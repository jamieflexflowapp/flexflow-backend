'use strict';

const Stripe = require('stripe');

const stripe = Stripe(process.env.STRIPE_SECRET_KEY);

const PRICES = {
  pro_monthly: 'price_1Tdu4zHPZ6Izq1uFbqKS6XPZ',
  pro_annual:  'price_1TWzptHPZ6Izq1uFvAw8B6tw',
};

const PRODUCTS = {
  pro_monthly: 'prod_UdAPwLJEEwG04s',
  pro_annual:  'prod_UW1tXJBRhgfyxn',
};

module.exports = { stripe, PRICES, PRODUCTS };
