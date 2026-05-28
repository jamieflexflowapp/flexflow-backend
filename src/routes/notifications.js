'use strict';

/**
 * FlexFlow — Notifications Routes
 * Phase 4 — Notification Centre backend
 *
 * GET    /notifications           — get all notifications for user
 * PATCH  /notifications/:id/read  — mark a notification as read
 * DELETE /notifications/:id       — delete a notification
 * POST   /notifications/read-all  — mark all as read
 * DELETE /notifications/clear-all — delete all notifications
 */

const express = require('express');
const router  = express.Router();
const { verifyToken, checkOnboardingComplete } = require('../middleware/auth');
const { query } = require('../config/database');

router.use(verifyToken, checkOnboardingComplete);

// ── GET /notifications ────────────────────────────────────────────────────────
router.get('/', async (req, res) => {
  try {
    const { type, unread_only } = req.query;

    let sql = `
      SELECT id, alert_type, title, body, is_read, created_at
      FROM notifications
      WHERE user_id = $1
    `;
    const params = [req.user.userId];

    if (type) {
      params.push(type);
      sql += ` AND alert_type = $${params.length}`;
    }
    if (unread_only === 'true') {
      sql += ` AND is_read = false`;
    }

    sql += ` ORDER BY created_at DESC LIMIT 50`;

    const result = await query(sql, params);
    const unreadCount = result.rows.filter(n => !n.is_read).length;

    return res.json({
      notifications: result.rows,
      unread_count:  unreadCount,
      total:         result.rows.length,
    });

  } catch (err) {
    console.error('Notifications get error:', err);
    return res.status(500).json({ error: 'Failed to get notifications.' });
  }
});

// ── PATCH /notifications/:id/read ─────────────────────────────────────────────
router.patch('/:id/read', async (req, res) => {
  try {
    await query(
      `UPDATE notifications SET is_read = true, read_at = NOW()
       WHERE id = $1 AND user_id = $2`,
      [req.params.id, req.user.userId]
    );
    return res.json({ message: 'Notification marked as read.' });
  } catch (err) {
    console.error('Mark read error:', err);
    return res.status(500).json({ error: 'Failed to mark notification as read.' });
  }
});

// ── DELETE /notifications/:id ─────────────────────────────────────────────────
router.delete('/:id', async (req, res) => {
  try {
    await query(
      `DELETE FROM notifications WHERE id = $1 AND user_id = $2`,
      [req.params.id, req.user.userId]
    );
    return res.json({ message: 'Notification deleted.' });
  } catch (err) {
    console.error('Delete notification error:', err);
    return res.status(500).json({ error: 'Failed to delete notification.' });
  }
});

// ── POST /notifications/read-all ──────────────────────────────────────────────
router.post('/read-all', async (req, res) => {
  try {
    const result = await query(
      `UPDATE notifications SET is_read = true, read_at = NOW()
       WHERE user_id = $1 AND is_read = false`,
      [req.user.userId]
    );
    return res.json({
      message: 'All notifications marked as read.',
      updated: result.rowCount,
    });
  } catch (err) {
    console.error('Read all error:', err);
    return res.status(500).json({ error: 'Failed to mark all as read.' });
  }
});

// ── DELETE /notifications/clear-all ──────────────────────────────────────────
router.delete('/clear-all', async (req, res) => {
  try {
    const result = await query(
      `DELETE FROM notifications WHERE user_id = $1`,
      [req.user.userId]
    );
    return res.json({
      message: 'All notifications cleared.',
      deleted: result.rowCount,
    });
  } catch (err) {
    console.error('Clear all error:', err);
    return res.status(500).json({ error: 'Failed to clear notifications.' });
  }
});

module.exports = router;
