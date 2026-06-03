'use strict';

/**
 * FlexFlow — Report Generation Engine (RGE v1.3)
 * Session J — Task 9
 *
 * Transforms engine outputs into professionally formatted documents.
 * READS ONLY — never recalculates anything. Every number is from an upstream engine.
 *
 * Reports produced:
 *   Monthly PDF      — PLUS + PRO — auto 1st of following month (covers previous month)
 *   [REMOVED] Quarterly PDF — removed, monthly + annual only
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
  const lastDay    = new Date(year, month, 0).getDate();
  const monthEnd   = `${year}-${String(month).padStart(2,'0')}-${String(lastDay).padStart(2,'0')}`;

  const userResult = await query('SELECT full_name, receives_pension, annual_personal_pension_net, annual_employer_pension_contribution, pension_contribution_frequency FROM users WHERE id = $1', [userId]);
  const userName = userResult.rows[0]?.full_name || 'FlexFlow User';
  const monthName = new Date(year, month - 1, 1).toLocaleString('en-GB', { month: 'long', year: 'numeric' });

  // Tax summary
  const taxYear = getTaxYear(new Date(year, month - 1, 1));
  const taxResult = await query(
    'SELECT total_tax_liability, it_total, ni_class2, ni_class4_main, ni_class4_upper, ni_total FROM tax_calculations WHERE user_id = $1 AND tax_year = $2',
    [userId, taxYear]
  );
  const tax = taxResult.rows[0] || {};

  // FYTD income (tax year start to end of this month)
  const [tyStart] = taxYear.split('/');
  const fyStart = parseInt(tyStart) + '-04-06';
  const fytdIncomeResult = await query(
    'SELECT SUM(amount) as total FROM transactions WHERE user_id = $1 AND is_income = true AND user_confirmed = true AND transaction_date >= $2 AND transaction_date <= $3',
    [userId, fyStart, monthEnd]
  );
  const fytdIncome = parseFloat(fytdIncomeResult.rows[0]?.total || 0);

  // FYTD expenses (tax year start to end of this month)
  const fytdExpenseResult = await query(
    'SELECT SUM(ABS(amount)) as total FROM transactions WHERE user_id = $1 AND is_income = false AND user_confirmed = true AND transaction_date >= $2 AND transaction_date <= $3',
    [userId, fyStart, monthEnd]
  );
  const fytdExpenses = parseFloat(fytdExpenseResult.rows[0]?.total || 0);

  // Mileage deduction for this month
  const mileageMonthResult = await query(
    'SELECT SUM(miles) as total_miles FROM mileage_log WHERE user_id = $1 AND journey_date >= $2 AND journey_date <= $3',
    [userId, monthStart, monthEnd]
  );
  const mileageMonthMiles = parseFloat(mileageMonthResult.rows[0]?.total_miles || 0);
  const mileageMonthDeduction = mileageMonthMiles <= 10000
    ? mileageMonthMiles * 0.45
    : (10000 * 0.45) + ((mileageMonthMiles - 10000) * 0.25);

  // Mileage deduction FYTD
  const mileageFYTDResult = await query(
    'SELECT SUM(miles) as total_miles FROM mileage_log WHERE user_id = $1 AND journey_date >= $2 AND journey_date <= $3',
    [userId, fyStart, monthEnd]
  );
  const mileageFYTDMiles = parseFloat(mileageFYTDResult.rows[0]?.total_miles || 0);
  const mileageFYTDDeduction = mileageFYTDMiles <= 10000
    ? mileageFYTDMiles * 0.45
    : (10000 * 0.45) + ((mileageFYTDMiles - 10000) * 0.25);

  // Home office deduction (monthly flat rate from home_office_config)
  const hoursResult = await query('SELECT monthly_hours, monthly_deduction FROM home_office_config WHERE user_id = $1', [userId]);
  const hoHours = parseFloat(hoursResult.rows[0]?.monthly_hours || 0);
  const hoMonthly = parseFloat(hoursResult.rows[0]?.monthly_deduction || 0);
  const hoFYTD = hoMonthly * (Math.floor((new Date(monthEnd) - new Date(fyStart)) / (1000*60*60*24*30.44)) + 1);

  // Mileage trips for this month (detail rows)
  const mileageTripsResult = await query(
    'SELECT journey_date, purpose, miles FROM mileage_log WHERE user_id = $1 AND journey_date >= $2 AND journey_date <= $3 ORDER BY journey_date DESC',
    [userId, monthStart, monthEnd]
  );

  // Income transactions
  const incomeResult = await query(
    `SELECT t.transaction_date, t.description, t.merchant_name, t.amount, bc.account_name
     FROM transactions t
     LEFT JOIN bank_connections bc ON bc.id = t.bank_connection_id
     WHERE t.user_id = $1 AND t.is_income = true AND t.user_confirmed = true
       AND t.transaction_date >= $2 AND t.transaction_date <= $3
     ORDER BY t.transaction_date DESC`,
    [userId, monthStart, monthEnd]
  );

  // Expense transactions
  const expenseResult = await query(
    `SELECT t.transaction_date, t.description, t.merchant_name, t.amount, t.category, t.sub_category, bc.account_name
     FROM transactions t
     LEFT JOIN bank_connections bc ON bc.id = t.bank_connection_id
     WHERE t.user_id = $1 AND t.is_income = false AND t.user_confirmed = true
       AND t.transaction_date >= $2 AND t.transaction_date <= $3
     ORDER BY t.transaction_date DESC`,
    [userId, monthStart, monthEnd]
  );

  const esc = (v) => { const s = String(v ?? ''); return (s.includes(',') || s.includes('"')) ? '"' + s.replace(/"/g, '""') + '"' : s; };
  const fmtDate = (d) => d ? new Date(d).toLocaleDateString('en-GB') : '';
  const fmtAmt = (n) => parseFloat(n || 0).toFixed(2);

  const totalIncome = incomeResult.rows.reduce((s, r) => s + parseFloat(r.amount || 0), 0);
  const totalExpenses = expenseResult.rows.reduce((s, r) => s + Math.abs(parseFloat(r.amount || 0)), 0);

  const rows = [
    'FlexFlow - Monthly Financial Report',
    'Period,' + monthName,
    'Generated,' + new Date().toLocaleDateString('en-GB'),
    'Name,' + esc(userName),
    'Tax Year,' + taxYear,
    '',
    'SECTION 1 - MONTHLY SUMMARY',
    'Field,Amount',
    'Total Income (FY to Date),' + fmtAmt(fytdIncome),
    'Total Income (' + new Date(year, month - 1, 1).toLocaleString('en-GB', { month: 'long' }) + '),' + fmtAmt(totalIncome),
    'Total Expenses (FY to Date),' + fmtAmt(fytdExpenses),
    'Total Expenses (' + new Date(year, month - 1, 1).toLocaleString('en-GB', { month: 'long' }) + '),' + fmtAmt(totalExpenses),
    'Mileage Deduction (' + new Date(year, month - 1, 1).toLocaleString('en-GB', { month: 'long' }) + '),' + fmtAmt(mileageMonthDeduction),
    'Mileage Deduction (FY to Date),' + fmtAmt(mileageFYTDDeduction),
    'Home Office Deduction (monthly),' + fmtAmt(hoMonthly),
    'Home Office Deduction (FY to Date),' + fmtAmt(hoFYTD),
    'Total Allowable Deductions (' + new Date(year, month - 1, 1).toLocaleString('en-GB', { month: 'long' }) + '),' + fmtAmt(totalExpenses + mileageMonthDeduction + hoMonthly),
    'Total Allowable Deductions (FY to Date),' + fmtAmt(fytdExpenses + mileageFYTDDeduction + hoFYTD),
    'Income Tax (FY to Date),' + fmtAmt(tax.it_total),
    'NI Class 2 (FY to Date),' + fmtAmt(tax.ni_class2),
    'NI Class 4 Main (FY to Date),' + fmtAmt(tax.ni_class4_main),
    'NI Class 4 Upper (FY to Date),' + fmtAmt(tax.ni_class4_upper),
    'Total Tax Liability (FY to Date),' + fmtAmt(tax.total_tax_liability),
    ...(userResult.rows[0]?.receives_pension ? [
      '',
      'PENSION',
      'Personal Pension (annual net),' + fmtAmt(userResult.rows[0].annual_personal_pension_net),
      'Employer Pension (annual),' + fmtAmt(userResult.rows[0].annual_employer_pension_contribution),
      'Contribution Frequency,' + (userResult.rows[0].pension_contribution_frequency || 'annual'),
    ] : []),

    '',
    'SECTION 2 - INCOME TRANSACTIONS',
    'Date,Description,Merchant,Amount,Account',
    ...incomeResult.rows.map(r => [fmtDate(r.transaction_date), esc(r.description), esc(r.merchant_name), fmtAmt(r.amount), esc(r.account_name)].join(',')),
    '',
    'SECTION 3 - EXPENSE TRANSACTIONS',
    'Date,Description,Merchant,Amount,Category,Sub-Category,Account',
    ...expenseResult.rows.map(r => [fmtDate(r.transaction_date), esc(r.description), esc(r.merchant_name), fmtAmt(Math.abs(r.amount)), esc(r.category), esc(r.sub_category), esc(r.account_name)].join(',')),
    '',
    'SECTION 4 - ALLOWABLE DEDUCTIONS',
    '',
    'Mileage Deduction',
    'Date,Purpose,Miles,Deduction (£)',
    ...mileageTripsResult.rows.map(r => {
      const m = parseFloat(r.miles || 0);
      const d = m * 0.45;
      return [fmtDate(r.journey_date), esc(r.purpose), fmtAmt(m), fmtAmt(d)].join(',');
    }),
    'Total Mileage This Month,' + fmtAmt(mileageMonthMiles) + ' miles,' + fmtAmt(mileageMonthDeduction),
    '',
    'Home Office (Flat Rate)',
    'Hours/Month,Monthly Deduction (£)',
    fmtAmt(hoHours) + ',' + fmtAmt(hoMonthly),
  ];

  return '\uFEFF' + rows.join('\r\n');
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

async function generateAnnualPDF(userId, taxYear) {
  const [startYearStr] = taxYear.split('/');
  const startYear = parseInt(startYearStr);
  const fyStart = startYear + '-04-06';
  const fyEnd   = (startYear + 1) + '-04-05';
  const userResult = await query('SELECT full_name, income_structure FROM users WHERE id = $1', [userId]);
  const user = userResult.rows[0];
  const incomeResult = await query('SELECT SUM(amount) as total FROM income_events WHERE user_id = $1 AND income_date >= $2 AND income_date <= $3', [userId, fyStart, fyEnd]);
  const totalIncome = parseFloat(incomeResult.rows[0]?.total || 0);
  const expenseResult = await query("SELECT SUM(ABS(amount)) as total FROM transactions WHERE user_id = $1 AND category = 'expense' AND transaction_date >= $2 AND transaction_date <= $3", [userId, fyStart, fyEnd]);
  const totalExpenses = parseFloat(expenseResult.rows[0]?.total || 0);
  const taxResult = await query('SELECT total_tax_liability, income_tax, national_insurance, total_deductions, sa_deadline FROM tax_calculations WHERE user_id = $1 AND tax_year = $2', [userId, taxYear]);
  const taxCalc = taxResult.rows[0] || {};
  const monthlyResult = await query("SELECT DATE_TRUNC('month', income_date) as month, SUM(amount) as total FROM income_events WHERE user_id = $1 AND income_date >= $2 AND income_date <= $3 GROUP BY DATE_TRUNC('month', income_date) ORDER BY month", [userId, fyStart, fyEnd]);
  const doc = new PDFDocument({ margin: 50, size: 'A4' });
  const buffers = [];
  doc.on('data', b => buffers.push(b));
  doc.rect(0, 0, doc.page.width, 80).fill('#0E1928');
  doc.fillColor('#14A8AE').fontSize(20).font('Helvetica-Bold').text('FlexFlow', 50, 25);
  doc.fillColor('#FFFFFF').fontSize(12).font('Helvetica').text('Annual Summary — Tax Year ' + taxYear, 50, 50);
  doc.fillColor('#9CA3AF').fontSize(9).text(user.full_name + ' · Prepared automatically', 50, 65);
  doc.moveDown(3);
  renderSectionHeader(doc, 'Year at a Glance');
  renderKeyValueTable(doc, [
    { label: 'Total income',       value: '£' + totalIncome.toFixed(2) },
    { label: 'Total expenses',     value: '£' + totalExpenses.toFixed(2) },
    { label: 'Tax deductions',     value: '£' + parseFloat(taxCalc.total_deductions || 0).toFixed(2) },
    { label: 'Tax liability',      value: '£' + parseFloat(taxCalc.total_tax_liability || 0).toFixed(2) },
    { label: 'Income tax',         value: '£' + parseFloat(taxCalc.income_tax || 0).toFixed(2) },
    { label: 'National Insurance', value: '£' + parseFloat(taxCalc.national_insurance || 0).toFixed(2) },
    { label: 'SA deadline',        value: taxCalc.sa_deadline ? new Date(taxCalc.sa_deadline).toLocaleDateString('en-GB') : '31 Jan' },
  ]);
  doc.moveDown(1);
  renderSectionHeader(doc, 'Monthly Income Breakdown');
  if (monthlyResult.rows.length > 0) {
    renderKeyValueTable(doc, monthlyResult.rows.map(r => ({ label: new Date(r.month).toLocaleString('en-GB', { month: 'long', year: 'numeric' }), value: '£' + parseFloat(r.total).toFixed(2) })));
  } else {
    doc.fillColor('#6B7280').fontSize(9).text('No income events recorded this tax year.', { indent: 10 });
  }
  addFooter(doc, ACCOUNTANT_DISCLAIMER);
  doc.end();
  return new Promise(resolve => { doc.on('end', () => resolve(Buffer.concat(buffers))); });
}

async function generateAnnualCSV(userId, taxYear) {
  const [startYearStr] = taxYear.split('/');
  const startYear = parseInt(startYearStr);
  const fyStart = startYear + '-04-06';
  const fyEnd   = (startYear + 1) + '-04-05';
  const fmtAmt = (n) => parseFloat(n || 0).toFixed(2);

  const userResult = await query(
    'SELECT full_name, income_structure, receives_pension, annual_personal_pension_net, annual_employer_pension_contribution, pension_contribution_frequency FROM users WHERE id = $1',
    [userId]
  );
  const user = userResult.rows[0] || {};
  const isLtd = user.income_structure === 'ltd_director' || user.income_structure === 'S2';

  // Annual tax summary
  const taxResult = await query(
    'SELECT total_tax_liability, it_total, ni_class2, ni_class4_main, ni_class4_upper, gross_se_income FROM tax_calculations WHERE user_id = $1 AND tax_year = $2',
    [userId, taxYear]
  );
  const tax = taxResult.rows[0] || {};

  const ltdTax = isLtd ? (await query(
    'SELECT corp_tax_reserve, div_tax, employer_ni, total_tax_owed, earnings_post_tax FROM ltd_tax_calculations WHERE user_id = $1 AND tax_year = $2',
    [userId, taxYear]
  )).rows[0] || {} : {};

  // Total income and expenses for the year
  const totalIncomeResult = await query(
    'SELECT COALESCE(SUM(amount),0) as total FROM transactions WHERE user_id = $1 AND is_income = true AND user_confirmed = true AND transaction_date >= $2 AND transaction_date <= $3',
    [userId, fyStart, fyEnd]
  );
  const totalExpensesResult = await query(
    'SELECT COALESCE(SUM(ABS(amount)),0) as total FROM transactions WHERE user_id = $1 AND is_income = false AND user_confirmed = true AND transaction_date >= $2 AND transaction_date <= $3',
    [userId, fyStart, fyEnd]
  );
  const totalIncome = parseFloat(totalIncomeResult.rows[0].total);
  const totalExpenses = parseFloat(totalExpensesResult.rows[0].total);

  // Monthly income breakdown (Apr=4 to Mar=3 next year)
  const months = [];
  for (let i = 0; i < 12; i++) {
    const d = new Date(startYear, 3 + i, 1); // April = month 3
    const mStart = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2,'0') + '-01';
    const lastDay = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
    const mEnd = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2,'0') + '-' + String(lastDay).padStart(2,'0');
    const label = d.toLocaleString('en-GB', { month: 'long', year: 'numeric' });

    const inc = await query(
      'SELECT COALESCE(SUM(amount),0) as total FROM transactions WHERE user_id = $1 AND is_income = true AND user_confirmed = true AND transaction_date >= $2 AND transaction_date <= $3',
      [userId, mStart, mEnd]
    );
    const exp = await query(
      'SELECT COALESCE(SUM(ABS(amount)),0) as total FROM transactions WHERE user_id = $1 AND is_income = false AND user_confirmed = true AND transaction_date >= $2 AND transaction_date <= $3',
      [userId, mStart, mEnd]
    );
    months.push({ label, income: parseFloat(inc.rows[0].total), expenses: parseFloat(exp.rows[0].total) });
  }

  const rows = [
    'FlexFlow - ' + (isLtd ? 'Ltd Director' : 'Sole Trader') + ' Annual Report',
    'Tax Year,' + taxYear,
    'Generated,' + new Date().toLocaleDateString('en-GB'),
    'Name,' + (user.full_name || 'FlexFlow User'),
    '',
    'SECTION 1 - ANNUAL SUMMARY',
    'Field,Amount',
    'Total Income (FY to Date),' + fmtAmt(totalIncome),
    'Total Expenses (FY to Date),' + fmtAmt(totalExpenses),
    '',
    isLtd ? 'Corporation Tax Reserve,' + fmtAmt(ltdTax.corp_tax_reserve) : 'Income Tax (FY to Date),' + fmtAmt(tax.it_total),
    isLtd ? 'Dividend Tax,' + fmtAmt(ltdTax.div_tax) : 'NI Class 2 (FY to Date),' + fmtAmt(tax.ni_class2),
    isLtd ? 'Employer NI,' + fmtAmt(ltdTax.employer_ni) : 'NI Class 4 Main (FY to Date),' + fmtAmt(tax.ni_class4_main),
    isLtd ? 'Total Tax Liability (FY to Date),' + fmtAmt(ltdTax.total_tax_owed) : 'NI Class 4 Upper (FY to Date),' + fmtAmt(tax.ni_class4_upper),
    isLtd ? '' : 'Total Tax Liability (FY to Date),' + fmtAmt(tax.total_tax_liability),
    isLtd ? 'Post-Tax Earnings (FY to Date),' + fmtAmt(parseFloat(ltdTax.earnings_post_tax || 0)) : 'Post-Tax Earnings (FY to Date),' + fmtAmt(parseFloat(tax.gross_se_income || 0) - parseFloat(tax.total_tax_liability || 0)),
    ...(user.receives_pension ? [
      '',
      'PENSION',
      'Personal Pension (annual net),' + fmtAmt(user.annual_personal_pension_net),
      'Employer Pension (annual),' + fmtAmt(user.annual_employer_pension_contribution),
      'Contribution Frequency,' + (user.pension_contribution_frequency || 'annual'),
    ] : []),
    '',
    'SECTION 2 - MONTHLY INCOME BREAKDOWN',
    'Month,Income',
    ...months.map(m => m.label + ',' + fmtAmt(m.income)),
    '',
    'SECTION 3 - MONTHLY EXPENSE BREAKDOWN',
    'Month,Expenses',
    ...months.map(m => m.label + ',' + fmtAmt(m.expenses)),
  ];

  return '\uFEFF' + rows.join('\r\n');
}

async function generateLtdMonthlyCSV(userId, year, month) {
  const monthStart = `${year}-${String(month).padStart(2,'0')}-01`;
  const lastDay    = new Date(year, month, 0).getDate();
  const monthEnd   = `${year}-${String(month).padStart(2,'0')}-${String(lastDay).padStart(2,'0')}`;
  const taxYear    = getTaxYear(new Date(year, month - 1, 1));
  const monthName  = new Date(year, month - 1, 1).toLocaleString('en-GB', { month: 'long', year: 'numeric' });

  const userResult = await query(
    'SELECT full_name, receives_pension, annual_personal_pension_net, annual_employer_pension_contribution, pension_contribution_frequency FROM users WHERE id = $1',
    [userId]
  );
  const user = userResult.rows[0] || {};

  const ltdTax = (await query(
    'SELECT * FROM ltd_tax_calculations WHERE user_id = $1 AND tax_year = $2',
    [userId, taxYear]
  )).rows[0] || {};

  const incomeResult = await query(
    `SELECT t.transaction_date, t.description, t.merchant_name, t.amount, bc.account_name
     FROM transactions t
     LEFT JOIN bank_connections bc ON bc.id = t.bank_connection_id
     WHERE t.user_id = $1 AND t.is_income = true AND t.user_confirmed = true
       AND t.transaction_date >= $2 AND t.transaction_date <= $3
     ORDER BY t.transaction_date DESC`,
    [userId, monthStart, monthEnd]
  );

  const expenseResult = await query(
    `SELECT t.transaction_date, t.description, t.merchant_name, t.amount, t.category, t.sub_category, bc.account_name
     FROM transactions t
     LEFT JOIN bank_connections bc ON bc.id = t.bank_connection_id
     WHERE t.user_id = $1 AND t.is_income = false AND t.user_confirmed = true
       AND t.transaction_date >= $2 AND t.transaction_date <= $3
     ORDER BY t.transaction_date DESC`,
    [userId, monthStart, monthEnd]
  );

  const esc = (v) => { const s = String(v ?? ''); return (s.includes(',') || s.includes('"')) ? '"' + s.replace(/"/g, '""') + '"' : s; };
  const fmtDate = (d) => d ? new Date(d).toLocaleDateString('en-GB') : '';
  const fmtAmt = (n) => parseFloat(n || 0).toFixed(2);
  const monthLabel = new Date(year, month - 1, 1).toLocaleString('en-GB', { month: 'long' });

  const totalIncome = incomeResult.rows.reduce((s, r) => s + parseFloat(r.amount || 0), 0);
  const totalExpenses = expenseResult.rows.reduce((s, r) => s + Math.abs(parseFloat(r.amount || 0)), 0);

  const rows = [
    'FlexFlow - Ltd Director Monthly Report',
    'Period,' + monthName,
    'Generated,' + new Date().toLocaleDateString('en-GB'),
    'Name,' + esc(user.full_name || 'FlexFlow User'),
    'Tax Year,' + taxYear,
    '',
    'SECTION 1 - MONTHLY SUMMARY',
    'Field,Amount',
    'Total Income (FY to Date),' + fmtAmt(ltdTax.fytd_turnover),
    'Total Income (' + monthLabel + '),' + fmtAmt(totalIncome),
    'Total Expenses (FY to Date),' + fmtAmt(ltdTax.fytd_expenses),
    'Total Expenses (' + monthLabel + '),' + fmtAmt(totalExpenses),
    'Director Salary (Annual),' + fmtAmt(ltdTax.director_salary_annual),
    'Director Salary (Monthly),' + fmtAmt(ltdTax.director_salary_monthly),
    'Salary Paid (FY to Date),' + fmtAmt(ltdTax.salary_paid_ytd),
    'Employer NI (FY to Date),' + fmtAmt(ltdTax.employer_ni),
    'CT Taxable Profit,' + fmtAmt(ltdTax.ct_taxable_profit),
    'Corporation Tax Reserve,' + fmtAmt(ltdTax.corp_tax_reserve),
    'Dividend Tax,' + fmtAmt(ltdTax.div_tax),
    'Total Tax Liability (FY to Date),' + fmtAmt(ltdTax.total_tax_owed),
    ...(user.receives_pension ? [
      '',
      'PENSION',
      'Personal Pension (annual net),' + fmtAmt(user.annual_personal_pension_net),
      'Employer Pension (annual),' + fmtAmt(user.annual_employer_pension_contribution),
      'Contribution Frequency,' + (user.pension_contribution_frequency || 'annual'),
    ] : []),
    '',
    'SECTION 2 - INCOME TRANSACTIONS',
    'Date,Description,Merchant,Amount,Account',
    ...incomeResult.rows.map(r => [fmtDate(r.transaction_date), esc(r.description), esc(r.merchant_name), fmtAmt(r.amount), esc(r.account_name)].join(',')),
    '',
    'SECTION 3 - EXPENSE TRANSACTIONS',
    'Date,Description,Merchant,Amount,Category,Sub-Category,Account',
    ...expenseResult.rows.map(r => [fmtDate(r.transaction_date), esc(r.description), esc(r.merchant_name), fmtAmt(Math.abs(r.amount)), esc(r.category), esc(r.sub_category), esc(r.account_name)].join(',')),
  ];

  return '\uFEFF' + rows.join('\r\n');
}

module.exports = {
  generateMonthlyPDF,
  generateAnnualPDF,
  generateMonthlyCSV,
  generateAnnualCSV,
  generateLtdMonthlyCSV,
  assembleMonthlyData,
};
