'use strict';

/**
 * ════════════════════════════════════════════════════════════════════════════
 * FLEXFLOW — BUSINESS ENGINE v1.0
 * For UK Private Limited Company Directors
 * Tax Year: 2026/27 (6 April 2026 – 5 April 2027)
 *
 * COMPONENTS:
 *   1. Corporation Tax Engine     — calculates CT liability on company profits
 *   2. Dividend Tax Engine        — calculates personal dividend tax liability
 *   3. Business Expense Engine    — validates and categorises allowable expenses
 *   4. Business Dashboard Engine  — combines all three for the Business tab
 *
 * SOURCES (verified April/May 2026):
 *   - HMRC Corporation Tax rates: gov.uk/corporation-tax-rates
 *   - HMRC Dividend tax: gov.uk/tax-on-dividends
 *   - ICAEW Autumn Budget 2025 summary
 *   - Deloitte UK Tax Rates 2026/27
 *   - Finance Act 2026 sections 4-7
 *   - ATT 2026/27 Tax Year Updates
 *
 * RATES CONFIRMED FOR 2026/27:
 *   Corporation Tax:
 *     Small profits rate:   19%  (profits ≤ £50,000)
 *     Marginal relief band: £50,001 – £250,000 (fraction 3/200)
 *     Main rate:            25%  (profits > £250,000)
 *     Effective marginal:   26.5% per £ in band
 *
 *   Dividend Tax (FROM 6 APRIL 2026 — INCREASED FROM 2025/26):
 *     Allowance:            £500  (unchanged)
 *     Basic rate:           10.75% (was 8.75% in 2025/26)
 *     Higher rate:          35.75% (was 33.75% in 2025/26)
 *     Additional rate:      39.35% (unchanged)
 *
 *   Income tax bands (England/Wales/NI):
 *     Personal allowance:   £12,570
 *     Basic rate band:      £12,571 – £50,270
 *     Higher rate band:     £50,271 – £125,140
 *     Additional rate:      > £125,140
 * ════════════════════════════════════════════════════════════════════════════
 */

// ── CONSTANTS 2026/27 ────────────────────────────────────────────────────────

const CT = {
  SMALL_PROFITS_RATE:  0.19,
  MAIN_RATE:           0.25,
  LOWER_THRESHOLD:     50000,
  UPPER_THRESHOLD:     250000,
  MARGINAL_FRACTION:   3 / 200,   // 0.015 — confirmed HMRC
};

const DIV = {
  ALLOWANCE:           500,       // £500 — unchanged for 2026/27
  BASIC_RATE:          0.1075,    // 10.75% — increased from 8.75% April 2026
  HIGHER_RATE:         0.3575,    // 35.75% — increased from 33.75% April 2026
  ADDITIONAL_RATE:     0.3935,    // 39.35% — unchanged
};

const IT = {
  PERSONAL_ALLOWANCE:  12570,
  BASIC_THRESHOLD:     50270,
  HIGHER_THRESHOLD:    125140,
};

const NI = {
  EMPLOYER_RATE:       0.15,      // Employer NI 2026/27
  NI_THRESHOLD:        12570,     // NI secondary threshold (director salary)
};

// ════════════════════════════════════════════════════════════════════════════
// 1. CORPORATION TAX ENGINE
// ════════════════════════════════════════════════════════════════════════════

/**
 * calculateCorporationTax
 * Calculates the corporation tax liability for a UK Ltd company.
 *
 * @param {number} grossRevenue             — total company income (£)
 * @param {number} allowableExpenses        — total allowable business expenses (£)
 * @param {number} directorSalary           — annual director salary (£, allowable expense)
 * @param {number} associatedCompanies      — number of associated companies (default 0)
 * @param {number} employerPensionContribution — annual employer pension paid by company (£)
 *                                            — allowable deduction under BIM46035
 *                                            — reduces taxable profit, saves CT at marginal rate
 * @returns {object} — full CT breakdown including pension impact
 */
