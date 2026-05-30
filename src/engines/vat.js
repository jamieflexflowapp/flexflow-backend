'use strict';

/**
 * FlexFlow — VAT Engine
 * Session F — Task 6b
 *
 * Handles VAT calculations for registered businesses.
 * Critical: VAT deadline = 1 calendar month + 7 days after quarter end.
 * JavaScript's setMonth() overflows month-end dates — must cap explicitly.
 * Build Note 10: Q1 (31 Mar) = 7 May. Q2 (30 Jun) = 6 Aug. Q3 (30 Sep) = 6 Nov. Q4 (31 Dec) = 7 Feb.
 *
 * Source: Tax Engine v3.5 + Build Note 10 (Phase 3 Plan v3.2)
 */

const { query } = require('../config/database');

// VAT quarters — quarter end dates
const VAT_QUARTERS = [
  { quarter: 'Q1', endMonth: 3,  endDay: 31 },  // March 31
  { quarter: 'Q2', endMonth: 6,  endDay: 30 },  // June 30
  { quarter: 'Q3', endMonth: 9,  endDay: 30 },  // September 30
  { quarter: 'Q4', endMonth: 12, endDay: 31 },  // December 31
];

// ══════════════════════════════════════════════════════════════════════════════
// VAT DEADLINE CALCULATOR
// Build Note 10: setMonth() overflows — use explicit last-day-of-month capping
// ══════════════════════════════════════════════════════════════════════════════

function calcVATDeadline(quarterEndDate) {
  // Parse date string directly — avoids UTC/BST timezone offset issue
  // new Date('YYYY-MM-DD') parses as UTC midnight; toISOString() returns UTC
  // On BST (UTC+1) machines this shifts the date back by 1 day
  // Fix: parse string manually and use local Date constructor
  const [y, m, d] = quarterEndDate.split('-').map(Number);

  // Add 1 calendar month with explicit last-day-of-month capping
  // (Build Note 10: setMonth() overflows — e.g. March 31 + 1 = May 1 ❌)
  let nextMonth = m + 1;
  let nextYear  = y;
  if (nextMonth > 12) { nextMonth -= 12; nextYear++; }

  // Last day of the next month
  const lastDay = new Date(nextYear, nextMonth, 0).getDate();
  const newDay  = Math.min(d, lastDay);

  // Add 7 days
  const deadline = new Date(nextYear, nextMonth - 1, newDay + 7);

  // Format using LOCAL date parts — not toISOString() which returns UTC
  const ry = deadline.getFullYear();
  const rm = String(deadline.getMonth() + 1).padStart(2, '0');
  const rd = String(deadline.getDate()).padStart(2, '0');
  return ry + '-' + rm + '-' + rd;
}

// Verify our implementation against Build Note 10 confirmed deadlines
function verifyVATDeadlines() {
  const tests = [
    { end: '2026-03-31', expected: '2026-05-07', label: 'Q1: 31 Mar → 7 May' },
    { end: '2026-06-30', expected: '2026-08-06', label: 'Q2: 30 Jun → 6 Aug' },
    { end: '2026-09-30', expected: '2026-11-06', label: 'Q3: 30 Sep → 6 Nov' },
    { end: '2026-12-31', expected: '2027-02-07', label: 'Q4: 31 Dec → 7 Feb' },
  ];
  const results = tests.map(t => ({
    label: t.label, end: t.end, expected: t.expected, got: calcVATDeadline(t.end),
    pass: calcVATDeadline(t.end) === t.expected,
  }));
  return results;
}

// ══════════════════════════════════════════════════════════════════════════════
// GET CURRENT VAT QUARTER
// ══════════════════════════════════════════════════════════════════════════════

function getCurrentVATQuarter() {
  const now   = new Date();
  const month = now.getMonth() + 1; // 1-12

  let quarter;
  if (month <= 3)       quarter = VAT_QUARTERS[0]; // Q1: Jan-Mar
  else if (month <= 6)  quarter = VAT_QUARTERS[1]; // Q2: Apr-Jun
  else if (month <= 9)  quarter = VAT_QUARTERS[2]; // Q3: Jul-Sep
  else                  quarter = VAT_QUARTERS[3]; // Q4: Oct-Dec

  const year     = month > quarter.endMonth ? now.getFullYear() + 1 : now.getFullYear();
  const endDate  = `${year}-${String(quarter.endMonth).padStart(2,'0')}-${quarter.endDay}`;
  const deadline = calcVATDeadline(endDate);

  return {
    quarter:      quarter.quarter,
    quarter_end:  endDate,
    deadline,
    days_until_deadline: Math.ceil((new Date(deadline) - now) / (1000 * 60 * 60 * 24)),
  };
}

// ══════════════════════════════════════════════════════════════════════════════
// VAT CALCULATION
// Output VAT (on sales) minus Input VAT (on business purchases) = VAT owed
// ══════════════════════════════════════════════════════════════════════════════

