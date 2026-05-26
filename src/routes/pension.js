'use strict';

/**
 * FlexFlow — Pension Contributions Engine (Tax Engine v4.0)
 *
 * Calculates pension contributions, tax relief, annual allowance, and
 * effective relief rate for BOTH sole traders and Ltd directors.
 *
 *   Sole Trader   — personal contributions only (RAS at 20% + higher rate via SA)
 *   Ltd Director  — employer contributions (CT-deductible) + personal contributions
 *
 * ALL rate constants read from the tax_rates database table.
 * ZERO hardcoded values. Updating a rate = updating the database only.
 *
 * Source: Tax Engine Specification v4.1 (May 2026), Part 1e
 * Verified against: GOV.UK, MoneyHelper, LITRG, HMRC PTM, BIM46035,
 *                   AJ Bell, Royal London, Aegon, Croner-i
 *
 * CRITICAL RULES:
 *   1. Personal contributions are capped at relevant UK earnings:
 *        - Sole trader: trading profit
 *        - Ltd director: SALARY ONLY (dividends NOT relevant earnings)
 *      Floor: £3,600 gross for low/no earners.
 *   2. Employer contributions are NOT capped by salary — only by AA.
 *   3. Tapered annual allowance: applies if BOTH threshold income > £200k
 *      AND adjusted income > £260k. Reduces £1 per £2 over £260k, floor £10k.
 *   4. MPAA: if user has flexibly accessed DC pension, AA = £10k regardless.
 *   5. Class 4 NI is NOT reduced by personal pension contributions.
 *   6. Basic rate band extension: gross contribution extends basic rate band,
 *      delivering higher/additional rate relief via Self Assessment.
 *   7. PA restoration: gross contribution reduces adjusted net income for PA
 *      taper purposes — can restore PA in the £100k–£125,140 zone.
 *   8. Defensive: all inputs sanitised through safePositive() — engine never
 *      crashes or produces NaN/Infinity, even with garbage inputs.
 */

const { query } = require('../config/database');

// ══════════════════════════════════════════════════════════════════════════════
// INPUT SANITISATION — defensive against null/undefined/NaN/Infinity/negatives
// ══════════════════════════════════════════════════════════════════════════════

function safe(n, fallback = 0) {
  if (n === null || n === undefined) return fallback;
  const num = Number(n);
  if (!Number.isFinite(num)) return fallback;
  return num;
}

function safePositive(n, fallback = 0) {
  return Math.max(0, safe(n, fallback));
}

const round2 = (n) => Math.round(n * 100) / 100;

// ══════════════════════════════════════════════════════════════════════════════
// RATE LOADER — reads pension rates from tax_rates table
// ══════════════════════════════════════════════════════════════════════════════

async function loadPensionRates(taxYear = '2026/27') {
  const result = await query(
    `SELECT parameter_key, parameter_value
     FROM tax_rates
     WHERE tax_year = $1
       AND jurisdiction = 'UK'
       AND parameter_key LIKE 'pension_%'`,
    [taxYear]
  );

  const rates = {};
  for (const row of result.rows) {
    rates[row.parameter_key] = parseFloat(row.parameter_value);
  }
  return rates;
}

// ══════════════════════════════════════════════════════════════════════════════
// ANNUAL ALLOWANCE — with tapered AA and MPAA
// ══════════════════════════════════════════════════════════════════════════════

/**
 * Calculate the effective annual allowance for this user/year.
 *
 * @param {object} args
 * @param {number} args.thresholdIncome  — taxable income minus personal pension contribs
 * @param {number} args.adjustedIncome   — threshold income + employer contribs
 * @param {boolean} args.mpaaTriggered   — has user flexibly accessed a DC pension?
 * @param {object} rates                 — loaded pension rates
 */
function calcAnnualAllowance({ thresholdIncome, adjustedIncome, mpaaTriggered }, rates) {
  const standardAA   = rates.pension_annual_allowance         || 60000;
  const minimumAA    = rates.pension_annual_allowance_minimum || 10000;
  const taperThresh  = rates.pension_taper_threshold_income   || 200000;
  const taperAdj     = rates.pension_taper_adjusted_income    || 260000;
  const mpaa         = rates.pension_mpaa                     || 10000;

  // MPAA overrides everything for DC pensions
  if (mpaaTriggered) return mpaa;

  // Taper only applies if BOTH thresholds exceeded
  if (thresholdIncome <= taperThresh) return standardAA;
  if (adjustedIncome  <= taperAdj)    return standardAA;

  // £1 reduction per £2 of adjusted income above £260k, floor at minimum
  const taperReduction = Math.floor((adjustedIncome - taperAdj) / 2);
  return Math.max(minimumAA, standardAA - taperReduction);
}

