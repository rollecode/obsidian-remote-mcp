#!/usr/bin/env node
// Two defects in obsidian-mcp's edit-note tool.
//
// 1. Its schema is a zod discriminatedUnion, and createSchemaHandler keeps only
//    type/properties/required from the converted output. A union has none of
//    those at the top level, so the tool advertises an object with no
//    properties at all. Its parameters are then discoverable only from the
//    prose in the description, and a strict client may refuse to call it.
//    Parsing still uses the union, so the delete operation keeps working; only
//    the advertised schema is replaced.
//
// 2. The success message is built as `Note ${operation}ed successfully`, which
//    reads "Note replaceed successfully" for the replace operation.
//
// Idempotent, and loud if upstream changes shape rather than silently doing
// nothing.
const fs = require('fs');
const path = require('path');

const TARGET = path.join(__dirname, '..', 'node_modules', 'obsidian-mcp', 'build', 'main.js');

const SCHEMA_MARKER = 'var EDIT_NOTE_INPUT_SCHEMA =';

const SCHEMA_FROM = `function createEditNoteTool(vaults) {
  return createTool({`;

const SCHEMA_TO = `var EDIT_NOTE_INPUT_SCHEMA = {
  type: "object",
  properties: {
    vault: { type: "string", minLength: 1, description: "Name of the vault containing the note" },
    filename: { type: "string", minLength: 1, description: "Just the note name without any path separators (e.g. 'my-note.md', NOT 'folder/my-note.md')" },
    folder: { type: "string", description: "Optional subfolder path relative to vault root (e.g. 'journal/2024')" },
    operation: { type: "string", enum: ["append", "prepend", "replace", "delete"], description: "append adds to the end, prepend adds to the start, replace overwrites the whole note, delete removes it" },
    content: { type: "string", minLength: 1, description: "Content to append, prepend or replace with. Required for every operation except delete" }
  },
  required: ["vault", "filename", "operation"]
};
function createEditNoteTool(vaults) {
  const tool = createTool({`;

// Anchored on schema2, which only edit-note uses. The closing lines on their
// own are shared by every tool in the bundle, so replacing those would land on
// whichever tool happens to come first.
const RETURN_FROM = `    schema: schema2,
    handler: async (args, vaultPath, _vaultName) => {
      const result = await editNote(vaultPath, args.filename, args.operation, "content" in args ? args.content : undefined, args.folder);
      return createToolResponse(formatFileResult(result));
    }
  }, vaults);
}`;

const RETURN_TO = `    schema: schema2,
    handler: async (args, vaultPath, _vaultName) => {
      const result = await editNote(vaultPath, args.filename, args.operation, "content" in args ? args.content : undefined, args.folder);
      return createToolResponse(formatFileResult(result));
    }
  }, vaults);
  tool.inputSchema = { ...tool.inputSchema, jsonSchema: EDIT_NOTE_INPUT_SCHEMA };
  return tool;
}`;

const TYPO_FROM = 'message: `Note ${operation}ed successfully`,';
const TYPO_TO = 'message: `Note ${operation === "replace" ? "replaced" : operation + "ed"} successfully`,';

if (!fs.existsSync(TARGET)) {
  console.error(`fix-edit-note: ${TARGET} not found`);
  process.exit(1);
}

let source = fs.readFileSync(TARGET, 'utf8');
let changed = false;

// Every anchor must match exactly once. A pattern that appears twice would
// otherwise be replaced in whichever tool comes first and quietly break it.
function occurrences(haystack, needle) {
  return haystack.split(needle).length - 1;
}

function requireUnique(needle, label) {
  const n = occurrences(source, needle);
  if (n !== 1) {
    console.error(`fix-edit-note: ${label} matches ${n} times, expected exactly 1. Refusing to patch.`);
    process.exit(1);
  }
}

if (source.includes(SCHEMA_MARKER)) {
  console.log('fix-edit-note: schema already applied');
} else if (source.includes(SCHEMA_FROM) && source.includes(RETURN_FROM)) {
  requireUnique(SCHEMA_FROM, 'tool opening');
  requireUnique(RETURN_FROM, 'tool body');
  source = source.replace(SCHEMA_FROM, SCHEMA_TO).replace(RETURN_FROM, RETURN_TO);
  changed = true;
  console.log('fix-edit-note: edit-note now advertises its parameters');
} else {
  console.error('fix-edit-note: edit-note tool not in the expected shape, check obsidian-mcp before shipping');
  process.exit(1);
}

if (source.includes(TYPO_TO)) {
  console.log('fix-edit-note: message already applied');
} else if (source.includes(TYPO_FROM)) {
  requireUnique(TYPO_FROM, 'success message');
  source = source.replace(TYPO_FROM, TYPO_TO);
  changed = true;
  console.log('fix-edit-note: replace no longer reports "replaceed"');
} else {
  console.error('fix-edit-note: success message not in the expected shape');
  process.exit(1);
}

if (changed) fs.writeFileSync(TARGET, source);
