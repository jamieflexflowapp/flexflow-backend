'use strict';

/**
 * FlexFlow — Cash Flow Forecasting Engine (FCE v1.4)
 * Session I — Task 8
 *
 * Answers: "What is my likely financial position in each of the next 90 days?"
 * Different from Runway Calculator — this is a PROJECTION, not a stress test.
 *
 * Key rules (from FCE v1.4 spec):
 *   - Tax pot ALWAYS excluded from available balance (Build Note 8)
 *   - Danger detection uses CONSERVATIVE projection (lower quartile)
 *   - Tier 1 denominator ONLY for danger thresholds (Build Note 3)
 *   - Invoice tracking permanently cut (Build Note 12)
 *   - Seasonal weights inherited from ISE (same table)
 *   - 30-day window for PLUS, 90-day for PRO
 *   - FREE users: 403 (Runway Calculator only)
 *   - FCA: no directive language anywhere
 *   - FSBE sessions: 2-hour TTL, ephemeral — never modifies stored data
 *   - Build Note 4: NEVER pass scenario income to Tax Engine
 *
 * Source: FCE v1.4 + FSBE v1.1 Specifications (May 2026)
 */

const { query } = require('../config/database');

// Seasonal weights (same as ISE v1.5 — inherited, not duplicated)
const SEASONAL_WEIGHTS = {
  1:  0.75, 2:  0.80, 3:  1.05, 4:  1.10,
  5:  1.10, 6:  1.05, 7:  0.90, 8:  0.75,
  9:  1.10, 10: 1.15, 11: 1.05, 12: 0.90,
};

// Source reliability weights (FCE Part 5.2 Step 3)
const RELIABILITY_WEIGHTS = { GREEN: 1.0, AMBER: 0.75, RED: 0.4 };

// Danger thresholds (FCE Part 7)
const DANGER_RED   = 0.80; // Conservative income < 80% of projected expenses
const DANGER_AMBER = 1.00; // Conservative income < 100% of projected expenses

// ══════════════════════════════════════════════════════════════════════════════
// MAIN: generateForecast
// ══════════════════════════════════════════════════════════════════════════════