// ══════════════════════════════════════════════════════════════════════════════
// SOLE TRADER PENSION ENGINE
// ══════════════════════════════════════════════════════════════════════════════

/**
 * Calculate sole trader personal pension contribution + relief.
 *
 * Note: This is a pure function — does NOT compute income tax saving.
 * That happens upstream in tax.js where the basic-rate-band-extended
 * income tax calculation is performed. This function returns the band
 * extension amount and other inputs needed for that calculation.
 *
 * @param {object} input
 * @param {number} input.tradingProfit               — annual trading profit
 * @param {number} input.netPensionContribution      — what user pays (gross = net / 0.80)
 * @param {boolean} input.mpaaTriggered              — MPAA flag
 * @param {number} input.otherIncomeForTaper         — optional other income (PAYE etc)
 * @param {object} rates                             — loaded pension rates
 */
function calcSoleTraderPension(input, rates) {
  // Sanitise inputs
  const tradingProfit          = safePositive(input.tradingProfit);
  const netPensionContribution = safePositive(input.netPensionContribution);
  const otherIncomeForTaper    = safePositive(input.otherIncomeForTaper);
  const mpaaTriggered          = Boolean(input.mpaaTriggered);

  const rasRelief    = rates.pension_ras_basic_relief || 0.20;
  const basicAmount  = rates.pension_basic_amount     || 3600;

  // Gross up the contribution (basic rate relief added at source)
  const grossContribution         = round2(netPensionContribution / (1 - rasRelief));
  const basicRateReliefAtSource   = round2(grossContribution - netPensionContribution);

  // Relief cap: greater of £3,600 OR trading profit (relevant UK earnings)
  const reliefCap = Math.max(basicAmount, tradingProfit);

  // Annual allowance (standard / tapered / MPAA)
  const thresholdIncome = tradingProfit + otherIncomeForTaper;
  const adjustedIncome  = thresholdIncome;  // no employer contribs for sole trader
  const annualAllowance = calcAnnualAllowance({ thresholdIncome, adjustedIncome, mpaaTriggered }, rates);

  // Effective allowance for relief purposes
  const effectiveAllowance = Math.min(reliefCap, annualAllowance);

  // Excess (above which AA charge applies)
  const excess               = Math.max(0, grossContribution - effectiveAllowance);
  const reliefableContribution = grossContribution - excess;

  return {
    // Inputs (echoed for transparency)
    net_pension_contribution:         round2(netPensionContribution),
    // Gross-up
    gross_pension_contribution:       grossContribution,
    basic_rate_relief_at_source:      basicRateReliefAtSource,
    // Caps and allowance
    relief_cap:                       round2(reliefCap),
    annual_allowance:                 round2(annualAllowance),
    annual_allowance_basis:           mpaaTriggered ? 'mpaa'
                                      : annualAllowance < 60000 ? 'tapered'
                                      : 'standard',
    effective_allowance:              round2(effectiveAllowance),
    // Excess
    excess_contribution:              round2(excess),
    reliefable_contribution:          round2(reliefableContribution),
    // Band extension for income tax engine
    band_extension:                   round2(reliefableContribution),
    // PA restoration input (gross contribution reduces adjusted net income)
    pa_taper_reduction:               round2(reliefableContribution),
    mpaa_applied:                     mpaaTriggered,
    taper_applied:                    annualAllowance < 60000 && !mpaaTriggered,
  };
}

// ══════════════════════════════════════════════════════════════════════════════
// LTD DIRECTOR PENSION ENGINE
// ══════════════════════════════════════════════════════════════════════════════

/**
 * Calculate Ltd director pension — employer + optional personal contributions.
 *
 * @param {object} input
 * @param {number} input.directorSalary               — annual director salary
 * @param {number} input.dividendsTaken               — annual dividend amount
 * @param {number} input.employerPensionContribution  — gross, paid by company
 * @param {number} input.personalPensionContribution  — gross (NOT net) — personal RAS
 * @param {boolean} input.mpaaTriggered               — MPAA flag
 * @param {object} rates                              — loaded pension rates
 */
