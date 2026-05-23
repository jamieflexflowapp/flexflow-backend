'use strict';

/**
 * FlexFlow — Income Smoothing Engine (ISE v2.1)
 *
 * Upgrades from v2.0:
 *   - Ltd Director smoothing: quarterly-aware dividend model
 *   - Corporation Tax with marginal relief (£50k–£250k)
 *   - Band-aware dividend tax (based on total personal income)
 *   - Associated companies divide CT bands
 *   - Other PAYE income shifts personal tax bands
 *
 * Unchanged from v2.0:
 *   - Source-level smoothing (Tier 1) — RETAINER/IRREGULAR/WINDFALL/DECLINING
 *   - Volatility scoring (Tier 4) — STABLE/MODERATE/HIGH
 *   - Window cap at 36 months
 *   - Confidence thresholds: LOW <12, MEDIUM 12-23, HIGH 24+
 *
 * Function signature unchanged — drop-in replacement.
 * Sole Trader users get IDENTICAL output to v2.0.
 * Ltd Director users get NEW ltd_breakdown object in response.
 *
 * Source: ISE v2.0 Specification Document, Parts 6 and 7.
 */

const { query } = require('../config/database');

// ── 2026/27 TAX CONSTANTS ──────────────────────────────────────────
const PERSONAL_ALLOWANCE       = 12570;
const PA_TAPER_THRESHOLD       = 100000;
const BASIC_RATE_BAND          = 37700;
const HIGHER_BAND_TOP          = 125140;

const DIVIDEND_ALLOWANCE       = 500;
const DIV_BASIC_RATE           = 0.0875;
const DIV_HIGHER_RATE          = 0.3375;
const DIV_ADDITIONAL_RATE      = 0.3935;

const IT_BASIC_RATE            = 0.20;
const IT_HIGHER_RATE           = 0.40;
const IT_ADDITIONAL_RATE       = 0.45;

const EE_NI_PRIMARY_THRESHOLD  = 12570;
const EE_NI_UPPER_LIMIT        = 50270;
const EE_NI_MAIN_RATE          = 0.08;
const EE_NI_UPPER_RATE         = 0.02;

const CT_SMALL_PROFITS_RATE    = 0.19;
const CT_MAIN_RATE             = 0.25;
const CT_LOWER_LIMIT           = 50000;
const CT_UPPER_LIMIT           = 250000;
const CT_MARGINAL_RELIEF_FRAC  = 3 / 200;

// ── ISE v2 CONFIG (unchanged) ──────────────────────────────────────
const SEASONAL_WEIGHTS = {
  1: 0.75, 2: 0.80, 3: 1.05, 4: 1.10, 5: 1.10, 6: 1.05,
  7: 0.90, 8: 0.75, 9: 1.10, 10: 1.15, 11: 1.05, 12: 0.90,
};
const SEASONAL_ALERT_THRESHOLD = 0.30;

const RETAINER_MIN_FREQUENCY = 0.75;
const RETAINER_MAX_VARIANCE_RATIO = 0.25;
const WINDFALL_MULTIPLIER = 3.0;
const DECLINING_DROP_RATIO = 0.50;

const VOLATILITY_STABLE_MAX = 0.20;
const VOLATILITY_MODERATE_MAX = 0.50;

const MAX_WINDOW_MONTHS = 36;

// ══════════════════════════════════════════════════════════════════════
// CORPORATION TAX HELPERS (NEW in v2.1)
// ══════════════════════════════════════════════════════════════════════

function corporationTaxAnnual(annualProfit, associatedCompanies = 1) {
  if (annualProfit <= 0) return 0;
  // Adjust CT limits by associated companies count
  const adjustedLower = CT_LOWER_LIMIT / associatedCompanies;
  const adjustedUpper = CT_UPPER_LIMIT / associatedCompanies;
  if (annualProfit <= adjustedLower) return annualProfit * CT_SMALL_PROFITS_RATE;
  if (annualProfit >= adjustedUpper) return annualProfit * CT_MAIN_RATE;
  // Marginal relief between bands
  const mainRateTax    = annualProfit * CT_MAIN_RATE;
  const marginalRelief = (adjustedUpper - annualProfit) * CT_MARGINAL_RELIEF_FRAC;
  return mainRateTax - marginalRelief;
}

