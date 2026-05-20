'use strict';

/**
 * FlexFlow — Budget Routes
 * Phase 4 — Group D Adaptive Budgeting
 *
 * GET  /budget/categories              — get user's budget categories + % allocations
 * POST /budget/categories              — save budget categories + % allocations
 * GET  /budget/transactions            — get this month's non-essential transactions
 * POST /budget/transactions/:id/categorise — assign a transaction to a budget category
 * GET  /budget/summary                 — current month spend vs limits per category
 */

const express = require('express');
const router  = express.Router();
const { verifyToken, checkOnboardingComplete } = require('../middleware/auth');
const { query } = require('../config/database');

router.use(verifyToken, checkOnboardingComplete);

// ── GET /budget/categories ────────────────────────────────────────────────────
// Returns user's budget categories with % allocations

router.get('/categories', async (req, res) => {
  try {
    const result = await query(
      `SELECT * FROM budget_categories
       WHERE user_id = $1
       ORDER BY display_order ASC`,
      [req.user.userId]
    );

    if (result.rows.length === 0) {
      // Return defaults if none configured
      return res.json({
        categories: [
          { name: 'Eating out',    icon: '🍽️', pct: 8  },
          { name: 'Entertainment', icon: '🎬', pct: 5  },
          { name: 'Shopping',      icon: '🛍️', pct: 10 },
          { name: 'Hobbies',       icon: '🎯', pct: 5  },
          { name: 'Takeaways',     icon: '🥡', pct: 5  },
        ],
        configured: false,
      });
    }

    return res.json({ categories: result.rows, configured: true });
  } catch (err) {
    console.error('Budget categories get error:', err);
    return res.status(500).json({ error: 'Failed to get budget categories.' });
  }
});

// ── POST /budget/categories ───────────────────────────────────────────────────
// Save budget categories + % allocations

router.post('/categories', async (req, res) => {
  try {
    const { categories } = req.body;

    if (!categories || !Array.isArray(categories)) {
      return res.status(400).json({ error: 'categories array required.' });
    }

    const totalPct = categories.reduce((s, c) => s + (c.pct || 0), 0);
    if (totalPct > 100) {
      return res.status(400).json({ error: 'Total percentage cannot exceed 100%.' });
    }

    // Delete existing and reinsert
    await query(
      `DELETE FROM budget_categories WHERE user_id = $1`,
      [req.user.userId]
    );

    for (let i = 0; i < categories.length; i++) {
      const cat = categories[i];
      await query(
        `INSERT INTO budget_categories
           (user_id, name, icon, pct, display_order)
         VALUES ($1, $2, $3, $4, $5)`,
        [req.user.userId, cat.name, cat.icon || '📦', cat.pct, i]
      );
    }

    return res.json({ message: 'Budget categories saved.', total_pct: totalPct });
  } catch (err) {
    console.error('Budget categories save error:', err);
    return res.status(500).json({ error: 'Failed to save budget categories.' });
  }
});

// ── GET /budget/transactions ──────────────────────────────────────────────────
// This month's non-essential transactions — categorised and uncategorised

router.get('/transactions', async (req, res) => {
  try {
    const now = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1)
      .toISOString().split('T')[0];

    const result = await query(
      `SELECT t.id, t.merchant_name, t.description, t.amount,
              t.transaction_date, bt.category_name
       FROM transactions t
       LEFT JOIN budget_transaction_categories bt
         ON bt.transaction_id = t.id AND bt.user_id = t.user_id
       WHERE t.user_id = $1
         AND t.transaction_date >= $2
         AND t.amount < 0
         AND t.is_income = false
         AND NOT EXISTS (
           SELECT 1 FROM expense_records er
           WHERE er.transaction_id = t.id AND er.user_id = t.user_id
             AND er.confirmed = true
         )
       ORDER BY t.transaction_date DESC`,
      [req.user.userId, monthStart]
    );

    const categorised   = result.rows.filter(t => t.category_name);
    const uncategorised = result.rows.filter(t => !t.category_name);

    return res.json({
      categorised,
      uncategorised,
      categorised_count:   categorised.length,
      uncategorised_count: uncategorised.length,
    });
  } catch (err) {
    console.error('Budget transactions error:', err);
    return res.status(500).json({ error: 'Failed to get budget transactions.' });
  }
});

// ── POST /budget/transactions/:id/categorise ──────────────────────────────────
// Assign a transaction to a budget category

router.post('/transactions/:id/categorise', async (req, res) => {
  try {
    const { category_name } = req.body;
    const { id } = req.params;

    if (!category_name) {
      return res.status(400).json({ error: 'category_name required.' });
    }

    // Verify transaction belongs to user
    const txn = await query(
      `SELECT id FROM transactions WHERE id = $1 AND user_id = $2`,
      [id, req.user.userId]
    );
    if (txn.rows.length === 0) {
      return res.status(404).json({ error: 'Transaction not found.' });
    }

    await query(
      `INSERT INTO budget_transaction_categories
         (user_id, transaction_id, category_name)
       VALUES ($1, $2, $3)
       ON CONFLICT (user_id, transaction_id) DO UPDATE SET
         category_name = EXCLUDED.category_name,
         updated_at    = NOW()`,
      [req.user.userId, id, category_name]
    );

    return res.json({ message: 'Transaction categorised.', category: category_name });
  } catch (err) {
    console.error('Categorise transaction error:', err);
    return res.status(500).json({ error: 'Failed to categorise transaction.' });
  }
});

// ── GET /budget/summary ───────────────────────────────────────────────────────
// Current month spend vs limits per category

router.get('/summary', async (req, res) => {
  try {
    const now = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1)
      .toISOString().split('T')[0];

    // Get categories
    const cats = await query(
      `SELECT name, pct FROM budget_categories WHERE user_id = $1`,
      [req.user.userId]
    );

    // Get spend per category this month
    const spend = await query(
      `SELECT btc.category_name, SUM(ABS(t.amount)) AS total_spent
       FROM budget_transaction_categories btc
       JOIN transactions t ON t.id = btc.transaction_id
       WHERE btc.user_id = $1
         AND t.transaction_date >= $2
       GROUP BY btc.category_name`,
      [req.user.userId, monthStart]
    );

    const spendMap = {};
    spend.rows.forEach(s => { spendMap[s.category_name] = parseFloat(s.total_spent); });

    return res.json({
      categories: cats.rows.map(c => ({
        name:        c.name,
        pct:         c.pct,
        spent:       spendMap[c.name] || 0,
      })),
      month: monthStart,
    });
  } catch (err) {
    console.error('Budget summary error:', err);
    return res.status(500).json({ error: 'Failed to get budget summary.' });
  }
});

// ── GET /forecast/month/:month ────────────────────────────────────────────────
// Note: this is in forecast.js — just documenting here for reference

module.exports = router;
