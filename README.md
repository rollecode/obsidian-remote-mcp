<center align="center" style="text-align: center;justify-content:center;">
<div align="center" style="text-align: center;justify-content:center;">
<h1 align="center" style="text-align: center;justify-content:center;">

Obsidian remote MCP server

<img style="justify-content:center;text-align: center;width: 95px; height: auto;" width="793" height="411" alt="image" src="https://github.com/user-attachments/assets/abed1a04-d69b-4ab4-a490-d606064df72d" />
<img style="justify-content:center;text-align: center;width: 250px; height: auto;" alt="image" src="https://github.com/user-attachments/assets/334c2e4d-d56d-4462-89bb-3443195ef68d" />

</h1>


![Version](https://img.shields.io/badge/version-1.2.1-blue.svg?style=for-the-badge) ![Node](https://img.shields.io/badge/Node.js-339933?style=for-the-badge&logo=node.js&logoColor=white) ![OAuth](https://img.shields.io/badge/OAuth_2.1-EB5424?style=for-the-badge&logo=auth0&logoColor=white)

</div>
</center>

<hr>

Reach your Obsidian vault from anywhere, in Claude.ai and Claude Code, without Obsidian running and without the vault on the machine you are working from. Wraps [obsidian-mcp](https://github.com/StevenStavrakis/obsidian-mcp) in an OAuth 2.1 authorization server so it can be added as a Claude.ai custom connector, and keeps static bearer tokens working for Claude Code.

<hr>

## Requirements

- An always-on Linux machine, such as a home server, a NAS or a VPS
- Your vault synced to it with [Obsidian Sync](https://obsidian.md/help/sync) via [Headless Sync](https://obsidian.md/help/sync/headless), [Syncthing](https://github.com/syncthing/syncthing), [Obsidian Git](https://github.com/Vinzent03/obsidian-git) or [Nextcloud](https://github.com/nextcloud/desktop)
- Node.js 18 or newer
- An HTTPS reverse proxy or tunnel

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

Only the auth server is reachable from outside. Port 8420 speaks no authentication at all. supergateway offers no flag to choose a bind address and listens on every interface, so the unit confines it with `IPAddressDeny=any` and `IPAddressAllow=localhost`; without that it would answer anyone on the LAN.

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
| `DEFAULT_VAULT` | unset | Vault used when a tool call omits one. Serving more than one vault without this makes Claude ask which to use on every call |
| `CALL_TIMEOUT_MS` | `120000` | How long a call may go without a byte from upstream before the session is torn down. Inactivity, not total duration |

## Sessions that stop answering

`obsidian-mcp` starts a connection monitor that calls `server.close()` once 60 seconds pass without a request. Closing the stdio transport detaches its stdin listener, so the process keeps running but never answers again. That is reasonable where a desktop client spawns a child per session and disposes of it, but here supergateway keeps one child per session for up to an hour, and any human-paced pause between two calls is longer than a minute. The helper went deaf mid-session and every later call hung.

`patches/disable-idle-close.js` makes that timeout a no-op; it runs on `postinstall` and is idempotent. Session lifetime is supergateway's job, so nothing is lost.

`patches/fix-edit-note.js` fixes two more things in the same dependency. `edit-note` is the only tool whose schema is a zod union, and the bundled converter keeps just `type`, `properties` and `required`, none of which a union has at the top level, so the tool advertised no parameters at all and a strict client could refuse to call it. Its `replace` operation also reported "Note replaceed successfully".

Both patches check that each anchor matches exactly once and abort with an explanation rather than silently doing nothing, so a future `obsidian-mcp` that has moved on fails the install instead of shipping a half-patched bundle.

Two further guards keep a stuck child from ever hanging a client again:

- A call that goes `CALL_TIMEOUT_MS` without a byte from upstream is cut, and the session is terminated so the wedged child dies with it. The SSE `GET` stream is exempt, since it is idle by design.
- A request carrying a session the upstream no longer knows gets `404`, not the `400` supergateway returns. Only `404` obliges a client to send a fresh `InitializeRequest`, per the session management rules in the MCP 2025-06-18 transport spec, so clients recover on their own.

## Security

- Authorization codes are single use and expire in 60 seconds
- PKCE is required and only `S256` is accepted
- Redirect URIs are matched exactly against registered values
- Refresh tokens rotate on every use
- Tokens are stored as SHA-256 hashes, so the database holds no usable credentials
- Tokens are bound to the resource they were issued for and rejected elsewhere
- The password is stored as a scrypt hash, compared in constant time

This grants write access to your vault over the internet. Use a strong password, keep `ISSUER` on HTTPS, and remember that anyone holding the static token has the same access without the login page.
