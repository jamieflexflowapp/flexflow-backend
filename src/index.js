'use strict';

/**
 * FlexFlow — API Entry Point
 * Phase 3, Session A — scaffold only
 * Routes and engines added in subsequent sessions
 */

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { pool } = require('./config/database');
const { validateStartup } = require('./utils/startupValidation');
const { startQuarterlyCron } = require('./utils/quarterlyCron');

const app = express();
const PORT = process.env.PORT || 3000;

// ── Middleware ─────────────────────────────────────────────────────────────────
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ── Health check ───────────────────────────────────────────────────────────────
app.get('/health', async (req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({
      status: 'ok',
      app: 'FlexFlow API',
      version: '1.0.0',
      db: 'connected',
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    res.status(503).json({ status: 'error', db: 'disconnected', error: err.message });
  }
});

// ── Routes ────────────────────────────────────────────────────────────────────
// Session B
const authRoutes        = require('./routes/auth');
const onboardingRoutes  = require('./routes/onboarding');

app.use('/auth',        authRoutes);
app.use('/onboarding',  onboardingRoutes);

const truelayerRoutes   = require('./routes/truelayer');
app.use('/truelayer',   truelayerRoutes);
// Session C: TrueLayer routes ✅
const incomeRoutes      = require('./routes/income');
app.use('/income',      incomeRoutes);
// Session D: Income Smoothing Engine ✅
const taxRoutes         = require('./routes/tax');
app.use('/tax',         taxRoutes);
// Session E: Tax Engine ✅

const expensesRoutes    = require('./routes/expenses');
app.use('/expenses',    expensesRoutes);
const runwayRoutes      = require('./routes/runway');
app.use('/runway',      runwayRoutes);
const forecastRoutes    = require('./routes/forecast');
app.use('/forecast',    forecastRoutes);
const reportsRoutes         = require('./routes/reports');
const notificationsRoutes   = require('./routes/notifications');
const budgetRoutes           = require('./routes/budget');
app.use('/reports',        reportsRoutes);
app.use('/notifications',  notificationsRoutes);
app.use('/budget',         budgetRoutes);
// Session J: Report Generation Engine ✅ — PHASE 3 COMPLETE

// ── 404 handler ───────────────────────────────────────────────────────────────
app.use((req, res) => {
  res.status(404).json({ error: 'Route not found' });
});

// ── Error handler ─────────────────────────────────────────────────────────────
app.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
  console.error(err.stack);
  res.status(err.status || 500).json({
    error: process.env.NODE_ENV === 'production' ? 'Internal server error' : err.message,
  });
});

// ── Start ─────────────────────────────────────────────────────────────────────
app.listen(PORT, async () => {
  console.log(`\n🚀 FlexFlow API running on port ${PORT}`);
  console.log(`   Environment: ${process.env.NODE_ENV || 'development'}`);
  console.log(`   Health check: http://localhost:${PORT}/health\n`);

  // Session G: Startup validation — verify DB rates on every start
  await validateStartup();

  // Session G: Start quarterly salary/dividend review cron
  startQuarterlyCron();

  // Session I: Purge expired FSBE scenario sessions every hour
  const { purgeExpiredSessions } = require('./engines/fsbe');
  const cron = require('node-cron');
  cron.schedule('0 * * * *', async () => {
    const purged = await purgeExpiredSessions();
    if (purged > 0) console.log(`[FSBE] Purged ${purged} expired scenario sessions.`);
  });

  // Session J: Auto-generate monthly reports on 1st of each month at 06:00
  // Generates report for PREVIOUS month — e.g. runs 1 Jun, covers May
  // Updated from spec (was last day of month) per product decision May 2026
  const { generateMonthlyPDF, generateMonthlyCSV, generateQuarterlyPDF } = require('./engines/rge');
  const { query: dbQuery } = require('./config/database');
  cron.schedule('0 6 1 * *', async () => {
    console.log('[RGE] Monthly report generation starting...');
    try {
      const now = new Date();
      const reportDate = new Date(now.getFullYear(), now.getMonth() - 1, 1);
      const year  = reportDate.getFullYear();
      const month = reportDate.getMonth() + 1;
      const users = await dbQuery(
        "SELECT id FROM users WHERE plan IN ('plus', 'pro') AND onboarding_complete = true"
      );
      console.log(`[RGE] Generating for ${users.rows.length} users — ${month}/${year}`);
      for (const user of users.rows) {
        try {
          await generateMonthlyPDF(user.id, year, month);
          await generateMonthlyCSV(user.id, year, month);
        } catch (err) {
          console.error(`[RGE] Failed for user ${user.id}:`, err.message);
        }
      }
      console.log('[RGE] Monthly report generation complete.');
    } catch (err) {
      console.error('[RGE] Monthly cron error:', err.message);
    }
  });

  // Annual report cron — runs 06:00 on 6 April each year
  // Covers the tax year that just ended on 5 April (end of day)
  // e.g. runs 6 Apr 2026 → generates 2025/26 annual report
  cron.schedule('0 6 6 4 *', async () => {
    console.log('[RGE] Annual report generation starting...');
    try {
      const now = new Date();
      const taxYearEnd  = now.getFullYear() - 1; // e.g. 2026 run → 2025 start year
      const taxYear     = `${taxYearEnd}/${String(taxYearEnd + 1).slice(-2)}`; // '2025/26'

      const users = await dbQuery(
        "SELECT id FROM users WHERE plan = 'pro' AND onboarding_complete = true"
      );
      console.log(`[RGE] Generating annual reports for ${users.rows.length} PRO users — ${taxYear}`);

      for (const user of users.rows) {
        try {
          await generateQuarterlyPDF(user.id, now.getFullYear(), 'annual');
        } catch (err) {
          console.error(`[RGE] Annual failed for user ${user.id}:`, err.message);
        }
      }
      console.log('[RGE] Annual report generation complete.');
    } catch (err) {
      console.error('[RGE] Annual cron error:', err.message);
    }
  });
});

module.exports = app;
