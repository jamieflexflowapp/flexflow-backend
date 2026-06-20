'use strict';

/**
 * FlexFlow — Runway Calculator Engine
 * Session H — Task 7
 *
 * Answers the question every freelancer thinks about:
 * "If no more money comes in today, how long until I run out?"
 *
 * CRITICAL RULES (from spec + build notes):
 *
 * Build Note 8: available_balance = bank_balance − tax_pot_balance
 *   Tax pot is ALWAYS excluded. It is not spendable money.
 *   This applies everywhere: runway, forecasting, reports.
 *
 * Build Note 3: Runway denominator = Tier 1 committed outgoings ONLY
 *   NOT total projected_expenses. NAE v1.1 Part 3 is authoritative.
 *   GREEN = 12+ weeks of runway
 *   AMBER = 8-11 weeks of runway
 *   RED   = under 8 weeks of runway
 *
 * Formula:
 *   available_balance = bank_balance − tax_pot_balance
 *   runway_weeks = available_balance ÷ (tier1_monthly ÷ 4.33)
 *
 * Sources: ISE v1.5, TPVE v1.2, NAE v1.1, Phase 3 Plan v3.2
 */

const { query } = require('../config/database');

// ══════════════════════════════════════════════════════════════════════════════
// MAIN: calculateRunway
// ══════════════════════════════════════════════════════════════════════════════

async function calculateRunway(userId) {
  // Step 1: Get total bank balance across all connected accounts
  const bankResult = await query(
    `SELECT
       COALESCE(SUM(bc.current_balance), 0) as tax_pot_balance
     FROM bank_connections bc
     JOIN account_designations ad ON ad.bank_account_id = bc.account_id AND ad.user_id = $1
     WHERE bc.user_id = $1 AND bc.is_active = true AND ad.designation_type = 'tax'`,
    [userId]
  );

  // Get spending account balance from designated accounts
  const balanceResult = await query(
    `SELECT COALESCE(SUM(bc.current_balance), 0) as net_balance
     FROM bank_connections bc
     JOIN account_designations ad ON ad.bank_account_id = bc.account_id AND ad.user_id = $1
     WHERE bc.user_id = $1 AND bc.is_active = true AND ad.designation_type = 'spending'`,
    [userId]
  );

  const taxPotBalance  = parseFloat(bankResult.rows[0]?.tax_pot_balance) || 0;
  const bankBalance    = parseFloat(balanceResult.rows[0]?.net_balance)  || 0;

  // Build Note 8: available_balance = bank_balance − tax_pot_balance
  // Tax pot is ALWAYS excluded — it is not spendable money
  const availableBalance = Math.max(0, Math.round((bankBalance - taxPotBalance) * 100) / 100);

  // Step 2: Get Tier 1 committed outgoings total (monthly)
  // Build Note 3: denominator is Tier 1 ONLY — not all projected expenses
  const tier1Result = await query(
    `SELECT COALESCE(SUM(amount), 0) as tier1_monthly
     FROM committed_bills
     WHERE user_id = $1 AND is_active = true`,
    [userId]
  );
  const tier1Monthly = parseFloat(tier1Result.rows[0]?.tier1_monthly) || 0;

  // Step 3: Calculate runway in weeks
  // Formula: available_balance ÷ (Tier 1 monthly ÷ 4.33)
  let runwayWeeks = 0;
  if (tier1Monthly > 0) {
    const weeklyBurn    = Math.round((tier1Monthly / 4.33) * 100) / 100;  // 2dp to match display
    runwayWeeks         = availableBalance / weeklyBurn;  // full precision from 2dp weekly
  }

  // Step 4: Danger status — based on weeks of runway
  // Updated thresholds (Build Note 3 v1.2):
  // GREEN = 12+ weeks  — comfortable, over 3 months of buffer
  // AMBER = 8-11 weeks — getting tight, under 3 months
  // RED   = under 8 weeks — critical, less than 2 months

  let runwayStatus;
  if (tier1Monthly === 0) {
    runwayStatus = 'UNKNOWN'; // No Tier 1 data yet
  } else if (runwayWeeks >= 12) {
    runwayStatus = 'GREEN';
  } else if (runwayWeeks >= 8) {
    runwayStatus = 'AMBER';
  } else {
    runwayStatus = 'RED';
  }

  // Step 5: TPVE — Tax pot verification
  const tpveResult = await query(
    `SELECT total_tax_liability FROM tax_calculations WHERE user_id = $1 ORDER BY calculated_at DESC LIMIT 1`,
    [userId]
  );
  const taxPotTarget  = parseFloat(tpveResult.rows[0]?.total_tax_liability) || 0;
  const taxPotCoverage = taxPotTarget > 0
    ? Math.round((taxPotBalance / taxPotTarget) * 100)
    : 100;

  let tpveStatus;
  if (taxPotTarget === 0)         tpveStatus = 'TPVE_UNKNOWN';
  else if (taxPotBalance >= taxPotTarget) tpveStatus = 'TPVE_GOOD';
  else                            tpveStatus = 'TPVE_RED';

  const taxPotShortfall = Math.max(0, Math.round((taxPotTarget - taxPotBalance) * 100) / 100);

  // Step 6: Save snapshot
  await saveRunwaySnapshot(userId, {
    bankBalance, taxPotBalance, availableBalance,
    tier1Monthly, runwayWeeks, runwayStatus,
  });

  // Step 7: Update TPVE in tax_verification table
  await updateTPVE(userId, tpveStatus, taxPotBalance, taxPotTarget, taxPotShortfall, taxPotCoverage);

  // Step 8: Fire alerts if needed (non-fatal)
  try { await fireRunwayAlerts(userId, runwayStatus, tpveStatus, runwayWeeks, taxPotShortfall); } catch (e) { console.warn('[RUNWAY] Alert firing skipped:', e.message); }

  // FCA-compliant response — factual only, no directive language
  const incomeRow = await query(`SELECT personal_income FROM users WHERE id = $1`, [userId]);
  const personalIncome = parseFloat(incomeRow.rows[0]?.personal_income) || 0;
  return {
    // Available balance (tax pot excluded — Build Note 8)
    bank_balance:        Math.round(bankBalance * 100) / 100,
    tax_pot_balance:     Math.round(taxPotBalance * 100) / 100,
    available_balance:   availableBalance,

    // Runway
    tier1_monthly:       Math.round(tier1Monthly * 100) / 100,
    weeklyOutgoings:     Math.round((tier1Monthly / 4.33) * 100) / 100,
    runway_weeks:        runwayWeeks,
    runway_status:       runwayStatus,

    // Personal income vs Tier 1
    personal_income:     Math.round(personalIncome * 100) / 100,
    income_vs_tier1_pct: tier1Monthly > 0
      ? Math.round((personalIncome / tier1Monthly) * 100)
      : null,

    // TPVE
    tax_pot_target:      Math.round(taxPotTarget * 100) / 100,
    tax_pot_coverage_pct: taxPotCoverage,
    tax_pot_shortfall:   taxPotShortfall,
    tpve_status:         tpveStatus,

    calculated_at:       new Date().toISOString(),

    // FCA disclosure
    disclosure: 'Runway estimate based on your connected bank data and declared committed outgoings. This is an estimate only.',
  };
}

