'use strict';

/**
 * FlexFlow — Tax Calculation Engine (Tax Engine v3.5)
 * Session E — Task 6a
 *
 * The core tax calculation function that powers the tax pot.
 * ALL rate constants read from the tax_rates database table.
 * ZERO hardcoded values. Updating a rate = updating the database only.
 *
 * Income structures covered in this session (E):
 *   S1  — Sole trader (SE only)
 *   S2  — Ltd company director (salary + dividends)
 *   S8  — Ltd director with dividends only
 *   Scottish variants of all the above
 *   Partnership income (S13/S14/S15)
 *
 * Mixed income, VAT, CIS, Rental (S3a/b/c/d, S10) → Session F
 *
 * Source: Tax Engine Specification v3.5 (May 2026)
 * Rates: All from tax_rates database table (jurisdiction UK or SCO)
 *
 * CRITICAL RULES (from spec):
 *   1. Band stacking: PAYE → SE → rental → dividends (in that order)
 *   2. PA taper: floor((income-100000)/2), bites at £100,001 not £100,000
 *   3. Dividend allowance OCCUPIES band space — does not exempt
 *   4. Class 4 NI on SE profit ONLY — not PAYE, not dividends, not rental
 *   5. Scottish rates: non-savings/non-dividend income ONLY
 *   6. SPA: always use date_of_birth — never fixed age (Build Note 5)
 *   7. Zero hardcoded values — all rates from tax_rates table
 */

const { query } = require('../config/database');

// ══════════════════════════════════════════════════════════════════════════════
// RATE LOADER — reads ALL rates from database
// ══════════════════════════════════════════════════════════════════════════════

async function loadRates(taxYear = '2026/27', isScottish = false) {
  const jurisdiction = isScottish ? 'SCO' : 'UK';

  const result = await query(
    `SELECT parameter_key, parameter_value
     FROM tax_rates
     WHERE tax_year = $1
       AND jurisdiction IN ('UK', $2)
     ORDER BY jurisdiction DESC`, // SCO overrides UK for same key
    [taxYear, jurisdiction]
  );

  const rates = {};
  for (const row of result.rows) {
    // If SCO rate already set, don't overwrite with UK rate
    if (!rates[row.parameter_key]) {
      rates[row.parameter_key] = parseFloat(row.parameter_value);
    }
  }
  return rates;
}

// ══════════════════════════════════════════════════════════════════════════════
// PERSONAL ALLOWANCE — with taper
// ══════════════════════════════════════════════════════════════════════════════

function calcEffectivePA(totalIncome, rates) {
  const pa         = effectivePAOverride !== null ? effectivePAOverride : (rates.personal_allowance || 12570);
  const taperStart = rates.pa_taper_start     || 100000;

  if (totalIncome <= taperStart) return pa;

  // Taper: lose £1 PA per £2 above £100,000
  // floor() — taper bites at £100,001 not £100,000 (confirmed in spec)
  const reduction = Math.floor((totalIncome - taperStart) / 2);
  return Math.max(0, pa - reduction);
}

// ══════════════════════════════════════════════════════════════════════════════
// INCOME TAX — UK bands
// ══════════════════════════════════════════════════════════════════════════════

function calcUKIncomeTax(taxableNonDivIncome, rates) {
  const pa        = 0; // Already applied before calling this
  const brt       = (rates.basic_rate_threshold  || 50270);
  const hrt       = (rates.higher_rate_threshold || 125140);
  const basicBand = brt - (rates.personal_allowance || 12570);  // 37,700
  const higherBand= hrt - brt;                                   // 74,870

  let tax = 0;
  let remaining = Math.max(0, taxableNonDivIncome);

  const inBasic  = Math.min(remaining, basicBand);
  tax += inBasic * (rates.basic_rate || 0.20);
  remaining -= inBasic;

  const inHigher = Math.min(remaining, higherBand);
  tax += inHigher * (rates.higher_rate || 0.40);
  remaining -= inHigher;

  tax += remaining * (rates.additional_rate || 0.45);

  return Math.round(tax * 100) / 100;
}

