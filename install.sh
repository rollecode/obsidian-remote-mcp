#!/usr/bin/env bash
#
# Installer for obsidian-remote-mcp.
#
#   curl -fsSL https://raw.githubusercontent.com/rollecode/obsidian-remote-mcp/main/install.sh | bash
#
# Non-interactive:
#   VAULT=/home/me/Documents/Vault HOSTNAME=obsidian-mcp.example.com \
#     curl -fsSL .../install.sh | bash
#
# Installs the code and the services. Exposing the endpoint to the internet is
# left to you: a tunnel or reverse proxy is the one step where setups genuinely
# differ, and guessing wrong there means publishing a vault by accident.

set -euo pipefail

REPO_URL="https://github.com/rollecode/obsidian-remote-mcp.git"
INSTALL_DIR="${INSTALL_DIR:-$HOME/obsidian-remote-mcp}"
CONFIG_DIR="${CONFIG_DIR:-$HOME/.config/obsidian-mcp}"
MCP_PORT="${MCP_PORT:-8420}"
AUTH_PORT="${AUTH_PORT:-8422}"
PROXY_PORT="${PROXY_PORT:-8421}"

BOLD=$'\033[1m'; DIM=$'\033[2m'; RED=$'\033[0;31m'; GREEN=$'\033[0;32m'
YELLOW=$'\033[1;33m'; BLUE=$'\033[0;34m'; NC=$'\033[0m'
info()  { echo "${BLUE}==>${NC} $1"; }
ok()    { echo "${GREEN} ok${NC} $1"; }
warn()  { echo "${YELLOW}  ! ${NC}$1"; }
die()   { echo "${RED}error:${NC} $1" >&2; exit 1; }

# Piped into bash means stdin is the script, so prompts have to come from the
# terminal directly or they eat the rest of the script. `[ -r /dev/tty ]` is not
# a sufficient test: in a container without a TTY the device node exists and
# passes the permission check, then opening it fails with ENXIO.
if ( exec 3</dev/tty ) 2>/dev/null; then exec 3</dev/tty; else exec 3<&0; fi
ask() { # ask <prompt> <default>
  local prompt=$1 default=${2:-} reply
  if [ -n "$default" ]; then printf '%s [%s]: ' "$prompt" "$default" >&2
  else printf '%s: ' "$prompt" >&2; fi
  IFS= read -r reply <&3 || reply=""
  echo "${reply:-$default}"
}
ask_secret() {
  local prompt=$1 reply
  printf '%s: ' "$prompt" >&2
  stty -echo 2>/dev/null || true
  IFS= read -r reply <&3 || reply=""
  stty echo 2>/dev/null || true
  printf '\n' >&2
  echo "$reply"
}

[ "$(id -u)" -eq 0 ] && die "Do not run this as root. It installs into \$HOME and asks for sudo only where needed."

# --- prerequisites ---------------------------------------------------------

info "Checking prerequisites"
command -v node >/dev/null || die "node is not installed (need 18 or newer)"
command -v npm  >/dev/null || die "npm is not installed"
command -v git  >/dev/null || die "git is not installed"
NODE_MAJOR=$(node -p 'process.versions.node.split(".")[0]')
[ "$NODE_MAJOR" -ge 18 ] || die "node $NODE_MAJOR is too old, need 18 or newer"
ok "node $(node -v), npm $(npm -v)"

# --- code ------------------------------------------------------------------

if [ -d "$INSTALL_DIR/.git" ]; then
  info "Updating $INSTALL_DIR"
  git -C "$INSTALL_DIR" pull --ff-only >/dev/null 2>&1 || warn "could not fast-forward, leaving the checkout alone"
elif [ -f "./auth-server.js" ] && [ -f "./set-password.js" ]; then
  INSTALL_DIR="$(pwd)"
  info "Using the checkout in $INSTALL_DIR"
else
  info "Cloning into $INSTALL_DIR"
  git clone --quiet "$REPO_URL" "$INSTALL_DIR"
fi

info "Installing dependencies"
(cd "$INSTALL_DIR" && npm install --omit=dev --silent)
ok "dependencies installed"

# --- configuration ---------------------------------------------------------

