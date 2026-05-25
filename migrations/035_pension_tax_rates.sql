-- ════════════════════════════════════════════════════════════════════════════
-- Migration 035 — Pension Rate Parameters (2026/27)
-- ════════════════════════════════════════════════════════════════════════════
-- Adds pension-specific rate parameters to the tax_rates table so the
-- Pension Engine can load them via loadPensionRates() matching the existing
-- pattern in tax.js. Zero hardcoded values policy.
--
-- Sources triangulated May 2026:
--   - gov.uk Pensions Tax Manual + tax-on-your-private-pension/annual-allowance
--   - MoneyHelper: annual-allowance + tapered-annual-allowance
--   - LITRG, AJ Bell, Royal London, Aegon adviser guidance
--   - HMRC BIM46030/BIM46035 (Ltd director employer contributions)
-- ════════════════════════════════════════════════════════════════════════════

BEGIN;

INSERT INTO tax_rates (tax_year, jurisdiction, parameter_key, parameter_value, description, effective_from, source)
VALUES
  ('2026/27', 'UK', 'pension_annual_allowance',          60000.0000, 'Standard annual allowance for tax relief on pension contributions',                                  '2026-04-06', 'gov.uk/tax-on-your-private-pension/annual-allowance'),
  ('2026/27', 'UK', 'pension_annual_allowance_minimum',  10000.0000, 'Floor of tapered annual allowance (reached when adjusted income hits £360,000)',                    '2026-04-06', 'MoneyHelper tapered-annual-allowance'),
  ('2026/27', 'UK', 'pension_taper_threshold_income',   200000.0000, 'Threshold income above which the tapered annual allowance MAY apply (both thresholds must be met)', '2026-04-06', 'HMRC Pensions Tax Manual + LITRG'),
  ('2026/27', 'UK', 'pension_taper_adjusted_income',    260000.0000, 'Adjusted income above which the tapered annual allowance actively reduces',                         '2026-04-06', 'HMRC Pensions Tax Manual + LITRG'),
  ('2026/27', 'UK', 'pension_mpaa',                      10000.0000, 'Money Purchase Annual Allowance — triggered by flexible DC pension access',                         '2026-04-06', 'gov.uk MPAA guidance'),
  ('2026/27', 'UK', 'pension_basic_amount',               3600.0000, 'Tax-relievable contribution floor for users with low or no relevant UK earnings',                   '2026-04-06', 'Aegon adviser guidance / HMRC PTM044100'),
  ('2026/27', 'UK', 'pension_ras_basic_relief',              0.2000, 'Basic rate relief at source — provider claims this from HMRC (e.g. £80 net = £100 gross)',          '2026-04-06', 'gov.uk relief at source')
ON CONFLICT (tax_year, jurisdiction, parameter_key) DO UPDATE
  SET parameter_value = EXCLUDED.parameter_value,
      description     = EXCLUDED.description,
      effective_from  = EXCLUDED.effective_from,
      source          = EXCLUDED.source,
      updated_at      = NOW();

DO $$
DECLARE v_count INTEGER;
BEGIN
  SELECT COUNT(*) INTO v_count
  FROM tax_rates
  WHERE tax_year = '2026/27' AND jurisdiction = 'UK' AND parameter_key LIKE 'pension_%';
  IF v_count < 7 THEN
    RAISE EXCEPTION 'Migration 035 failed: expected 7 pension rate rows, found %', v_count;
  END IF;
  RAISE NOTICE 'Migration 035 verified: % pension rate rows present for 2026/27', v_count;
END$$;

COMMIT;
