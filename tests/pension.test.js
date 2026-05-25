'use strict';

/**
 * FlexFlow — Pension Engine Tests (Tax Engine v4.1)
 *
 * Run with: npm test  (or: node --test tests/pension.test.js)
 *
 * Coverage strategy (curated subset of the 670-case prototype):
 *   Tier 1 — Numerical correctness:        25 cases
 *   Tier 2 — Edge bands & boundaries:      20 cases
 *   Tier 3 — Tapered annual allowance:     15 cases
 *   Tier 4 — MPAA scenarios:                8 cases
 *   Tier 5 — Persona scenarios:            15 cases (real-world named users)
 *   Tier 6 — Adversarial inputs:           15 cases (negative/null/NaN/Infinity)
 *
 * Total: ~98 backend tests
 *
 * These tests exercise the engine functions in isolation (no DB).
 * They validate the pure math against independent calculations.
 *
 * NOTE: The full 670-case sweep lives in the v4.1 spec document and the
 * prototype harness. This file is the production regression suite.
 */

const test   = require('node:test');
const assert = require('node:assert/strict');

const {
  safe,
  safePositive,
  round2,
  calcAnnualAllowance,
  calcSoleTraderPension,
  calcLtdDirectorPension,
  calcAnnualAllowanceCharge,
} = require('../src/engines/pension');

// Pension rates as they would be loaded from the database (post-migration 035)
const RATES = {
  pension_annual_allowance:         60000,
  pension_annual_allowance_minimum: 10000,
  pension_taper_threshold_income:   200000,
  pension_taper_adjusted_income:    260000,
  pension_mpaa:                     10000,
  pension_basic_amount:              3600,
  pension_ras_basic_relief:          0.20,
  // Income tax rates (for AA charge calc)
  basic_rate_threshold:             50270,
  higher_rate_threshold:           125140,
  basic_rate:                        0.20,
  higher_rate:                       0.40,
  additional_rate:                   0.45,
  intermediate_band_top:            43662,
  advanced_band_top:               150000,
  intermediate_rate:                 0.21,
  top_rate:                          0.48,
  advanced_rate:                     0.45,
};

// ═══════════════════════════════════════════════════════════════════════════
// TIER 1 — NUMERICAL CORRECTNESS (25 cases)
// ═══════════════════════════════════════════════════════════════════════════

test('Sole Trader: £30k profit, £4,000 net pension — basic rate', () => {
  const r = calcSoleTraderPension({ tradingProfit: 30000, netPensionContribution: 4000, mpaaTriggered: false }, RATES);
  assert.equal(r.gross_pension_contribution, 5000);
  assert.equal(r.basic_rate_relief_at_source, 1000);
  assert.equal(r.relief_cap, 30000);
  assert.equal(r.annual_allowance, 60000);
  assert.equal(r.effective_allowance, 30000);
  assert.equal(r.excess_contribution, 0);
  assert.equal(r.reliefable_contribution, 5000);
  assert.equal(r.band_extension, 5000);
});

test('Sole Trader: £70k profit, £4,000 net pension — higher rate territory', () => {
  const r = calcSoleTraderPension({ tradingProfit: 70000, netPensionContribution: 4000 }, RATES);
  assert.equal(r.gross_pension_contribution, 5000);
  assert.equal(r.band_extension, 5000); // upstream tax.js will apply this
});

test('Sole Trader: £150k profit, £8,000 net — additional rate, PA wiped', () => {
  const r = calcSoleTraderPension({ tradingProfit: 150000, netPensionContribution: 8000 }, RATES);
  assert.equal(r.gross_pension_contribution, 10000);
  assert.equal(r.relief_cap, 150000);
  assert.equal(r.annual_allowance, 60000);
});

test('Sole Trader: £22k profit, £1,200 net pension', () => {
  const r = calcSoleTraderPension({ tradingProfit: 22000, netPensionContribution: 1200 }, RATES);
  assert.equal(r.gross_pension_contribution, 1500);
  assert.equal(r.relief_cap, 22000);
});

test('Sole Trader: zero profit, £2,880 net (the £3,600 gross floor)', () => {
  const r = calcSoleTraderPension({ tradingProfit: 0, netPensionContribution: 2880 }, RATES);
  assert.equal(r.gross_pension_contribution, 3600);
  assert.equal(r.relief_cap, 3600); // floor applies
  assert.equal(r.effective_allowance, 3600);
});

