'use strict';

/**
 * FlexFlow — TrueLayer Integration Routes
 * Session C — Task 4
 *
 * GET  /truelayer/connect          — generate TrueLayer OAuth URL
 * GET  /truelayer/callback         — handle OAuth callback, store tokens
 * POST /truelayer/sync             — manually trigger transaction sync
 * POST /truelayer/webhook          — TrueLayer webhook (new transactions)
 * GET  /truelayer/accounts         — list connected accounts
 * POST /truelayer/designate-tax    — set a bank account as the tax account
 *
 * TrueLayer Client ID: sandbox-flexflow-04aa28 (already registered)
 * Sandbox mode: TRUELAYER_SANDBOX=true in .env
 */

const express  = require('express');
const router   = express.Router();
const axios    = require('axios');
const { verifyToken, checkOnboardingComplete } = require('../middleware/auth');
const { query, withTransaction } = require('../config/database');
const { classifyTransaction } = require('../engines/tce');

// TrueLayer API base URLs
const TL_AUTH_URL = process.env.TRUELAYER_SANDBOX === 'true'
  ? 'https://auth.truelayer-sandbox.com'
  : 'https://auth.truelayer.com';

const TL_API_URL = process.env.TRUELAYER_SANDBOX === 'true'
  ? 'https://api.truelayer-sandbox.com'
  : 'https://api.truelayer.com';

// ── GET /truelayer/connect ────────────────────────────────────────────────────
// Generate TrueLayer OAuth authorisation URL
// Mobile app opens this URL in a browser for bank selection


// ── Plan bank account limit middleware ──────────────────────────────────────
async function checkBankAccountLimit(req, res, next) {
  try {
    const userId = req.user?.id;
    if (!userId) return next();

    const limitResult = await query(
      `SELECT pc.max_bank_accounts,
              COUNT(tla.id) AS current_count
       FROM users u
       JOIN plan_config pc ON pc.plan = COALESCE(u.plan, 'free')
       LEFT JOIN truelayer_accounts tla ON tla.user_id = u.id AND tla.is_active = true
       WHERE u.id = $1
       GROUP BY pc.max_bank_accounts`,
      [userId]
    );

    if (limitResult.rows.length > 0) {
      const { max_bank_accounts, current_count } = limitResult.rows[0];
      if (max_bank_accounts !== -1 && parseInt(current_count) >= parseInt(max_bank_accounts)) {
        return res.status(403).json({
          error: 'Bank account limit reached for your plan',
          max_bank_accounts: parseInt(max_bank_accounts),
          current_count: parseInt(current_count),
          upgrade_required: true,
        });
      }
    }
    next();
  } catch (err) {
    console.error('Plan limit check error:', err);
    next(); // Non-fatal — proceed if check fails
  }
}

router.get('/connect', verifyToken, checkOnboardingComplete, checkBankAccountLimit, async (req, res) => {
  const params = new URLSearchParams({
    response_type: 'code',
    client_id:     process.env.TRUELAYER_CLIENT_ID,
    scope:         'info accounts balance cards transactions direct_debits standing_orders offline_access',
    redirect_uri:  process.env.TRUELAYER_REDIRECT_URI,
    providers:     'uk-ob-all uk-oauth-all',
    state:         req.user.userId, // Pass userId through OAuth flow
  });

  const authUrl = `${TL_AUTH_URL}/?${params.toString()}`;
  return res.json({ auth_url: authUrl });
});

// ── GET /truelayer/callback ───────────────────────────────────────────────────
// TrueLayer redirects here after user authorises bank connection
// Exchange code for tokens, fetch accounts, store everything

