'use strict';

/**
 * FlexFlow — Auth Controller
 * Updated Phase 4 — Email verification added
 *
 * JWT strategy:
 *   Access token  — short-lived (15 min), sent with every API request
 *   Refresh token — long-lived (7 days), used only to get a new access token
 *   Refresh token hash stored in users.refresh_token_hash (bcrypt)
 *   On logout: hash is cleared — token is invalidated server-side
 *
 * Email verification:
 *   6-digit code generated at register, stored hashed in DB
 *   Expires after 15 minutes
 *   POST /auth/verify-email — validates code, marks user verified
 *   POST /auth/resend-verification — generates new code, sends new email
 */

const bcrypt = require('bcryptjs');
const jwt    = require('jsonwebtoken');
const crypto = require('crypto');
const { query } = require('../config/database');

// SendGrid — graceful fallback if not installed yet
let sendVerificationEmail, sendWelcomeEmail;
try {
  const sg = require('../utils/sendgrid');
  sendVerificationEmail = sg.sendVerificationEmail;
  sendWelcomeEmail      = sg.sendWelcomeEmail;
} catch (err) {
  // SendGrid not installed — log code to console during development
  sendVerificationEmail = async (email, name, code) => {
    if (process.env.NODE_ENV === 'development') console.log(`[DEV EMAIL] Verification code for ${email}: ${code}`);
  };
  sendWelcomeEmail = async (email, name) => {
    if (process.env.NODE_ENV === 'development') console.log(`[DEV EMAIL] Welcome email sent to ${email}`);
  };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function generateAccessToken(userId) {
  return jwt.sign(
    { userId, type: 'access' },
    process.env.JWT_SECRET,
    { expiresIn: process.env.JWT_EXPIRES_IN || '15m' }
  );
}

function generateRefreshToken(userId) {
  return jwt.sign(
    { userId, type: 'refresh' },
    process.env.JWT_REFRESH_SECRET,
    { expiresIn: process.env.JWT_REFRESH_EXPIRES_IN || '7d' }
  );
}

function generateVerificationCode() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

function validateEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function validatePassword(password, firstName, lastName) {
  if (!password || password.length < 8)         return 'At least 8 characters required.';
  if (!/[A-Z]/.test(password))                  return 'At least one uppercase letter required.';
  if (!/[a-z]/.test(password))                  return 'At least one lowercase letter required.';
  if (!/[0-9]/.test(password))                  return 'At least one number required.';
  if (firstName && password.toLowerCase().includes(firstName.toLowerCase()))
    return 'Password cannot contain your name.';
  if (lastName && password.toLowerCase().includes(lastName.toLowerCase()))
    return 'Password cannot contain your name.';
  return null;
}

// ── POST /auth/register ───────────────────────────────────────────────────────

async function register(req, res) {
  try {
    const { email, password, first_name, last_name } = req.body;
    const full_name = [first_name, last_name].filter(Boolean).join(' ') || null;

    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password are required.' });
    }
    if (!validateEmail(email)) {
      return res.status(400).json({ error: 'Please enter a valid email address.' });
    }
    const pwError = validatePassword(password, first_name, last_name);
    if (pwError) {
      return res.status(400).json({ error: pwError });
    }

    // Check if email already registered
    const existing = await query(
      'SELECT id, email_verified, verification_expires FROM users WHERE email = $1',
      [email.toLowerCase().trim()]
    );
    if (existing.rows.length > 0) {
      if (!existing.rows[0].email_verified) {
        // Auto-delete if verification has expired — lets user start fresh cleanly
        const expiry = existing.rows[0].verification_expires;
        if (expiry && new Date() > new Date(expiry)) {
          await query('DELETE FROM users WHERE email = $1', [email.toLowerCase().trim()]);
          // Fall through to fresh registration below
        } else {
          return res.status(409).json({
            error: 'An account with this email exists but is not verified. Please check your inbox or resend the code.',
            unverified: true
          });
        }
      } else {
        return res.status(409).json({ error: 'An account with this email already exists.' });
      }
    }

    // Hash password
    const password_hash = await bcrypt.hash(password, 12);

    // Generate verification code
    const code    = generateVerificationCode();
    const expires = new Date(Date.now() + 15 * 60 * 1000); // 15 minutes

    // Create user (unverified)
    const result = await query(
      `INSERT INTO users (email, password_hash, full_name, email_verified,
                          verification_code, verification_expires)
       VALUES ($1, $2, $3, false, $4, $5)
       RETURNING id, email, full_name, plan, onboarding_complete`,
      [email.toLowerCase().trim(), password_hash, full_name, code, expires]
    );
    const user = result.rows[0];

    // Send verification email
    await sendVerificationEmail(email, first_name || 'there', code);

    return res.status(201).json({
      message: 'Account created. Please check your email for your verification code.',
      user_id: user.id,
      email:   user.email,
    });

  } catch (err) {
    console.error('Register error:', err);
    return res.status(500).json({ error: 'Registration failed. Please try again.' });
  }
}

