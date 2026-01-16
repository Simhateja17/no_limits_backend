#!/usr/bin/env node

/**
 * Generate secure JWT secrets for production
 * Run: node generate-secrets.cjs
 */

import crypto from 'crypto';

console.log('\n=== JWT Secret Generator ===\n');
console.log('Copy these values to your Render environment variables:\n');

const jwtSecret = crypto.randomBytes(64).toString('hex');
const jwtRefreshSecret = crypto.randomBytes(64).toString('hex');

console.log('JWT_SECRET:');
console.log(jwtSecret);
console.log('\nJWT_REFRESH_SECRET:');
console.log(jwtRefreshSecret);

console.log('\n=== Environment Variable Format ===\n');
console.log(`JWT_SECRET=${jwtSecret}`);
console.log(`JWT_REFRESH_SECRET=${jwtRefreshSecret}`);
console.log('\n');
