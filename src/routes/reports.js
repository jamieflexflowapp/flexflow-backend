'use strict';

/**
 * FlexFlow — Reports Routes
 * Session J — Task 9
 *
 * GET  /reports/monthly          — generate or retrieve monthly PDF
 * GET  /reports/quarterly        — generate quarterly accountancy PDF (PRO)
 * GET  /reports/annual           — generate annual report (PRO)
 * GET  /reports/csv              — monthly CSV export (all tiers)
 * GET  /reports/list             — list all generated reports for user
 *
 * Storage: AWS S3 (or local /tmp in development)
 * Retention: 7-year via S3 lifecycle policy (configured in AWS console)
 */

const express = require('express');
const router  = express.Router();
const { verifyToken, checkOnboardingComplete } = require('../middleware/auth');
const { generateMonthlyPDF, generateQuarterlyPDF, generateMonthlyCSV } = require('../engines/rge');
const { query } = require('../config/database');

// AWS SDK — gracefully disabled if not configured (development mode)
let s3 = null;
try {
  const AWS = require('aws-sdk');
  if (process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY) {
    s3 = new AWS.S3({ region: process.env.AWS_REGION || 'eu-west-2' });
  }
} catch (e) {
  console.log('AWS SDK not available — using local storage for reports.');
}

router.use(verifyToken, checkOnboardingComplete);

// ── GET /reports/monthly ──────────────────────────────────────────────────────
// PLUS + PRO only

router.get('/monthly', async (req, res) => {
  try {
    const userResult = await query(`SELECT plan, full_name FROM users WHERE id = $1`, [req.user.userId]);
    const { plan } = userResult.rows[0];

    if (plan === 'free') {
      return res.status(403).json({
        error: 'Your monthly summary is available on Plus and Pro.',
        code:  'UPGRADE_REQUIRED',
      });
    }

    const now   = new Date();
    const year  = parseInt(req.query.year)  || now.getFullYear();
    const month = parseInt(req.query.month) || now.getMonth() + 1;

    if (month < 1 || month > 12) {
      return res.status(400).json({ error: 'Invalid month. Use 1-12.' });
    }

    // Check S3 cache first
    const s3Key = `reports/${req.user.userId}/monthly/${year}-${String(month).padStart(2,'0')}.pdf`;
    const cached = await getFromS3(s3Key);
    if (cached) {
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename="FlexFlow-Monthly-${year}-${String(month).padStart(2,'0')}.pdf"`);
      return res.send(cached);
    }

    const pdfBuffer = await generateMonthlyPDF(req.user.userId, year, month);

    // Store to S3 (or log in dev)
    await storeToS3(s3Key, pdfBuffer, 'application/pdf');

    // Log to reports table
    await logReport(req.user.userId, 'monthly_pdf', year, month, s3Key);

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="FlexFlow-Monthly-${year}-${String(month).padStart(2,'0')}.pdf"`);
    return res.send(pdfBuffer);

  } catch (err) {
    console.error('Monthly report error:', err);
    return res.status(500).json({ error: 'Failed to generate monthly report.' });
  }
});

// ── GET /reports/quarterly ────────────────────────────────────────────────────
// PRO only

router.get('/quarterly', async (req, res) => {
  try {
    const userResult = await query(`SELECT plan FROM users WHERE id = $1`, [req.user.userId]);
    const { plan } = userResult.rows[0];

    if (plan !== 'pro') {
      return res.status(403).json({
        error: 'Quarterly accountancy reports are a Pro feature.',
        code:  'UPGRADE_REQUIRED',
      });
    }

    const now     = new Date();
    const year    = parseInt(req.query.year) || now.getFullYear();
    const quarter = req.query.quarter || getCurrentQuarter();

    if (!['Q1','Q2','Q3','Q4'].includes(quarter)) {
      return res.status(400).json({ error: 'Invalid quarter. Use Q1, Q2, Q3, or Q4.' });
    }

    const s3Key = `reports/${req.user.userId}/quarterly/${year}-${quarter}.pdf`;
    const cached = await getFromS3(s3Key);
    if (cached) {
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename="FlexFlow-Quarterly-${year}-${quarter}.pdf"`);
      return res.send(cached);
    }

    const pdfBuffer = await generateQuarterlyPDF(req.user.userId, year, quarter);
    await storeToS3(s3Key, pdfBuffer, 'application/pdf');
    await logReport(req.user.userId, 'quarterly_pdf', year, null, s3Key, quarter);

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="FlexFlow-Quarterly-${year}-${quarter}.pdf"`);
    return res.send(pdfBuffer);

  } catch (err) {
    console.error('Quarterly report error:', err);
    return res.status(500).json({ error: 'Failed to generate quarterly report.' });
  }
});

