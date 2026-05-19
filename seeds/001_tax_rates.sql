-- Seed 001: tax_rates — 2026/27 Complete Rate Set
-- ALL rates sourced and verified:
--   UK rates: House of Commons Library Direct Taxes 2026/27 (13 May 2026), GOV.UK, HMRC
--   Scottish rates: gov.scot official table (14 Jan 2026), ICAEW Tax News Jan 2026, Deloitte Tax Tables 2026/27
--   Dividend rates: GOV.UK Finance Act 2026 s.8, Budget 2025 OOTLAR
--   Section 24: GOV.UK, LITRG, Finance Act 2026 ss.5-7
--
-- ZERO hardcoded values in engine code — every rate is read from this table.
-- To update rates: npm run config:update-rates (DO NOT edit engine code)

-- ── UK INCOME TAX BANDS ──────────────────────────────────────────────────────
INSERT INTO tax_rates (tax_year, jurisdiction, parameter_key, parameter_value, description, effective_from, source)
VALUES
  ('2026/27', 'UK', 'personal_allowance',         12570,  'Personal Allowance — frozen until April 2031', '2026-04-06', 'GOV.UK / Budget 2025'),
  ('2026/27', 'UK', 'basic_rate_threshold',        50270,  'Upper limit of basic rate band', '2026-04-06', 'GOV.UK / Finance Act 2026'),
  ('2026/27', 'UK', 'higher_rate_threshold',       125140, 'Additional rate threshold', '2026-04-06', 'GOV.UK / Finance Act 2026'),
  ('2026/27', 'UK', 'pa_taper_start',              100000, 'PA taper starts at £100,000', '2026-04-06', 'GOV.UK'),
  ('2026/27', 'UK', 'pa_taper_rate',               0.5,    'Lose £1 PA per £2 above taper start', '2026-04-06', 'GOV.UK'),
  ('2026/27', 'UK', 'basic_rate',                  0.20,   'Income tax basic rate', '2026-04-06', 'GOV.UK / Finance Act 2026'),
  ('2026/27', 'UK', 'higher_rate',                 0.40,   'Income tax higher rate', '2026-04-06', 'GOV.UK / Finance Act 2026'),
  ('2026/27', 'UK', 'additional_rate',             0.45,   'Income tax additional rate', '2026-04-06', 'GOV.UK / Finance Act 2026'),

-- ── UK DIVIDEND RATES (from 6 April 2026) ────────────────────────────────────
  ('2026/27', 'UK', 'dividend_allowance',          500,    'Dividend allowance — occupies band space', '2026-04-06', 'GOV.UK Finance Act 2026 s.8'),
  ('2026/27', 'UK', 'dividend_basic_rate',         0.1075, 'Dividend basic rate — +2pp from April 2026', '2026-04-06', 'GOV.UK Finance Act 2026 s.8 / Budget 2025 OOTLAR'),
  ('2026/27', 'UK', 'dividend_higher_rate',        0.3575, 'Dividend higher rate — +2pp from April 2026', '2026-04-06', 'GOV.UK Finance Act 2026 s.8 / Budget 2025 OOTLAR'),
  ('2026/27', 'UK', 'dividend_additional_rate',    0.3935, 'Dividend additional rate — UNCHANGED at 39.35%', '2026-04-06', 'GOV.UK Finance Act 2026 s.8 / Budget 2025 OOTLAR'),

-- ── NATIONAL INSURANCE ────────────────────────────────────────────────────────
  ('2026/27', 'UK', 'class2_spt',                  7105,   'Class 2 Small Profits Threshold', '2026-04-06', 'GOV.UK / HMRC'),
  ('2026/27', 'UK', 'class2_weekly_rate',           3.65,   'Class 2 NI weekly rate (voluntary, auto-credited above SPT)', '2026-04-06', 'GOV.UK / HMRC'),
  ('2026/27', 'UK', 'class4_lpl',                  12570,  'Class 4 Lower Profits Limit (= Personal Allowance)', '2026-04-06', 'GOV.UK / HMRC'),
  ('2026/27', 'UK', 'class4_upl',                  50270,  'Class 4 Upper Profits Limit', '2026-04-06', 'GOV.UK / HMRC'),
  ('2026/27', 'UK', 'class4_main_rate',             0.06,   'Class 4 NI main rate (6%)', '2026-04-06', 'GOV.UK / HMRC'),
  ('2026/27', 'UK', 'class4_upper_rate',            0.02,   'Class 4 NI upper rate (2%)', '2026-04-06', 'GOV.UK / HMRC'),

-- ── VAT ───────────────────────────────────────────────────────────────────────
  ('2026/27', 'UK', 'vat_threshold',               90000,  'VAT registration threshold', '2026-04-06', 'GOV.UK / HMRC'),
  ('2026/27', 'UK', 'vat_standard_rate',           0.20,   'VAT standard rate', '2026-04-06', 'GOV.UK / HMRC'),
  ('2026/27', 'UK', 'vat_flat_rate_avg',           0.115,  'VAT flat rate scheme average (varies by sector)', '2026-04-06', 'GOV.UK / HMRC'),

