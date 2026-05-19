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

    const cached = await query(
      `SELECT * FROM tax_calculations
       WHERE user_id = $1 AND tax_year = $2`,
      [req.user.userId, taxYear]
    );

    if (cached.rows.length === 0) {
      // Never calculated — run now
      const result = await calculateTaxLiability(req.user.userId, taxYear);
      return res.json(result);
    }

    const r = cached.rows[0];
    return res.json({
      tax_year:         r.tax_year,
      is_scottish:      r.is_scottish,
      gross_paye:       parseFloat(r.gross_paye_income)        || 0,
      gross_se:         parseFloat(r.gross_se_income)          || 0,
      gross_dividends:  parseFloat(r.gross_dividend_income)    || 0,
      gross_rental:     parseFloat(r.gross_rental_income)      || 0,
      partner_share:    parseFloat(r.gross_partnership_income) || 0,
      effective_pa:     parseFloat(r.effective_pa)             || 0,
      pa_tapered:       r.pa_tapered,
      it_total:         parseFloat(r.it_total)                 || 0,
      ni_class2:        parseFloat(r.ni_class2)                || 0,
      ni_class4:        parseFloat(r.ni_class4_main)           || 0,
      ni_total:         parseFloat(r.ni_total)                 || 0,
      s24_credit:       parseFloat(r.section24_credit)         || 0,
      total_liability:  parseFloat(r.total_tax_liability)      || 0,
      monthly_tax_pot:  parseFloat(r.monthly_tax_pot_contrib)  || 0,
      mtd_required:     r.mtd_required,
      calculated_at:    r.calculated_at,
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

module.exports = router;
