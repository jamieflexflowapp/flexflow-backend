'use strict';

/**
 * FlexFlow — Expense Deduction Engine (EDE v2)
 * Session F — Task 6b
 *
 * HMRC taxes profit, not gross income. This engine identifies allowable
 * business expenses and reduces taxable profit before the Tax Engine runs.
 *
 * Three tiers:
 *   Tier 1 — Auto-detect: HIGH confidence, deduct automatically
 *   Tier 2 — Prompted: MEDIUM confidence, user must confirm business use %
 *   Tier 3 — Manual: user-initiated classification
 *
 * Critical rules (EDE v2 spec):
 *   - Conservative by design: when in doubt, prompt — never over-deduct
 *   - SE users only (S1, S2, S3a-d, S5, S11) — PAYE cannot deduct
 *   - S5 users: deduct from SE component only
 *   - Word-boundary matching (no substring false positives — Build Note 11)
 *   - "Xero" word-boundary: negative lookahead prevents "Xero Landscaping" match
 *   - PayPal: Tier 2 prompted (mixed use)
 *   - Accountant fees: Tier 2 if invoice may include SA filing (not allowable)
 *
 * Source: EDE v2 Specification (May 2026) — 456 cases, 0 failures
 */

const { query, withTransaction } = require('../config/database');

// ── SE-compatible income structures ──────────────────────────────────────────
const SE_STRUCTURES = ['S1','S2','S3a','S3b','S3c','S3d','S4','S5','S8','S10','S11'];

// ══════════════════════════════════════════════════════════════════════════════
// TIER 1 — AUTO-DETECT RULES (HIGH confidence — deduct immediately)
// Merchant name matching uses word boundaries — no substring matches
// ══════════════════════════════════════════════════════════════════════════════

const TIER1_RULES = [
  // Software & Digital Subscriptions (BIM35801/BIM35820)
  { pattern: /\b(adobe|figma|sketch|canva\s+pro)\b/i,          category: 'software',       pct: 100, hmrc: 'BIM35820' },
  { pattern: /\b(microsoft\s+365|google\s+workspace)\b/i,       category: 'software',       pct: 100, hmrc: 'BIM35820' },
  { pattern: /\b(xero(?!\s+\w+ing)|quickbooks|freeagent|sage)\b/i, category: 'accounting', pct: 100, hmrc: 'BIM35820' },
  { pattern: /\b(slack|zoom|teams)\b.*\b(business|pro|plan)\b/i, category: 'software',     pct: 100, hmrc: 'BIM35820' },
  { pattern: /\b(github|aws|heroku|vercel|netlify|cloudflare)\b/i, category: 'hosting',    pct: 100, hmrc: 'BIM35820' },
  { pattern: /\b(dropbox\s+business|google\s+drive)\b/i,        category: 'software',       pct: 100, hmrc: 'BIM35820' },

  // Professional Fees (BIM46405/BIM46450)
  // Note: accountants moved to Tier 2 (may include SA filing — not allowable)
  { pattern: /\b(solicitor|legal\s+fee|contract\s+review)\b/i,  category: 'legal',         pct: 100, hmrc: 'BIM46450' },

  // Bank & Finance Charges (BIM45800)
  { pattern: /\b(stripe|sumup|square|izettle)\b.*\bfee\b/i,     category: 'bank_charges',  pct: 100, hmrc: 'BIM45800' },
  { pattern: /\bpayment\s+processing\s+fee\b/i,                  category: 'bank_charges',  pct: 100, hmrc: 'BIM45800' },
  { pattern: /\bforeign\s+(exchange|transfer)\s+fee\b/i,         category: 'bank_charges',  pct: 100, hmrc: 'BIM45800' },

  // Marketing & Advertising (BIM42600)
  { pattern: /\b(google\s+ads|facebook\s+ads|meta\s+ads|linkedin\s+ads)\b/i, category: 'marketing', pct: 100, hmrc: 'BIM42600' },
  { pattern: /\b(mailchimp|mailerlite|convertkit)\b/i,           category: 'marketing',     pct: 100, hmrc: 'BIM42600' },

  // Office Supplies (BIM37670)
  { pattern: /\b(viking\s+direct|staples|ryman)\b/i,             category: 'office',        pct: 100, hmrc: 'BIM37670' },
  { pattern: /\boffice\s+(supplies|stationery)\b/i,              category: 'office',        pct: 100, hmrc: 'BIM37670' },

  // Equipment (BIM35450) — purchase of tools/equipment for the trade
  { pattern: /\b(laptop|monitor|keyboard|mouse|webcam|microphone)\b/i, category: 'equipment', pct: 100, hmrc: 'BIM35450' },

  // Insurance (BIM45501) — professional indemnity, public liability
  { pattern: /\b(professional\s+indemnity|public\s+liability|hiscox|axa\s+business)\b/i, category: 'insurance', pct: 100, hmrc: 'BIM45501' },

  // Postage & Delivery (BIM37840)
  { pattern: /\b(royal\s+mail|parcelforce|ups\s+business|fedex\s+business|dhl\s+business)\b/i, category: 'postage', pct: 100, hmrc: 'BIM37840' },
];

