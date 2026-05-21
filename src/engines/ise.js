'use strict';

/**
 * FlexFlow — Income Smoothing Engine (ISE v1.5)
 * Session D — Task 5
 *
 * The engine that answers: "How much of the money in my account
 * is actually mine to spend this month?"
 *
 * Produces the Personal Income figure — the single number that feeds
 * the Budgeting Engine, Runway Calculator, and Forecasting Engine.
 *
 * Key rules (from ISE v1.5 spec):
 *   - Default rolling window: 6 months (12 for PRO users)
 *   - Confidence: LOW < 12 months, MEDIUM 12–23 months, HIGH 24+ months
 *   - SE income ONLY is smoothed. PAYE added as fixed monthly amount.
 *   - CIS: read gross_amount from income_events (Build Note 2)
 *   - Zero-income months ARE included in the average (they're real months)
 *   - Personal Income is always post-tax-pot
 *   - Event-driven — recalculates on every new income event
 *
 * Source: ISE v1.5 Specification (May 2026)
 */

const { query } = require('../config/database');

// ── Seasonal weighting factors (ISE v1.5 Part 3) ─────────────────────────────
// Based on IPSE Self-Employed Landscape 2024 + FlexFlow beta data
// Applied as multipliers to identify historically quiet months
const SEASONAL_WEIGHTS = {
  1:  0.75,  // January  — post-Christmas quiet
  2:  0.80,  // February — still slow
  3:  1.05,  // March    — picking up
  4:  1.10,  // April    — strong Q2 start
  5:  1.10,  // May      — strong
  6:  1.05,  // June     — good
  7:  0.90,  // July     — summer slow-down begins
  8:  0.75,  // August   — quietest summer month
  9:  1.10,  // September— back to work surge
  10: 1.15,  // October  — strongest month
  11: 1.05,  // November — good
  12: 0.90,  // December — slowing before Christmas
};

// Quiet month threshold — if upcoming month is >30% below average, fire seasonal alert
const SEASONAL_ALERT_THRESHOLD = 0.30;

// ══════════════════════════════════════════════════════════════════════════════
// MAIN ENGINE FUNCTION
// Called on every income event, tax update, or settings change
// ══════════════════════════════════════════════════════════════════════════════

