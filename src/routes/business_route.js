'use strict';
const express = require('express');
const router  = express.Router();
const { query } = require('../config/database');
const { verifyToken } = require('../middleware/auth');

router.use(verifyToken);

router.get('/summary', async (req, res) => {
  try {
    const userId = req.user.userId;
    const u = (await query(
      `SELECT director_salary_annual, dividend_frequency, is_scottish_taxpayer FROM users WHERE id = $1`,
      [userId]
    )).rows[0];
    if (!u) return res.status(404).json({ error: 'User not found' });

    // Tax year start (6 Apr)
    const now = new Date();
    const fyYear = (now.getMonth() > 3 || (now.getMonth() === 3 && now.getDate() >= 6))
      ? now.getFullYear() : now.getFullYear() - 1;
    const fyStart = new Date(fyYear, 3, 6);
    const fyStartStr = fyStart.toISOString().split('T')[0];

    // Months elapsed in tax year
    const msPerMonth = 1000 * 60 * 60 * 24 * 30.44;
    const monthsElapsed = Math.min(12, Math.max(1, Math.floor((now - fyStart) / msPerMonth) + 1));
    const monthsRemaining = 12 - monthsElapsed;

    // Turnover and expenses from real transactions
    const fytdTurnover = parseFloat((await query(
      `SELECT COALESCE(SUM(amount),0) AS t FROM transactions
       WHERE user_id=$1 AND transaction_type='CREDIT' AND is_income=true AND transaction_date>=$2`,
      [userId, fyStartStr]
    )).rows[0].t);

    const fytdExpenses = parseFloat((await query(
      `SELECT COALESCE(SUM(ABS(amount)),0) AS t FROM transactions
       WHERE user_id=$1 AND transaction_type='DEBIT' AND transaction_date>=$2`,
      [userId, fyStartStr]
    )).rows[0].t);

    // Director salary — full annual figure deducted (committed expense)
    const dirSalaryAnnual = parseFloat(u.director_salary_annual || 12570);
    const dirSalaryMonthly = Math.round(dirSalaryAnnual / 12 * 100) / 100;
    const salaryPaidYTD = Math.round(dirSalaryMonthly * monthsElapsed * 100) / 100;
    const salaryRemaining = Math.round(dirSalaryMonthly * monthsRemaining * 100) / 100;

    // Taxable profit = Turnover − Expenses − Full Annual Salary
    const ctTaxableProfit = Math.max(0, Math.round((fytdTurnover - fytdExpenses - dirSalaryAnnual) * 100) / 100);

    // Corporation Tax (2026/27 rates)
    let corpTaxReserve = 0;
    if (ctTaxableProfit <= 50000)
      corpTaxReserve = Math.round(ctTaxableProfit * 0.19 * 100) / 100;
    else if (ctTaxableProfit <= 250000)
      corpTaxReserve = Math.round((ctTaxableProfit * 0.25 - (3/200) * (250000 - ctTaxableProfit)) * 100) / 100;
    else
      corpTaxReserve = Math.round(ctTaxableProfit * 0.25 * 100) / 100;

    // Available for dividends (post CT)
    const availableForDividends = Math.max(0, Math.round((ctTaxableProfit - corpTaxReserve) * 100) / 100);

    // Dividend tax (2026/27: 10.75% basic, £500 allowance)
    // Personal allowance unused by salary offsets dividend income first
    const personalAllowance = 12570;
    const unusedPersonalAllowance = Math.max(0, personalAllowance - dirSalaryAnnual);
    const divAllowance = 500;
    const taxableDivs = Math.max(0, availableForDividends - unusedPersonalAllowance - divAllowance);
    const basicTop = 50270;
    const divStartPoint = Math.max(personalAllowance, dirSalaryAnnual) + divAllowance;
    const basicRoom = Math.max(0, basicTop - Math.max(divStartPoint, 0));
    const inBasic = Math.min(taxableDivs, basicRoom);
    const afterBasic = taxableDivs - inBasic;
    const higherRoom = Math.max(0, 125140 - Math.max(divStartPoint + inBasic, basicTop));
    const inHigher = Math.min(afterBasic, higherRoom);
    const inAdditional = afterBasic - inHigher;
    const divTax = Math.round((inBasic * 0.1075 + inHigher * 0.3575 + inAdditional * 0.3935) * 100) / 100;

    // Post-tax earnings
    const earningsPostTax = Math.round((availableForDividends - divTax) * 100) / 100;
    const totalTaxOwed = Math.round((corpTaxReserve + divTax) * 100) / 100;

    const dividendsPaidYtd = 0;

    res.json({
      fytdTurnover,
      fytdExpenses,
      directorSalaryAnnual: dirSalaryAnnual,
      directorSalaryMonthly: dirSalaryMonthly,
      salaryPaidYtd: salaryPaidYTD,
      salaryRemaining,
      monthsElapsed,
      monthsRemaining,
      ctTaxableProfit,
      corpTaxReserve,
      availableForDividends,
      divTax,
      earningsPostTax,
      totalTaxOwed,
      availableToTake: earningsPostTax,
      dividendsPaidYtd,
      dividendAllowance: divAllowance,
      dividendFrequency: u.dividend_frequency || 'quarterly',
      isScottishTaxpayer: !!u.is_scottish_taxpayer,
      taxYear: `${fyYear}/${String(fyYear + 1).slice(-2)}`,
    });
  } catch (err) {
    console.error('[BUSINESS]', err.message);
    res.status(500).json({ error: 'Failed to load business summary' });
  }
});

module.exports = router;
