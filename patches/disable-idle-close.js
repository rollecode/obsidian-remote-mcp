#!/usr/bin/env node
// obsidian-mcp starts a ConnectionMonitor that calls server.close() after 60
// seconds without a request. Closing the stdio transport detaches its stdin
// listener, so the process keeps running but never answers again.
//
// That suits its intended use, where a desktop client spawns a fresh child per
// session and disposes of it. Here supergateway keeps one child per session for
// up to an hour, and any human-paced gap between two calls is longer than 60
// seconds, so the helper goes deaf mid-session and every later call hangs.
// Session lifetime is supergateway's job, so the monitor is redundant here.
//
// Idempotent, and loud if upstream changes shape rather than silently doing
// nothing.
const fs = require('fs');
const path = require('path');

const TARGET = path.join(
  __dirname,
  '..',
  'node_modules',
  'obsidian-mcp',
  'build',
  'main.js'
);

const FROM = `    this.connectionMonitor.start(() => {
      this.server.close();
    });`;
const TO = `    this.connectionMonitor.start(() => {});`;

if (!fs.existsSync(TARGET)) {
  console.error(`disable-idle-close: ${TARGET} not found`);
  process.exit(1);
}

const source = fs.readFileSync(TARGET, 'utf8');

if (source.includes(TO)) {
  console.log('disable-idle-close: already applied');
  process.exit(0);
}

if (!source.includes(FROM)) {
  console.error(
    'disable-idle-close: idle-close call site not found. obsidian-mcp has changed; ' +
      're-check whether it still closes the server on an idle timer before shipping.'
  );
  process.exit(1);
}

fs.writeFileSync(TARGET, source.replace(FROM, TO));
console.log('disable-idle-close: patched, helper no longer goes deaf after 60s idle');
