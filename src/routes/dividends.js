'use strict';

const express     = require('express');
const router      = express.Router();
const { query }   = require('../config/database');
const { verifyToken, checkOnboardingComplete } = require('../middleware/auth');

// ── GET /dividends/calculator ────────────────────────────────────────────────
// Returns the available-to-take figure for the dividend calculator
// Formula: bank_balance − tax_pot
router.get('/calculator', verifyToken, checkOnboardingComplete, async (req, res) => {
  try {
    const userId = req.user.id;

    // Get available balance and tax pot
    const balResult = await query(
      `SELECT
         COALESCE(SUM(CASE WHEN t.amount > 0 THEN t.amount ELSE 0 END), 0)
         - COALESCE(SUM(CASE WHEN t.amount < 0 THEN ABS(t.amount) ELSE 0 END), 0)
         AS available_balance
       FROM transactions t
       WHERE t.user_id = $1`,
      [userId]
    );

    const taxPotResult = await query(
      `SELECT COALESCE(tax_pot_balance, 0) AS tax_pot
       FROM users WHERE id = $1`,
      [userId]
    );

    const availableBalance = parseFloat(balResult.rows[0]?.available_balance) || 0;
    const taxPot           = parseFloat(taxPotResult.rows[0]?.tax_pot) || 0;
    const afterTax         = availableBalance - taxPot;
    const availableTake    = Math.round(afterTax * 100) / 100;

    // Get dividend allowance remaining this tax year
    const divResult = await query(
      `SELECT COALESCE(SUM(ie.gross_amount), 0) AS ytd_dividends
       FROM income_events ie
       WHERE ie.user_id = $1
         AND ie.income_type = 'dividend'
         AND ie.income_date >= DATE_TRUNC('year', CURRENT_DATE - INTERVAL '3 months') + INTERVAL '3 months'`,
      [userId]
    );
    const ytdDividends    = parseFloat(divResult.rows[0]?.ytd_dividends) || 0;
    const divAllowance    = 500; // £500 2024/25+
    const allowanceUsed   = Math.min(ytdDividends, divAllowance);
    const allowanceLeft   = Math.max(divAllowance - allowanceUsed, 0);

    // Get user's tax band for dividend rate
    const userResult = await query(
      `SELECT director_salary_annual, dividend_frequency FROM users WHERE id = $1`,
      [userId]
    );
    const user = userResult.rows[0] || {};

    res.json({
      available_balance:   Math.round(availableBalance * 100) / 100,
      tax_pot:             Math.round(taxPot * 100) / 100,
      available_to_take:   Math.max(availableTake, 0),
      dividend_allowance:  divAllowance,
      allowance_used:      Math.round(allowanceUsed * 100) / 100,
      allowance_remaining: allowanceLeft,
      director_salary_annual: parseFloat(user.director_salary_annual) || 12570,
      dividend_frequency:     user.dividend_frequency || 'quarterly',
    });
  } catch (err) {
    console.error('Dividend calculator error:', err);
    res.status(500).json({ error: 'Failed to calculate dividend position' });
  }
});

// ── POST /dividends/calculate-tax ────────────────────────────────────────────
// Real-time tax calculation for a proposed dividend amount
router.post('/calculate-tax', verifyToken, checkOnboardingComplete, async (req, res) => {
  try {
    const userId = req.user.id;
    const { amount } = req.body;

    if (!amount || parseFloat(amount) <= 0) {
      return res.status(400).json({ error: 'amount must be greater than 0' });
    }

    const proposedDiv = parseFloat(amount);

    // Get user details for band calculation
    const userResult = await query(
      `SELECT director_salary_annual, is_scottish_taxpayer FROM users WHERE id = $1`,
      [userId]
    );
    const user = userResult.rows[0] || {};
    const annualSalary = parseFloat(user.director_salary_annual) || 12570;

    // Get YTD dividends already taken
    const divResult = await query(
      `SELECT COALESCE(SUM(gross_amount), 0) AS ytd_dividends
       FROM income_events
       WHERE user_id = $1 AND income_type = 'dividend'
         AND income_date >= DATE_TRUNC('year', CURRENT_DATE - INTERVAL '3 months') + INTERVAL '3 months'`,
      [userId]
    );
    const ytdDividends   = parseFloat(divResult.rows[0]?.ytd_dividends) || 0;
    const divAllowance   = 500;
    const allowanceLeft  = Math.max(divAllowance - ytdDividends, 0);

    // Calculate tax on proposed dividend
    const taxFree        = Math.min(proposedDiv, allowanceLeft);
    const taxable        = Math.max(proposedDiv - taxFree, 0);

    // Determine rate based on total income (salary + dividends)
    const totalIncome    = annualSalary + ytdDividends + proposedDiv;
    const basicThreshold = 50270;
    const higherThreshold = 125140;

    let tax = 0;
    let rate = 0;
    let band = 'basic';

    if (totalIncome <= basicThreshold) {
      rate = 0.0875; band = 'basic';
      tax  = Math.round(taxable * rate * 100) / 100;
    } else if (totalIncome <= higherThreshold) {
      rate = 0.3375; band = 'higher';
      tax  = Math.round(taxable * rate * 100) / 100;
    } else {
      rate = 0.3935; band = 'additional';
      tax  = Math.round(taxable * rate * 100) / 100;
    }

    const netAmount = Math.round((proposedDiv - tax) * 100) / 100;

    res.json({
      proposed_dividend:   proposedDiv,
      tax_free_portion:    Math.round(taxFree * 100) / 100,
      taxable_portion:     Math.round(taxable * 100) / 100,
      dividend_tax:        tax,
      effective_rate:      rate,
      band,
      net_amount:          netAmount,
      allowance_remaining: Math.round(allowanceLeft * 100) / 100,
    });
  } catch (err) {
    console.error('Dividend tax calc error:', err);
    res.status(500).json({ error: 'Failed to calculate dividend tax' });
  }
});