// ══════════════════════════════════════════════════════════════════════════════
// TIER 2 — PROMPTED RULES (MEDIUM confidence — await user confirmation)
// ══════════════════════════════════════════════════════════════════════════════

const TIER2_RULES = [
  // Mobile phone — personal use element likely
  { key: 'exp_prompt_phone',      pattern: /\b(o2|vodafone|ee|three|sky\s+mobile|bt\s+mobile|giffgaff)\b/i, category: 'phone', hint: 'What % of this phone bill is for business use?' },
  // Home broadband — personal use likely
  { key: 'exp_prompt_broadband',  pattern: /\b(bt\s+broadband|virgin\s+media|sky\s+broadband|talk\s+talk)\b/i, category: 'broadband', hint: 'What % of your broadband is for business use?' },
  // Accountant — may include SA filing (not allowable)
  { key: 'exp_prompt_accountant', pattern: /\baccountants?\b|\bbookkeep/i, category: 'professional_fees', hint: 'Does this invoice include your Self Assessment tax return filing? If so, that portion is not allowable.' },
  // Training — allowable only for existing skills (BIM42526)
  { key: 'exp_prompt_training',   pattern: /\b(udemy|coursera|linkedin\s+learning|training|course|workshop|conference)\b/i, category: 'training', hint: 'Is this training directly related to your existing business skills?' },
  // Amazon/eBay — mixed use
  { key: 'exp_prompt_amazon',     pattern: /\b(amazon|ebay|paypal)\b/i, category: 'mixed_purchase', hint: 'Was this purchase wholly for your business?' },
  // Meals — only allowable when travelling overnight (BIM37900)
  { key: 'exp_prompt_meals',      pattern: /\b(restaurant|cafe|costa|starbucks|pret|greggs|deliveroo|uber\s+eats)\b/i, category: 'subsistence', hint: 'Was this meal while you were travelling overnight for business? Meals are only allowable in that case.' },
  // Professional body memberships (BIM50290)
  { key: 'exp_prompt_membership', pattern: /\b(membership|subscription)\b.*\b(professional|institute|chartered|association)\b/i, category: 'subscriptions', hint: 'Is this membership for a professional body directly related to your business?' },
  // Travel (not commuting — BIM37000)
  { key: 'exp_prompt_travel',     pattern: /\b(trainline|national\s+rail|easyjet|ryanair|british\s+airways|tfl|uber)\b/i, category: 'travel', hint: 'Was this journey for business? Commuting between home and a regular workplace is not allowable.' },
];

// ══════════════════════════════════════════════════════════════════════════════
// MAIN: processExpense
// Called for every debit transaction classified as Tier 2 expense by TCE
// ══════════════════════════════════════════════════════════════════════════════

