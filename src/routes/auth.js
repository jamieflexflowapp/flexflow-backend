'use strict';

const express        = require('express');
const router         = express.Router();
const authController = require('../middleware/authController');
const { verifyToken } = require('../middleware/auth');
const bcrypt         = require('bcryptjs');
const { query }      = require('../config/database');
const { sendVerificationEmail } = require('../utils/sendgrid');

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
  console.log('[DELETE] endpoint hit, body:', JSON.stringify(req.body), 'user:', req.user?.userId);
  try {
    const userId = req.user.userId;
    const { password, reason, otherReason } = req.body;

    if (!password) return res.status(400).json({ error: 'Password required' });

    const userResult = await query(`SELECT email, password_hash FROM users WHERE id = $1`, [userId]);
    if (!userResult.rows[0]) return res.status(404).json({ error: 'User not found' });
    const { email, password_hash } = userResult.rows[0];

    const valid = await bcrypt.compare(password, password_hash);
    if (!valid) return res.status(401).json({ error: 'Incorrect password' });

    const tables = [
      'notifications', 'account_designations', 'committed_bills',
      'transactions', 'bank_connections', 'income_events',
      'tax_calculations', 'tax_verification', 'quarterly_review_log',
      'expense_categories', 'user_sessions',
    ];
    for (const table of tables) {
      try { await query(`DELETE FROM ${table} WHERE user_id = $1`, [userId]); } catch(e) {}
    }
    await query(`DELETE FROM users WHERE id = $1`, [userId]);

    const deletedAt = new Date().toLocaleString('en-GB', { timeZone: 'Europe/London' });
    const reasonText = reason === 'Other' ? (otherReason || 'Other') : (reason || 'Not provided');
    await sendEmail({
      to: 'jamie@flexflowapp.co.uk',
      subject: `FlexFlow — Account Deleted: ${email}`,
      text: `A FlexFlow account has been deleted.\n\nEmail: ${email}\nUser ID: ${userId}\nReason: ${reasonText}\nDeleted at: ${deletedAt} (London time)\n\nThis is an automated notification.`,
      html: `<h2>FlexFlow Account Deletion</h2><table><tr><td><b>Email:</b></td><td>${email}</td></tr><tr><td><b>User ID:</b></td><td>${userId}</td></tr><tr><td><b>Reason:</b></td><td>${reasonText}</td></tr><tr><td><b>Deleted at:</b></td><td>${deletedAt} (London time)</td></tr></table>`,
    }).catch(e => console.warn('[DELETE] Email notify failed:', e.message));

    res.json({ success: true });
  } catch (err) {
    console.error('[DELETE ACCOUNT]', err);
    res.status(500).json({ error: 'Failed to delete account' });
  }
});

module.exports = router;
