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

    const { rows } = await query(`
      SELECT id, description, merchant_name, amount, transaction_date,
             category, sub_category, transaction_type
      FROM transactions
      WHERE user_id = $1
        AND transaction_type = 'DEBIT'
        AND transaction_date >= $2
        AND category != 'transfer'
      ORDER BY transaction_date DESC
      LIMIT 100
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

    res.json({ transactions, count: transactions.length });
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

module.exports = router;
