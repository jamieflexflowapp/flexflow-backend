'use strict';

/**
 * FlexFlow — Expenses Routes
 * Updated Phase 4 — Expense Review UI endpoints added
 *
 * GET  /expenses/summary          — total deductions, taxable profit
 * GET  /expenses/records          — all confirmed expense records
 * GET  /expenses/review           — transactions pending Tier 2 review
 * POST /expenses/confirm          — confirm a Tier 2 expense with business %
 * POST /expenses/dismiss          — dismiss a transaction (not an expense)
 * POST /expenses/undo             — undo a dismiss — move back to pending
 * POST /expenses/manual           — manually mark any transaction as expense
 * GET  /expenses/home-office      — home office deduction
 * POST /expenses/home-office      — set home office hours
 * GET  /expenses/mileage          — mileage deduction summary + trip list
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
      `SELECT er.*, t.description, t.merchant_name, t.transaction_date,
              t.amount AS transaction_amount
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

// ── GET /expenses/review ──────────────────────────────────────────────────────
// Returns all transactions pending Tier 2 review, confirmed, and dismissed

router.get('/review', async (req, res) => {
  try {
    const taxYear = req.query.tax_year || getCurrentTaxYear();

    // Tier 2 pending — flagged but not yet confirmed or dismissed
    const pending = await query(
      `SELECT t.id, t.merchant_name, t.description, t.amount,
              t.transaction_date, n.alert_subtype AS prompt
       FROM transactions t
       JOIN notifications n ON n.user_id = t.user_id
         AND n.alert_type = 'CLASSIF_EXPENSE_POTENTIAL'
         AND n.metadata->>'transaction_id' = t.id::text
       WHERE t.user_id = $1
         AND t.transaction_date >= $2
         AND NOT EXISTS (
           SELECT 1 FROM expense_records er
           WHERE er.transaction_id = t.id AND er.user_id = t.user_id
         )
       ORDER BY t.transaction_date DESC`,
      [req.user.userId, taxYear + '-04-06']
    );

    // Confirmed Tier 2 expenses
    const confirmed = await query(
      `SELECT er.id, t.merchant_name, t.description, t.amount AS transaction_amount,
              t.transaction_date, er.business_pct, er.deduct_amount, er.hmrc_category
       FROM expense_records er
       JOIN transactions t ON t.id = er.transaction_id
       WHERE er.user_id = $1 AND er.tax_year = $2
         AND er.confirmed = true AND er.auto_detected = false
       ORDER BY t.transaction_date DESC`,
      [req.user.userId, taxYear]
    );

    // Dismissed transactions
    const dismissed = await query(
      `SELECT t.id, t.merchant_name, t.description, t.amount, t.transaction_date
       FROM transactions t
       JOIN expense_dismissals ed ON ed.transaction_id = t.id
         AND ed.user_id = t.user_id
       WHERE t.user_id = $1
         AND t.transaction_date >= $2
       ORDER BY t.transaction_date DESC`,
      [req.user.userId, taxYear + '-04-06']
    );

    // Auto-detected expenses
    const auto = await query(
      `SELECT er.id, t.merchant_name, t.description, t.amount AS transaction_amount,
              t.transaction_date, er.hmrc_category, er.deduct_amount
       FROM expense_records er
       JOIN transactions t ON t.id = er.transaction_id
       WHERE er.user_id = $1 AND er.tax_year = $2
         AND er.confirmed = true AND er.auto_detected = true
       ORDER BY t.transaction_date DESC`,
      [req.user.userId, taxYear]
    );

    return res.json({
      pending:   pending.rows,
      confirmed: confirmed.rows,
      dismissed: dismissed.rows,
      auto:      auto.rows,
      tax_year:  taxYear,
      pending_count: pending.rows.length,
    });

  } catch (err) {
    console.error('Expense review error:', err);
    return res.status(500).json({ error: 'Failed to get expense review.' });
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

    // Get transaction
    const txnResult = await query(
      `SELECT amount, merchant_name FROM transactions WHERE id = $1 AND user_id = $2`,
      [transaction_id, req.user.userId]
    );
    if (txnResult.rows.length === 0) {
      return res.status(404).json({ error: 'Transaction not found.' });
    }

    const txn         = txnResult.rows[0];
    const absAmount   = Math.abs(parseFloat(txn.amount));
    const deductAmount = Math.round(absAmount * business_pct / 100 * 100) / 100;
    const taxYear     = getCurrentTaxYear();

    // Remove any dismissal record for this transaction
    await query(
      `DELETE FROM expense_dismissals WHERE transaction_id = $1 AND user_id = $2`,
      [transaction_id, req.user.userId]
    );

    // Upsert expense record
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
      req.user.userId, transaction_id, taxYear,
      hmrc_category || 'other', business_pct, deductAmount,
    ]);

    // Store merchant override so future transactions are auto-handled
    if (txn.merchant_name) {
      await query(`
        INSERT INTO user_expense_overrides
          (user_id, merchant_pattern, business_pct, hmrc_category)
        VALUES ($1,$2,$3,$4)
        ON CONFLICT (user_id, merchant_pattern) DO UPDATE SET
          business_pct  = EXCLUDED.business_pct,
          hmrc_category = EXCLUDED.hmrc_category,
          updated_at    = NOW()
      `, [req.user.userId, txn.merchant_name, business_pct, hmrc_category || 'other']);
    }

    const result = await recalcTaxableProfit(req.user.userId);
    return res.json({
      message:       'Expense confirmed.',
      deduct_amount: deductAmount,
      ...result,
    });

  } catch (err) {
    console.error('Confirm expense error:', err);
    return res.status(500).json({ error: 'Failed to confirm expense.' });
  }
});

// ── POST /expenses/dismiss ────────────────────────────────────────────────────
// Dismiss a transaction — user says it is NOT a business expense

router.post('/dismiss', async (req, res) => {
  try {
    const { transaction_id } = req.body;

    if (!transaction_id) {
      return res.status(400).json({ error: 'transaction_id required.' });
    }

    // Verify transaction belongs to user
    const txn = await query(
      `SELECT id FROM transactions WHERE id = $1 AND user_id = $2`,
      [transaction_id, req.user.userId]
    );
    if (txn.rows.length === 0) {
      return res.status(404).json({ error: 'Transaction not found.' });
    }

    // Remove any existing expense record
    await query(
      `DELETE FROM expense_records WHERE transaction_id = $1 AND user_id = $2`,
      [transaction_id, req.user.userId]
    );

    // Insert dismissal record
    await query(`
      INSERT INTO expense_dismissals (user_id, transaction_id)
      VALUES ($1, $2)
      ON CONFLICT (user_id, transaction_id) DO NOTHING
    `, [req.user.userId, transaction_id]);

    const result = await recalcTaxableProfit(req.user.userId);
    return res.json({ message: 'Transaction dismissed.', ...result });

  } catch (err) {
    console.error('Dismiss expense error:', err);
    return res.status(500).json({ error: 'Failed to dismiss transaction.' });
  }
});

// ── POST /expenses/undo ───────────────────────────────────────────────────────
// Undo a dismissal — move transaction back to pending review

router.post('/undo', async (req, res) => {
  try {
    const { transaction_id } = req.body;

    if (!transaction_id) {
      return res.status(400).json({ error: 'transaction_id required.' });
    }

    // Remove dismissal record
    await query(
      `DELETE FROM expense_dismissals WHERE transaction_id = $1 AND user_id = $2`,
      [transaction_id, req.user.userId]
    );

    // Also remove any expense record so it goes back to pending
    await query(
      `DELETE FROM expense_records
       WHERE transaction_id = $1 AND user_id = $2 AND auto_detected = false`,
      [transaction_id, req.user.userId]
    );

    return res.json({ message: 'Transaction moved back to review.' });

  } catch (err) {
    console.error('Undo dismiss error:', err);
    return res.status(500).json({ error: 'Failed to undo dismissal.' });
  }
});

// ── POST /expenses/manual ─────────────────────────────────────────────────────
// Manually mark any transaction as an allowable expense

router.post('/manual', async (req, res) => {
  try {
    const { transaction_id, hmrc_category, business_pct = 100 } = req.body;

    if (!transaction_id || !hmrc_category) {
      return res.status(400).json({ error: 'transaction_id and hmrc_category required.' });
    }

    const txnResult = await query(
      `SELECT amount FROM transactions WHERE id = $1 AND user_id = $2`,
      [transaction_id, req.user.userId]
    );
    if (txnResult.rows.length === 0) {
      return res.status(404).json({ error: 'Transaction not found.' });
    }

    const absAmount    = Math.abs(parseFloat(txnResult.rows[0].amount));
    const deductAmount = Math.round(absAmount * business_pct / 100 * 100) / 100;
    const taxYear      = getCurrentTaxYear();

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
    `, [req.user.userId, transaction_id, taxYear,
        hmrc_category, business_pct, deductAmount]);

    const result = await recalcTaxableProfit(req.user.userId);
    return res.json({ message: 'Expense manually added.', deduct_amount: deductAmount, ...result });

  } catch (err) {
    console.error('Manual expense error:', err);
    return res.status(500).json({ error: 'Failed to add manual expense.' });
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
      return res.json({ configured: false, monthlyHours: 0, annualDeduction: 0 });
    }
    const r = result.rows[0];
    return res.json({
      configured: true,
      id: r.id,
      userId: r.user_id,
      monthlyHours: r.monthly_hours,
      method: r.method,
      monthlyDeduction: r.monthly_deduction,
      annualDeduction: r.annual_deduction,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    });
  } catch (err) {
    console.error('Home office get error:', err);
    return res.status(500).json({ error: 'Failed to get home office config.' });
  }
});

router.post('/home-office', async (req, res) => {
  try {
    const { monthly_hours, method = 'flat_rate' } = req.body;

    const calc = await calcHomeOfficeDeduction(req.user.userId, monthly_hours || 0, method);

    await query(`
      INSERT INTO home_office_config
        (user_id, monthly_hours, method, monthly_deduction, annual_deduction)
      VALUES ($1,$2,$3,$4,$5)
      ON CONFLICT (user_id) DO UPDATE SET
        monthly_hours     = EXCLUDED.monthly_hours,
        method            = EXCLUDED.method,
        monthly_deduction = EXCLUDED.monthly_deduction,
        annual_deduction  = EXCLUDED.annual_deduction,
        updated_at        = NOW()
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
    `, [req.user.userId, miles, purpose,
        journey_date || new Date().toISOString().split('T')[0], taxYear]);

    const summary = await calcMileageDeduction(req.user.userId, taxYear);
    await recalcTaxableProfit(req.user.userId);
    return res.json({ message: 'Journey logged.', ...summary });

  } catch (err) {
    console.error('Mileage post error:', err);
    return res.status(500).json({ error: 'Failed to log journey.' });
  }
});


// ── DELETE /expenses/mileage/:id ─────────────────────────────────────────────
// Delete a specific mileage journey

router.delete('/mileage/:id', async (req, res) => {
  try {
    const result = await query(
      `DELETE FROM mileage_log WHERE id = $1 AND user_id = $2`,
      [req.params.id, req.user.userId]
    );
    if (result.rowCount === 0) {
      return res.status(404).json({ error: 'Journey not found.' });
    }
    await recalcTaxableProfit(req.user.userId);
    return res.json({ message: 'Journey deleted.' });
  } catch (err) {
    console.error('Delete mileage error:', err);
    return res.status(500).json({ error: 'Failed to delete journey.' });
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

router.get('/vat/deadlines', async (req, res) => {
  const results = verifyVATDeadlines();
  const allPass = results.every(r => r.pass);
  return res.json({ all_pass: allPass, results });
});

module.exports = router;
