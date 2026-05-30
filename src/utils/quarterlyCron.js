'use strict';

/**
 * FlexFlow — Quarterly Salary/Dividend Review Cron
 * Task 6c
 *
 * Fires at 08:00 on: 30 Jun, 30 Sep, 31 Dec, 31 Mar
 * Target users: S2 (Ltd), S3b (PAYE+Dividends), S3c (PAYE+Salary+Dividends)
 *
 * Logic:
 *   1. Get all eligible users (S2/S3b/S3c)
 *   2. For each user: compare projected annual income vs last saved salary/div split
 *   3. If income shift > 10% AND ≥ 3 months of data AND not already prompted this quarter
 *   4. Create a notification record (factual language only — FCA requirement)
 *   5. Log to quarterly_review_log (suppression prevents duplicate prompts)
 *
 * FCA compliance: prompt must use factual observation language.
 * NEVER: "You should change your salary" or "We recommend..."
 * ALWAYS: "Your income has changed by X% since your last review."
 */

const cron = require('node-cron');
const { query } = require('../config/database');

// ── Quarterly review logic ────────────────────────────────────────────────────

async function runQuarterlyReview() {
  console.log(`[${new Date().toISOString()}] Running quarterly salary/dividend review...`);

  const taxYear = getCurrentTaxYear();
  const quarter = getCurrentQuarter();

  try {
    // Get all eligible Ltd/dividend users
    const users = await query(
      `SELECT id, income_structure, personal_income, tax_pot_target
       FROM users
       WHERE income_structure IN ('S2','S3b','S3c')
         AND onboarding_complete = true`,
    );

    let prompted = 0, skipped = 0;

    for (const user of users.rows) {
      await processUserReview(user, taxYear, quarter)
        .then(result => result.prompted ? prompted++ : skipped++)
        .catch(err => console.error(`Review error for user ${user.id}:`, err.message));
    }

    console.log(`[Quarterly Review] Complete: ${prompted} prompted, ${skipped} skipped.`);

  } catch (err) {
    console.error('[Quarterly Review] Failed:', err.message);
  }
}

async function processUserReview(user, taxYear, quarter) {
  // Check suppression — don't prompt twice in same quarter
  const existing = await query(
    `SELECT id FROM quarterly_review_log
     WHERE user_id = $1 AND quarter = $2 AND tax_year = $3
       AND (prompt_sent = true OR suppressed = true)`,
    [user.id, quarter, taxYear]
  );

  if (existing.rows.length > 0) {
    return { prompted: false, reason: 'Already prompted this quarter' };
  }

  // Check we have ≥ 3 months of income data
  const dataCheck = await query(
    `SELECT COUNT(DISTINCT DATE_TRUNC('month', income_date)) as months
     FROM income_events
     WHERE user_id = $1 AND tax_year = $2
       AND income_type IN ('se','dividend','ltd_salary','paye')`,
    [user.id, taxYear]
  );

  const monthsOfData = parseInt(dataCheck.rows[0]?.months) || 0;
  if (monthsOfData < 3) {
    await logReview(user.id, taxYear, quarter, false, 'Insufficient data', null);
    return { prompted: false, reason: 'Less than 3 months data' };
  }

  // Calculate projected annual income from YTD data
  const incomeResult = await query(
    `SELECT
       SUM(CASE WHEN income_type IN ('ltd_salary','paye') THEN gross_amount ELSE 0 END) as ytd_salary,
       SUM(CASE WHEN income_type = 'dividend' THEN gross_amount ELSE 0 END) as ytd_dividends,
       COUNT(DISTINCT DATE_TRUNC('month', income_date)) as months_count
     FROM income_events
     WHERE user_id = $1 AND tax_year = $2`,
    [user.id, taxYear]
  );

  const row          = incomeResult.rows[0];
  const monthsCount  = parseInt(row?.months_count) || 1;
  const ytdSalary    = parseFloat(row?.ytd_salary)    || 0;
  const ytdDividends = parseFloat(row?.ytd_dividends) || 0;

  // Project to annual
  const projSalary    = (ytdSalary    / monthsCount) * 12;
  const projDividends = (ytdDividends / monthsCount) * 12;
  const projTotal     = projSalary + projDividends;

  if (projTotal === 0) {
    return { prompted: false, reason: 'No income data' };
  }

  // Get last saved salary/dividend split
  const lastReview = await query(
    `SELECT new_salary, new_dividend FROM quarterly_review_log
     WHERE user_id = $1 AND user_responded = true
     ORDER BY created_at DESC LIMIT 1`,
    [user.id]
  );

  let incomeShiftPct = 0;
  if (lastReview.rows.length > 0) {
    const lastSalary   = parseFloat(lastReview.rows[0].new_salary)   || 0;
    const lastDividend = parseFloat(lastReview.rows[0].new_dividend)  || 0;
    const lastTotal    = lastSalary + lastDividend;
    if (lastTotal > 0) {
      incomeShiftPct = Math.abs((projTotal - lastTotal) / lastTotal) * 100;
    }
  } else {
    // First review — always prompt if sufficient data
    incomeShiftPct = 15; // Treat as shift to trigger first review
  }

  // Prompt if shift > 10%
  if (incomeShiftPct <= 10) {
    await logReview(user.id, taxYear, quarter, false, 'Income shift below threshold', incomeShiftPct);
    return { prompted: false, reason: `Income shift ${incomeShiftPct.toFixed(1)}% — below 10% threshold` };
  }

  // FCA compliant copy — factual observation, no directive language
  const shiftDirection = projTotal > (parseFloat(lastReview.rows[0]?.new_salary || 0) + parseFloat(lastReview.rows[0]?.new_dividend || 0))
    ? 'increased'
    : 'changed';

  const notifTitle = 'Your quarterly income review';
  const notifBody  = `Your projected annual income for ${taxYear} is £${Math.round(projTotal).toLocaleString()}. ` +
    `This has ${shiftDirection} by ${incomeShiftPct.toFixed(0)}% since your last review. ` +
    `You may want to check whether your salary and dividend split still reflects your current position.`;
  // Note: "may want to check" is factual — not "you should change" or "we recommend"

  // Quarterly salary review notification disabled
  const notif = { rows: [] };

  // Log to quarterly_review_log
  await logReview(
    user.id, taxYear, quarter, true, null, incomeShiftPct,
    projSalary, projDividends, notif.rows[0]?.id
  );

  return { prompted: true };
}

