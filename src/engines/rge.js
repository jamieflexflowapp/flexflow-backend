'use strict';

/**
 * FlexFlow — Report Generation Engine (RGE v1.3)
 * Session J — Task 9
 *
 * Transforms engine outputs into professionally formatted documents.
 * READS ONLY — never recalculates anything. Every number is from an upstream engine.
 *
 * Reports produced:
 *   Monthly PDF      — PLUS + PRO — auto last day of month
 *   Quarterly PDF    — PRO only   — end of each calendar quarter
 *   Annual PDF       — PRO only   — end of each tax year (5 April)
 *   Monthly CSV      — ALL tiers  — raw transaction export
 *
 * Storage: AWS S3 with 7-year retention lifecycle policy
 * FCA: factual only — no advice, no recommendations, no directive language
 *
 * Source: RGE v1.3 Specification (May 2026)
 */

const PDFDocument = require('pdfkit');
const { query }   = require('../config/database');

// FlexFlow design system — from indexv2.html
const COLOURS = {
  bg:         '#0E1928',
  navy:       '#14213D',
  teal:       '#0D7377',
  tealLight:  '#14A8AE',
  amber:      '#F4A261',
  white:      '#FFFFFF',
  greyLight:  '#9CA3AF',
  grey:       '#6B7280',
  red:        '#EF4444',
  green:      '#22C55E',
};

// FCA disclaimer — fixed footer on every page
const FCA_DISCLAIMER = 'This report presents your financial data from your connected bank accounts. It does not constitute financial, tax, or legal advice. Figures are based on transactions received and classified to the date shown.';
const ACCOUNTANT_DISCLAIMER = 'This report presents financial data from your connected bank accounts. It does not constitute financial, tax, or legal advice. Your accountant should review all figures before use in any official submission.';

// ══════════════════════════════════════════════════════════════════════════════
// DATA ASSEMBLY — reads from all upstream engines
// ══════════════════════════════════════════════════════════════════════════════

async function assembleMonthlyData(userId, year, month) {
  const monthStart = `${year}-${String(month).padStart(2,'0')}-01`;
  const monthEnd   = new Date(year, month, 0).toISOString().split('T')[0];
  const taxYear    = getTaxYear(new Date(year, month - 1, 1));

  // User profile
  const userResult = await query(
    `SELECT full_name, income_structure, confidence_level, personal_income,
            tax_pot_target, monthly_tax_allocation, is_vat_registered, plan
     FROM users WHERE id = $1`,
    [userId]
  );
  const user = userResult.rows[0];

  // Section 1: Income
  const incomeResult = await query(
    `SELECT ie.income_type, ie.amount, ie.gross_amount, ie.is_cis,
            ie.cis_deduction_rate, is2.name as source_name, is2.reliability_score
     FROM income_events ie
     LEFT JOIN income_sources is2 ON is2.id = ie.income_source_id
     WHERE ie.user_id = $1
       AND ie.income_date >= $2 AND ie.income_date <= $3`,
    [userId, monthStart, monthEnd]
  );
  const incomeEvents  = incomeResult.rows;
  const totalIncome   = incomeEvents.reduce((s, r) => s + parseFloat(r.amount), 0);

  // Section 2: Spending
  const tier1Result = await query(
    `SELECT name, monthly_equiv as amount, category
     FROM committed_outgoings
     WHERE user_id = $1 AND is_tier1 = true AND is_active = true`,
    [userId]
  );
  const tier2Result = await query(
    `SELECT sub_category, SUM(ABS(amount)) as total
     FROM transactions
     WHERE user_id = $1 AND category = 'expense' AND sub_category != 'committed_outgoing'
       AND transaction_date >= $2 AND transaction_date <= $3
     GROUP BY sub_category`,
    [userId, monthStart, monthEnd]
  );
  const tier1Total = tier1Result.rows.reduce((s, r) => s + parseFloat(r.amount), 0);
  const tier2Total = tier2Result.rows.reduce((s, r) => s + parseFloat(r.total), 0);

  // Section 3: Tax pot (from TPVE)
  const tpveResult = await query(
    `SELECT status, current_pot_balance, target_pot_balance, coverage_pct
     FROM tax_verification WHERE user_id = $1 AND tax_year = $2`,
    [userId, taxYear]
  );
  const tpve = tpveResult.rows[0] || { status: 'TPVE_UNKNOWN', current_pot_balance: 0, target_pot_balance: 0, coverage_pct: 0 };

  // Section 4: Runway
  const runwayResult = await query(
    `SELECT runway_weeks, runway_status, available_balance, tier1_monthly
     FROM runway_snapshots WHERE user_id = $1
     ORDER BY snapshot_date DESC LIMIT 1`,
    [userId]
  );
  const runway = runwayResult.rows[0] || { runway_weeks: 0, runway_status: 'UNKNOWN' };

  // Tax calculations
  const taxResult = await query(
    `SELECT total_tax_liability, monthly_tax_pot_contrib, sa_deadline
     FROM tax_calculations WHERE user_id = $1 AND tax_year = $2`,
    [userId, taxYear]
  );
  const taxCalc = taxResult.rows[0] || {};

  return {
    user, taxYear,
    period: { year, month, monthStart, monthEnd },
    income:  { events: incomeEvents, total: Math.round(totalIncome * 100) / 100 },
    spending: {
      tier1: { items: tier1Result.rows, total: Math.round(tier1Total * 100) / 100 },
      tier2: { items: tier2Result.rows, total: Math.round(tier2Total * 100) / 100 },
      taxAllocation: parseFloat(user.monthly_tax_allocation) || 0,
    },
    tpve,
    runway,
    taxCalc,
  };
}

