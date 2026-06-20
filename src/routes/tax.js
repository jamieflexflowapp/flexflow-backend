'use strict';

/**
 * FlexFlow — Tax Routes
 * Session E — Task 6a
 *
 * GET  /tax/liability          — get current tax liability and pot target
 * POST /tax/calculate          — trigger full recalculation
 * GET  /tax/breakdown          — detailed breakdown by income type
 * GET  /tax/rates              — current tax rates from database (transparency)
 * GET  /tax/pot                — current tax pot status
 */

const express = require('express');
const router  = express.Router();
const { verifyToken, checkOnboardingComplete } = require('../middleware/auth');
const { calculateTaxLiability, loadRates } = require('../engines/tax');
const { query } = require('../config/database');

router.use(verifyToken, checkOnboardingComplete);

// ── GET /tax/liability ────────────────────────────────────────────────────────
// Returns current tax liability — reads from tax_calculations table
// If not yet calculated, triggers calculation first

router.get('/liability', async (req, res) => {
  try {
    const taxYear = req.query.tax_year || '2026/27';

    // Always recalculate fresh so data reflects latest confirmed transactions
    const r = await calculateTaxLiability(req.user.userId, taxYear);

    // confirmedFytdTotal — single source of truth for pre-tax income display
    // Reads directly from transactions table (same source as income page)
    const now = new Date();
    const fyYear = (now.getMonth() > 3 || (now.getMonth() === 3 && now.getDate() >= 6))
      ? now.getFullYear() : now.getFullYear() - 1;
    const fyStart = `${fyYear}-04-06`;
    const confirmedResult = await query(
      `SELECT COALESCE(SUM(amount), 0) as total FROM transactions
       WHERE user_id = $1 AND transaction_type = 'CREDIT'
         AND transaction_date >= $2
         AND is_income = true AND user_confirmed = true`,
      [req.user.userId, fyStart]
    );
    const confirmedFytdTotal = parseFloat(confirmedResult.rows[0]?.total) || 0;

    return res.json({
      // Original field names
      taxYear:          r.tax_year,
      isScottish:       r.is_scottish,
      grossPaye:        r.gross_paye        || 0,
      grossSe:          r.gross_se          || 0,
      grossDividends:   r.gross_dividends   || 0,
      grossRental:      r.gross_rental      || 0,
      partnerShare:     r.partner_share     || 0,
      effectivePa:      r.effective_pa      || 0,
      paTapered:        r.pa_tapered        || false,
      itTotal:          r.it_total          || 0,
      niClass2:         r.ni_class2         || 0,
      niClass4:         r.ni_class4         || 0,
      niTotal:          r.ni_total          || 0,
      s24Credit:        r.s24_credit        || 0,
      totalLiability:   r.total_liability   || 0,
      monthlyTaxPot:    r.monthly_tax_pot   || 0,
      mtdRequired:      r.mtd_required      || false,
      calculatedAt:     r.calculated_at,
      // camelCase aliases expected by frontend TaxScreen
      confirmedFytdTotal,
      taxableProfit:               (r.gross_se || 0) + (r.gross_paye || 0),
      incomeTaxDue:                r.it_total          || 0,
      class4NiDue:                 r.ni_class4         || 0,
      class2NiDue:                 r.ni_class2         || 0,
      totalTaxDue:                 r.total_liability   || 0,
      effectivePersonalAllowance:  r.effective_pa      || 0,
      taxCode:                     r.tax_code          || '1257L',
      pensionReliefAmount:         r.pension?.income_tax_saving || 0,
    });

  } catch (err) {
    console.error('Tax liability error:', err);
    return res.status(500).json({ error: 'Failed to retrieve tax liability.' });
  }
});

// ── POST /tax/calculate ───────────────────────────────────────────────────────
// Full recalculation — triggered after new income events, settings change etc

router.post('/calculate', async (req, res) => {
  try {
    const taxYear = req.body.tax_year || '2026/27';
    const result  = await calculateTaxLiability(req.user.userId, taxYear);
    return res.json({ message: 'Tax liability recalculated.', ...result });
  } catch (err) {
    console.error('Tax calculate error:', err);
    return res.status(500).json({ error: 'Tax calculation failed.' });
  }
});

// ── GET /tax/rates ────────────────────────────────────────────────────────────
// Show the user which rates are being used — transparency + FCA compliance

router.get('/rates', async (req, res) => {
  try {
    const taxYear = req.query.tax_year || '2026/27';

    // Get user's Scottish status
    const userResult = await query(
      `SELECT is_scottish_taxpayer FROM users WHERE id = $1`,
      [req.user.userId]
    );
    const isScottish = userResult.rows[0]?.is_scottish_taxpayer || false;

    const result = await query(
      `SELECT parameter_key, parameter_value, description, jurisdiction, source
       FROM tax_rates
       WHERE tax_year = $1
         AND jurisdiction IN ('UK', $2)
       ORDER BY jurisdiction, parameter_key`,
      [taxYear, isScottish ? 'SCO' : 'UK']
    );

    return res.json({
      tax_year:    taxYear,
      jurisdiction: isScottish ? 'SCO' : 'UK',
      rates:       result.rows,
      note:        'All tax calculations use these rates. Rates are updated automatically when HMRC publishes changes.',
    });
  } catch (err) {
    console.error('Tax rates error:', err);
    return res.status(500).json({ error: 'Failed to retrieve tax rates.' });
  }
});

// ── GET /tax/pot ──────────────────────────────────────────────────────────────
// Current tax pot status — balance vs target