// ── Save daily runway snapshot ────────────────────────────────────────────────

async function saveRunwaySnapshot(userId, data) {
  const today = new Date().toISOString().split('T')[0];
  await query(`
    INSERT INTO runway_snapshots
      (user_id, snapshot_date, bank_balance, tax_pot_balance,
       available_balance, tier1_monthly, runway_weeks, runway_status)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
    ON CONFLICT (user_id, snapshot_date) DO UPDATE SET
      bank_balance      = EXCLUDED.bank_balance,
      tax_pot_balance   = EXCLUDED.tax_pot_balance,
      available_balance = EXCLUDED.available_balance,
      tier1_monthly     = EXCLUDED.tier1_monthly,
      runway_weeks      = EXCLUDED.runway_weeks,
      runway_status     = EXCLUDED.runway_status
  `, [
    userId, today,
    data.bankBalance, data.taxPotBalance, data.availableBalance,
    data.tier1Monthly, data.runwayWeeks, data.runwayStatus,
  ]);
}

// ── Update TPVE status ────────────────────────────────────────────────────────

async function updateTPVE(userId, status, balance, target, shortfall, coverage) {
  const taxYear = getCurrentTaxYear();
  await query(`
    INSERT INTO tax_verification
      (user_id, tax_year, status, current_pot_balance, target_pot_balance,
       shortfall, coverage_pct, verified_at)
    VALUES ($1,$2,$3,$4,$5,$6,$7,NOW())
    ON CONFLICT (user_id, tax_year) DO UPDATE SET
      status               = EXCLUDED.status,
      current_pot_balance  = EXCLUDED.current_pot_balance,
      target_pot_balance   = EXCLUDED.target_pot_balance,
      shortfall            = EXCLUDED.shortfall,
      coverage_pct         = EXCLUDED.coverage_pct,
      verified_at          = NOW(),
      updated_at           = NOW()
  `, [userId, taxYear, status, balance, target, shortfall, coverage]);
}

// ── Fire alerts via NAE ───────────────────────────────────────────────────────
// FCA-compliant copy — factual disclosure only, no directive language

async function fireRunwayAlerts(userId, runwayStatus, tpveStatus, runwayWeeks, shortfall) {
  const alerts = [];

  // Runway alerts — disabled, keeping expenses + income review only

  // TPVE alert — fire if tax pot is below target, clear if good
  if (tpveStatus === 'TPVE_RED' && shortfall > 0) {
    alerts.push({
      type: 'TPVE',
      severity: 'warning',
      title: 'Tax pot below target',
      body: `Your tax pot is £${shortfall.toFixed(2)} below your estimated tax liability. Top it up to avoid a shortfall at self-assessment.`,
      dedup: 'tpve-below-target',
    });
  } else if (tpveStatus === 'TPVE_GOOD' || tpveStatus === 'TPVE_UNKNOWN') {
    await query(
      `DELETE FROM notifications WHERE user_id = $1 AND dedup_key = 'tpve-below-target'`,
      [userId]
    );
  }

  // Insert notifications
  for (const alert of alerts) {
    await query(`
      INSERT INTO notifications
        (user_id, alert_type, severity, title, body, dedup_key,
         valid_until)
      VALUES ($1,$2,$3,$4,$5,$6, NOW() + INTERVAL '24 hours')
      ON CONFLICT (user_id, dedup_key) DO NOTHING
    `, [userId, alert.type, alert.severity, alert.title, alert.body, alert.dedup]);
  }
}

// ── Tax year helper ───────────────────────────────────────────────────────────

const { getCurrentTaxYear } = require('../utils/taxYear');

module.exports = { calculateRunway };
