'use strict';

const express   = require('express');
const router    = express.Router();
const speakeasy = require('speakeasy');
const QRCode    = require('qrcode');
const jwt       = require('jsonwebtoken');
const { query } = require('../config/database');
const { verifyToken } = require('../middleware/auth');

// ── POST /auth/2fa/setup ──────────────────────────────────────────────────────
// Generate a new TOTP secret and return QR code for the user to scan
router.post('/setup', verifyToken, async (req, res) => {
  try {
    const secret = speakeasy.generateSecret({
      name: `FlexFlow (${req.user.email || 'your account'})`,
      length: 20,
    });

    // Store secret temporarily (unconfirmed until /confirm is called)
    await query(
      'UPDATE users SET totp_secret = $1 WHERE id = $2',
      [secret.base32, req.user.userId]
    );

    const qrCodeDataUrl = await QRCode.toDataURL(secret.otpauth_url);

    return res.json({
      secret: secret.base32,
      qrCode: qrCodeDataUrl,
      otpauthUrl: secret.otpauth_url,
      manualCode: secret.base32,
    });
  } catch (err) {
    console.error('[2FA SETUP]', err.message);
    return res.status(500).json({ error: 'Failed to set up 2FA.' });
  }
});

// ── POST /auth/2fa/confirm ────────────────────────────────────────────────────
// Verify the first code from the authenticator app and enable 2FA
router.post('/confirm', verifyToken, async (req, res) => {
  try {
    const { code } = req.body;
    if (!code) return res.status(400).json({ error: 'Code required.' });

    const result = await query(
      'SELECT totp_secret FROM users WHERE id = $1',
      [req.user.userId]
    );
    const secret = result.rows[0]?.totp_secret;
    if (!secret) return res.status(400).json({ error: 'No 2FA setup in progress.' });

    const verified = speakeasy.totp.verify({
      secret,
      encoding: 'base32',
      token: code,
      window: 1,
    });

    if (!verified) return res.status(400).json({ error: 'Invalid code. Please try again.' });

    await query(
      'UPDATE users SET two_fa_enabled = true WHERE id = $1',
      [req.user.userId]
    );

    // Insert nudge notification dismissal — remove the 2FA nudge now it's enabled
    await query(
      `UPDATE notifications SET is_dismissed = true, dismissed_at = NOW()
       WHERE user_id = $1 AND alert_type = '2fa_nudge'`,
      [req.user.userId]
    );

    return res.json({ success: true, two_fa_enabled: true });
  } catch (err) {
    console.error('[2FA CONFIRM]', err.message);
    return res.status(500).json({ error: 'Failed to confirm 2FA.' });
  }
});

// ── POST /auth/2fa/disable ────────────────────────────────────────────────────
// Disable 2FA after verifying a valid code
router.post('/disable', verifyToken, async (req, res) => {
  try {
    const { code } = req.body;
    if (!code) return res.status(400).json({ error: 'Code required.' });

    const result = await query(
      'SELECT totp_secret FROM users WHERE id = $1',
      [req.user.userId]
    );
    const secret = result.rows[0]?.totp_secret;
    if (!secret) return res.status(400).json({ error: '2FA is not enabled.' });

    const verified = speakeasy.totp.verify({
      secret,
      encoding: 'base32',
      token: code,
      window: 1,
    });

    if (!verified) return res.status(400).json({ error: 'Invalid code. Please try again.' });

    await query(
      'UPDATE users SET two_fa_enabled = false, totp_secret = NULL WHERE id = $1',
      [req.user.userId]
    );

    return res.json({ success: true, two_fa_enabled: false });
  } catch (err) {
    console.error('[2FA DISABLE]', err.message);
    return res.status(500).json({ error: 'Failed to disable 2FA.' });
  }
});

// ── POST /auth/2fa/validate ───────────────────────────────────────────────────
// Called at login when 2FA is required — exchange temp token for full JWT
router.post('/validate', async (req, res) => {
  try {
    const { temp_token, code } = req.body;
    if (!temp_token || !code) return res.status(400).json({ error: 'temp_token and code required.' });

    let payload;
    try {
      payload = jwt.verify(temp_token, process.env.JWT_SECRET);
    } catch {
      return res.status(401).json({ error: 'Invalid or expired token.' });
    }

    if (payload.type !== '2fa_pending') {
      return res.status(401).json({ error: 'Invalid token type.' });
    }

    const result = await query(
      `SELECT id, email, full_name, plan, onboarding_complete, onboarding_step,
              income_structure, is_scottish_taxpayer, subscription_status,
              totp_secret, two_fa_enabled
       FROM users WHERE id = $1`,
      [payload.userId]
    );

    const user = result.rows[0];
    if (!user) return res.status(401).json({ error: 'User not found.' });

    const verified = speakeasy.totp.verify({
      secret: user.totp_secret,
      encoding: 'base32',
      token: code,
      window: 1,
    });

    if (!verified) return res.status(400).json({ error: 'Invalid code. Please try again.' });

    const bcrypt = require('bcrypt');
    const { generateAccessToken, generateRefreshToken } = require('../middleware/authController');
    const accessToken  = generateAccessToken(user.id);
    const refreshToken = generateRefreshToken(user.id);
    const refreshHash  = await bcrypt.hash(refreshToken, 10);

    await query(
      'UPDATE users SET refresh_token_hash = $1, last_login_at = NOW() WHERE id = $2',
      [refreshHash, user.id]
    );

    return res.json({
      user: {
        id:                   user.id,
        email:                user.email,
        full_name:            user.full_name,
        plan:                 user.plan,
        onboarding_complete:  user.onboarding_complete,
        onboarding_step:      user.onboarding_step,
        income_structure:     user.income_structure,
        is_scottish_taxpayer: user.is_scottish_taxpayer,
        subscription_status:  user.subscription_status,
      },
      access_token:  accessToken,
      refresh_token: refreshToken,
    });
  } catch (err) {
    console.error('[2FA VALIDATE]', err.message);
    return res.status(500).json({ error: 'Failed to validate 2FA.' });
  }
});

// ── GET /auth/2fa/status ──────────────────────────────────────────────────────
router.get('/status', verifyToken, async (req, res) => {
  try {
    const result = await query(
      'SELECT two_fa_enabled FROM users WHERE id = $1',
      [req.user.userId]
    );
    return res.json({ two_fa_enabled: result.rows[0]?.two_fa_enabled || false });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to get 2FA status.' });
  }
});

module.exports = router;
