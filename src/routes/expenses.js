'use strict';

/**
 * FlexFlow — Expenses Routes
 * Session F — Task 6b
 *
 * GET  /expenses/summary          — total deductions, taxable profit
 * GET  /expenses/records          — all expense records
 * POST /expenses/confirm          — confirm a Tier 2 prompted expense
 * POST /expenses/manual           — manually mark a transaction as expense
 * GET  /expenses/home-office      — home office deduction
 * POST /expenses/home-office      — set home office hours
 * GET  /expenses/mileage          — mileage deduction summary
 * POST /expenses/mileage          — log a business journey
 * GET  /expenses/vat              — VAT calculation and deadline
 * GET  /expenses/vat/threshold    — VAT threshold check
 */

const express = require('express');
const router  = express.Router();
const { verifyToken, checkOnboardingComplete } = require('../middleware/auth');
const { processExpense, calcHomeOfficeDeduction, calcMileageDeduction,
        recalcTaxableProfit, getCurrentTaxYear } = require('../engines/ede');
const { calculateVAT, checkVATThreshold, getCurrentVATQuarter,
        verifyVATDeadlines } = require('../engines/vat');
const { query } = require('../config/database');

router.use(verifyToken, checkOnboardingComplete);

// ── GET /expenses/summary ─────────────────────────────────────────────────────

router.get('/summary', async (req, res) => {
  try {
    const result = await recalcTaxableProfit(req.user.userId);
    return res.json({
      ...result,
      tax_year: getCurrentTaxYear(),
    });
  } catch (err) {
    console.error('Expenses summary error:', err);
    return res.status(500).json({ error: 'Failed to get expenses summary.' });
  }
});

// ── GET /expenses/records ─────────────────────────────────────────────────────

router.get('/records', async (req, res) => {
  try {
    const taxYear = req.query.tax_year || getCurrentTaxYear();
    const result = await query(
      `SELECT er.*, t.description, t.merchant_name, t.transaction_date
       FROM expense_records er
       LEFT JOIN transactions t ON t.id = er.transaction_id
       WHERE er.user_id = $1 AND er.tax_year = $2 AND er.confirmed = true
       ORDER BY t.transaction_date DESC`,
      [req.user.userId, taxYear]
    );
    return res.json({ records: result.rows, tax_year: taxYear });
  } catch (err) {
    console.error('Expense records error:', err);
    return res.status(500).json({ error: 'Failed to get expense records.' });
  }
});

// ── POST /expenses/confirm ────────────────────────────────────────────────────
// Confirm a Tier 2 prompted expense with business use %

router.post('/confirm', async (req, res) => {
  try {
    const { transaction_id, business_pct, hmrc_category } = req.body;

    if (!transaction_id || business_pct === undefined) {
      return res.status(400).json({ error: 'transaction_id and business_pct required.' });
    }
    if (business_pct < 0 || business_pct > 100) {
      return res.status(400).json({ error: 'business_pct must be 0–100.' });
    }

    // Get transaction amount
    const txnResult = await query(
      `SELECT amount FROM transactions WHERE id = $1 AND user_id = $2`,
      [transaction_id, req.user.userId]
    );
    if (txnResult.rows.length === 0) {
      return res.status(404).json({ error: 'Transaction not found.' });
    }

    const absAmount   = Math.abs(parseFloat(txnResult.rows[0].amount));
    const deductAmount = Math.round(absAmount * business_pct / 100 * 100) / 100;

    await query(`
      INSERT INTO expense_records
        (user_id, transaction_id, tax_year, hmrc_category, business_pct,
         deduct_amount, auto_detected, confirmed)
      VALUES ($1,$2,$3,$4,$5,$6,false,true)
      ON CONFLICT (user_id, transaction_id) DO UPDATE SET
        hmrc_category = EXCLUDED.hmrc_category,
        business_pct  = EXCLUDED.business_pct,
        deduct_amount = EXCLUDED.deduct_amount,
        confirmed     = true,
        updated_at    = NOW()
    `, [
      req.user.userId, transaction_id, getCurrentTaxYear(),
      hmrc_category || 'other', business_pct, deductAmount,
    ]);

    // Store override for future transactions from same merchant
    const txn = await query(
      `SELECT merchant_name FROM transactions WHERE id = $1`,
      [transaction_id]
    );
    if (txn.rows[0]?.merchant_name) {
      await query(`
        INSERT INTO user_expense_overrides
          (user_id, merchant_pattern, business_pct, hmrc_category)
        VALUES ($1,$2,$3,$4)
        ON CONFLICT (user_id, merchant_pattern) DO UPDATE SET
          business_pct  = EXCLUDED.business_pct,
          hmrc_category = EXCLUDED.hmrc_category
      `, [req.user.userId, txn.rows[0].merchant_name, business_pct, hmrc_category]);
    }

    const result = await recalcTaxableProfit(req.user.userId);
    return res.json({ message: 'Expense confirmed.', deduct_amount: deductAmount, ...result });

  } catch (err) {
    console.error('Confirm expense error:', err);
    return res.status(500).json({ error: 'Failed to confirm expense.' });
  }
});