async function calculateVAT(userId, taxYear = '2026/27') {
  const userResult = await query(
    `SELECT is_vat_registered, vat_number FROM users WHERE id = $1`,
    [userId]
  );
  const user = userResult.rows[0];
  if (!user?.is_vat_registered) {
    return { vat_registered: false };
  }

  // Load VAT rate from database
  const rateResult = await query(
    `SELECT parameter_value FROM tax_rates
     WHERE tax_year = $1 AND jurisdiction = 'UK' AND parameter_key = 'vat_standard_rate'`,
    [taxYear]
  );
  const vatRate = parseFloat(rateResult.rows[0]?.parameter_value) || 0.20;

  // Output VAT — VAT collected on sales (SE income × standard rate)
  const incomeResult = await query(
    `SELECT COALESCE(SUM(gross_amount), 0) as gross_income
     FROM income_events
     WHERE user_id = $1 AND tax_year = $2 AND income_type IN ('se','cis')`,
    [userId, taxYear]
  );
  const grossIncome = parseFloat(incomeResult.rows[0]?.gross_income) || 0;
  const outputVAT   = Math.round(grossIncome * vatRate / (1 + vatRate) * 100) / 100;

  // Input VAT — VAT paid on business expenses (reclaim)
  const expResult = await query(
    `SELECT COALESCE(SUM(deduct_amount), 0) as total_expenses
     FROM expense_records
     WHERE user_id = $1 AND tax_year = $2 AND confirmed = true`,
    [userId, taxYear]
  );
  const totalExpenses = parseFloat(expResult.rows[0]?.total_expenses) || 0;
  const inputVAT      = Math.round(totalExpenses * vatRate / (1 + vatRate) * 100) / 100;

  const vatOwed = Math.max(0, Math.round((outputVAT - inputVAT) * 100) / 100);

  // Current quarter info
  const currentQuarter = getCurrentVATQuarter();

  // Store VAT in tax_calculations
  await query(
    `UPDATE tax_calculations SET
       is_vat_registered = true,
       vat_owed          = $1,
       vat_quarter_end   = $2,
       vat_deadline      = $3,
       updated_at        = NOW()
     WHERE user_id = $4 AND tax_year = $5`,
    [vatOwed, currentQuarter.quarter_end, currentQuarter.deadline, userId, taxYear]
  );

  return {
    vat_registered:    true,
    vat_number:        user.vat_number,
    vat_rate:          vatRate,
    gross_income:      grossIncome,
    output_vat:        outputVAT,
    input_vat:         inputVAT,
    vat_owed:          vatOwed,
    current_quarter:   currentQuarter,
    // FCA: factual disclosure, no directive language
    disclosure:        `VAT estimate based on income and expenses recorded in FlexFlow for ${taxYear}. Please verify with your accountant before filing.`,
  };
}

// ══════════════════════════════════════════════════════════════════════════════
// VAT THRESHOLD CHECK
// Alerts user when gross income approaches or crosses the £90,000 VAT threshold
// ══════════════════════════════════════════════════════════════════════════════

async function checkVATThreshold(userId, taxYear = '2026/27') {
  // Get VAT threshold from database
  const rateResult = await query(
    `SELECT parameter_value FROM tax_rates
     WHERE tax_year = $1 AND jurisdiction = 'UK' AND parameter_key = 'vat_threshold'`,
    [taxYear]
  );
  const threshold = parseFloat(rateResult.rows[0]?.parameter_value) || 90000;

  // Get rolling 12-month gross income
  const incomeResult = await query(
    `SELECT COALESCE(SUM(gross_amount), 0) as rolling_12m
     FROM income_events
     WHERE user_id = $1
       AND income_date >= NOW() - INTERVAL '12 months'
       AND income_type IN ('se','cis')`,
    [userId]
  );
  const rolling12m = parseFloat(incomeResult.rows[0]?.rolling_12m) || 0;

  const pctOfThreshold = Math.round((rolling12m / threshold) * 100);
  const approaching    = rolling12m >= threshold * 0.85 && rolling12m < threshold;
  const exceeded       = rolling12m >= threshold;

  if (exceeded || approaching) {
    // VAT notifications disabled — keeping expenses + income review only
    if (false) await query(`
      INSERT INTO notifications
        (user_id, alert_type, severity, title, body, dedup_key, valid_until)
      VALUES ($1, $2, $3, $4, $5, $6, NOW() + INTERVAL '30 days')
      ON CONFLICT (user_id, dedup_key) DO NOTHING
    `, [
      userId,
      exceeded ? 'VAT_THRESHOLD_EXCEEDED' : 'VAT_THRESHOLD_APPROACHING',
      exceeded ? 'RED' : 'AMBER',
      exceeded ? 'VAT registration threshold reached' : 'Approaching VAT registration threshold',
      exceeded
        ? `Your rolling 12-month income has reached £${rolling12m.toFixed(0)}, which exceeds the £${threshold.toLocaleString()} VAT registration threshold. You may need to register for VAT.`
        : `Your rolling 12-month income is £${rolling12m.toFixed(0)} — ${pctOfThreshold}% of the £${threshold.toLocaleString()} VAT threshold.`,
      exceeded ? 'VAT_EXCEEDED' : 'VAT_APPROACHING',
    ]);
  }

  return {
    rolling_12m_income: rolling12m,
    vat_threshold:      threshold,
    pct_of_threshold:   pctOfThreshold,
    approaching,
    exceeded,
  };
}

module.exports = {
  calcVATDeadline,
  verifyVATDeadlines,
  getCurrentVATQuarter,
  calculateVAT,
  checkVATThreshold,
};