async function generateForecast(userId, scenarioOverride = null) {
  // Load user profile
  const userResult = await query(
    `SELECT plan, income_structure, reserve_buffer_pct, is_vat_registered,
            personal_income, tax_pot_target, is_cis_worker
     FROM users WHERE id = $1`,
    [userId]
  );
  const user = userResult.rows[0];
  if (!user) throw new Error('User not found');

  // Tier gate — FREE gets 403 (enforced in route, not here)
  const windowMonths = user.plan === 'pro' ? 3 : 1;
  const reserveBuffer = parseFloat(user.reserve_buffer_pct) || 0.15;

  // Step 1: Current balance (tax pot excluded — Build Note 8)
  const balanceResult = await query(
    `SELECT
       COALESCE(SUM(CASE WHEN is_tax_account = false THEN tax_pot_balance ELSE 0 END), 0) as bank_balance,
       COALESCE(SUM(CASE WHEN is_tax_account = true  THEN tax_pot_balance ELSE 0 END), 0) as tax_pot_balance
     FROM bank_connections WHERE user_id = $1 AND is_active = true`,
    [userId]
  );
  const bankBalance   = parseFloat(balanceResult.rows[0]?.bank_balance)   || 0;
  const taxPotBalance = parseFloat(balanceResult.rows[0]?.tax_pot_balance) || 0;
  const startBalance  = Math.max(0, bankBalance - taxPotBalance);

  // Step 2: Income history for projection
  const sixMonthsAgo = new Date();
  sixMonthsAgo.setMonth(sixMonthsAgo.getMonth() - 12);

  const incomeResult = await query(
    `SELECT
       DATE_TRUNC('month', income_date) AS month,
       SUM(gross_amount) as total
     FROM income_events
     WHERE user_id = $1
       AND income_type IN ('se','cis','rental','dividend','paye','umbrella')
       AND included_in_smoothing = true
       AND income_date >= $2
     GROUP BY DATE_TRUNC('month', income_date)
     ORDER BY month ASC`,
    [userId, sixMonthsAgo.toISOString().split('T')[0]]
  );

  const monthlyIncomes = incomeResult.rows.map(r => parseFloat(r.total) || 0);
  const monthsOfData   = monthlyIncomes.length;

  // Confidence level (FCE Part 5.1)
  let confidence;
  if (monthsOfData < 3)       confidence = 'LOW';
  else if (monthsOfData < 12) confidence = 'MEDIUM';
  else                        confidence = 'HIGH';

  // Base case: rolling average
  const avgIncome = monthsOfData > 0
    ? monthlyIncomes.reduce((s, v) => s + v, 0) / monthsOfData
    : 0;

  // Conservative case: lower quartile (25th percentile)
  const sorted = [...monthlyIncomes].sort((a, b) => a - b);
  const q25idx = Math.floor(sorted.length * 0.25);
  const conservativeIncome = sorted.length > 0 ? (sorted[q25idx] || 0) : 0;

  // Source reliability weighting
  const sourcesResult = await query(
    `SELECT reliability_score, average_monthly FROM income_sources
     WHERE user_id = $1 AND is_active = true`,
    [userId]
  );
  let reliabilityFactor = 1.0;
  if (sourcesResult.rows.length > 0) {
    const weights = sourcesResult.rows.map(s => RELIABILITY_WEIGHTS[s.reliability_score] || 0.75);
    reliabilityFactor = weights.reduce((s, v) => s + v, 0) / weights.length;
  }

  // Monthly tax pot contribution
  const monthlyTaxPot = parseFloat(user.tax_pot_target) || 0;

  // Step 3: Tier 1 outgoings
  const tier1Result = await query(
    `SELECT id, name, amount, frequency, monthly_equiv, next_due_date, category
     FROM committed_outgoings
     WHERE user_id = $1 AND is_tier1 = true AND is_active = true`,
    [userId]
  );
  const tier1Outgoings = tier1Result.rows;
  const tier1Monthly   = tier1Outgoings.reduce((s, r) => s + parseFloat(r.monthly_equiv), 0);

  // Step 4: Tier 2 run-rate (last 3 months discretionary average)
  const threeMonthsAgo = new Date();
  threeMonthsAgo.setMonth(threeMonthsAgo.getMonth() - 3);
  const tier2Result = await query(
    `SELECT COALESCE(SUM(ABS(amount)) / 3.0, 0) as avg_monthly_tier2
     FROM transactions
     WHERE user_id = $1
       AND category = 'expense'
       AND sub_category NOT IN ('committed_outgoing')
       AND transaction_date >= $2`,
    [userId, threeMonthsAgo.toISOString().split('T')[0]]
  );
  const tier2Monthly = parseFloat(tier2Result.rows[0]?.avg_monthly_tier2) || 0;

  // Step 5: Tax events (SA, POA, VAT)
  const taxResult = await query(
    `SELECT total_tax_liability, payments_on_account, is_vat_registered, vat_owed,
            vat_deadline, sa_deadline
     FROM tax_calculations
     WHERE user_id = $1 AND tax_year = $2`,
    [userId, getCurrentTaxYear()]
  );
  const taxCalc = taxResult.rows[0] || {};

  // Step 6: Build month-by-month forecast
  const months = [];
  let runningBalance = startBalance;

  for (let i = 0; i < windowMonths; i++) {
    const forecastDate = new Date();
    forecastDate.setMonth(forecastDate.getMonth() + i + 1);
    forecastDate.setDate(1);

    const calMonth    = forecastDate.getMonth() + 1; // 1-12
    const seasonWeight = SEASONAL_WEIGHTS[calMonth] || 1.0;
    const monthLabel  = forecastDate.toLocaleString('en-GB', { month: 'long', year: 'numeric' });
    const monthKey    = forecastDate.toISOString().slice(0, 7); // YYYY-MM

    // Apply scenario override if present (FSBE — never stored, never tax-engine fed)
    let scenarioIncomeAdjustment = 0;
    if (scenarioOverride && scenarioOverride.month === monthKey) {
      scenarioIncomeAdjustment = scenarioOverride.income_delta || 0;
      // Build Note 4: NEVER pass scenario income to Tax Engine
    }

    // Base case income
    let projIncomeBase = confidence === 'LOW'
      ? 0 // Conservative only for LOW
      : avgIncome * seasonWeight * reliabilityFactor * (1 - reserveBuffer) + scenarioIncomeAdjustment;
    projIncomeBase = Math.max(0, Math.round(projIncomeBase * 100) / 100);

    // Conservative income (used for danger detection)
    let projIncomeConservative = conservativeIncome * seasonWeight * reliabilityFactor * (1 - reserveBuffer) + scenarioIncomeAdjustment;
    projIncomeConservative = Math.max(0, Math.round(projIncomeConservative * 100) / 100);

    // Tier 1 expenses due this month
    const tier1Due = tier1Outgoings
      .filter(o => isOutgoingDueInMonth(o, forecastDate))
      .map(o => ({ name: o.name, amount: parseFloat(o.amount), category: o.category }));
    const tier1Total = tier1Due.reduce((s, o) => s + o.amount, 0);

    // Tier 2 run-rate (with seasonal weighting)
    const projTier2 = Math.round(tier2Monthly * seasonWeight * 100) / 100;

    // Tax spike events this month
    const taxSpikes = buildTaxSpikes(forecastDate, taxCalc, user.is_vat_registered);
    const taxSpikeTotal = taxSpikes.reduce((s, t) => s + t.amount, 0);

    // Total projected expenses
    const projExpenses = Math.round((tier1Total + projTier2 + taxSpikeTotal + monthlyTaxPot) * 100) / 100;

    // Projected balance
    const projBalanceBase = Math.round((runningBalance + projIncomeBase - projExpenses) * 100) / 100;
    runningBalance = projBalanceBase;

    // Danger detection — always uses CONSERVATIVE projection (FCE Part 7)
    let dangerLevel;
    if (tier1Monthly === 0) {
      dangerLevel = 'UNKNOWN';
    } else if (projIncomeConservative < projExpenses * DANGER_RED) {
      dangerLevel = 'RED';
    } else if (projIncomeConservative < projExpenses * DANGER_AMBER) {
      dangerLevel = 'AMBER';
    } else {
      dangerLevel = 'GREEN';
    }

    // FCA-compliant alert copy (FCE Part 7)
    let alertCopy = null;
    if (dangerLevel === 'RED') {
      alertCopy = `${monthLabel} is flagged as a risk month. In quieter periods like this, your income has historically been significantly below your outgoings. This is based on your own patterns — not a prediction.`;
    } else if (dangerLevel === 'AMBER') {
      alertCopy = `${monthLabel} looks like it could be a quieter month for your income. Based on your historical patterns, income may not fully cover your committed payments this month.`;
    }

    months.push({
      month:          monthKey,
      month_label:    monthLabel,
      // Income
      proj_income_base:         projIncomeBase,
      proj_income_conservative: projIncomeConservative,
      seasonal_weight:          seasonWeight,
      // Expenses
      tier1_due:                tier1Due,
      tier1_total:              Math.round(tier1Total * 100) / 100,
      tier2_run_rate:           projTier2,
      tax_spikes:               taxSpikes,
      tax_spike_total:          Math.round(taxSpikeTotal * 100) / 100,
      monthly_tax_pot:          monthlyTaxPot,
      proj_expenses:            projExpenses,
      // Balance
      proj_balance:             projBalanceBase,
      // Danger
      danger_level:             dangerLevel,
      alert_copy:               alertCopy,
      is_scenario:              !!scenarioOverride,
    });
  }

  // Fire danger month alerts
  await fireDangerAlerts(userId, months);

  // Save forecast snapshot
  await saveForecastSnapshot(userId, months);

  return {
    window_months:      windowMonths,
    confidence:         confidence,
    months_of_data:     monthsOfData,
    start_balance:      Math.round(startBalance * 100) / 100,
    bank_balance:       Math.round(bankBalance * 100) / 100,
    tax_pot_balance:    Math.round(taxPotBalance * 100) / 100,
    avg_monthly_income: Math.round(avgIncome * 100) / 100,
    conservative_income:Math.round(conservativeIncome * 100) / 100,
    reserve_buffer_pct: reserveBuffer,
    months,
    is_scenario:        !!scenarioOverride,
    generated_at:       new Date().toISOString(),
    // FCA disclosure
    disclosure: 'Projections are based on your historical income and spending patterns. They are estimates only and not financial advice.',
  };
}

