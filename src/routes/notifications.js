'use strict';
const express = require('express');
const router = express.Router();
const { query } = require('../config/database');
const { verifyToken } = require('../middleware/auth');

router.use(verifyToken);

// POST /notifications/token — register device push token
router.post('/token', async (req, res) => {
  try {
    const { token } = req.body;
    if (!token) return res.status(400).json({ error: 'Token required' });
    await query(
      'UPDATE users SET expo_push_token = $1 WHERE id = $2',
      [token, req.user.userId]
    );
    res.json({ success: true });
  } catch (err) {
    console.error('[PUSH TOKEN]', err.message);
    res.status(500).json({ error: 'Failed to save push token' });
  }
});

// PATCH /notifications/preferences — toggle push notifications on/off
router.patch('/preferences', async (req, res) => {
  try {
    const { push_notifications_enabled } = req.body;
    await query(
      'UPDATE users SET push_notifications_enabled = $1 WHERE id = $2',
      [push_notifications_enabled, req.user.userId]
    );
    res.json({ success: true, push_notifications_enabled });
  } catch (err) {
    console.error('[PUSH PREFS]', err.message);
    res.status(500).json({ error: 'Failed to update preferences' });
  }
});

// GET /notifications/preferences — get current preferences
router.get('/preferences', async (req, res) => {
  try {
    const result = await query(
      'SELECT push_notifications_enabled FROM users WHERE id = $1',
      [req.user.userId]
    );
    res.json({ push_notifications_enabled: result.rows[0]?.push_notifications_enabled || false });
  } catch (err) {
    res.status(500).json({ error: 'Failed to get preferences' });
  }
});

module.exports = router;

// GET /notifications — fetch all undismissed notifications for user
router.get('/', async (req, res) => {
  try {
    const result = await query(
      `SELECT id, alert_type, severity, title, body, action_url, is_read, is_dismissed, created_at
       FROM notifications
       WHERE user_id = $1 AND is_dismissed = false
       ORDER BY created_at DESC
       LIMIT 50`,
      [req.user.userId]
    );
    res.json({ notifications: result.rows });
  } catch (err) {
    console.error('[NOTIFS GET]', err.message);
    res.status(500).json({ error: 'Failed to fetch notifications' });
  }
});

// DELETE /notifications/:id — dismiss a notification permanently
router.delete('/:id', async (req, res) => {
  try {
    await query(
      `UPDATE notifications SET is_dismissed = true, dismissed_at = NOW()
       WHERE id = $1 AND user_id = $2`,
      [req.params.id, req.user.userId]
    );
    res.json({ success: true });
  } catch (err) {
    console.error('[NOTIFS DELETE]', err.message);
    res.status(500).json({ error: 'Failed to dismiss notification' });
  }
});