function calculateCorporationTax(
  grossRevenue,
  allowableExpenses = 0,
  directorSalary    = 0,
  associatedCompanies = 0,
  employerPensionContribution = 0
) {
  // Defensive: sanitise all inputs
  grossRevenue                = Math.max(0, Number(grossRevenue) || 0);
  allowableExpenses           = Math.max(0, Number(allowableExpenses) || 0);
  directorSalary              = Math.max(0, Number(directorSalary) || 0);
  associatedCompanies         = Math.max(0, Number(associatedCompanies) || 0);
  employerPensionContribution = Math.max(0, Number(employerPensionContribution) || 0);

  // Step 1: Calculate taxable profit
  // Director salary AND employer pension are allowable deductions from company profits.
  // BIM46035: pension is wholly and exclusively for the trade in normal cases.
  const totalDeductions  = allowableExpenses + directorSalary + employerPensionContribution;
  const taxableProfit    = Math.max(0, grossRevenue - totalDeductions);

  // Step 2: Adjust thresholds for associated companies
  // Thresholds divided by (associatedCompanies + 1)
  const divisor          = associatedCompanies + 1;
  const lowerThreshold   = CT.LOWER_THRESHOLD  / divisor;
  const upperThreshold   = CT.UPPER_THRESHOLD  / divisor;

  // Step 3: Calculate CT based on profit band
  let ctLiability   = 0;
  let effectiveRate = 0;
  let band          = '';

  if (taxableProfit <= 0) {
    ctLiability   = 0;
    effectiveRate = 0;
    band          = 'none';
  } else if (taxableProfit <= lowerThreshold) {
    // Small profits rate
    ctLiability   = Math.round(taxableProfit * CT.SMALL_PROFITS_RATE * 100) / 100;
    effectiveRate = CT.SMALL_PROFITS_RATE;
    band          = 'small_profits';
  } else if (taxableProfit <= upperThreshold) {
    // Marginal relief band
    // Formula: CT = (profit × 25%) − (3/200 × (250,000 − profit))
    // Adjusted for associated companies using scaled upper threshold
    const grossCT      = taxableProfit * CT.MAIN_RATE;
    const relief       = CT.MARGINAL_FRACTION * (upperThreshold - taxableProfit);
    ctLiability        = Math.round(Math.max(0, grossCT - relief) * 100) / 100;
    effectiveRate      = taxableProfit > 0 ? ctLiability / taxableProfit : 0;
    band               = 'marginal_relief';
  } else {
    // Main rate
    ctLiability   = Math.round(taxableProfit * CT.MAIN_RATE * 100) / 100;
    effectiveRate = CT.MAIN_RATE;
    band          = 'main_rate';
  }

  // Step 4: Post-CT profit (distributable as dividends)
  const postCtProfit     = Math.round(Math.max(0, taxableProfit - ctLiability) * 100) / 100;

  // Step 5: Monthly CT accrual (for tax pot)
  const monthlyCtAccrual = Math.round(ctLiability / 12 * 100) / 100;

  // Step 6: Pension impact — baseline CT (without pension) for saving calculation
  let ctLiabilityNoPension = 0;
  let corporationTaxSaving = 0;
  if (employerPensionContribution > 0) {
    const profitNoPension = Math.max(0, grossRevenue - allowableExpenses - directorSalary);
    if (profitNoPension <= 0) {
      ctLiabilityNoPension = 0;
    } else if (profitNoPension <= lowerThreshold) {
      ctLiabilityNoPension = Math.round(profitNoPension * CT.SMALL_PROFITS_RATE * 100) / 100;
    } else if (profitNoPension <= upperThreshold) {
      const grossCTnp = profitNoPension * CT.MAIN_RATE;
      const reliefNp  = CT.MARGINAL_FRACTION * (upperThreshold - profitNoPension);
      ctLiabilityNoPension = Math.round(Math.max(0, grossCTnp - reliefNp) * 100) / 100;
    } else {
      ctLiabilityNoPension = Math.round(profitNoPension * CT.MAIN_RATE * 100) / 100;
    }
    corporationTaxSaving = Math.round((ctLiabilityNoPension - ctLiability) * 100) / 100;
  }

  return {
    gross_revenue:                      Math.round(grossRevenue * 100) / 100,
    allowable_expenses:                 Math.round(allowableExpenses * 100) / 100,
    director_salary:                    Math.round(directorSalary * 100) / 100,
    employer_pension_contribution:      Math.round(employerPensionContribution * 100) / 100,
    total_deductions:                   Math.round(totalDeductions * 100) / 100,
    taxable_profit:                     taxableProfit,
    ct_liability:                       ctLiability,
    ct_liability_no_pension:            ctLiabilityNoPension,
    corporation_tax_saving_from_pension: corporationTaxSaving,
    effective_rate:                     Math.round(effectiveRate * 10000) / 10000,
    effective_rate_pct:                 Math.round(effectiveRate * 10000) / 100,
    band,
    lower_threshold:                    lowerThreshold,
    upper_threshold:                    upperThreshold,
    post_ct_profit:                     postCtProfit,
    monthly_ct_accrual:                 monthlyCtAccrual,
    associated_companies:               associatedCompanies,
  };
}

