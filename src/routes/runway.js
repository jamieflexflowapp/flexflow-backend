'use strict';

/**
 * FlexFlow — Runway Routes
 * Session H — Task 7
 *
 * GET  /runway                    — current runway calculation
 * GET  /runway/history            — runway trend (last 30 days)
 * GET  /runway/outgoings          — list Tier 1 committed outgoings
 * POST /runway/outgoings          — add a committed outgoing
 * PUT  /runway/outgoings/:id      — update a committed outgoing
 * DELETE /runway/outgoings/:id    — remove a committed outgoing
 * GET  /runway/tpve               — tax pot verification status
 */

const express = require('express');
const router  = express.Router();
const { verifyToken, checkOnboardingComplete } = require('../middleware/auth');
const { calculateRunway } = require('../engines/runway');
const { query } = require('../config/database');

router.use(verifyToken, checkOnboardingComplete);

// ── GET /runway ───────────────────────────────────────────────────────────────
// The main runway calculation — answers "how long until I run out?"

router.get('/', async (req, res) => {
  try {
    const result = await calculateRunway(req.user.userId);
    return res.json(result);
  } catch (err) {
    console.error('Runway error:', err);
    return res.status(500).json({ error: 'Failed to calculate runway.' });
  }
});

// ── GET /runway/history ───────────────────────────────────────────────────────
// Runway trend — last 30 snapshots for chart display

router.get('/history', async (req, res) => {
  try {
    const result = await query(
      `SELECT snapshot_date, available_balance, tier1_monthly,
              runway_weeks, runway_status
       FROM runway_snapshots
       WHERE user_id = $1
       ORDER BY snapshot_date DESC
       LIMIT 30`,
      [req.user.userId]
    );
    return res.json({ history: result.rows });
  } catch (err) {
    console.error('Runway history error:', err);
    return res.status(500).json({ error: 'Failed to get runway history.' });
  }
});

// ── GET /runway/outgoings ─────────────────────────────────────────────────────
// List all Tier 1 committed outgoings

router.get('/outgoings', async (req, res) => {
  try {
    const result = await query(
      `SELECT id, name, category, amount, frequency, monthly_equiv,
              next_due_date, is_tier1, is_active
       FROM committed_outgoings
       WHERE user_id = $1 AND is_active = true
       ORDER BY monthly_equiv DESC`,
      [req.user.userId]
    );

    const tier1Total = result.rows
      .filter(r => r.is_tier1)
      .reduce((sum, r) => sum + parseFloat(r.monthly_equiv), 0);

    return res.json({
      outgoings:    result.rows,
      tier1_monthly: Math.round(tier1Total * 100) / 100,
    });
  } catch (err) {
    console.error('Outgoings error:', err);
    return res.status(500).json({ error: 'Failed to get outgoings.' });
  }
});

// ── POST /runway/outgoings ────────────────────────────────────────────────────
// Add a committed outgoing

router.post('/outgoings', async (req, res) => {
  try {
    const { name, category, amount, frequency, next_due_date } = req.body;

    if (!name || !amount || !next_due_date) {
      return res.status(400).json({ error: 'name, amount, and next_due_date are required.' });
    }

    const freq = frequency || 'monthly';
    const monthly_equiv = calcMonthlyEquiv(parseFloat(amount), freq);

    const result = await query(`
      INSERT INTO committed_outgoings
        (user_id, name, category, amount, frequency, monthly_equiv,
         next_due_date, is_tier1)
      VALUES ($1,$2,$3,$4,$5,$6,$7,true)
      RETURNING *
    `, [
      req.user.userId, name, category || 'other',
      parseFloat(amount), freq, monthly_equiv, next_due_date,
    ]);

    // Recalculate runway with new outgoing
    const runway = await calculateRunway(req.user.userId);
    return res.status(201).json({
      message: 'Outgoing added.',
      outgoing: result.rows[0],
      runway_impact: runway,
    });

  } catch (err) {
    console.error('Add outgoing error:', err);
    return res.status(500).json({ error: 'Failed to add outgoing.' });
  }
});

// ── PUT /runway/outgoings/:id ─────────────────────────────────────────────────