-- ── MTD ───────────────────────────────────────────────────────────────────────
  ('2026/27', 'UK', 'mtd_threshold_2026',          50000,  'MTD mandatory threshold from April 2026 (gross income)', '2026-04-06', 'GOV.UK / HMRC MTD guidance'),
  ('2026/27', 'UK', 'mtd_threshold_2027',          30000,  'MTD threshold from April 2027', '2027-04-06', 'GOV.UK / HMRC MTD guidance'),
  ('2026/27', 'UK', 'mtd_threshold_2028',          20000,  'MTD threshold from April 2028', '2028-04-06', 'GOV.UK / HMRC MTD guidance'),

-- ── RENTAL INCOME / SECTION 24 ────────────────────────────────────────────────
  ('2026/27', 'UK', 'section24_credit_rate',       0.20,   'Section 24 mortgage interest credit rate (20% for 2026/27)', '2026-04-06', 'GOV.UK / LITRG / Finance Act 2026'),
  ('2026/27', 'UK', 'property_allowance',          1000,   'Property allowance — gross <= £1,000 fully exempt', '2026-04-06', 'GOV.UK / LITRG'),
  ('2026/27', 'UK', 'rent_a_room_limit',           7500,   'Rent-a-room relief annual limit', '2026-04-06', 'GOV.UK / LITRG'),
  ('2026/27', 'UK', 'rent_a_room_joint',           3750,   'Rent-a-room joint ownership limit', '2026-04-06', 'GOV.UK / LITRG'),
  -- Finance Act 2026: new property income rates from April 2027
  ('2027/28', 'UK', 'property_basic_rate',         0.22,   'New property income basic rate from April 2027', '2027-04-06', 'Finance Act 2026 ss.6-7 / House of Commons Library CBP-10450'),
  ('2027/28', 'UK', 'property_higher_rate',        0.42,   'New property income higher rate from April 2027', '2027-04-06', 'Finance Act 2026 ss.6-7 / House of Commons Library CBP-10450'),
  ('2027/28', 'UK', 'property_additional_rate',    0.47,   'New property income additional rate from April 2027', '2027-04-06', 'Finance Act 2026 ss.6-7 / House of Commons Library CBP-10450'),
  ('2027/28', 'UK', 'section24_credit_rate',       0.22,   'Section 24 credit rate rises to 22% from April 2027', '2027-04-06', 'Finance Act 2026 ss.6-7 / Sterling & Wells April 2026');

-- ── SCOTTISH INCOME TAX RATES 2026/27 ────────────────────────────────────────
-- Scottish rates apply ONLY to non-savings, non-dividend income
-- Source: gov.scot official table (14 Jan 2026), ICAEW Tax News Jan 2026, Deloitte Tax Tables 2026/27
INSERT INTO tax_rates (tax_year, jurisdiction, parameter_key, parameter_value, description, effective_from, source)
VALUES
  ('2026/27', 'SCO', 'personal_allowance',         12570,  'Personal Allowance — same as UK', '2026-04-06', 'gov.scot / GOV.UK'),
  ('2026/27', 'SCO', 'starter_rate',               0.19,   'Scottish starter rate', '2026-04-06', 'gov.scot official table 14 Jan 2026'),
  ('2026/27', 'SCO', 'starter_band_top',           16537,  'Scottish starter band upper limit (income, not taxable)', '2026-04-06', 'gov.scot official table 14 Jan 2026'),
  ('2026/27', 'SCO', 'basic_rate',                 0.20,   'Scottish basic rate', '2026-04-06', 'gov.scot official table 14 Jan 2026'),
  ('2026/27', 'SCO', 'basic_band_top',             43662,  'Scottish basic band upper limit (income)', '2026-04-06', 'gov.scot official table 14 Jan 2026'),
  ('2026/27', 'SCO', 'intermediate_rate',          0.21,   'Scottish intermediate rate', '2026-04-06', 'gov.scot official table 14 Jan 2026'),
  ('2026/27', 'SCO', 'intermediate_band_top',      75000,  'Scottish intermediate band upper limit (income)', '2026-04-06', 'gov.scot official table 14 Jan 2026'),
  ('2026/27', 'SCO', 'higher_rate',                0.42,   'Scottish higher rate', '2026-04-06', 'gov.scot official table 14 Jan 2026'),
  ('2026/27', 'SCO', 'higher_band_top',            125140, 'Scottish higher band upper limit — aligns with UK additional rate threshold', '2026-04-06', 'gov.scot / GOV.UK'),
  ('2026/27', 'SCO', 'advanced_rate',              0.45,   'Scottish advanced rate', '2026-04-06', 'gov.scot official table 14 Jan 2026'),
  ('2026/27', 'SCO', 'advanced_band_top',          150000, 'Scottish advanced band upper limit', '2026-04-06', 'gov.scot official table 14 Jan 2026'),
  ('2026/27', 'SCO', 'top_rate',                   0.48,   'Scottish top rate (above £150,000)', '2026-04-06', 'gov.scot official table 14 Jan 2026'),
  -- Section 24 credit rate for Scottish landlords = 20% (Scottish basic rate = 20% in 2026/27)
  ('2026/27', 'SCO', 'section24_credit_rate',      0.20,   'Section 24 credit rate for Scottish landlords (= Scottish basic rate 2026/27)', '2026-04-06', 'GOV.UK / LITRG (LITRG confirmed: same rules, 20% credit)');
