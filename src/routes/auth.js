'use strict';

/**
 * FlexFlow — Auth Routes
 * Session B — Task 3
 *
 * POST /auth/register  — create account
 * POST /auth/login     — get access + refresh tokens
 * POST /auth/refresh   — exchange refresh token for new access token
 * POST /auth/logout    — invalidate refresh token
 */

const express = require('express');
const router = express.Router();
const authController = require('../middleware/authController');

router.post('/register', authController.register);
router.post('/login',    authController.login);
router.post('/refresh',  authController.refresh);
router.post('/logout',   authController.logout);

module.exports = router;
