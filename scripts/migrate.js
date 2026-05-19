'use strict';

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

async function runMigrations() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS _migrations (
      filename    VARCHAR(255) PRIMARY KEY,
      applied_at  TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  const migrationsDir = path.join(__dirname, '..', 'migrations');
  const files = fs.readdirSync(migrationsDir).filter(f => f.endsWith('.sql')).sort();
  const applied = await pool.query('SELECT filename FROM _migrations');
  const appliedSet = new Set(applied.rows.map(r => r.filename));
  const pending = files.filter(f => !appliedSet.has(f));

  console.log(`\n🔧 FlexFlow — ${files.length} migrations total, ${pending.length} pending...\n`);

  if (pending.length === 0) {
    console.log('  ✅ All migrations already applied.\n');
    await pool.end();
    return;
  }

  for (const file of pending) {
    const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf8');
    try {
      await pool.query(sql);
      await pool.query('INSERT INTO _migrations (filename) VALUES ($1)', [file]);
      console.log(`  ✅ ${file}`);
    } catch (err) {
      console.error(`  ❌ ${file}: ${err.message}`);
      process.exit(1);
    }
  }

  console.log('\n✅ All migrations complete.\n');
  await pool.end();
}

runMigrations().catch(err => { console.error('Migration failed:', err); process.exit(1); });