// ══════════════════════════════════════════════════════════════════════
// SALARY TAX & NI (NEW in v2.1)
// ══════════════════════════════════════════════════════════════════════

function calcSalaryTaxAndNI(annualSalary) {
  // PA taper above £100k
  let pa = PERSONAL_ALLOWANCE;
  if (annualSalary > PA_TAPER_THRESHOLD) {
    pa = Math.max(0, PERSONAL_ALLOWANCE - (annualSalary - PA_TAPER_THRESHOLD) / 2);
  }
  // Income tax (banded)
  let it = 0;
  const taxable = Math.max(0, annualSalary - pa);
  if (taxable <= BASIC_RATE_BAND) {
    it = taxable * IT_BASIC_RATE;
  } else if (taxable <= (HIGHER_BAND_TOP - PERSONAL_ALLOWANCE)) {
    it = (BASIC_RATE_BAND * IT_BASIC_RATE)
       + ((taxable - BASIC_RATE_BAND) * IT_HIGHER_RATE);
  } else {
    it = (BASIC_RATE_BAND * IT_BASIC_RATE)
       + ((HIGHER_BAND_TOP - PERSONAL_ALLOWANCE - BASIC_RATE_BAND) * IT_HIGHER_RATE)
       + ((taxable - (HIGHER_BAND_TOP - PERSONAL_ALLOWANCE)) * IT_ADDITIONAL_RATE);
  }
  // Employee NI
  let ni = 0;
  if (annualSalary > EE_NI_PRIMARY_THRESHOLD) {
    const niable = Math.min(annualSalary, EE_NI_UPPER_LIMIT) - EE_NI_PRIMARY_THRESHOLD;
    ni += niable * EE_NI_MAIN_RATE;
    if (annualSalary > EE_NI_UPPER_LIMIT) {
      ni += (annualSalary - EE_NI_UPPER_LIMIT) * EE_NI_UPPER_RATE;
    }
  }
  return { it, ni, pa, salaryNet: annualSalary - it - ni };
}

// ══════════════════════════════════════════════════════════════════════
// DIVIDEND TAX (NEW in v2.1)
// ══════════════════════════════════════════════════════════════════════

function calcDividendTax(annualSalary, annualGrossDividend, otherPayeIncome = 0) {
  const totalIncome = annualSalary + annualGrossDividend + otherPayeIncome;
  // PA taper above £100k on total income
  let pa = PERSONAL_ALLOWANCE;
  if (totalIncome > PA_TAPER_THRESHOLD) {
    pa = Math.max(0, PERSONAL_ALLOWANCE - (totalIncome - PA_TAPER_THRESHOLD) / 2);
  }
  // PA is used by salary + other PAYE income first
  const nonDivIncome = annualSalary + otherPayeIncome;
  const paUsedByNonDiv = Math.min(nonDivIncome, pa);
  const paRemainingForDividend = pa - paUsedByNonDiv;
  // Dividend allowance applied after PA
  const dividendAfterPA  = Math.max(0, annualGrossDividend - paRemainingForDividend);
  const dividendAfterDA  = Math.max(0, dividendAfterPA - DIVIDEND_ALLOWANCE);
  // Compute remaining basic-band space (salary + other PAYE uses it first)
  const nonDivTaxable    = Math.max(0, nonDivIncome - pa);
  const basicBandLeft    = Math.max(0, BASIC_RATE_BAND - nonDivTaxable);
  const higherBandLeft   = Math.max(0,
    (HIGHER_BAND_TOP - PERSONAL_ALLOWANCE) - Math.max(nonDivTaxable, BASIC_RATE_BAND)
  );
  let dividendTax = 0;
  let remaining = dividendAfterDA;
  const inBasic = Math.min(remaining, basicBandLeft);
  dividendTax += inBasic * DIV_BASIC_RATE;
  remaining -= inBasic;
  if (remaining > 0) {
    const inHigher = Math.min(remaining, higherBandLeft);
    dividendTax += inHigher * DIV_HIGHER_RATE;
    remaining -= inHigher;
  }
  if (remaining > 0) {
    dividendTax += remaining * DIV_ADDITIONAL_RATE;
  }
  return {
    dividendTax,
    pa,
    paUsedByNonDiv,
    paRemainingForDividend,
    dividendAfterDA,
  };
}

