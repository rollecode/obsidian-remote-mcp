## Commits and code style

- 2 space indents
- One logical change per commit
- Commit subjects: one line, under 50 characters (GitHub's display limit)
- Use present tense in commits and CHANGELOG.md
- Use sentence case for headings (not Title Case)
- Never use bold text as headings, use proper heading levels instead
- Always add an empty line after headings
- No formatting in CHANGELOG.md except `inline code` and when absolute necessary
- Use `*` as bullets in CHANGELOG.md
- CHANGELOG.md bullets: 2-10 words
- Rationale belongs in code comments or docs, never in commits or CHANGELOG.md
- Real semver: patch = fix/tweak, minor = new capability, major = breaking change. Default to patch
- One version bump per work session, not per commit or per fix
- Never use Claude watermark in commits (FORBIDDEN: "Co-Authored-By")
- No emojis in commits or code
- Keep CHANGELOG.md date up to date when adding entries

## Architecture

- `auth-server.js` is the only security boundary: OAuth 2.1 authorization server plus resource guard, proxying to supergateway on :8420
- Port 8420 has no authentication at all and must never be exposed
- Two credential paths by design: OAuth for Claude.ai, static bearer token for Claude Code
- Tokens and authorization codes are stored as SHA-256 hashes in SQLite
- Single user by design - "authentication" is proving you know one password, there are no accounts

## Security invariants

Do not weaken these without a deliberate decision:

- PKCE `S256` only, never `plain`
- Redirect URIs matched exactly, never by prefix
- Authorization codes single use, deleted on first sight
- Refresh tokens rotate on every use
- Token audience validated against the resource identifier
- Secrets compared with `crypto.timingSafeEqual`
- A bad `client_id` or `redirect_uri` renders an error, never redirects
