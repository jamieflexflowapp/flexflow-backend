'use strict';

/**
 * FlexFlow — Onboarding Routes
 * Session B — Task 3
 *
 * Handles the Q1 onboarding routing logic (Budgeting Engine v5.3)
 * Sets all income flags on the users table.
 * Sets onboarding_complete = true when profile is complete.
 *
 * POST /onboarding/profile   — save income structure answers
 * GET  /onboarding/status    — get current onboarding step
 * POST /onboarding/complete  — mark onboarding as done (final step)
 */

const express  = require('express');
const router   = express.Router();
const { verifyToken } = require('../middleware/auth');
const { query } = require('../config/database');

// All onboarding routes require a valid token (but NOT onboarding_complete)
router.use(verifyToken);

// ── GET /onboarding/status ────────────────────────────────────────────────────

router.get('/status', async (req, res) => {
  try {
    const result = await query(
      `SELECT onboarding_complete, onboarding_step, income_structure,
              is_scottish_taxpayer, receives_paye, receives_se,
              receives_rental_income, receives_partnership, is_ltd_director,
              is_cis_worker, is_vat_registered
       FROM users WHERE id = $1`,
      [req.user.userId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'User not found.' });
    }

    return res.status(200).json(result.rows[0]);
  } catch (err) {
    console.error('Onboarding status error:', err);
    return res.status(500).json({ error: 'Failed to get onboarding status.' });
  }
});

// ── POST /onboarding/profile ──────────────────────────────────────────────────
// Saves Q1 answers and sets all income flags.
// Based on Budgeting Engine v5.3 onboarding routing logic.

router.post('/profile', async (req, res) => {
  try {
    const {
      // Q1 primary income type
      income_structure,         // 'S1'|'S2'|'S3a'|'S3b'|'S3c'|'S3d'|'S10'|'S12a'
      disclaimer_accepted,     // boolean — user accepted FCA disclaimer
      disclaimer_version,      // string — version of disclaimer accepted e.g. '1.0'

      // Income flags
      receives_paye,
      receives_se,
      receives_rental_income,
      receives_partnership,
      is_ltd_director,
      is_cis_worker,
      is_vat_registered,
      vat_number,
      utr_number,

      // Scottish taxpayer — detected from postcode
      is_scottish_taxpayer,
      postcode,

      // Personal details
      full_name,
      date_of_birth,            // Required for SPA calculation (Build Note 5)
      address_line_1,
      city,

      // Partnership specific
      partnership_profit_share_pct,
      partnership_utr,

      // Step tracking
      onboarding_step,

      // Additional fields referenced below but missing from destructuring
      tax_code,
      director_salary_annual,
      dividend_frequency,
      trading_duration,
    } = req.body;

    // Map frontend labels → internal S-codes (Phase 4.5 fix)
    const STRUCTURE_MAP = {
      sole_trader:   'S1',
      ltd_director:  'S2',
      partnership:   'S13',
      mixed:         'S3a',
    };
    const mappedStructure = income_structure
      ? (STRUCTURE_MAP[income_structure] || income_structure)
      : income_structure;

    // Validate income_structure if provided
    const validStructures = ['S1','S2','S3a','S3b','S3c','S3d','S10','S12a'];
    if (mappedStructure && !validStructures.includes(mappedStructure)) {
      return res.status(400).json({ error: 'Invalid income structure.' });
    }
    // Use mapped value going forward
    if (income_structure) Object.assign(req.body, { income_structure: mappedStructure });

    // Scottish taxpayer auto-detection from postcode
    // Scottish postcode prefixes: AB DD DG EH FK G HS IV KA KW KY ML PA PH TD ZE
    let scottish = is_scottish_taxpayer;
    if (postcode && scottish === undefined) {
      const prefix = postcode.trim().toUpperCase().replace(/[0-9].*/, '');
      const scottishPrefixes = ['AB','DD','DG','EH','FK','G','HS','IV','KA','KW','KY','ML','PA','PH','TD','ZE'];
      scottish = scottishPrefixes.some(p => prefix === p || prefix.startsWith(p));
    }

    // Build update object — only update fields that were provided
    const updates = [];
    const values  = [];
    let   i       = 1;

    const addField = (col, val) => {
      if (val !== undefined && val !== null) {
        updates.push(`${col} = $${i++}`);
        values.push(val);
      }
    };

    addField('income_structure',          mappedStructure || income_structure);
    if (tax_code) {
      addField('tax_code',              tax_code.toUpperCase().trim());
      addField('tax_code_updated_at',   new Date().toISOString());
    }
    if (director_salary_annual !== undefined) {
      addField('director_salary_annual', director_salary_annual != null ? parseFloat(director_salary_annual) : 12570);
    }
    if (dividend_frequency) {
      addField('dividend_frequency',     dividend_frequency);
      addField('dividend_frequency_updated_at', new Date().toISOString());
    }
    if (disclaimer_accepted) {
      addField('disclaimer_accepted',      true);
      addField('disclaimer_accepted_at',   new Date().toISOString());
      addField('disclaimer_version',       disclaimer_version || '1.0');
    }
    addField('receives_paye',             receives_paye);
    addField('receives_se',               receives_se);
    addField('receives_rental_income',    receives_rental_income);
    addField('receives_partnership',      receives_partnership);
    addField('is_ltd_director',           is_ltd_director);
    addField('is_cis_worker',             is_cis_worker);
    addField('is_vat_registered',         is_vat_registered);
    addField('vat_number',                vat_number);
    addField('utr_number',                utr_number);
    addField('is_scottish_taxpayer',      scottish);
    addField('full_name',                 full_name);
    addField('date_of_birth',             date_of_birth);
    addField('address_line_1',            address_line_1);
    addField('postcode',                  postcode);
    addField('city',                      city);
    addField('onboarding_step',           onboarding_step);
    addField('trading_duration',          trading_duration);

    if (updates.length === 0) {
      return res.status(400).json({ error: 'No profile fields provided.' });
    }

    updates.push(`updated_at = NOW()`);
    values.push(req.user.userId);

    await query(
      `UPDATE users SET ${updates.join(', ')} WHERE id = $${i}`,
      values
    );

    // Get updated profile to return
    const updated = await query(
      `SELECT onboarding_complete, onboarding_step, income_structure,
              is_scottish_taxpayer, receives_paye, receives_se,
              receives_rental_income, receives_partnership, is_ltd_director,
              is_cis_worker, is_vat_registered, full_name
       FROM users WHERE id = $1`,
      [req.user.userId]
    );

    return res.status(200).json({
      message: 'Profile updated.',
      profile: updated.rows[0],
    });

  } catch (err) {
    console.error('Onboarding profile error:', err);
    return res.status(500).json({ error: 'Failed to save profile.' });
  }
});