// ── GET/POST /expenses/home-office ────────────────────────────────────────────

router.get('/home-office', async (req, res) => {
  try {
    const result = await query(
      `SELECT * FROM home_office_config WHERE user_id = $1`,
      [req.user.userId]
    );
    if (result.rows.length === 0) {
      return res.json({ configured: false, annual_deduction: 0 });
    }
    return res.json({ configured: true, ...result.rows[0] });
  } catch (err) {
    console.error('Home office get error:', err);
    return res.status(500).json({ error: 'Failed to get home office config.' });
  }
});

router.post('/home-office', async (req, res) => {
  try {
    const { monthly_hours, method = 'flat_rate' } = req.body;

    if (!monthly_hours || monthly_hours < 25) {
      return res.status(400).json({
        error: 'Minimum 25 hours per month required for home office deduction.',
      });
    }

    const calc = await calcHomeOfficeDeduction(req.user.userId, monthly_hours, method);

    if (!calc.eligible) {
      return res.status(400).json({ error: 'Not eligible for home office deduction.', ...calc });
    }

    await query(`
      INSERT INTO home_office_config
        (user_id, monthly_hours, method, monthly_deduction, annual_deduction)
      VALUES ($1,$2,$3,$4,$5)
      ON CONFLICT (user_id) DO UPDATE SET
        monthly_hours    = EXCLUDED.monthly_hours,
        method           = EXCLUDED.method,
        monthly_deduction= EXCLUDED.monthly_deduction,
        annual_deduction = EXCLUDED.annual_deduction,
        updated_at       = NOW()
    `, [req.user.userId, monthly_hours, method, calc.monthly, calc.annual]);

    const totals = await recalcTaxableProfit(req.user.userId);
    return res.json({ message: 'Home office deduction set.', ...calc, ...totals });

  } catch (err) {
    console.error('Home office set error:', err);
    return res.status(500).json({ error: 'Failed to set home office deduction.' });
  }
});

// ── GET/POST /expenses/mileage ────────────────────────────────────────────────

router.get('/mileage', async (req, res) => {
  try {
    const taxYear = req.query.tax_year || getCurrentTaxYear();
    const summary = await calcMileageDeduction(req.user.userId, taxYear);
    const trips   = await query(
      `SELECT * FROM mileage_log WHERE user_id = $1 AND tax_year = $2 ORDER BY journey_date DESC`,
      [req.user.userId, taxYear]
    );
    return res.json({ ...summary, trips: trips.rows, tax_year: taxYear });
  } catch (err) {
    console.error('Mileage get error:', err);
    return res.status(500).json({ error: 'Failed to get mileage.' });
  }
});

router.post('/mileage', async (req, res) => {
  try {
    const { miles, purpose, journey_date } = req.body;

    if (!miles || miles <= 0) return res.status(400).json({ error: 'miles required.' });
    if (!purpose)             return res.status(400).json({ error: 'purpose required.' });

    const taxYear = getCurrentTaxYear();
    await query(`
      INSERT INTO mileage_log (user_id, miles, purpose, journey_date, tax_year)
      VALUES ($1,$2,$3,$4,$5)
    `, [req.user.userId, miles, purpose, journey_date || new Date().toISOString().split('T')[0], taxYear]);

    const summary = await calcMileageDeduction(req.user.userId, taxYear);
    await recalcTaxableProfit(req.user.userId);
    return res.json({ message: 'Journey logged.', ...summary });

  } catch (err) {
    console.error('Mileage post error:', err);
    return res.status(500).json({ error: 'Failed to log journey.' });
  }
});

// ── GET /expenses/vat ─────────────────────────────────────────────────────────

router.get('/vat', async (req, res) => {
  try {
    const taxYear = req.query.tax_year || getCurrentTaxYear();
    const result  = await calculateVAT(req.user.userId, taxYear);
    return res.json(result);
  } catch (err) {
    console.error('VAT error:', err);
    return res.status(500).json({ error: 'Failed to calculate VAT.' });
  }
});

router.get('/vat/threshold', async (req, res) => {
  try {
    const result = await checkVATThreshold(req.user.userId);
    return res.json(result);
  } catch (err) {
    console.error('VAT threshold error:', err);
    return res.status(500).json({ error: 'Failed to check VAT threshold.' });
  }
});

// ── GET /expenses/vat/deadlines (dev utility) ─────────────────────────────────
// Verifies VAT deadline arithmetic against Build Note 10 confirmed figures

router.get('/vat/deadlines', async (req, res) => {
  const results = verifyVATDeadlines();
  const allPass = results.every(r => r.pass);
  return res.json({ all_pass: allPass, results });
});

module.exports = router;
