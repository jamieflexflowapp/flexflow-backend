-- Migration 006: tax_calculations
-- Tax liability records per user per tax year
-- All values calculated by Tax Engine v3.5 — zero hardcoded rates in code

CREATE TABLE IF NOT EXISTS tax_calculations (
  id                        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id                   UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  tax_year                  VARCHAR(9) NOT NULL,            -- '2026/27'

  -- Income inputs
  gross_se_income           DECIMAL(12,2) DEFAULT 0.00,     -- Gross SE/trading income
  gross_paye_income         DECIMAL(12,2) DEFAULT 0.00,
  gross_dividend_income     DECIMAL(12,2) DEFAULT 0.00,
  gross_rental_income       DECIMAL(12,2) DEFAULT 0.00,
  gross_partnership_income  DECIMAL(12,2) DEFAULT 0.00,

  -- Allowances applied
  personal_allowance        DECIMAL(12,2) DEFAULT 12570.00, -- From tax_rates table
  pa_tapered                BOOLEAN DEFAULT false,
  effective_pa              DECIMAL(12,2),                  -- After taper

  -- Income Tax
  it_basic_rate             DECIMAL(12,2) DEFAULT 0.00,
  it_higher_rate            DECIMAL(12,2) DEFAULT 0.00,
  it_additional_rate        DECIMAL(12,2) DEFAULT 0.00,
  it_dividend_basic         DECIMAL(12,2) DEFAULT 0.00,
  it_dividend_higher        DECIMAL(12,2) DEFAULT 0.00,
  it_dividend_additional    DECIMAL(12,2) DEFAULT 0.00,
  it_total                  DECIMAL(12,2) DEFAULT 0.00,

  -- National Insurance
  ni_class2                 DECIMAL(12,2) DEFAULT 0.00,
  ni_class4_main            DECIMAL(12,2) DEFAULT 0.00,
  ni_class4_upper           DECIMAL(12,2) DEFAULT 0.00,
  ni_total                  DECIMAL(12,2) DEFAULT 0.00,

  -- Rental income specific (Tax Engine v3.5 Part 1d)
  rental_profit             DECIMAL(12,2) DEFAULT 0.00,
  rental_finance_costs      DECIMAL(12,2) DEFAULT 0.00,
  section24_credit          DECIMAL(12,2) DEFAULT 0.00,     -- 20% × min(finCosts,profit,incomeAbovePA)
  rental_loss_applied       DECIMAL(12,2) DEFAULT 0.00,
  rental_loss_carried_fwd   DECIMAL(12,2) DEFAULT 0.00,
  fin_costs_carried_fwd     DECIMAL(12,2) DEFAULT 0.00,     -- SA105 Box 45

  -- Scottish income tax (replaces UK bands for non-savings income)
  is_scottish               BOOLEAN DEFAULT false,
  it_scottish_starter       DECIMAL(12,2) DEFAULT 0.00,
  it_scottish_basic         DECIMAL(12,2) DEFAULT 0.00,
  it_scottish_intermediate  DECIMAL(12,2) DEFAULT 0.00,
  it_scottish_higher        DECIMAL(12,2) DEFAULT 0.00,
  it_scottish_advanced      DECIMAL(12,2) DEFAULT 0.00,
  it_scottish_top           DECIMAL(12,2) DEFAULT 0.00,

  -- VAT
  is_vat_registered         BOOLEAN DEFAULT false,
  vat_owed                  DECIMAL(12,2) DEFAULT 0.00,
  vat_quarter_end           DATE,
  vat_deadline              DATE,                           -- VAT deadline: 1 month + 7 days (Build Note 10)

  -- Total liability
  total_tax_liability       DECIMAL(12,2) DEFAULT 0.00,     -- IT + NI (no VAT — separate)
  tax_pot_target            DECIMAL(12,2) DEFAULT 0.00,     -- Target balance in tax account
  monthly_tax_pot_contrib   DECIMAL(12,2) DEFAULT 0.00,     -- Monthly set-aside

  -- MTD flag
  mtd_required              BOOLEAN DEFAULT false,

  -- Self Assessment
  sa_deadline               DATE,                           -- 31 Jan following tax year end
  payments_on_account       DECIMAL(12,2) DEFAULT 0.00,

  -- Status
  calculation_basis         VARCHAR(20) DEFAULT 'projected', -- 'projected'|'confirmed'|'filed'
  calculated_at             TIMESTAMPTZ DEFAULT NOW(),
  created_at                TIMESTAMPTZ DEFAULT NOW(),
  updated_at                TIMESTAMPTZ DEFAULT NOW(),

  UNIQUE(user_id, tax_year)
);

CREATE INDEX idx_tax_calculations_user_year ON tax_calculations(user_id, tax_year);
