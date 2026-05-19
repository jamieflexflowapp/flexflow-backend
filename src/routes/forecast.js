'use strict';

/**
 * FlexFlow — Forecast Routes
 * Session I — Task 8
 *
 * GET  /forecast              — generate 90-day cash flow forecast
 * GET  /forecast/history      — historical forecast snapshots
 * POST /forecast/scenario     — create FSBE scenario session (PRO only)
 * GET  /forecast/scenario/:id — retrieve existing scenario session
 * DELETE /forecast/scenario/:id — clear scenario session
 */

const express = require('express');
const router  = express.Router();
const { verifyToken, checkOnboardingComplete } = require('../middleware/auth');
const { generateForecast } = require('../engines/forecast');
const { createScenarioSession, getScenarioSession, purgeExpiredSessions } = require('../engines/fsbe');
const { query } = require('../config/database');

router.use(verifyToken, checkOnboardingComplete);

// ── GET /forecast ─────────────────────────────────────────────────────────────
// Main forecast — tier-gated at API level (FREE = 403)

router.get('/', async (req, res) => {
  try {
    // Tier gate — FREE users cannot access forecasting
    const userResult = await query(
      `SELECT plan FROM users WHERE id = $1`,
      [req.user.userId]
    );
    const plan = userResult.rows[0]?.plan || 'free';

    if (plan === 'free') {
      return res.status(403).json({
        error: 'Cash flow forecasting is available on FlexFlow Plus and Pro.',
        code:  'UPGRADE_REQUIRED',
        upgrade_copy: 'Upgrade to Plus to see your 30-day income forecast, or Pro for the full 90-day view with danger month detection.',
      });
    }

    const result = await generateForecast(req.user.userId);
    return res.json(result);

  } catch (err) {
    console.error('Forecast error:', err);
    return res.status(500).json({ error: 'Failed to generate forecast.' });
  }
});

// ── GET /forecast/history ─────────────────────────────────────────────────────

router.get('/history', async (req, res) => {
  try {
    const userResult = await query(
      `SELECT plan FROM users WHERE id = $1`,
      [req.user.userId]
    );
    if (userResult.rows[0]?.plan === 'free') {
      return res.status(403).json({ error: 'Forecast history requires Plus or Pro.', code: 'UPGRADE_REQUIRED' });
    }

    const result = await query(
      `SELECT snapshot_date, forecast_json, created_at
       FROM forecast_snapshots
       WHERE user_id = $1
       ORDER BY snapshot_date DESC
       LIMIT 90`,
      [req.user.userId]
    );

    return res.json({ snapshots: result.rows });
  } catch (err) {
    console.error('Forecast history error:', err);
    return res.status(500).json({ error: 'Failed to get forecast history.' });
  }
});

// ── POST /forecast/scenario ───────────────────────────────────────────────────
// PRO only — FSBE what-if scenario

router.post('/scenario', async (req, res) => {
  try {
    // PRO gate — enforced at API level (FSBE v1.1 Part 2)
    const userResult = await query(
      `SELECT plan FROM users WHERE id = $1`,
      [req.user.userId]
    );
    const plan = userResult.rows[0]?.plan || 'free';

    if (plan !== 'pro') {
      return res.status(403).json({
        error: 'The Future Scenario Building Tool is available on FlexFlow Pro.',
        code:  'UPGRADE_REQUIRED',
      });
    }

    const { scenario_type, params } = req.body;
    if (!scenario_type || !params) {
      return res.status(400).json({ error: 'scenario_type and params are required.' });
    }

    const result = await createScenarioSession(req.user.userId, scenario_type, params);
    return res.status(201).json(result);

  } catch (err) {
    console.error('Scenario error:', err.message);
    return res.status(400).json({ error: err.message || 'Failed to create scenario.' });
  }
});

// ── GET /forecast/scenario/:id ────────────────────────────────────────────────

router.get('/scenario/:id', async (req, res) => {
  try {
    const userResult = await query(`SELECT plan FROM users WHERE id = $1`, [req.user.userId]);
    if (userResult.rows[0]?.plan !== 'pro') {
      return res.status(403).json({ error: 'PRO required.', code: 'UPGRADE_REQUIRED' });
    }

    const session = await getScenarioSession(req.user.userId, req.params.id);
    return res.json({
      session_id:        session.id,
      scenario_type:     session.scenario_type,
      expires_at:        session.expires_at,
      base_forecast:     JSON.parse(session.base_forecast_json),
      scenario_forecast: JSON.parse(session.scenario_forecast_json),
      impact:            JSON.parse(session.impact_json),
    });
  } catch (err) {
    console.error('Get scenario error:', err.message);
    return res.status(404).json({ error: err.message || 'Scenario not found.' });
  }
});

// ── DELETE /forecast/scenario/:id ─────────────────────────────────────────────

router.delete('/scenario/:id', async (req, res) => {
  try {
    await query(
      `DELETE FROM scenario_sessions WHERE id = $1 AND user_id = $2`,
      [req.params.id, req.user.userId]
    );
    return res.json({ message: 'Scenario cleared.' });
  } catch (err) {
    console.error('Delete scenario error:', err);
    return res.status(500).json({ error: 'Failed to clear scenario.' });
  }
});

module.exports = router;