async function assembleQuarterlyData(userId, year, quarter) {
  // Quarter month ranges: Q1=Jan-Mar, Q2=Apr-Jun, Q3=Jul-Sep, Q4=Oct-Dec
  const quarterMonths = { Q1: [1,3], Q2: [4,6], Q3: [7,9], Q4: [10,12] };
  const [startMonth, endMonth] = quarterMonths[quarter];
  const periodStart = `${year}-${String(startMonth).padStart(2,'0')}-01`;
  const periodEnd   = new Date(year, endMonth, 0).toISOString().split('T')[0];
  const taxYear     = getTaxYear(new Date(year, startMonth - 1, 1));

  const userResult = await query(
    `SELECT full_name, income_structure, confidence_level, personal_income,
            taxable_profit, total_deductions, is_vat_registered
     FROM users WHERE id = $1`,
    [userId]
  );
  const user = userResult.rows[0];

  // Section 1: Income by month
  const incomeResult = await query(
    `SELECT DATE_TRUNC('month', income_date) as month,
            income_type, SUM(gross_amount) as total
     FROM income_events
     WHERE user_id = $1 AND income_date >= $2 AND income_date <= $3
     GROUP BY DATE_TRUNC('month', income_date), income_type
     ORDER BY month`,
    [userId, periodStart, periodEnd]
  );

  // Section 2: Expense deductions (EDE v2 output)
  const expenseResult = await query(
    `SELECT hmrc_category, SUM(deduct_amount) as total, COUNT(*) as count
     FROM expense_records
     WHERE user_id = $1 AND confirmed = true
       AND tax_year = $2
     GROUP BY hmrc_category
     ORDER BY total DESC`,
    [userId, taxYear]
  );

  // Mileage
  const mileageResult = await query(
    `SELECT SUM(miles) as total_miles FROM mileage_log
     WHERE user_id = $1 AND tax_year = $2`,
    [userId, taxYear]
  );

  // VAT
  const vatResult = await query(
    `SELECT vat_owed, is_vat_registered, vat_deadline
     FROM tax_calculations WHERE user_id = $1 AND tax_year = $2`,
    [userId, taxYear]
  );

  return {
    user, taxYear, quarter, year,
    period: { periodStart, periodEnd, startMonth, endMonth },
    income:    incomeResult.rows,
    expenses:  expenseResult.rows,
    mileage:   mileageResult.rows[0] || { total_miles: 0 },
    vat:       vatResult.rows[0] || {},
  };
}

// ══════════════════════════════════════════════════════════════════════════════
// PDF GENERATION
// ══════════════════════════════════════════════════════════════════════════════