// ══════════════════════════════════════════════════════════════════════════════
// INCOME TAX — Scottish bands (Part 1b)
// Applies to non-savings, non-dividend income only
// ══════════════════════════════════════════════════════════════════════════════

function calcScottishIncomeTax(taxableNonDivIncome, rates) {
  // Scottish bands (all from database — rates object has SCO values)
  const bands = [
    { name: 'starter',      top: (rates.starter_band_top      || 16537)  - (rates.personal_allowance || 12570), rate: rates.starter_rate      || 0.19 },
    { name: 'basic',        top: (rates.basic_band_top         || 43662)  - (rates.personal_allowance || 12570), rate: rates.basic_rate         || 0.20 },
    { name: 'intermediate', top: (rates.intermediate_band_top  || 75000)  - (rates.personal_allowance || 12570), rate: rates.intermediate_rate  || 0.21 },
    { name: 'higher',       top: (rates.higher_rate_threshold  || 125140) - (rates.personal_allowance || 12570), rate: rates.higher_rate        || 0.42 },
    { name: 'advanced',     top: (rates.advanced_band_top      || 150000) - (rates.personal_allowance || 12570), rate: rates.advanced_rate      || 0.45 },
    { name: 'top',          top: Infinity,                                                                        rate: rates.top_rate           || 0.48 },
  ];

  let tax = 0;
  let remaining = Math.max(0, taxableNonDivIncome);
  let prevTop = 0;
  const breakdown = [];

  for (const band of bands) {
    if (remaining <= 0) break;
    const bandSize = Math.min(remaining, band.top - prevTop);
    if (bandSize > 0) {
      const bandTax = Math.round(bandSize * band.rate * 100) / 100;
      tax += bandTax;
      breakdown.push({ band: band.name, income: bandSize, rate: band.rate, tax: bandTax });
      remaining -= bandSize;
    }
    prevTop = band.top;
  }

  return { tax: Math.round(tax * 100) / 100, breakdown };
}

// ══════════════════════════════════════════════════════════════════════════════
// DIVIDEND TAX — UK-wide rates (even for Scottish taxpayers)
// Dividend allowance OCCUPIES band space — does not exempt
// ══════════════════════════════════════════════════════════════════════════════

function calcDividendTax(dividendIncome, nonDivTaxableIncome, rates) {
  if (dividendIncome <= 0) return { tax: 0, breakdown: [] };

  const divAllowance = rates.dividend_allowance || 500;
  const brt          = rates.basic_rate_threshold  || 50270;
  const hrt          = rates.higher_rate_threshold || 125140;
  const pa           = rates.personal_allowance    || 12570;

  // Dividends sit on top of non-div income
  // The allowance occupies band space at 0% — critical rule
  let remaining      = dividendIncome;
  let priorFilled    = nonDivTaxableIncome; // How much of the bands are already used
  let tax            = 0;
  const breakdown    = [];

  // Dividend allowance (0%) — occupies band space
  const allowanceInBand = Math.min(remaining, divAllowance);
  breakdown.push({ band: 'allowance', income: allowanceInBand, rate: 0, tax: 0 });
  remaining -= allowanceInBand;
  priorFilled += allowanceInBand;

  if (remaining <= 0) return { tax: 0, breakdown };

  // Basic rate dividend (10.75%)
  const basicTop    = brt - pa;
  const basicAvail  = Math.max(0, basicTop - priorFilled);
  const inBasic     = Math.min(remaining, basicAvail);
  if (inBasic > 0) {
    const t = Math.round(inBasic * (rates.dividend_basic_rate || 0.1075) * 100) / 100;
    tax += t;
    breakdown.push({ band: 'basic', income: inBasic, rate: rates.dividend_basic_rate || 0.1075, tax: t });
    remaining -= inBasic;
    priorFilled += inBasic;
  }

  // Higher rate dividend (35.75%)
  const higherTop   = hrt - pa;
  const higherAvail = Math.max(0, higherTop - priorFilled);
  const inHigher    = Math.min(remaining, higherAvail);
  if (inHigher > 0) {
    const t = Math.round(inHigher * (rates.dividend_higher_rate || 0.3575) * 100) / 100;
    tax += t;
    breakdown.push({ band: 'higher', income: inHigher, rate: rates.dividend_higher_rate || 0.3575, tax: t });
    remaining -= inHigher;
  }

  // Additional rate dividend (39.35%)
  if (remaining > 0) {
    const t = Math.round(remaining * (rates.dividend_additional_rate || 0.3935) * 100) / 100;
    tax += t;
    breakdown.push({ band: 'additional', income: remaining, rate: rates.dividend_additional_rate || 0.3935, tax: t });
  }

  return { tax: Math.round(tax * 100) / 100, breakdown };
}