// ══════════════════════════════════════════════════════════════════════
// MAIN ENGINE FUNCTION (entry point — unchanged signature)
// ══════════════════════════════════════════════════════════════════════

async function calculatePersonalIncome(userId) {
  // Step 1: Load user with all Ltd-relevant fields
  const userResult = await query(
    `SELECT income_structure, is_cis_worker, receives_paye,
            is_ltd_director, rolling_window_months,
            tax_pot_target, plan,
            director_salary_annual, dividend_frequency,
            associated_companies_count, other_paye_income
     FROM users WHERE id = $1`,
    [userId]
  );
  if (userResult.rows.length === 0) throw new Error('User not found');
  const user = userResult.rows[0];

  // Step 2: Determine window
  const requestedWindow = user.rolling_window_months || MAX_WINDOW_MONTHS;
  const windowMonths    = Math.min(requestedWindow, MAX_WINDOW_MONTHS);
  const windowStart     = new Date();
  windowStart.setMonth(windowStart.getMonth() - windowMonths);
  const windowStartStr  = windowStart.toISOString().split('T')[0];

  // Step 3: Months of data (drives confidence)
  const monthsResult = await query(
    `SELECT COUNT(DISTINCT DATE_TRUNC('month', income_date)) AS months_count
     FROM income_events
     WHERE user_id = $1
       AND income_type IN ('se', 'cis', 'rental', 'dividend')
       AND included_in_smoothing = true
       AND income_date < DATE_TRUNC('month', CURRENT_DATE)`,
    [userId]
  );
  const monthsOfData = parseInt(monthsResult.rows[0]?.months_count) || 0;

  let confidenceLevel;
  if (monthsOfData < 12)      confidenceLevel = 'LOW';
  else if (monthsOfData < 24) confidenceLevel = 'MEDIUM';
  else                        confidenceLevel = 'HIGH';

  // Edge case: no data
  if (monthsOfData === 0) {
    await writePersonalIncome(userId, 0, 'LOW', 0, 0, 0);
    return buildResult({
      personalIncome: 0,
      confidenceLevel: 'LOW',
      grossAvgMonthlySE: 0,
      monthlyTaxAlloc: 0,
      monthsOfData: 0,
      windowMonths,
      sources: [],
      volatility: { label: 'STABLE', stdDeviation: 0, copy: 'Not enough data yet.' },
      monthlyTotals: [],
      isLtd: !!user.is_ltd_director,
    });
  }

  // Step 4: Per-source classification (unchanged from v2.0)
  const sourcesResult = await query(
    `SELECT id, name, source_type, provider_name, first_seen_at, last_seen_at,
            average_monthly, reliability_score, tax_deducted_at_source, cis_rate
     FROM income_sources
     WHERE user_id = $1 AND is_active = true`,
    [userId]
  );

  const smoothedSources = [];
  for (const source of sourcesResult.rows) {
    const smoothed = await smoothSingleSource(userId, source, windowStartStr);
    smoothedSources.push(smoothed);
  }

  // Step 5: Aggregate smoothed contributions
  const totalSmoothedSE = smoothedSources
    .filter(s => s.classification !== 'WINDFALL' && s.classification !== 'DORMANT')
    .reduce((sum, s) => sum + s.smoothedMonthly, 0);

  // Step 6: Monthly totals (for volatility)
  const monthlyTotals = await getMonthlyTotals(userId, windowStartStr, windowMonths);
  const volatility = calculateVolatility(monthlyTotals);

  // Step 7: Seasonal alert
  const nextMonthRaw  = new Date().getMonth() + 2;
  const nextMonthKey  = nextMonthRaw > 12 ? nextMonthRaw - 12 : nextMonthRaw;
  const seasonalWeight = SEASONAL_WEIGHTS[nextMonthKey];
  const isSeasonallyQuiet = seasonalWeight < (1 - SEASONAL_ALERT_THRESHOLD);

  // Step 8: BRANCH on user structure
  const monthlyTaxAlloc = parseFloat(user.tax_pot_target) || 0;
  let personalIncome, fixedMonthlyNet = 0;
  let ltdBreakdown = null;

  const grossAvgMonthlySE = monthlyTotals.length > 0
    ? monthlyTotals.reduce((s, v) => s + v, 0) / monthlyTotals.length
    : 0;

  if (user.is_ltd_director) {
    // ── Ltd Director flow (NEW in v2.1) ────────────────────────────
    ltdBreakdown = computeLtdBreakdown({
      smoothedBusinessIncome: totalSmoothedSE,
      monthlyTaxAlloc,
      annualSalary:          parseFloat(user.director_salary_annual) || 12570,
      dividendFrequency:     user.dividend_frequency || 'quarterly',
      associatedCompanies:   parseInt(user.associated_companies_count) || 1,
      otherPayeIncome:       parseFloat(user.other_paye_income) || 0,
    });
    personalIncome = ltdBreakdown.personal_income_monthly;
  } else {
    // ── Sole Trader flow (unchanged from v2.0) ─────────────────────
    if (user.receives_paye || user.income_structure?.startsWith('S3') || user.income_structure === 'S5') {
      const payeResult = await query(
        `SELECT AVG(gross_amount) AS avg_paye
         FROM income_events
         WHERE user_id = $1
           AND income_type = 'paye'
           AND income_date >= $2
           AND included_in_smoothing = true`,
        [userId, windowStartStr]
      );
      fixedMonthlyNet = parseFloat(payeResult.rows[0]?.avg_paye) || 0;
    }
    const netAvgMonthlySE = Math.max(0, totalSmoothedSE - monthlyTaxAlloc);
    personalIncome = Math.round((fixedMonthlyNet + netAvgMonthlySE) * 100) / 100;
  }

  // Step 9: Write to users table
  await writePersonalIncome(
    userId, personalIncome, confidenceLevel,
    grossAvgMonthlySE, 0, monthsOfData
  );

  // Step 10: Update reliability scores per source
  for (const src of smoothedSources) {
    await query(
      `UPDATE income_sources
       SET reliability_score = $1,
           source_type = $2,
           average_monthly = $3,
           reliability_updated_at = NOW()
       WHERE id = $4`,
      [src.reliabilityScore, src.classification, src.smoothedMonthly, src.id]
    );
  }

  return buildResult({
    personalIncome,
    confidenceLevel,
    grossAvgMonthlySE,
    monthlyTaxAlloc,
    monthsOfData,
    windowMonths,
    sources: smoothedSources,
    volatility,
    monthlyTotals,
    isSeasonallyQuiet,
    nextMonthKey,
    fixedMonthlyNet,
    isLtd: !!user.is_ltd_director,
    ltdBreakdown,
  });
}

