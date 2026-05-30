'use strict';

/**
 * FlexFlow — Auth Routes
 * Updated Phase 4 — Email verification routes added
 *
 * POST /auth/register             — create account, send verification email
 * POST /auth/verify-email         — validate 6-digit code, mark verified
 * POST /auth/resend-verification  — resend verification code
 * POST /auth/login                — get access + refresh tokens
 * POST /auth/refresh              — exchange refresh token for new access token
 * POST /auth/logout               — invalidate refresh token
 */

const express = require('express');
const router  = express.Router();
const authController = require('../middleware/authController');

router.post('/register',            authController.register);
router.post('/verify-email',        authController.verifyEmail);
router.post('/forgot-password',     authController.forgotPassword);
router.post('/reset-password',      authController.resetPassword);
router.post('/resend-verification', authController.resendVerification);
router.post('/login',               authController.login);
router.post('/refresh',             authController.refresh);
router.post('/logout',              authController.logout);

module.exports = router;

// GET /auth/me — return current user profile
const { verifyToken } = require('../middleware/auth');
router.get('/me', verifyToken, async (req, res) => {
  try {
    const { query } = require('../config/database');
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
