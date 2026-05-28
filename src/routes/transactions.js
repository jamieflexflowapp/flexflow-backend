'use strict';
const express = require('express');
const router  = express.Router();
const { query } = require('../config/database');
const { verifyToken } = require('../middleware/auth');

router.use(verifyToken);

router.get('/auto-confirmed', async (req, res) => {
  try {
    const userId = req.user.userId;
    const now = new Date();
    const fyYear = (now.getMonth() > 3 || (now.getMonth() === 3 && now.getDate() >= 6))
      ? now.getFullYear() : now.getFullYear() - 1;
    const fyStartStr = `${fyYear}-04-06`;

    const page = parseInt(req.query.page || '1');
    const limit = 50;
    const offset = (page - 1) * limit;

    const { rows } = await query(`
      SELECT id, description, merchant_name, amount, transaction_date,
             category, sub_category, transaction_type
      FROM transactions
      WHERE user_id = $1
        AND transaction_type = 'DEBIT'
        AND transaction_date >= $2
        AND category != 'transfer'
        AND user_confirmed IS NULL
      ORDER BY transaction_date DESC
      LIMIT $3 OFFSET $4
    `, [userId, fyStartStr, limit, offset]);

    const totalResult = await query(`
      SELECT COUNT(*) as total FROM transactions
      WHERE user_id = $1 AND transaction_type = 'DEBIT'
        AND transaction_date >= $2 AND category != 'transfer'
    `, [userId, fyStartStr]);

    const reviewedResult = await query(`
      SELECT COUNT(*) as reviewed FROM transactions
      WHERE user_id = $1 AND transaction_type = 'DEBIT'
        AND transaction_date >= $2 AND category != 'transfer'
        AND user_confirmed IS NOT NULL
    `, [userId, fyStartStr]);

    const transactions = rows.map(r => ({
      id:          r.id,
      description: r.description || r.merchant_name || 'Unknown',
      amount:      Math.abs(parseFloat(r.amount)),
      date:        r.transaction_date,
      category:    r.category || 'expense',
      subCategory: r.sub_category,
      type:        'expense',
      status:      'auto',
      confirmed:   null,
      suggestion:  null,
    }));

    const total = parseInt(totalResult.rows[0].total);
    const reviewed = parseInt(reviewedResult.rows[0].reviewed);

    res.json({ transactions, count: transactions.length, total, reviewed, pending: total - reviewed });
  } catch (err) {
    console.error('[TRANSACTIONS]', err.message);
    res.status(500).json({ error: 'Failed to load transactions' });
  }
});

router.get('/pending-review', async (req, res) => {
  try {
    const userId = req.user.userId;
    const now = new Date();
    const fyYear = (now.getMonth() > 3 || (now.getMonth() === 3 && now.getDate() >= 6))
      ? now.getFullYear() : now.getFullYear() - 1;
    const fyStartStr = `${fyYear}-04-06`;

    const { rows } = await query(`
      SELECT id, description, merchant_name, amount, transaction_date,
             category, sub_category, transaction_type, is_income
      FROM transactions
      WHERE user_id = $1
        AND transaction_type = 'CREDIT'
        AND transaction_date >= $2
        AND category != 'transfer'
        AND user_confirmed IS NULL
      ORDER BY transaction_date DESC
      LIMIT 100
    `, [userId, fyStartStr]);

    const transactions = rows.map(r => ({
      id:          r.id,
      description: r.description || r.merchant_name || 'Unknown',
      amount:      Math.abs(parseFloat(r.amount)),
      date:        r.transaction_date,
      category:    r.category || 'income',
      subCategory: r.sub_category,
      type:        'income',
      isIncome:    r.is_income,
      status:      r.is_income ? 'confirmed' : 'pending',
      confirmed:   r.is_income ? true : null,
      suggestion:  r.sub_category || null,
    }));

    res.json({ transactions, count: transactions.length });
  } catch (err) {
    console.error('[TRANSACTIONS]', err.message);
    res.status(500).json({ error: 'Failed to load transactions' });
  }
});