async function calculatePersonalIncome(userId) {
  // Step 1: Get user profile
  const userResult = await query(
    `SELECT income_structure, is_cis_worker, receives_paye,
            is_ltd_director, rolling_window_months,
            tax_pot_target, plan
     FROM users WHERE id = $1`,
    [userId]
  );

  if (userResult.rows.length === 0) throw new Error('User not found');
  const user = userResult.rows[0];

  const reserveBuffer    = 0;  // Safety reserve removed — not used
  const windowMonths     = user.plan === 'pro'
    ? (user.rolling_window_months || 12)
    : 6;
  const monthlyTaxAlloc  = parseFloat(user.tax_pot_target) || 0;

  // Step 2: Fetch SE income events — rolling window
  // CIS: read gross_amount (pre-deduction) not amount (Build Note 2)
  const windowStart = new Date();
  windowStart.setMonth(windowStart.getMonth() - windowMonths);

  const incomeResult = await query(
    `SELECT
       DATE_TRUNC('month', income_date) AS month,
       SUM(CASE
         WHEN is_cis = true THEN gross_amount   -- CIS: always use gross_amount
         ELSE gross_amount                        -- non-CIS: gross = net
       END) AS monthly_total
     FROM income_events
     WHERE user_id = $1
       AND income_type IN ('se', 'cis', 'rental', 'dividend')
       AND included_in_smoothing = true
       AND income_date >= $2
       AND income_date < DATE_TRUNC('month', CURRENT_DATE)  -- exclude current incomplete month
     GROUP BY DATE_TRUNC('month', income_date)
     ORDER BY month DESC`,
    [userId, windowStart.toISOString().split('T')[0]]
  );

  const monthlyData = incomeResult.rows;

  // Step 3: Determine confidence level
  const monthsOfData = monthlyData.length;
  let confidenceLevel;
  if (monthsOfData < 12)      confidenceLevel = 'LOW';
  else if (monthsOfData < 24) confidenceLevel = 'MEDIUM';
  else                        confidenceLevel = 'HIGH';

  // Edge case: no income data yet
  if (monthsOfData === 0) {
    await writePersonalIncome(userId, 0, 'LOW', 0, 0, 0);
    return buildResult(0, 'LOW', 0, 0, 0, monthsOfData, reserveBuffer, windowMonths);
  }

  // Step 4: Build complete month array (including zero months)
  // Zero-income months ARE included — they're real months (spec Part 3.3)
  const monthMap = {};
  monthlyData.forEach(row => {
    const key = row.month.toISOString().slice(0, 7); // 'YYYY-MM'
    monthMap[key] = parseFloat(row.monthly_total) || 0;
  });

  // Fill in zero months for the full window
  const allMonths = [];
  for (let i = 0; i < windowMonths; i++) {
    const d = new Date();
    d.setMonth(d.getMonth() - i);
    const key = d.toISOString().slice(0, 7);
    allMonths.push(monthMap[key] || 0);
  }

  // Step 5: Calculate gross average monthly SE income
  const totalSE = allMonths.reduce((s, v) => s + v, 0);
  const grossAvgMonthlySE = totalSE / windowMonths;

  // Step 6: Subtract monthly tax pot allocation (post-tax-pot)
  const netAvgMonthlySE = Math.max(0, grossAvgMonthlySE - monthlyTaxAlloc);

  // Step 7: Add fixed PAYE/salary if mixed income structure
  let fixedMonthlyNet = 0;
  if (user.receives_paye || user.income_structure?.startsWith('S3') || user.income_structure === 'S5') {
    const payeResult = await query(
      `SELECT AVG(gross_amount) as avg_paye
       FROM income_events
       WHERE user_id = $1
         AND income_type = 'paye'
         AND income_date >= $2
         AND included_in_smoothing = true`,
      [userId, windowStart.toISOString().split('T')[0]]
    );
    // PAYE arrives net of tax — use as-is (tax already deducted at source)
    fixedMonthlyNet = parseFloat(payeResult.rows[0]?.avg_paye) || 0;
  }

  // Step 8: Apply reserve buffer to variable income only
  const smoothedVariableIncome = netAvgMonthlySE * (1 - reserveBuffer);
  const reserveAmount          = netAvgMonthlySE * reserveBuffer;

  // Step 9: Personal Income = fixed net + smoothed variable
  const personalIncome = Math.round((fixedMonthlyNet + smoothedVariableIncome) * 100) / 100;

  // Step 10: Detect seasonal quiet month
  const nextMonth        = new Date().getMonth() + 2; // 1-12 for next calendar month
  const nextMonthKey     = nextMonth > 12 ? nextMonth - 12 : nextMonth;
  const seasonalWeight   = SEASONAL_WEIGHTS[nextMonthKey];
  const isSeasonallyQuiet = seasonalWeight < (1 - SEASONAL_ALERT_THRESHOLD);

  // Step 11: Write to users table
  await writePersonalIncome(
    userId, personalIncome, confidenceLevel,
    grossAvgMonthlySE, reserveAmount, monthsOfData
  );

  // Step 12: Update income source reliability scores
  await updateIncomeSourceReliability(userId);

  return buildResult(
    personalIncome, confidenceLevel, grossAvgMonthlySE,
    reserveAmount, monthlyTaxAlloc, monthsOfData,
    reserveBuffer, windowMonths, fixedMonthlyNet,
    smoothedVariableIncome, isSeasonallyQuiet, nextMonthKey
  );
}

// ── Write results to users table ─────────────────────────────────────────────