test('Sole Trader: gross-up arithmetic is exact at varying amounts', () => {
  assert.equal(calcSoleTraderPension({ tradingProfit: 40000, netPensionContribution: 800 }, RATES).gross_pension_contribution, 1000);
  assert.equal(calcSoleTraderPension({ tradingProfit: 40000, netPensionContribution: 2400 }, RATES).gross_pension_contribution, 3000);
  assert.equal(calcSoleTraderPension({ tradingProfit: 40000, netPensionContribution: 4800 }, RATES).gross_pension_contribution, 6000);
  assert.equal(calcSoleTraderPension({ tradingProfit: 40000, netPensionContribution: 8000 }, RATES).gross_pension_contribution, 10000);
});

test('Sole Trader: contribution exceeds AA → excess flagged', () => {
  const r = calcSoleTraderPension({ tradingProfit: 100000, netPensionContribution: 50000 }, RATES);
  assert.equal(r.gross_pension_contribution, 62500);
  assert.equal(r.annual_allowance, 60000);
  assert.equal(r.effective_allowance, 60000);
  assert.equal(r.excess_contribution, 2500);
  assert.equal(r.reliefable_contribution, 60000);
});

test('Sole Trader: contribution exceeds trading profit → cap at profit', () => {
  const r = calcSoleTraderPension({ tradingProfit: 5000, netPensionContribution: 8000 }, RATES);
  assert.equal(r.gross_pension_contribution, 10000);
  assert.equal(r.relief_cap, 5000); // capped at profit (above floor)
  assert.equal(r.effective_allowance, 5000);
  assert.equal(r.excess_contribution, 5000);
});

test('Ltd Director: typical setup — rev £100k, salary £12,570, dividends, employer pension £20k', () => {
  const r = calcLtdDirectorPension({
    directorSalary: 12570, dividendsTaken: 30000,
    employerPensionContribution: 20000, personalPensionContribution: 0,
  }, RATES);
  assert.equal(r.employer_pension_contribution, 20000);
  assert.equal(r.personal_pension_contribution, 0);
  assert.equal(r.personal_relief_cap, 12570);
  assert.equal(r.annual_allowance, 60000);
  assert.equal(r.total_pension_input, 20000);
  assert.equal(r.aa_excess, 0);
  assert.equal(r.ct_deductible_amount, 20000);
});

test('Ltd Director: max employer pension at annual allowance', () => {
  const r = calcLtdDirectorPension({
    directorSalary: 12570, dividendsTaken: 40000,
    employerPensionContribution: 60000, personalPensionContribution: 0,
  }, RATES);
  assert.equal(r.total_pension_input, 60000);
  assert.equal(r.aa_excess, 0);
});

test('Ltd Director: employer pension OVER annual allowance', () => {
  const r = calcLtdDirectorPension({
    directorSalary: 12570, dividendsTaken: 0,
    employerPensionContribution: 75000, personalPensionContribution: 0,
  }, RATES);
  assert.equal(r.total_pension_input, 75000);
  assert.equal(r.aa_excess, 15000);
});

test('Ltd Director: personal contribution capped at salary (NOT salary + dividends)', () => {
  const r = calcLtdDirectorPension({
    directorSalary: 12570, dividendsTaken: 50000,
    employerPensionContribution: 0, personalPensionContribution: 30000,
  }, RATES);
  assert.equal(r.personal_relief_cap, 12570);
  assert.equal(r.personal_excess_over_cap, 17430); // 30000 - 12570
});

test('Ltd Director: combined employer + personal contributions', () => {
  const r = calcLtdDirectorPension({
    directorSalary: 12570, dividendsTaken: 30000,
    employerPensionContribution: 30000, personalPensionContribution: 10000,
  }, RATES);
  assert.equal(r.total_pension_input, 40000);
  assert.equal(r.aa_excess, 0);
});

test('Ltd Director: combined contributions hit annual allowance', () => {
  const r = calcLtdDirectorPension({
    directorSalary: 12570, dividendsTaken: 30000,
    employerPensionContribution: 50000, personalPensionContribution: 12570,
  }, RATES);
  assert.equal(r.total_pension_input, 62570);
  assert.equal(r.aa_excess, 2570);
});

test('AA calc: standard £60k applies below taper thresholds', () => {
  assert.equal(calcAnnualAllowance({ thresholdIncome: 100000, adjustedIncome: 150000, mpaaTriggered: false }, RATES), 60000);
});

test('AA calc: standard £60k when only threshold income exceeds (need both)', () => {
  assert.equal(calcAnnualAllowance({ thresholdIncome: 250000, adjustedIncome: 250000, mpaaTriggered: false }, RATES), 60000);
});

