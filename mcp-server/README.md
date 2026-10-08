# TateSide live schematic MCP (Beta)

Ported from upstream EasySchematic `e2f178c` (5 October 2026), adapted to the TateSide fork's shared library and store. It provides 26 upstream editing tools, five TateSide missing-device tools and three Jetbuilt project tools. It works with an empty schematic or an existing one.

The assistant starts this Node program on the laptop over MCP stdio. The open editor tab connects to its WebSocket on `127.0.0.1`. The VPS hosts the editor/API; it does not host this local MCP server. Token pairing, an Origin allowlist and a single active tab protect the connection. Pairing stays in memory and turns off on reload.

## Build and test

Use Node 24 from the repository root:

```sh
npm ci --prefix mcp-server
npm test --prefix mcp-server
```

The main frontend build includes the editor bridge. CI builds and tests this separate server too. After updating its source, rebuild before restarting your assistant.

## Office Claude Desktop setup (Windows)

Install Node.js 24 and Claude Desktop, and put this checkout in a stable local folder on each workstation. From the checkout root, run `npm ci --prefix mcp-server`, `npm test --prefix mcp-server`, then `./mcp-server/setup-claude.ps1`. The script preserves other Claude settings/MCP servers, backs up the existing config in the protected token directory, creates/protects that workstation's token, and registers the built server on port 8766. It does not install Claude or Node. Run it again after moving the checkout. Never share a workstation's pairing token in chat or email.

Restart Claude Desktop, run `./mcp-server/copy-pairing-token.ps1`, log into the test editor normally, and pair in **File → Preferences → AI (Beta)** with port **8766**. Allow browser local-network access. A single EasySchematic connection provides Jetbuilt and canvas tools using the signed-in editor's API; LibraryD0ctor is optional and not required for this workflow. No Jetbuilt credential belongs in Claude config.

The script defaults to the test editor origin. Production requires an explicitly selected origin and a release containing these frontend changes. Actual installed Claude UI activation must be checked on each workstation; stdio/browser fixture tests do not prove it.

## Jetbuilt project workflow

Say: “Open P-1234 and show me its rooms and kit.” The assistant uses `search_jetbuilt_projects` and `get_jetbuilt_project` without changing the canvas. Choose the exact project when search is ambiguous. The preview returns exact room names, item ids, quantities, matches and unresolved bundles. Only the last three previews are held in that tab; reloading invalidates them.

Say: “Start a schematic for the boardroom, with the codec and displays.” `start_jetbuilt_schematic` takes the preview id, optional rooms and item ids. Quantities become separate Devices with independent Ports. Unmatched kit is reported for research, with its room container ready for `create_local_device` and `place_device_in_room`. `includeUnmatched=true` explicitly requests portless placeholders instead. Possible matches and unreviewed bundle components are never guessed. Imports are capped at 1000 Devices; select a narrower scope for large quotes. A nonempty canvas requires an explicit replacement request and `replaceCurrent=true`; save existing work before replacing it. Importing is not undoable across project boundaries.

The regular **Start New Project** dialog retains **Room scope → All rooms / one room** and adds **Place each unit separately for wiring**. Uncheck it for the older representative `xN` layout.

For a researched local Device, open **Device Properties → Add to TateSide Library**. Current Properties edits are applied locally, then the shared-template review dialog opens. Publishing is a human action, reuses API validation/duplicate checks and retains research evidence. Publication links the shared template identity without changing instance Port ids or existing Connections. Changes made in the shared-template review apply to the reusable definition; use normal Properties/template sync to change the placed Device afterward. Cancelling the shared review does not undo the Properties edits already applied.

## Existing laptop configuration

Configuration has been added to the existing user Codex config and Claude Code config, plus a prepared Claude Desktop config. Both use the same protected pairing-token file; no token is in Git or assistant config. Claude installation/activation still needs checking in the client.

| Assistant | Local port | Configuration |
|---|---|---|
| Codex | 8765 | `~/.codex/config.toml`, server `easyschematic` |
| Claude Code | 8766 | `~/.claude.json`, user MCP server `easyschematic` |
| Claude Desktop | 8766 | `%APPDATA%/Claude/claude_desktop_config.json` |