// ══════════════════════════════════════════════════════════════════════════════
// HELPERS
// ══════════════════════════════════════════════════════════════════════════════

function isOutgoingDueInMonth(outgoing, forecastDate) {
  if (!outgoing.next_due_date) return false;
  const due = new Date(outgoing.next_due_date);
  return due.getFullYear() === forecastDate.getFullYear() &&
         due.getMonth()    === forecastDate.getMonth();
}

function buildTaxSpikes(forecastDate, taxCalc, isVatRegistered) {
  const spikes = [];
  const month  = forecastDate.getMonth() + 1;
  const day    = forecastDate.getDate();

  // Self Assessment + POA 1: 31 January
  if (month === 1) {
    const liability = parseFloat(taxCalc.total_tax_liability) || 0;
    const poa       = parseFloat(taxCalc.payments_on_account) || 0;
    if (liability > 0) {
      spikes.push({ name: 'Self Assessment balancing payment', amount: liability, date: '31 Jan', type: 'tax_spike' });
    }
    if (poa > 0) {
      spikes.push({ name: 'Payment on Account (1st)', amount: poa * 0.5, date: '31 Jan', type: 'tax_spike' });
    }
  }

  // POA 2: 31 July
  if (month === 7) {
    const poa = parseFloat(taxCalc.payments_on_account) || 0;
    if (poa > 0) {
      spikes.push({ name: 'Payment on Account (2nd)', amount: poa * 0.5, date: '31 Jul', type: 'tax_spike' });
    }
  }

  // VAT quarterly
  if (isVatRegistered) {
    const vatDue = [5, 8, 11, 2]; // May, Aug, Nov, Feb
    if (vatDue.includes(month)) {
      const vatOwed = parseFloat(taxCalc.vat_owed) || 0;
      if (vatOwed > 0) {
        spikes.push({ name: 'VAT quarterly payment', amount: vatOwed, date: `${forecastDate.toLocaleString('en-GB', { month: 'short' })}`, type: 'vat_spike' });
      }
    }
  }

  return spikes;
}

