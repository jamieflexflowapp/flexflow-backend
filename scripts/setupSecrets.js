'use strict';
/**
 * FlexFlow — Generate and save JWT secrets to .env
 * Run once: node scripts/setupSecrets.js
 */
const crypto = require('crypto');
const fs     = require('fs');
const path   = require('path');

const envPath = path.join(__dirname, '..', '.env');
let   env     = fs.readFileSync(envPath, 'utf8');

const jwtSecret        = crypto.randomBytes(48).toString('hex');
const jwtRefreshSecret = crypto.randomBytes(48).toString('hex');

env = env.replace('JWT_SECRET=your_jwt_secret_here_minimum_32_chars',        `JWT_SECRET=${jwtSecret}`);
env = env.replace('JWT_REFRESH_SECRET=your_refresh_secret_here_minimum_32_chars', `JWT_REFRESH_SECRET=${jwtRefreshSecret}`);

fs.writeFileSync(envPath, env);
console.log('✅ JWT secrets generated and saved to .env');
console.log('   Restart the server for changes to take effect: npm run dev');