async function processExpense(transactionId, userId) {
  // Step 1: Check SE user gate
  const userResult = await query(
    `SELECT income_structure FROM users WHERE id = $1`,
    [userId]
  );
  const user = userResult.rows[0];
  if (!user || !SE_STRUCTURES.includes(user.income_structure)) {
    return { action: 'skip', reason: 'Not an SE user' };
  }

  // Get transaction details
  const txnResult = await query(
    `SELECT amount, description, merchant_name, sub_category
     FROM transactions WHERE id = $1 AND user_id = $2`,
    [transactionId, userId]
  );
  if (txnResult.rows.length === 0) return { action: 'skip', reason: 'Transaction not found' };

  const txn = txnResult.rows[0];
  const absAmount = Math.abs(parseFloat(txn.amount));
  const descLower = ((txn.description || '') + ' ' + (txn.merchant_name || '')).toLowerCase();

  // Step 3: Tier 1 auto-detect
  for (const rule of TIER1_RULES) {
    if (rule.pattern.test(descLower)) {
      const deductAmount = Math.round(absAmount * rule.pct / 100 * 100) / 100;
      await recordExpense(userId, transactionId, {
        category:       rule.category,
        pct:            rule.pct,
        deduct_amount:  deductAmount,
        auto_detected:  true,
        hmrc_ref:       rule.hmrc,
      });
      await recalcTaxableProfit(userId);
      return { action: 'auto_deducted', category: rule.category, amount: deductAmount };
    }
  }

  // Step 4: Check prior user overrides
  const override = await query(
    `SELECT business_pct, hmrc_category FROM user_expense_overrides
     WHERE user_id = $1 AND merchant_pattern ILIKE $2
     LIMIT 1`,
    [userId, `%${txn.merchant_name || txn.description?.split(' ')[0]}%`]
  );
  if (override.rows.length > 0) {
    const pct = override.rows[0].business_pct;
    const deductAmount = Math.round(absAmount * pct / 100 * 100) / 100;
    await recordExpense(userId, transactionId, {
      category:      override.rows[0].hmrc_category,
      pct,
      deduct_amount: deductAmount,
      auto_detected: true,
      source:        'user_override',
    });
    await recalcTaxableProfit(userId);
    return { action: 'override_applied', amount: deductAmount };
  }

  // Step 5: Tier 2 prompted
  for (const rule of TIER2_RULES) {
    if (rule.pattern.test(descLower)) {
      // Fire notification prompt — user must confirm
      await query(`
        INSERT INTO notifications
          (user_id, alert_type, severity, title, body, dedup_key)
        VALUES ($1, 'CLASSIF_EXPENSE_POTENTIAL', 'INFO', $2, $3, $4)
        ON CONFLICT (user_id, dedup_key) DO NOTHING
      `, [
        userId,
        'Possible business expense',
        `${txn.merchant_name || txn.description} — ${rule.hint}`,
        `${rule.key}_${transactionId}`,
      ]);
      return { action: 'prompted', key: rule.key, hint: rule.hint };
    }
  }

  // Step 6: No match — available for manual marking
  return { action: 'no_match', reason: 'No auto or prompted rule matched' };
}

// ══════════════════════════════════════════════════════════════════════════════
// HOME OFFICE CALCULATION (HMRC flat rate method)
// ══════════════════════════════════════════════════════════════════════════════

// HMRC flat rates (per month, by hours of business use per month)
const HOME_OFFICE_FLAT_RATES = [
  { minHours: 25, maxHours: 50,  monthlyRate: 10  },
  { minHours: 51, maxHours: 100, monthlyRate: 18  },
  { minHours: 101, maxHours: Infinity, monthlyRate: 26 },
];

async function calcHomeOfficeDeduction(userId, monthlyHours, method = 'flat_rate') {
  if (method === 'flat_rate') {
    const tier = HOME_OFFICE_FLAT_RATES.find(
      r => monthlyHours >= r.minHours && monthlyHours <= r.maxHours
    );
    if (!tier) return { annual: 0, monthly: 0, method: 'flat_rate', eligible: false };
    const monthly = tier.monthlyRate;
    const annual  = monthly * 12;
    return { annual, monthly, method: 'flat_rate', eligible: true, hours: monthlyHours };
  }
  return { annual: 0, method: 'unsupported' };
}

// ══════════════════════════════════════════════════════════════════════════════
// MILEAGE TRACKING (45p/25p HMRC rates)
// ══════════════════════════════════════════════════════════════════════════════

const MILEAGE_RATE_FIRST  = 0.45; // First 10,000 miles
const MILEAGE_RATE_ABOVE  = 0.25; // Above 10,000 miles
const MILEAGE_THRESHOLD   = 10000;

