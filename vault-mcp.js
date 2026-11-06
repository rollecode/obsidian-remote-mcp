#!/usr/bin/env node
//
// MCP server over an Obsidian vault on disk, spoken over stdio or Streamable HTTP.
//
// Reads and writes plain files, so Obsidian does not need to be running and no
// plugin is involved. auth-server.js is what makes it safe to reach from
// outside; nothing in here authenticates anything.

'use strict';

const { randomUUID } = require('node:crypto');
const express = require('express');
const { Server } = require('@modelcontextprotocol/sdk/server/index.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const { StreamableHTTPServerTransport } = require('@modelcontextprotocol/sdk/server/streamableHttp.js');
const {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  McpError,
  ErrorCode,
  isInitializeRequest,
} = require('@modelcontextprotocol/sdk/types.js');

const { createRegistry } = require('./lib/vault');
const { check } = require('./lib/validate');
const pkg = require('./package.json');

const TOOLS = [
  ...require('./lib/tools/browse').tools,
  ...require('./lib/tools/notes').tools,
  ...require('./lib/tools/frontmatter').tools,
  ...require('./lib/tools/folders').tools,
  ...require('./lib/tools/tags').tools,
  ...require('./lib/tools/links').tools,
  ...require('./lib/tools/search').tools,
  ...require('./lib/tools/canvas').tools,
  ...require('./lib/tools/daily').tools,
  ...require('./lib/tools/attachments').tools,
];

const HTTP_FLAG = '--http';
const HTTP_HOST = '127.0.0.1';
const MCP_PATH = '/mcp';
const SESSION_HEADER = 'mcp-session-id';
const BODY_LIMIT = '50mb';
// Every session shares the one vault index, so an idle session costs almost nothing.
const SESSION_IDLE_MS = 60 * 60 * 1000;
const HTTP_BAD_REQUEST = 400;
const HTTP_NOT_FOUND = 404;
const HTTP_INTERNAL_ERROR = 500;
const JSONRPC_SERVER_ERROR = -32000;

const USAGE = `Usage: node vault-mcp.js [--http <port>] <vault-path> [more-vault-paths...]

Serves each directory as a vault named after its folder, lower-cased with
non-alphanumeric characters turned into hyphens: "~/Documents/Brain dump"
becomes "brain-dump".

Speaks MCP over stdio, or with --http <port> over Streamable HTTP on
${HTTP_HOST}, one process and one vault index for every session. It has no
authentication of its own, so run it behind auth-server.js.`;

function log(message) {
  // stdout carries the protocol. Anything else goes to stderr or it corrupts
  // the stream and the client drops the connection.
  process.stderr.write(`[vault-mcp] ${message}\n`);
}

function parseArgs(argv) {
  const args = argv.slice(2);
  const at = args.indexOf(HTTP_FLAG);
  const port = at === -1 ? null : Number(args[at + 1]);
  const rest = at === -1 ? args : args.filter((_, i) => i !== at && i !== at + 1);
  return { port, paths: rest.filter((a) => !a.startsWith('-')) };
}

function createServer(vaults, byName) {
  const server = new Server(
    { name: 'obsidian-vault-mcp', version: pkg.version },
    { capabilities: { tools: {} } }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const tool = byName.get(request.params.name);
    if (!tool) {
      throw new McpError(ErrorCode.MethodNotFound, `Unknown tool "${request.params.name}".`);
    }
    const args = request.params.arguments || {};

    try {
      check(tool.inputSchema, args, tool.name);
      return await tool.handler(args, { vaults });
    } catch (err) {
      // Returned as a tool result rather than a JSON-RPC error: the caller can
      // read what went wrong and try again, instead of the client treating the
      // whole request as failed.
      const message = err instanceof McpError ? err.message.replace(/^MCP error -?\d+:\s*/, '') : err.message;
      log(`${tool.name} failed: ${message}`);
      return { content: [{ type: 'text', text: message }], isError: true };
    }
  });

  return server;
}

function rpcError(res, status, message) {
  res.status(status).json({ jsonrpc: '2.0', error: { code: JSONRPC_SERVER_ERROR, message }, id: null });
}

function serveHttp(port, vaults, byName) {
  const sessions = new Map(); // session id -> { transport, timer }

  function touch(id) {
    const session = sessions.get(id);
    if (!session) {
      return;
    }
    clearTimeout(session.timer);
    session.timer = setTimeout(() => session.transport.close(), SESSION_IDLE_MS);
  }

  function drop(id) {
    const session = sessions.get(id);
    if (!session) {
      return;
    }
    clearTimeout(session.timer);
    sessions.delete(id);
  }

  async function open(req, res) {
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (id) => {
        sessions.set(id, { transport, timer: null });
        touch(id);
      },
    });
    transport.onclose = () => {
      if (transport.sessionId) {
        drop(transport.sessionId);
      }
    };
    await createServer(vaults, byName).connect(transport);
    await transport.handleRequest(req, res, req.body);
  }

  const app = express();
  app.use(express.json({ limit: BODY_LIMIT }));
  app.get('/healthz', (_req, res) => res.type('text').send('ok'));

  app.all(MCP_PATH, async (req, res) => {
    const id = req.get(SESSION_HEADER);
    const session = id ? sessions.get(id) : null;

    try {
      if (session) {
        touch(id);
        await session.transport.handleRequest(req, res, req.body);
        return;
      }
      // An unknown id gets 404, which tells the client to start a new session.
      if (id) {
        rpcError(res, HTTP_NOT_FOUND, 'Session not found');
        return;
      }
      if (req.method !== 'POST' || !isInitializeRequest(req.body)) {
        rpcError(res, HTTP_BAD_REQUEST, 'No session: send initialize first');
        return;
      }
      await open(req, res);
    } catch (err) {
      log(`request failed: ${err.message}`);
      if (!res.headersSent) {
        rpcError(res, HTTP_INTERNAL_ERROR, 'Internal error');
      }
    }
  });

  app.listen(port, HTTP_HOST, () => log(`listening on http://${HTTP_HOST}:${port}${MCP_PATH}`));
}

async function main() {
  const { port, paths } = parseArgs(process.argv);
  if (process.argv.includes('--help') || process.argv.includes('-h') || paths.length === 0) {
    process.stderr.write(`${USAGE}\n`);
    process.exit(paths.length === 0 ? 1 : 0);
  }
  if (port !== null && !(Number.isInteger(port) && port > 0)) {
    log(`invalid ${HTTP_FLAG} port`);
    process.exit(1);
  }

  let vaults;
  try {
    vaults = createRegistry(paths);
  } catch (err) {
    log(`cannot start: ${err.message}`);
    process.exit(1);
  }

  const byName = new Map(TOOLS.map((tool) => [tool.name, tool]));
  if (byName.size !== TOOLS.length) {
    log('duplicate tool name in the registry');
    process.exit(1);
  }

  if (port === null) {
    await createServer(vaults, byName).connect(new StdioServerTransport());
  } else {
    serveHttp(port, vaults, byName);
  }
  log(`serving ${vaults.size} vault(s): ${[...vaults.keys()].join(', ')} - ${TOOLS.length} tools`);

  for (const vault of vaults.values()) {
    vault.index().catch((err) => log(`initial index of ${vault.name} failed: ${err.message}`));
  }
}

process.on('unhandledRejection', (err) => log(`unhandled rejection: ${err && err.message}`));

main().catch((err) => {
  log(`fatal: ${err && err.stack ? err.stack : err}`);
  process.exit(1);
});
