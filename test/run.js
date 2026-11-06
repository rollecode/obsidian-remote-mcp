#!/usr/bin/env node
//
// End-to-end test: starts vault-mcp.js over stdio against a throwaway vault and
// exercises every tool through a real MCP client, so the schemas, the dispatch
// and the filesystem behaviour are all covered rather than the handlers alone.
//
// Run with: npm test

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');
const { spawn } = require('child_process');

let passed = 0;
let failed = 0;
const failures = [];

function ok(name) {
  passed += 1;
  process.stdout.write(`  ok    ${name}\n`);
}

function bad(name, err) {
  failed += 1;
  failures.push(`${name}: ${err.message}`);
  process.stdout.write(`  FAIL  ${name}\n        ${err.message.split('\n')[0]}\n`);
}

async function test(name, fn) {
  try {
    await fn();
    ok(name);
  } catch (err) {
    bad(name, err);
  }
}

function buildVault(root) {
  const write = (rel, content) => {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), content);
  };

  write('.obsidian/daily-notes.json', JSON.stringify({ format: '[Log] YYYY-MM-DD', folder: 'Journal' }));
  write('.obsidian/app.json', JSON.stringify({ attachmentFolderPath: 'Assets' }));

  write(
    'Index.md',
    [
      '---',
      'title: Index',
      'tags:',
      '  - hub',
      'status: active',
      '---',
      '',
      '# Index',
      '',
      'Links to [[Alpha]] and [[Projects/Beta|the beta note]] and [Gamma](Projects/Gamma.md).',
      'A broken one: [[Nowhere]].',
      '',
      'Inline tag #project/dude and #hub.',
      '',
      '```',
      '# not a heading, #not-a-tag, [[not-a-link]]',
      '```',
      '',
      '## Tasks',
      '',
      '- [ ] first',
      '',
      '## Notes',
      '',
      'Some text.',
    ].join('\n')
  );

  write('Alpha.md', ['---', 'tags: [project/dude]', '---', '', '# Alpha', '', 'Back to [[Index]].'].join('\n'));
  write('Projects/Beta.md', '# Beta\n\nNothing links out of here except [[Alpha]].\n');
  write('Projects/Gamma.md', '# Gamma\n\nOrphan-ish, linked only from Index.\n');
  write('Loose.md', '# Loose\n\nNothing links here and it links nowhere.\n');
  write('Assets/pixel.png', Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex'));
  write('Assets/data.csv', 'a,b\n1,2\n');
  write(
    'Existing.canvas',
    JSON.stringify(
      {
        nodes: [
          { id: 'n1', type: 'text', text: 'Kept', x: 0, y: 0, width: 400, height: 200, styleAttributes: { shape: 'oval' } },
          { id: 'n2', type: 'file', file: 'Alpha.md', x: 500, y: 0, width: 400, height: 400, styleAttributes: {} },
        ],
        edges: [{ id: 'e1', fromNode: 'n1', fromSide: 'right', toNode: 'n2', toSide: 'left', styleAttributes: {} }],
        metadata: { version: '1.0' },
      },
      null,
      2
    )
  );
}

const textOf = (result) => result.content.map((c) => c.text || `<${c.type}>`).join('\n');

function expectOk(result, label) {
  if (result.isError) throw new Error(`${label} returned an error: ${textOf(result)}`);
  return textOf(result);
}

function expectError(result, label) {
  if (!result.isError) throw new Error(`${label} should have failed but returned: ${textOf(result)}`);
  return textOf(result);
}

function contains(haystack, needle, label) {
  assert.ok(haystack.includes(needle), `${label}: expected to find "${needle}" in:\n${haystack}`);
}

const VAULT_PORT = 18420;
const AUTH_PORT = 18422;
const TEST_TOKEN = 'test-token';
// Well under Node's 5 s keep-alive close, which is what a wrong length waits for.
const PROXY_DEADLINE_MS = 2000;