// ════════════════════════════════════════════════════════════════════════════
// 2. DIVIDEND TAX ENGINE
// ════════════════════════════════════════════════════════════════════════════

/**
 * calculateDividendTax
 * Calculates personal dividend tax for a Ltd Director.
 * Dividends sit on top of other income (salary) for band calculation.
 *
 * @param {number} proposedDividend    — dividend amount proposed (£)
 * @param {number} directorSalary      — annual salary already taken (£)
 * @param {number} ytdDividends        — dividends already taken this tax year (£)
 * @param {boolean} isScottish         — Scottish taxpayer (affects IT bands NOT div tax)
 * @returns {object} — full dividend tax breakdown
 */
function calculateDividendTax(
  proposedDividend,
  directorSalary  = 12570,
  ytdDividends    = 0,
  isScottish      = false
) {
  // Note: Scottish rates do NOT apply to dividend income.
  // Dividend tax rates are UK-wide regardless of residence.
  // isScottish parameter retained for future salary band calculations.

  // Step 1: Allowance remaining this tax year
  const allowanceUsed    = Math.min(ytdDividends, DIV.ALLOWANCE);
  const allowanceLeft    = Math.max(0, DIV.ALLOWANCE - allowanceUsed);

  // Step 2: Tax-free portion of proposed dividend
  const taxFree          = Math.min(proposedDividend, allowanceLeft);
  const taxableAmount    = Math.max(0, proposedDividend - taxFree);

  // Step 3: Determine tax bands
  // Total income = salary + YTD dividends + proposed dividend
  // Dividends stack on top of salary for band purposes
  const totalIncome      = directorSalary + ytdDividends + proposedDividend;

  // Salary occupies the lower bands; dividends sit on top
  // Basic rate band available for dividends:
  const salaryAbovePA    = Math.max(0, directorSalary - IT.PERSONAL_ALLOWANCE);
  const basicBandAvail   = Math.max(0, (IT.BASIC_THRESHOLD - IT.PERSONAL_ALLOWANCE) - salaryAbovePA);

  // Of the taxable dividend, how much falls in basic vs higher vs additional
  let remainingTaxable   = taxableAmount;
  let basicDivAmount     = 0;
  let higherDivAmount    = 0;
  let additionalDivAmount= 0;

  // Previously taken dividends already consuming band space
  const prevDivBandUsed  = Math.max(0, ytdDividends - allowanceUsed);
  const basicBandLeft    = Math.max(0, basicBandAvail - prevDivBandUsed);
  const higherBandTop    = IT.HIGHER_THRESHOLD - IT.PERSONAL_ALLOWANCE - salaryAbovePA - prevDivBandUsed;

  if (remainingTaxable > 0) {
    basicDivAmount       = Math.min(remainingTaxable, basicBandLeft);
    remainingTaxable    -= basicDivAmount;
  }
  if (remainingTaxable > 0) {
    const higherBandLeft = Math.max(0, higherBandTop - basicBandLeft);
    higherDivAmount      = Math.min(remainingTaxable, higherBandLeft);
    remainingTaxable    -= higherDivAmount;
  }
  if (remainingTaxable > 0) {
    additionalDivAmount  = remainingTaxable;
  }

  // Step 4: Calculate tax per band
  const basicTax         = Math.round(basicDivAmount     * DIV.BASIC_RATE     * 100) / 100;
  const higherTax        = Math.round(higherDivAmount    * DIV.HIGHER_RATE    * 100) / 100;
  const additionalTax    = Math.round(additionalDivAmount* DIV.ADDITIONAL_RATE* 100) / 100;
  const totalTax         = Math.round((basicTax + higherTax + additionalTax) * 100) / 100;

  // Step 5: Net dividend (take-home)
  const netDividend      = Math.round((proposedDividend - totalTax) * 100) / 100;

  // Step 6: Effective rate on total dividend
  const effectiveRate    = proposedDividend > 0
    ? Math.round((totalTax / proposedDividend) * 10000) / 10000
    : 0;

  // Step 7: Determine primary band
  let primaryBand = 'allowance';
  if (additionalDivAmount > 0) primaryBand = 'additional';
  else if (higherDivAmount > 0) primaryBand = 'higher';
  else if (basicDivAmount > 0) primaryBand = 'basic';

  return {
    proposed_dividend:      Math.round(proposedDividend * 100) / 100,
    director_salary:        Math.round(directorSalary * 100) / 100,
    ytd_dividends:          Math.round(ytdDividends * 100) / 100,
    allowance_used:         Math.round(allowanceUsed * 100) / 100,
    allowance_remaining:    Math.round(allowanceLeft * 100) / 100,
    tax_free_portion:       Math.round(taxFree * 100) / 100,
    taxable_amount:         Math.round(taxableAmount * 100) / 100,
    basic_rate_amount:      Math.round(basicDivAmount * 100) / 100,
    higher_rate_amount:     Math.round(higherDivAmount * 100) / 100,
    additional_rate_amount: Math.round(additionalDivAmount * 100) / 100,
    basic_tax:              basicTax,
    higher_tax:             higherTax,
    additional_tax:         additionalTax,
    total_tax:              totalTax,
    net_dividend:           netDividend,
    effective_rate:         effectiveRate,
    effective_rate_pct:     Math.round(effectiveRate * 10000) / 100,
    primary_band:           primaryBand,
    rates_used: {
      allowance:   DIV.ALLOWANCE,
      basic:       DIV.BASIC_RATE,
      higher:      DIV.HIGHER_RATE,
      additional:  DIV.ADDITIONAL_RATE,
      tax_year:    '2026/27',
    },
    is_scottish: isScottish,
    scottish_note: isScottish
      ? 'Scottish rates apply to salary only. Dividend tax is UK-wide (10.75%/35.75%/39.35%).'
      : null,
  };
}

