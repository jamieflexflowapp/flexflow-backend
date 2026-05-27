'use strict';
const express = require('express');
const router  = express.Router();
const { query } = require('../config/database');
const { verifyToken } = require('../middleware/auth');

router.use(verifyToken);

router.get('/summary', async (req, res) => {
  try {
    const userId = req.user.userId;
    const u = (await query(`SELECT director_salary_annual, dividend_frequency, is_scottish_taxpayer FROM users WHERE id = $1`, [userId])).rows[0];
    if (!u) return res.status(404).json({ error: 'User not found' });
    const now = new Date();
    const fyStart = new Date(now.getMonth() >= 3 ? now.getFullYear() : now.getFullYear() - 1, 3, 6);
    const fytd_turnover  = parseFloat((await query(`SELECT COALESCE(SUM(amount),0) AS t FROM transactions WHERE user_id=$1 AND transaction_type='CREDIT' AND is_income=true AND transaction_date>=$2`, [userId, fyStart.toISOString().split('T')[0]])).rows[0].t);
    const fytd_expenses  = parseFloat((await query(`SELECT COALESCE(SUM(amount),0) AS t FROM transactions WHERE user_id=$1 AND transaction_type='DEBIT' AND transaction_date>=$2`, [userId, fyStart.toISOString().split('T')[0]])).rows[0].t);
    const dir_salary = parseFloat(u.director_salary_annual || 12570);
    const ct_base = Math.max(0, fytd_turnover - fytd_expenses - dir_salary);
    let corp_tax_reserve = 0;
    if (ct_base <= 50000) corp_tax_reserve = Math.round(ct_base*0.19*100)/100;
    else if (ct_base <= 250000) corp_tax_reserve = Math.round((ct_base*0.25-(3/200)*(250000-ct_base))*100)/100;
    else corp_tax_reserve = Math.round(ct_base*0.25*100)/100;
    const salary_paid_ytd = parseFloat((await query(`SELECT COALESCE(SUM(amount),0) AS t FROM transactions WHERE user_id=$1 AND category='director_salary' AND transaction_date>=$2`, [userId, fyStart.toISOString().split('T')[0]])).rows[0].t);
    const dividends_paid_ytd = 0; // dividend_payments table not yet created
    res.json({ fytd_turnover, fytd_expenses, ct_taxable_profit: Math.round(ct_base*100)/100, corp_tax_reserve, available_to_take: Math.max(0, Math.round((ct_base-corp_tax_reserve)*100)/100), director_salary_annual: dir_salary, salary_paid_ytd, dividends_paid_ytd, dividend_allowance: 500, dividend_frequency: u.dividend_frequency || 'quarterly', is_scottish_taxpayer: !!u.is_scottish_taxpayer, tax_year: `${fyStart.getFullYear()}/${String(fyStart.getFullYear()+1).slice(-2)}` });
  } catch (err) {
    console.error('[BUSINESS]', err.message);
    res.status(500).json({ error: 'Failed to load business summary' });
  }
});

module.exports = router;
