'use strict';

const express        = require('express');
const router         = express.Router();
const authController = require('../middleware/authController');
const { verifyToken } = require('../middleware/auth');
const bcrypt         = require('bcryptjs');
const { query, withTransaction } = require('../config/database');
const { sendEmail } = require('../utils/sendgrid');

router.post('/register',            authController.register);
router.post('/verify-email',        authController.verifyEmail);
router.post('/forgot-password',     authController.forgotPassword);
router.post('/reset-password',      authController.resetPassword);
router.post('/resend-verification', authController.resendVerification);
router.post('/login',               authController.login);
router.post('/refresh',             authController.refresh);
router.post('/logout',              authController.logout);

// GET /auth/me
router.get('/me', verifyToken, async (req, res) => {
  try {
    const r = await query(
      `SELECT id, full_name, email, plan, income_structure, tax_code,
              is_scottish_taxpayer, onboarding_complete, onboarding_step, director_salary_annual,
              dividend_frequency, receives_pension, tax_year_splash_seen
       FROM users WHERE id = $1`,
      [req.user.userId]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'User not found' });
    const u = r.rows[0];
    res.json({
      id:                   u.id,
      full_name:            u.full_name,
      email:                u.email,
      plan:                 u.plan || 'free',
      income_structure:     u.income_structure,
      tax_code:             u.tax_code || '1257L',
      is_scottish_taxpayer: !!u.is_scottish_taxpayer,
      onboarding_complete:  !!u.onboarding_complete,
      onboarding_step:      u.onboarding_step,
      director_salary_annual: u.director_salary_annual,
      dividend_frequency:      u.dividend_frequency,
      receives_pension:        !!u.receives_pension,
      tax_year_splash_seen:    u.tax_year_splash_seen || null,
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to load profile' });
  }
});

// DELETE /auth/account
router.delete('/account', verifyToken, async (req, res) => {
  try {
    const userId = req.user.userId;
    const { password, reason, otherReason } = req.body;

    if (!password) return res.status(400).json({ error: 'Password required' });

    const userResult = await query(`SELECT email, password_hash, full_name, income_structure, tax_code, is_scottish_taxpayer, plan, created_at FROM users WHERE id = $1`, [userId]);
    if (!userResult.rows[0]) return res.status(404).json({ error: 'User not found' });
    const { email, password_hash, full_name, income_structure, tax_code, is_scottish_taxpayer, plan, created_at } = userResult.rows[0];

    const valid = await bcrypt.compare(password, password_hash);
    if (!valid) return res.status(401).json({ error: 'Incorrect password' });

    const reasonText = reason === 'Other' ? (otherReason || 'Other') : (reason || 'Not provided');

    // --- SINGLE TRANSACTION: archive + delete together, rolls back if anything fails ---
    await withTransaction(async (client) => {
      // Archive user record
      await client.query(
        `INSERT INTO archive.users (original_user_id, deletion_date, deletion_reason, income_structure, tax_code, is_scottish_taxpayer, plan, created_at)
         VALUES ($1, NOW(), $2, $3, $4, $5, $6, $7)
         ON CONFLICT (original_user_id) DO NOTHING`,
        [userId, reasonText, income_structure, tax_code, is_scottish_taxpayer, plan, created_at]
      );
      // Archive transactions
      await client.query(
        `INSERT INTO archive.transactions (id, original_user_id, transaction_date, description, merchant_name, amount, is_income, user_confirmed, category, sub_category, created_at)
         SELECT id, user_id, transaction_date, description, merchant_name, amount, is_income, user_confirmed, category, sub_category, created_at
         FROM transactions WHERE user_id = $1`, [userId]
      );
      // Archive tax calculations
      await client.query(
        `INSERT INTO archive.tax_calculations (original_user_id, tax_year, gross_se_income, gross_paye_income, gross_dividend_income, total_tax_liability, it_total, ni_total, calculated_at)
         SELECT user_id, tax_year, gross_se_income, gross_paye_income, gross_dividend_income, total_tax_liability, it_total, ni_total, calculated_at
         FROM tax_calculations WHERE user_id = $1`, [userId]
      );
      // Archive committed bills
      await client.query(
        `INSERT INTO archive.committed_bills (original_user_id, name, amount, day_of_month, source, created_at)
         SELECT user_id, name, amount, day_of_month, source, created_at
         FROM committed_bills WHERE user_id = $1`, [userId]
      );
      // Archive mileage log
      await client.query(
        `INSERT INTO archive.mileage_log (original_user_id, journey_date, purpose, miles, tax_year, created_at)
         SELECT user_id, journey_date, purpose, miles, tax_year, created_at
         FROM mileage_log WHERE user_id = $1`, [userId]
      );
      // Archive home office config
      await client.query(
        `INSERT INTO archive.home_office_config (original_user_id, monthly_hours, method, monthly_deduction, annual_deduction)
         SELECT user_id, monthly_hours, method, monthly_deduction, annual_deduction
         FROM home_office_config WHERE user_id = $1
         ON CONFLICT (original_user_id) DO NOTHING`, [userId]
      );
      // Archive runway snapshots
      await client.query(
        `INSERT INTO archive.runway_snapshots (original_user_id, snapshot_date, bank_balance, available_balance, runway_weeks, runway_status, created_at)
         SELECT user_id, snapshot_date, bank_balance, available_balance, runway_weeks, runway_status, snapshot_date
         FROM runway_snapshots WHERE user_id = $1`, [userId]
      );
      // Hard delete from live DB — only runs if all archive inserts succeeded
      await client.query(`DELETE FROM users WHERE id = $1`, [userId]);
    });

    // --- Send notification email (outside transaction — non-critical) ---
    const deletedAt = new Date().toLocaleString('en-GB', { timeZone: 'Europe/London' });
    await sendEmail({
      to: 'jamie@flexflowapp.co.uk',
      subject: `FlexFlow — Account Deleted: ${email}`,
      text: `A FlexFlow account has been deleted.\n\nEmail: ${email}\nName: ${full_name}\nUser ID: ${userId}\nReason: ${reasonText}\nDeleted at: ${deletedAt} (London time)\n\nData archived for 6-year retention. Live account permanently deleted.`,
      html: `<h2>FlexFlow Account Deletion</h2><table><tr><td><b>Email:</b></td><td>${email}</td></tr><tr><td><b>Name:</b></td><td>${full_name}</td></tr><tr><td><b>User ID:</b></td><td>${userId}</td></tr><tr><td><b>Reason:</b></td><td>${reasonText}</td></tr><tr><td><b>Deleted at:</b></td><td>${deletedAt} (London time)</td></tr></table><p>Data archived for 6-year retention. Live account permanently deleted.</p>`,
    }).catch(e => console.warn('[DELETE] Email notify failed:', e.message));

    console.log('[DELETE ACCOUNT] SUCCESS — sending success response');
    res.json({ success: true });
  } catch (err) {
    console.error('[DELETE ACCOUNT] FAILED:', err.message);
    res.status(500).json({ error: 'Failed to delete account' });
  }
});

// POST /auth/tax-year-splash-seen — mark splash as seen for current tax year
router.post('/tax-year-splash-seen', verifyToken, async (req, res) => {
  try {
    const { getCurrentTaxYear } = require('../utils/taxYear');
    const taxYear = getCurrentTaxYear();
    await query(
      `UPDATE users SET tax_year_splash_seen = $1 WHERE id = $2`,
      [taxYear, req.user.userId]
    );
    res.json({ success: true, tax_year: taxYear });
  } catch (err) {
    res.status(500).json({ error: 'Failed to update tax year splash state' });
  }
});

module.exports = router;