// ════════════════════════════════════════════════════════════════════════════
// 3. BUSINESS EXPENSE ENGINE
// ════════════════════════════════════════════════════════════════════════════

/**
 * ALLOWABLE EXPENSE CATEGORIES for Ltd Companies (HMRC 2026/27)
 * Source: gov.uk/expenses-if-youre-self-employed + HMRC CT guidance
 */
const EXPENSE_CATEGORIES = {
  staff:           { label: 'Staff & Payroll',         allowable: true,  notes: 'Salaries, employer NI, pension contributions' },
  professional:    { label: 'Professional Services',   allowable: true,  notes: 'Accountant, solicitor, business consultant fees' },
  office:          { label: 'Office & Admin',          allowable: true,  notes: 'Rent, utilities, stationery, postage, cleaning' },
  it_software:     { label: 'IT & Software',           allowable: true,  notes: 'Subscriptions, hosting, hardware (revenue costs)' },
  travel:          { label: 'Business Travel',         allowable: true,  notes: 'Not commuting. Mileage at 55p/25p, public transport, hotels' },
  marketing:       { label: 'Marketing & Advertising', allowable: true,  notes: 'Ads, website, PR, branded materials' },
  training:        { label: 'Training & Development',  allowable: true,  notes: 'Must be relevant to existing trade — not new skills' },
  insurance:       { label: 'Business Insurance',      allowable: true,  notes: 'PI, PL, employers liability, business property' },
  bank_charges:    { label: 'Bank & Finance Charges',  allowable: true,  notes: 'Business account fees, payment processing, loan interest' },
  subscriptions:   { label: 'Subscriptions & Memberships', allowable: true, notes: 'HMRC-approved trade bodies, relevant professional memberships' },
  equipment:       { label: 'Equipment & Machinery',   allowable: true,  notes: 'Capital allowances apply — AIA up to £1m. Not direct deduction.' },
  repairs:         { label: 'Repairs & Maintenance',   allowable: true,  notes: 'Repairs to business property/equipment — not improvements' },
  entertainment:   { label: 'Staff Entertainment',     allowable: true,  notes: '£150/head annual limit for staff events — not client entertainment' },
  pension:         { label: 'Pension Contributions',   allowable: true,  notes: 'Company pension contributions — up to £60,000 annual allowance' },
  home_office:     { label: 'Home Office',             allowable: true,  notes: 'Proportion of household costs — documented basis only' },
  // NOT allowable:
  client_entertain:{ label: 'Client Entertainment',    allowable: false, notes: 'NOT allowable — HMRC explicitly excludes client entertainment' },
  personal:        { label: 'Personal Expenses',       allowable: false, notes: 'NOT allowable — must be wholly and exclusively for business' },
  fines:           { label: 'Fines & Penalties',       allowable: false, notes: 'NOT allowable — e.g. parking fines, HMRC penalties' },
  dividends_paid:  { label: 'Dividend Payments',       allowable: false, notes: 'NOT allowable — dividends are distributions, not expenses' },
};

