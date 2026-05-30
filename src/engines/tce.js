'use strict';

/**
 * FlexFlow — Transaction Classification Engine (TCE v1)
 * Session C — Task 4
 *
 * Classifies every transaction TrueLayer imports.
 * Applied on every webhook import, in priority order.
 * No transaction skips the tree. No transaction is left unclassified.
 *
 * CRITICAL (Build Note 2):
 *   income_events has TWO amount columns:
 *   .amount       = NET (cash received after any CIS deduction) — display only
 *   .gross_amount = GROSS (pre-deduction) — used by Tax Engine and ISE
 *   For non-CIS income: amount === gross_amount
 *
 * CRITICAL (Build Note 11):
 *   'non cis' in description must gate the ENTIRE CIS branch.
 *   A round CIS-plausible amount with 'non cis' in description is NOT CIS.
 *
 * Source: TCE v1 Specification (May 2026) — all 10 classification priorities
 */

const { query } = require('../config/database');

// ── CIS detection helpers ─────────────────────────────────────────────────────

// CIS deduction rates
const CIS_RATES = [0.20, 0.30]; // Standard 20%, higher 30%

/**
 * Is this amount plausible as a net CIS payment?
 * Gross = net / (1 - rate) must be close to a round £10 amount (±£2)
 */
function isCISPlausibleAmount(netAmount) {
  for (const rate of CIS_RATES) {
    const gross = netAmount / (1 - rate);
    const rounded = Math.round(gross / 10) * 10;
    if (Math.abs(gross - rounded) <= 2) return { plausible: true, rate, gross };
  }
  return { plausible: false };
}

/**
 * Does description contain 'CIS' as a whole word?
 * 'non cis' explicitly EXCLUDES CIS classification (Build Note 11)
 */
function hasCISKeyword(description) {
  if (!description) return false;
  const lower = description.toLowerCase();
  // 'non cis' gates the ENTIRE CIS branch
  if (/non[\s-]cis/i.test(lower)) return false;
  // CIS as whole word
  return /\bcis\b/i.test(description);
}

// ── Umbrella companies — REMOVED (v1 decision, May 2026) ─────────────────────
// Umbrella company workers are treated as PAYE for tax purposes.
// Umbrella income type removed from v1. Deferred to v2 if needed.
// UMBRELLA_COMPANIES array and Priority 7 branch removed.

// ── Known pension providers (Priority 8) ─────────────────────────────────────
const PENSION_PROVIDERS = [
  'nest', 'aviva', 'legal & general', 'standard life', 'teachers pension',
  'nhs pension', 'royal london', 'scottish widows', 'zurich', 'prudential',
  'now pensions', 'peoples pension', 'state pension', 'dwp pension',
];

// ── HMRC sort code ────────────────────────────────────────────────────────────
const HMRC_SORT_CODE = '083210';

// ══════════════════════════════════════════════════════════════════════════════
// MAIN CLASSIFICATION FUNCTION
// Applied to every transaction on import — runs branches 1-10 in order
// ══════════════════════════════════════════════════════════════════════════════

