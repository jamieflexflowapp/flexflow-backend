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

    // Single source of truth: total_deductions kept fresh by ede.recalcTaxableProfit
    // (confirmed expenses + home office + mileage). Avoids divergent CT calcs.
    const fytdExpenses = parseFloat((await query(
      `SELECT COALESCE(total_deductions,0) AS t FROM users WHERE id=$1`,
      [userId]
    )).rows[0].t);

    // Director salary — full annual figure deducted (committed expense)
    const dirSalaryAnnual = u.director_salary_annual != null ? parseFloat(u.director_salary_annual) : 12570;
    const dirSalaryMonthly = Math.round(dirSalaryAnnual / 12 * 100) / 100;
    const salaryPaidYTD = Math.round(dirSalaryMonthly * monthsElapsed * 100) / 100;
    const salaryRemaining = Math.round(dirSalaryMonthly * monthsRemaining * 100) / 100;

    // Employer NI — 15% above £5,000 secondary threshold (2025/26), sole director = no Employment Allowance
    const EMPLOYER_NI_RATE = 0.15;
    const EMPLOYER_NI_THRESHOLD = 5000;
    const employerNI = Math.round(Math.max(0, dirSalaryAnnual - EMPLOYER_NI_THRESHOLD) * EMPLOYER_NI_RATE * 100) / 100;

    // Taxable profit = Turnover − Expenses − Full Annual Salary − Employer NI
    const ctTaxableProfit = Math.max(0, Math.round((fytdTurnover - fytdExpenses - dirSalaryAnnual - employerNI) * 100) / 100);

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
    const totalTaxOwed = Math.round((corpTaxReserve + divTax + employerNI) * 100) / 100;

    const dividendsPaidYtd = 0;

    res.json({
      fytdTurnover,
      fytdExpenses,
      directorSalaryAnnual: dirSalaryAnnual,
      employerNI,
      employerNIRate: EMPLOYER_NI_RATE,
      employerNIThreshold: EMPLOYER_NI_THRESHOLD,
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

// GET /business/salary-breakdown?salary=25000
router.get('/salary-breakdown', async (req, res) => {
  try {
    const userId = req.user.userId;
    const salary = parseFloat(req.query.salary) || 0;

    // Get user profile
    const u = (await query(`SELECT is_scottish_taxpayer, tax_code, director_salary_annual FROM users WHERE id = $1`, [userId])).rows[0];
    const isScottish = u?.is_scottish_taxpayer || false;
    const taxCode = (u?.tax_code || '1257L').toUpperCase().trim();
    const taxYear = '2026/27';

    // Load rates from DB
    const ratesRows = (await query(
      `SELECT parameter_key, parameter_value FROM tax_rates WHERE tax_year = $1 AND jurisdiction = 'UK'`,
      [taxYear]
    )).rows;
    const uk = {};
    ratesRows.forEach(r => { uk[r.parameter_key] = parseFloat(r.parameter_value); });

    const scoRows = (await query(
      `SELECT parameter_key, parameter_value FROM tax_rates WHERE tax_year = $1 AND jurisdiction = 'SCO'`,
      [taxYear]
    )).rows;
    const sco = {};
    scoRows.forEach(r => { sco[r.parameter_key] = parseFloat(r.parameter_value); });

    // Personal allowance from tax code
    const pa = uk.personal_allowance || 12570;
    let personalAllowance = pa;
    if (taxCode === 'NT') personalAllowance = salary;
    else if (['BR','D0','D1'].includes(taxCode)) personalAllowance = 0;
    else if (taxCode.startsWith('K')) personalAllowance = -(parseInt(taxCode.slice(1) || 0) * 10);
    else {
      const stripped = taxCode.replace(/^[SC]/, '').replace(/[A-Z]+$/, '');
      const n = parseInt(stripped);
      personalAllowance = isNaN(n) ? pa : n * 10;
    }
    // PA taper: reduces by £1 for every £2 above £100,000, gone at £125,140
    const paTaperStart = uk.pa_taper_start || 100000;
    if (salary > paTaperStart) {
      const taper = Math.floor((salary - paTaperStart) / 2);
      personalAllowance = Math.max(0, personalAllowance - taper);
    }
    personalAllowance = Math.max(0, personalAllowance);
    const salaryTaxable = Math.max(0, salary - personalAllowance);

    // Income tax
    let incomeTax = 0;
    let bands = [];
    if (isScottish) {
      // Fixed Scottish band SIZES — applied sequentially to taxable income
      const starterSize  = sco.starter_band_top  - (sco.personal_allowance || 12570); // 3967
      const basicSize    = sco.basic_band_top     - sco.starter_band_top;              // 12989
      const interSize    = sco.intermediate_band_top - sco.basic_band_top;             // 14136
      const higherSize   = sco.higher_band_top    - sco.intermediate_band_top;         // 31338
      const advSize      = sco.advanced_band_top  - sco.higher_band_top;               // 50140
      const starter = Math.max(0, Math.min(salaryTaxable, starterSize));
      const basic   = Math.max(0, Math.min(salaryTaxable - starterSize, basicSize));
      const inter   = Math.max(0, Math.min(salaryTaxable - starterSize - basicSize, interSize));
      const higher  = Math.max(0, Math.min(salaryTaxable - starterSize - basicSize - interSize, higherSize));
      const adv     = Math.max(0, Math.min(salaryTaxable - starterSize - basicSize - interSize - higherSize, advSize));
      const top     = Math.max(0, salaryTaxable - starterSize - basicSize - interSize - higherSize - advSize);
      incomeTax = Math.round((
        starter * sco.starter_rate + basic * sco.basic_rate + inter * sco.intermediate_rate +
        higher * sco.higher_rate + adv * sco.advanced_rate + top * sco.top_rate
      ) * 100) / 100;
      bands = [
        { label: 'Tax-free (Personal Allowance)', range: `Up to £${pa.toLocaleString()}`, rate: '0%', active: salary <= personalAllowance },
        { label: 'Starter rate', range: `£${(pa+1).toLocaleString()} – £${sco.starter_band_top.toLocaleString()}`, rate: '19%', active: salary > pa && salary <= sco.starter_band_top },
        { label: 'Basic rate', range: `£${(sco.starter_band_top+1).toLocaleString()} – £${sco.basic_band_top.toLocaleString()}`, rate: '20%', active: salary > sco.starter_band_top && salary <= sco.basic_band_top },
        { label: 'Intermediate rate', range: `£${(sco.basic_band_top+1).toLocaleString()} – £${sco.intermediate_band_top.toLocaleString()}`, rate: '21%', active: salary > sco.basic_band_top && salary <= sco.intermediate_band_top },
        { label: 'Higher rate', range: `£${(sco.intermediate_band_top+1).toLocaleString()} – £${sco.higher_band_top.toLocaleString()}`, rate: '42%', active: salary > sco.intermediate_band_top && salary <= sco.higher_band_top },
        { label: 'Advanced rate', range: `£${(sco.higher_band_top+1).toLocaleString()} – £${sco.advanced_band_top.toLocaleString()}`, rate: '45%', active: salary > sco.higher_band_top && salary <= sco.advanced_band_top },
        { label: 'Top rate', range: `Above £${sco.advanced_band_top.toLocaleString()}`, rate: '48%', active: salary > sco.advanced_band_top },
      ];
    } else {
      const basicBandSize  = (uk.basic_rate_threshold || 50270) - (uk.personal_allowance || 12570); // 37700 — fixed
      const higherBandSize = (uk.higher_rate_threshold || 125140) - (uk.basic_rate_threshold || 50270); // 74870 — fixed
      const basicBand  = Math.max(0, Math.min(salaryTaxable, basicBandSize));
      const higherBand = Math.max(0, Math.min(salaryTaxable - basicBandSize, higherBandSize));
      const addlBand   = Math.max(0, salaryTaxable - basicBandSize - higherBandSize);
      incomeTax = Math.round((basicBand * uk.basic_rate + higherBand * uk.higher_rate + addlBand * uk.additional_rate) * 100) / 100;
      bands = [
        { label: 'Tax-free (Personal Allowance)', range: `Up to £${pa.toLocaleString()}`, rate: '0%', active: salary <= personalAllowance },
        { label: 'Basic rate', range: `£${(pa+1).toLocaleString()} – £${(uk.basic_rate_threshold || 50270).toLocaleString()}`, rate: '20%', active: salary > pa && salary <= (uk.basic_rate_threshold || 50270) },
        { label: 'Higher rate', range: `£${((uk.basic_rate_threshold||50270)+1).toLocaleString()} – £${(uk.higher_rate_threshold||125140).toLocaleString()}`, rate: '40%', active: salary > (uk.basic_rate_threshold||50270) && salary <= (uk.higher_rate_threshold||125140) },
        { label: 'Additional rate', range: `Above £${(uk.higher_rate_threshold||125140).toLocaleString()}`, rate: '45%', active: salary > (uk.higher_rate_threshold||125140) },
      ];
    }

    // Employee NI
    const niThreshold = uk.ni_primary_threshold || 12570;
    const niUEL = uk.ni_upper_earnings_limit || 50270;
    const niDue = Math.round((
      Math.max(0, Math.min(salary, niUEL) - niThreshold) * (uk.ni_main_rate || 0.08) +
      Math.max(0, salary - niUEL) * (uk.ni_upper_rate || 0.02)
    ) * 100) / 100;

    // Employer NI
    const empNiThreshold = uk.employer_ni_secondary_threshold || 5000;
    const employerNI = Math.round(Math.max(0, salary - empNiThreshold) * (uk.employer_ni_rate || 0.15) * 100) / 100;

    // Take-home & corp tax saving
    const takeHome = Math.round((salary - incomeTax - niDue) * 100) / 100;
    const corpTaxSaving = Math.round(salary * 0.19 * 100) / 100;

    // This tax year so far
    const fyStart = new Date('2026-04-06');
    const today = new Date();
    const monthsElapsed = Math.min(12, Math.max(1, Math.floor((today - fyStart) / (1000 * 60 * 60 * 24 * 30.44)) + 1));
    const monthlyGross = Math.round((salary / 12) * 100) / 100;
    const salaryTakenYTD = Math.round(monthlyGross * monthsElapsed * 100) / 100;

    res.json({
      salary, personalAllowance, salaryTaxable,
      incomeTax, niDue, employerNI, takeHome, corpTaxSaving,
      isScottish, taxCode, taxYear,
      monthlyGross, salaryTakenYTD, monthsElapsed,
      isTaxFree: salary <= personalAllowance && niDue === 0,
      bands,
    });
  } catch (err) {
    console.error('[SALARY-BREAKDOWN]', err.message);
    res.status(500).json({ error: 'Failed to calculate salary breakdown' });
  }
});

module.exports = router;
