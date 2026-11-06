### 1.6.0: 2026-11-06

* Serve Streamable HTTP without supergateway
* Fix `tools/list` hanging behind the auth server

### 1.5.0: 2026-10-24

* Add Obsidian canvas support
* Create canvases from notes and their links
* Lay out canvas nodes automatically
* Replace obsidian-mcp with an own vault server
* Add heading-scoped editing with `patch-note`
* Add find and replace within a note
* Add frontmatter property editing
* Add backlinks and outgoing links
* Add broken and orphaned note reports
* Add tag listing with counts
* Add folder browsing, moving and deleting
* Add daily note reading and appending
* Add attachment listing and reading
* Add recent notes and vault stats
* Add batch note reading
* Add note outlines
* Add copy-note
* Filter search by tag, property, folder and date
* Rewrite links when a folder moves
* Keep unknown canvas fields on edit
* Refuse writes into `.obsidian`
* Refuse paths escaping the vault through symlinks
* Write notes atomically
* Serve a page at the site root for connector icons
* Drop the install-time patches
* Add an end-to-end test suite

### 1.4.3: 2026-09-27

* Reap sessions whose clients disconnect

### 1.4.2: 2026-08-17

* Simplify the sign-in page

### 1.4.1: 2026-08-15

* Make `edit-note` advertise its parameters
* Fix "Note replaceed successfully"
* Fix release workflow breaking on backticks

### 1.4.0: 2026-08-15

* Stop the vault helper going deaf after 60s idle
* Patch obsidian-mcp on install

### 1.3.0: 2026-08-15

* Cut calls to a wedged upstream child
* Terminate the session when upstream stalls
* Return 404 for unknown sessions so clients reconnect
* Add `CALL_TIMEOUT_MS`
* Confine port 8420 to loopback

### 1.2.1: 2026-08-13

* Serve an Obsidian favicon and logo
* Stop 404s being cached by the CDN
* Remove a tool that does not exist

### 1.2.0: 2026-08-13

* Fix tool calls failing from Claude.ai
* Add DEFAULT_VAULT so clients stop asking
* Derive the vault slug in the installer

### 1.1.2: 2026-08-12

* Name and link every sync method properly

### 1.1.1: 2026-08-12

* Fix wrong headless sync link
* Trim install section to one command

### 1.1.0: 2026-08-12

* Add curl bash installer
* Add Claude Code install instructions
* Add release workflow
* Add requirements section

### 1.0.0: 2026-08-12

* Initial release
* OAuth 2.1 authorization server with PKCE, dynamic client registration and refresh token rotation
* Static bearer token accepted alongside OAuth
* Streamable HTTP proxy to obsidian-mcp via supergateway
* systemd units and nginx config for Cloudflare Tunnel deployment
