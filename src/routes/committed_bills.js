'use strict';

const express      = require('express');
const router       = express.Router();
const { query }    = require('../db');
const requireAuth  = require('../middleware/requireAuth');

// ── GET /committed-bills ────────────────────────────────────────────────────
// Returns all active committed bills for the user
router.get('/', requireAuth, async (req, res) => {
  try {
    const userId = req.user.id;
    const result = await query(
      `SELECT id, name, amount, day_of_month, source, transaction_id, created_at
       FROM committed_bills
       WHERE user_id = $1 AND is_active = true
       ORDER BY created_at ASC`,
      [userId]
    );

    const bills       = result.rows;
    const totalMonthly = bills.reduce((s, b) => s + parseFloat(b.amount), 0);
    const weeklyAmount = Math.round((totalMonthly / 4.33) * 100) / 100;

    res.json({
      bills,
      totalMonthly: Math.round(totalMonthly * 100) / 100,
      weeklyAmount,
    });
  } catch (err) {
    console.error('Get committed bills error:', err);
    res.status(500).json({ error: 'Failed to fetch committed bills' });
  }
});

// ── POST /committed-bills ────────────────────────────────────────────────────
// Add a new committed bill (manual or from transaction)
router.post('/', requireAuth, async (req, res) => {
  try {
    const userId = req.user.id;
    const { name, amount, day_of_month, source = 'manual', transaction_id } = req.body;

    if (!name || !amount) {
      return res.status(400).json({ error: 'name and amount are required' });
    }
    if (parseFloat(amount) <= 0) {
      return res.status(400).json({ error: 'amount must be greater than 0' });
    }

    const result = await query(
      `INSERT INTO committed_bills
         (user_id, name, amount, day_of_month, source, transaction_id)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id, name, amount, day_of_month, source, created_at`,
      [userId, name.trim(), parseFloat(amount), day_of_month || null,
       source, transaction_id || null]
    );

    res.status(201).json({ bill: result.rows[0] });
  } catch (err) {
    console.error('Add committed bill error:', err);
    res.status(500).json({ error: 'Failed to add committed bill' });
  }
});

// ── DELETE /committed-bills/:id ─────────────────────────────────────────────
// Soft-delete (deactivate) a committed bill
router.delete('/:id', requireAuth, async (req, res) => {
  try {
    const userId = req.user.id;
    const { id }  = req.params;

    const result = await query(
      `UPDATE committed_bills
       SET is_active = false, updated_at = NOW()
       WHERE id = $1 AND user_id = $2
       RETURNING id`,
      [id, userId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Bill not found' });
    }

    res.json({ success: true, id: parseInt(id) });
  } catch (err) {
    console.error('Delete committed bill error:', err);
    res.status(500).json({ error: 'Failed to remove committed bill' });
  }
});

// ── PUT /committed-bills/:id/restore ────────────────────────────────────────
// Restore a previously removed bill
router.put('/:id/restore', requireAuth, async (req, res) => {
  try {
    const userId = req.user.id;
    const { id }  = req.params;

    const result = await query(
      `UPDATE committed_bills
       SET is_active = true, updated_at = NOW()
       WHERE id = $1 AND user_id = $2
       RETURNING id, name, amount, day_of_month, source`,
      [id, userId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Bill not found' });
    }

    res.json({ bill: result.rows[0] });
  } catch (err) {
    console.error('Restore committed bill error:', err);
    res.status(500).json({ error: 'Failed to restore committed bill' });
  }
});

module.exports = router;