// GET /transactions/dismissed — transactions the user rejected (user_confirmed = false)
router.get('/dismissed', async (req, res) => {
  try {
    const userId = req.user.userId;
    const now = new Date();
    const fyYear = (now.getMonth() > 3 || (now.getMonth() === 3 && now.getDate() >= 6))
      ? now.getFullYear() : now.getFullYear() - 1;
    const fyStartStr = `${fyYear}-04-06`;

    const { rows } = await query(`
      SELECT id, description, merchant_name, amount, transaction_date,
             category, sub_category
      FROM transactions
      WHERE user_id = $1
        AND transaction_type = 'DEBIT'
        AND transaction_date >= $2
        AND category != 'transfer'
        AND user_confirmed = false
      ORDER BY dismissed_at DESC NULLS LAST, transaction_date DESC
      LIMIT 50
    `, [userId, fyStartStr]);

    const transactions = rows.map(r => ({
      id:          r.id,
      description: r.description || r.merchant_name || 'Unknown',
      amount:      Math.abs(parseFloat(r.amount)),
      date:        r.transaction_date,
      category:    r.category || 'expense',
      subCategory: r.sub_category,
      confirmed:   false,
    }));

    const countResult = await query(`
      SELECT COUNT(*) AS total FROM transactions
      WHERE user_id = $1 AND transaction_type = 'DEBIT'
        AND transaction_date >= $2 AND category != 'transfer'
        AND user_confirmed = false
    `, [userId, fyStartStr]);

    res.json({ transactions, total: parseInt(countResult.rows[0].total) });
  } catch (err) {
    console.error('[DISMISSED]', err.message);
    res.status(500).json({ error: 'Failed to load dismissed transactions' });
  }
});

// PATCH /transactions/:id/confirm — save user's expense decision
router.patch('/:id/confirm', async (req, res) => {
  try {
    const userId = req.user.userId;
    const { id } = req.params;
    const { confirmed, businessPct = 100 } = req.body;

    // Save decision on transaction
    await query(
      `UPDATE transactions
         SET user_confirmed = $1,
             dismissed_at = CASE WHEN $1 = false THEN NOW() ELSE NULL END
       WHERE id = $2 AND user_id = $3`,
      [confirmed, id, userId]
    );

    if (confirmed === true) {
      // Fetch transaction details
      const txn = (await query(
        `SELECT description, merchant_name, amount, transaction_date, category FROM transactions WHERE id = $1`,
        [id]
      )).rows[0];

      if (txn) {
        const now = new Date();
        const fyYear = (now.getMonth() > 3 || (now.getMonth() === 3 && now.getDate() >= 6))
          ? now.getFullYear() : now.getFullYear() - 1;
        const taxYear = `${fyYear}/${String(fyYear + 1).slice(-2)}`;
        const amount = Math.abs(parseFloat(txn.amount));
        const deductAmount = Math.round(amount * (businessPct / 100) * 100) / 100;

        // Upsert into expense_records
        await query(`
          INSERT INTO expense_records
            (user_id, transaction_id, tax_year, hmrc_category, business_pct, deduct_amount, confirmed, auto_detected)
          VALUES ($1, $2, $3, $4, $5, $6, true, false)
          ON CONFLICT (user_id, transaction_id) DO UPDATE SET
            confirmed = true, business_pct = $5, deduct_amount = $6
        `, [
          userId,
          id,
          taxYear,
          txn.category || 'expense',
          businessPct,
          deductAmount
        ]);
      }
    } else {
      // Remove from expense_records if rejected
      await query(
        `DELETE FROM expense_records WHERE transaction_id = $1 AND user_id = $2`,
        [id, userId]
      );
    }

    res.json({ success: true, id, confirmed });
  } catch (err) {
    console.error('[TRANSACTIONS CONFIRM]', err.message);
    res.status(500).json({ error: 'Failed to save decision' });
  }
});

module.exports = router;