router.get('/callback', async (req, res) => {
  try {
    const { code, state: userId, error } = req.query;

    if (error) {
      return res.redirect(`flexflow://bank-connect?error=${encodeURIComponent(error)}`);
    }

    if (!code || !userId) {
      return res.status(400).json({ error: 'Missing code or state.' });
    }

    // Exchange authorisation code for access + refresh tokens
    const tokenResponse = await axios.post(`${TL_AUTH_URL}/connect/token`, {
      grant_type:    'authorization_code',
      client_id:     process.env.TRUELAYER_CLIENT_ID,
      client_secret: process.env.TRUELAYER_CLIENT_SECRET,
      redirect_uri:  process.env.TRUELAYER_REDIRECT_URI,
      code,
    }, { headers: { 'Content-Type': 'application/json' } });

    const { access_token, refresh_token, expires_in } = tokenResponse.data;
    const tokenExpiresAt = new Date(Date.now() + expires_in * 1000);

    // Fetch accounts from TrueLayer
    const accountsResponse = await axios.get(`${TL_API_URL}/data/v1/accounts`, {
      headers: { Authorization: `Bearer ${access_token}` },
    });

    const accounts = accountsResponse.data.results || [];

    // Store each account as a bank_connection
    await withTransaction(async (client) => {
      for (const account of accounts) {
        await client.query(`
          INSERT INTO bank_connections
            (user_id, provider, provider_id, account_id, account_type,
             account_name, currency, access_token, refresh_token, token_expires_at)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
          ON CONFLICT (user_id, account_id) DO UPDATE SET
            access_token = EXCLUDED.access_token,
            refresh_token = EXCLUDED.refresh_token,
            token_expires_at = EXCLUDED.token_expires_at,
            updated_at = NOW()
        `, [
          userId,
          account.provider?.provider_id || 'unknown',
          account.provider?.provider_id || 'unknown',
          account.account_id,
          account.account_type?.toLowerCase() || 'current',
          account.display_name || account.account_type,
          account.currency || 'GBP',
          access_token,
          refresh_token,
          tokenExpiresAt,
        ]);
      }
    });

    // Kick off initial transaction sync (async — don't wait)
    syncTransactionsForUser(userId, access_token).catch(err =>
      console.error('Initial sync error:', err.message)
    );

    // Redirect to app
    return res.redirect(`flexflow://bank-connect?success=true&accounts=${accounts.length}`);

  } catch (err) {
    console.error('TrueLayer callback error:', err.message);
    return res.redirect(`flexflow://bank-connect?error=connection_failed`);
  }
});

// ── POST /truelayer/sync ──────────────────────────────────────────────────────
// Manual trigger for transaction sync (for testing and catch-up)

router.post('/sync', verifyToken, checkOnboardingComplete, async (req, res) => {
  try {
    const connections = await query(
      `SELECT id, access_token, account_id FROM bank_connections
       WHERE user_id = $1 AND is_active = true`,
      [req.user.userId]
    );

    if (connections.rows.length === 0) {
      return res.status(404).json({ error: 'No connected bank accounts found.' });
    }

    let totalImported = 0;

    for (const conn of connections.rows) {
      const count = await syncAccountTransactions(
        req.user.userId, conn.account_id, conn.access_token
      );
      totalImported += count;
    }

    return res.json({
      message: `Sync complete. ${totalImported} new transactions imported.`,
      count: totalImported,
    });

  } catch (err) {
    console.error('Sync error:', err.message);
    return res.status(500).json({ error: 'Sync failed.' });
  }
});

// ── POST /truelayer/webhook ───────────────────────────────────────────────────
// TrueLayer sends webhooks when new transactions arrive
// In production: verify webhook signature before processing

router.post('/webhook', async (req, res) => {
  try {
    const { type, results } = req.body;

    // Acknowledge receipt immediately — TrueLayer expects fast response
    res.status(200).json({ received: true });

    if (type !== 'transaction') return;

    // Process each webhook payload asynchronously
    for (const item of (results || [])) {
      if (item.account_id && item.user_id) {
        const conn = await query(
          `SELECT access_token FROM bank_connections
           WHERE user_id = $1 AND account_id = $2 AND is_active = true`,
          [item.user_id, item.account_id]
        );
        if (conn.rows.length > 0) {
          syncAccountTransactions(item.user_id, item.account_id, conn.rows[0].access_token)
            .catch(err => console.error('Webhook sync error:', err.message));
        }
      }
    }

  } catch (err) {
    console.error('Webhook error:', err.message);
  }
});