async function generateMonthlyPDF(userId, year, month) {
  const data = await assembleMonthlyData(userId, year, month);
  const monthName = new Date(year, month - 1, 1).toLocaleString('en-GB', { month: 'long' });

  const doc = new PDFDocument({ margin: 50, size: 'A4' });
  const buffers = [];
  doc.on('data', b => buffers.push(b));

  // ── Header ────────────────────────────────────────────────────────────────
  doc.rect(0, 0, doc.page.width, 80).fill('#0E1928');
  doc.fillColor('#14A8AE').fontSize(20).font('Helvetica-Bold')
     .text('FlexFlow', 50, 25);
  doc.fillColor('#FFFFFF').fontSize(12).font('Helvetica')
     .text(`Monthly Summary — ${monthName} ${year}`, 50, 50);
  doc.fillColor('#9CA3AF').fontSize(9)
     .text(`${data.user.full_name} · Tax year ${data.taxYear} · Prepared automatically`, 50, 65);

  doc.moveDown(3);

  // ── Section 5: Month at a Glance ─────────────────────────────────────────
  renderSectionHeader(doc, 'Month at a Glance');
  const glance = [
    { label: 'Income in',       value: `£${data.income.total.toFixed(2)}` },
    { label: 'Committed out',   value: `£${data.spending.tier1.total.toFixed(2)}` },
    { label: 'Tax set aside',   value: `£${data.spending.taxAllocation.toFixed(2)}` },
    { label: 'Tax pot coverage',value: `${Math.round(parseFloat(data.tpve.coverage_pct) || 0)}%` },
    { label: 'Runway',          value: `${parseFloat(data.runway.runway_weeks || 0).toFixed(1)} weeks` },
  ];
  renderKeyValueTable(doc, glance);

  // ── Section 1: Income ─────────────────────────────────────────────────────
  renderSectionHeader(doc, '1. Income This Month');
  doc.fillColor('#374151').fontSize(10).font('Helvetica')
     .text(`Total income received: £${data.income.total.toFixed(2)}`, { indent: 10 });
  doc.moveDown(0.5);

  if (data.income.events.length > 0) {
    const incomeRows = data.income.events.map(e => ({
      label: `${e.source_name || e.income_type.toUpperCase()}`,
      value: `£${parseFloat(e.amount).toFixed(2)}${e.is_cis ? ' (net)' : ''}`,
    }));
    renderKeyValueTable(doc, incomeRows);
  } else {
    doc.fillColor('#6B7280').fontSize(9).text('No income events recorded this month.', { indent: 10 });
  }

  doc.fillColor('#6B7280').fontSize(8)
     .text(`Personal Income (FlexFlow smoothed average): £${parseFloat(data.user.personal_income || 0).toFixed(2)}`, { indent: 10 });
  doc.moveDown(1);

  // ── Section 2: Spending ───────────────────────────────────────────────────
  renderSectionHeader(doc, '2. Spending This Month');
  doc.fillColor('#374151').fontSize(10)
     .text(`Tier 1 committed outgoings: £${data.spending.tier1.total.toFixed(2)}`, { indent: 10 });
  data.spending.tier1.items.forEach(item => {
    doc.fillColor('#6B7280').fontSize(9)
       .text(`  ${item.name}: £${parseFloat(item.amount).toFixed(2)}`, { indent: 20 });
  });
  doc.moveDown(0.5);
  doc.fillColor('#374151').fontSize(10)
     .text(`Tier 2 discretionary: £${data.spending.tier2.total.toFixed(2)}`, { indent: 10 });
  doc.fillColor('#6B7280').fontSize(9)
     .text(`Tax pot contribution: £${data.spending.taxAllocation.toFixed(2)}`, { indent: 10 });
  doc.moveDown(1);

  // ── Section 3: Tax Pot ────────────────────────────────────────────────────
  renderSectionHeader(doc, '3. Tax Pot Status');
  const tpveRows = [
    { label: 'Current pot balance', value: `£${parseFloat(data.tpve.current_pot_balance || 0).toFixed(2)}` },
    { label: 'Target balance',      value: `£${parseFloat(data.tpve.target_pot_balance || 0).toFixed(2)}` },
    { label: 'Coverage',            value: `${Math.round(parseFloat(data.tpve.coverage_pct || 0))}%` },
    { label: 'Status',              value: data.tpve.status || 'UNKNOWN' },
  ];
  renderKeyValueTable(doc, tpveRows);
  doc.moveDown(1);

  // ── Section 4: Runway ─────────────────────────────────────────────────────
  renderSectionHeader(doc, '4. Runway');
  const runwayRows = [
    { label: 'Available balance', value: `£${parseFloat(data.runway.available_balance || 0).toFixed(2)}` },
    { label: 'Runway',           value: `${parseFloat(data.runway.runway_weeks || 0).toFixed(1)} weeks` },
    { label: 'Status',           value: data.runway.runway_status || 'UNKNOWN' },
  ];
  renderKeyValueTable(doc, runwayRows);

  // ── Footer ────────────────────────────────────────────────────────────────
  addFooter(doc, FCA_DISCLAIMER);

  doc.end();
  return new Promise(resolve => {
    doc.on('end', () => resolve(Buffer.concat(buffers)));
  });
}