/**
 * validateExpense
 * Validates whether a business expense is allowable for CT purposes.
 *
 * @param {string} category   — expense category key
 * @param {number} amount     — expense amount (£)
 * @param {string} notes      — optional description
 * @returns {object}          — validation result
 */
function validateExpense(category, amount, notes = '') {
  const cat = EXPENSE_CATEGORIES[category];
  if (!cat) {
    return {
      valid:    false,
      allowable: false,
      warning:  `Unknown category '${category}'. Default to disallowed until verified.`,
      category,
      amount,
    };
  }

  // Entertainment cap check
  if (category === 'entertainment' && amount > 150) {
    return {
      valid:     true,
      allowable: true,
      warning:   `Staff entertainment exceeds £150/head limit. Only £150/head is allowable. Review total headcount.`,
      category,
      amount,
      label:     cat.label,
      notes:     cat.notes,
    };
  }

  return {
    valid:     true,
    allowable: cat.allowable,
    warning:   cat.allowable ? null : `${cat.label} is not an allowable expense: ${cat.notes}`,
    category,
    amount:    cat.allowable ? amount : 0,
    label:     cat.label,
    notes:     cat.notes,
  };
}

/**
 * calculateAllowableExpenses
 * Takes an array of expense items and returns total allowable deductions.
 *
 * @param {Array} expenses — [{category, amount, description}]
 * @returns {object}       — expense summary with allowable total
 */
function calculateAllowableExpenses(expenses = []) {
  let totalAllowable   = 0;
  let totalDisallowed  = 0;
  const validated      = [];
  const warnings       = [];

  for (const exp of expenses) {
    const result = validateExpense(exp.category, exp.amount, exp.description);
    validated.push({ ...exp, ...result });

    if (result.allowable) {
      totalAllowable  += result.amount;
    } else {
      totalDisallowed += exp.amount;
      if (result.warning) warnings.push(result.warning);
    }
  }

  return {
    expenses:          validated,
    total_allowable:   Math.round(totalAllowable  * 100) / 100,
    total_disallowed:  Math.round(totalDisallowed * 100) / 100,
    total_submitted:   Math.round((totalAllowable + totalDisallowed) * 100) / 100,
    warning_count:     warnings.length,
    warnings,
    categories:        EXPENSE_CATEGORIES,
  };
}

// ════════════════════════════════════════════════════════════════════════════
// 4. BUSINESS DASHBOARD ENGINE
// ════════════════════════════════════════════════════════════════════════════

/**
 * calculateBusinessDashboard
 * Master function combining all three engines for the Business tab.
 * Returns everything the Business screen needs in one call.
 *
 * @param {object} params
 *   @param {number} companyBankBalance    — current company account balance (£)
 *   @param {number} grossRevenueFY        — estimated full-year revenue (£)
 *   @param {number} allowableExpensesFY   — total allowable expenses FY (£)
 *   @param {number} directorSalaryAnnual  — annual director salary (£)
 *   @param {number} ytdDividendsTaken     — dividends taken so far this tax year (£)
 *   @param {number} proposedDividend      — proposed next dividend amount (£)
 *   @param {number} associatedCompanies   — associated company count (default 0)
 *   @param {boolean} isScottish           — Scottish taxpayer
 * @returns {object} — complete business dashboard data
 */