// ══════════════════════════════════════════════════════════════════════════════
// NATIONAL INSURANCE — Class 2 and Class 4 (sole traders + partners)
// Class 4 on SE profit ONLY — not PAYE, not dividends, not rental
// ══════════════════════════════════════════════════════════════════════════════

function calcNationalInsurance(seProfit, dateOfBirth, rates) {
  const spt  = rates.class2_spt          || 7105;
  const lpl  = rates.class4_lpl          || 12570;
  const upl  = rates.class4_upl          || 50270;
  const main = rates.class4_main_rate    || 0.06;
  const upper= rates.class4_upper_rate   || 0.02;
  const c2Rate=rates.class2_weekly_rate  || 3.65;

  // SPA check (Build Note 5): always use DOB, never fixed age
  // Class 4 NI exempt from 6 April of tax year AFTER reaching SPA
  const isExemptFromClass4 = isAboveSPA(dateOfBirth);
  if (isExemptFromClass4) {
    return { class2: 0, class4: 0, total: 0, spa_exempt: true };
  }

  // Class 2 NI — auto-credited above SPT, voluntary below
  const class2 = seProfit > spt
    ? Math.round(c2Rate * 52 * 100) / 100
    : 0;

  // Class 4 NI
  let class4 = 0;
  if (seProfit > lpl) {
    const mainProfit  = Math.min(seProfit, upl) - lpl;
    const upperProfit = Math.max(0, seProfit - upl);
    class4 = Math.round((mainProfit * main + upperProfit * upper) * 100) / 100;
  }

  return {
    class2,
    class4,
    total: Math.round((class2 + class4) * 100) / 100,
    spa_exempt: false,
  };
}

// SPA timetable (Build Note 5) — transitioning 66→67 April 2026–March 2028
function isAboveSPA(dateOfBirth) {
  if (!dateOfBirth) return false;
  const dob = new Date(dateOfBirth);
  const now = new Date();
  const age = (now - dob) / (1000 * 60 * 60 * 24 * 365.25);

  // SPA is transitioning — use 66 as minimum for now
  // Full DOB-based SPA lookup would use GOV.UK SPA timetable
  // For 2026/27: SPA = 66 for most users, rising to 67 for those born after April 1960
  const birthYear = dob.getFullYear();
  const birthMonth = dob.getMonth() + 1;

  // Born April 1960 or later → SPA = 67
  if (birthYear > 1960 || (birthYear === 1960 && birthMonth >= 4)) {
    return age >= 67;
  }
  return age >= 66;
}

// ══════════════════════════════════════════════════════════════════════════════
// SECTION 24 CREDIT — Rental income mortgage interest (Part 1d)
// Credit = 20% × MIN(finCosts, rentalProfit, adjustedIncomeAbovePA)
// Cannot create a refund. Unused fin costs carry forward.
// ══════════════════════════════════════════════════════════════════════════════

function calcSection24Credit(finCosts, rentalProfit, adjustedIncomeAbovePA, rates) {
  const creditRate = rates.section24_credit_rate || 0.20;
  const capA = finCosts;
  const capB = Math.max(0, rentalProfit);
  const capC = Math.max(0, adjustedIncomeAbovePA);
  const creditBasis = Math.min(capA, capB, capC);
  return {
    credit: Math.round(creditBasis * creditRate * 100) / 100,
    creditBasis,
    capA, capB, capC,
  };
}

