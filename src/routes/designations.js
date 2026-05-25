// ════════════════════════════════════════════════════════════════════════════
// /designations — Account Designation API
//
// v2 — fixed auth middleware import to match project convention
//      (was: requireAuth, now: verifyToken from ../middleware/auth)
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
const { verifyToken } = require('../middleware/auth');

const VALID_TYPES = ['spending', 'tax', 'pension', 'future_earnings'];

// ─── GET /designations ──────────────────────────────────────────────────────
// Returns the current user's designations grouped by type.
router.get('/', verifyToken, async (req, res) => {
  try {
    const { rows } = await db.query(
      `SELECT bank_account_id, account_label, account_provider, designation_type,
              created_at, updated_at
       FROM account_designations
       WHERE user_id = $1
       ORDER BY designation_type, account_label`,
      [req.user.id]
    );

    // Group by designation_type for easier consumption by the frontend.
    const grouped = { spending: [], tax: [], pension: [], future_earnings: [] };
    for (const row of rows) {
      grouped[row.designation_type].push({
        bankAccountId: row.bank_account_id,
        accountLabel:  row.account_label,
        provider:      row.account_provider,
        createdAt:     row.created_at,
        updatedAt:     row.updated_at,
      });
    }

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
router.post('/', verifyToken, async (req, res) => {
  const { designations } = req.body;
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

  // At least one account must have 'spending' designation
  const hasSpending = designations.some(d => d.types.includes('spending'));
  if (!hasSpending) {
    return res.status(400).json({
      error: 'At least one account must be designated as spending',
    });
  }

  // Use the pool-shared client pattern from other routes if available,
  // else fall back to db.query directly.
  const client = (db.getClient && typeof db.getClient === 'function')
    ? await db.getClient()
    : null;

  try {
    if (client) await client.query('BEGIN');

    // Clear existing designations for this user
    const delQuery = 'DELETE FROM account_designations WHERE user_id = $1';
    if (client) await client.query(delQuery, [req.user.id]);
    else await db.query(delQuery, [req.user.id]);

    // Insert new rows (one per account+type combo)
    for (const d of designations) {
      for (const type of d.types) {
        const insQuery = `INSERT INTO account_designations
             (user_id, bank_account_id, account_label, account_provider, designation_type)
           VALUES ($1, $2, $3, $4, $5)`;
        const insParams = [
          req.user.id, d.bankAccountId, d.accountLabel || null,
          d.provider || null, type
        ];
        if (client) await client.query(insQuery, insParams);
        else await db.query(insQuery, insParams);
      }
    }

    if (client) await client.query('COMMIT');
    res.json({ success: true, count: designations.length });
  } catch (err) {
    if (client) await client.query('ROLLBACK');
    console.error('POST /designations failed:', err);
    res.status(500).json({ error: 'Could not save designations' });
  } finally {
    if (client) client.release();
  }
});

// ─── GET /designations/balance/:type ────────────────────────────────────────
// Returns the resolved balance for a given designation type.
// STUB until TrueLayer balance polling is wired.
router.get('/balance/:type', verifyToken, async (req, res) => {
  const { type } = req.params;
  if (!VALID_TYPES.includes(type)) {
    return res.status(400).json({ error: 'Invalid designation type' });
  }

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