async function writePersonalIncome(
  userId, personalIncome, confidenceLevel,
  grossAvgMonthlySE, reserveAmount, monthsOfData
) {
  await query(
    `UPDATE users SET
       personal_income              = $1,
       confidence_level             = $2,
       gross_avg_monthly_se         = $3,
       reserve_amount               = $4,
       months_of_data               = $5,
       last_smoothing_calculated    = NOW(),
       updated_at                   = NOW()
     WHERE id = $6`,
    [personalIncome, confidenceLevel, grossAvgMonthlySE,
     reserveAmount, monthsOfData, userId]
  );
}

// ── Build API response object ─────────────────────────────────────────────────

function buildResult(
  personalIncome, confidenceLevel, grossAvgMonthlySE,
  reserveAmount, monthlyTaxAlloc, monthsOfData,
  reserveBuffer, windowMonths, fixedMonthlyNet = 0,
  smoothedVariableIncome = 0, isSeasonallyQuiet = false, quietMonth = null
) {
  // FCA compliance — no directive language (spec Part 11)
  // MUST NOT say "you can spend" or "this is your income"
  const copyStrings = {
    LOW:    `Based on ${monthsOfData} month${monthsOfData === 1 ? '' : 's'} of income data. Accuracy increases significantly at 12 months.`,
    MEDIUM: `Based on your last ${monthsOfData} months of income data. Accuracy increases further at 24 months.`,
    HIGH:   `Based on your last ${monthsOfData} months of income data — high confidence.`,
  };

  const MONTH_NAMES = ['','January','February','March','April','May','June',
    'July','August','September','October','November','December'];

  return {
    personal_income:          Math.round(personalIncome * 100) / 100,
    confidence_level:         confidenceLevel,
    confidence_copy:          copyStrings[confidenceLevel],
    gross_avg_monthly_se:     Math.round(grossAvgMonthlySE * 100) / 100,
    monthly_tax_allocation:   Math.round(monthlyTaxAlloc * 100) / 100,
    reserve_amount:           Math.round(reserveAmount * 100) / 100,
    fixed_monthly_net:        Math.round(fixedMonthlyNet * 100) / 100,
    smoothed_variable_income: Math.round(smoothedVariableIncome * 100) / 100,
    months_of_data:           monthsOfData,
    window_months:            windowMonths,
    seasonal_alert: isSeasonallyQuiet ? {
      fires:    true,
      month:    MONTH_NAMES[quietMonth],
      // FCA: factual disclosure, no directive language
      copy:     `Heads up — ${MONTH_NAMES[quietMonth]} is typically a quieter month based on seasonal patterns. Your reserve buffer is here to help — no changes have been made automatically.`,
    } : { fires: false },
    calculated_at: new Date().toISOString(),
  };
}

// ── Update income source reliability scores ──────────────────────────────────
// GREEN = regular and reliable (≥4 of last 6 months have income from source)
// AMBER = irregular but present (1–3 of last 6 months)
// RED   = declining or absent (0 of last 6 months)

async function updateIncomeSourceReliability(userId) {
  const sources = await query(
    `SELECT id FROM income_sources WHERE user_id = $1 AND is_active = true`,
    [userId]
  );

  for (const source of sources.rows) {
    const sixMonthsAgo = new Date();
    sixMonthsAgo.setMonth(sixMonthsAgo.getMonth() - 6);

    const countResult = await query(
      `SELECT COUNT(DISTINCT DATE_TRUNC('month', income_date)) as active_months
       FROM income_events
       WHERE user_id = $1
         AND income_source_id = $2
         AND income_date >= $3`,
      [userId, source.id, sixMonthsAgo.toISOString().split('T')[0]]
    );

    const activeMonths = parseInt(countResult.rows[0]?.active_months) || 0;
    const score = activeMonths >= 4 ? 'GREEN' : activeMonths >= 1 ? 'AMBER' : 'RED';

    await query(
      `UPDATE income_sources
       SET reliability_score = $1, reliability_updated_at = NOW()
       WHERE id = $2`,
      [score, source.id]
    );
  }
}

module.exports = { calculatePersonalIncome, updateIncomeSourceReliability };
