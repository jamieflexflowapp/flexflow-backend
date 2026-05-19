'use strict';

/**
 * FlexFlow — Auth Controller
 * Session B — Task 3
 *
 * JWT strategy:
 *   Access token  — short-lived (15 min), sent with every API request
 *   Refresh token — long-lived (7 days), used only to get a new access token
 *   Refresh token hash stored in users.refresh_token_hash (bcrypt)
 *   On logout: hash is cleared — token is invalidated server-side
 */

const bcrypt = require('bcryptjs');
const jwt    = require('jsonwebtoken');
const { query } = require('../config/database');

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

function validateEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function validatePassword(password) {
  // Minimum 8 chars, at least one letter and one number
  return password && password.length >= 8 && /[a-zA-Z]/.test(password) && /[0-9]/.test(password);
}

// ── POST /auth/register ───────────────────────────────────────────────────────

async function register(req, res) {
  try {
    const { email, password, full_name } = req.body;

    // Validate inputs
    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password are required.' });
    }
    if (!validateEmail(email)) {
      return res.status(400).json({ error: 'Please enter a valid email address.' });
    }
    if (!validatePassword(password)) {
      return res.status(400).json({
        error: 'Password must be at least 8 characters and contain at least one letter and one number.'
      });
    }

    // Check if email already registered
    const existing = await query(
      'SELECT id FROM users WHERE email = $1',
      [email.toLowerCase().trim()]
    );
    if (existing.rows.length > 0) {
      return res.status(409).json({ error: 'An account with this email already exists.' });
    }

    // Hash password
    const password_hash = await bcrypt.hash(password, 12);

    // Create user
    const result = await query(
      `INSERT INTO users (email, password_hash, full_name)
       VALUES ($1, $2, $3)
       RETURNING id, email, full_name, plan, onboarding_complete, created_at`,
      [email.toLowerCase().trim(), password_hash, full_name || null]
    );
    const user = result.rows[0];

    // Generate tokens
    const accessToken  = generateAccessToken(user.id);
    const refreshToken = generateRefreshToken(user.id);

    // Store refresh token hash
    const refreshHash = await bcrypt.hash(refreshToken, 10);
    await query(
      'UPDATE users SET refresh_token_hash = $1, last_login_at = NOW() WHERE id = $2',
      [refreshHash, user.id]
    );

    return res.status(201).json({
      message: 'Account created successfully.',
      user: {
        id:                 user.id,
        email:              user.email,
        full_name:          user.full_name,
        plan:               user.plan,
        onboarding_complete: user.onboarding_complete,
      },
      access_token:  accessToken,
      refresh_token: refreshToken,
    });

  } catch (err) {
    console.error('Register error:', err);
    return res.status(500).json({ error: 'Registration failed. Please try again.' });
  }
}

// ── POST /auth/login ──────────────────────────────────────────────────────────

async function login(req, res) {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password are required.' });
    }

    // Find user
    const result = await query(
      `SELECT id, email, full_name, password_hash, plan,
              onboarding_complete, onboarding_step, income_structure,
              is_scottish_taxpayer, subscription_status
       FROM users WHERE email = $1`,
      [email.toLowerCase().trim()]
    );

    if (result.rows.length === 0) {
      // Generic message — don't reveal whether email exists
      return res.status(401).json({ error: 'Incorrect email or password.' });
    }

    const user = result.rows[0];

    // Check password
    const passwordMatch = await bcrypt.compare(password, user.password_hash);
    if (!passwordMatch) {
      return res.status(401).json({ error: 'Incorrect email or password.' });
    }

    // Generate tokens
    const accessToken  = generateAccessToken(user.id);
    const refreshToken = generateRefreshToken(user.id);

    // Store refresh token hash + update last login
    const refreshHash = await bcrypt.hash(refreshToken, 10);
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

    // Verify refresh token signature
    let payload;
    try {
      payload = jwt.verify(refresh_token, process.env.JWT_REFRESH_SECRET);
    } catch (err) {
      return res.status(401).json({ error: 'Invalid or expired refresh token.' });
    }

    if (payload.type !== 'refresh') {
      return res.status(401).json({ error: 'Invalid token type.' });
    }

    // Get user and check stored hash
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

    // Verify the refresh token matches what we stored
    const tokenMatch = await bcrypt.compare(refresh_token, user.refresh_token_hash);
    if (!tokenMatch) {
      return res.status(401).json({ error: 'Invalid refresh token. Please log in again.' });
    }

    // Issue new tokens (rotation — old refresh token invalidated)
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
      // Try to identify the user from the token and clear their hash
      try {
        const payload = jwt.verify(refresh_token, process.env.JWT_REFRESH_SECRET);
        await query(
          'UPDATE users SET refresh_token_hash = NULL WHERE id = $1',
          [payload.userId]
        );
      } catch (err) {
        // Token invalid — that's fine, user is logged out anyway
      }
    }

    return res.status(200).json({ message: 'Logged out successfully.' });

  } catch (err) {
    console.error('Logout error:', err);
    return res.status(500).json({ error: 'Logout failed.' });
  }
}

module.exports = { register, login, refresh, logout };
