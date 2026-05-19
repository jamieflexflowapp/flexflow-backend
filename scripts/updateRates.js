'use strict';

/**
 * FlexFlow — Config: Update Tax Rates
 * npm run config:update-rates
 *
 * Updates tax rate constants in the database.
 * NEVER edit engine code to change a rate — use this script.
 * Every change is logged to tax_rate_changes (immutable audit log).
 *
 * Usage:
 *   npm run config:update-rates
 *   — Interactive: prompts for rate key, new value, reason, source
 *
 * Or pass args directly:
 *   node scripts/updateRates.js --key basic_rate --value 0.20 --year 2027/28 \
 *     --reason "No change" --source "GOV.UK"
 */

require('dotenv').config();
const { Pool } = require('pg');
const readline = require('readline');

const pool = new Pool({
  host:     process.env.DB_HOST     || 'localhost',
  port:     parseInt(process.env.DB_PORT || '5432'),
  database: process.env.DB_NAME     || 'flexflow',
  user:     process.env.DB_USER     || 'flexflow_user',
  password: process.env.DB_PASSWORD || 'flexflow_dev_password',
});

async function updateRate({ taxYear, jurisdiction, key, newValue, reason, source }) {
  // Get current value
  const current = await pool.query(
    `SELECT parameter_value FROM tax_rates
     WHERE tax_year = $1 AND jurisdiction = $2 AND parameter_key = $3`,
    [taxYear, jurisdiction, key]
  );

  const oldValue = current.rows[0]?.parameter_value || null;

  // Update tax_rates table
  await pool.query(`
    INSERT INTO tax_rates (tax_year, jurisdiction, parameter_key, parameter_value,
                           effective_from, source)
    VALUES ($1, $2, $3, $4, CURRENT_DATE, $5)
    ON CONFLICT (tax_year, jurisdiction, parameter_key) DO UPDATE SET
      parameter_value = EXCLUDED.parameter_value,
      source          = EXCLUDED.source,
      effective_from  = CURRENT_DATE,
      updated_at      = NOW()
  `, [taxYear, jurisdiction, key, newValue, source]);

  // Write to immutable audit log (tax_rate_changes — never deleted)
  await pool.query(`
    INSERT INTO tax_rate_changes
      (tax_year, jurisdiction, parameter_key, old_value, new_value,
       change_reason, source, effective_from)
    VALUES ($1, $2, $3, $4, $5, $6, $7, CURRENT_DATE)
  `, [taxYear, jurisdiction, key, oldValue, newValue, reason, source]);

  // Log to rate_monitor_log
  await pool.query(`
    INSERT INTO rate_monitor_log (tax_year, status, changes_found)
    VALUES ($1, 'changes_found', 1)
  `, [taxYear]);

  console.log(`\n✅ Rate updated:`);
  console.log(`   ${jurisdiction} ${taxYear} ${key}`);
  console.log(`   ${oldValue} → ${newValue}`);
  console.log(`   Reason: ${reason}`);
  console.log(`   Source: ${source}`);
  console.log(`   Audit log updated.\n`);
}

async function listRates(taxYear = '2026/27') {
  const result = await pool.query(
    `SELECT jurisdiction, parameter_key, parameter_value, source
     FROM tax_rates WHERE tax_year = $1
     ORDER BY jurisdiction, parameter_key`,
    [taxYear]
  );
  console.log(`\n📋 Current rates for ${taxYear}:`);
  result.rows.forEach(r => {
    console.log(`  [${r.jurisdiction}] ${r.parameter_key}: ${r.parameter_value} (${r.source || 'no source'})`);
  });
  console.log('');
}

async function run() {
  const args = process.argv.slice(2);

  // Parse CLI args if provided
  const getArg = (flag) => {
    const idx = args.indexOf(flag);
    return idx >= 0 ? args[idx + 1] : null;
  };

  if (args.includes('--list')) {
    await listRates(getArg('--year') || '2026/27');
    await pool.end();
    return;
  }

  // If all args provided, run non-interactively
  const key      = getArg('--key');
  const value    = getArg('--value');
  const year     = getArg('--year')   || '2026/27';
  const jur      = getArg('--jur')    || 'UK';
  const reason   = getArg('--reason') || 'Manual update';
  const source   = getArg('--source') || 'Manual';

  if (key && value) {
    await updateRate({ taxYear: year, jurisdiction: jur, key, newValue: parseFloat(value), reason, source });
    await pool.end();
    return;
  }

  // Interactive mode
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ask = (q) => new Promise(resolve => rl.question(q, resolve));

  console.log('\n🔧 FlexFlow — Update Tax Rate');
  console.log('   All changes are logged to the immutable audit trail.\n');

  await listRates();

  const taxYear    = await ask('Tax year (e.g. 2026/27): ');
  const jur2       = await ask('Jurisdiction (UK or SCO): ');
  const paramKey   = await ask('Parameter key: ');
  const newVal     = await ask('New value: ');
  const changeReason = await ask('Reason for change: ');
  const changeSource = await ask('Legislative source (e.g. GOV.UK Finance Act 2027): ');

  rl.close();

  await updateRate({
    taxYear:      taxYear.trim(),
    jurisdiction: jur2.trim().toUpperCase(),
    key:          paramKey.trim(),
    newValue:     parseFloat(newVal),
    reason:       changeReason.trim(),
    source:       changeSource.trim(),
  });

  await pool.end();
}

run().catch(err => { console.error('Update failed:', err.message); process.exit(1); });