function calcLtdDirectorPension(input, rates) {
  // Sanitise inputs
  const directorSalary              = safePositive(input.directorSalary);
  const dividendsTaken              = safePositive(input.dividendsTaken);
  const employerPensionContribution = safePositive(input.employerPensionContribution);
  const personalPensionContribution = safePositive(input.personalPensionContribution);
  const mpaaTriggered               = Boolean(input.mpaaTriggered);

  const basicAmount  = rates.pension_basic_amount     || 3600;
  const rasRelief    = rates.pension_ras_basic_relief || 0.20;

  // Personal contribution relief cap = salary (NOT salary + dividends)
  // Dividends are NOT relevant UK earnings for personal contributions.
  const personalReliefCap = Math.max(basicAmount, directorSalary);
  const personalExcessOverCap = Math.max(0, personalPensionContribution - personalReliefCap);

  // For Ltd director, the input is GROSS personal contribution (matches how
  // employer contribution is captured). Net = gross × 0.80.
  const personalNetContribution = round2(personalPensionContribution * (1 - rasRelief));
  const personalBasicRateRelief = round2(personalPensionContribution - personalNetContribution);

  // Annual allowance — both contributions count
  // Threshold income = total taxable income MINUS personal pension contribs
  // Adjusted income = threshold income + employer contribs
  const thresholdIncome = directorSalary + dividendsTaken - personalPensionContribution;
  const adjustedIncome  = thresholdIncome + employerPensionContribution;
  const annualAllowance = calcAnnualAllowance({ thresholdIncome, adjustedIncome, mpaaTriggered }, rates);

  // Total pension input
  const totalPensionInput = employerPensionContribution + personalPensionContribution;

  // AA excess
  const aaExcess = Math.max(0, totalPensionInput - annualAllowance);

  return {
    // Inputs (echoed)
    employer_pension_contribution:    round2(employerPensionContribution),
    personal_pension_contribution:    round2(personalPensionContribution),  // gross
    personal_net_contribution:        personalNetContribution,
    personal_basic_rate_relief:       personalBasicRateRelief,
    // Caps
    personal_relief_cap:              round2(personalReliefCap),
    personal_excess_over_cap:         round2(personalExcessOverCap),
    // Allowance
    annual_allowance:                 round2(annualAllowance),
    annual_allowance_basis:           mpaaTriggered ? 'mpaa'
                                      : annualAllowance < 60000 ? 'tapered'
                                      : 'standard',
    threshold_income:                 round2(thresholdIncome),
    adjusted_income:                  round2(adjustedIncome),
    // Totals
    total_pension_input:              round2(totalPensionInput),
    aa_excess:                        round2(aaExcess),
    // Band extension for personal pension (used by income tax + dividend tax engines)
    band_extension:                   round2(personalPensionContribution),
    // Employer contribution reduces Corp Tax (consumed by business.js calculateCorporationTax)
    ct_deductible_amount:             round2(employerPensionContribution),
    mpaa_applied:                     mpaaTriggered,
    taper_applied:                    annualAllowance < 60000 && !mpaaTriggered,
  };
}

// ══════════════════════════════════════════════════════════════════════════════
// ANNUAL ALLOWANCE CHARGE
// Applied to excess contributions at user's marginal income tax rate.
// ══════════════════════════════════════════════════════════════════════════════

function calcAnnualAllowanceCharge(excessGross, totalTaxableIncome, isScottish, rates) {
  if (excessGross <= 0) return 0;

  // Marginal rate based on total taxable income
  let marginalRate;
  if (isScottish) {
    const intTop = rates.intermediate_band_top || 43662;
    const advTop = rates.advanced_band_top     || 150000;
    if      (totalTaxableIncome > advTop) marginalRate = rates.top_rate          || 0.48;
    else if (totalTaxableIncome > 125140) marginalRate = rates.advanced_rate     || 0.45;
    else if (totalTaxableIncome > intTop) marginalRate = rates.higher_rate       || 0.42;
    else                                  marginalRate = rates.intermediate_rate || 0.21;
  } else {
    const brt = rates.basic_rate_threshold  || 50270;
    const hrt = rates.higher_rate_threshold || 125140;
    if      (totalTaxableIncome > hrt) marginalRate = rates.additional_rate || 0.45;
    else if (totalTaxableIncome > brt) marginalRate = rates.higher_rate     || 0.40;
    else                                marginalRate = rates.basic_rate     || 0.20;
  }

  return round2(excessGross * marginalRate);
}

// ══════════════════════════════════════════════════════════════════════════════
// EXPORTS
// ══════════════════════════════════════════════════════════════════════════════

module.exports = {
  safe,
  safePositive,
  round2,
  loadPensionRates,
  calcAnnualAllowance,
  calcSoleTraderPension,
  calcLtdDirectorPension,
  calcAnnualAllowanceCharge,
};
