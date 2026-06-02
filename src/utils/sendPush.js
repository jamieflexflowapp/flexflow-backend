'use strict';
const axios = require('axios');
const { query } = require('../config/database');

async function sendPush(userId, title, body) {
  try {
    const result = await query(
      'SELECT expo_push_token, push_notifications_enabled FROM users WHERE id = $1',
      [userId]
    );
    const user = result.rows[0];
    if (!user || !user.push_notifications_enabled || !user.expo_push_token) return;

    await axios.post('https://exp.host/--/api/v2/push/send', {
      to: user.expo_push_token,
      title,
      body,
      sound: 'default',
    }, {
      headers: { 'Content-Type': 'application/json' },
    });

    console.log(`[PUSH] Sent to user ${userId}: ${title}`);
  } catch (err) {
    console.error(`[PUSH] Failed for user ${userId}:`, err.message);
  }
}

module.exports = { sendPush };
