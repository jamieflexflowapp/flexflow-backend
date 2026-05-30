'use strict';

/**
 * FlexFlow — SendGrid Email Utility
 * Phase 4 — Auth Backend
 *
 * Sends transactional emails via SendGrid.
 * Requires SENDGRID_API_KEY in .env
 * Free tier: 100 emails/day — sufficient for beta
 */

const sgMail = require('@sendgrid/mail');

sgMail.setApiKey(process.env.SENDGRID_API_KEY);

const FROM_EMAIL = process.env.SENDGRID_FROM_EMAIL || 'hello@flexflowapp.co.uk';
const FROM_NAME  = 'FlexFlow';

// ── Send email verification code ──────────────────────────────────────────────
async function sendVerificationEmail(toEmail, firstName, code) {
  const msg = {
    to:   toEmail,
    from: { email: FROM_EMAIL, name: FROM_NAME },
    subject: 'Verify your FlexFlow account',
    text: `Hi ${firstName},\n\nYour FlexFlow verification code is: ${code}\n\nThis code expires in 15 minutes.\n\nIf you didn't create a FlexFlow account, you can ignore this email.\n\nThe FlexFlow Team`,
    html: `
      <div style="font-family: Arial, sans-serif; max-width: 480px; margin: 0 auto; padding: 32px; background: #0E1928; color: #ffffff; border-radius: 12px;">
        <h1 style="color: #14A8AE; font-size: 28px; margin-bottom: 8px;">FlexFlow</h1>
        <p style="color: #C8D4E0; font-size: 16px;">Hi ${firstName},</p>
        <p style="color: #C8D4E0; font-size: 16px;">Your verification code is:</p>
        <div style="background: #151D2B; border: 3px solid #14A8AE; border-radius: 12px; padding: 24px; text-align: center; margin: 24px 0;">
          <span style="font-size: 40px; font-weight: 800; letter-spacing: 12px; color: #ffffff;">${code}</span>
        </div>
        <p style="color: #C8D4E0; font-size: 14px;">This code expires in <strong>15 minutes</strong>.</p>
        <p style="color: #6B7280; font-size: 12px; margin-top: 32px;">If you didn't create a FlexFlow account, you can safely ignore this email.</p>
      </div>
    `,
  };

  await sgMail.send(msg);
}

// ── Send welcome email (after verification) ───────────────────────────────────
async function sendWelcomeEmail(toEmail, firstName) {
  const msg = {
    to:   toEmail,
    from: { email: FROM_EMAIL, name: FROM_NAME },
    subject: "Welcome to FlexFlow — you're all set",
    text: `Hi ${firstName},\n\nWelcome to FlexFlow! Your account is verified and ready to go.\n\nFlexFlow gives you real-time clarity on your income, tax pot and runway — built specifically for freelancers like you.\n\nThe FlexFlow Team`,
    html: `
      <div style="font-family: Arial, sans-serif; max-width: 480px; margin: 0 auto; padding: 32px; background: #0E1928; color: #ffffff; border-radius: 12px;">
        <h1 style="color: #14A8AE; font-size: 28px; margin-bottom: 8px;">FlexFlow</h1>
        <p style="color: #C8D4E0; font-size: 16px;">Hi ${firstName},</p>
        <p style="color: #C8D4E0; font-size: 16px;">Welcome to FlexFlow! Your account is verified and you're all set.</p>
        <p style="color: #C8D4E0; font-size: 16px;">FlexFlow gives you real-time clarity on your income, tax pot and runway — built specifically for freelancers like you.</p>
        <p style="color: #C8D4E0; font-size: 14px; margin-top: 32px;">The FlexFlow Team</p>
      </div>
    `,
  };

  await sgMail.send(msg);
}

// ── Send password reset code ─────────────────────────────────────────────────
async function sendPasswordResetEmail(toEmail, firstName, code) {
  const msg = {
    to:   toEmail,
    from: { email: FROM_EMAIL, name: FROM_NAME },
    subject: 'Reset your FlexFlow password',
    text: `Hi ${firstName},

Your password reset code is: ${code}

This code expires in 15 minutes.

If you didn't request a password reset, you can ignore this email.

The FlexFlow Team`,
    html: `
      <div style="font-family: Arial, sans-serif; max-width: 480px; margin: 0 auto; padding: 32px; background: #0E1928; color: #ffffff; border-radius: 12px;">
        <h1 style="color: #14A8AE; font-size: 28px; margin-bottom: 8px;">FlexFlow</h1>
        <p style="color: #C8D4E0; font-size: 16px;">Hi ${firstName},</p>
        <p style="color: #C8D4E0; font-size: 16px;">You requested a password reset. Your code is:</p>
        <div style="background: #151D2B; border: 3px solid #14A8AE; border-radius: 12px; padding: 24px; text-align: center; margin: 24px 0;">
          <span style="font-size: 40px; font-weight: 800; letter-spacing: 12px; color: #ffffff;">${code}</span>
        </div>
        <p style="color: #C8D4E0; font-size: 14px;">This code expires in <strong>15 minutes</strong>.</p>
        <p style="color: #6B7280; font-size: 12px; margin-top: 32px;">If you didn't request a password reset, you can safely ignore this email.</p>
      </div>
    `,
  };
  await sgMail.send(msg);
}

module.exports = { sendVerificationEmail, sendWelcomeEmail, sendPasswordResetEmail };