// ══════════════════════════════════════════════════════════════════════
// LTD DIRECTOR BREAKDOWN (NEW in v2.1)
// ══════════════════════════════════════════════════════════════════════

function computeLtdBreakdown({
  smoothedBusinessIncome,
  monthlyTaxAlloc,
  annualSalary,
  dividendFrequency,
  associatedCompanies,
  otherPayeIncome,
}) {
  const monthlySalary    = annualSalary / 12;
  // monthlyTaxAlloc represents business expenses + reserved corp tax in our simplified model
  // For now treat monthlyTaxAlloc as smoothed business expenses
  const monthlyExpenses  = monthlyTaxAlloc;
  // Step 1: Monthly profit pre-CT
  const monthlyProfitPreCT = smoothedBusinessIncome - monthlyExpenses - monthlySalary;
  const annualProfitPreCT  = monthlyProfitPreCT * 12;
  // Step 2: Corporation tax
  const annualCT       = corporationTaxAnnual(annualProfitPreCT, associatedCompanies);
  const monthlyCT      = annualCT / 12;
  const effectiveCTRate = annualProfitPreCT > 0 ? annualCT / annualProfitPreCT : 0;
  // Step 3: Distributable
  const distributableMonthly = monthlyProfitPreCT - monthlyCT;
  const distributableAnnual  = distributableMonthly * 12;
  // Step 4: Salary tax & NI
  const { salaryNet, it: salaryIT, ni: salaryNI } = calcSalaryTaxAndNI(annualSalary);
  const salaryNetMonthly = salaryNet / 12;

  if (distributableAnnual <= 0) {
    return {
      director_salary_net_monthly:               Math.round(salaryNetMonthly * 100) / 100,
      sustainable_monthly_dividend_gross:        0,
      sustainable_monthly_dividend_net:          0,
      corp_tax_allocation_monthly:               0,
      effective_ct_rate:                         Math.round(effectiveCTRate * 1000) / 10,
      dividend_frequency:                        dividendFrequency,
      next_dividend_recommended_amount:          0,
      annual_dividend_tax:                       0,
      annual_salary_it:                          Math.round(salaryIT * 100) / 100,
      annual_salary_ni:                          Math.round(salaryNI * 100) / 100,
      personal_income_monthly:                   Math.round(salaryNetMonthly * 100) / 100,
      explainer:                                 'Business profit is currently insufficient to support dividends. Personal income reflects salary only.',
      alert:                                     'NO_DIVIDEND_CAPACITY',
    };
  }

  // Step 5: Dividend tax (band-aware on total income)
  const { dividendTax } = calcDividendTax(annualSalary, distributableAnnual, otherPayeIncome);
  const annualDividendNet  = distributableAnnual - dividendTax;
  const monthlyDividendNet = annualDividendNet / 12;
  // Step 6: Personal income (monthly)
  const personalIncomeMonthly = salaryNetMonthly + monthlyDividendNet;
  // Step 7: Recommended next dividend draw
  const freqLower = (dividendFrequency || 'quarterly').toLowerCase();
  const periodMonths = freqLower === 'monthly' ? 1 :
                       freqLower === 'quarterly' ? 3 :
                       freqLower === 'annually' ? 12 : 3;
  const recommendedDividendDraw = distributableMonthly * periodMonths;

  const explainer = `Based on your business income, you could sustainably take ` +
    `£${Math.round(monthlyDividendNet).toLocaleString('en-GB')}/month in dividends. ` +
    `You typically draw ${freqLower} — your next recommended dividend is ` +
    `£${Math.round(recommendedDividendDraw).toLocaleString('en-GB')}.`;

  return {
    director_salary_net_monthly:        Math.round(salaryNetMonthly * 100) / 100,
    sustainable_monthly_dividend_gross: Math.round(distributableMonthly * 100) / 100,
    sustainable_monthly_dividend_net:   Math.round(monthlyDividendNet * 100) / 100,
    corp_tax_allocation_monthly:        Math.round(monthlyCT * 100) / 100,
    effective_ct_rate:                  Math.round(effectiveCTRate * 1000) / 10,
    dividend_frequency:                 freqLower,
    next_dividend_recommended_amount:   Math.round(recommendedDividendDraw * 100) / 100,
    annual_dividend_tax:                Math.round(dividendTax * 100) / 100,
    annual_salary_it:                   Math.round(salaryIT * 100) / 100,
    annual_salary_ni:                   Math.round(salaryNI * 100) / 100,
    personal_income_monthly:            Math.round(personalIncomeMonthly * 100) / 100,
    explainer,
    alert:                              null,
  };
}

