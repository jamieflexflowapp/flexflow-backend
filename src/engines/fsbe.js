'use strict';

/**
 * FlexFlow — Future Scenario Building Engine (FSBE v1.1)
 * Session I — Task 8
 *
 * PRO-only. Ephemeral what-if overlays on the 90-day forecast.
 * NEVER modifies stored data. NEVER feeds scenario income to Tax Engine.
 * Sessions expire after 2 hours (cron purges expired records).
 *
 * Four scenario types:
 *   A — Client pauses (named source, duration 1-12 weeks)
 *   B — Month off (zero income for selected month)
 *   C — New project (income boost in selected month)
 *   D — Custom income adjustment (% change)
 *
 * Build Note 4: Scenario sessions expire 2 hrs. NEVER pass scenario
 * income to Tax Engine. Scenario results are display-only.
 *
 * Source: FSBE v1.1 Specification (May 2026)
 */

const { query } = require('../config/database');
const { generateForecast } = require('./forecast');

// Session TTL — 2 hours (Build Note 4)
const SESSION_TTL_HOURS = 2;

// ══════════════════════════════════════════════════════════════════════════════
// CREATE SCENARIO SESSION
// ══════════════════════════════════════════════════════════════════════════════

async function createScenarioSession(userId, scenarioType, params) {
  // Validate scenario type
  if (!['client_pause', 'month_off', 'new_project', 'custom'].includes(scenarioType)) {
    throw new Error('Invalid scenario type.');
  }

  // Build income delta per month from scenario params
  const incomeDeltas = await buildIncomeDeltas(userId, scenarioType, params);

  // Run forecast with scenario overlay
  // Build Note 4: NEVER pass this to Tax Engine
  const scenarioForecast = await runScenarioForecast(userId, incomeDeltas);

  // Run base forecast for comparison
  const baseForecast = await generateForecast(userId);

  // Calculate impact summary
  const impact = calculateImpact(baseForecast, scenarioForecast);

  // Store session (ephemeral — 2hr TTL)
  const expiresAt = new Date();
  expiresAt.setHours(expiresAt.getHours() + SESSION_TTL_HOURS);

  const session = await query(`
    INSERT INTO scenario_sessions
      (user_id, scenario_type, scenario_params, base_forecast_json,
       scenario_forecast_json, impact_json, expires_at)
    VALUES ($1,$2,$3,$4,$5,$6,$7)
    RETURNING id, created_at, expires_at
  `, [
    userId,
    scenarioType,
    JSON.stringify(params),
    JSON.stringify(baseForecast),
    JSON.stringify(scenarioForecast),
    JSON.stringify(impact),
    expiresAt.toISOString(),
  ]);

  return {
    session_id:         session.rows[0].id,
    scenario_type:      scenarioType,
    expires_at:         session.rows[0].expires_at,
    base_forecast:      baseForecast,
    scenario_forecast:  scenarioForecast,
    impact,
    // FCA: factual, no directive language
    disclosure: 'This is a hypothetical scenario based on your historical patterns. It is not a prediction and does not affect your actual financial data.',
  };
}

// ── Build income deltas per affected month ────────────────────────────────────

async function buildIncomeDeltas(userId, scenarioType, params) {
  const deltas = {}; // { 'YYYY-MM': deltaAmount }

  switch (scenarioType) {

  case 'client_pause': {
    // Scenario A: client pauses for N weeks
    const { source_id, start_date, duration_weeks } = params;
    if (!source_id || !start_date || !duration_weeks) {
      throw new Error('client_pause requires source_id, start_date, duration_weeks (1-12).');
    }
    if (duration_weeks < 1 || duration_weeks > 12) {
      throw new Error('duration_weeks must be between 1 and 12.');
    }

    // Get source's average monthly contribution
    const srcResult = await query(
      `SELECT average_monthly, reliability_score FROM income_sources
       WHERE id = $1 AND user_id = $2`,
      [source_id, userId]
    );
    if (srcResult.rows.length === 0) throw new Error('Income source not found.');

    const monthlyContrib = parseFloat(srcResult.rows[0].average_monthly) || 0;
    const reliabilityWeight = { GREEN: 1.0, AMBER: 0.75, RED: 0.4 }[srcResult.rows[0].reliability_score] || 0.75;

    // Calculate affected months and partial month overlap
    const startDate = new Date(start_date);
    const endDate   = new Date(start_date);
    endDate.setDate(endDate.getDate() + (duration_weeks * 7));

    const affectedMonths = getAffectedMonths(startDate, endDate);
    for (const { monthKey, overlapDays, daysInMonth } of affectedMonths) {
      const partialFactor = overlapDays / daysInMonth;
      deltas[monthKey] = -(monthlyContrib * partialFactor * reliabilityWeight);
    }
    break;
  }

  case 'month_off': {
    // Scenario B: zero income for selected month
    const { month } = params; // 'YYYY-MM'
    if (!month) throw new Error('month_off requires month (YYYY-MM).');

    // Get user's average income for that calendar month
    const calMonth = parseInt(month.split('-')[1]);
    const incResult = await query(
      `SELECT COALESCE(AVG(monthly_total), 0) as avg_income FROM (
         SELECT DATE_TRUNC('month', income_date) as m,
                SUM(gross_amount) as monthly_total
         FROM income_events
         WHERE user_id = $1 AND EXTRACT(MONTH FROM income_date) = $2
           AND included_in_smoothing = true
         GROUP BY m
       ) t`,
      [userId, calMonth]
    );
    const avgForMonth = parseFloat(incResult.rows[0]?.avg_income) || 0;
    deltas[month] = -avgForMonth; // Zero income = subtract the average
    break;
  }

  case 'new_project': {
    // Scenario C: income boost in selected month
    const { month, amount } = params;
    if (!month || !amount) throw new Error('new_project requires month (YYYY-MM) and amount.');
    if (parseFloat(amount) <= 0) throw new Error('amount must be positive.');
    deltas[month] = parseFloat(amount);
    break;
  }

  case 'custom': {
    // Scenario D: % change across N months
    const { month, pct_change } = params;
    if (!month || pct_change === undefined) throw new Error('custom requires month (YYYY-MM) and pct_change (-100 to 200).');
    if (pct_change < -100 || pct_change > 200) throw new Error('pct_change must be between -100 and 200.');

    // Get base income for the month
    const calMonth = parseInt(month.split('-')[1]);
    const incResult = await query(
      `SELECT COALESCE(AVG(monthly_total), 0) as avg_income FROM (
         SELECT DATE_TRUNC('month', income_date) as m, SUM(gross_amount) as monthly_total
         FROM income_events
         WHERE user_id = $1 AND EXTRACT(MONTH FROM income_date) = $2
           AND included_in_smoothing = true
         GROUP BY m
       ) t`,
      [userId, calMonth]
    );
    const baseIncome = parseFloat(incResult.rows[0]?.avg_income) || 0;
    deltas[month] = baseIncome * (pct_change / 100);
    break;
  }
  }

  return deltas;
}