router.get('/pot', async (req, res) => {
  try {
    // Get tax account balance
    const potResult = await query(
      `SELECT bc.tax_pot_balance, u.tax_pot_target, u.mtd_required
       FROM users u
       LEFT JOIN bank_connections bc
         ON bc.user_id = u.id AND bc.is_tax_account = true
       WHERE u.id = $1`,
      [req.user.userId]
    );

    const r = potResult.rows[0];
    const balance = parseFloat(r?.tax_pot_balance) || 0;
    const target  = parseFloat(r?.tax_pot_target)  || 0;
    const shortfall = Math.max(0, target - balance);
    const coverage  = target > 0 ? Math.round((balance / target) * 100) : 100;

    let status = 'TPVE_UNKNOWN';
    if (target === 0)         status = 'TPVE_UNKNOWN';
    else if (coverage >= 100) status = 'TPVE_GOOD';
    else if (coverage >= 80)  status = 'TPVE_AMBER';
    else                      status = 'TPVE_RED';

    return res.json({
      current_balance: balance,
      target_balance:  target,
      shortfall,
      coverage_pct:    coverage,
      status,
      mtd_required:    r?.mtd_required || false,
    });

  } catch (err) {
    console.error('Tax pot error:', err);
    return res.status(500).json({ error: 'Failed to retrieve tax pot status.' });
  }
});


// ── GET /tax/self-assessment ──────────────────────────────────────────────────
// Self Assessment tracker data — deadline, days remaining, estimated bill

router.get('/self-assessment', async (req, res) => {
  try {
    const taxYear   = req.query.tax_year || '2026/27';
    const deadline  = new Date('2027-01-31');
    const today     = new Date();
    const daysLeft  = Math.ceil((deadline - today) / (1000 * 60 * 60 * 24));
    const taxYearStart = new Date('2026-04-06');
    const taxYearDays  = 365;
    const daysPassed   = Math.ceil((today - taxYearStart) / (1000 * 60 * 60 * 24));
    const yearPct      = Math.min(100, Math.round((daysPassed / taxYearDays) * 100));

    // Get current tax liability
    const liabilityResult = await query(
      `SELECT total_tax_liability, it_total, ni_total FROM tax_calculations
       WHERE user_id = $1 AND tax_year = $2`,
      [req.user.userId, taxYear]
    );

    // Get total expenses
    const expenseResult = await query(
      `SELECT COALESCE(SUM(deduct_amount), 0) AS total_deductions
       FROM expense_records
       WHERE user_id = $1 AND tax_year = $2 AND confirmed = true`,
      [req.user.userId, taxYear]
    );

    // Get gross income — dynamic tax year start (auto-rolls over each 6 April)
    const _now = new Date();
    const _fyYear = (_now.getMonth() > 3 || (_now.getMonth() === 3 && _now.getDate() >= 6))
      ? _now.getFullYear() : _now.getFullYear() - 1;
    const _fyStart = `${_fyYear}-04-06`;
    const incomeResult = await query(
      `SELECT COALESCE(SUM(amount), 0) AS gross_income
       FROM transactions
       WHERE user_id = $1
         AND transaction_date >= $2
         AND amount > 0
         AND is_income = true
         AND user_confirmed = true`,
      [req.user.userId, _fyStart]
    );

    const estimatedTax  = parseFloat(liabilityResult.rows[0]?.total_tax_liability) || 0;
    const totalDeductions = parseFloat(expenseResult.rows[0]?.total_deductions) || 0;
    const grossIncome   = parseFloat(incomeResult.rows[0]?.gross_income) || 0;
    const taxableProfit = Math.max(0, grossIncome - totalDeductions);

    // RAG status
    const ragStatus = daysLeft > 180 ? 'GREEN' : daysLeft > 60 ? 'AMBER' : 'RED';

    return res.json({
      deadline:         '31 Jan 2027',
      days_remaining:   daysLeft,
      rag_status:       ragStatus,
      tax_year:         taxYear,
      tax_year_pct:     yearPct,
      gross_income:     grossIncome,
      total_deductions: totalDeductions,
      taxable_profit:   taxableProfit,
      estimated_tax:    estimatedTax,
      key_dates: [
        { label: 'Tax year ends',          date: '5 Apr 2027',  type: 'year_end' },
        { label: 'Paper return deadline',  date: '31 Oct 2026', type: 'paper'    },
        { label: 'Online return deadline', date: '31 Jan 2027', type: 'online'   },
        { label: 'Payment on account 1',  date: '31 Jan 2027', type: 'payment'  },
        { label: 'Payment on account 2',  date: '31 Jul 2027', type: 'payment'  },
      ],
    });

  } catch (err) {
    console.error('Self assessment error:', err);
    return res.status(500).json({ error: 'Failed to get self assessment data.' });
  }
});


// ── Update tax code ─────────────────────────────────────────────────────────
router.put('/tax-code', async (req, res) => {
  try {
    const userId   = req.user.id;
    const { tax_code } = req.body;

    if (!tax_code || typeof tax_code !== 'string') {
      return res.status(400).json({ error: 'tax_code is required' });
    }

    const cleaned = tax_code.toUpperCase().trim();

    // Basic validation — must be NT, BR, D0, D1, K followed by digits, or numeric+letter
    const validPattern = /^[SC]?\d{1,4}[A-Z]{1,2}$|^(NT|BR|D[01])$|^[SC]?K\d{1,4}$/;
    if (!validPattern.test(cleaned)) {
      return res.status(400).json({ error: 'Invalid tax code format' });
    }

    await query(
      `UPDATE users SET tax_code = $1, tax_code_updated_at = NOW() WHERE id = $2`,
      [cleaned, userId]
    );

    res.json({ success: true, tax_code: cleaned });
  } catch (err) {
    console.error('Tax code update error:', err);
    res.status(500).json({ error: 'Failed to update tax code' });
  }
});

module.exports = router;
