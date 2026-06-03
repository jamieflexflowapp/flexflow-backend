'use strict';

const express = require('express');
const router  = express.Router();
const { verifyToken, checkOnboardingComplete } = require('../middleware/auth');
const { query } = require('../config/database');

router.use(verifyToken, checkOnboardingComplete);

router.get('/export', async (req, res) => {
  const userId = req.user.userId;
  try {
    const userResult = await query(
      `SELECT full_name, email, income_structure, tax_code, is_scottish_taxpayer,
              receives_pension, pension_contribution_frequency,
              annual_personal_pension_net, annual_employer_pension_contribution,
              mpaa_triggered, created_at
       FROM users WHERE id = $1`, [userId]
    );
    const txResult = await query(
      `SELECT transaction_date, description, merchant_name, amount,
              is_income, user_confirmed, category, sub_category, created_at
       FROM transactions WHERE user_id = $1 ORDER BY transaction_date DESC`, [userId]
    );
    const mileageResult = await query(
      `SELECT journey_date, purpose, miles, tax_year, created_at
       FROM mileage_log WHERE user_id = $1 ORDER BY journey_date DESC`, [userId]
    );
    const hoResult = await query(
      `SELECT monthly_hours, method, monthly_deduction, annual_deduction
       FROM home_office_config WHERE user_id = $1`, [userId]
    );
    const billsResult = await query(
      `SELECT name, amount, day_of_month, source, is_active, created_at
       FROM committed_bills WHERE user_id = $1`, [userId]
    );
    const taxResult = await query(
      `SELECT tax_year, gross_se_income, gross_paye_income, gross_dividend_income,
              total_tax_liability, it_total, ni_total, ni_class2, ni_class4_main, calculated_at
       FROM tax_calculations WHERE user_id = $1 ORDER BY tax_year DESC`, [userId]
    );
    const banksResult = await query(
      `SELECT account_name, account_type, current_balance, is_active, created_at
       FROM bank_connections WHERE user_id = $1`, [userId]
    );
    const desigResult = await query(
      `SELECT bank_account_id, designation_type
       FROM account_designations WHERE user_id = $1`, [userId]
    );
    const runwayResult = await query(
      `SELECT snapshot_date, bank_balance, available_balance,
              tier1_monthly, runway_weeks, runway_status
       FROM runway_snapshots WHERE user_id = $1 ORDER BY snapshot_date DESC LIMIT 90`, [userId]
    );
    const notifResult = await query(
      `SELECT title, body, alert_type, created_at
       FROM notifications WHERE user_id = $1 ORDER BY created_at DESC LIMIT 100`, [userId]
    );
    const exportData = {
      export_generated_at: new Date().toISOString(),
      gdpr_note: 'This export contains all personal data FlexFlow holds about you under UK GDPR Article 15.',
      account: userResult.rows[0] || {},
      transactions: txResult.rows,
      mileage_log: mileageResult.rows,
      home_office: hoResult.rows[0] || null,
      committed_bills: billsResult.rows,
      tax_calculations: taxResult.rows,
      connected_accounts: banksResult.rows,
      account_designations: desigResult.rows,
      runway_snapshots: runwayResult.rows,
      notifications: notifResult.rows,
    };
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', 'attachment; filename="FlexFlow-MyData-Export.json"');
    return res.json(exportData);
  } catch (err) {
    console.error('[EXPORT] Error:', err);
    return res.status(500).json({ error: 'Failed to generate data export.' });
  }
});

module.exports = router;
