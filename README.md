# FlexFlow — Backend API

Financial planning for the self-employed. Built for the 4.2 million self-employed people in the UK who have been ignored by every existing financial app.

## Tech Stack

- **Runtime:** Node.js v24 LTS
- **Framework:** Express
- **Database:** PostgreSQL
- **Bank data:** TrueLayer (UK) / Plaid (US)
- **Payments:** Stripe
- **Reports:** AWS S3
- **Auth:** JWT (access + refresh tokens)

## Quick Start

```bash
# 1. Install dependencies and set up database
npm run setup

# 2. Copy and fill in environment variables
cp .env.example .env
# Edit .env with your values

# 3. Start development server
npm run dev
```

## Project Structure

```
backend/
├── src/
│   ├── index.js          # App entry point
│   ├── routes/           # API route handlers
│   ├── middleware/        # Auth, error handling, validation
│   ├── engines/           # Core calculation engines
│   ├── utils/             # Shared utilities
│   └── config/            # Database, env config
├── migrations/            # Versioned database migrations (001-019)
├── seeds/                 # Database seed data (tax rates, expense rules)
└── scripts/               # Admin and maintenance scripts
```

## Phase 3 Build Status

- [x] Session A — Repo + Database (Tasks 1+2)
- [ ] Session B — Authentication (Task 3)
- [ ] Session C — TrueLayer Integration (Task 4)
- [ ] Session D — Income Smoothing Engine (Task 5)
- [ ] Session E — Tax Engine: sole trader + Ltd (Task 6a)
- [ ] Session F — Tax Engine: mixed income + VAT (Task 6b)
- [ ] Session G — Config layer + Quarterly review (Tasks 6b+6c)
- [ ] Session H — Runway Calculator (Task 7)
- [ ] Session I — Cash Flow Forecasting (Task 8)
- [ ] Session J — Report Generation Engine (Task 9)

## Key Rules (from spec library)

1. **Zero hardcoded tax values** — all rates read from `tax_rates` table
2. **Tax pot excluded from available balance** — always
3. **CIS income** — `.amount` = net (display), `.gross_amount` = gross (calculations)
4. **Tax year** — 6 April to 5 April. April 6 is day 1 of new year
5. **Invoice tracking** — permanently cut (Feature 7, May 2026)
