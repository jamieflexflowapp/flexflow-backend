'use strict';

/**
 * FlexFlow — Auth Middleware
 * Session B — Task 3
 *
 * Two middleware functions:
 *
 * 1. verifyToken
 *    Validates the JWT access token on every protected route.
 *    Attaches req.user = { userId } for downstream use.
 *
 * 2. checkOnboardingComplete
 *    Applied to all dashboard routes AFTER verifyToken.
 *    Returns 403 until users.onboarding_complete = true.
 *    This is the gate — the app is unusable until the user has
 *    completed their income profile setup.
 */

const jwt    = require('jsonwebtoken');
const { query } = require('../config/database');

// ── 1. Verify JWT access token ────────────────────────────────────────────────

async function verifyToken(req, res, next) {
  try {
    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'Authentication required.' });
    }

    const token = authHeader.split(' ')[1];

    let payload;
    try {
      payload = jwt.verify(token, process.env.JWT_SECRET);
    } catch (err) {
      if (err.name === 'TokenExpiredError') {
        return res.status(401).json({
          error: 'Session expired.',
          code: 'TOKEN_EXPIRED',   // Mobile app uses this to trigger refresh
        });
      }
      return res.status(401).json({ error: 'Invalid token.' });
    }

    if (payload.type !== 'access') {
      return res.status(401).json({ error: 'Invalid token type.' });
    }

    // Attach user ID for downstream use
    req.user = { userId: payload.userId };
    next();

  } catch (err) {
    console.error('verifyToken error:', err);
    return res.status(500).json({ error: 'Authentication error.' });
  }
}

// ── 2. Onboarding complete gate ───────────────────────────────────────────────
// Applied AFTER verifyToken on all dashboard routes.
// Returns 403 until the user has completed their income profile.
// This ensures no calculation engine ever runs without knowing
// the user's income structure, tax flags, and Scottish status.

async function checkOnboardingComplete(req, res, next) {
  try {
    const result = await query(
      `SELECT onboarding_complete, onboarding_step, income_structure
       FROM users WHERE id = $1`,
      [req.user.userId]
    );

    if (result.rows.length === 0) {
      return res.status(401).json({ error: 'User not found.' });
    }

    const user = result.rows[0];

    if (!user.onboarding_complete) {
      return res.status(403).json({
        error: 'Please complete your income profile setup to access FlexFlow.',
        code: 'ONBOARDING_INCOMPLETE',
        onboarding_step: user.onboarding_step,  // Mobile app uses this to resume
      });
    }

    // Attach full user context for engines
    req.user.income_structure = user.income_structure;
    next();

  } catch (err) {
    console.error('checkOnboardingComplete error:', err);
    return res.status(500).json({ error: 'Authentication error.' });
  }
}

module.exports = { verifyToken, checkOnboardingComplete };