async function generateQuarterlyPDF(userId, year, quarter) {
  const data = await assembleQuarterlyData(userId, year, quarter);

  const doc = new PDFDocument({ margin: 50, size: 'A4' });
  const buffers = [];
  doc.on('data', b => buffers.push(b));

  // Header
  doc.rect(0, 0, doc.page.width, 80).fill('#0E1928');
  doc.fillColor('#14A8AE').fontSize(20).font('Helvetica-Bold').text('FlexFlow', 50, 25);
  doc.fillColor('#FFFFFF').fontSize(12).font('Helvetica')
     .text(`Quarterly Financial Summary — ${quarter} ${year}`, 50, 50);
  doc.fillColor('#9CA3AF').fontSize(9)
     .text(`${data.user.full_name} · Tax year ${data.taxYear} · Prepared automatically`, 50, 65);
  doc.moveDown(3);

  // Section 1: Income by month
  renderSectionHeader(doc, '1. Income Summary by Month');
  if (data.income.length > 0) {
    data.income.forEach(row => {
      const m = new Date(row.month).toLocaleString('en-GB', { month: 'long' });
      doc.fillColor('#374151').fontSize(9)
         .text(`${m} — ${row.income_type.toUpperCase()}: £${parseFloat(row.total).toFixed(2)}`, { indent: 10 });
    });
  } else {
    doc.fillColor('#6B7280').fontSize(9).text('No income events recorded this quarter.', { indent: 10 });
  }
  doc.moveDown(1);

  // Section 2: Expense deductions
  renderSectionHeader(doc, '2. Expense Deductions by HMRC Category');
  if (data.expenses.length > 0) {
    const expRows = data.expenses.map(e => ({
      label: e.hmrc_category.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase()),
      value: `£${parseFloat(e.total).toFixed(2)} (${e.count} items)`,
    }));
    renderKeyValueTable(doc, expRows);
    doc.moveDown(0.5);
    const totalDed = data.expenses.reduce((s, e) => s + parseFloat(e.total), 0);
    doc.fillColor('#0D7377').fontSize(10).font('Helvetica-Bold')
       .text(`Total deductions: £${totalDed.toFixed(2)}`, { indent: 10 });
    doc.fillColor('#374151').fontSize(10).font('Helvetica')
       .text(`Taxable profit: £${parseFloat(data.user.taxable_profit || 0).toFixed(2)}`, { indent: 10 });
  } else {
    doc.fillColor('#6B7280').fontSize(9).text('No confirmed expense deductions this quarter.', { indent: 10 });
  }
  doc.moveDown(1);

  // Section 3: Mileage
  renderSectionHeader(doc, '3. Mileage Deduction');
  const miles = parseFloat(data.mileage.total_miles) || 0;
  const mileageDeduction = miles <= 10000
    ? miles * 0.45
    : (10000 * 0.45) + ((miles - 10000) * 0.25);
  doc.fillColor('#374151').fontSize(9).font('Helvetica')
     .text(`Total business miles: ${miles.toFixed(0)}`, { indent: 10 })
     .text(`Mileage deduction: £${mileageDeduction.toFixed(2)}`, { indent: 10 });
  doc.moveDown(1);

  // Section 4: VAT (if registered)
  if (data.user.is_vat_registered) {
    renderSectionHeader(doc, '4. VAT Position');
    doc.fillColor('#374151').fontSize(9)
       .text(`VAT owed: £${parseFloat(data.vat.vat_owed || 0).toFixed(2)}`, { indent: 10 })
       .text(`Next deadline: ${data.vat.vat_deadline || 'See HMRC account'}`, { indent: 10 });
    doc.moveDown(1);
  }

  addFooter(doc, ACCOUNTANT_DISCLAIMER);
  doc.end();

  return new Promise(resolve => {
    doc.on('end', () => resolve(Buffer.concat(buffers)));
  });
}