// ── GET /truelayer/accounts ───────────────────────────────────────────────────

router.get('/accounts', verifyToken, checkOnboardingComplete, async (req, res) => {
  try {
    const result = await query(
      `SELECT id, provider, account_name, account_type, currency,
              is_tax_account, tax_pot_balance, is_active, last_synced_at, sync_status
       FROM bank_connections WHERE user_id = $1 ORDER BY created_at ASC`,
      [req.user.userId]
    );
    return res.json({ accounts: result.rows });
  } catch (err) {
    console.error('Accounts error:', err.message);
    return res.status(500).json({ error: 'Failed to fetch accounts.' });
  }
});

// ── POST /truelayer/designate-tax ─────────────────────────────────────────────
// Designate one bank account as the tax pot account

router.post('/designate-tax', verifyToken, checkOnboardingComplete, async (req, res) => {
  try {
    const { account_id } = req.body;

    if (!account_id) {
      return res.status(400).json({ error: 'account_id required.' });
    }

    await withTransaction(async (client) => {
      // Clear existing tax designation
      await client.query(
        `UPDATE bank_connections SET is_tax_account = false
         WHERE user_id = $1`,
        [req.user.userId]
      );
      // Set new tax account
      await client.query(
        `UPDATE bank_connections SET is_tax_account = true, updated_at = NOW()
         WHERE user_id = $1 AND id = $2`,
        [req.user.userId, account_id]
      );
    });

    return res.json({ message: 'Tax account designated.' });
  } catch (err) {
    console.error('Designate tax error:', err.message);
    return res.status(500).json({ error: 'Failed to designate tax account.' });
  }
});

// ══════════════════════════════════════════════════════════════════════════════
// CORE SYNC FUNCTIONS
// ══════════════════════════════════════════════════════════════════════════════

async function syncTransactionsForUser(userId, accessToken) {
  const connections = await query(
    `SELECT id, account_id FROM bank_connections
     WHERE user_id = $1 AND is_active = true`,
    [userId]
  );
  for (const conn of connections.rows) {
    await syncAccountTransactions(userId, conn.account_id, accessToken);
  }
}