test('AA calc: standard £60k when only adjusted income exceeds (need both)', () => {
  assert.equal(calcAnnualAllowance({ thresholdIncome: 199000, adjustedIncome: 280000, mpaaTriggered: false }, RATES), 60000);
});

test('AA calc: taper kicks in when both thresholds exceeded', () => {
  // AI £280k, taper = (280k - 260k)/2 = £10k → AA = 60k - 10k = £50k
  assert.equal(calcAnnualAllowance({ thresholdIncome: 210000, adjustedIncome: 280000, mpaaTriggered: false }, RATES), 50000);
});

test('AA calc: taper to floor at £360k adjusted income', () => {
  assert.equal(calcAnnualAllowance({ thresholdIncome: 250000, adjustedIncome: 360000, mpaaTriggered: false }, RATES), 10000);
});

test('AA calc: taper below floor stays at floor', () => {
  assert.equal(calcAnnualAllowance({ thresholdIncome: 500000, adjustedIncome: 500000, mpaaTriggered: false }, RATES), 10000);
});

test('AA calc: MPAA overrides everything', () => {
  assert.equal(calcAnnualAllowance({ thresholdIncome: 30000, adjustedIncome: 30000, mpaaTriggered: true }, RATES), 10000);
  assert.equal(calcAnnualAllowance({ thresholdIncome: 500000, adjustedIncome: 500000, mpaaTriggered: true }, RATES), 10000);
});

test('AA charge: 0 when no excess', () => {
  assert.equal(calcAnnualAllowanceCharge(0, 50000, false, RATES), 0);
});

test('AA charge: basic rate when below £50k taxable', () => {
  assert.equal(calcAnnualAllowanceCharge(1000, 40000, false, RATES), 200);
});

test('AA charge: higher rate when above £50k', () => {
  assert.equal(calcAnnualAllowanceCharge(1000, 80000, false, RATES), 400);
});

test('AA charge: additional rate when above £125k', () => {
  assert.equal(calcAnnualAllowanceCharge(1000, 140000, false, RATES), 450);
});

test('AA charge: Scottish top rate', () => {
  assert.equal(calcAnnualAllowanceCharge(1000, 200000, true, RATES), 480);
});

// ═══════════════════════════════════════════════════════════════════════════
// TIER 2 — EDGE BANDS & BOUNDARIES (20 cases)
// ═══════════════════════════════════════════════════════════════════════════

test('Edge: profit £12,570 (PA exactly)', () => {
  const r = calcSoleTraderPension({ tradingProfit: 12570, netPensionContribution: 800 }, RATES);
  assert.equal(r.gross_pension_contribution, 1000);
  assert.equal(r.relief_cap, 12570);
});

test('Edge: profit £12,571 (£1 over PA)', () => {
  const r = calcSoleTraderPension({ tradingProfit: 12571, netPensionContribution: 800 }, RATES);
  assert.equal(r.relief_cap, 12571);
});

test('Edge: profit £50,269 (£1 under higher rate)', () => {
  const r = calcSoleTraderPension({ tradingProfit: 50269, netPensionContribution: 800 }, RATES);
  assert.equal(r.relief_cap, 50269);
});

test('Edge: profit £50,270 (exactly at higher rate threshold)', () => {
  const r = calcSoleTraderPension({ tradingProfit: 50270, netPensionContribution: 800 }, RATES);
  assert.equal(r.relief_cap, 50270);
});

test('Edge: profit £50,271 (£1 into higher rate)', () => {
  const r = calcSoleTraderPension({ tradingProfit: 50271, netPensionContribution: 800 }, RATES);
  assert.equal(r.relief_cap, 50271);
});

test('Edge: profit £100,000 (exactly at PA taper start)', () => {
  const r = calcSoleTraderPension({ tradingProfit: 100000, netPensionContribution: 8000 }, RATES);
  assert.equal(r.gross_pension_contribution, 10000);
});

test('Edge: profit £125,140 (PA wipeout point)', () => {
  const r = calcSoleTraderPension({ tradingProfit: 125140, netPensionContribution: 8000 }, RATES);
  assert.equal(r.gross_pension_contribution, 10000);
});

test('Edge: profit £200,000 (taper boundary, no taper yet)', () => {
  const r = calcSoleTraderPension({ tradingProfit: 200000, netPensionContribution: 40000 }, RATES);
  assert.equal(r.annual_allowance, 60000);
});

test('Edge: profit £200,001 (£1 over threshold, but AI still ≤£260k, no taper)', () => {
  const r = calcSoleTraderPension({ tradingProfit: 200001, netPensionContribution: 40000 }, RATES);
  assert.equal(r.annual_allowance, 60000);
});

