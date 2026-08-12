#!/usr/bin/env node
// Write a scrypt password hash for the OAuth login page.
// Usage: node set-password.js <password>

'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const os = require('os');

const password = process.argv[2];
if (!password) {
  console.error('Usage: node set-password.js <password>');
  process.exit(2);
}

const dir = process.env.CONFIG_DIR || path.join(os.homedir(), '.config', 'obsidian-mcp');
fs.mkdirSync(dir, { recursive: true });

const salt = crypto.randomBytes(16).toString('hex');
const hash = crypto.scryptSync(password, salt, 64).toString('hex');
const file = path.join(dir, 'password-hash');
fs.writeFileSync(file, `${salt}:${hash}\n`, { mode: 0o600 });

console.log(`Wrote ${file}`);