async function syncAccountTransactions(userId, accountId, accessToken) {
  let imported = 0;

  try {
    // Fetch transactions from TrueLayer (last 12 months)
    const from = new Date();
    from.setFullYear(from.getFullYear() - 1);

    const response = await axios.get(
      `${TL_API_URL}/data/v1/accounts/${accountId}/transactions`, {
        headers: { Authorization: `Bearer ${accessToken}` },
        params: {
          from: from.toISOString().split('T')[0],
          to:   new Date().toISOString().split('T')[0],
        },
      }
    );

    const transactions = response.data.results || [];

    // Get user profile for classification
    const userResult = await query(
      `SELECT income_structure, is_cis_worker, is_ltd_director,
              is_scottish_taxpayer, receives_rental_income, receives_pension,
              employer_name, company_name
       FROM users WHERE id = $1`,
      [userId]
    );
    const user = userResult.rows[0];

    // Get bank_connection id
    const connResult = await query(
      `SELECT id FROM bank_connections WHERE user_id = $1 AND account_id = $2`,
      [userId, accountId]
    );
    const bankConnectionId = connResult.rows[0]?.id;

    for (const txn of transactions) {
      // Normalise TrueLayer transaction
      const normalised = {
        truelayer_id:     txn.transaction_id,
        amount:           txn.amount,
        description:      txn.description || '',
        merchant_name:    txn.merchant_name || '',
        transaction_type: txn.transaction_type === 'CREDIT' ? 'CREDIT' : 'DEBIT',
        transaction_date: txn.timestamp?.split('T')[0] || txn.date,
      };

      // Check if already imported (dedup by truelayer_id)
      const existing = await query(
        `SELECT id FROM transactions WHERE truelayer_id = $1`,
        [normalised.truelayer_id]
      );
      if (existing.rows.length > 0) continue;

      // Run TCE classification
      const classification = await classifyTransaction(normalised, user);

      // Store transaction
      const txnResult = await query(`
        INSERT INTO transactions
          (user_id, bank_connection_id, truelayer_id, amount, description,
           merchant_name, transaction_date, transaction_type,
           category, sub_category, is_classified, is_income, is_cis)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,true,$11,$12)
        RETURNING id
      `, [
        userId, bankConnectionId, normalised.truelayer_id,
        normalised.amount, normalised.description, normalised.merchant_name,
        normalised.transaction_date, normalised.transaction_type,
        classification.category, classification.sub_category,
        classification.is_income || false,
        classification.is_cis || false,
      ]);

      const txnId = txnResult.rows[0].id;

      // If income — store in income_events with dual amount columns
      if (classification.is_income) {
        const taxYear = getTaxYear(new Date(normalised.transaction_date));

        await query(`
          INSERT INTO income_events
            (user_id, transaction_id, amount, gross_amount, income_date,
             income_type, tax_year, is_cis, cis_deduction_rate,
             tax_deducted, is_rental)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
          ON CONFLICT DO NOTHING
        `, [
          userId, txnId,
          classification.amount_net   || Math.abs(normalised.amount),
          classification.gross_amount || Math.abs(normalised.amount),
          normalised.transaction_date,
          classification.income_type  || 'se',
          taxYear,
          classification.is_cis       || false,
          classification.cis_deduction_rate || null,
          classification.tax_deducted || 0,
          classification.is_rental    || false,
        ]);
      }

      imported++;
    }

    // Update sync status
    await query(
      `UPDATE bank_connections
       SET last_synced_at = NOW(), sync_status = 'ok', updated_at = NOW()
       WHERE user_id = $1 AND account_id = $2`,
      [userId, accountId]
    );

  } catch (err) {
    console.error(`Sync error for account ${accountId}:`, err.message);
    await query(
      `UPDATE bank_connections
       SET sync_status = 'error', sync_error = $1, updated_at = NOW()
       WHERE user_id = $2 AND account_id = $3`,
      [err.message, userId, accountId]
    );
  }

  return imported;
}

// ── Tax year helper (Build Note 9) ───────────────────────────────────────────
// Tax year: 6 April to 5 April
// April 6 is the FIRST day of the new year
// Bug: must use (month > 4) OR (month === 4 AND day >= 6)
// NOT month >= 4 (which would wrongly include 1-5 April in new year)

function getTaxYear(date) {
  const month = date.getMonth() + 1; // 1-12
  const day   = date.getDate();
  const year  = date.getFullYear();

  const isNewYear = (month > 4) || (month === 4 && day >= 6);
  const startYear = isNewYear ? year : year - 1;
  return `${startYear}/${String(startYear + 1).slice(-2)}`;
}


// ── GET /accounts/count — returns current connections vs plan limit ──────────
router.get('/accounts/count', verifyToken, async (req, res) => {
  try {
    const userId = req.user.id;
    const result = await query(
      `SELECT pc.max_bank_accounts, pc.display_name AS plan_name,
              COUNT(tla.id) AS current_count
       FROM users u
       JOIN plan_config pc ON pc.plan = COALESCE(u.plan, 'free')
       LEFT JOIN truelayer_accounts tla ON tla.user_id = u.id AND tla.is_active = true
       WHERE u.id = $1
       GROUP BY pc.max_bank_accounts, pc.display_name`,
      [userId]
    );

    const row = result.rows[0] || { max_bank_accounts: 1, current_count: 0, plan_name: 'Free' };
    res.json({
      current_count:     parseInt(row.current_count),
      max_bank_accounts: parseInt(row.max_bank_accounts),
      unlimited:         row.max_bank_accounts === -1,
      plan_name:         row.plan_name,
      can_add_more:      row.max_bank_accounts === -1 || parseInt(row.current_count) < parseInt(row.max_bank_accounts),
    });
  } catch (err) {
    console.error('Account count error:', err);
    res.status(500).json({ error: 'Failed to get account count' });
  }
});

module.exports = router;