// ══════════════════════════════════════════════════════════════════════
// SOURCE SMOOTHING (unchanged from v2.0)
// ══════════════════════════════════════════════════════════════════════

async function smoothSingleSource(userId, source, windowStartStr) {
  const eventsResult = await query(
    `SELECT
       DATE_TRUNC('month', income_date) AS month,
       SUM(gross_amount) AS monthly_amount
     FROM income_events
     WHERE user_id = $1
       AND income_source_id = $2
       AND income_date >= $3
       AND income_date < DATE_TRUNC('month', CURRENT_DATE)
       AND included_in_smoothing = true
     GROUP BY DATE_TRUNC('month', income_date)
     ORDER BY month ASC`,
    [userId, source.id, windowStartStr]
  );

  const monthlyAmounts = eventsResult.rows.map(r => parseFloat(r.monthly_amount) || 0);
  const monthsWithIncome = monthlyAmounts.length;

  const firstSeen = source.first_seen_at ? new Date(source.first_seen_at) : new Date(windowStartStr);
  const windowStart = new Date(windowStartStr);
  const effectiveStart = firstSeen > windowStart ? firstSeen : windowStart;
  const monthsActive = Math.max(1, Math.round(
    (new Date() - effectiveStart) / (1000 * 60 * 60 * 24 * 30.44)
  ));

  if (monthsWithIncome === 0) {
    return {
      id: source.id, name: source.name, providerName: source.provider_name,
      classification: 'DORMANT', reliabilityScore: 'RED', smoothedMonthly: 0,
      lastPaidAt: source.last_seen_at, monthsWithIncome: 0, monthsActive,
      strategy: 'none', sparkline: [],
    };
  }

  const mean = monthlyAmounts.reduce((s, v) => s + v, 0) / monthsWithIncome;
  const variance = monthlyAmounts.reduce((s, v) => s + Math.pow(v - mean, 2), 0) / monthsWithIncome;
  const stdDev = Math.sqrt(variance);
  const varianceRatio = mean > 0 ? stdDev / mean : 0;
  const frequency = monthsWithIncome / monthsActive;

  let classification, smoothedMonthly, strategy;
  const sortedDesc = [...monthlyAmounts].sort((a, b) => b - a);
  const largest = sortedDesc[0];
  const secondLargest = sortedDesc[1] || 0;
  const isWindfall = monthsWithIncome === 1 || (largest > mean * WINDFALL_MULTIPLIER && largest > secondLargest * 2);

  if (isWindfall) {
    classification = 'WINDFALL';
    smoothedMonthly = 0;
    strategy = 'excluded';
  } else {
    const recentMonths = monthlyAmounts.slice(-3);
    const recentMean = recentMonths.reduce((s, v) => s + v, 0) / recentMonths.length;
    const isDeclining = monthsWithIncome >= 4 && recentMean < (mean * DECLINING_DROP_RATIO);
    if (isDeclining) {
      classification = 'DECLINING';
      smoothedMonthly = recentMean;
      strategy = 'recent_3mo_mean';
    } else if (frequency >= RETAINER_MIN_FREQUENCY && varianceRatio < RETAINER_MAX_VARIANCE_RATIO) {
      classification = 'RETAINER';
      const last3 = monthlyAmounts.slice(-3);
      smoothedMonthly = last3.reduce((s, v) => s + v, 0) / last3.length;
      strategy = 'recent_3mo_mean';
    } else {
      classification = 'IRREGULAR';
      const sorted = [...monthlyAmounts].sort((a, b) => a - b);
      const mid = Math.floor(sorted.length / 2);
      const median = sorted.length % 2 === 0
        ? (sorted[mid - 1] + sorted[mid]) / 2
        : sorted[mid];
      smoothedMonthly = median * frequency;
      strategy = 'frequency_weighted_median';
    }
  }

  const reliabilityScore =
    classification === 'RETAINER'  ? 'GREEN' :
    classification === 'IRREGULAR' ? 'AMBER' :
    classification === 'DECLINING' ? 'RED' :
    classification === 'WINDFALL'  ? 'AMBER' : 'RED';

  const sparkline = buildSparkline(eventsResult.rows, 6);

  return {
    id: source.id, name: source.name, providerName: source.provider_name,
    classification, reliabilityScore,
    smoothedMonthly: Math.round(smoothedMonthly * 100) / 100,
    lastPaidAt: source.last_seen_at, monthsWithIncome, monthsActive,
    mean: Math.round(mean * 100) / 100, stdDev: Math.round(stdDev * 100) / 100,
    strategy, sparkline,
  };
}