// ── POST /onboarding/complete ─────────────────────────────────────────────────
// Final step — validates the profile is complete enough to proceed,
// then sets onboarding_complete = true, unlocking the dashboard.

router.post('/complete', async (req, res) => {
  try {
    // Fetch current profile
    const result = await query(
      `SELECT income_structure, date_of_birth, full_name
       FROM users WHERE id = $1`,
      [req.user.userId]
    );

    const user = result.rows[0];

    // Minimum requirements to complete onboarding
    const errors = [];
    if (!user.income_structure) errors.push('Income structure is required.');
    if (!user.full_name)        errors.push('Full name is required.');

    if (errors.length > 0) {
      return res.status(400).json({
        error: 'Please complete your profile before continuing.',
        details: errors,
      });
    }

    // Set onboarding complete — unlocks the dashboard
    await query(
      `UPDATE users
       SET onboarding_complete = true, onboarding_step = 99, updated_at = NOW()
       WHERE id = $1`,
      [req.user.userId]
    );

    // Insert 2FA nudge notification
    await query(
      `INSERT INTO notifications (user_id, alert_type, title, message, is_dismissed)
       VALUES ($1, '2fa_nudge', 'Secure your account', 'Enable two-factor authentication to protect your financial data.', false)
       ON CONFLICT DO NOTHING`,
      [req.user.userId]
    ).catch(() => {}); // Non-fatal

    return res.status(200).json({
      message: 'Onboarding complete. Welcome to FlexFlow.',
      onboarding_complete: true,
    });

  } catch (err) {
    console.error('Onboarding complete error:', err);
    return res.status(500).json({ error: 'Failed to complete onboarding.' });
  }
});

module.exports = router;