// ── POST /auth/verify-email ───────────────────────────────────────────────────

async function verifyEmail(req, res) {
  try {
    const { email, code } = req.body;

    if (!email || !code) {
      return res.status(400).json({ error: 'Email and verification code are required.' });
    }

    const result = await query(
      `SELECT id, full_name, email_verified, verification_code,
              verification_expires, plan, onboarding_complete
       FROM users WHERE email = $1`,
      [email.toLowerCase().trim()]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Account not found.' });
    }

    const user = result.rows[0];

    if (user.email_verified) {
      return res.status(400).json({ error: 'This account is already verified.' });
    }

    if (!user.verification_code || user.verification_code !== code.trim()) {
      return res.status(400).json({ error: 'Incorrect verification code. Please try again.' });
    }

    if (new Date() > new Date(user.verification_expires)) {
      return res.status(400).json({
        error: 'This code has expired. Please request a new one.',
        expired: true
      });
    }

    // Mark as verified and clear code
    await query(
      `UPDATE users
       SET email_verified = true, verification_code = NULL,
           verification_expires = NULL, last_login_at = NOW()
       WHERE id = $1`,
      [user.id]
    );

    // Send welcome email
    await sendWelcomeEmail(email, user.full_name ? user.full_name.split(' ')[0] : 'there');

    // Generate tokens — user is now logged in
    const accessToken  = generateAccessToken(user.id);
    const refreshToken = generateRefreshToken(user.id);
    const refreshHash  = await bcrypt.hash(refreshToken, 10);

    await query(
      'UPDATE users SET refresh_token_hash = $1 WHERE id = $2',
      [refreshHash, user.id]
    );

    return res.status(200).json({
      message: 'Email verified successfully. Welcome to FlexFlow!',
      user: {
        id:                  user.id,
        email:               email,
        full_name:           user.full_name,
        plan:                user.plan,
        onboarding_complete: user.onboarding_complete,
      },
      access_token:  accessToken,
      refresh_token: refreshToken,
    });

  } catch (err) {
    console.error('Verify email error:', err);
    return res.status(500).json({ error: 'Verification failed. Please try again.' });
  }
}

// ── POST /auth/resend-verification ────────────────────────────────────────────

async function resendVerification(req, res) {
  try {
    const { email } = req.body;

    if (!email) {
      return res.status(400).json({ error: 'Email is required.' });
    }

    const result = await query(
      'SELECT id, full_name, email_verified FROM users WHERE email = $1',
      [email.toLowerCase().trim()]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Account not found.' });
    }

    const user = result.rows[0];

    if (user.email_verified) {
      return res.status(400).json({ error: 'This account is already verified.' });
    }

    // Generate new code
    const code    = generateVerificationCode();
    const expires = new Date(Date.now() + 15 * 60 * 1000);

    await query(
      'UPDATE users SET verification_code = $1, verification_expires = $2 WHERE id = $3',
      [code, expires, user.id]
    );

    const firstName = user.full_name ? user.full_name.split(' ')[0] : 'there';
    await sendVerificationEmail(email, firstName, code);

    return res.status(200).json({
      message: 'A new verification code has been sent to your email.'
    });

  } catch (err) {
    console.error('Resend verification error:', err);
    return res.status(500).json({ error: 'Failed to resend code. Please try again.' });
  }
}