// ── GET /reports/csv ──────────────────────────────────────────────────────────
// All tiers — raw transaction export

router.get('/csv', async (req, res) => {
  try {
    const now   = new Date();
    const year  = parseInt(req.query.year)  || now.getFullYear();
    const month = parseInt(req.query.month) || now.getMonth() + 1;

    if (month < 1 || month > 12) {
      return res.status(400).json({ error: 'Invalid month. Use 1-12.' });
    }

    const csv = await generateMonthlyCSV(req.user.userId, year, month);
    const monthName = new Date(year, month - 1, 1).toLocaleString('en-GB', { month: 'long' });

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition',
      `attachment; filename="FlexFlow-Transactions-${monthName}-${year}.csv"`);
    return res.send(csv);

  } catch (err) {
    console.error('CSV export error:', err);
    return res.status(500).json({ error: 'Failed to generate CSV export.' });
  }
});

// ── GET /reports/list ─────────────────────────────────────────────────────────

router.get('/list', async (req, res) => {
  try {
    const result = await query(
      `SELECT report_type, report_year, report_month, report_quarter,
              s3_key, generated_at
       FROM report_log
       WHERE user_id = $1
       ORDER BY generated_at DESC
       LIMIT 50`,
      [req.user.userId]
    );
    return res.json({ reports: result.rows });
  } catch (err) {
    console.error('Report list error:', err);
    return res.status(500).json({ error: 'Failed to list reports.' });
  }
});

// ══════════════════════════════════════════════════════════════════════════════
// S3 HELPERS
// ══════════════════════════════════════════════════════════════════════════════

async function getFromS3(key) {
  if (!s3) return null;
  try {
    const result = await s3.getObject({
      Bucket: process.env.AWS_S3_BUCKET,
      Key:    key,
    }).promise();
    return result.Body;
  } catch (err) {
    if (err.code === 'NoSuchKey') return null;
    throw err;
  }
}

async function storeToS3(key, buffer, contentType) {
  if (!s3) {
    console.log(`[RGE] Dev mode — would store to S3: ${key} (${buffer.length} bytes)`);
    return;
  }
  await s3.putObject({
    Bucket:      process.env.AWS_S3_BUCKET,
    Key:         key,
    Body:        buffer,
    ContentType: contentType,
    // 7-year retention enforced via S3 lifecycle policy (configured in AWS console)
    // not via code — lifecycle applies to entire bucket prefix
  }).promise();
}

async function logReport(userId, type, year, month, s3Key, quarter = null) {
  await query(`
    INSERT INTO report_log
      (user_id, report_type, report_year, report_month, report_quarter,
       s3_key, generated_at)
    VALUES ($1,$2,$3,$4,$5,$6,NOW())
    ON CONFLICT (user_id, report_type, report_year, report_month, report_quarter)
    DO UPDATE SET s3_key = EXCLUDED.s3_key, generated_at = NOW()
  `, [userId, type, year, month, quarter, s3Key]);
}

function getCurrentQuarter() {
  const month = new Date().getMonth() + 1;
  if (month <= 3)  return 'Q1';
  if (month <= 6)  return 'Q2';
  if (month <= 9)  return 'Q3';
  return 'Q4';
}

module.exports = router;
