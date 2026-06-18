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
    const userId = req.user?.userId;
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

router.get('/connect', verifyToken, checkBankAccountLimit, async (req, res) => {
  const params = new URLSearchParams({
    response_type: 'code',
    client_id:     process.env.TRUELAYER_CLIENT_ID,
    scope:         'info accounts balance cards transactions offline_access',
    redirect_uri:  process.env.TRUELAYER_REDIRECT_URI,
    providers:     process.env.TRUELAYER_SANDBOX === 'true' ? 'mock' : 'uk-ob-all uk-oauth-all',
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
    console.log('Token exchange params:', { grant_type: 'authorization_code', client_id: process.env.TRUELAYER_CLIENT_ID, redirect_uri: process.env.TRUELAYER_REDIRECT_URI, code: code?.slice(0,20) + '...' });
    const tlBasicAuth = Buffer.from(
      `${process.env.TRUELAYER_CLIENT_ID}:${process.env.TRUELAYER_CLIENT_SECRET}`
    ).toString('base64');
    const tokenResponse = await axios.post(`${TL_AUTH_URL}/connect/token`,
      new URLSearchParams({
        grant_type:   'authorization_code',
        redirect_uri: process.env.TRUELAYER_REDIRECT_URI,
        code,
      }).toString(),
      { headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Authorization': `Basic ${tlBasicAuth}`,
      }}
    );

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
             account_name, currency, access_token, refresh_token, token_expires_at,
             consent_granted_at, consent_expires_at)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, NOW(), NOW() + INTERVAL '90 days')
          ON CONFLICT (user_id, account_id) DO UPDATE SET
            access_token = EXCLUDED.access_token,
            refresh_token = EXCLUDED.refresh_token,
            token_expires_at = EXCLUDED.token_expires_at,
            consent_granted_at = NOW(),
            consent_expires_at = NOW() + INTERVAL '90 days',
            is_active = true,
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

    // Clear any consent_expiring notifications now bank is reconnected
    await query(
      `UPDATE notifications SET is_dismissed = true
       WHERE user_id = $1 AND alert_type = 'consent_expiring'`,
      [userId]
    );

    // Kick off initial transaction sync (async — don't wait)
    syncTransactionsForUser(userId, access_token, true).catch(err =>
      console.error('Initial sync error:', err.message)
    );

    // Redirect to app
    return res.redirect(`flexflow://bank-connect?success=true&accounts=${accounts.length}`);

  } catch (err) {
    console.error('TrueLayer callback error:', err.message);
    console.error('TrueLayer callback error detail:', err.response?.data);
    console.error('TrueLayer callback error status:', err.response?.status);
    return res.redirect(`flexflow://bank-connect?error=connection_failed`);
  }
});

