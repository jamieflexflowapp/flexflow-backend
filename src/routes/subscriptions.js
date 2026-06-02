'use strict';

const express = require('express');
const router  = express.Router();
const { verifyToken } = require('../middleware/auth');
const { query }       = require('../config/database');
const { stripe, PRICES } = require('../config/stripe');

router.post('/checkout', verifyToken, async (req, res) => {
  try {
    const { plan, interval } = req.body;
    if (plan !== 'pro') return res.status(400).json({ error: 'Invalid plan.' });
    const priceId = interval === 'annual' ? PRICES.pro_annual : PRICES.pro_monthly;
    const result = await query(`SELECT email, stripe_customer_id, trial_used FROM users WHERE id = $1`, [req.user.userId]);
    if (!result.rows.length) return res.status(404).json({ error: 'User not found.' });
    const { email, stripe_customer_id, trial_used } = result.rows[0];
    const sessionParams = {
      mode: 'subscription',
      payment_method_types: ['card'],
      line_items: [{ price: priceId, quantity: 1 }],
      success_url: `${process.env.APP_URL}/subscription/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url:  `${process.env.APP_URL}/subscription/cancel`,
      metadata: { userId: req.user.userId, plan: 'pro', interval },
    };
    if (stripe_customer_id) {
      sessionParams.customer = stripe_customer_id;
    } else {
      sessionParams.customer_email = email;
    }
    if (!trial_used) {
      sessionParams.subscription_data = { trial_period_days: 30 };
    }
    const session = await stripe.checkout.sessions.create(sessionParams);
    return res.status(200).json({ checkoutUrl: session.url, sessionId: session.id });
  } catch (err) {
    console.error('Checkout error:', err);
    return res.status(500).json({ error: 'Failed to create checkout session.' });
  }
});

router.get('/status', verifyToken, async (req, res) => {
  try {
    const result = await query(
      `SELECT plan, stripe_customer_id, stripe_subscription_id,
              subscription_status, subscription_renewal_date, subscription_cancel_at_period_end
       FROM users WHERE id = $1`, [req.user.userId]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'User not found.' });
    return res.status(200).json(result.rows[0]);
  } catch (err) {
    return res.status(500).json({ error: 'Failed to get subscription status.' });
  }
});

router.post('/cancel', verifyToken, async (req, res) => {
  try {
    const result = await query(`SELECT stripe_subscription_id FROM users WHERE id = $1`, [req.user.userId]);
    const { stripe_subscription_id } = result.rows[0];
    if (!stripe_subscription_id) return res.status(400).json({ error: 'No active subscription.' });
    await stripe.subscriptions.update(stripe_subscription_id, { cancel_at_period_end: true });
    await query(`UPDATE users SET subscription_cancel_at_period_end = true, updated_at = NOW() WHERE id = $1`, [req.user.userId]);
    return res.status(200).json({ message: 'Subscription will cancel at period end.' });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to cancel subscription.' });
  }
});

router.post('/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  const sig = req.headers['stripe-signature'];
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }
  try {
    switch (event.type) {
      case 'checkout.session.completed': {
        const s = event.data.object;
        await query(
          `UPDATE users SET plan = 'pro', stripe_customer_id = $2, stripe_subscription_id = $3,
           subscription_status = 'active', subscription_cancel_at_period_end = false,
           trial_used = true, updated_at = NOW()
           WHERE id = $1`,
          [s.metadata.userId, s.customer, s.subscription]
        );
        break;
      }
      case 'invoice.payment_succeeded': {
        const inv = event.data.object;
        const sub = await stripe.subscriptions.retrieve(inv.subscription);
        await query(
          `UPDATE users SET subscription_status = 'active', subscription_renewal_date = to_timestamp($2), updated_at = NOW()
           WHERE stripe_subscription_id = $1`,
          [inv.subscription, sub.current_period_end]
        );
        break;
      }
      case 'invoice.payment_failed':
        await query(
          `UPDATE users SET subscription_status = 'past_due', updated_at = NOW() WHERE stripe_subscription_id = $1`,
          [event.data.object.subscription]
        );
        break;
      case 'customer.subscription.deleted':
        await query(
          `UPDATE users SET plan = 'cancelled', subscription_status = 'cancelled', stripe_subscription_id = NULL, updated_at = NOW()
           WHERE stripe_subscription_id = $1`,
          [event.data.object.id]
        );
        break;
    }
    return res.status(200).json({ received: true });
  } catch (err) {
    return res.status(500).json({ error: 'Webhook processing failed.' });
  }
});

module.exports = router;
