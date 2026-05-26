'use strict';

const Stripe = require('stripe');

const stripe = Stripe(process.env.STRIPE_SECRET_KEY);

const PRICES = {
  free:        'price_1TWznyHPZ6Izq1uFhpShBnqU',
  pro_monthly: 'price_1TWzpUHPZ6Izq1uFGSqpzPfc',
  pro_annual:  'price_1TWzptHPZ6Izq1uFvAw8B6tw',
};

const PRODUCTS = {
  free:        'prod_UW1rhTXFYby47A',
  pro_monthly: 'prod_UW1tZz2FnpZTmQ',
  pro_annual:  'prod_UW1tXJBRhgfyxn',
};

module.exports = { stripe, PRICES, PRODUCTS };
