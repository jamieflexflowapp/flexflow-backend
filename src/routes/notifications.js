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