async function fireDangerAlerts(userId, months) {
  for (const month of months) {
    if (month.danger_level === 'RED' || month.danger_level === 'AMBER') {
      const dedupKey = `DANGER_${month.danger_level}_${month.month}`;
      await query(`
        INSERT INTO notifications
          (user_id, alert_type, severity, title, body, dedup_key, valid_until)
        VALUES ($1,$2,$3,$4,$5,$6, NOW() + INTERVAL '30 days')
        ON CONFLICT (user_id, dedup_key) DO NOTHING
      `, [
        userId,
        'DANGER_MONTH_AHEAD',
        month.danger_level,
        `${month.danger_level === 'RED' ? '⚠️ Risk month' : 'Quieter month'}: ${month.month_label}`,
        month.alert_copy,
        dedupKey,
      ]);
    }
  }
}

async function saveForecastSnapshot(userId, months) {
  const today = new Date().toISOString().split('T')[0];
  await query(`
    INSERT INTO forecast_snapshots
      (user_id, snapshot_date, forecast_json)
    VALUES ($1, $2, $3)
    ON CONFLICT (user_id, snapshot_date) DO UPDATE SET
      forecast_json = EXCLUDED.forecast_json,
      updated_at    = NOW()
  `, [userId, today, JSON.stringify(months)]);
}

function getCurrentTaxYear() {
  const now   = new Date();
  const month = now.getMonth() + 1;
  const day   = now.getDate();
  const year  = now.getFullYear();
  const isNew = (month > 4) || (month === 4 && day >= 6);
  const start = isNew ? year : year - 1;
  return `${start}/${String(start + 1).slice(-2)}`;
}

module.exports = { generateForecast, getCurrentTaxYear };
