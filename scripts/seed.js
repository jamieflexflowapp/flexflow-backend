'use strict';

/**
 * FlexFlow — Database Seed Runner
 * Seeds: tax_rates (2026/27 UK + Scottish), expense_rules, compliance_copy
 * Safe to run multiple times — uses INSERT ... ON CONFLICT DO NOTHING
 */

require('dotenv').config();
const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');

const pool = new Pool({
  host:     process.env.DB_HOST     || 'localhost',
  port:     parseInt(process.env.DB_PORT || '5432'),
  database: process.env.DB_NAME     || 'flexflow',
  user:     process.env.DB_USER     || 'flexflow_user',
  password: process.env.DB_PASSWORD || 'flexflow_dev_password',
});

async function runSeeds() {
  const seedsDir = path.join(__dirname, '..', 'seeds');
  const files = fs.readdirSync(seedsDir)
    .filter(f => f.endsWith('.sql'))
    .sort();

  console.log(`\n🌱 FlexFlow — Running ${files.length} seed files...\n`);

  for (const file of files) {
    const filePath = path.join(seedsDir, file);
    const sql = fs.readFileSync(filePath, 'utf8');
    try {
      await pool.query(sql);
      console.log(`  ✅ ${file}`);
    } catch (err) {
      console.error(`  ❌ ${file}: ${err.message}`);
      process.exit(1);
    }
  }

  console.log('\n✅ All seeds complete. Tax rates, expense rules, and compliance copy loaded.\n');
  await pool.end();
}

runSeeds().catch(err => {
  console.error('Seed failed:', err);
  process.exit(1);
});