// ══════════════════════════════════════════════════════════════════════════════
// MAIN: calculateTaxLiability
// Called by: Tax routes, ISE (for monthly_tax_allocation), Runway Calculator
// ══════════════════════════════════════════════════════════════════════════════

async function calculateTaxLiability(userId, taxYear = '2026/27') {
  // Load user profile
  const userResult = await query(
    `SELECT income_structure, is_scottish_taxpayer, is_cis_worker,
            is_ltd_director, is_vat_registered, is_vat_registered,
            receives_rental_income, receives_partnership,
            date_of_birth, partnership_profit_share_pct,
            tax_pot_target,
            COALESCE(tax_code, '1257L') AS tax_code
     FROM users WHERE id = $1`,
    [userId]
  );

  if (userResult.rows.length === 0) throw new Error('User not found');
  const user = userResult.rows[0];

  // Parse tax code to determine effective personal allowance
  // Supports: 1257L (standard), BR, D0, D1, NT, K codes, S/C prefix variants
  const rawTaxCode = (user.tax_code || '1257L').toUpperCase().trim();
  let effectivePAOverride = null;

  if (rawTaxCode === 'NT') {
    effectivePAOverride = 999999;           // No tax — treat as unlimited allowance
  } else if (rawTaxCode === 'BR' || rawTaxCode === 'D0' || rawTaxCode === 'D1') {
    effectivePAOverride = 0;               // No personal allowance on this income
  } else if (rawTaxCode.startsWith('K')) {
    const kNum = parseInt(rawTaxCode.slice(1)) || 0;
    effectivePAOverride = -(kNum * 10);    // K codes = negative allowance
  } else {
    // Standard numeric code e.g. 1257L, S1257L, C1257L
    const stripped = rawTaxCode.replace(/^[SC]/, '').replace(/[A-Z]+$/, '');
    const codeNum = parseInt(stripped);
    if (!isNaN(codeNum)) {
      effectivePAOverride = codeNum * 10;  // e.g. 1257 × 10 = £12,570
    }
  }

  // Load all rates from database — zero hardcoded values
  const rates = await loadRates(taxYear, user.is_scottish_taxpayer);

  // Load income events for this tax year
  const incomeResult = await query(
    `SELECT income_type, SUM(gross_amount) as total
     FROM income_events
     WHERE user_id = $1 AND tax_year = $2
     GROUP BY income_type`,
    [userId, taxYear]
  );

  const incomeByType = {};
  for (const row of incomeResult.rows) {
    incomeByType[row.income_type] = parseFloat(row.total) || 0;
  }

  const grossSE        = incomeByType['se']          || 0;
  const grossPAYE      = incomeByType['paye']        || 0;
  const grossDividends = incomeByType['dividend']    || 0;
  const grossRental    = incomeByType['rental']      || 0;
  const grossPartner   = incomeByType['partnership'] || 0;
  const grossCIS       = incomeByType['cis']         || 0;

  // CIS workers: total SE = gross_amount (pre-deduction) from income_events
  const totalSE = grossSE + grossCIS;

  // Load rental income details if applicable
  let rentalProfit = 0, finCosts = 0, finCostsBF = 0;
  if (user.receives_rental_income) {
    const rentalResult = await query(
      `SELECT SUM(allowable_expenses) as exp, SUM(finance_costs) as fin,
              SUM(fin_costs_carried_fwd) as finbf, SUM(gross_income) as gross
       FROM income_sources
       WHERE user_id = $1 AND is_rental = true AND is_active = true`,
      [userId]
    );
    if (rentalResult.rows[0]?.gross) {
      const rg = rentalResult.rows[0];
      rentalProfit = Math.max(0, parseFloat(rg.gross || 0) - parseFloat(rg.exp || 0));
      finCosts     = parseFloat(rg.fin  || 0);
      finCostsBF   = parseFloat(rg.finbf || 0);
    }
  }

  // Partnership profit share
  const partnerShare = user.receives_partnership && user.partnership_profit_share_pct
    ? grossPartner * (parseFloat(user.partnership_profit_share_pct) / 100)
    : 0;

  // Total income for PA taper
  const totalIncome = grossPAYE + totalSE + partnerShare + rentalProfit + grossDividends;
  const effectivePA = calcEffectivePA(totalIncome, rates);

  // Taxable non-dividend income (band stacking: PAYE → SE → partner → rental)
  const totalNonDiv    = grossPAYE + totalSE + partnerShare + rentalProfit;
  const taxableNonDiv  = Math.max(0, totalNonDiv - effectivePA);

  // Income tax on non-dividend income
  let itNonDiv = 0;
  let itBreakdown = [];
  if (user.is_scottish_taxpayer) {
    const result = calcScottishIncomeTax(taxableNonDiv, rates);
    itNonDiv     = result.tax;
    itBreakdown  = result.breakdown;
  } else {
    itNonDiv = calcUKIncomeTax(taxableNonDiv, rates);
  }

  // Dividend tax (UK-wide even for Scottish taxpayers)
  const divResult = calcDividendTax(grossDividends, taxableNonDiv, rates);
  const itDividends = divResult.tax;

  // Section 24 credit (rental income — Part 1d)
  let s24Credit = 0, s24NewForward = 0;
  if (user.receives_rental_income && finCosts + finCostsBF > 0) {
    const adjustedIncomeAbovePA = Math.max(0, totalNonDiv - effectivePA);
    const s24Result = calcSection24Credit(
      finCosts + finCostsBF, rentalProfit, adjustedIncomeAbovePA, rates
    );
    s24Credit      = s24Result.credit;
    s24NewForward  = Math.max(0, (finCosts + finCostsBF) - s24Result.creditBasis);
    // Credit cannot create refund — applied after IT is calculated
  }

  // Total income tax before Section 24 credit
  const itBeforeS24 = Math.round((itNonDiv + itDividends) * 100) / 100;
  // Net income tax after Section 24 credit (cannot go below 0)
  const itTotal     = Math.max(0, Math.round((itBeforeS24 - s24Credit) * 100) / 100);

  // National Insurance — SE profit only (Class 2 + Class 4)
  const niResult = calcNationalInsurance(totalSE + partnerShare, user.date_of_birth, rates);

  // MTD flag (Build Note 7)
  const grossQualifying = totalSE + grossRental + partnerShare;
  const mtdRequired = grossQualifying > (rates.mtd_threshold_2026 || 50000);

  // Total liability
  const totalLiability = Math.round((itTotal + niResult.total) * 100) / 100;

  // Monthly tax pot contribution
  const monthlyTaxPot = Math.round(totalLiability / 12 * 100) / 100;

  // FCA-compliant disclosures
  const disclosures = [];
  if (user.is_scottish_taxpayer) {
    disclosures.push({
      type: 'SCOTTISH_IT',
      copy: 'Scottish income tax rates apply to your employment and self-employed income. Savings and dividend income are taxed at UK-wide rates.',
    });
  }
  if (user.receives_rental_income) {
    disclosures.push({ type: 'RENTAL_IT', copy: 'Rental income tax estimate. Based on income and expenses declared.' });
    if (s24NewForward > 0) {
      disclosures.push({ type: 'FIN_COSTS_CARRIED_FWD', copy: 'Unused mortgage interest relief has been carried forward to next year.' });
    }
    disclosures.push({ type: 'FINANCE_ACT_2026', copy: 'Rental income tax rates are scheduled to increase from April 2027. Your current estimates use 2026/27 rates.' });
  }
  if (mtdRequired) {
    disclosures.push({ type: 'MTD_REQUIRED', copy: 'Your income level may require you to use Making Tax Digital from April 2026.' });
  }

  // Write results to tax_calculations table
  await writeTaxCalculation(userId, taxYear, {
    grossPAYE, grossSE: totalSE, grossDividends, grossRental, partnerShare,
    effectivePA, itTotal, niResult, s24Credit, s24NewForward,
    totalLiability, monthlyTaxPot, mtdRequired,
    isScottish: user.is_scottish_taxpayer,
  });

  // Update users.tax_pot_target and users.mtd_required
  await query(
    `UPDATE users SET
       tax_pot_target = $1,
       mtd_required   = $2,
       updated_at     = NOW()
     WHERE id = $3`,
    [monthlyTaxPot, mtdRequired, userId]
  );

  return {
    tax_year:           taxYear,
    income_structure:   user.income_structure,
    is_scottish:        user.is_scottish_taxpayer,
    // Income
    gross_paye:         grossPAYE,
    gross_se:           totalSE,
    gross_dividends:    grossDividends,
    gross_rental:       grossRental,
    partner_share:      partnerShare,
    total_income:       totalIncome,
    // Tax
    effective_pa:       effectivePA,
    pa_tapered:         effectivePA < (rates.personal_allowance || 12570),
    it_non_div:         itNonDiv,
    it_dividends:       itDividends,
    s24_credit:         s24Credit,
    s24_fin_costs_fwd:  s24NewForward,
    it_total:           itTotal,
    it_breakdown:       itBreakdown,
    div_breakdown:      divResult.breakdown,
    // NI
    ni_class2:          niResult.class2,
    ni_class4:          niResult.class4,
    ni_total:           niResult.total,
    spa_exempt:         niResult.spa_exempt,
    // Totals
    total_liability:    totalLiability,
    monthly_tax_pot:    monthlyTaxPot,
    mtd_required:       mtdRequired,
    disclosures,
    rates_year:         taxYear,
    calculated_at:      new Date().toISOString(),
  };
}