// ── POST /auth/login ──────────────────────────────────────────────────────────

async function login(req, res) {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password are required.' });
    }

    const result = await query(
      `SELECT id, email, full_name, password_hash, plan, email_verified,
              onboarding_complete, onboarding_step, income_structure,
              is_scottish_taxpayer, subscription_status,
              two_fa_enabled
       FROM users WHERE email = $1`,
      [email.toLowerCase().trim()]
    );

    if (result.rows.length === 0) {
      return res.status(401).json({ error: 'Incorrect email or password.' });
    }

    const user = result.rows[0];

    const passwordMatch = await bcrypt.compare(password, user.password_hash);
    if (!passwordMatch) {
      return res.status(401).json({ error: 'Incorrect email or password.' });
    }

    // Block login if email not verified
    if (!user.email_verified) {
      return res.status(403).json({
        error: 'Please verify your email before logging in.',
        unverified: true,
        email: user.email,
      });
    }

    if (user.two_fa_enabled) {
      const tempToken = jwt.sign(
        { userId: user.id, type: '2fa_pending' },
        process.env.JWT_SECRET,
        { expiresIn: '10m' }
      );
      if (process.env.NODE_ENV === 'development') console.log("[2FA] Sending requires2fa response, temp_token length:", tempToken.length);
      return res.status(200).json({ requires2fa: true, temp_token: tempToken });
    }

    const accessToken  = generateAccessToken(user.id);
    const refreshToken = generateRefreshToken(user.id);
    const refreshHash  = await bcrypt.hash(refreshToken, 10);

    await query(
      'UPDATE users SET refresh_token_hash = $1, last_login_at = NOW() WHERE id = $2',
      [refreshHash, user.id]
    );

    return res.status(200).json({
      user: {
        id:                  user.id,
        email:               user.email,
        full_name:           user.full_name,
        plan:                user.plan,
        onboarding_complete: user.onboarding_complete,
        onboarding_step:     user.onboarding_step,
        income_structure:    user.income_structure,
        is_scottish_taxpayer: user.is_scottish_taxpayer,
        subscription_status: user.subscription_status,
      },
      access_token:  accessToken,
      refresh_token: refreshToken,
    });

  } catch (err) {
    console.error('Login error:', err);
    return res.status(500).json({ error: 'Login failed. Please try again.' });
  }
}

// ── POST /auth/refresh ────────────────────────────────────────────────────────

async function refresh(req, res) {
  try {
    const { refresh_token } = req.body;

    if (!refresh_token) {
      return res.status(400).json({ error: 'Refresh token required.' });
    }

    let payload;
    try {
      payload = jwt.verify(refresh_token, process.env.JWT_REFRESH_SECRET);
    } catch (err) {
      return res.status(401).json({ error: 'Invalid or expired refresh token.' });
    }

    if (payload.type !== 'refresh') {
      return res.status(401).json({ error: 'Invalid token type.' });
    }

    const result = await query(
      'SELECT id, refresh_token_hash, onboarding_complete FROM users WHERE id = $1',
      [payload.userId]
    );

    if (result.rows.length === 0) {
      return res.status(401).json({ error: 'User not found.' });
    }

    const user = result.rows[0];

    if (!user.refresh_token_hash) {
      return res.status(401).json({ error: 'Session expired. Please log in again.' });
    }

    const tokenMatch = await bcrypt.compare(refresh_token, user.refresh_token_hash);
    if (!tokenMatch) {
      return res.status(401).json({ error: 'Invalid refresh token. Please log in again.' });
    }

    const newAccessToken  = generateAccessToken(user.id);
    const newRefreshToken = generateRefreshToken(user.id);
    const newRefreshHash  = await bcrypt.hash(newRefreshToken, 10);

    await query(
      'UPDATE users SET refresh_token_hash = $1 WHERE id = $2',
      [newRefreshHash, user.id]
    );

    return res.status(200).json({
      access_token:  newAccessToken,
      refresh_token: newRefreshToken,
    });

  } catch (err) {
    console.error('Refresh error:', err);
    return res.status(500).json({ error: 'Token refresh failed.' });
  }
}