async function classifyTransaction(transaction, user, connectedAccountIds = []) {
  const {
    amount,           // Positive = credit, negative = debit (as stored)
    description = '',
    merchant_name = '',
    transaction_type, // 'CREDIT' | 'DEBIT'
    truelayer_id,
  } = transaction;

  const absAmount = Math.abs(amount);
  const isCredit  = transaction_type === 'CREDIT' || amount > 0;
  const descLower = (description + ' ' + merchant_name).toLowerCase();

  // ── BRANCH 1: Internal Transfer (HIGHEST PRIORITY) ───────────────────────
  // Check for matching transaction in connected accounts (±£1, same day)
  // In sandbox: detect by description keywords
  if (isCredit && /transfer|moving|sent from|from account/i.test(descLower)) {
    return { category: 'transfer', sub_category: 'internal_transfer', is_income: false };
  }
  if (!isCredit && /transfer|moving|sent to|to account/i.test(descLower)) {
    return { category: 'transfer', sub_category: 'internal_transfer', is_income: false };
  }

  // ── BRANCH 1b: Returned DD / Failed Payment Detection ───────────────────
  // Returned Direct Debits are credits but NOT income — auto-dismiss
  if (isCredit && /returned dd|returned direct debit|unpaid dd|unpaid direct debit|recalled payment|reverse payment/i.test(descLower)) {
    return { category: 'transfer', sub_category: 'returned_dd', is_income: false, auto_dismiss: true };
  }

  // ── BRANCH 2: HMRC Payment Detection ────────────────────────────────────
  if (!isCredit) {
    const sortCode = (transaction.sort_code || '').replace(/-/g, '');
    if (
      sortCode === HMRC_SORT_CODE ||
      /hmrc|self.?assessment|self assess/i.test(descLower) ||
      (/paye/i.test(descLower) && absAmount > 500)
    ) {
      return { category: 'tax_payment', sub_category: 'hmrc_payment', is_income: false };
    }
  }

  // ── BRANCH 3: Split CREDIT vs DEBIT ─────────────────────────────────────
  if (!isCredit) {
    // → BRANCH 7: Expense Classification
    return classifyExpense(transaction, user, descLower, absAmount);
  }

  // ── BRANCH 4: Minimum Income Threshold (£50) ────────────────────────────
  // Prevents round-ups, cashback, interest polluting income
  if (absAmount < 50) {
    return {
      category: 'income', sub_category: 'micro_credit',
      is_income: false,   // Not treated as income
      flag_for_review: true,
    };
  }

  // ── BRANCH 5: Income Classification (Priorities 1-10) ───────────────────
  return classifyIncome(transaction, user, descLower, absAmount);
}

// ══════════════════════════════════════════════════════════════════════════════
// INCOME CLASSIFICATION — TCE Part 3
// ══════════════════════════════════════════════════════════════════════════════

async function classifyIncome(transaction, user, descLower, absAmount) {
  const { description = '', merchant_name = '' } = transaction;

  // Priority 1: User override (checked in DB before calling this function)
  // Priority 2: Known income source match (checked in DB before calling this function)
  // Both handled in the webhook handler — if found, skip this function

  // Priority 3: PAYE detection
  const payeStructures = ['S5','S7','S9','S12a','S12b','S12c'];
  if (user.income_structure && payeStructures.includes(user.income_structure)) {
    if (
      (user.employer_name && descLower.includes(user.employer_name.toLowerCase())) ||
      /salary|wages|payroll|pay date|monthly pay|employer/i.test(descLower)
    ) {
      return {
        category: 'income', sub_category: 'paye',
        income_type: 'paye', is_income: true,
        tax_deducted_at_source: true,
        paye_flag: true,
        amount_net: absAmount,
        gross_amount: absAmount, // PAYE: net = gross for income_events purposes (tax already paid)
      };
    }
  }

  // Priority 4: CIS detection
  // Build Note 11: 'non cis' gates the ENTIRE branch
  if (user.is_cis_worker && hasCISKeyword(description)) {
    const cisCheck = isCISPlausibleAmount(absAmount);
    if (cisCheck.plausible) {
      return {
        category: 'income', sub_category: 'cis',
        income_type: 'cis', is_income: true,
        is_cis: true,
        cis_deduction_rate: cisCheck.rate,
        amount_net: absAmount,        // What hit the bank
        gross_amount: cisCheck.gross, // Pre-deduction — Tax Engine reads this
        tax_deducted: Math.round((cisCheck.gross - absAmount) * 100) / 100,
      };
    }
  }

  // Priority 5: Dividend detection (Ltd directors)
  if (user.is_ltd_director) {
    const hasSalaryKeyword = /salary|wages|monthly pay/i.test(descLower);
    const hasCompanyName   = user.company_name && descLower.includes(user.company_name.toLowerCase());
    const isDividendPattern = !hasSalaryKeyword && (hasCompanyName || /dividend|div payment/i.test(descLower));
    if (isDividendPattern) {
      return {
        category: 'income', sub_category: 'dividend',
        income_type: 'dividend', is_income: true,
        div_flag: true,
        amount_net: absAmount, gross_amount: absAmount,
      };
    }
  }

  // Priority 6: Ltd salary detection (runs before dividend, salary keyword takes precedence)
  if (user.is_ltd_director) {
    const hasSalaryKeyword = /salary|wages|monthly pay/i.test(descLower);
    const inSalaryRange    = absAmount >= 400 && absAmount <= 2500;
    if (hasSalaryKeyword && inSalaryRange) {
      return {
        category: 'income', sub_category: 'ltd_salary',
        income_type: 'ltd_salary', is_income: true,
        paye_flag: true, tax_deducted_at_source: true,
        amount_net: absAmount, gross_amount: absAmount,
      };
    }
  }

  // Priority 7: Umbrella/IR35 — REMOVED (v1 decision, May 2026)
  // Umbrella workers should select PAYE in onboarding. Deferred to v2.

  // Priority 8: Pension/annuity
  const matchedPension = PENSION_PROVIDERS.find(p => descLower.includes(p));
  if (matchedPension || (user.receives_pension)) {
    return {
      category: 'income', sub_category: 'pension',
      income_type: 'pension', is_income: true,
      pension_flag: true,
      amount_net: absAmount, gross_amount: absAmount,
    };
  }

  // Priority 9: Rental income
  if (user.receives_rental_income && /rent|rental|letting|tenancy|landlord/i.test(descLower)) {
    return {
      category: 'income', sub_category: 'rental',
      income_type: 'rental', is_income: true,
      is_rental: true,
      amount_net: absAmount, gross_amount: absAmount,
    };
  }

  // Priority 9 (default): SE income or unmatched Ltd credit
  const seCompatible = ['S1','S2','S3a','S3b','S3c','S3d','S4','S10','S11','ltd_director'].includes(user.income_structure);
  if (seCompatible) {
    const incomeType = user.income_structure === 'ltd_director' ? 'se' : 'se';
    return {
      category: 'income', sub_category: 'se_income',
      income_type: incomeType, is_income: true,
      amount_net: absAmount, gross_amount: absAmount,
    };
  }

  // Priority 10: Unclassified credit
  return {
    category: 'income', sub_category: 'unclassified_credit',
    income_type: 'unclassified', is_income: false,
    flag_for_review: true,
  };
}