// ══════════════════════════════════════════════════════════════════════════════
// CSV GENERATION — all tiers
// ══════════════════════════════════════════════════════════════════════════════

async function generateMonthlyCSV(userId, year, month) {
  const monthStart = `${year}-${String(month).padStart(2,'0')}-01`;
  const monthEnd   = new Date(year, month, 0).toISOString().split('T')[0];

  const result = await query(
    `SELECT t.transaction_date, t.description, t.merchant_name,
            t.amount, t.category, t.sub_category, t.transaction_type,
            bc.account_name, bc.provider
     FROM transactions t
     LEFT JOIN bank_connections bc ON bc.id = t.bank_connection_id
     WHERE t.user_id = $1
       AND t.transaction_date >= $2
       AND t.transaction_date <= $3
     ORDER BY t.transaction_date DESC`,
    [userId, monthStart, monthEnd]
  );

  const headers = ['Date', 'Description', 'Merchant', 'Amount', 'Type', 'Category', 'Sub-Category', 'Account', 'Provider'];
  const rows = result.rows.map(r => [
    r.transaction_date?.toISOString?.()?.split?.('T')[0] || r.transaction_date,
    `"${(r.description || '').replace(/"/g, '""')}"`,
    `"${(r.merchant_name || '').replace(/"/g, '""')}"`,
    r.amount,
    r.transaction_type,
    r.category,
    r.sub_category,
    `"${(r.account_name || '').replace(/"/g, '""')}"`,
    r.provider,
  ]);

  const csv = [headers.join(','), ...rows.map(r => r.join(','))].join('\n');
  return csv;
}

// ══════════════════════════════════════════════════════════════════════════════
// PDF HELPERS
// ══════════════════════════════════════════════════════════════════════════════

function renderSectionHeader(doc, title) {
  doc.rect(50, doc.y, doc.page.width - 100, 24).fill('#0E1928');
  doc.fillColor('#14A8AE').fontSize(11).font('Helvetica-Bold')
     .text(title, 60, doc.y - 18);
  doc.moveDown(1);
}

function renderKeyValueTable(doc, rows) {
  rows.forEach(row => {
    const y = doc.y;
    doc.fillColor('#374151').fontSize(9).font('Helvetica')
       .text(row.label, 60, y, { width: 250 });
    doc.fillColor('#111827').fontSize(9).font('Helvetica-Bold')
       .text(row.value, 320, y, { width: 200, align: 'right' });
    doc.moveDown(0.6);
  });
}

function addFooter(doc, disclaimer) {
  const y = doc.page.height - 60;
  doc.rect(0, y - 10, doc.page.width, 70).fill('#F9FAFB');
  doc.fillColor('#6B7280').fontSize(7).font('Helvetica')
     .text(disclaimer, 50, y, { width: doc.page.width - 100, align: 'center' });
  doc.fillColor('#14A8AE').fontSize(7)
     .text('Generated by FlexFlow · flexflowapp.co.uk', 50, y + 20, { align: 'center', width: doc.page.width - 100 });
}

// ── Tax year helper ───────────────────────────────────────────────────────────
function getTaxYear(date) {
  const month = date.getMonth() + 1;
  const day   = date.getDate();
  const year  = date.getFullYear();
  const isNew = (month > 4) || (month === 4 && day >= 6);
  const start = isNew ? year : year - 1;
  return `${start}/${String(start + 1).slice(-2)}`;
}

module.exports = {
  generateMonthlyPDF,
  generateQuarterlyPDF,
  generateMonthlyCSV,
  assembleMonthlyData,
};