async function calcMileageDeduction(userId, taxYear = '2026/27') {
  const result = await query(
    `SELECT COALESCE(SUM(miles), 0) as total_miles
     FROM mileage_log
     WHERE user_id = $1 AND tax_year = $2`,
    [userId, taxYear]
  );

  const totalMiles = parseFloat(result.rows[0]?.total_miles) || 0;
  const firstMiles  = Math.min(totalMiles, MILEAGE_THRESHOLD);
  const aboveMiles  = Math.max(0, totalMiles - MILEAGE_THRESHOLD);
  const deduction   = Math.round((firstMiles * MILEAGE_RATE_FIRST + aboveMiles * MILEAGE_RATE_ABOVE) * 100) / 100;

  return { total_miles: totalMiles, deduction, rate_first: MILEAGE_RATE_FIRST, rate_above: MILEAGE_RATE_ABOVE };
}

// ══════════════════════════════════════════════════════════════════════════════
// TAXABLE PROFIT CALCULATION
// Formula: gross_se_income - total_allowable_expenses
// Written to users.taxable_profit — Tax Engine reads this
// ══════════════════════════════════════════════════════════════════════════════

async function recalcTaxableProfit(userId) {
  const taxYear = getCurrentTaxYear();

  // Sum all confirmed allowable expenses
  const expResult = await query(
    `SELECT COALESCE(SUM(deduct_amount), 0) as total_deductions
     FROM expense_records
     WHERE user_id = $1 AND tax_year = $2 AND confirmed = true`,
    [userId, taxYear]
  );

  // Home office deduction
  const hoResult = await query(
    `SELECT annual_deduction FROM home_office_config WHERE user_id = $1`,
    [userId]
  );
  const homeOffice = parseFloat(hoResult.rows[0]?.annual_deduction) || 0;

  // Mileage deduction
  const mileage = await calcMileageDeduction(userId, taxYear);

  const totalDeductions = Math.round(
    (parseFloat(expResult.rows[0].total_deductions) + homeOffice + mileage.deduction) * 100
  ) / 100;

  // Get gross SE income
  const incomeResult = await query(
    `SELECT COALESCE(SUM(gross_amount), 0) as gross_se
     FROM income_events
     WHERE user_id = $1 AND tax_year = $2
       AND income_type IN ('se', 'cis')
       AND included_in_smoothing = true`,
    [userId, taxYear]
  );

  const grossSE = parseFloat(incomeResult.rows[0]?.gross_se) || 0;
  const taxableProfit = Math.max(0, Math.round((grossSE - totalDeductions) * 100) / 100);

  // Write to users table — Tax Engine reads taxable_profit
  await query(
    `UPDATE users SET
       taxable_profit   = $1,
       total_deductions = $2,
       updated_at       = NOW()
     WHERE id = $3`,
    [taxableProfit, totalDeductions, userId]
  );

  return { gross_se: grossSE, total_deductions: totalDeductions, taxable_profit: taxableProfit };
}

// ── Tax year helper ───────────────────────────────────────────────────────────
function getCurrentTaxYear() {
  const now   = new Date();
  const month = now.getMonth() + 1;
  const day   = now.getDate();
  const year  = now.getFullYear();
  const isNewYear = (month > 4) || (month === 4 && day >= 6);
  const startYear = isNewYear ? year : year - 1;
  return `${startYear}/${String(startYear + 1).slice(-2)}`;
}

// ── Record an expense ─────────────────────────────────────────────────────────
async function recordExpense(userId, transactionId, data) {
  const taxYear = getCurrentTaxYear();
  await query(`
    INSERT INTO expense_records
      (user_id, transaction_id, tax_year, hmrc_category, business_pct,
       deduct_amount, auto_detected, hmrc_ref, confirmed)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,true)
    ON CONFLICT (user_id, transaction_id) DO UPDATE SET
      hmrc_category = EXCLUDED.hmrc_category,
      business_pct  = EXCLUDED.business_pct,
      deduct_amount = EXCLUDED.deduct_amount,
      auto_detected = EXCLUDED.auto_detected,
      confirmed     = true,
      updated_at    = NOW()
  `, [
    userId, transactionId, taxYear,
    data.category, data.pct || 100, data.deduct_amount,
    data.auto_detected || false, data.hmrc_ref || null,
  ]);
}

module.exports = {
  processExpense,
  calcHomeOfficeDeduction,
  calcMileageDeduction,
  recalcTaxableProfit,
  getCurrentTaxYear,
  TIER1_RULES,
  TIER2_RULES,
};
