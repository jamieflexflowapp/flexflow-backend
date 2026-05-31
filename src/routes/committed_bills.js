'use strict';

const express      = require('express');
const router       = express.Router();
const { query }    = require('../config/database');
const { verifyToken, checkOnboardingComplete } = require('../middleware/auth');

// ── GET /committed-bills ────────────────────────────────────────────────────
// Returns all active committed bills for the user
router.get('/', verifyToken, checkOnboardingComplete, async (req, res) => {
  try {
    const userId = req.user.userId;
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

// ── GET /committed-bills/spending-transactions ──────────────────────────────
// Returns recent debit transactions from spending-designated accounts,
// excluding any already saved as committed bills.
router.get('/spending-transactions', verifyToken, checkOnboardingComplete, async (req, res) => {
  try {
    const userId = req.user.userId;
    const result = await query(
      `SELECT DISTINCT ON (COALESCE(NULLIF(TRIM(t.merchant_name),''), NULLIF(TRIM(t.description),'')))
         t.id, t.truelayer_id AS transaction_id,
         COALESCE(NULLIF(TRIM(t.merchant_name),''), NULLIF(TRIM(t.description),'')) AS name,
         ABS(t.amount) AS amount,
         t.transaction_date,
         EXTRACT(DAY FROM t.transaction_date)::int AS day_of_month
       FROM transactions t
       JOIN bank_connections bc ON bc.id = t.bank_connection_id
       JOIN account_designations ad
         ON ad.bank_account_id = bc.account_id AND ad.user_id = $1
       WHERE t.user_id = $1
         AND ad.designation_type = 'bills'
         AND t.is_income = false
         AND t.transaction_type = 'DEBIT'
         AND t.transaction_date >= NOW() - INTERVAL '90 days'
         AND COALESCE(NULLIF(TRIM(t.merchant_name),''), NULLIF(TRIM(t.description),'')) IS NOT NULL
         AND NOT EXISTS (
           SELECT 1 FROM committed_bills cb
           WHERE cb.user_id = $1
             AND cb.is_active = true
             AND (cb.transaction_id = t.truelayer_id
               OR LOWER(cb.name) = LOWER(COALESCE(NULLIF(TRIM(t.merchant_name),''), NULLIF(TRIM(t.description),''))))
         )
         AND NOT EXISTS (
           SELECT 1 FROM committed_bill_dismissals cbd
           WHERE cbd.user_id = $1 AND cbd.transaction_id = t.truelayer_id
         )
       ORDER BY COALESCE(NULLIF(TRIM(t.merchant_name),''), NULLIF(TRIM(t.description),'')), t.transaction_date DESC
       LIMIT 50`,
      [userId]
    );
    res.json({ transactions: result.rows });
  } catch (err) {
    console.error('Spending transactions error:', err.message);
    res.status(500).json({ error: 'Failed to fetch spending transactions.' });
  }
});

// ── POST /committed-bills ────────────────────────────────────────────────────
// Add a new committed bill (manual or from transaction)
router.post('/', verifyToken, checkOnboardingComplete, async (req, res) => {
  try {
    const userId = req.user.userId;
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
router.delete('/:id', verifyToken, checkOnboardingComplete, async (req, res) => {
  try {
    const userId = req.user.userId;
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
router.put('/:id/restore', verifyToken, checkOnboardingComplete, async (req, res) => {
  try {
    const userId = req.user.userId;
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


// ── POST /committed-bills/dismiss ───────────────────────────────────────────
// Dismiss a pending transaction — user says it is NOT a committed bill
router.post('/dismiss', verifyToken, checkOnboardingComplete, async (req, res) => {
  try {
    const userId = req.user.userId;
    const { transaction_id } = req.body;
    if (!transaction_id) return res.status(400).json({ error: 'transaction_id required' });
    await query(
      `INSERT INTO committed_bill_dismissals (user_id, transaction_id)
       VALUES ($1, $2) ON CONFLICT (user_id, transaction_id) DO NOTHING`,
      [userId, transaction_id]
    );
    res.json({ success: true });
  } catch (err) {
    console.error('Dismiss bill transaction error:', err);
    res.status(500).json({ error: 'Failed to dismiss transaction' });
  }
});

// ── DELETE /committed-bills/dismiss/:transaction_id ──────────────────────────
// Undo a dismissal — move transaction back to pending
router.delete('/dismiss/:transaction_id', verifyToken, checkOnboardingComplete, async (req, res) => {
  try {
    const userId = req.user.userId;
    const { transaction_id } = req.params;
    await query(
      `DELETE FROM committed_bill_dismissals WHERE user_id = $1 AND transaction_id = $2`,
      [userId, transaction_id]
    );
    res.json({ success: true });
  } catch (err) {
    console.error('Undo dismiss bill error:', err);
    res.status(500).json({ error: 'Failed to undo dismissal' });
  }
});

// ── GET /committed-bills/dismissed ──────────────────────────────────────────
// Returns dismissed transactions
router.get('/dismissed', verifyToken, checkOnboardingComplete, async (req, res) => {
  try {
    const userId = req.user.userId;
    const result = await query(
      `SELECT t.id, t.truelayer_id AS transaction_id,
              COALESCE(NULLIF(TRIM(t.merchant_name),''), NULLIF(TRIM(t.description),'')) AS name,
              ABS(t.amount) AS amount,
              t.transaction_date
       FROM committed_bill_dismissals cbd
       JOIN transactions t ON t.truelayer_id = cbd.transaction_id AND t.user_id = $1
       WHERE cbd.user_id = $1
       ORDER BY cbd.created_at DESC`,
      [userId]
    );
    res.json({ transactions: result.rows });
  } catch (err) {
    console.error('Get dismissed bills error:', err);
    res.status(500).json({ error: 'Failed to fetch dismissed transactions' });
  }
});

module.exports = router;
