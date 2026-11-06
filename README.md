<center align="center" style="text-align: center;justify-content:center;">
<div align="center" style="text-align: center;justify-content:center;">
<h1 align="center" style="text-align: center;justify-content:center;">

Obsidian remote MCP server

<img style="justify-content:center;text-align: center;width: 95px; height: auto;" width="793" height="411" alt="image" src="https://github.com/user-attachments/assets/abed1a04-d69b-4ab4-a490-d606064df72d" />
<img style="justify-content:center;text-align: center;width: 250px; height: auto;" alt="image" src="https://github.com/user-attachments/assets/334c2e4d-d56d-4462-89bb-3443195ef68d" />

</h1>


![Version](https://img.shields.io/badge/version-1.5.0-blue.svg?style=for-the-badge) ![Node](https://img.shields.io/badge/Node.js-339933?style=for-the-badge&logo=node.js&logoColor=white) ![OAuth](https://img.shields.io/badge/OAuth_2.1-EB5424?style=for-the-badge&logo=auth0&logoColor=white)

</div>
</center>

<hr>

Reach your Obsidian vault from anywhere, in Claude.ai and Claude Code, without Obsidian running and without the vault on the machine you are working from. A vault server that reads and writes the files directly - notes, properties, tags, links, canvases and attachments - behind an OAuth 2.1 authorization server, so it can be added as a Claude.ai custom connector while static bearer tokens keep working for Claude Code.

<hr>

> [!WARNING]
> Using this server with a paid AI service costs money. Tool definitions and results are billed as input tokens, and an agent can call tools repeatedly on its own. You are responsible for every charge, so set spending limits with your provider. The author accepts no liability for any costs. See [DISCLAIMER.md](DISCLAIMER.md).

## Requirements

- An always-on Linux machine, such as a home server, a NAS or a VPS
- Your vault synced to it with [Obsidian Sync](https://obsidian.md/help/sync) via [Headless Sync](https://obsidian.md/help/sync/headless), [Syncthing](https://github.com/syncthing/syncthing), [Obsidian Git](https://github.com/Vinzent03/obsidian-git) or [Nextcloud](https://github.com/nextcloud/desktop)
- Node.js 18 or newer
- An HTTPS reverse proxy or tunnel

## Features

- Read and write your vault from Claude.ai and Claude Code
- 36 tools covering notes, headings, properties, tags, links, folders, search, canvases, daily notes and attachments
- Full Obsidian canvas support: create, read and edit `.canvas` files, with automatic layout
- Moves and renames rewrite the links that pointed at the note, wikilink and markdown alike
- OAuth 2.1 with PKCE, dynamic client registration, and refresh token rotation
- Static bearer token accepted alongside OAuth, so both clients work at once
- Works with Obsidian closed - the vault is read from disk, no plugins needed
- Serves multiple vaults from one endpoint
- No inbound firewall port needed when paired with a Cloudflare Tunnel

## How it works

```
vault-mcp.js --http       reads and writes the vault, :8420
  -> auth-server.js        OAuth 2.1 + token check, :8422
  -> nginx                 :8421
  -> Cloudflare Tunnel     https://obsidian-mcp.example.com
```

Only the auth server is reachable from outside. Port 8420 speaks no authentication at all, so the vault server binds 127.0.0.1 and the unit adds `IPAddressDeny=any` and `IPAddressAllow=localhost` on top. One process serves every session from one shared vault index.

Claude.ai custom connectors accept OAuth or, in a beta not everyone has, a fixed request header. Claude Code accepts a header directly. This serves both: an OAuth 2.1 flow per the MCP 2025-06-18 authorization spec, and a static token read from a file.

## Install

Run this on the machine that holds the vault. It asks for your vault path and hostname, installs the code, generates a password and a token, and writes the service files ready to start.

```bash
curl -fsSL https://raw.githubusercontent.com/rollecode/obsidian-remote-mcp/main/install.sh | bash
```

## Install with Claude Code

Claude Code can do the whole thing, including the tunnel and the reverse proxy, which the installer deliberately leaves alone because every setup differs. Start it in an empty directory:

```bash
claude
```

Then give it this:

```
Install https://github.com/rollecode/obsidian-remote-mcp on this machine.

Read the repository's README for the architecture and the manual setup steps, then work out what applies here rather than assuming. Specifically:

1. Find my Obsidian vault and confirm the path with me before using it.
2. Install the code and dependencies, set a login password, and generate a static token for Claude Code.
3. Install and start both systemd services with the real paths for this machine.
4. Expose it over HTTPS on a hostname I give you. Check what I already run - Cloudflare Tunnel, nginx, Caddy, Traefik - and use that rather than installing something new. Never open a router port without asking me first.
5. Verify it end to end: the discovery endpoints return valid JSON, an unauthenticated request gets 401 with a WWW-Authenticate header, and the static token gets a 200 from the MCP endpoint.
6. Print the Claude.ai connector URL and the exact claude mcp add command for Claude Code, and tell me the password.

This exposes read and write access to my notes over the internet, so tell me anything that weakens that before you do it.
```

## Manual setup

Install first:

```bash
git clone https://github.com/rollecode/obsidian-remote-mcp.git
cd obsidian-remote-mcp
npm install
```

Then set a password. This is what you type on the OAuth login page, and only its scrypt hash is stored.

```bash
node set-password.js 'your-password-here'
```

Generate a static token if you want to use Claude Code, which can send a header directly and skip the login page.

```bash
mkdir -p ~/.config/obsidian-mcp
openssl rand -hex 32 > ~/.config/obsidian-mcp/token
chmod 600 ~/.config/obsidian-mcp/token
```

Install the services, replacing `YOUR_USER`, the vault path and `ISSUER` in the unit files with your own.

```bash
sudo cp systemd/*.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now obsidian-mcp obsidian-mcp-auth
```

Expose it. Add the nginx site from `nginx/obsidian-mcp.conf`, then point a Cloudflare Tunnel at `http://localhost:8421`. Any HTTPS reverse proxy works, but a tunnel avoids opening a router port.

```yaml
ingress:
  - hostname: obsidian-mcp.example.com
    service: http://localhost:8421
```

```bash
cloudflared tunnel route dns YOUR_TUNNEL obsidian-mcp.example.com
sudo systemctl restart cloudflared
```

Finally, connect. In Claude.ai go to **Customize** &rarr; **Connectors** &rarr; **Add custom connector**, enter `https://obsidian-mcp.example.com/mcp` and leave **Client ID** and **Client Secret** blank, since the server registers Claude automatically. You will be asked for the password you set earlier. Remember to enable the connector in each conversation from the **+** menu.

For Claude Code, use the static token.

```bash
claude mcp add --transport http obsidian https://obsidian-mcp.example.com/mcp \
  --header "Authorization: Bearer $(cat ~/.config/obsidian-mcp/token)"
```

## Tools

Every tool takes an optional `vault`. With one vault it is inferred, and with `DEFAULT_VAULT` set the auth server fills it in, so it rarely needs passing. Anything addressing a file takes `path` relative to the vault root; note tools also accept the older `filename` plus `folder` pair.

### Notes

| Tool | Description |
|------|-------------|
| `read-note` | Read a note, optionally with line numbers |
| `read-notes` | Read several notes in one call |
| `create-note` | Create a note, with frontmatter as an object |
| `edit-note` | Append, prepend, replace or delete a whole note |
| `patch-note` | Edit one section, addressed by its heading |
| `replace-in-note` | Find and replace inside a note, literal or regex |
| `move-note` | Move or rename, rewriting the links that pointed at it |
| `copy-note` | Copy a note to another path |
| `delete-note` | Delete a note, to `.trash` unless `permanent` |
| `get-note-outline` | Headings with levels and line numbers |
| `update-frontmatter` | Set and remove properties, keeping comments and key order |

### Canvas

| Tool | Description |
|------|-------------|
| `create-canvas` | Create a canvas from nodes and edges, or straight from a list of notes |
| `read-canvas` | Nodes and edges with their ids, or the raw JSON |
| `edit-canvas` | Add, update and remove nodes and edges, or re-flow the layout |
| `list-canvases` | Every `.canvas` in the vault |

### Tags, links and structure

| Tool | Description |
|------|-------------|
| `add-tags` | Add tags, in frontmatter or inline |
| `remove-tags` | Remove tags, taking their hierarchy with them |
| `rename-tag` | Rename a tag across the vault |
| `list-tags` | Every tag with how many notes use it |
| `get-backlinks` | What links to a note |
| `get-outgoing-links` | What a note links to, and whether it resolves |
| `find-broken-links` | Links pointing at notes that do not exist |
| `find-orphaned-notes` | Notes nothing links to |

### Browsing and search

| Tool | Description |
|------|-------------|
| `search-vault` | Content, filename, tag, property and date filters, combinable |
| `list-directory` | One folder at a time, or recursive |
| `list-notes` | Enumerate notes by folder, tag or date |
| `get-recent-notes` | What changed most recently |
| `get-vault-stats` | Counts, tags, links, largest folders |
| `list-available-vaults` | The vaults this server exposes |
| `create-directory` | Create a folder |
| `move-directory` | Move a folder and rewrite the links to everything in it |
| `delete-directory` | Delete a folder, to `.trash` unless `permanent` |

### Daily notes and attachments

| Tool | Description |
|------|-------------|
| `get-daily-note` | The daily note for a date, per the vault's own daily-note settings |
| `append-to-daily-note` | Append to today's note, optionally under a heading |
| `list-attachments` | Non-markdown files in the vault |
| `read-attachment` | Images as images, text-like files as text |

### Canvas support

Obsidian canvases are [JSON Canvas](https://jsoncanvas.org) files, not markdown, which is why a markdown-only server cannot touch them. Coordinates are the part a language model handles worst, so `x`/`y`/`width`/`height` are optional everywhere and filled from a grid; `edit-canvas` also has a `layout` operation that re-flows an existing canvas into a grid, column or row.

Node ids are yours to choose, so edges can reference nodes in the same call:

```json
{
  "path": "Maps/Flow.canvas",
  "nodes": [
    { "id": "start", "type": "text", "text": "# Kickoff" },
    { "id": "spec", "type": "file", "file": "Projects/Spec.md" }
  ],
  "edges": [{ "from": "start", "to": "spec", "label": "leads to" }]
}
```

`fromNotes` builds a canvas straight from a set of notes, and with `linkEdges` it draws an arrow wherever one of them links to another, turning a corner of the vault graph into a canvas in one call.

Obsidian writes fields the spec does not define, `styleAttributes` on every node and a top-level `metadata` object, and it discards a canvas it cannot parse. Every edit preserves what it does not recognise, and a failed operation writes nothing at all.

## Development

The vault server runs on its own over stdio, without the auth server, which is the quickest way to try a change:

```bash
npm install
node vault-mcp.js ~/Documents/YourVault
npx @modelcontextprotocol/inspector node vault-mcp.js ~/Documents/YourVault
```

`npm test` builds a throwaway vault, starts the server over stdio and drives every tool through a real MCP client, checking the files on disk afterwards. It touches nothing outside its own temp directory.

## Endpoints

| Path | Purpose |
|------|---------|
| `/mcp` | The MCP endpoint, requires a token |
| `/.well-known/oauth-protected-resource` | RFC 9728 resource metadata |
| `/.well-known/oauth-authorization-server` | RFC 8414 server metadata |
| `/register` | RFC 7591 dynamic client registration |
| `/authorize` | Login page and authorization code issuance |
| `/token` | Token exchange and refresh |
| `/healthz` | Health check |

## Configuration

| Variable | Default | Purpose |
|----------|---------|---------|
| `ISSUER` | required | Public HTTPS base URL, no trailing slash |
| `PORT` | `8422` | Port the auth server listens on |
| `UPSTREAM` | `http://127.0.0.1:8420` | Where `vault-mcp.js --http` is listening |
| `CONFIG_DIR` | `~/.config/obsidian-mcp` | Password hash, static token, OAuth database |
| `DEFAULT_VAULT` | unset | Vault used when a tool call omits one. Serving more than one vault without this makes Claude ask which to use on every call |
| `CALL_TIMEOUT_MS` | `120000` | How long a call may go without a byte from upstream before the session is torn down. Inactivity, not total duration |

## The vault server

`vault-mcp.js` speaks MCP over stdio and touches nothing but the vault directory. It replaced [obsidian-mcp](https://github.com/StevenStavrakis/obsidian-mcp) in 1.5.0, which had to be patched on install to stop it going deaf after 60 seconds idle and to make `edit-note` advertise its parameters at all, and which was never going to grow canvas support.

Listings, tags, links and search all read one in-memory index. It stats the tree on demand and re-parses only the files whose size or mtime moved, so a vault of 6500 notes costs a few seconds on the first call and single-digit milliseconds after that. Every write invalidates it, so a tool never reads its own change back as stale.

Three things are refused outright rather than left to care:

- A path that resolves outside the vault, including through a symlink planted inside it
- Any write into `.obsidian`, where a bad value corrupts the vault for every client that syncs it
- A canvas edit where any operation fails, which writes nothing rather than half of a list

Deletions move to the vault's `.trash`, where Obsidian lists them under deleted files, unless `permanent` is set. Writes go to a hidden temp file and are renamed into place, so a sync client never reads a half-written note.

Two guards in the auth server keep a stuck child from hanging a client:

- A call that goes `CALL_TIMEOUT_MS` without a byte from upstream is cut, and the session is terminated so the wedged child dies with it. The SSE `GET` stream is exempt, since it is idle by design.
- A request carrying a session the upstream no longer knows gets `404`, not a `400`. Only `404` obliges a client to send a fresh `InitializeRequest`, per the session management rules in the MCP 2025-06-18 transport spec, so clients recover on their own.

## Security

- Authorization codes are single use and expire in 60 seconds
- PKCE is required and only `S256` is accepted
- Redirect URIs are matched exactly against registered values
- Refresh tokens rotate on every use
- Tokens are stored as SHA-256 hashes, so the database holds no usable credentials
- Tokens are bound to the resource they were issued for and rejected elsewhere
- The password is stored as a scrypt hash, compared in constant time

This grants write access to your vault over the internet. Use a strong password, keep `ISSUER` on HTTPS, and remember that anyone holding the static token has the same access without the login page.
