'use strict';
const express = require('express');
const router  = express.Router();
const { query } = require('../config/database');
const { verifyToken } = require('../middleware/auth');

router.use(verifyToken);

router.get('/summary', async (req, res) => {
  try {
    const userId = req.user.userId;
    const r = await query(
      `SELECT receives_pension, pension_contribution_frequency,
              annual_personal_pension_net, annual_employer_pension_contribution,
              mpaa_triggered, mpaa_trigger_date, is_scottish_taxpayer
       FROM users WHERE id = $1`,
      [userId]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'User not found' });
    const u = r.rows[0];

    const now = new Date();
    const fyStart = new Date(now.getMonth() >= 3 ? now.getFullYear() : now.getFullYear() - 1, 3, 6);
    const monthsElapsed = Math.max(1, Math.floor((now - fyStart) / (1000*60*60*24*30.44)) + 1);

    const annual_personal = parseFloat(u.annual_personal_pension_net || 0);
    const annual_employer = parseFloat(u.annual_employer_pension_contribution || 0);
    const freq = u.pension_contribution_frequency || 'monthly';
    const mult = freq === 'monthly' ? monthsElapsed : freq === 'quarterly' ? Math.floor(monthsElapsed/3) : monthsElapsed/12;
    const personal_monthly = annual_personal / 12;
    const employer_monthly = annual_employer / 12;
    const saved_this_fy = u.receives_pension
      ? Math.round((personal_monthly + employer_monthly) * mult * 100) / 100
      : 0;

    const annual_allowance = u.mpaa_triggered ? 10000 : 60000;
    const relief_rate = u.is_scottish_taxpayer ? 0.19 : 0.20;
    const relief_amount = Math.round(annual_personal * relief_rate * 100) / 100;

    res.json({
      receives_pension:                    !!u.receives_pension,
      pension_status:                      u.receives_pension ? 'yes' : 'no',
      pension_frequency:                   freq,
      personal_pension_amount:             personal_monthly,
      employer_pension_amount:             employer_monthly,
      annual_personal_pension_net:         annual_personal,
      annual_employer_pension_contribution: annual_employer,
      mpaa_triggered:                      !!u.mpaa_triggered,
      mpaa_trigger_date:                   u.mpaa_trigger_date || null,
      annual_allowance,
      saved_this_fy,
      relief_rate,
      relief_amount,
      months_elapsed: monthsElapsed,
    });
  } catch (err) {
    console.error('[PENSION]', err.message);
    res.status(500).json({ error: 'Failed to load pension summary' });
  }
});

router.post('/update', async (req, res) => {
  try {
    const userId = req.user.userId;
    const {
      pension_status, pension_frequency,
      annual_personal_pension_net, annual_employer_pension_contribution,
      mpaa_triggered, mpaa_trigger_date,
    } = req.body;

    const updates = []; const values = []; let i = 1;
    const add = (col, val) => { if (val !== undefined) { updates.push(`${col} = $${i++}`); values.push(val); } };

    add('receives_pension',                    pension_status === 'yes' ? true : pension_status === 'no' ? false : undefined);
    add('pension_contribution_frequency',       pension_frequency);
    add('annual_personal_pension_net',          annual_personal_pension_net);
    add('annual_employer_pension_contribution', annual_employer_pension_contribution);
    add('mpaa_triggered',                       mpaa_triggered);
    add('mpaa_trigger_date',                    mpaa_trigger_date || null);

    if (!updates.length) return res.status(400).json({ error: 'No fields provided' });
    updates.push(`updated_at = NOW()`); values.push(userId);
    await query(`UPDATE users SET ${updates.join(', ')} WHERE id = $${i}`, values);
    res.json({ success: true });
  } catch (err) {
    console.error('[PENSION update]', err.message);
    res.status(500).json({ error: 'Failed to update pension' });
  }
});

module.exports = router;