// ── POST /dividends/log ──────────────────────────────────────────────────────
// Log a dividend payment taken
router.post('/log', verifyToken, checkOnboardingComplete, async (req, res) => {
  try {
    const userId = req.user.id;
    const { amount, date, notes } = req.body;

    if (!amount || parseFloat(amount) <= 0) {
      return res.status(400).json({ error: 'amount must be greater than 0' });
    }

    const dividendDate = date || new Date().toISOString().split('T')[0];
    const grossAmount  = parseFloat(amount);

    // Insert as income event
    const result = await query(
      `INSERT INTO income_events
         (user_id, income_date, gross_amount, income_type,
          source_name, notes, included_in_smoothing)
       VALUES ($1, $2, $3, 'dividend', 'Director Dividend', $4, true)
       RETURNING id, income_date, gross_amount`,
      [userId, dividendDate, grossAmount, notes || null]
    );

    // Log in quarterly_review_log
    const now = new Date();
    const quarter = `Q${Math.ceil((now.getMonth() + 1) / 3)}`;
    const taxYear = now.getMonth() >= 3
      ? `${now.getFullYear()}/${now.getFullYear() + 1 - 2000}`
      : `${now.getFullYear() - 1}/${now.getFullYear() - 2000}`;

    await query(
      `INSERT INTO quarterly_review_log
         (user_id, quarter, tax_year, review_date, new_dividend,
          user_responded, user_responded_at)
       VALUES ($1, $2, $3, $4, $5, true, NOW())
       ON CONFLICT (user_id, quarter, tax_year)
       DO UPDATE SET new_dividend = $5, user_responded = true, user_responded_at = NOW()`,
      [userId, quarter, taxYear, dividendDate, grossAmount]
    );

    res.status(201).json({
      success:      true,
      income_event: result.rows[0],
      quarter,
      tax_year:     taxYear,
    });
  } catch (err) {
    console.error('Log dividend error:', err);
    res.status(500).json({ error: 'Failed to log dividend' });
  }
});

// ── GET /dividends/history ───────────────────────────────────────────────────
// Returns dividend history for the current tax year
router.get('/history', verifyToken, checkOnboardingComplete, async (req, res) => {
  try {
    const userId = req.user.id;

    const result = await query(
      `SELECT id, income_date, gross_amount, notes, created_at
       FROM income_events
       WHERE user_id = $1
         AND income_type = 'dividend'
         AND income_date >= DATE_TRUNC('year', CURRENT_DATE - INTERVAL '3 months') + INTERVAL '3 months'
       ORDER BY income_date DESC
       LIMIT 20`,
      [userId]
    );

    const total = result.rows.reduce((s, r) => s + parseFloat(r.gross_amount), 0);

    res.json({
      dividends:  result.rows,
      total_ytd:  Math.round(total * 100) / 100,
      count:      result.rows.length,
    });
  } catch (err) {
    console.error('Dividend history error:', err);
    res.status(500).json({ error: 'Failed to fetch dividend history' });
  }
});

// ── PUT /dividends/settings ──────────────────────────────────────────────────
// Update director salary and dividend frequency
router.put('/settings', verifyToken, checkOnboardingComplete, async (req, res) => {
  try {
    const userId = req.user.id;
    const { director_salary_annual, dividend_frequency } = req.body;

    const validFrequencies = ['monthly', 'quarterly', 'annually', 'adhoc'];
    if (dividend_frequency && !validFrequencies.includes(dividend_frequency)) {
      return res.status(400).json({ error: 'Invalid dividend_frequency' });
    }

    await query(
      `UPDATE users SET
         director_salary_annual        = COALESCE($1, director_salary_annual),
         dividend_frequency            = COALESCE($2, dividend_frequency),
         dividend_frequency_updated_at = NOW()
       WHERE id = $3`,
      [director_salary_annual || null, dividend_frequency || null, userId]
    );

    res.json({ success: true });
  } catch (err) {
    console.error('Dividend settings error:', err);
    res.status(500).json({ error: 'Failed to update dividend settings' });
  }
});

module.exports = router;
