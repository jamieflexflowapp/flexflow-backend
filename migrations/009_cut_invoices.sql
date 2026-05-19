-- Migration 009: [PERMANENTLY CUT]
-- Invoice table — Feature 7 removed May 2026
-- DO NOT CREATE this table. DO NOT reference it anywhere.
-- This file exists only to preserve migration numbering sequence.
-- Income projection uses historical bank data and seasonal patterns only.
--
-- Build Note 12: Feature 7 (invoice tracking) is permanently cut across
-- all specs and all code. The 009_create_invoices migration is CUT.

-- Intentionally empty.
SELECT 1; -- no-op