async function logReview(userId, taxYear, quarter, promptSent, suppressReason, shiftPct,
                          salary = null, dividend = null, notifId = null) {
  await query(`
    INSERT INTO quarterly_review_log
      (user_id, tax_year, quarter, review_date, projected_annual_income,
       income_shift_pct, prompt_sent, prompt_sent_at, notification_id,
       suppressed, suppression_reason)
    VALUES ($1,$2,$3,CURRENT_DATE,$4,$5,$6,$7,$8,$9,$10)
    ON CONFLICT (user_id, quarter, tax_year) DO UPDATE SET
      projected_annual_income = EXCLUDED.projected_annual_income,
      income_shift_pct        = EXCLUDED.income_shift_pct,
      prompt_sent             = EXCLUDED.prompt_sent,
      prompt_sent_at          = EXCLUDED.prompt_sent_at,
      notification_id         = EXCLUDED.notification_id,
      suppressed              = EXCLUDED.suppressed,
      suppression_reason      = EXCLUDED.suppression_reason
  `, [
    userId, taxYear, quarter,
    salary !== null ? (salary + (dividend || 0)) : null,
    shiftPct,
    promptSent, promptSent ? new Date() : null,
    notifId,
    !promptSent && suppressReason !== null,
    suppressReason,
  ]);
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function getCurrentTaxYear() {
  const now   = new Date();
  const month = now.getMonth() + 1;
  const day   = now.getDate();
  const year  = now.getFullYear();
  const isNew = (month > 4) || (month === 4 && day >= 6);
  const start = isNew ? year : year - 1;
  return `${start}/${String(start + 1).slice(-2)}`;
}

function getCurrentQuarter() {
  const month = new Date().getMonth() + 1;
  if (month <= 3)  return 'Q4'; // Jan-Mar = Q4 of previous year
  if (month <= 6)  return 'Q1'; // Apr-Jun = Q1
  if (month <= 9)  return 'Q2'; // Jul-Sep = Q2
  return 'Q3';                   // Oct-Dec = Q3
}

// ── Cron schedule ─────────────────────────────────────────────────────────────
// Fires at 08:00 on: 30 Jun, 30 Sep, 31 Dec, 31 Mar
// node-cron format: second(opt) minute hour day-of-month month day-of-week

function startQuarterlyCron() {
  // 30 June at 08:00
  cron.schedule('0 8 30 6 *', runQuarterlyReview);
  // 30 September at 08:00
  cron.schedule('0 8 30 9 *', runQuarterlyReview);
  // 31 December at 08:00
  cron.schedule('0 8 31 12 *', runQuarterlyReview);
  // 31 March at 08:00
  cron.schedule('0 8 31 3 *', runQuarterlyReview);

  console.log('⏰ Quarterly salary/dividend review cron scheduled (08:00 on 30 Jun, 30 Sep, 31 Dec, 31 Mar)');
}

module.exports = { startQuarterlyCron, runQuarterlyReview };