// ── POST /auth/logout ─────────────────────────────────────────────────────────

async function logout(req, res) {
  try {
    const { refresh_token } = req.body;

    if (refresh_token) {
      try {
        const payload = jwt.verify(refresh_token, process.env.JWT_REFRESH_SECRET);
        await query(
          'UPDATE users SET refresh_token_hash = NULL WHERE id = $1',
          [payload.userId]
        );
      } catch (err) {
        // Token invalid — fine, user is logged out anyway
      }
    }

    return res.status(200).json({ message: 'Logged out successfully.' });

  } catch (err) {
    console.error('Logout error:', err);
    return res.status(500).json({ error: 'Logout failed.' });
  }
}

// ── Forgot Password ──────────────────────────────────────────────────────────
async function forgotPassword(req, res) {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: 'Email is required.' });

    const { rows } = await query(
      `SELECT id, full_name FROM users WHERE email = $1`,
      [email.toLowerCase().trim()]
    );

    // Always return success — don't reveal if email exists
    if (rows.length === 0) {
      return res.json({ message: 'If that email exists, a reset code has been sent.' });
    }

    const user = rows[0];
    const firstName = user.full_name?.split(' ')[0] || 'there';
    const code = String(Math.floor(100000 + Math.random() * 900000));
    const expires = new Date(Date.now() + 15 * 60 * 1000);

    await query(
      `UPDATE users SET pw_reset_code = $1, pw_reset_expires = $2 WHERE id = $3`,
      [code, expires, user.id]
    );

    const sg = require('../utils/sendgrid');
    await sg.sendPasswordResetEmail(email.toLowerCase().trim(), firstName, code);

    res.json({ message: 'If that email exists, a reset code has been sent.' });
  } catch (err) {
    console.error('[FORGOT-PASSWORD]', err.message);
    res.status(500).json({ error: 'Failed to send reset email.' });
  }
}

// ── Reset Password ────────────────────────────────────────────────────────────
async function resetPassword(req, res) {
  try {
    const { email, code, password } = req.body;
    if (!email || !code || !password) {
      return res.status(400).json({ error: 'Email, code and new password are required.' });
    }

    const { rows } = await query(
      `SELECT id, full_name, pw_reset_code, pw_reset_expires FROM users WHERE email = $1`,
      [email.toLowerCase().trim()]
    );

    if (rows.length === 0) return res.status(400).json({ error: 'Invalid or expired code.' });

    const user = rows[0];
    if (!user.pw_reset_code || user.pw_reset_code !== code) {
      return res.status(400).json({ error: 'Invalid or expired code.' });
    }
    if (new Date() > new Date(user.pw_reset_expires)) {
      return res.status(400).json({ error: 'Reset code has expired. Please request a new one.' });
    }

    const firstName = user.full_name?.split(' ')[0] || '';
    const lastName  = user.full_name?.split(' ').slice(1).join(' ') || '';
    const pwError = validatePassword(password, firstName, lastName);
    if (pwError) return res.status(400).json({ error: pwError });

    const password_hash = await bcrypt.hash(password, 12);

    await query(
      `UPDATE users SET password_hash = $1, pw_reset_code = NULL, pw_reset_expires = NULL WHERE id = $2`,
      [password_hash, user.id]
    );

    res.json({ message: 'Password reset successfully. You can now sign in.' });
  } catch (err) {
    console.error('[RESET-PASSWORD]', err.message);
    res.status(500).json({ error: 'Failed to reset password.' });
  }
}

module.exports = { register, verifyEmail, resendVerification, login, refresh, logout, forgotPassword, resetPassword, generateAccessToken, generateRefreshToken };