// ══════════════════════════════════════════════════════════════════════
// VOLATILITY (unchanged from v2.0)
// ══════════════════════════════════════════════════════════════════════

function calculateVolatility(monthlyTotals) {
  if (monthlyTotals.length < 2) {
    return {
      label: 'STABLE', stdDeviation: 0, minRecentMonth: 0, maxRecentMonth: 0,
      ratio: 0, copy: 'Not enough data to assess income variability yet.',
    };
  }
  const mean = monthlyTotals.reduce((s, v) => s + v, 0) / monthlyTotals.length;
  const variance = monthlyTotals.reduce((s, v) => s + Math.pow(v - mean, 2), 0) / monthlyTotals.length;
  const stdDev = Math.sqrt(variance);
  const ratio = mean > 0 ? stdDev / mean : 0;
  let label;
  if (ratio < VOLATILITY_STABLE_MAX)        label = 'STABLE';
  else if (ratio < VOLATILITY_MODERATE_MAX) label = 'MODERATE';
  else                                       label = 'HIGH';
  const minMonth = Math.min(...monthlyTotals);
  const maxMonth = Math.max(...monthlyTotals);
  const rounded = Math.round(stdDev);
  const copy = `Your monthly income typically varies by ±£${rounded.toLocaleString('en-GB')}/month`;
  return {
    label, stdDeviation: Math.round(stdDev * 100) / 100,
    minRecentMonth: Math.round(minMonth * 100) / 100,
    maxRecentMonth: Math.round(maxMonth * 100) / 100,
    ratio: Math.round(ratio * 1000) / 1000, copy,
  };
}