function calculateBusinessDashboard({
  companyBankBalance         = 0,
  grossRevenueFY             = 0,
  allowableExpensesFY        = 0,
  directorSalaryAnnual       = 12570,
  ytdDividendsTaken          = 0,
  proposedDividend           = 0,
  associatedCompanies        = 0,
  isScottish                 = false,
  employerPensionContribution = 0,
} = {}) {

  // ── Corp Tax ───────────────────────────────────────────────────────────────
  // Employer pension is a deductible expense — reduces taxable profit + saves CT.
  const ct = calculateCorporationTax(
    grossRevenueFY,
    allowableExpensesFY,
    directorSalaryAnnual,
    associatedCompanies,
    employerPensionContribution
  );

  // ── CT Reserve (portion of bank balance reserved for HMRC) ────────────────
  // We calculate CT on the FY estimate, then reserve monthly accrual from balance
  const ctReserveFromBalance = ct.monthly_ct_accrual;

  // ── Available funds after CT reserve ─────────────────────────────────────
  const availableAfterCT = Math.max(0,
    Math.round((companyBankBalance - ctReserveFromBalance) * 100) / 100
  );

  // ── Dividend Tax ──────────────────────────────────────────────────────────
  const divTax = calculateDividendTax(
    proposedDividend,
    directorSalaryAnnual,
    ytdDividendsTaken,
    isScottish
  );

  // ── Post-CT profit available for dividends (FY basis) ─────────────────────
  const maxDividendAvailable = ct.post_ct_profit;

  // ── Salary summary ────────────────────────────────────────────────────────
  // Employer NI on salary above threshold
  const employerNI = directorSalaryAnnual > NI.NI_THRESHOLD
    ? Math.round((directorSalaryAnnual - NI.NI_THRESHOLD) * NI.EMPLOYER_RATE * 100) / 100
    : 0;

  const monthlySalaryGross = Math.round(directorSalaryAnnual / 12 * 100) / 100;

  return {
    // ── Company position ────────────────────────────────────────────────────
    company: {
      bank_balance:          Math.round(companyBankBalance * 100) / 100,
      ct_monthly_reserve:    ctReserveFromBalance,
      available_after_ct:    availableAfterCT,
      gross_revenue_fy:      Math.round(grossRevenueFY * 100) / 100,
      allowable_expenses_fy: Math.round(allowableExpensesFY * 100) / 100,
    },

    // ── Corporation tax ─────────────────────────────────────────────────────
    corporation_tax: ct,

    // ── Salary ──────────────────────────────────────────────────────────────
    salary: {
      annual_gross:      Math.round(directorSalaryAnnual * 100) / 100,
      monthly_gross:     monthlySalaryGross,
      employer_ni:       employerNI,
      at_ni_threshold:   directorSalaryAnnual <= NI.NI_THRESHOLD,
      ni_threshold:      NI.NI_THRESHOLD,
    },

    // ── Dividends ────────────────────────────────────────────────────────────
    dividends: {
      ytd_taken:             Math.round(ytdDividendsTaken * 100) / 100,
      proposed:              Math.round(proposedDividend * 100) / 100,
      max_available_fy:      Math.round(maxDividendAvailable * 100) / 100,
      tax_on_proposed:       divTax,
      allowance_remaining:   Math.round(Math.max(0, DIV.ALLOWANCE - ytdDividendsTaken) * 100) / 100,
    },

    // ── Tax year ─────────────────────────────────────────────────────────────
    meta: {
      tax_year:              '2026/27',
      calculated_at:         new Date().toISOString(),
      is_scottish:           isScottish,
      ct_rates: {
        small_profits:       CT.SMALL_PROFITS_RATE,
        main_rate:           CT.MAIN_RATE,
        marginal_fraction:   '3/200',
        lower_threshold:     CT.LOWER_THRESHOLD,
        upper_threshold:     CT.UPPER_THRESHOLD,
      },
      dividend_rates: {
        allowance:           DIV.ALLOWANCE,
        basic:               DIV.BASIC_RATE,
        higher:              DIV.HIGHER_RATE,
        additional:          DIV.ADDITIONAL_RATE,
        note:                'Rates increased 6 April 2026 per Autumn Budget 2025',
      },
    },
  };
}

// ════════════════════════════════════════════════════════════════════════════
// EXPORTS
// ════════════════════════════════════════════════════════════════════════════

module.exports = {
  calculateCorporationTax,
  calculateDividendTax,
  validateExpense,
  calculateAllowableExpenses,
  calculateBusinessDashboard,
  CONSTANTS: { CT, DIV, IT, NI, EXPENSE_CATEGORIES },
};