// ── POST /truelayer/auto-sync ────────────────────────────────────────────────
// Called on app load — only syncs if last sync was >15 minutes ago
router.post('/auto-sync', verifyToken, checkOnboardingComplete, async (req, res) => {
  try {
    const userId = req.user.userId;
    const threshold = new Date(Date.now() - 15 * 60 * 1000);
    const connections = await query(
      'SELECT account_id, last_synced_at, access_token FROM bank_connections WHERE user_id = $1 AND is_active = true AND (last_synced_at IS NULL OR last_synced_at < $2) LIMIT 1',
      [userId, threshold]
    );
    if (connections.rows.length === 0) return res.json({ synced: false, reason: 'recently_synced' });
    const accessToken = connections.rows[0].access_token;
    syncTransactionsForUser(userId, accessToken, false).catch(err => console.error('[AUTO-SYNC] error:', err.message));
    res.json({ synced: true });
  } catch (err) {
    console.error('[AUTO-SYNC]', err.message);
    res.status(500).json({ error: 'Auto-sync failed' });
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

// ── DELETE /truelayer/accounts/:id — disconnect a bank account ───────────────
router.delete('/accounts/:id', verifyToken, async (req, res) => {
  try {
    const { id } = req.params;
    const result = await query(
      'UPDATE bank_connections SET is_active = false, updated_at = NOW() WHERE id = $1 AND user_id = $2 RETURNING id',
      [id, req.user.userId]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Account not found' });
    console.log('[DISCONNECT] Bank account disconnected:', id);
    res.json({ success: true });
  } catch (err) {
    console.error('[DISCONNECT]', err.message);
    res.status(500).json({ error: 'Failed to disconnect account' });
  }
});

// ── GET /truelayer/accounts ───────────────────────────────────────────────────

router.get('/accounts', verifyToken, async (req, res) => {
  try {
    const result = await query(
      `SELECT id, account_id, provider, account_name, account_type, currency,
              current_balance, is_tax_account, tax_pot_balance, is_active,
              last_synced_at, sync_status
       FROM bank_connections WHERE user_id = $1 AND is_active = true ORDER BY created_at ASC`,
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

async function syncTransactionsForUser(userId, accessToken, isInitial = false) {
  const connections = await query(
    `SELECT id, account_id FROM bank_connections
     WHERE user_id = $1 AND is_active = true`,
    [userId]
  );
  for (const conn of connections.rows) {
    await syncAccountTransactions(userId, conn.account_id, accessToken, isInitial);
  }
}

async function syncAccountTransactions(userId, accountId, accessToken, isInitial = false) {
  let imported = 0;

  try {
    // On initial sync use 6 years back to maximise Monzo 5-min window
    // On regular sync use tax year start (6 April)
    const now = new Date();
    const taxYearStart = now.getMonth() >= 3 && !(now.getMonth() === 3 && now.getDate() < 6)
      ? new Date(now.getFullYear(), 3, 6)
      : new Date(now.getFullYear() - 1, 3, 6);
    const sixYearsAgo = new Date(now.getFullYear() - 6, now.getMonth(), now.getDate());
    const from = isInitial ? sixYearsAgo : taxYearStart;

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
        ON CONFLICT DO NOTHING
        RETURNING id
      `, [
        userId, bankConnectionId, normalised.truelayer_id,
        normalised.amount, normalised.description, normalised.merchant_name,
        normalised.transaction_date, normalised.transaction_type,
        classification.category, classification.sub_category,
        classification.is_income || false,
        classification.is_cis || false,
      ]);

      if (!txnResult.rows[0]) continue; // already exists, skip
      const txnId = txnResult.rows[0].id;

      // Auto-dismiss if TCE flagged it (e.g. returned DD — not income, not for review)
      if (classification.auto_dismiss) {
        await query(
          `UPDATE transactions SET user_confirmed = false, dismissed_at = NOW() WHERE id = $1`,
          [txnId]
        );
      }

      // Income events are NOT written here — only written when user confirms
      // via PATCH /transactions/:id/confirm-income

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


// ── Token refresh helper ─────────────────────────────────────────────────────
// TrueLayer access tokens expire after ~1 hour.
// Call this before any API request — it refreshes if within 5 minutes of expiry.

async function refreshAccessToken(userId, accountId) {
  // Get current token record
  const result = await query(
    `SELECT id, access_token, refresh_token, token_expires_at
     FROM bank_connections
     WHERE user_id = $1 AND account_id = $2 AND is_active = true
     LIMIT 1`,
    [userId, accountId]
  );

  if (result.rows.length === 0) throw new Error('No connection found');
  const conn = result.rows[0];

  // Check if refresh needed (within 5 minutes of expiry)
  const expiresAt  = new Date(conn.token_expires_at);
  const fiveMinutes = 5 * 60 * 1000;
  if (expiresAt - Date.now() > fiveMinutes) {
    return conn.access_token; // Still valid — return as-is
  }

  // Refresh the token
  let tokenResponse;
  try {
    tokenResponse = await axios.post(`${TL_AUTH_URL}/connect/token`,
      new URLSearchParams({
        grant_type:    'refresh_token',
        client_id:     process.env.TRUELAYER_CLIENT_ID,
        client_secret: process.env.TRUELAYER_CLIENT_SECRET,
        refresh_token: conn.refresh_token,
      }).toString(),
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
    );
  } catch (err) {
    const status = err?.response?.status;
    if (status === 400 || status === 401) {
      // Consent expired or revoked — mark connection inactive and notify user
      await query(
        `UPDATE bank_connections SET is_active = false, updated_at = NOW()
         WHERE user_id = $1 AND account_id = $2`,
        [userId, accountId]
      );
      // Insert re-consent notification (avoid duplicates)
      await query(
        `INSERT INTO notifications (user_id, alert_type, severity, title, body)
         SELECT $1, 'consent_expiring', 'WARNING',
           'Bank connection disconnected',
           'Your bank connection has expired. Tap to re-connect and keep your FlexFlow data up to date.'
         WHERE NOT EXISTS (
           SELECT 1 FROM notifications
           WHERE user_id = $1 AND alert_type = 'consent_expiring'
             AND is_dismissed = false
             AND created_at > NOW() - INTERVAL '1 day'
         )`,
        [userId]
      );
      console.log(`[TOKEN EXPIRED] Connection marked inactive for user ${userId} account ${accountId}`);
    }
    throw err;
  }

  const { access_token, refresh_token, expires_in } = tokenResponse.data;
  const newExpiry = new Date(Date.now() + expires_in * 1000);

  // Store refreshed tokens
  await query(
    `UPDATE bank_connections
     SET access_token = $1, refresh_token = $2,
         token_expires_at = $3, updated_at = NOW()
     WHERE user_id = $4 AND account_id = $5`,
    [access_token, refresh_token, newExpiry, userId, accountId]
  );

  console.log(`🔄 Token refreshed for user ${userId} account ${accountId}`);
  return access_token;
}


// ── GET /truelayer/status ─────────────────────────────────────────────────────
// Returns whether the user has at least one active connected bank account.
// Frontend uses this to decide whether to show "Connect bank" or live data.

router.get('/status', verifyToken, async (req, res) => {
  try {
    const result = await query(
      `SELECT
         COUNT(*) FILTER (WHERE is_active = true)                          AS connected_count,
         COUNT(*) FILTER (WHERE is_active = false)                         AS inactive_count,
         MAX(last_synced_at)                                                AS last_synced,
         COUNT(*) FILTER (WHERE is_active = true AND sync_status = 'error') AS error_count,
         BOOL_OR(is_active = true AND is_tax_account = true)               AS has_tax_account
       FROM bank_connections
       WHERE user_id = $1`,
      [req.user.userId]
    );

    const row = result.rows[0];
    const connectedCount = parseInt(row.connected_count) || 0;

    const inactiveCount = parseInt(row.inactive_count) || 0;
    return res.json({
      connected:                  connectedCount > 0,
      connected_count:            connectedCount,
      last_synced:                row.last_synced || null,
      has_tax_account:            row.has_tax_account || false,
      has_errors:                 parseInt(row.error_count) > 0,
      has_inactive_connections:   inactiveCount > 0,
      inactive_count:             inactiveCount,
    });
  } catch (err) {
    console.error('Status error:', err.message);
    return res.status(500).json({ error: 'Failed to get connection status.' });
  }
});


// ── GET /truelayer/balances ───────────────────────────────────────────────────
// Returns live balances for designated accounts:
//   spendingBalance — sum of all accounts designated as 'spending'
//   taxPotBalance   — sum of all accounts designated as 'tax'
//
// Designation is stored in account_designations table (many-to-many).
// Falls back to bank_connections.is_tax_account for backwards compat.
//
// Fetches fresh balances from TrueLayer API (with token refresh).
// Caches to bank_connections.current_balance — if TrueLayer call fails,
// returns the last cached value rather than erroring.

router.get('/balances', verifyToken, async (req, res) => {
  try {
    const userId = req.user.userId;

    // Get all active connections with their designations
    const connsResult = await query(
      `SELECT
         bc.id, bc.account_id, bc.account_name, bc.access_token,
         bc.refresh_token, bc.token_expires_at, bc.current_balance,
         bc.is_tax_account,
         COALESCE(
           array_agg(ad.designation_type) FILTER (WHERE ad.designation_type IS NOT NULL),
           ARRAY[]::text[]
         ) AS designations
       FROM bank_connections bc
       LEFT JOIN account_designations ad
         ON ad.bank_account_id = bc.account_id AND ad.user_id = $1
       WHERE bc.user_id = $1 AND bc.is_active = true
       GROUP BY bc.id, bc.account_name, bc.access_token, bc.refresh_token,
                bc.token_expires_at, bc.current_balance, bc.is_tax_account`,
      [userId]
    );

    const connections = connsResult.rows;

    if (connections.length === 0) {
      return res.json({
        connected:       false,
        spendingBalance: null,
        taxPotBalance:   null,
        accounts:        [],
      });
    }

    // Fetch live balance for each account from TrueLayer
    const accountBalances = [];

    for (const conn of connections) {
      let balance = conn.current_balance || 0;

      try {
        // Refresh token if needed
        const accessToken = await refreshAccessToken(userId, conn.account_id);

        // Fetch balance from TrueLayer
        const balResponse = await axios.get(
          `${TL_API_URL}/data/v1/accounts/${conn.account_id}/balance`,
          { headers: { Authorization: `Bearer ${accessToken}` } }
        );

        const balData = balResponse.data.results?.[0];
        if (balData) {
          balance = balData.available !== undefined
            ? balData.available   // Use available (excludes pending)
            : balData.current;

          // Cache to DB
          await query(
            `UPDATE bank_connections
             SET current_balance = $1, last_balance_fetch = NOW(), updated_at = NOW()
             WHERE id = $2`,
            [balance, conn.id]
          );
        }
      } catch (fetchErr) {
        // Token refresh or API failed — use cached balance, log and continue
        console.warn(`Balance fetch failed for account ${conn.account_id}: ${fetchErr.message} — using cached`);
      }

      accountBalances.push({
        id:           conn.id,
        account_id:   conn.account_id,
        account_name: conn.account_name,
        balance,
        designations: conn.designations,
        is_tax_account: conn.is_tax_account,
      });
    }

    // Sum balances by designation
    // An account can have multiple designations (many-to-many)
    // Priority: designation table first, is_tax_account fallback

    let spendingBalance        = 0;
    let taxPotBalance          = 0;
    let futureEarningsBalance  = 0;
    let pensionBalance         = 0;
    let billsBalance           = 0;
    let hasSpending            = false;
    let hasTax                 = false;
    let hasFutureEarnings      = false;
    let hasPension             = false;
    let hasBills               = false;

    for (const acc of accountBalances) {
      const desigs = acc.designations || [];

      // Use designation table if populated, else fall back to is_tax_account flag
      const isSpending       = desigs.includes('spending');
      const isTax            = desigs.includes('tax') || (desigs.length === 0 && acc.is_tax_account);
      const isFutureEarnings = desigs.includes('future_earnings');
      const isPension        = desigs.includes('pension');
      const isBills          = desigs.includes('bills');

      if (isSpending)       { spendingBalance       += acc.balance; hasSpending       = true; }
      if (isTax)            { taxPotBalance         += acc.balance; hasTax            = true; }
      if (isFutureEarnings) { futureEarningsBalance += acc.balance; hasFutureEarnings = true; }
      if (isPension)        { pensionBalance        += acc.balance; hasPension        = true; }
      if (isBills)          { billsBalance          += acc.balance; hasBills          = true; }
    }

    // Round to 2dp
    spendingBalance       = Math.round(spendingBalance       * 100) / 100;
    taxPotBalance         = Math.round(taxPotBalance         * 100) / 100;
    futureEarningsBalance = Math.round(futureEarningsBalance * 100) / 100;
    pensionBalance        = Math.round(pensionBalance        * 100) / 100;
    billsBalance          = Math.round(billsBalance          * 100) / 100;

    return res.json({
      connected:             true,
      spendingBalance:       hasSpending       ? spendingBalance       : null,
      taxPotBalance:         hasTax            ? taxPotBalance         : null,
      futureEarningsBalance: hasFutureEarnings ? futureEarningsBalance : null,
      pensionBalance:        hasPension        ? pensionBalance        : null,
      billsBalance:          hasBills          ? billsBalance          : null,
      accounts:              accountBalances,
      fetched_at:            new Date().toISOString(),
    });

  } catch (err) {
    console.error('Balances error:', err.message);
    return res.status(500).json({ error: 'Failed to fetch balances.' });
  }
});

// ── GET /truelayer/consent-status — returns consent expiry info per connection ──
router.get('/consent-status', verifyToken, async (req, res) => {
  try {
    const userId = req.user.userId;
    const { rows } = await query(`
      SELECT id, provider, account_name, consent_granted_at, consent_expires_at,
             EXTRACT(DAY FROM (consent_expires_at - NOW())) AS days_remaining
      FROM bank_connections
      WHERE user_id = $1 AND is_active = true
      GROUP BY id, provider, account_name, consent_granted_at, consent_expires_at
      ORDER BY consent_expires_at ASC
    `, [userId]);

    const connections = rows.map(r => ({
      id:               r.id,
      provider:         r.provider,
      accountName:      r.account_name,
      consentGrantedAt: r.consent_granted_at,
      consentExpiresAt: r.consent_expires_at,
      daysRemaining:    Math.max(0, Math.floor(parseFloat(r.days_remaining) || 0)),
      isExpiringSoon:   parseFloat(r.days_remaining) <= 7,
      isExpired:        parseFloat(r.days_remaining) <= 0,
    }));

    const hasExpiring = connections.some(c => c.isExpiringSoon);
    const hasExpired  = connections.some(c => c.isExpired);

    return res.json({ connections, hasExpiring, hasExpired });
  } catch (err) {
    console.error('Consent status error:', err.message);
    return res.status(500).json({ error: 'Failed to fetch consent status.' });
  }
});

module.exports = router;
