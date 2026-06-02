'use strict';

const express = require('express');
const router  = express.Router();
const { verifyToken, checkOnboardingComplete } = require('../middleware/auth');
const { generateMonthlyPDF, generateAnnualPDF, generateMonthlyCSV, generateAnnualCSV, generateLtdMonthlyCSV } = require('../engines/rge');
const { query } = require('../config/database');

let s3 = null;
try {
  const AWS = require('aws-sdk');
  if (process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY) {
    s3 = new AWS.S3({ region: process.env.AWS_REGION || 'eu-west-2' });
  }
} catch (e) {
  console.log('AWS SDK not available — dev mode.');
}

router.use(verifyToken, checkOnboardingComplete);

router.get('/monthly', async (req, res) => {
  try {
    const now   = new Date();
    const year  = parseInt(req.query.year)  || now.getFullYear();
    const month = parseInt(req.query.month) || now.getMonth() + 1;
    if (month < 1 || month > 12) return res.status(400).json({ error: 'Invalid month.' });
    const s3Key = `reports/${req.user.userId}/monthly/${year}-${String(month).padStart(2,'0')}.pdf`;
    const cached = await getFromS3(s3Key);
    if (cached) { res.setHeader('Content-Type','application/pdf'); res.setHeader('Content-Disposition',`attachment; filename="FlexFlow-Monthly-${year}-${String(month).padStart(2,'0')}.pdf"`); return res.send(cached); }
    const pdfBuffer = await generateMonthlyPDF(req.user.userId, year, month);
    await storeToS3(s3Key, pdfBuffer, 'application/pdf');
    await logReport(req.user.userId, 'monthly_pdf', year, month, s3Key);
    res.setHeader('Content-Type','application/pdf');
    res.setHeader('Content-Disposition',`attachment; filename="FlexFlow-Monthly-${year}-${String(month).padStart(2,'0')}.pdf"`);
    return res.send(pdfBuffer);
  } catch (err) { console.error('Monthly report error:', err); return res.status(500).json({ error: 'Failed to generate monthly report.' }); }
});

router.get('/annual', async (req, res) => {
  try {
    const now = new Date();
    const currentTaxYear = (now.getMonth() > 3 || (now.getMonth() === 3 && now.getDate() >= 6))
      ? `${now.getFullYear()}/${String(now.getFullYear()+1).slice(-2)}`
      : `${now.getFullYear()-1}/${String(now.getFullYear()).slice(-2)}`;
    const taxYear = req.query.tax_year || currentTaxYear;
    const s3Key = `reports/${req.user.userId}/annual/${taxYear.replace('/','_')}.pdf`;
    const cached = await getFromS3(s3Key);
    if (cached) { res.setHeader('Content-Type','application/pdf'); res.setHeader('Content-Disposition',`attachment; filename="FlexFlow-Annual-${taxYear.replace('/','_')}.pdf"`); return res.send(cached); }
    const pdfBuffer = await generateAnnualPDF(req.user.userId, taxYear);
    await storeToS3(s3Key, pdfBuffer, 'application/pdf');
    await logReport(req.user.userId, 'annual_pdf', parseInt(taxYear.split('/')[0]), null, s3Key);
    res.setHeader('Content-Type','application/pdf');
    res.setHeader('Content-Disposition',`attachment; filename="FlexFlow-Annual-${taxYear.replace('/','_')}.pdf"`);
    return res.send(pdfBuffer);
  } catch (err) { console.error('Annual report error:', err); return res.status(500).json({ error: 'Failed to generate annual report.' }); }
});

router.get('/csv', async (req, res) => {
  try {
    const now   = new Date();
    const year  = parseInt(req.query.year)  || now.getFullYear();
    const month = parseInt(req.query.month) || now.getMonth() + 1;
    if (month < 1 || month > 12) return res.status(400).json({ error: 'Invalid month.' });
    const userResult = await query('SELECT income_structure FROM users WHERE id = $1', [req.user.userId]);
    const struct = userResult.rows[0]?.income_structure || ''; const isLtd = struct === 'ltd_director' || struct === 'S2';
    const csv = isLtd
      ? await generateLtdMonthlyCSV(req.user.userId, year, month)
      : await generateMonthlyCSV(req.user.userId, year, month);
    const monthName = new Date(year, month-1, 1).toLocaleString('en-GB', { month: 'long' });
    res.setHeader('Content-Type','text/csv');
    res.setHeader('Content-Disposition',`attachment; filename="FlexFlow-Transactions-${monthName}-${year}.csv"`);
    return res.send(csv);
  } catch (err) { console.error('CSV error:', err); return res.status(500).json({ error: 'Failed to generate CSV.' }); }
});

router.get('/annual-csv', async (req, res) => {
  try {
    const now = new Date();
    const currentTaxYear = (now.getMonth() > 3 || (now.getMonth() === 3 && now.getDate() >= 6))
      ? now.getFullYear() + '/' + String(now.getFullYear()+1).slice(-2)
      : (now.getFullYear()-1) + '/' + String(now.getFullYear()).slice(-2);
    const taxYear = req.query.tax_year || currentTaxYear;
    const csv = await generateAnnualCSV(req.user.userId, taxYear);
    res.setHeader('Content-Type','text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="FlexFlow-Annual-' + taxYear.replace('/','_') + '.csv"');
    return res.send(csv);
  } catch (err) { console.error('Annual CSV error:', err); return res.status(500).json({ error: 'Failed to generate annual CSV.' }); }
});

router.get('/list', async (req, res) => {
  try {
    const result = await query(
      `SELECT report_type, report_year, report_month, report_quarter, s3_key, generated_at
       FROM report_log WHERE user_id = $1 ORDER BY generated_at DESC LIMIT 50`,
      [req.user.userId]
    );
    return res.json({ reports: result.rows });
  } catch (err) { return res.status(500).json({ error: 'Failed to list reports.' }); }
});

async function getFromS3(key) {
  if (!s3) return null;
  try { const r = await s3.getObject({ Bucket: process.env.AWS_S3_BUCKET, Key: key }).promise(); return r.Body; }
  catch (err) { if (err.code === 'NoSuchKey') return null; throw err; }
}
async function storeToS3(key, buffer, contentType) {
  if (!s3) { console.log(`[RGE] Dev mode — would store: ${key}`); return; }
  await s3.putObject({ Bucket: process.env.AWS_S3_BUCKET, Key: key, Body: buffer, ContentType: contentType }).promise();
}
async function logReport(userId, type, year, month, s3Key, quarter = null) {
  await query(`INSERT INTO report_log (user_id, report_type, report_year, report_month, report_quarter, s3_key, generated_at)
    VALUES ($1,$2,$3,$4,$5,$6,NOW()) ON CONFLICT (user_id, report_type, report_year, report_month, report_quarter)
    DO UPDATE SET s3_key = EXCLUDED.s3_key, generated_at = NOW()`,
    [userId, type, year, month, quarter, s3Key]);
}

module.exports = router;
