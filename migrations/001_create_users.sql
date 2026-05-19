-- Migration 001: users
-- Foundation table. All other tables reference this.
-- FlexFlow Phase 3 — Session A

CREATE TABLE IF NOT EXISTS users (
  id                        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email                     VARCHAR(255) UNIQUE NOT NULL,
  password_hash             VARCHAR(255) NOT NULL,

  -- Profile
  full_name                 VARCHAR(255),
  date_of_birth             DATE,                          -- Required for SPA calculation (Build Note 5)
  address_line_1            VARCHAR(255),
  address_line_2            VARCHAR(255),
  city                      VARCHAR(100),
  postcode                  VARCHAR(20),

  -- Tax identity flags — set at onboarding
  income_structure          VARCHAR(20),                   -- 'S1' sole trader | 'S2' ltd | 'S3a/b/c/d' mixed | 'S10' rental only
  is_scottish_taxpayer      BOOLEAN DEFAULT false,         -- Postcode-detected at onboarding
  receives_paye             BOOLEAN DEFAULT false,
  receives_se               BOOLEAN DEFAULT false,
  receives_rental_income    BOOLEAN DEFAULT false,
  receives_partnership      BOOLEAN DEFAULT false,
  is_ltd_director           BOOLEAN DEFAULT false,
  is_cis_worker             BOOLEAN DEFAULT false,
  is_vat_registered         BOOLEAN DEFAULT false,
  vat_number                VARCHAR(20),
  utr_number                VARCHAR(20),                   -- Unique Taxpayer Reference
  mtd_required              BOOLEAN DEFAULT false,         -- Set true when gross income > £50k (Build Note 7)

  -- Subscription
  plan                      VARCHAR(20) DEFAULT 'free',    -- 'free' | 'plus' | 'pro'
  stripe_customer_id        VARCHAR(255),
  subscription_status       VARCHAR(20) DEFAULT 'inactive',

  -- Onboarding gate (Build Note — all dashboard routes return 403 until true)
  onboarding_complete       BOOLEAN DEFAULT false,
  onboarding_step           INTEGER DEFAULT 0,

  -- State
  refresh_token_hash        VARCHAR(255),
  last_login_at             TIMESTAMPTZ,
  created_at                TIMESTAMPTZ DEFAULT NOW(),
  updated_at                TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_users_email ON users(email);
CREATE INDEX idx_users_postcode ON users(postcode);