// ── Run forecast with income deltas applied ───────────────────────────────────

async function runScenarioForecast(userId, incomeDeltas) {
  // Generate base forecast then apply deltas month by month
  const baseForecast = await generateForecast(userId);

  // Apply income deltas to each affected month
  baseForecast.months = baseForecast.months.map(month => {
    const delta = incomeDeltas[month.month] || 0;
    if (delta === 0) return month;

    const newBase         = Math.max(0, month.proj_income_base + delta);
    const newConservative = Math.max(0, month.proj_income_conservative + delta);
    const newBalance      = month.proj_balance + (newBase - month.proj_income_base);

    // Re-run danger detection with new conservative income
    let dangerLevel;
    if (month.proj_expenses === 0) {
      dangerLevel = 'UNKNOWN';
    } else if (newConservative < month.proj_expenses * 0.80) {
      dangerLevel = 'RED';
    } else if (newConservative < month.proj_expenses) {
      dangerLevel = 'AMBER';
    } else {
      dangerLevel = 'GREEN';
    }

    return {
      ...month,
      proj_income_base:          Math.round(newBase * 100) / 100,
      proj_income_conservative:  Math.round(newConservative * 100) / 100,
      proj_balance:              Math.round(newBalance * 100) / 100,
      danger_level:              dangerLevel,
      scenario_delta:            Math.round(delta * 100) / 100,
      is_scenario:               true,
    };
  });

  baseForecast.is_scenario = true;
  return baseForecast;
}

// ── Calculate scenario impact summary ────────────────────────────────────────

function calculateImpact(baseForecast, scenarioForecast) {
  const baseEndBalance     = baseForecast.months[baseForecast.months.length - 1]?.proj_balance || 0;
  const scenarioEndBalance = scenarioForecast.months[scenarioForecast.months.length - 1]?.proj_balance || 0;
  const balanceDiff        = Math.round((scenarioEndBalance - baseEndBalance) * 100) / 100;

  const newRedMonths   = scenarioForecast.months.filter(m => m.danger_level === 'RED').length;
  const baseRedMonths  = baseForecast.months.filter(m => m.danger_level === 'RED').length;

  return {
    balance_impact:       balanceDiff,
    balance_impact_label: balanceDiff >= 0 ? 'improvement' : 'reduction',
    new_danger_months:    Math.max(0, newRedMonths - baseRedMonths),
    scenario_end_balance: Math.round(scenarioEndBalance * 100) / 100,
    base_end_balance:     Math.round(baseEndBalance * 100) / 100,
  };
}

// ── Get affected months with partial overlap ──────────────────────────────────

function getAffectedMonths(startDate, endDate) {
  const months = [];
  const current = new Date(startDate.getFullYear(), startDate.getMonth(), 1);

  while (current <= endDate) {
    const monthKey    = current.toISOString().slice(0, 7);
    const daysInMonth = new Date(current.getFullYear(), current.getMonth() + 1, 0).getDate();
    const monthStart  = new Date(current);
    const monthEnd    = new Date(current.getFullYear(), current.getMonth() + 1, 0);

    const overlapStart = startDate > monthStart ? startDate : monthStart;
    const overlapEnd   = endDate   < monthEnd   ? endDate   : monthEnd;
    const overlapDays  = Math.max(0, Math.ceil((overlapEnd - overlapStart) / (1000 * 60 * 60 * 24)) + 1);

    months.push({ monthKey, overlapDays, daysInMonth });
    current.setMonth(current.getMonth() + 1);
  }

  return months;
}

// ── Get existing session ──────────────────────────────────────────────────────

async function getScenarioSession(userId, sessionId) {
  const result = await query(
    `SELECT * FROM scenario_sessions
     WHERE id = $1 AND user_id = $2 AND expires_at > NOW()`,
    [sessionId, userId]
  );
  if (result.rows.length === 0) throw new Error('Scenario session not found or expired.');
  return result.rows[0];
}

// ── Purge expired sessions (called by cron) ───────────────────────────────────

async function purgeExpiredSessions() {
  const result = await query(
    `DELETE FROM scenario_sessions WHERE expires_at < NOW() RETURNING id`
  );
  return result.rowCount;
}

module.exports = { createScenarioSession, getScenarioSession, purgeExpiredSessions };
