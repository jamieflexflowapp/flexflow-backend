'use strict';

const express = require('express');
const router = express.Router();
const { verifyToken } = require('../middleware/auth');
const { query } = require('../config/database');
const { sendEmail } = require('../utils/sendgrid');

router.post('/', verifyToken, async (req, res) => {
  try {
    const userId = req.user.userId;
    const { topic, message } = req.body;

    if (!topic || !message?.trim()) {
      return res.status(400).json({ error: 'Topic and message are required' });
    }

    const userResult = await query(`SELECT email, full_name FROM users WHERE id = $1`, [userId]);
    const user = userResult.rows[0];
    const userEmail = user?.email || 'Unknown';
    const userName = user?.full_name || 'Unknown';
    const sentAt = new Date().toLocaleString('en-GB', { timeZone: 'Europe/London' });

    console.log('[SUPPORT] Sending email to jamie@flexflowapp.co.uk for user:', userEmail);
    await sendEmail({
      to: 'jamie@flexflowapp.co.uk',
      subject: `FlexFlow Support: ${topic}`,
      text: `New support message received.\n\nFrom: ${userName} (${userEmail})\nUser ID: ${userId}\nTopic: ${topic}\nSent at: ${sentAt} (London time)\n\nMessage:\n${message}`,
      html: `<h2>FlexFlow Support Message</h2><table><tr><td><b>From:</b></td><td>${userName} (${userEmail})</td></tr><tr><td><b>User ID:</b></td><td>${userId}</td></tr><tr><td><b>Topic:</b></td><td>${topic}</td></tr><tr><td><b>Sent at:</b></td><td>${sentAt} (London time)</td></tr></table><br><h3>Message:</h3><p>${message.replace(/\n/g, '<br>')}</p>`,
    });

    res.json({ success: true });
  } catch (err) {
    console.error('[SUPPORT]', err);
    res.status(500).json({ error: 'Failed to send support message' });
  }
});

module.exports = router;
