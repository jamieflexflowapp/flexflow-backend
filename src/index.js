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

// ── camelCase response middleware (Phase 4.5) ─────────────────────────────
// Converts snake_case DB/backend fields to camelCase for React Native frontend.
const { camelizeMiddleware } = require('./middleware/camelize');
app.use(camelizeMiddleware);

// ── HTTPS enforcement (production only) ───────────────────────────────────────
if (process.env.NODE_ENV === 'production') {
  app.use((req, res, next) => {
    if (req.headers['x-forwarded-proto'] !== 'https') {
      return res.redirect(301, 'https://' + req.headers.host + req.url);
    }
    next();
  });
}

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
const committedBillsRoutes = require('./routes/committed_bills');
app.use('/committed-bills', committedBillsRoutes);
const dividendsRoutes = require('./routes/dividends');
app.use('/dividends', dividendsRoutes);
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
const supportRoutes     = require('./routes/support');
app.use('/forecast',    forecastRoutes);
app.use('/support',     supportRoutes);
const reportsRoutes         = require('./routes/reports');
const notificationsRoutes   = require('./routes/notifications');
const twofaRoutes           = require('./routes/twofa');
app.use('/reports',        reportsRoutes);
app.use('/notifications',  notificationsRoutes);
app.use('/auth/2fa',        twofaRoutes);
// Session J: Report Generation Engine ✅ — PHASE 3 COMPLETE

// ── Phase 4.5 routes ─────────────────────────────────────────────────────────
const subscriptionRoutes  = require('./routes/subscriptions');
const pensionRoutes        = require('./routes/pension_route');
const businessRoutes       = require('./routes/business_route');
const transactionRoutes    = require('./routes/transactions');
const designationRoutes    = require('./routes/designations');

app.use('/subscriptions', subscriptionRoutes);
app.use('/pension',       pensionRoutes);
app.use('/business',      businessRoutes);
app.use('/transactions',  transactionRoutes);
app.use('/designations',  designationRoutes);

const userExportRoutes = require('./routes/user_export');
app.use('/user', userExportRoutes);

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
  const { sendPush } = require('./utils/sendPush');
  const { query: dbQuery } = require('./config/database');
  cron.schedule('0 6 1 * *', async () => {
    console.log('[RGE] Monthly report generation starting...');
    try {
      const now = new Date();
      const reportDate = new Date(now.getFullYear(), now.getMonth() - 1, 1);
      const year  = reportDate.getFullYear();
      const month = reportDate.getMonth() + 1;
      const users = await dbQuery(
        "SELECT id FROM users WHERE plan = 'pro' AND onboarding_complete = true"
      );
      console.log(`[RGE] Generating for ${users.rows.length} users — ${month}/${year}`);
      for (const user of users.rows) {
        try {
          await generateMonthlyPDF(user.id, year, month);
          await generateMonthlyCSV(user.id, year, month);
          const monthName = new Date(year, month - 1, 1).toLocaleString('default', { month: 'long' });
          await sendPush(user.id, 'Your monthly report is ready', `Your ${monthName} ${year} FlexFlow report has been generated.`);
          await dbQuery(`INSERT INTO notifications (user_id, alert_type, severity, title, body, dedup_key)
            VALUES ($1, 'monthly_report', 'INFO', 'Monthly report ready', $2, $3)
            ON CONFLICT (user_id, dedup_key) DO NOTHING`,
            [user.id, `Your ${monthName} ${year} report has been generated and is ready to download.`, `monthly_report_${user.id}_${year}_${month}`]);
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
          await sendPush(user.id, 'Your annual report is ready', `Your ${taxYear} tax year report has been generated.`);
          await dbQuery(`INSERT INTO notifications (user_id, alert_type, severity, title, body, dedup_key)
            VALUES ($1, 'annual_report', 'INFO', 'Annual report ready', $2, $3)
            ON CONFLICT (user_id, dedup_key) DO NOTHING`,
            [user.id, `Your ${taxYear} tax year report has been generated and is ready to download.`, `annual_report_${user.id}_${taxYear}`]);
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

// Nightly cleanup — delete unverified accounts older than 24 hours
const { query: dbQuery } = require('./config/database');
setInterval(async () => {
  try {
    const r = await dbQuery(
      "DELETE FROM users WHERE email_verified = false AND verification_expires < NOW() - INTERVAL '24 hours'"
    );
    if (r.rowCount > 0) console.log(`[Cleanup] Removed ${r.rowCount} expired unverified account(s)`);
  } catch (err) {
    console.error('[Cleanup] Error:', err.message);
  }

// Nightly 6-year archive purge — runs 03:00 every night
// Deletes archived records for accounts deleted more than 6 years ago
const cronLib = require('node-cron');
cronLib.schedule('0 3 * * *', async () => {
  try {
    const expired = await dbQuery(
      "SELECT original_user_id FROM archive.users WHERE deletion_date < NOW() - INTERVAL '6 years'"
    );
    if (expired.rows.length === 0) return;
    for (const row of expired.rows) {
      const uid = row.original_user_id;
      await dbQuery('DELETE FROM archive.transactions WHERE original_user_id = $1', [uid]);
      await dbQuery('DELETE FROM archive.tax_calculations WHERE original_user_id = $1', [uid]);
      await dbQuery('DELETE FROM archive.committed_bills WHERE original_user_id = $1', [uid]);
      await dbQuery('DELETE FROM archive.mileage_log WHERE original_user_id = $1', [uid]);
      await dbQuery('DELETE FROM archive.home_office_config WHERE original_user_id = $1', [uid]);
      await dbQuery('DELETE FROM archive.runway_snapshots WHERE original_user_id = $1', [uid]);
      await dbQuery('DELETE FROM archive.users WHERE original_user_id = $1', [uid]);
    }
    console.log(`[Archive Purge] Permanently deleted ${expired.rows.length} account(s) past 6-year retention window`);
  } catch (err) {
    console.error('[Archive Purge] Error:', err.message);
  }
});
}, 1000 * 60 * 60 * 24); // every 24 hours
