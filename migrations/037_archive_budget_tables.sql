-- ════════════════════════════════════════════════════════════════════════════
-- Migration 037 — Archive Budget tables
--
-- FlexFlow has dropped the Budget feature (strategic decision May 2026):
-- discretionary budgeting overlaps with Monzo/Emma/YNAB and dilutes the app's
-- core wedge (irregular-earner income+tax+runway clarity).
--
-- This migration ARCHIVES the budget tables rather than dropping them, so any
-- existing data can be inspected or restored if needed. Tables are renamed
-- with an _archived_2026_05 suffix and the originals are gone from the schema.
-- ════════════════════════════════════════════════════════════════════════════

ALTER TABLE IF EXISTS budget_categories
  RENAME TO budget_categories_archived_2026_05;

ALTER TABLE IF EXISTS budget_transaction_categories
  RENAME TO budget_transaction_categories_archived_2026_05;

COMMENT ON TABLE budget_categories_archived_2026_05 IS
  'ARCHIVED 2026-05: Budget feature removed. Originally tracked user-defined budget categories. Retain for historical reference / potential future recovery.';

COMMENT ON TABLE budget_transaction_categories_archived_2026_05 IS
  'ARCHIVED 2026-05: Budget feature removed. Originally mapped transactions to budget categories. Retain for historical reference.';