// ══════════════════════════════════════════════════════════════════════
// HELPERS (unchanged from v2.0)
// ══════════════════════════════════════════════════════════════════════

async function getMonthlyTotals(userId, windowStartStr, windowMonths) {
  const result = await query(
    `SELECT
       DATE_TRUNC('month', income_date) AS month,
       SUM(gross_amount) AS monthly_total
     FROM income_events
     WHERE user_id = $1
       AND income_type IN ('se', 'cis', 'rental', 'dividend')
       AND included_in_smoothing = true
       AND income_date >= $2
       AND income_date < DATE_TRUNC('month', CURRENT_DATE)
     GROUP BY DATE_TRUNC('month', income_date)
     ORDER BY month DESC`,
    [userId, windowStartStr]
  );
  const monthMap = {};
  result.rows.forEach(row => {
    const key = row.month.toISOString().slice(0, 7);
    monthMap[key] = parseFloat(row.monthly_total) || 0;
  });
  const totals = [];
  for (let i = 0; i < windowMonths; i++) {
    const d = new Date();
    d.setMonth(d.getMonth() - i);
    const key = d.toISOString().slice(0, 7);
    totals.push(monthMap[key] || 0);
  }
  return totals;
}

function buildSparkline(eventRows, monthCount) {
  const monthMap = {};
  eventRows.forEach(row => {
    const key = row.month.toISOString().slice(0, 7);
    monthMap[key] = parseFloat(row.monthly_amount) || 0;
  });
  const spark = [];
  for (let i = monthCount - 1; i >= 0; i--) {
    const d = new Date();
    d.setMonth(d.getMonth() - i);
    const key = d.toISOString().slice(0, 7);
    spark.push(Math.round((monthMap[key] || 0) * 100) / 100);
  }
  return spark;
}

