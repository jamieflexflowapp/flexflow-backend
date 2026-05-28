// ════════════════════════════════════════════════════════════════════════════
// /designations — Account Designation API
//
// Endpoints:
//   GET    /designations                  → list current designations for user
//   POST   /designations                  → bulk replace designations for user
//   GET    /designations/balance/:type    → resolved balance for a designation
//                                            (e.g. 'spending' returns the sum
//                                            of all accounts tagged spending,
//                                            minus ring-fenced amounts)
//
// Designation types: 'spending' | 'tax' | 'pension' | 'future_earnings'
//
// Priority (when one pot holds multiple jobs):
//   Tax > Pension > Future Earnings > Spending (whatever's left)
// ════════════════════════════════════════════════════════════════════════════
const express = require('express');
const router = express.Router();
const db = require('../config/database');
const { verifyToken: requireAuth } = require('../middleware/auth');

const VALID_TYPES = ['spending', 'tax', 'pension', 'future_earnings', 'bills'];

// ─── GET /designations ──────────────────────────────────────────────────────
// Returns the current user's designations grouped by type.
router.get('/', requireAuth, async (req, res) => {
  try {
    const { rows } = await db.query(
      `SELECT bank_account_id, account_label, account_provider, designation_type,
              created_at, updated_at
       FROM account_designations
       WHERE user_id = $1
       ORDER BY designation_type, account_label`,
      [req.user.userId || req.user.id]
    );

    // Group by designation_type for easier consumption by the frontend.
    const grouped = { spending: [], tax: [], pension: [], future_earnings: [], bills: [] };
    for (const row of rows) {
      grouped[row.designation_type].push({
        bankAccountId: row.bank_account_id,
        accountLabel:  row.account_label,
        provider:      row.account_provider,
        createdAt:     row.created_at,
        updatedAt:     row.updated_at,
      });
    }

    console.log('[DESIG GET] returning:', JSON.stringify(Object.fromEntries(Object.entries(grouped).map(([k,v])=> [k, v.length]))));
    res.json({ designations: grouped, raw: rows });
  } catch (err) {
    console.error('GET /designations failed:', err);
    res.status(500).json({ error: 'Could not load designations' });
  }
});

// ─── POST /designations ─────────────────────────────────────────────────────
// Bulk replaces the user's designations. Body shape:
// {
//   designations: [
//     { bankAccountId, accountLabel, provider, types: ['spending', 'tax'] },
//     ...
//   ]
// }
router.post('/', requireAuth, async (req, res) => {
  const { designations } = req.body;
  console.log('[DESIG POST] received:', JSON.stringify(designations?.slice(0,2)));
  if (!Array.isArray(designations)) {
    return res.status(400).json({ error: 'designations must be an array' });
  }

  // Validate each entry
  for (const d of designations) {
    if (!d.bankAccountId || !Array.isArray(d.types)) {
      return res.status(400).json({ error: 'each entry needs bankAccountId and types[]' });
    }
    for (const t of d.types) {
      if (!VALID_TYPES.includes(t)) {
        return res.status(400).json({ error: `Invalid designation type: ${t}` });
      }
    }
  }

  try {
    await db.query('BEGIN');

    // Clear existing designations for this user
    await db.query(
      'DELETE FROM account_designations WHERE user_id = $1',
      [req.user.userId || req.user.id]
    );

    // Insert new rows (one per account+type combo)
    for (const d of designations) {
      for (const type of d.types) {
        await db.query(
          `INSERT INTO account_designations
             (user_id, bank_account_id, account_label, account_provider, designation_type)
           VALUES ($1, $2, $3, $4, $5)`,
          [req.user.userId || req.user.id, d.bankAccountId, d.accountLabel || null,
           d.provider || null, type]
        );
      }
    }

    await db.query('COMMIT');
    res.json({ success: true, count: designations.length });
  } catch (err) {
    await db.query('ROLLBACK');
    console.error('POST /designations failed:', err);
    res.status(500).json({ error: 'Could not save designations' });
  } finally {
  }
});

// ─── GET /designations/balance/:type ────────────────────────────────────────
// Returns the resolved balance for a given designation type.
// For 'spending', returns sum of all spending-tagged account balances MINUS
// the ring-fenced amounts (tax pot expected balance, pension pot expected, etc.)
// when those tags share the same account.
//
// NOTE: this is a stub for now — needs TrueLayer balance integration. Returns
// a sample shape so the frontend can be built against the expected response.
router.get('/balance/:type', requireAuth, async (req, res) => {
  const { type } = req.params;
  if (!VALID_TYPES.includes(type)) {
    return res.status(400).json({ error: 'Invalid designation type' });
  }

  // STUB: full integration to be wired up alongside TrueLayer balance polling.
  res.json({
    designationType: type,
    balance: 0,
    accountCount: 0,
    accounts: [],
    ringfenced: 0,
    stub: true,
    message: 'TrueLayer balance integration pending. Schema and route in place.',
  });
});

module.exports = router;