test('Edge: profit £260,001 (over adjusted income threshold)', () => {
  const r = calcSoleTraderPension({ tradingProfit: 260001, netPensionContribution: 40000 }, RATES);
  // taper = floor((260001-260000)/2) = 0 → AA still 60000
  assert.equal(r.annual_allowance, 60000);
});

test('Edge: profit £260,002 (taper of £1)', () => {
  const r = calcSoleTraderPension({ tradingProfit: 260002, netPensionContribution: 40000 }, RATES);
  // taper = floor((260002-260000)/2) = 1 → AA = 59999
  assert.equal(r.annual_allowance, 59999);
});

test('Edge: net pension £0.01 (rounding edge — does not crash)', () => {
  const r = calcSoleTraderPension({ tradingProfit: 30000, netPensionContribution: 0.01 }, RATES);
  assert.ok(Number.isFinite(r.gross_pension_contribution));
  assert.ok(r.gross_pension_contribution >= 0);
});

test('Edge: floating point precision profit', () => {
  const r = calcSoleTraderPension({ tradingProfit: 12570.999999, netPensionContribution: 1000.456 }, RATES);
  assert.ok(Number.isFinite(r.gross_pension_contribution));
  assert.ok(r.gross_pension_contribution > 0);
});

test('Ltd Edge: salary £0, employer pension £60k', () => {
  const r = calcLtdDirectorPension({
    directorSalary: 0, dividendsTaken: 0,
    employerPensionContribution: 60000, personalPensionContribution: 0,
  }, RATES);
  assert.equal(r.personal_relief_cap, 3600); // floor applies
  assert.equal(r.total_pension_input, 60000);
  assert.equal(r.aa_excess, 0);
});

test('Ltd Edge: salary £125,140 (additional rate director, max AA)', () => {
  const r = calcLtdDirectorPension({
    directorSalary: 125140, dividendsTaken: 0,
    employerPensionContribution: 0, personalPensionContribution: 60000,
  }, RATES);
  assert.equal(r.personal_relief_cap, 125140);
  assert.equal(r.aa_excess, 0);
});

test('Ltd Edge: salary at small-profits boundary AI', () => {
  const r = calcLtdDirectorPension({
    directorSalary: 50270, dividendsTaken: 9730,
    employerPensionContribution: 0, personalPensionContribution: 0,
  }, RATES);
  assert.equal(r.threshold_income, 60000);
});

test('Edge: AA charge boundary at £50,270', () => {
  // £50,270 = exactly at higher rate threshold → still basic rate by < check
  assert.equal(calcAnnualAllowanceCharge(1000, 50270, false, RATES), 200);
  assert.equal(calcAnnualAllowanceCharge(1000, 50271, false, RATES), 400);
});

test('Edge: AA charge boundary at £125,140', () => {
  assert.equal(calcAnnualAllowanceCharge(1000, 125140, false, RATES), 400);
  assert.equal(calcAnnualAllowanceCharge(1000, 125141, false, RATES), 450);
});

test('Edge: very small net contribution (£1)', () => {
  const r = calcSoleTraderPension({ tradingProfit: 30000, netPensionContribution: 1 }, RATES);
  assert.equal(r.gross_pension_contribution, 1.25);
});

test('Edge: contribution exactly at annual allowance', () => {
  const r = calcSoleTraderPension({ tradingProfit: 100000, netPensionContribution: 48000 }, RATES);
  assert.equal(r.gross_pension_contribution, 60000);
  assert.equal(r.excess_contribution, 0);
});

// ═══════════════════════════════════════════════════════════════════════════
// TIER 3 — TAPERED ANNUAL ALLOWANCE (15 cases)
// ═══════════════════════════════════════════════════════════════════════════

test('Taper: ST profit £280k → AA = £50k', () => {
  const r = calcSoleTraderPension({ tradingProfit: 280000, netPensionContribution: 40000 }, RATES);
  assert.equal(r.annual_allowance, 50000);
  assert.equal(r.annual_allowance_basis, 'tapered');
});

test('Taper: ST profit £300k → AA = £40k', () => {
  const r = calcSoleTraderPension({ tradingProfit: 300000, netPensionContribution: 40000 }, RATES);
  assert.equal(r.annual_allowance, 40000);
});

test('Taper: ST profit £350k → AA = £15k', () => {
  const r = calcSoleTraderPension({ tradingProfit: 350000, netPensionContribution: 40000 }, RATES);
  assert.equal(r.annual_allowance, 15000);
});