VAULT="${VAULT:-}"
while [ -z "$VAULT" ]; do
  VAULT=$(ask "Full path to your Obsidian vault" "")
  [ -z "$VAULT" ] && { warn "A vault path is required."; continue; }
  VAULT="${VAULT/#\~/$HOME}"
  if [ ! -d "$VAULT" ]; then warn "No such directory: $VAULT"; VAULT=""; continue; fi
  # Not fatal: obsidian-mcp reads plain markdown, an .obsidian folder only means
  # the vault has been opened in the app at least once.
  [ -d "$VAULT/.obsidian" ] || warn "No .obsidian folder there - is that really a vault?"
done
# obsidian-mcp registers a vault under a slug of its folder name, so
# "My Notes" is addressed as "my-notes".
VAULT_SLUG=$(basename "$VAULT" | tr '[:upper:]' '[:lower:]' | tr -c '[:alnum:]\n' '-' | sed 's/-\+/-/g; s/^-//; s/-$//')
ok "vault: $VAULT (as \"$VAULT_SLUG\")"

HOSTNAME_PUBLIC="${HOSTNAME:-}"
while [ -z "$HOSTNAME_PUBLIC" ]; do
  HOSTNAME_PUBLIC=$(ask "Public hostname this will be served on (e.g. obsidian-mcp.example.com)" "")
  case "$HOSTNAME_PUBLIC" in
    *://*) warn "Hostname only, without https://"; HOSTNAME_PUBLIC="" ;;
    *.*) : ;;
    "") : ;;
    *) warn "That does not look like a hostname."; HOSTNAME_PUBLIC="" ;;
  esac
done
ISSUER="https://$HOSTNAME_PUBLIC"
ok "issuer: $ISSUER"

mkdir -p "$CONFIG_DIR"
chmod 700 "$CONFIG_DIR"

# --- password --------------------------------------------------------------

if [ -f "$CONFIG_DIR/password-hash" ]; then
  ok "password already set, keeping it"
else
  PASSWORD="${PASSWORD:-}"
  if [ -z "$PASSWORD" ]; then
    PASSWORD=$(ask_secret "Password for the OAuth login page (blank to generate one)")
  fi
  GENERATED=0
  if [ -z "$PASSWORD" ]; then
    PASSWORD=$(node -e 'console.log(require("crypto").randomBytes(18).toString("base64url"))')
    GENERATED=1
  fi
  (cd "$INSTALL_DIR" && CONFIG_DIR="$CONFIG_DIR" node set-password.js "$PASSWORD" >/dev/null)
  chmod 600 "$CONFIG_DIR/password-hash"
  if [ "$GENERATED" = 1 ]; then
    ok "generated password: ${BOLD}$PASSWORD${NC}"
    warn "Save it now - only its hash is stored."
  else
    ok "password set"
  fi
fi

# --- static token ----------------------------------------------------------

if [ -f "$CONFIG_DIR/token" ]; then
  ok "static token already exists, keeping it"
else
  node -e 'console.log(require("crypto").randomBytes(32).toString("hex"))' > "$CONFIG_DIR/token"
  chmod 600 "$CONFIG_DIR/token"
  ok "static token generated for Claude Code"
fi

# --- service files ---------------------------------------------------------

NODE_BIN="$(command -v node)"
UNIT_TMP="$(mktemp -d)"
trap 'rm -rf "$UNIT_TMP"' EXIT

cat > "$UNIT_TMP/obsidian-mcp.service" <<EOF
[Unit]
Description=Obsidian MCP server (stdio) exposed over Streamable HTTP via supergateway
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$USER
WorkingDirectory=$INSTALL_DIR
ExecStart=$NODE_BIN $INSTALL_DIR/node_modules/supergateway/dist/index.js \\
  --stdio "$NODE_BIN $INSTALL_DIR/node_modules/obsidian-mcp/build/main.js '$VAULT'" \\
  --outputTransport streamableHttp \\
  --port $MCP_PORT \\
  --stateful \\
  --sessionTimeout 3600000 \\
  --healthEndpoint /healthz \\
  --logLevel info
Restart=on-failure
RestartSec=5
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=false
ReadWritePaths="$VAULT"
# supergateway binds every interface and has no --host flag, so this port would
# otherwise serve the unauthenticated MCP to the whole LAN. Only the auth server
# on loopback may reach it.
IPAddressDeny=any
IPAddressAllow=localhost