async function writePersonalIncome(
  userId, personalIncome, confidenceLevel,
  grossAvgMonthlySE, reserveAmount, monthsOfData
) {
  await query(
    `UPDATE users SET
       personal_income           = $1,
       confidence_level          = $2,
       gross_avg_monthly_se      = $3,
       reserve_amount            = $4,
       months_of_data            = $5,
       last_smoothing_calculated = NOW(),
       updated_at                = NOW()
     WHERE id = $6`,
    [personalIncome, confidenceLevel, grossAvgMonthlySE,
     reserveAmount, monthsOfData, userId]
  );
}

// ══════════════════════════════════════════════════════════════════════
// BUILD API RESPONSE
// ══════════════════════════════════════════════════════════════════════

function buildResult({
  personalIncome, confidenceLevel, grossAvgMonthlySE,
  monthlyTaxAlloc, monthsOfData, windowMonths,
  sources, volatility, monthlyTotals,
  isSeasonallyQuiet = false, nextMonthKey = null,
  fixedMonthlyNet = 0, isLtd = false, ltdBreakdown = null,
}) {
  const monthsUsed = Math.min(monthsOfData, MAX_WINDOW_MONTHS);
  const confidenceCopy = {
    LOW:    `Based on ${monthsOfData} month${monthsOfData === 1 ? '' : 's'} of income data. Accuracy increases significantly at 12 months.`,
    MEDIUM: `Based on your last ${monthsUsed} months of income data. Accuracy increases further at 24 months.`,
    HIGH:   `Based on your last ${monthsUsed} months of income data — high confidence.`,
  }[confidenceLevel];

  const MONTH_NAMES = ['','January','February','March','April','May','June',
    'July','August','September','October','November','December'];

  const result = {
    personal_income:        Math.round(personalIncome * 100) / 100,
    confidence_level:       confidenceLevel,
    confidence_copy:        confidenceCopy,
    months_of_data:         monthsOfData,
    months_used:            monthsUsed,
    window_months:          windowMonths,
    volatility,
    sources: sources.map(s => ({
      id: s.id, name: s.name, provider_name: s.providerName,
      classification: s.classification, reliability_score: s.reliabilityScore,
      smoothed_monthly: s.smoothedMonthly, last_paid_at: s.lastPaidAt,
      months_with_income: s.monthsWithIncome, months_active: s.monthsActive,
      mean: s.mean, std_deviation: s.stdDev, strategy: s.strategy, sparkline: s.sparkline,
    })),
    source_count:           sources.filter(s => s.classification !== 'DORMANT').length,
    active_source_count:    sources.filter(s => s.classification === 'RETAINER' || s.classification === 'IRREGULAR').length,
    gross_avg_monthly_se:   Math.round(grossAvgMonthlySE * 100) / 100,
    monthly_tax_allocation: Math.round(monthlyTaxAlloc * 100) / 100,
    fixed_monthly_net:      Math.round(fixedMonthlyNet * 100) / 100,
    monthly_totals_history: monthlyTotals,
    seasonal_alert: isSeasonallyQuiet ? {
      fires: true,
      month: MONTH_NAMES[nextMonthKey],
      copy:  `Heads up — ${MONTH_NAMES[nextMonthKey]} is typically a quieter month based on seasonal patterns.`,
    } : { fires: false },
    calculated_at:  new Date().toISOString(),
    engine_version: 'ISE v2.1',
  };
  // Attach Ltd-specific breakdown if applicable
  if (isLtd && ltdBreakdown) {
    result.ltd_breakdown = ltdBreakdown;
  }
  return result;
}

// ══════════════════════════════════════════════════════════════════════
// EXPORTS
// ══════════════════════════════════════════════════════════════════════

module.exports = {
  calculatePersonalIncome,
  // Exposed for testing
  calculateVolatility,
  smoothSingleSource,
  corporationTaxAnnual,
  calcSalaryTaxAndNI,
  calcDividendTax,
  computeLtdBreakdown,
};