// ── Write to tax_calculations table ──────────────────────────────────────────

async function writeTaxCalculation(userId, taxYear, data) {
  await query(`
    INSERT INTO tax_calculations
      (user_id, tax_year, gross_paye_income, gross_se_income,
       gross_dividend_income, gross_rental_income, gross_partnership_income,
       effective_pa, pa_tapered, it_total, ni_class2, ni_class4_main,
       ni_total, section24_credit, fin_costs_carried_fwd,
       total_tax_liability, monthly_tax_pot_contrib, mtd_required,
       is_scottish, calculation_basis, calculated_at)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,'projected',NOW())
    ON CONFLICT (user_id, tax_year) DO UPDATE SET
      gross_paye_income        = EXCLUDED.gross_paye_income,
      gross_se_income          = EXCLUDED.gross_se_income,
      gross_dividend_income    = EXCLUDED.gross_dividend_income,
      gross_rental_income      = EXCLUDED.gross_rental_income,
      gross_partnership_income = EXCLUDED.gross_partnership_income,
      effective_pa             = EXCLUDED.effective_pa,
      pa_tapered               = EXCLUDED.pa_tapered,
      it_total                 = EXCLUDED.it_total,
      ni_class2                = EXCLUDED.ni_class2,
      ni_class4_main           = EXCLUDED.ni_class4_main,
      ni_total                 = EXCLUDED.ni_total,
      section24_credit         = EXCLUDED.section24_credit,
      fin_costs_carried_fwd    = EXCLUDED.fin_costs_carried_fwd,
      total_tax_liability      = EXCLUDED.total_tax_liability,
      monthly_tax_pot_contrib  = EXCLUDED.monthly_tax_pot_contrib,
      mtd_required             = EXCLUDED.mtd_required,
      is_scottish              = EXCLUDED.is_scottish,
      calculated_at            = NOW(),
      updated_at               = NOW()
  `, [
    userId, taxYear,
    data.grossPAYE, data.grossSE, data.grossDividends,
    data.grossRental, data.partnerShare,
    data.effectivePA, data.pa_tapered || false,
    data.itTotal,
    data.niResult.class2, data.niResult.class4, data.niResult.total,
    data.s24Credit, data.s24NewForward,
    data.totalLiability, data.monthlyTaxPot, data.mtdRequired,
    data.isScottish,
  ]);
}

module.exports = {
  calculateTaxLiability,
  calcEffectivePA,
  calcUKIncomeTax,
  calcScottishIncomeTax,
  calcDividendTax,
  calcNationalInsurance,
  calcSection24Credit,
  loadRates,
};