test('Taper: ST profit £359,998 → AA = £10,001 (£1 above floor)', () => {
  const r = calcSoleTraderPension({ tradingProfit: 359998, netPensionContribution: 40000 }, RATES);
  // taper = (359998-260000)/2 = 49999 → AA = 60000 - 49999 = 10001
  assert.equal(r.annual_allowance, 10001);
});

test('Taper: ST profit £360k → AA = £10k (exactly at floor)', () => {
  const r = calcSoleTraderPension({ tradingProfit: 360000, netPensionContribution: 40000 }, RATES);
  assert.equal(r.annual_allowance, 10000);
});

test('Taper: ST profit £500k → AA = £10k (floor holds)', () => {
  const r = calcSoleTraderPension({ tradingProfit: 500000, netPensionContribution: 40000 }, RATES);
  assert.equal(r.annual_allowance, 10000);
});

test('Taper: ST profit £1m → AA = £10k', () => {
  const r = calcSoleTraderPension({ tradingProfit: 1000000, netPensionContribution: 40000 }, RATES);
  assert.equal(r.annual_allowance, 10000);
});

test('Taper: Ltd director high dividends pulls into taper', () => {
  // AI = 12570 + 280000 + 50000 = 342570 → taper = (342570-260000)/2 = 41285 → AA = 18715
  const r = calcLtdDirectorPension({
    directorSalary: 12570, dividendsTaken: 280000,
    employerPensionContribution: 50000, personalPensionContribution: 0,
  }, RATES);
  assert.equal(r.annual_allowance, 18715);
});

test('Taper: Ltd director, exactly at £260k adjusted income', () => {
  const r = calcLtdDirectorPension({
    directorSalary: 12570, dividendsTaken: 247430,
    employerPensionContribution: 0, personalPensionContribution: 0,
  }, RATES);
  // AI = 12570 + 247430 - 0 + 0 = 260000 → exactly at threshold, NO taper
  assert.equal(r.annual_allowance, 60000);
});

test('Taper: Ltd director, AI £260,002 (£2 over) → AA = £59,999', () => {
  const r = calcLtdDirectorPension({
    directorSalary: 12570, dividendsTaken: 247432,
    employerPensionContribution: 0, personalPensionContribution: 0,
  }, RATES);
  assert.equal(r.annual_allowance, 59999);
});

test('Taper: Ltd director, personal contribution reduces threshold income', () => {
  // Threshold = 12570 + 250000 - 50000 = 212570 (above 200k, taper applies)
  // Adjusted = 212570 + 0 = 212570 (below 260k, NO actual taper)
  const r = calcLtdDirectorPension({
    directorSalary: 12570, dividendsTaken: 250000,
    employerPensionContribution: 0, personalPensionContribution: 50000,
  }, RATES);
  assert.equal(r.annual_allowance, 60000);
});

test('Taper: Ltd director, employer pension counts toward adjusted income', () => {
  // Threshold = 12570 + 270000 - 0 = 282570 (over 200k)
  // Adjusted = 282570 + 30000 = 312570 (over 260k → taper)
  // taper = (312570 - 260000) / 2 = 26285 → AA = 33715
  const r = calcLtdDirectorPension({
    directorSalary: 12570, dividendsTaken: 270000,
    employerPensionContribution: 30000, personalPensionContribution: 0,
  }, RATES);
  assert.equal(r.annual_allowance, 33715);
});

test('Taper: ST tapered AA produces excess if over allowance', () => {
  const r = calcSoleTraderPension({ tradingProfit: 350000, netPensionContribution: 32000 }, RATES);
  assert.equal(r.gross_pension_contribution, 40000);
  assert.equal(r.annual_allowance, 15000);
  assert.equal(r.excess_contribution, 25000);
});

test('Taper: basis flag is "tapered" when taper applies', () => {
  const r = calcSoleTraderPension({ tradingProfit: 300000, netPensionContribution: 40000 }, RATES);
  assert.equal(r.annual_allowance_basis, 'tapered');
  assert.equal(r.taper_applied, true);
});

test('Taper: basis flag is "standard" when below thresholds', () => {
  const r = calcSoleTraderPension({ tradingProfit: 80000, netPensionContribution: 8000 }, RATES);
  assert.equal(r.annual_allowance_basis, 'standard');
  assert.equal(r.taper_applied, false);
});

// ═══════════════════════════════════════════════════════════════════════════
// TIER 4 — MPAA SCENARIOS (8 cases)
// ═══════════════════════════════════════════════════════════════════════════