// ══════════════════════════════════════════════════════════════════════════════
// EXPENSE CLASSIFICATION — TCE Part 4
// Tier 1 = committed non-negotiable outgoings (runway denominator)
// Tier 2 = discretionary / categorised spending
// ══════════════════════════════════════════════════════════════════════════════

const TIER1_KEYWORDS = [
  'rent', 'mortgage', 'council tax', 'water rates', 'electricity', 'gas',
  'broadband', 'internet', 'phone contract', 'mobile contract', 'insurance',
  'car finance', 'loan payment', 'finance payment',
];

const TIER2_CATEGORIES = {
  eating_out:    ['restaurant', 'cafe', 'coffee', 'takeaway', 'deliveroo', 'uber eats', 'just eat'],
  transport:     ['tfl', 'uber', 'train', 'bus', 'parking', 'petrol', 'fuel', 'taxi'],
  groceries:     ['tesco', 'sainsbury', 'asda', 'waitrose', 'lidl', 'aldi', 'morrisons', 'marks & spencer food'],
  shopping:      ['amazon', 'ebay', 'asos', 'next', 'primark', 'h&m', 'zara'],
  health:        ['gym', 'pharmacy', 'boots', 'chemist', 'dentist', 'optician'],
  entertainment: ['cinema', 'netflix', 'spotify', 'disney', 'apple music', 'amazon prime'],
  travel:        ['hotel', 'airbnb', 'booking.com', 'expedia', 'easyjet', 'ryanair', 'british airways'],
  subscriptions: ['subscription', 'monthly plan', 'annual plan'],
};

function classifyExpense(transaction, user, descLower, absAmount) {
  // Tier 1 detection
  const isTier1 = TIER1_KEYWORDS.some(k => descLower.includes(k));
  if (isTier1) {
    return {
      category: 'expense', sub_category: 'committed_outgoing',
      is_income: false, tier_1: true,
    };
  }

  // Tier 2 categorisation
  for (const [cat, keywords] of Object.entries(TIER2_CATEGORIES)) {
    if (keywords.some(k => descLower.includes(k))) {
      return {
        category: 'expense', sub_category: cat,
        is_income: false, tier_1: false,
      };
    }
  }

  // Unclassified expense
  return {
    category: 'expense', sub_category: 'unclassified_expense',
    is_income: false, tier_1: false, flag_for_review: true,
  };
}

module.exports = { classifyTransaction, hasCISKeyword, isCISPlausibleAmount };