async function waitForHealth(port) {
  for (let i = 0; i < 50; i++) {
    try {
      if ((await fetch(`http://127.0.0.1:${port}/healthz`)).ok) return;
    } catch {
      // Not listening yet.
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`nothing listening on ${port}`);
}

// vault-mcp.js --http behind auth-server.js, the chain the live service runs.
async function startProxyChain(root, vault) {
  const configDir = path.join(root, 'auth-config');
  fs.mkdirSync(configDir);
  fs.writeFileSync(path.join(configDir, 'token'), TEST_TOKEN);
  const children = [
    spawn(process.execPath, [path.join(__dirname, '..', 'vault-mcp.js'), '--http', String(VAULT_PORT), vault], { stdio: 'ignore' }),
    spawn(process.execPath, [path.join(__dirname, '..', 'auth-server.js')], {
      stdio: 'ignore',
      env: {
        ...process.env,
        PORT: String(AUTH_PORT),
        UPSTREAM: `http://127.0.0.1:${VAULT_PORT}`,
        ISSUER: `http://127.0.0.1:${AUTH_PORT}`,
        DEFAULT_VAULT: 'test-vault',
        CONFIG_DIR: configDir,
      },
    }),
  ];
  await waitForHealth(VAULT_PORT);
  await waitForHealth(AUTH_PORT);
  return () => children.forEach((child) => child.kill());
}

async function proxyPost(body, sessionId) {
  const headers = {
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
    authorization: `Bearer ${TEST_TOKEN}`,
  };
  if (sessionId) headers['mcp-session-id'] = sessionId;
  const res = await fetch(`http://127.0.0.1:${AUTH_PORT}/mcp`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(PROXY_DEADLINE_MS),
  });
  return { res, text: await res.text() };
}

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-mcp-test-'));
  const vault = path.join(root, 'Test Vault');
  fs.mkdirSync(vault);
  buildVault(vault);

  const client = new Client({ name: 'vault-mcp-test', version: '1.0.0' }, { capabilities: {} });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(__dirname, '..', 'vault-mcp.js'), vault],
    stderr: 'pipe',
  });
  await client.connect(transport);

  const call = (name, args = {}) => client.callTool({ name, arguments: args });
  const read = (rel) => fs.readFileSync(path.join(vault, rel), 'utf8');
  const exists = (rel) => fs.existsSync(path.join(vault, rel));

  process.stdout.write('\nTool registry\n');
  const { tools } = await client.listTools();
  await test('every tool advertises a description and an object schema', () => {
    for (const tool of tools) {
      assert.ok(tool.description && tool.description.length > 20, `${tool.name} has no useful description`);
      assert.strictEqual(tool.inputSchema.type, 'object', `${tool.name} schema is not an object`);
      assert.ok(tool.inputSchema.properties, `${tool.name} advertises no properties`);
    }
  });
  await test('every tool but list-available-vaults advertises "vault"', () => {
    // auth-server.js rewrites tools/list to inject DEFAULT_VAULT, and it keys
    // off this property being present.
    for (const tool of tools) {
      if (tool.name === 'list-available-vaults') continue;
      assert.ok(tool.inputSchema.properties.vault, `${tool.name} is missing the vault property`);
    }
  });

  process.stdout.write('\nBrowsing\n');
  await test('list-available-vaults names the vault after its folder', async () => {
    contains(expectOk(await call('list-available-vaults'), 'list-available-vaults'), 'test-vault', 'vault name');
  });
  await test('get-vault-stats counts notes and finds the broken link', async () => {
    const out = expectOk(await call('get-vault-stats'), 'get-vault-stats');
    contains(out, 'Notes            5', 'note count');
    contains(out, '1 broken', 'broken link count');
  });
  await test('list-directory shows folders and files without descending', async () => {
    const out = expectOk(await call('list-directory'), 'list-directory');
    contains(out, 'Projects/', 'subfolder');
    contains(out, 'Index.md', 'root note');
    assert.ok(!out.includes('Beta.md'), 'should not descend into Projects');
    assert.ok(!out.includes('.obsidian'), 'should not list the config folder');
  });
  await test('list-directory recursive reaches nested notes', async () => {
    contains(expectOk(await call('list-directory', { recursive: true }), 'recursive'), 'Projects/Beta.md', 'nested note');
  });
  await test('list-notes filters by tag, parents matching children', async () => {
    const out = expectOk(await call('list-notes', { tag: 'project' }), 'list-notes');
    contains(out, 'Index.md', 'Index has #project/dude');
    contains(out, 'Alpha.md', 'Alpha has project/dude in frontmatter');
    assert.ok(!out.includes('Loose.md'), 'Loose has no tags');
  });
  await test('get-recent-notes returns newest first', async () => {
    contains(expectOk(await call('get-recent-notes', { limit: 3 }), 'get-recent-notes'), '.md', 'some note');
  });

  process.stdout.write('\nReading\n');
  await test('read-note returns the raw markdown including frontmatter', async () => {
    const out = expectOk(await call('read-note', { path: 'Index.md' }), 'read-note');
    contains(out, 'title: Index', 'frontmatter');
    contains(out, '## Tasks', 'body');
  });
  await test('read-note accepts upstream filename + folder', async () => {
    contains(expectOk(await call('read-note', { filename: 'Beta.md', folder: 'Projects' }), 'read-note'), '# Beta', 'body');
  });
  await test('read-note adds line numbers on request', async () => {
    contains(expectOk(await call('read-note', { path: 'Alpha.md', withLineNumbers: true }), 'read-note'), '    1  ---', 'line 1');
  });
  await test('read-notes reports a missing note without failing the batch', async () => {
    const out = expectOk(await call('read-notes', { paths: ['Alpha.md', 'Ghost.md'] }), 'read-notes');
    contains(out, '# Alpha', 'existing note');
    contains(out, '[not found]', 'missing note');
  });
  await test('get-note-outline lists headings with line numbers', async () => {
    const out = expectOk(await call('get-note-outline', { path: 'Index.md' }), 'get-note-outline');
    contains(out, '# Index', 'h1');
    contains(out, '## Tasks', 'h2');
    assert.ok(!out.includes('not a heading'), 'a heading inside a code fence is not a heading');
  });

  process.stdout.write('\nWriting\n');
  await test('create-note writes frontmatter from an object', async () => {
    expectOk(await call('create-note', { path: 'New/Made.md', content: '# Made\n', frontmatter: { status: 'draft', tags: ['new'] } }), 'create-note');
    const body = read('New/Made.md');
    contains(body, 'status: draft', 'frontmatter key');
    contains(body, '# Made', 'body');
  });
  await test('create-note refuses to clobber without overwrite', async () => {
    contains(expectError(await call('create-note', { path: 'New/Made.md', content: 'x' }), 'create-note'), 'already exists', 'refusal');
  });
  await test('edit-note appends without swallowing the newline', async () => {
    expectOk(await call('edit-note', { path: 'New/Made.md', operation: 'append', content: 'appended line' }), 'edit-note');
    contains(read('New/Made.md'), '# Made\nappended line', 'appended');
  });
  await test('edit-note replace reports "replaced", not "replaceed"', async () => {
    const out = expectOk(await call('edit-note', { path: 'New/Made.md', operation: 'replace', content: 'fresh' }), 'edit-note');
    contains(out, 'Replaced', 'message');
    assert.strictEqual(read('New/Made.md'), 'fresh');
  });
  await test('edit-note rejects a missing content argument', async () => {
    contains(expectError(await call('edit-note', { path: 'New/Made.md', operation: 'append' }), 'edit-note'), 'required', 'message');
  });
  await test('patch-note appends inside a section, not at the end of the note', async () => {
    expectOk(await call('patch-note', { path: 'Index.md', heading: 'Tasks', operation: 'append', content: '- [ ] second' }), 'patch-note');
    const body = read('Index.md');
    const tasks = body.indexOf('- [ ] second');
    const notes = body.indexOf('## Notes');
    assert.ok(tasks !== -1 && tasks < notes, 'the new task must land before the next heading');
  });
  await test('patch-note prepend puts content straight after the heading', async () => {
    expectOk(await call('patch-note', { path: 'Index.md', heading: 'Notes', operation: 'prepend', content: 'lead in' }), 'patch-note');
    contains(read('Index.md'), '## Notes\nlead in', 'prepended');
  });
  await test('patch-note names the available headings when one is missing', async () => {
    const out = expectError(await call('patch-note', { path: 'Index.md', heading: 'Nope', operation: 'append', content: 'x' }), 'patch-note');
    contains(out, '## Tasks', 'lists real headings');
  });
  await test('patch-note remove drops the heading and its body', async () => {
    expectOk(await call('create-note', { path: 'Sections.md', content: '# A\n\nbody a\n\n## B\n\nbody b\n\n# C\n\nbody c\n' }), 'create-note');
    expectOk(await call('patch-note', { path: 'Sections.md', heading: 'A', operation: 'remove' }), 'patch-note');
    const body = read('Sections.md');
    assert.ok(!body.includes('body a'), 'section body gone');
    assert.ok(!body.includes('body b'), 'nested subsection gone with it');
    contains(body, '# C', 'the next same-level heading survives');
  });
  await test('replace-in-note replaces every occurrence and reports the count', async () => {
    expectOk(await call('create-note', { path: 'Repeat.md', content: 'foo foo foo\n' }), 'create-note');
    contains(expectOk(await call('replace-in-note', { path: 'Repeat.md', find: 'foo', replace: 'bar' }), 'replace'), '3 occurrences', 'count');
    assert.strictEqual(read('Repeat.md'), 'bar bar bar\n');
  });
  await test('replace-in-note says so when nothing matched', async () => {
    contains(expectOk(await call('replace-in-note', { path: 'Repeat.md', find: 'zzz', replace: 'x' }), 'replace'), 'No match', 'message');
  });
  await test('replace-in-note treats the pattern literally unless regex is set', async () => {
    expectOk(await call('create-note', { path: 'Dots.md', content: 'a.c abc\n' }), 'create-note');
    expectOk(await call('replace-in-note', { path: 'Dots.md', find: 'a.c', replace: 'X' }), 'replace');
    assert.strictEqual(read('Dots.md'), 'X abc\n');
  });

  process.stdout.write('\nFrontmatter\n');
  await test('update-frontmatter sets and removes keys, keeping the body', async () => {
    expectOk(await call('update-frontmatter', { path: 'Index.md', set: { status: 'done', reviewed: '2026-08-20' }, remove: ['title'] }), 'update-frontmatter');
    const body = read('Index.md');
    contains(body, 'status: done', 'set');
    contains(body, 'reviewed:', 'added');
    assert.ok(!body.includes('title: Index'), 'removed');
    contains(body, '## Notes', 'body untouched');
  });
  await test('update-frontmatter creates the block on a note without one', async () => {
    expectOk(await call('update-frontmatter', { path: 'Loose.md', set: { kind: 'note' } }), 'update-frontmatter');
    assert.ok(read('Loose.md').startsWith('---\nkind: note\n---\n'), `unexpected: ${JSON.stringify(read('Loose.md'))}`);
  });

  process.stdout.write('\nTags\n');
  await test('add-tags merges into the frontmatter list without duplicating', async () => {
    expectOk(await call('add-tags', { files: ['Alpha.md'], tags: ['project/dude', 'review'] }), 'add-tags');
    const body = read('Alpha.md');
    assert.strictEqual((body.match(/project\/dude/g) || []).length, 1, 'existing tag not duplicated');
    contains(body, 'review', 'new tag added');
  });
  await test('add-tags can write inline tags too', async () => {
    expectOk(await call('add-tags', { files: ['Projects/Beta.md'], tags: ['inline-test'], location: 'content' }), 'add-tags');
    contains(read('Projects/Beta.md'), '#inline-test', 'inline tag');
  });
  await test('add-tags rejects a tag with a # or a space', async () => {
    contains(expectError(await call('add-tags', { files: ['Alpha.md'], tags: ['#bad tag'] }), 'add-tags'), 'not a usable tag', 'message');
  });
  await test('list-tags counts notes per tag', async () => {
    const out = expectOk(await call('list-tags'), 'list-tags');
    contains(out, '#project/dude', 'hierarchical tag');
    contains(out, '#hub', 'tag from both frontmatter and inline, counted once');
    assert.ok(!out.includes('not-a-tag'), 'a tag inside a code fence is not a tag');
  });
  await test('remove-tags takes the hierarchy with it', async () => {
    expectOk(await call('remove-tags', { files: ['Alpha.md'], tags: ['project'] }), 'remove-tags');
    assert.ok(!read('Alpha.md').includes('project/dude'), 'child tag removed with its parent');
  });
  await test('rename-tag rewrites frontmatter and inline occurrences vault-wide', async () => {
    const out = expectOk(await call('rename-tag', { oldTag: 'project', newTag: 'work' }), 'rename-tag');
    contains(out, 'Renamed #project to #work', 'message');
    contains(read('Index.md'), '#work/dude', 'inline tag renamed with its hierarchy');
  });

  process.stdout.write('\nLinks\n');
  await test('get-backlinks finds both wikilinks and markdown links', async () => {
    contains(expectOk(await call('get-backlinks', { path: 'Alpha.md' }), 'get-backlinks'), 'Index.md', 'wikilink source');
    contains(expectOk(await call('get-backlinks', { path: 'Projects/Gamma.md' }), 'get-backlinks'), 'Index.md', 'markdown link source');
  });
  await test('get-backlinks says so when nothing links in', async () => {
    contains(expectOk(await call('get-backlinks', { path: 'Loose.md' }), 'get-backlinks'), 'Nothing links to', 'message');
  });
  await test('get-outgoing-links marks the unresolvable one as broken', async () => {
    const out = expectOk(await call('get-outgoing-links', { path: 'Index.md' }), 'get-outgoing-links');
    contains(out, 'Alpha.md', 'resolved');
    contains(out, 'BROKEN', 'unresolved');
    assert.ok(!out.includes('not-a-link'), 'a link inside a code fence is not a link');
  });
  await test('find-broken-links finds exactly the planted one', async () => {
    const out = expectOk(await call('find-broken-links'), 'find-broken-links');
    contains(out, 'Nowhere', 'the broken target');
    contains(out, '1 broken link', 'count');
  });
  await test('find-orphaned-notes lists notes nothing links to', async () => {
    const out = expectOk(await call('find-orphaned-notes'), 'find-orphaned-notes');
    contains(out, 'Loose.md', 'orphan');
    assert.ok(!out.includes('Alpha.md'), 'Alpha is linked from Index');
  });

  process.stdout.write('\nMoving\n');
  await test('move-note leaves a short link alone when it still resolves', async () => {
    const out = expectOk(await call('move-note', { source: 'Alpha.md', destination: 'Archive/Alpha.md' }), 'move-note');
    contains(out, '2 notes link to it', 'both Index and Beta linked to Alpha');
    contains(out, 'none needed rewriting', 'a bare [[Alpha]] still resolves after the move');
    contains(read('Index.md'), '[[Alpha]]', 'link text untouched');
    assert.ok(exists('Archive/Alpha.md'), 'file moved');
  });
  await test('move-note switches to a full path when the basename stops being unique', async () => {
    expectOk(await call('create-note', { path: 'Duplicate.md', content: '# One\n' }), 'create-note');
    expectOk(await call('create-note', { path: 'Refs.md', content: 'See [[Duplicate]].\n' }), 'create-note');
    expectOk(await call('create-note', { path: 'Other/Duplicate.md', content: '# Two\n' }), 'create-note');
    expectOk(await call('move-note', { source: 'Duplicate.md', destination: 'Moved/Duplicate.md' }), 'move-note');
    contains(read('Refs.md'), '[[Moved/Duplicate]]', 'ambiguous basename forces the full path');
  });
  await test('move-note preserves an alias and a heading fragment', async () => {
    expectOk(await call('create-note', { path: 'Aliased.md', content: 'See [[Target#Part|the part]].\n' }), 'create-note');
    expectOk(await call('create-note', { path: 'Target.md', content: '# Target\n\n## Part\n' }), 'create-note');
    expectOk(await call('move-note', { source: 'Target.md', destination: 'Deep/Nest/Target.md' }), 'move-note');
    contains(read('Aliased.md'), '[[Target#Part|the part]]', 'alias and fragment survive');
  });
  await test('copy-note leaves the original in place', async () => {
    expectOk(await call('copy-note', { source: 'Loose.md', destination: 'Copy of Loose.md' }), 'copy-note');
    assert.ok(exists('Loose.md') && exists('Copy of Loose.md'), 'both present');
  });
  await test('move-directory moves everything and rewrites links once per note', async () => {
    const out = expectOk(await call('move-directory', { source: 'Projects', destination: 'Work/Projects' }), 'move-directory');
    contains(out, '2 files', 'Beta and Gamma');
    assert.ok(exists('Work/Projects/Beta.md'), 'moved');
    contains(read('Index.md'), 'Work/Projects/Gamma.md', 'the markdown link was repointed');
  });
  await test('move-directory refuses to move a folder into itself', async () => {
    contains(expectError(await call('move-directory', { source: 'Work', destination: 'Work/Inner' }), 'move-directory'), 'inside itself', 'message');
  });

  process.stdout.write('\nCanvas\n');
  await test('create-canvas lays out nodes and wires edges by caller-chosen ids', async () => {
    const out = expectOk(
      await call('create-canvas', {
        path: 'Maps/Flow.canvas',
        nodes: [
          { id: 'a', type: 'text', text: 'Start' },
          { id: 'b', type: 'file', file: 'Index.md' },
          { id: 'c', type: 'link', url: 'https://obsidian.md' },
        ],
        edges: [{ from: 'a', to: 'b', label: 'then' }, { from: 'b', to: 'c' }],
      }),
      'create-canvas'
    );
    contains(out, '3 nodes and 2 edges', 'summary');
    const canvas = JSON.parse(read('Maps/Flow.canvas'));
    assert.strictEqual(canvas.nodes.length, 3);
    for (const node of canvas.nodes) {
      for (const key of ['id', 'type', 'x', 'y', 'width', 'height']) {
        assert.ok(node[key] !== undefined, `node ${node.id} is missing ${key}`);
      }
    }
    const positions = new Set(canvas.nodes.map((n) => `${n.x},${n.y}`));
    assert.strictEqual(positions.size, 3, 'auto-layout must not stack nodes on top of each other');
    for (const edge of canvas.edges) {
      assert.ok(edge.fromSide && edge.toSide, 'edges need sides so Obsidian renders them tidily');
    }
  });
  await test('create-canvas from notes derives edges from the vault graph', async () => {
    const out = expectOk(
      await call('create-canvas', { path: 'Maps/Graph.canvas', fromNotes: ['Index.md', 'Archive/Alpha.md'], linkEdges: true }),
      'create-canvas'
    );
    contains(out, '2 nodes', 'both notes');
    const canvas = JSON.parse(read('Maps/Graph.canvas'));
    assert.ok(canvas.edges.length >= 1, 'Index links to Alpha, so there should be an edge');
  });
  await test('create-canvas warns about file nodes pointing nowhere', async () => {
    const out = expectOk(await call('create-canvas', { path: 'Maps/Missing.canvas', nodes: [{ type: 'file', file: 'Ghost.md' }] }), 'create-canvas');
    contains(out, 'do not exist yet', 'warning');
  });
  await test('create-canvas rejects an edge naming an unknown node', async () => {
    const out = expectError(
      await call('create-canvas', { path: 'Maps/Bad.canvas', nodes: [{ id: 'a', type: 'text', text: 'x' }], edges: [{ from: 'a', to: 'ghost' }] }),
      'create-canvas'
    );
    contains(out, 'does not match any node', 'message');
    assert.ok(!exists('Maps/Bad.canvas'), 'nothing written on failure');
  });
  await test('read-canvas summarises ids, types and edges', async () => {
    const out = expectOk(await call('read-canvas', { path: 'Existing.canvas' }), 'read-canvas');
    contains(out, 'n1', 'node id');
    contains(out, 'Kept', 'text content');
    contains(out, 'n1 (right) -> n2 (left)', 'edge');
  });
  await test('read-canvas raw returns the file itself', async () => {
    contains(expectOk(await call('read-canvas', { path: 'Existing.canvas', raw: true }), 'read-canvas'), '"styleAttributes"', 'raw json');
  });
  await test('edit-canvas applies operations in order and keeps Obsidian-only fields', async () => {
    expectOk(
      await call('edit-canvas', {
        path: 'Existing.canvas',
        operations: [
          { op: 'add-node', node: { id: 'n3', type: 'text', text: 'Added' } },
          { op: 'add-edge', edge: { from: 'n2', to: 'n3', label: 'next' } },
          { op: 'update-node', id: 'n1', node: { text: 'Renamed', color: '4' } },
        ],
      }),
      'edit-canvas'
    );
    const canvas = JSON.parse(read('Existing.canvas'));
    assert.strictEqual(canvas.nodes.length, 3);
    assert.strictEqual(canvas.edges.length, 2);
    assert.deepStrictEqual(canvas.metadata, { version: '1.0' }, 'top-level metadata preserved');
    const n1 = canvas.nodes.find((n) => n.id === 'n1');
    assert.strictEqual(n1.text, 'Renamed');
    assert.strictEqual(n1.color, '4');
    assert.deepStrictEqual(n1.styleAttributes, { shape: 'oval' }, 'unknown node fields preserved through an update');
  });
  await test('edit-canvas remove-node takes its edges with it', async () => {
    expectOk(await call('edit-canvas', { path: 'Existing.canvas', operations: [{ op: 'remove-node', id: 'n2' }] }), 'edit-canvas');
    const canvas = JSON.parse(read('Existing.canvas'));
    assert.strictEqual(canvas.nodes.length, 2);
    assert.strictEqual(canvas.edges.length, 0, 'both edges touched n2');
  });
  await test('edit-canvas writes nothing when an operation fails', async () => {
    const before = read('Existing.canvas');
    const out = expectError(
      await call('edit-canvas', {
        path: 'Existing.canvas',
        operations: [{ op: 'add-node', node: { id: 'n9', type: 'text', text: 'ok' } }, { op: 'remove-node', id: 'ghost' }],
      }),
      'edit-canvas'
    );
    contains(out, 'Nothing was written', 'message');
    assert.strictEqual(read('Existing.canvas'), before, 'file untouched');
  });
  await test('edit-canvas layout re-flows every node', async () => {
    expectOk(await call('edit-canvas', { path: 'Maps/Flow.canvas', operations: [{ op: 'layout', mode: 'column' }] }), 'edit-canvas');
    const canvas = JSON.parse(read('Maps/Flow.canvas'));
    assert.strictEqual(new Set(canvas.nodes.map((n) => n.x)).size, 1, 'a column shares one x');
  });
  await test('create-canvas rejects a colour that is neither a preset nor hex', async () => {
    contains(
      expectError(await call('create-canvas', { path: 'Maps/Colour.canvas', nodes: [{ type: 'text', text: 'x', color: 'red' }] }), 'create-canvas'),
      'preset',
      'message'
    );
  });
  await test('list-canvases finds every .canvas', async () => {
    const out = expectOk(await call('list-canvases'), 'list-canvases');
    contains(out, 'Existing.canvas', 'root canvas');
    contains(out, 'Maps/Flow.canvas', 'nested canvas');
  });
  await test('move-note works on a canvas', async () => {
    expectOk(await call('move-note', { source: 'Existing.canvas', destination: 'Maps/Existing.canvas' }), 'move-note');
    assert.ok(exists('Maps/Existing.canvas'), 'moved');
  });

  process.stdout.write('\nSearch\n');
  await test('search-vault finds content and reports the line', async () => {
    const out = expectOk(await call('search-vault', { query: 'Orphan-ish' }), 'search-vault');
    contains(out, 'Gamma.md', 'the note');
    contains(out, 'Orphan-ish', 'the matching line');
  });
  await test('search-vault supports the tag: shorthand', async () => {
    contains(expectOk(await call('search-vault', { query: 'tag:hub' }), 'search-vault'), 'Index.md', 'tagged note');
  });
  await test('search-vault filters by frontmatter property', async () => {
    const out = expectOk(await call('search-vault', { frontmatter: { status: 'done' } }), 'search-vault');
    contains(out, 'Index.md', 'matching note');
    assert.ok(!out.includes('Loose.md'), 'non-matching note excluded');
  });
  await test('search-vault takes filters with no query at all', async () => {
    contains(expectOk(await call('search-vault', { folder: 'Work' }), 'search-vault'), 'Work/Projects', 'folder filter');
  });
  await test('search-vault supports regex', async () => {
    contains(expectOk(await call('search-vault', { query: 'Orphan-\\w+', regex: true }), 'search-vault'), 'Gamma.md', 'regex hit');
  });
  await test('search-vault reports an unusable regex rather than throwing', async () => {
    contains(expectError(await call('search-vault', { query: '[unclosed', regex: true }), 'search-vault'), 'Invalid regular expression', 'message');
  });
  await test('search-vault insists on a query or a filter', async () => {
    contains(expectError(await call('search-vault', {}), 'search-vault'), 'at least one filter', 'message');
  });

  process.stdout.write('\nDaily notes\n');
  await test('get-daily-note honours the vault daily-notes format and folder', async () => {
    const out = expectError(await call('get-daily-note'), 'get-daily-note');
    contains(out, '[Log] YYYY-MM-DD', 'the configured format is reported');
    contains(out, 'Journal', 'the configured folder');
  });
  await test('append-to-daily-note creates the note at the configured path', async () => {
    expectOk(await call('append-to-daily-note', { content: 'first entry' }), 'append');
    const stamp = new Date();
    const name = `Log ${stamp.getFullYear()}-${String(stamp.getMonth() + 1).padStart(2, '0')}-${String(stamp.getDate()).padStart(2, '0')}.md`;
    assert.ok(exists(path.posix.join('Journal', name)), `expected Journal/${name}`);
    contains(read(path.posix.join('Journal', name)), 'first entry', 'content');
  });
  await test('append-to-daily-note creates a heading and appends under it', async () => {
    expectOk(await call('append-to-daily-note', { content: 'under heading', heading: 'Done' }), 'append');
    expectOk(await call('append-to-daily-note', { content: 'also under heading', heading: 'Done' }), 'append');
    const stamp = new Date();
    const name = `Log ${stamp.getFullYear()}-${String(stamp.getMonth() + 1).padStart(2, '0')}-${String(stamp.getDate()).padStart(2, '0')}.md`;
    const body = read(path.posix.join('Journal', name));
    assert.strictEqual((body.match(/## Done/g) || []).length, 1, 'the heading is created once, not twice');
    contains(body, 'also under heading', 'second append');
  });
  await test('get-daily-note accepts a relative date', async () => {
    contains(expectError(await call('get-daily-note', { date: '-30' }), 'get-daily-note'), 'No daily note at Journal/Log', 'resolved path');
  });
  await test('get-daily-note rejects an unparseable date', async () => {
    contains(expectError(await call('get-daily-note', { date: 'last tuesday' }), 'get-daily-note'), 'Unrecognised date', 'message');
  });

  process.stdout.write('\nAttachments\n');
  await test('list-attachments excludes markdown and canvases', async () => {
    const out = expectOk(await call('list-attachments'), 'list-attachments');
    contains(out, 'Assets/pixel.png', 'image');
    contains(out, 'Assets/data.csv', 'csv');
    assert.ok(!out.includes('.md'), 'no notes');
    assert.ok(!out.includes('.canvas'), 'no canvases');
  });
  await test('read-attachment returns an image as image content', async () => {
    const result = await call('read-attachment', { path: 'Assets/pixel.png' });
    assert.ok(!result.isError, textOf(result));
    const image = result.content.find((c) => c.type === 'image');
    assert.ok(image, 'expected an image content block');
    assert.strictEqual(image.mimeType, 'image/png');
  });
  await test('read-attachment returns a csv as text', async () => {
    contains(expectOk(await call('read-attachment', { path: 'Assets/data.csv' }), 'read-attachment'), 'a,b', 'contents');
  });

  process.stdout.write('\nDeleting\n');
  await test('delete-note moves the note to .trash by default', async () => {
    expectOk(await call('delete-note', { path: 'Copy of Loose.md' }), 'delete-note');
    assert.ok(!exists('Copy of Loose.md'), 'gone from the vault');
    assert.ok(exists('.trash/Copy of Loose.md'), 'recoverable from .trash');
  });
  await test('delete-note permanent leaves nothing behind', async () => {
    expectOk(await call('create-note', { path: 'Temp.md', content: 'x' }), 'create-note');
    expectOk(await call('delete-note', { path: 'Temp.md', permanent: true }), 'delete-note');
    assert.ok(!exists('Temp.md') && !exists('.trash/Temp.md'), 'really gone');
  });
  await test('delete-directory trashes the whole folder', async () => {
    expectOk(await call('create-directory', { path: 'Scratch/Deep' }), 'create-directory');
    expectOk(await call('create-note', { path: 'Scratch/Deep/x.md', content: 'x' }), 'create-note');
    expectOk(await call('delete-directory', { path: 'Scratch' }), 'delete-directory');
    assert.ok(!exists('Scratch'), 'gone');
    assert.ok(exists('.trash/Scratch/Deep/x.md'), 'recoverable');
  });

  process.stdout.write('\nSafety\n');
  await test('a path escaping the vault is refused', async () => {
    contains(expectError(await call('read-note', { path: '../../../etc/passwd' }), 'read-note'), 'escapes the vault', 'message');
  });
  await test('an absolute path in filename is refused', async () => {
    contains(expectError(await call('create-note', { filename: '/etc/evil.md', content: 'x' }), 'create-note'), 'must not be an absolute path', 'message');
  });
  await test('writing into .obsidian is refused', async () => {
    contains(expectError(await call('create-note', { path: '.obsidian/app.json' }), 'create-note'), 'read-only', 'message');
    assert.strictEqual(JSON.parse(read('.obsidian/app.json')).attachmentFolderPath, 'Assets', 'config intact');
  });
  await test('a symlink pointing out of the vault cannot be written through', async () => {
    fs.symlinkSync(os.tmpdir(), path.join(vault, 'escape'));
    contains(expectError(await call('create-note', { path: 'escape/evil.md', content: 'x' }), 'create-note'), 'escapes the vault', 'message');
  });
  await test('a missing required argument is reported by name', async () => {
    contains(expectError(await call('read-notes', {}), 'read-notes'), '"paths" is required', 'message');
  });
  await test('a wrongly typed argument is reported with both types', async () => {
    contains(expectError(await call('read-notes', { paths: 'Alpha.md' }), 'read-notes'), 'must be a array', 'message');
  });
  await test('an unknown tool is a protocol error', async () => {
    await assert.rejects(() => call('no-such-tool'), /Unknown tool/);
  });
  await test('a missing note is reported, not thrown', async () => {
    contains(expectError(await call('read-note', { path: 'Ghost.md' }), 'read-note'), 'No such note', 'message');
  });

  process.stdout.write('\nAuth proxy\n');
  const stopProxy = await startProxyChain(root, vault);
  await test('tools/list through the auth server arrives whole and on time', async () => {
    const init = await proxyPost({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } },
    });
    const sessionId = init.res.headers.get('mcp-session-id');
    assert.ok(sessionId, 'initialize returned no session');
    const { res, text } = await proxyPost({ jsonrpc: '2.0', id: 2, method: 'tools/list' }, sessionId);
    const length = res.headers.get('content-length');
    if (length) assert.strictEqual(Number(length), Buffer.byteLength(text), 'content-length does not match the body');
    contains(text, 'Defaults to \\"test-vault\\"', 'vault default');
  });
  stopProxy();

  await client.close();

  process.stdout.write(`\n${passed} passed, ${failed} failed\n`);
  if (failed) {
    process.stdout.write(`\nFailures:\n${failures.map((f) => `  - ${f}`).join('\n')}\n`);
    process.stdout.write(`\nVault kept for inspection: ${vault}\n`);
    process.exit(1);
  }
  fs.rmSync(root, { recursive: true, force: true });
}

main().catch((err) => {
  process.stderr.write(`${err.stack}\n`);
  process.exit(1);
});