test('MPAA: ST contribution within £10k limit', () => {
  const r = calcSoleTraderPension({ tradingProfit: 50000, netPensionContribution: 7200, mpaaTriggered: true }, RATES);
  assert.equal(r.gross_pension_contribution, 9000);
  assert.equal(r.annual_allowance, 10000);
  assert.equal(r.excess_contribution, 0);
});

test('MPAA: ST contribution exactly at £10k', () => {
  const r = calcSoleTraderPension({ tradingProfit: 50000, netPensionContribution: 8000, mpaaTriggered: true }, RATES);
  assert.equal(r.gross_pension_contribution, 10000);
  assert.equal(r.excess_contribution, 0);
});

test('MPAA: ST contribution £1 over £10k', () => {
  const r = calcSoleTraderPension({ tradingProfit: 50000, netPensionContribution: 8001, mpaaTriggered: true }, RATES);
  assert.equal(r.excess_contribution, 1.25);
});

test('MPAA: ST contribution well above £10k', () => {
  const r = calcSoleTraderPension({ tradingProfit: 100000, netPensionContribution: 20000, mpaaTriggered: true }, RATES);
  assert.equal(r.gross_pension_contribution, 25000);
  assert.equal(r.annual_allowance, 10000);
  assert.equal(r.excess_contribution, 15000);
});

test('MPAA: high earner — MPAA overrides taper', () => {
  // Would have been tapered to £10k anyway, but MPAA fixes at £10k regardless
  const r = calcSoleTraderPension({ tradingProfit: 30000, netPensionContribution: 8000, mpaaTriggered: true }, RATES);
  assert.equal(r.annual_allowance, 10000);
  assert.equal(r.annual_allowance_basis, 'mpaa');
});

test('MPAA: Ltd director with employer pension', () => {
  const r = calcLtdDirectorPension({
    directorSalary: 12570, dividendsTaken: 50000,
    employerPensionContribution: 8000, personalPensionContribution: 0,
    mpaaTriggered: true,
  }, RATES);
  assert.equal(r.annual_allowance, 10000);
  assert.equal(r.aa_excess, 0);
});

test('MPAA: Ltd combined employer + personal exceeds £10k', () => {
  const r = calcLtdDirectorPension({
    directorSalary: 12570, dividendsTaken: 30000,
    employerPensionContribution: 5000, personalPensionContribution: 6000,
    mpaaTriggered: true,
  }, RATES);
  assert.equal(r.total_pension_input, 11000);
  assert.equal(r.aa_excess, 1000);
});

test('MPAA: basis flag is "mpaa"', () => {
  const r = calcSoleTraderPension({ tradingProfit: 50000, netPensionContribution: 4000, mpaaTriggered: true }, RATES);
  assert.equal(r.annual_allowance_basis, 'mpaa');
  assert.equal(r.mpaa_applied, true);
});

// ═══════════════════════════════════════════════════════════════════════════
// TIER 5 — PERSONA SCENARIOS (15 cases)
// ═══════════════════════════════════════════════════════════════════════════

test('Persona: Sarah — graphic designer, £38k basic rate', () => {
  const r = calcSoleTraderPension({ tradingProfit: 38000, netPensionContribution: 2400 }, RATES);
  assert.equal(r.gross_pension_contribution, 3000);
  assert.equal(r.annual_allowance_basis, 'standard');
});

test('Persona: Mike — plumber, £62k higher rate', () => {
  const r = calcSoleTraderPension({ tradingProfit: 62000, netPensionContribution: 5000 }, RATES);
  assert.equal(r.gross_pension_contribution, 6250);
});

test('Persona: Aisha — Scottish freelancer, £35k intermediate', () => {
  const r = calcSoleTraderPension({ tradingProfit: 35000, netPensionContribution: 2400 }, RATES);
  assert.equal(r.gross_pension_contribution, 3000);
});

test('Persona: Caroline — late career, MPAA triggered', () => {
  const r = calcSoleTraderPension({ tradingProfit: 42000, netPensionContribution: 4800, mpaaTriggered: true }, RATES);
  assert.equal(r.gross_pension_contribution, 6000);
  assert.equal(r.annual_allowance, 10000);
  assert.equal(r.excess_contribution, 0);
});

test('Persona: David — top-rate solicitor, taper territory', () => {
  const r = calcSoleTraderPension({ tradingProfit: 280000, netPensionContribution: 40000 }, RATES);
  assert.equal(r.annual_allowance, 50000);
  assert.equal(r.excess_contribution, 0);
});

