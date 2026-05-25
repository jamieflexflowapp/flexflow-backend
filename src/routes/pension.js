'use strict';

const express = require('express');
const router  = express.Router();
const { query } = require('../config/database');
const { calculateTaxLiability } = require('../engines/tax');

router.get('/preferences', async (req, res) => {
  try {
    const userId = req.user && req.user.id;
    if (!userId) return res.status(401).json({ error: 'Unauthenticated' });

    const result = await query(
      `SELECT
         COALESCE(receives_pension, false)                        AS receives_pension,
         COALESCE(annual_personal_pension_net, 0)                 AS annual_personal_pension_net,
         COALESCE(annual_employer_pension_contribution, 0)        AS annual_employer_pension_contribution,
         COALESCE(mpaa_triggered, false)                          AS mpaa_triggered,
         mpaa_trigger_date,
         COALESCE(pension_contribution_frequency, 'annual')       AS pension_contribution_frequency,
         income_structure,
         is_ltd_director
       FROM users WHERE id = $1`,
      [userId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    const row = result.rows[0];
    return res.json({
      receives_pension:                     Boolean(row.receives_pension),
      annual_personal_pension_net:          parseFloat(row.annual_personal_pension_net),
      annual_employer_pension_contribution: parseFloat(row.annual_employer_pension_contribution),
      mpaa_triggered:                       Boolean(row.mpaa_triggered),
      mpaa_trigger_date:                    row.mpaa_trigger_date,
      pension_contribution_frequency:       row.pension_contribution_frequency,
      income_structure:                     row.income_structure,
      is_ltd_director:                      Boolean(row.is_ltd_director),
    });
  } catch (err) {
    console.error('GET /pension/preferences failed:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

router.post('/preferences', async (req, res) => {
  try {
    const userId = req.user && req.user.id;
    if (!userId) return res.status(401).json({ error: 'Unauthenticated' });

    const {
      receives_pension,
      annual_personal_pension_net,
      annual_employer_pension_contribution,
      mpaa_triggered,
      mpaa_trigger_date,
      pension_contribution_frequency,
    } = req.body || {};

    const errors = [];

    const personalNet = Number(annual_personal_pension_net);
    if (annual_personal_pension_net !== undefined && (Number.isNaN(personalNet) || personalNet < 0)) {
      errors.push('annual_personal_pension_net must be a non-negative number');
    }

    const employerGross = Number(annual_employer_pension_contribution);
    if (annual_employer_pension_contribution !== undefined && (Number.isNaN(employerGross) || employerGross < 0)) {
      errors.push('annual_employer_pension_contribution must be a non-negative number');
    }

    if (pension_contribution_frequency !== undefined
        && !['monthly', 'quarterly', 'annual'].includes(pension_contribution_frequency)) {
      errors.push('pension_contribution_frequency must be one of: monthly, quarterly, annual');
    }

    if (receives_pension !== undefined && typeof receives_pension !== 'boolean') {
      errors.push('receives_pension must be a boolean');
    }

    if (mpaa_triggered !== undefined && typeof mpaa_triggered !== 'boolean') {
      errors.push('mpaa_triggered must be a boolean');
    }

    if (personalNet > 1000000) errors.push('annual_personal_pension_net exceeds upper bound');
    if (employerGross > 1000000) errors.push('annual_employer_pension_contribution exceeds upper bound');

    if (errors.length > 0) {
      return res.status(400).json({ error: 'Validation failed', details: errors });
    }

    await query(
      `UPDATE users SET
         receives_pension                     = COALESCE($1, receives_pension),
         annual_personal_pension_net          = COALESCE($2, annual_personal_pension_net),
         annual_employer_pension_contribution = COALESCE($3, annual_employer_pension_contribution),
         mpaa_triggered                       = COALESCE($4, mpaa_triggered),
         mpaa_trigger_date                    = COALESCE($5, mpaa_trigger_date),
         pension_contribution_frequency       = COALESCE($6, pension_contribution_frequency),
         updated_at                           = NOW()
       WHERE id = $7`,
      [
        receives_pension                     === undefined ? null : receives_pension,
        annual_personal_pension_net          === undefined ? null : personalNet,
        annual_employer_pension_contribution === undefined ? null : employerGross,
        mpaa_triggered                       === undefined ? null : mpaa_triggered,
        mpaa_trigger_date                    === undefined ? null : mpaa_trigger_date,
        pension_contribution_frequency       === undefined ? null : pension_contribution_frequency,
        userId,
      ]
    );

    return res.json({ success: true, message: 'Pension preferences updated' });
  } catch (err) {
    console.error('POST /pension/preferences failed:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

router.get('/calculation', async (req, res) => {
  try {
    const userId = req.user && req.user.id;
    if (!userId) return res.status(401).json({ error: 'Unauthenticated' });

    const taxYear = req.query.tax_year || '2026/27';
    const result  = await calculateTaxLiability(userId, taxYear);

    return res.json({
      tax_year:        result.tax_year,
      pension:         result.pension,
      total_liability: result.total_liability,
      monthly_tax_pot: result.monthly_tax_pot,
      disclosures:     (result.disclosures || []).filter(d => d.type.startsWith('PENSION_')),
    });
  } catch (err) {
    console.error('GET /pension/calculation failed:', err);
    return res.status(500).json({ error: 'Internal server error', detail: err.message });
  }
});

module.exports = router;
