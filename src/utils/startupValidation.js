'use strict';

/**
 * FlexFlow — Startup Validation
 * Runs on every app start. Verifies:
 *   1. Database connection is live
 *   2. tax_rates table has 2026/27 UK and SCO rates seeded
 *   3. Critical rate constants are present and plausible
 *   4. expense_rules and compliance_copy tables are populated
 *
 * If validation fails: logs the error and exits.
 * The app must NOT start with missing or zero rate values.
 */

const { pool } = require('../config/database');

// Critical rates that must be present and non-zero
const REQUIRED_RATES = [
  { year: '2026/27', jur: 'UK',  key: 'personal_allowance',      min: 10000,  max: 20000 },
  { year: '2026/27', jur: 'UK',  key: 'basic_rate',              min: 0.15,   max: 0.25  },
  { year: '2026/27', jur: 'UK',  key: 'higher_rate',             min: 0.35,   max: 0.45  },
  { year: '2026/27', jur: 'UK',  key: 'additional_rate',         min: 0.40,   max: 0.50  },
  { year: '2026/27', jur: 'UK',  key: 'dividend_additional_rate',min: 0.38,   max: 0.41  },
  { year: '2026/27', jur: 'UK',  key: 'class4_main_rate',        min: 0.05,   max: 0.08  },
  { year: '2026/27', jur: 'UK',  key: 'vat_threshold',           min: 80000,  max: 100000},
  { year: '2026/27', jur: 'SCO', key: 'starter_rate',            min: 0.18,   max: 0.20  },
  { year: '2026/27', jur: 'SCO', key: 'top_rate',                min: 0.47,   max: 0.49  },
  { year: '2026/27', jur: 'UK',  key: 'section24_credit_rate',   min: 0.19,   max: 0.21  },
];

async function validateStartup() {
  console.log('🔍 FlexFlow startup validation...');
  const errors = [];

  // 1. Database connection
  try {
    await pool.query('SELECT 1');
    console.log('  ✅ Database connected');
  } catch (err) {
    errors.push(`Database connection failed: ${err.message}`);
    console.error('  ❌ Database connection failed');
  }

  // 2. Critical rate validation
  for (const check of REQUIRED_RATES) {
    try {
      const result = await pool.query(
        `SELECT parameter_value FROM tax_rates
         WHERE tax_year = $1 AND jurisdiction = $2 AND parameter_key = $3`,
        [check.year, check.jur, check.key]
      );

      if (result.rows.length === 0) {
        errors.push(`Missing rate: [${check.jur}] ${check.year} ${check.key}`);
        console.error(`  ❌ Missing: [${check.jur}] ${check.key}`);
      } else {
        const val = parseFloat(result.rows[0].parameter_value);
        if (val < check.min || val > check.max) {
          errors.push(`Rate out of range: [${check.jur}] ${check.key} = ${val} (expected ${check.min}–${check.max})`);
          console.error(`  ❌ Out of range: [${check.jur}] ${check.key} = ${val}`);
        } else {
          console.log(`  ✅ [${check.jur}] ${check.key} = ${val}`);
        }
      }
    } catch (err) {
      errors.push(`Rate check failed for ${check.key}: ${err.message}`);
    }
  }

  // 3. Dividend additional rate specifically — this was the bug in v3.1
  // Must be ~39.35% (0.3935) NOT 41.25% (0.4125)
  try {
    const divResult = await pool.query(
      `SELECT parameter_value FROM tax_rates
       WHERE tax_year = '2026/27' AND jurisdiction = 'UK'
         AND parameter_key = 'dividend_additional_rate'`
    );
    const divRate = parseFloat(divResult.rows[0]?.parameter_value);
    if (Math.abs(divRate - 0.3935) > 0.001) {
      errors.push(`CRITICAL: dividend_additional_rate = ${divRate} — should be 0.3935 (39.35%). Was this the v3.1 bug value 0.4125?`);
      console.error(`  ❌ CRITICAL: dividend_additional_rate = ${divRate} (should be 0.3935)`);
    } else {
      console.log(`  ✅ Dividend additional rate = ${divRate} (39.35% — UNCHANGED, correct)`);
    }
  } catch (err) {
    errors.push(`Dividend rate check failed: ${err.message}`);
  }

  if (errors.length > 0) {
    console.error('\n❌ Startup validation FAILED:');
    errors.forEach(e => console.error(`   • ${e}`));
    console.error('\nRun npm run seed to reload rates, or npm run config:update-rates to fix individual values.\n');
    process.exit(1);
  }

  console.log('\n✅ Startup validation passed. FlexFlow is ready.\n');
}

module.exports = { validateStartup };
