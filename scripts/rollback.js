'use strict';

/**
 * FlexFlow — Config: Rollback
 * npm run config:rollback
 *
 * Reverts the most recent rate change for a given parameter.
 * Uses the tax_rate_changes audit log to find the previous value.
 * The rollback itself is also logged to the audit trail.
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

async function run() {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ask = (q) => new Promise(resolve => rl.question(q, resolve));

  console.log('\n🔄 FlexFlow — Rollback Rate Change\n');

  // Show recent changes
  const recent = await pool.query(
    `SELECT id, tax_year, jurisdiction, parameter_key, old_value, new_value,
            change_reason, created_at
     FROM tax_rate_changes
     ORDER BY created_at DESC LIMIT 10`
  );

  console.log('Recent rate changes:');
  recent.rows.forEach((r, i) => {
    console.log(`  ${i+1}. [${r.jurisdiction}] ${r.tax_year} ${r.parameter_key}: ${r.old_value} → ${r.new_value} (${r.created_at.toISOString().split('T')[0]})`);
  });
  console.log('');

  const taxYear  = await ask('Tax year to rollback: ');
  const jur      = await ask('Jurisdiction (UK/SCO): ');
  const paramKey = await ask('Parameter key to rollback: ');
  const reason   = await ask('Reason for rollback: ');
  rl.close();

  // Find the previous value
  const history = await pool.query(
    `SELECT old_value, new_value, created_at FROM tax_rate_changes
     WHERE tax_year = $1 AND jurisdiction = $2 AND parameter_key = $3
     ORDER BY created_at DESC LIMIT 2`,
    [taxYear.trim(), jur.trim().toUpperCase(), paramKey.trim()]
  );

  if (history.rows.length === 0) {
    console.log('❌ No change history found for this parameter.');
    await pool.end();
    return;
  }

  const prevValue = history.rows[0].old_value;
  const currValue = history.rows[0].new_value;

  if (!prevValue) {
    console.log('❌ No previous value to rollback to (this was the first entry).');
    await pool.end();
    return;
  }

  console.log(`\nRolling back: ${currValue} → ${prevValue}`);

  // Update the rate
  await pool.query(
    `UPDATE tax_rates SET parameter_value = $1, updated_at = NOW()
     WHERE tax_year = $2 AND jurisdiction = $3 AND parameter_key = $4`,
    [prevValue, taxYear.trim(), jur.trim().toUpperCase(), paramKey.trim()]
  );

  // Log the rollback
  await pool.query(
    `INSERT INTO tax_rate_changes
       (tax_year, jurisdiction, parameter_key, old_value, new_value,
        change_reason, source, effective_from)
     VALUES ($1,$2,$3,$4,$5,$6,'ROLLBACK',CURRENT_DATE)`,
    [taxYear.trim(), jur.trim().toUpperCase(), paramKey.trim(),
     currValue, prevValue, `ROLLBACK: ${reason}`]
  );

  console.log(`✅ Rolled back successfully. Audit log updated.\n`);
  await pool.end();
}

run().catch(err => { console.error('Rollback failed:', err.message); process.exit(1); });
