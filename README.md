<center align="center" style="text-align: center;justify-content:center;">
<div align="center" style="text-align: center;justify-content:center;">
<h1 align="center" style="text-align: center;justify-content:center;">

Obsidian remote MCP server

</h1>

![Version](https://img.shields.io/badge/version-1.0.0-blue.svg?style=for-the-badge) ![Node](https://img.shields.io/badge/Node.js-339933?style=for-the-badge&logo=node.js&logoColor=white) ![OAuth](https://img.shields.io/badge/OAuth_2.1-EB5424?style=for-the-badge&logo=auth0&logoColor=white)

</div>
</center>

<hr>

Reach your Obsidian vault from anywhere, in Claude.ai and Claude Code, without Obsidian running and without the vault on the machine you are working from. Wraps [obsidian-mcp](https://github.com/StevenStavrakis/obsidian-mcp) in an OAuth 2.1 authorization server so it can be added as a Claude.ai custom connector, and keeps static bearer tokens working for Claude Code.

<hr>

## Features

- Read and write your vault from Claude.ai and Claude Code
- OAuth 2.1 with PKCE, dynamic client registration, and refresh token rotation
- Static bearer token accepted alongside OAuth, so both clients work at once
- Works with Obsidian closed - the vault is read from disk, no plugins needed
- Serves multiple vaults from one endpoint
- No inbound firewall port needed when paired with a Cloudflare Tunnel

## How it works

```
obsidian-mcp (stdio)
  -> supergateway          stdio to Streamable HTTP, :8420
  -> auth-server.js        OAuth 2.1 + token check, :8422
  -> nginx                 :8421
  -> Cloudflare Tunnel     https://obsidian-mcp.example.com
```

Only the auth server is reachable from outside. Port 8420 speaks no authentication at all and stays bound to localhost.

Claude.ai custom connectors accept OAuth or, in a beta not everyone has, a fixed request header. Claude Code accepts a header directly. This serves both: an OAuth 2.1 flow per the MCP 2025-06-18 authorization spec, and a static token read from a file.

## Setup

### 1. Install

```bash
git clone https://github.com/rollecode/obsidian-remote-mcp.git
cd obsidian-remote-mcp
npm install
```

### 2. Set a password

This is what you type on the OAuth login page. It is stored as a scrypt hash.

```bash
node set-password.js 'your-password-here'
```

### 3. Optional: a static token for Claude Code

```bash
mkdir -p ~/.config/obsidian-mcp
openssl rand -hex 32 > ~/.config/obsidian-mcp/token
chmod 600 ~/.config/obsidian-mcp/token
```

### 4. Install the services

Copy the unit files, replacing `YOUR_USER`, the vault path and `ISSUER` with your own:

```bash
sudo cp systemd/*.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now obsidian-mcp obsidian-mcp-auth
```

### 5. Expose it

Add the nginx site from `nginx/obsidian-mcp.conf`, then point a Cloudflare Tunnel at `http://localhost:8421`:

```yaml
ingress:
  - hostname: obsidian-mcp.example.com
    service: http://localhost:8421
```

```bash
cloudflared tunnel route dns YOUR_TUNNEL obsidian-mcp.example.com
sudo systemctl restart cloudflared
```

Any HTTPS reverse proxy works. A tunnel avoids opening a router port.

### 6. Connect

Claude.ai, Customize > Connectors > Add custom connector. Enter `https://obsidian-mcp.example.com/mcp` and leave Client ID and Client Secret blank - the server registers Claude automatically. You will be asked for the password from step 2.

Claude Code, using the static token from step 3:

```bash
claude mcp add --transport http obsidian https://obsidian-mcp.example.com/mcp \
  --header "Authorization: Bearer $(cat ~/.config/obsidian-mcp/token)"
```

## Tools

Provided by [obsidian-mcp](https://github.com/StevenStavrakis/obsidian-mcp).

| Tool | Description |
|------|-------------|
| `read-note` | Read a note |
| `create-note` | Create a note |
| `edit-note` | Edit a note |
| `delete-note` | Delete a note, to trash unless `permanent` |
| `move-note` | Move or rename a note |
| `search-vault` | Full text search |
| `create-directory` | Create a folder |
| `add-tags` | Add tags to a note |
| `remove-tags` | Remove tags from a note |
| `rename-tag` | Rename a tag across the vault |
| `manage-tags` | List and manage tags |
| `list-available-vaults` | List configured vaults |

Most tools take `{vault, folder, filename}`. `delete-note` takes `{vault, path}` instead.

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
| `UPSTREAM` | `http://127.0.0.1:8420` | Where supergateway is listening |
| `CONFIG_DIR` | `~/.config/obsidian-mcp` | Password hash, static token, OAuth database |

## Security

- Authorization codes are single use and expire in 60 seconds
- PKCE is required and only `S256` is accepted
- Redirect URIs are matched exactly against registered values
- Refresh tokens rotate on every use
- Tokens are stored as SHA-256 hashes, so the database holds no usable credentials
- Tokens are bound to the resource they were issued for and rejected elsewhere
- The password is stored as a scrypt hash, compared in constant time

This grants write access to your vault over the internet. Use a strong password, keep `ISSUER` on HTTPS, and remember that anyone holding the static token has the same access without the login page.

## Requirements

- Node.js 18 or newer
- An HTTPS reverse proxy or tunnel, since OAuth 2.1 requires HTTPS
- Obsidian is not required, and does not need to be running
