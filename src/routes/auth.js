'use strict';

/**
 * FlexFlow — Auth Routes
 * Updated Phase 4 — Email verification routes added
 *
 * POST /auth/register             — create account, send verification email
 * POST /auth/verify-email         — validate 6-digit code, mark verified
 * POST /auth/resend-verification  — resend verification code
 * POST /auth/login                — get access + refresh tokens
 * POST /auth/refresh              — exchange refresh token for new access token
 * POST /auth/logout               — invalidate refresh token
 */

const express = require('express');
const router  = express.Router();
const authController = require('../middleware/authController');

router.post('/register',            authController.register);
router.post('/verify-email',        authController.verifyEmail);
router.post('/resend-verification', authController.resendVerification);
router.post('/login',               authController.login);
router.post('/refresh',             authController.refresh);
router.post('/logout',              authController.logout);

module.exports = router;