test('Persona: Priya — part-time, below £3,600 floor', () => {
  const r = calcSoleTraderPension({ tradingProfit: 2400, netPensionContribution: 2880 }, RATES);
  assert.equal(r.gross_pension_contribution, 3600);
  assert.equal(r.relief_cap, 3600);
  assert.equal(r.excess_contribution, 0);
});

test('Persona: Priya Ltd — consultant, employer pension £20k', () => {
  const r = calcLtdDirectorPension({
    directorSalary: 12570, dividendsTaken: 50000,
    employerPensionContribution: 20000, personalPensionContribution: 0,
  }, RATES);
  assert.equal(r.ct_deductible_amount, 20000);
  assert.equal(r.aa_excess, 0);
});

test('Persona: James Ltd — contractor max employer pension', () => {
  const r = calcLtdDirectorPension({
    directorSalary: 12570, dividendsTaken: 40000,
    employerPensionContribution: 60000, personalPensionContribution: 0,
  }, RATES);
  assert.equal(r.total_pension_input, 60000);
  assert.equal(r.aa_excess, 0);
});

test('Persona: Sophie Ltd — high dividends approaching taper', () => {
  const r = calcLtdDirectorPension({
    directorSalary: 12570, dividendsTaken: 200000,
    employerPensionContribution: 30000, personalPensionContribution: 0,
  }, RATES);
  // Threshold = 12570 + 200000 = 212570 (over 200k)
  // Adjusted = 212570 + 30000 = 242570 (under 260k → no taper)
  assert.equal(r.annual_allowance, 60000);
});

test('Persona: Helen Ltd — solicitor higher salary + employer pension', () => {
  const r = calcLtdDirectorPension({
    directorSalary: 50000, dividendsTaken: 50000,
    employerPensionContribution: 30000, personalPensionContribution: 0,
  }, RATES);
  assert.equal(r.aa_excess, 0);
});

test('Persona: Anita Ltd — surgeon, tapered AA territory', () => {
  const r = calcLtdDirectorPension({
    directorSalary: 50270, dividendsTaken: 200000,
    employerPensionContribution: 60000, personalPensionContribution: 0,
  }, RATES);
  // Threshold = 50270 + 200000 = 250270 (over 200k)
  // Adjusted = 250270 + 60000 = 310270 (over 260k)
  // Taper = (310270 - 260000) / 2 = 25135 → AA = 34865
  assert.equal(r.annual_allowance, 34865);
});

test('Persona: Both Ltd 1 — combined personal + employer', () => {
  const r = calcLtdDirectorPension({
    directorSalary: 12570, dividendsTaken: 70000,
    employerPensionContribution: 30000, personalPensionContribution: 10000,
  }, RATES);
  assert.equal(r.total_pension_input, 40000);
  assert.equal(r.aa_excess, 0);
  assert.equal(r.personal_relief_cap, 12570);
  assert.equal(r.personal_excess_over_cap, 0); // 10000 < 12570
});

test('Persona: Both Ltd 2 — personal at salary cap', () => {
  const r = calcLtdDirectorPension({
    directorSalary: 12570, dividendsTaken: 70000,
    employerPensionContribution: 35000, personalPensionContribution: 12570,
  }, RATES);
  assert.equal(r.personal_excess_over_cap, 0); // exactly at cap
});

test('Persona: Scottish Ltd Aberdeen — top rate director', () => {
  const r = calcLtdDirectorPension({
    directorSalary: 50000, dividendsTaken: 100000,
    employerPensionContribution: 50000, personalPensionContribution: 0,
  }, RATES);
  // Threshold = 50000 + 100000 = 150000 (under 200k) → no taper
  assert.equal(r.annual_allowance, 60000);
});

test('Persona: MPAA Ltd — director drawing pension already', () => {
  const r = calcLtdDirectorPension({
    directorSalary: 12570, dividendsTaken: 50000,
    employerPensionContribution: 8000, personalPensionContribution: 0,
    mpaaTriggered: true,
  }, RATES);
  assert.equal(r.annual_allowance, 10000);
  assert.equal(r.aa_excess, 0);
});

// ═══════════════════════════════════════════════════════════════════════════
// TIER 6 — ADVERSARIAL INPUTS (15 cases)
// ═══════════════════════════════════════════════════════════════════════════

test('Adversarial: safe() handles null', () => {
  assert.equal(safe(null), 0);
  assert.equal(safe(null, 42), 42);
});

test('Adversarial: safe() handles undefined', () => {
  assert.equal(safe(undefined), 0);
});

test('Adversarial: safe() handles NaN', () => {
  assert.equal(safe(NaN), 0);
});