[Install]
WantedBy=multi-user.target
EOF

cat > "$UNIT_TMP/obsidian-mcp-auth.service" <<EOF
[Unit]
Description=OAuth 2.1 authorization server and resource guard for the Obsidian MCP
After=network-online.target obsidian-mcp.service
Wants=network-online.target

[Service]
Type=simple
User=$USER
WorkingDirectory=$INSTALL_DIR
Environment=PORT=$AUTH_PORT
Environment=UPSTREAM=http://127.0.0.1:$MCP_PORT
Environment=ISSUER=$ISSUER
Environment=CONFIG_DIR=$CONFIG_DIR
Environment=DEFAULT_VAULT=$VAULT_SLUG
ExecStart=$NODE_BIN $INSTALL_DIR/auth-server.js
Restart=on-failure
RestartSec=5
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=false
ReadWritePaths=$CONFIG_DIR

[Install]
WantedBy=multi-user.target
EOF

cat > "$UNIT_TMP/obsidian-mcp.conf" <<EOF
server {
    listen 127.0.0.1:$PROXY_PORT;
    server_name $HOSTNAME_PUBLIC;

    location / {
        proxy_pass http://127.0.0.1:$AUTH_PORT;
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header Connection "";
        proxy_set_header X-Forwarded-For \$remote_addr;
        proxy_set_header X-Forwarded-Proto https;
        proxy_read_timeout 1d;
        proxy_buffering off;
    }
}
EOF

cp "$UNIT_TMP"/*.service "$UNIT_TMP/obsidian-mcp.conf" "$INSTALL_DIR/" 2>/dev/null || true
ok "generated service files in $INSTALL_DIR"

INSTALL_UNITS=$(ask "Install and start the systemd services now? (needs sudo) [y/N]" "n")
STARTED=0
if [ "${INSTALL_UNITS,,}" = "y" ]; then
  if ! command -v systemctl >/dev/null; then
    warn "systemd not found, skipping"
  else
    sudo cp "$UNIT_TMP/obsidian-mcp.service" "$UNIT_TMP/obsidian-mcp-auth.service" /etc/systemd/system/
    sudo systemctl daemon-reload
    sudo systemctl enable --now obsidian-mcp obsidian-mcp-auth
    sleep 2
    if systemctl is-active --quiet obsidian-mcp-auth; then
      ok "services running"
      STARTED=1
    else
      warn "obsidian-mcp-auth did not start: journalctl -u obsidian-mcp-auth -n 30"
    fi
  fi
fi

# --- next steps ------------------------------------------------------------

TOKEN=$(cat "$CONFIG_DIR/token")
echo
echo "${BOLD}Installed.${NC}"
echo
if [ "$STARTED" = 0 ]; then
  echo "${BOLD}Start the services${NC}"
  echo "  sudo cp $INSTALL_DIR/obsidian-mcp.service $INSTALL_DIR/obsidian-mcp-auth.service /etc/systemd/system/"
  echo "  sudo systemctl daemon-reload"
  echo "  sudo systemctl enable --now obsidian-mcp obsidian-mcp-auth"
  echo
fi
echo "${BOLD}Expose it on $ISSUER${NC}  ${DIM}(not automated - setups differ)${NC}"
echo "  nginx site written to $INSTALL_DIR/obsidian-mcp.conf, listening on 127.0.0.1:$PROXY_PORT"
echo "  Point a Cloudflare Tunnel at http://localhost:$PROXY_PORT:"
echo "    ingress:"
echo "      - hostname: $HOSTNAME_PUBLIC"
echo "        service: http://localhost:$PROXY_PORT"
echo "  Any HTTPS reverse proxy works. OAuth 2.1 requires HTTPS, so plain HTTP will not do."
echo
echo "${BOLD}Then connect${NC}"
echo "  Claude.ai   Customize > Connectors > Add custom connector"
echo "              URL: $ISSUER/mcp"
echo "              Leave Client ID and Client Secret blank."
echo
echo "  Claude Code claude mcp add --transport http obsidian $ISSUER/mcp \\"
echo "                --header \"Authorization: Bearer $TOKEN\""
echo
