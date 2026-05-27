'use strict';

/**
 * FlexFlow — Income Routes
 * Session D — Task 5
 *
 * GET  /income/personal           — get current Personal Income figure
 * POST /income/recalculate        — manually trigger recalculation
 * GET  /income/sources            — list income sources with reliability scores
 * PUT  /income/settings           — update reserve buffer or window months
 * POST /income/events/:id/exclude — exclude an event from smoothing window
 */

const express = require('express');
const router  = express.Router();
const { verifyToken, checkOnboardingComplete } = require('../middleware/auth');
const { calculatePersonalIncome } = require('../engines/ise');
const { query } = require('../config/database');

// All income routes require auth + completed onboarding
router.use(verifyToken, checkOnboardingComplete);

// ── GET /income/personal ──────────────────────────────────────────────────────
// Returns the current Personal Income figure
// If never calculated, triggers calculation first

router.get('/personal', async (req, res) => {
  try {
    const userResult = await query(
      `SELECT personal_income, confidence_level, gross_avg_monthly_se,
              reserve_amount, months_of_data,
              last_smoothing_calculated, tax_pot_target
       FROM users WHERE id = $1`,
      [req.user.userId]
    );

    const user = userResult.rows[0];

    // If never calculated, run now
    if (!user.last_smoothing_calculated) {
      const result = await calculatePersonalIncome(req.user.userId);
      return res.json(result);
    }

    // Return cached result with metadata
    const grossAvg = parseFloat(user.gross_avg_monthly_se) || 0;
    return res.json({
      personal_income:        parseFloat(user.personal_income) || 0,
      personalIncome:         parseFloat(user.personal_income) || 0,
      confidence_level:       user.confidence_level || 'LOW',
      confidenceLevel:        user.confidence_level || 'LOW',
      confidence:             user.confidence_level || 'LOW',
      gross_avg_monthly_se:   grossAvg,
      grossAvgMonthlySe:      grossAvg,
      fytdTotal:              grossAvg * (user.months_of_data || 0),
      reserve_amount:         parseFloat(user.reserve_amount) || 0,
      monthly_tax_allocation: parseFloat(user.tax_pot_target) || 0,
      monthlyTaxAllocation:   parseFloat(user.tax_pot_target) || 0,
      months_of_data:         user.months_of_data || 0,
      monthsOfData:           user.months_of_data || 0,
      last_calculated:        user.last_smoothing_calculated,
      volatility:             { label: 'STABLE', stdDeviation: 0, copy: 'Calculating...' },
      sources:                [],
    });

  } catch (err) {
    console.error('Personal income error:', err);
    return res.status(500).json({ error: 'Failed to retrieve Personal Income.' });
  }
});

// ── POST /income/recalculate ──────────────────────────────────────────────────
// Manually trigger a recalculation (also called automatically by events)

router.post('/recalculate', async (req, res) => {
  try {
    const result = await calculatePersonalIncome(req.user.userId);
    return res.json({ message: 'Personal Income recalculated.', ...result });
  } catch (err) {
    console.error('Recalculate error:', err);
    return res.status(500).json({ error: 'Recalculation failed.' });
  }
});

// ── GET /income/sources ───────────────────────────────────────────────────────
// Income sources with reliability scores — GREEN/AMBER/RED

router.get('/sources', async (req, res) => {
  try {
    const result = await query(
      `SELECT id, name, source_type, provider_name,
              average_monthly, reliability_score, last_seen_at,
              is_rental, is_active
       FROM income_sources
       WHERE user_id = $1
       ORDER BY reliability_score ASC, average_monthly DESC`,
      [req.user.userId]
    );

    return res.json({ sources: result.rows });
  } catch (err) {
    console.error('Income sources error:', err);
    return res.status(500).json({ error: 'Failed to retrieve income sources.' });
  }
});

// ── PUT /income/settings ──────────────────────────────────────────────────────
// Update reserve buffer % or rolling window (PRO only for 12-month window)

router.put('/settings', async (req, res) => {
  try {
    const { rolling_window_months } = req.body;

    const updates = [];
    const values  = [];
    let i = 1;

    if (false) {
      const pct = 0;
      // Enforce 5–40% range (spec Part 4.1)
      if (pct < 0.05 || pct > 0.40) {
        return res.status(400).json({
          error: 'Reserve buffer must be between 5% and 40%.',
        });
      }
      values.push(pct);
    }

    if (rolling_window_months !== undefined) {
      // 12-month window is PRO only
      const userPlan = await query(
        `SELECT plan FROM users WHERE id = $1`, [req.user.userId]
      );
      if (rolling_window_months === 12 && userPlan.rows[0]?.plan !== 'pro') {
        return res.status(403).json({
          error: '12-month rolling window is available on the Pro plan.',
        });
      }
      if (![6, 12].includes(parseInt(rolling_window_months))) {
        return res.status(400).json({ error: 'Rolling window must be 6 or 12 months.' });
      }
      updates.push(`rolling_window_months = $${i++}`);
      values.push(rolling_window_months);
    }

    if (updates.length === 0) {
      return res.status(400).json({ error: 'No settings provided.' });
    }

    updates.push(`updated_at = NOW()`);
    values.push(req.user.userId);

    await query(
      `UPDATE users SET ${updates.join(', ')} WHERE id = $${i}`,
      values
    );

    // Recalculate with new settings
    const result = await calculatePersonalIncome(req.user.userId);
    return res.json({
      message: 'Settings updated. Personal Income recalculated.',
      ...result,
    });

  } catch (err) {
    console.error('Income settings error:', err);
    return res.status(500).json({ error: 'Failed to update settings.' });
  }
});

// ── POST /income/events/:id/exclude ──────────────────────────────────────────
// Exclude a one-off income event from the smoothing window
// e.g. equipment sale that shouldn't inflate the average

router.post('/events/:id/exclude', async (req, res) => {
  try {
    const { id } = req.params;

    // Verify this event belongs to this user
    const check = await query(
      `SELECT id FROM income_events WHERE id = $1 AND user_id = $2`,
      [id, req.user.userId]
    );

    if (check.rows.length === 0) {
      return res.status(404).json({ error: 'Income event not found.' });
    }

    await query(
      `UPDATE income_events
       SET included_in_smoothing = false, updated_at = NOW()
       WHERE id = $1`,
      [id]
    );

    // Recalculate with this event excluded
    const result = await calculatePersonalIncome(req.user.userId);
    return res.json({
      message: 'Event excluded from Personal Income calculation.',
      ...result,
    });

  } catch (err) {
    console.error('Exclude event error:', err);
    return res.status(500).json({ error: 'Failed to exclude event.' });
  }
});

module.exports = router;