test('Adversarial: safe() handles Infinity', () => {
  assert.equal(safe(Infinity), 0);
  assert.equal(safe(-Infinity), 0);
});

test('Adversarial: safePositive() clamps negatives to 0', () => {
  assert.equal(safePositive(-1000), 0);
  assert.equal(safePositive(-0.5), 0);
});

test('Adversarial: safePositive() handles strings', () => {
  assert.equal(safePositive('100'), 100);  // numeric string OK
  assert.equal(safePositive('abc'), 0);    // non-numeric → 0
});

test('Adversarial: ST engine handles negative trading profit', () => {
  const r = calcSoleTraderPension({ tradingProfit: -5000, netPensionContribution: 2000 }, RATES);
  assert.ok(Number.isFinite(r.gross_pension_contribution));
  assert.ok(r.gross_pension_contribution >= 0);
  assert.equal(r.relief_cap, 3600);
});

test('Adversarial: ST engine handles null trading profit', () => {
  const r = calcSoleTraderPension({ tradingProfit: null, netPensionContribution: 2000 }, RATES);
  assert.ok(Number.isFinite(r.annual_allowance));
});

test('Adversarial: ST engine handles NaN profit', () => {
  const r = calcSoleTraderPension({ tradingProfit: NaN, netPensionContribution: 2000 }, RATES);
  assert.ok(Number.isFinite(r.annual_allowance));
  assert.ok(Number.isFinite(r.gross_pension_contribution));
});

test('Adversarial: ST engine handles Infinity profit', () => {
  const r = calcSoleTraderPension({ tradingProfit: Infinity, netPensionContribution: 2000 }, RATES);
  assert.ok(Number.isFinite(r.gross_pension_contribution));
});

test('Adversarial: ST engine handles negative pension contribution', () => {
  const r = calcSoleTraderPension({ tradingProfit: 30000, netPensionContribution: -1000 }, RATES);
  assert.equal(r.gross_pension_contribution, 0);
  assert.equal(r.basic_rate_relief_at_source, 0);
});

test('Adversarial: ST engine handles undefined pension contribution', () => {
  const r = calcSoleTraderPension({ tradingProfit: 30000, netPensionContribution: undefined }, RATES);
  assert.equal(r.gross_pension_contribution, 0);
});

test('Adversarial: Ltd engine handles all-zero inputs', () => {
  const r = calcLtdDirectorPension({
    directorSalary: 0, dividendsTaken: 0,
    employerPensionContribution: 0, personalPensionContribution: 0,
  }, RATES);
  assert.equal(r.total_pension_input, 0);
  assert.equal(r.aa_excess, 0);
  assert.equal(r.annual_allowance, 60000);
});

test('Adversarial: Ltd engine handles negative dividends', () => {
  const r = calcLtdDirectorPension({
    directorSalary: 12570, dividendsTaken: -50000,
    employerPensionContribution: 10000, personalPensionContribution: 0,
  }, RATES);
  assert.ok(Number.isFinite(r.annual_allowance));
  assert.equal(r.aa_excess, 0);
});

test('Adversarial: Ltd engine handles massive contributions', () => {
  const r = calcLtdDirectorPension({
    directorSalary: 12570, dividendsTaken: 0,
    employerPensionContribution: 500000, personalPensionContribution: 0,
  }, RATES);
  assert.ok(Number.isFinite(r.aa_excess));
  assert.equal(r.aa_excess, 440000);  // 500000 - 60000
});

// ═══════════════════════════════════════════════════════════════════════════
// HELPER TESTS — round2 + general sanity
// ═══════════════════════════════════════════════════════════════════════════

test('Helper: round2() rounds to 2dp', () => {
  assert.equal(round2(1.235), 1.24);
  assert.equal(round2(1.234), 1.23);
  assert.equal(round2(0), 0);
  assert.equal(round2(-1.234), -1.23); // negative rounding behaves as expected
});

test('Sanity: no NaN escapes any persona scenario', () => {
  const personas = [
    { tradingProfit: 38000,  netPensionContribution: 2400 },
    { tradingProfit: 62000,  netPensionContribution: 5000 },
    { tradingProfit: 150000, netPensionContribution: 24000 },
    { tradingProfit: 280000, netPensionContribution: 40000 },
  ];
  for (const p of personas) {
    const r = calcSoleTraderPension(p, RATES);
    for (const [k, v] of Object.entries(r)) {
      if (typeof v === 'number') {
        assert.ok(Number.isFinite(v), `${k} is not finite: ${v}`);
      }
    }
  }
});