Restart/reload the assistant so it starts the server. Claude Code and Claude Desktop share port 8766 through the authenticated relay when both run the updated build. Codex and Claude use different ports; choose which controls the editor with the port setting. The configured hosted Origin is **https://testschematic.tateside.online**.

1. Copy the token without printing it by running `mcp-server/copy-pairing-token.ps1` in PowerShell.
2. Open testschematic and the schematic you want to work on; choose **File → Preferences → AI (Beta)**.
3. Paste the token, set **8765 for Codex** or **8766 for Claude**, and enable **Let my AI assistant read and edit this schematic**.
4. Wait for **Connection: connected**, then close Preferences.
5. Ask the assistant to inspect the schematic, or open **File → New** first to build from scratch. Normal undo and autosave apply to edits.

Example: “Create a meeting-room schematic with a display, conferencing codec and network switch. Search our library first, connect compatible ports, and propose any missing devices for my review.”

Allow local-network access if the browser requests it. Only one editor tab can control a port; enabling another supersedes the first. To switch assistants, disable the toggle, change the port, and enable it again. Multiple assistant chats on the same port share the first process's authenticated editor connection. Each chat still has its own MCP stdio process; additional processes relay tool calls through the port owner using the same pairing token.

If the editor says connected but a chat reports no editor, check which process owns port 8765 and whether additional processes are running an old build. Older builds logged `EADDRINUSE` but continued serving disconnected tools. Rebuild and reload those MCP processes to load the sharing fix; repeatedly reconnecting the editor cannot repair an old process that failed to bind its port. If the port owner exits, reload the MCP sessions and reconnect the editor.

## Missing devices

Search existing templates first, then read `get_library_taxonomy` and research official manufacturer specifications using the assistant's own browsing tools. Never invent ports or dimensions; include evidence and record uncertainty.

**Default: `create_local_device`.** This validates and saves a local custom device in the current browser, then places it immediately. No Library Doctor approval is needed. It returns the template and placed device identities; read `get_device` for the actual port IDs before wiring. Use `placeOnCanvas=false` to save only the template. Matching existing identities are reused without overwriting them.

Local devices persist in that browser and are included with schematic saves/exports. They travel with a shared schematic but are not published to everyone's device library. Clearing browser storage removes the browser copy; keep schematic files/server saves as backups. AI-created definitions are marked AI researched, retain evidence/confidence, and still need your engineering review. Device Properties offers **Add to TateSide Library** for human review and publication when ready.

**Optional shared publication:** only when the user wants everyone to have the device, use `propose_missing_device`. A human reviews it in File → Library Doctor, accepts it, selects the Accepted status filter, then chooses Publish approved device. Publication rechecks taxonomy/identity and writes the shared template plus audit event atomically. The assistant can check `get_device_proposal` and then use `add_approved_device`. There are no MCP approval/publication tools. Publishing in staging does not promote devices to production.

Quality declarations describe the assistant's research; the backend validates data/URL shape, not manufacturer ownership or specification completeness independently.

## Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `EASYSCHEMATIC_MCP_PORT` | 8765 | Local WebSocket port |
| `EASYSCHEMATIC_MCP_TOKEN_FILE` | `~/.config/easyschematic-mcp/pairing-token` | Persistent token, created exclusively if absent; never logged |
| `EASYSCHEMATIC_MCP_TOKEN` | unset | Explicit token override for fixtures or managed setups |
| `EASYSCHEMATIC_MCP_ORIGINS` | unset | Comma-separated exact hosted Origins; localhost dev Origins are also accepted |

On Windows protect the token folder with an ACL for your own account. Sean's folder and config backups have that ACL. Config backups are under `~/.config/easyschematic-mcp/config-backups-20261007`.

## Scope and differences

Supported editing includes devices, safe properties, compatible connections, layout, rooms, notes, modular cards, racks and batches. The assistant edits the open editor rather than directly editing server files. This integration deliberately retains the fork's schema and existing actions. Rack shelves are preserved on removal because the fork does not track upstream bridge-created shelf ownership. There is no SharePoint publishing tool or production deployment tool.

Official client references: [Codex MCP](https://developers.openai.com/codex/mcp), [Claude Code MCP](https://code.claude.com/docs/en/mcp).