router.put('/outgoings/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { name, amount, frequency, next_due_date, is_active } = req.body;

    const check = await query(
      `SELECT id FROM committed_outgoings WHERE id = $1 AND user_id = $2`,
      [id, req.user.userId]
    );
    if (check.rows.length === 0) {
      return res.status(404).json({ error: 'Outgoing not found.' });
    }

    const updates = [];
    const values  = [];
    let i = 1;

    if (name)          { updates.push(`name = $${i++}`);          values.push(name); }
    if (amount)        { 
      const freq = frequency || 'monthly';
      const monthly = calcMonthlyEquiv(parseFloat(amount), freq);
      updates.push(`amount = $${i++}`);           values.push(parseFloat(amount));
      updates.push(`monthly_equiv = $${i++}`);    values.push(monthly);
      if (frequency) { updates.push(`frequency = $${i++}`); values.push(freq); }
    }
    if (next_due_date) { updates.push(`next_due_date = $${i++}`); values.push(next_due_date); }
    if (is_active !== undefined) { updates.push(`is_active = $${i++}`); values.push(is_active); }
    updates.push(`updated_at = NOW()`);
    values.push(id);

    await query(
      `UPDATE committed_outgoings SET ${updates.join(', ')} WHERE id = $${i}`,
      values
    );

    const runway = await calculateRunway(req.user.userId);
    return res.json({ message: 'Outgoing updated.', runway_impact: runway });

  } catch (err) {
    console.error('Update outgoing error:', err);
    return res.status(500).json({ error: 'Failed to update outgoing.' });
  }
});

// ── DELETE /runway/outgoings/:id ──────────────────────────────────────────────
// Soft delete — sets is_active = false

router.delete('/outgoings/:id', async (req, res) => {
  try {
    const { id } = req.params;

    const check = await query(
      `SELECT id FROM committed_outgoings WHERE id = $1 AND user_id = $2`,
      [id, req.user.userId]
    );
    if (check.rows.length === 0) {
      return res.status(404).json({ error: 'Outgoing not found.' });
    }

    await query(
      `UPDATE committed_outgoings SET is_active = false, updated_at = NOW() WHERE id = $1`,
      [id]
    );

    const runway = await calculateRunway(req.user.userId);
    return res.json({ message: 'Outgoing removed.', runway_impact: runway });

  } catch (err) {
    console.error('Delete outgoing error:', err);
    return res.status(500).json({ error: 'Failed to remove outgoing.' });
  }
});

// ── GET /runway/tpve ──────────────────────────────────────────────────────────
// Tax Pot Verification Engine status

router.get('/tpve', async (req, res) => {
  try {
    const taxYear = getCurrentTaxYear();
    const result  = await query(
      `SELECT status, current_pot_balance, target_pot_balance,
              shortfall, coverage_pct, verified_at
       FROM tax_verification
       WHERE user_id = $1 AND tax_year = $2`,
      [req.user.userId, taxYear]
    );

    if (result.rows.length === 0) {
      // Never run — trigger now
      const runway = await calculateRunway(req.user.userId);
      return res.json({
        status:              runway.tpve_status,
        current_pot_balance: runway.tax_pot_balance,
        target_pot_balance:  runway.tax_pot_target,
        shortfall:           runway.tax_pot_shortfall,
        coverage_pct:        runway.tax_pot_coverage_pct,
      });
    }

    return res.json(result.rows[0]);
  } catch (err) {
    console.error('TPVE error:', err);
    return res.status(500).json({ error: 'Failed to get TPVE status.' });
  }
});

// ── Helpers ───────────────────────────────────────────────────────────────────

function calcMonthlyEquiv(amount, frequency) {
  switch (frequency) {
  case 'monthly':   return Math.round(amount * 100) / 100;
  case 'quarterly': return Math.round((amount / 3) * 100) / 100;
  case 'annual':    return Math.round((amount / 12) * 100) / 100;
  case 'weekly':    return Math.round((amount * 52 / 12) * 100) / 100;
  default:          return Math.round(amount * 100) / 100;
  }
}

function getCurrentTaxYear() {
  const now   = new Date();
  const month = now.getMonth() + 1;
  const day   = now.getDate();
  const year  = now.getFullYear();
  const isNew = (month > 4) || (month === 4 && day >= 6);
  const start = isNew ? year : year - 1;
  return `${start}/${String(start + 1).slice(-2)}`;
}

module.exports = router;
