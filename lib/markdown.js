'use strict';

// Markdown parsing shared by every tool: frontmatter, tags, links and headings.
//
// Tags and links are only read from prose. Code fences and inline code are
// blanked out first, because a shell snippet full of `#comment` lines would
// otherwise fill the vault's tag index with noise.

const YAML = require('yaml');

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/;

// `present` distinguishes "this note has no frontmatter" from "it has some and
// it does not parse", which are the same null otherwise and mean opposite
// things to a caller about to write.
function splitFrontmatter(content) {
  const match = content.match(FRONTMATTER);
  if (!match) return { present: false, frontmatter: null, raw: '', body: content, offset: 0 };
  return {
    present: true,
    raw: match[1],
    frontmatter: parseYaml(match[1]),
    body: content.slice(match[0].length),
    offset: match[0].length,
  };
}

function parseYaml(raw) {
  try {
    const value = YAML.parse(raw);
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  } catch {
    return null; // malformed frontmatter, reported rather than guessed at
  }
}

// Rewrites only the frontmatter block, leaving the body byte for byte intact.
// Mutating a parsed Document rather than re-stringifying a plain object is what
// keeps the user's comments, key order and quoting style.
function setFrontmatter(content, mutate) {
  const match = content.match(FRONTMATTER);
  const doc = match ? YAML.parseDocument(match[1]) : new YAML.Document({});
  if (!match) doc.contents = doc.createNode({});
  mutate(doc);

  const isEmpty = !doc.contents || (doc.contents.items && doc.contents.items.length === 0);
  const body = match ? content.slice(match[0].length) : content;
  if (isEmpty) return body;

  const yaml = doc.toString({ lineWidth: 0 }).replace(/\n$/, '');
  return `---\n${yaml}\n---\n${match ? body : body.replace(/^\r?\n/, '')}`;
}

// Same length, no content: offsets stay valid for anything computed afterwards.
function blankCode(body) {
  let out = body.replace(/^(\s*)(```+|~~~+)[^\n]*\n[\s\S]*?^\s*\2[^\n]*$/gm, (m) =>
    m.replace(/[^\n]/g, ' ')
  );
  out = out.replace(/`[^`\n]*`/g, (m) => ' '.repeat(m.length));
  return out;
}

// Obsidian requires at least one non-numeric character, so "#1" stays a plain
// number and "#2024/q1" is a tag. Leading punctuation is allowed so tags inside
// brackets or quotes still register.
const TAG = /(^|[\s(\[{'"|>])#([\p{L}\p{N}_/-]*[\p{L}_-][\p{L}\p{N}_/-]*)/gu;

// Offsets are into the body as given, so a caller can splice the original text
// using positions found in the blanked copy.
function inlineTagMatches(body) {
  const found = [];
  const clean = blankCode(body);
  for (const match of clean.matchAll(TAG)) {
    const tag = match[2].replace(/\/+$/, '');
    if (!tag) continue;
    found.push({ tag, index: match.index + match[1].length, length: tag.length + 1 });
  }
  return found;
}

function inlineTags(body) {
  return inlineTagMatches(body).map((m) => m.tag);
}

function frontmatterTags(frontmatter) {
  if (!frontmatter) return [];
  const out = [];
  for (const key of ['tags', 'tag']) {
    const value = frontmatter[key];
    if (!value) continue;
    if (Array.isArray(value)) out.push(...value.filter((t) => typeof t === 'string'));
    else if (typeof value === 'string') out.push(...value.split(/[,\s]+/).filter(Boolean));
  }
  return out.map((t) => t.replace(/^#/, '').replace(/\/+$/, '')).filter(Boolean);
}

const WIKILINK = /(!?)\[\[([^\[\]]+)\]\]/g;
const MDLINK = /(!?)\[([^\]]*)\]\(\s*(<[^>]*>|[^\s)]+)(?:\s+"[^"]*")?\s*\)/g;
const EXTERNAL = /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i;

// Both link syntaxes Obsidian understands. `target` is the raw destination with
// any heading, block reference and alias stripped off, which is what link
// resolution and backlinks need.
function parseLinks(body) {
  const clean = blankCode(body);
  const links = [];

  for (const match of clean.matchAll(WIKILINK)) {
    const inner = match[2];
    const alias = inner.indexOf('|');
    const head = alias === -1 ? inner : inner.slice(0, alias);
    const [target, fragment] = splitFragment(head);
    if (!target) continue; // [[#heading]] points at the same note
    links.push({
      type: 'wikilink',
      embed: match[1] === '!',
      target: target.trim(),
      fragment,
      alias: alias === -1 ? null : inner.slice(alias + 1).trim(),
      index: match.index,
      raw: match[0],
    });
  }

  for (const match of clean.matchAll(MDLINK)) {
    let dest = match[3].replace(/^<|>$/g, '');
    if (EXTERNAL.test(dest)) continue;
    dest = safeDecode(dest);
    const [target, fragment] = splitFragment(dest);
    if (!target) continue;
    links.push({
      type: 'markdown',
      embed: match[1] === '!',
      target: target.trim(),
      fragment,
      alias: match[2] || null,
      index: match.index,
      raw: match[0],
    });
  }

  return links.sort((a, b) => a.index - b.index);
}

// A bare % ("50%off.md") is not an escape; keep the link as written.
function safeDecode(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function splitFragment(value) {
  const hash = value.indexOf('#');
  if (hash === -1) return [value, null];
  return [value.slice(0, hash), value.slice(hash + 1) || null];
}

const HEADING = /^(#{1,6})\s+(.*?)\s*#*\s*$/;

// Line numbers are 1-based and count from the start of the file, frontmatter
// included, so they line up with what an editor shows.
function parseHeadings(content) {
  const { body, offset } = splitFrontmatter(content);
  const frontmatterLines = offset ? content.slice(0, offset).split('\n').length - 1 : 0;
  const clean = blankCode(body);
  const lines = clean.split('\n');
  const bodyLines = body.split('\n');
  const headings = [];

  lines.forEach((line, i) => {
    const match = line.match(HEADING);
    if (!match) return;
    headings.push({
      level: match[1].length,
      // The blanked copy keeps offsets but loses inline code, so read the text
      // back from the original line.
      text: (bodyLines[i].match(HEADING) || [, , match[2]])[2],
      line: frontmatterLines + i + 1,
      bodyLine: i,
    });
  });

  return headings;
}

function stripFrontmatter(content) {
  return splitFrontmatter(content).body;
}

function wordCount(content) {
  const words = stripFrontmatter(content)
    .replace(/```[\s\S]*?```/g, ' ')
    .match(/[\p{L}\p{N}'']+/gu);
  return words ? words.length : 0;
}

// Obsidian normalises a tag by lower-casing and hyphenating word boundaries,
// keeping the hierarchy separators.
function normalizeTag(tag) {
  return tag
    .replace(/^#/, '')
    .split('/')
    .map((part) =>
      part
        .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
        .replace(/[\s_]+/g, '-')
        .replace(/-+/g, '-')
        .replace(/^-|-$/g, '')
        .toLowerCase()
    )
    .filter(Boolean)
    .join('/');
}

module.exports = {
  blankCode,
  frontmatterTags,
  inlineTagMatches,
  inlineTags,
  normalizeTag,
  parseHeadings,
  parseLinks,
  setFrontmatter,
  splitFrontmatter,
  stripFrontmatter,
  wordCount,
};
