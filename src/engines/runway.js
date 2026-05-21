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
       COALESCE(SUM(CASE WHEN is_tax_account = false THEN tax_pot_balance ELSE 0 END), 0) as other_balance,
       COALESCE(SUM(CASE WHEN is_tax_account = true  THEN tax_pot_balance ELSE 0 END), 0) as tax_pot_balance,
       COUNT(*) as account_count
     FROM bank_connections
     WHERE user_id = $1 AND is_active = true`,
    [userId]
  );

  // Get actual bank balance from most recent transactions
  const balanceResult = await query(
    `SELECT COALESCE(SUM(amount), 0) as net_balance
     FROM transactions
     WHERE user_id = $1
       AND bank_connection_id IN (
         SELECT id FROM bank_connections
         WHERE user_id = $1 AND is_active = true AND is_tax_account = false
       )`,
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
    `SELECT COALESCE(SUM(monthly_equiv), 0) as tier1_monthly
     FROM committed_outgoings
     WHERE user_id = $1 AND is_tier1 = true AND is_active = true`,
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
    `SELECT tax_pot_target FROM users WHERE id = $1`,
    [userId]
  );
  const taxPotTarget  = parseFloat(tpveResult.rows[0]?.tax_pot_target) || 0;
  const taxPotCoverage = taxPotTarget > 0
    ? Math.round((taxPotBalance / taxPotTarget) * 100)
    : 100;

  let tpveStatus;
  if (taxPotTarget === 0)         tpveStatus = 'TPVE_UNKNOWN';
  else if (taxPotCoverage >= 100) tpveStatus = 'TPVE_GOOD';
  else if (taxPotCoverage >= 80)  tpveStatus = 'TPVE_AMBER';
  else                            tpveStatus = 'TPVE_RED';

  const taxPotShortfall = Math.max(0, Math.round((taxPotTarget - taxPotBalance) * 100) / 100);

  // Step 6: Save snapshot
  await saveRunwaySnapshot(userId, {
    bankBalance, taxPotBalance, availableBalance,
    tier1Monthly, runwayWeeks, runwayStatus,
  });

  // Step 7: Update TPVE in tax_verification table
  await updateTPVE(userId, tpveStatus, taxPotBalance, taxPotTarget, taxPotShortfall, taxPotCoverage);

  // Step 8: Fire alerts if needed
  await fireRunwayAlerts(userId, runwayStatus, tpveStatus, runwayWeeks, taxPotShortfall);

  // FCA-compliant response — factual only, no directive language
  return {
    // Available balance (tax pot excluded — Build Note 8)
    bank_balance:        Math.round(bankBalance * 100) / 100,
    tax_pot_balance:     Math.round(taxPotBalance * 100) / 100,
    available_balance:   availableBalance,

    // Runway
    tier1_monthly:       Math.round(tier1Monthly * 100) / 100,
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

  // Runway alerts
  if (runwayStatus === 'RED') {
    alerts.push({
      type:     'RUNWAY_RED',
      severity: 'RED',
      title:    'Low runway',
      body:     `Your available balance covers approximately ${runwayWeeks.toFixed(1)} weeks of committed outgoings.`,
      dedup:    `RUNWAY_RED_${new Date().toISOString().split('T')[0]}`,
    });
  } else if (runwayStatus === 'AMBER') {
    alerts.push({
      type:     'RUNWAY_AMBER',
      severity: 'AMBER',
      title:    'Runway below committed outgoings',
      body:     `Your estimated monthly income is below your committed outgoings. Available balance covers approximately ${runwayWeeks.toFixed(1)} weeks.`,
      dedup:    `RUNWAY_AMBER_${new Date().toISOString().split('T')[0]}`,
    });
  }

  // TPVE alerts
  if (tpveStatus === 'TPVE_RED') {
    alerts.push({
      type:     'TPVE_RED',
      severity: 'RED',
      title:    'Tax pot below target',
      body:     `Your tax pot is £${shortfall.toFixed(2)} below your estimated tax liability.`,
      dedup:    `TPVE_RED_${new Date().toISOString().split('T')[0]}`,
    });
  } else if (tpveStatus === 'TPVE_AMBER') {
    alerts.push({
      type:     'TPVE_AMBER',
      severity: 'AMBER',
      title:    'Tax pot approaching target',
      body:     `Your tax pot is £${shortfall.toFixed(2)} below your current tax liability estimate.`,
      dedup:    `TPVE_AMBER_${new Date().toISOString().split('T')[0]}`,
    });
  } else if (tpveStatus === 'TPVE_GOOD') {
    alerts.push({
      type:     'TPVE_GOOD',
      severity: 'INFO',
      title:    'Tax pot on track',
      body:     'Your tax pot covers your current estimated tax liability.',
      dedup:    `TPVE_GOOD_${getCurrentTaxYear()}`, // Once per tax year
    });
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

function getCurrentTaxYear() {
  const now   = new Date();
  const month = now.getMonth() + 1;
  const day   = now.getDate();
  const year  = now.getFullYear();
  const isNew = (month > 4) || (month === 4 && day >= 6);
  const start = isNew ? year : year - 1;
  return `${start}/${String(start + 1).slice(-2)}`;
}

module.exports = { calculateRunway };
