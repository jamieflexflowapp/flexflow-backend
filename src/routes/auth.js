'use strict';

const express        = require('express');
const router         = express.Router();
const authController = require('../middleware/authController');
const { verifyToken } = require('../middleware/auth');
const bcrypt         = require('bcryptjs');
const { query }      = require('../config/database');
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
              dividend_frequency, receives_pension
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
      dividend_frequency:   u.dividend_frequency,
      receives_pension:     !!u.receives_pension,
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

    const userResult = await query(`SELECT email, password_hash, full_name FROM users WHERE id = $1`, [userId]);
    if (!userResult.rows[0]) return res.status(404).json({ error: 'User not found' });
    const { email, password_hash, full_name } = userResult.rows[0];

    const valid = await bcrypt.compare(password, password_hash);
    if (!valid) return res.status(401).json({ error: 'Incorrect password' });

    // --- HARD DELETE: sensitive/personal tables ---
    const hardDeleteTables = [
      'notifications', 'account_designations', 'bank_connections',
      'tax_verification', 'quarterly_review_log', 'user_sessions',
      'home_office_config', 'mileage_log',
    ];
    for (const table of hardDeleteTables) {
      try { await query(`DELETE FROM ${table} WHERE user_id = $1`, [userId]); } catch(e) {}
    }

    // --- ANONYMISE user record — keep row for 6-year retention ---
    const anonEmail = 'deleted_' + userId + '@deleted.flexflow';
    await query(
      `UPDATE users SET
        full_name = 'Deleted User',
        email = $2,
        password_hash = 'DELETED',
        totp_secret = NULL,
        totp_enabled = false,
        is_verified = false,
        deleted_at = NOW()
       WHERE id = $1`,
      [userId, anonEmail]
    );

    // --- Financial records kept anonymised (user_id retained, no PII) ---
    // transactions, tax_calculations, committed_bills, income_events,
    // expense_categories, runway_snapshots — all kept for 6 years
    // They reference user_id (a UUID) which is no longer linked to any PII

    const deletedAt = new Date().toLocaleString('en-GB', { timeZone: 'Europe/London' });
    const reasonText = reason === 'Other' ? (otherReason || 'Other') : (reason || 'Not provided');
    await sendEmail({
      to: 'jamie@flexflowapp.co.uk',
      subject: `FlexFlow — Account Deleted: ${email}`,
      text: `A FlexFlow account has been deleted.\n\nEmail: ${email}\nName: ${full_name}\nUser ID: ${userId}\nReason: ${reasonText}\nDeleted at: ${deletedAt} (London time)\n\nPersonal data anonymised. Financial records retained for 6 years per retention policy.\n\nThis is an automated notification.`,
      html: `<h2>FlexFlow Account Deletion</h2><table><tr><td><b>Email:</b></td><td>${email}</td></tr><tr><td><b>Name:</b></td><td>${full_name}</td></tr><tr><td><b>User ID:</b></td><td>${userId}</td></tr><tr><td><b>Reason:</b></td><td>${reasonText}</td></tr><tr><td><b>Deleted at:</b></td><td>${deletedAt} (London time)</td></tr></table><p>Personal data anonymised. Financial records retained for 6 years per retention policy.</p>`,
    }).catch(e => console.warn('[DELETE] Email notify failed:', e.message));

    res.json({ success: true });
  } catch (err) {
    console.error('[DELETE ACCOUNT]', err);
    res.status(500).json({ error: 'Failed to delete account' });
  }
});

module.exports = router;
