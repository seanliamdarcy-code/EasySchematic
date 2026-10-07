# TateSide live schematic MCP (Beta)

Ported from upstream EasySchematic `e2f178c` (5 October 2026), adapted to the TateSide fork's shared library and store. It provides 26 upstream editing tools and five TateSide missing-device tools. It works with an empty schematic or an existing one.

The assistant starts this Node program on the laptop over MCP stdio. The open editor tab connects to its WebSocket on `127.0.0.1`. The VPS hosts the editor/API; it does not host this local MCP server. Token pairing, an Origin allowlist and a single active tab protect the connection. Pairing stays in memory and turns off on reload.

## Build and test

Use Node 24 from the repository root:

```sh
npm ci --prefix mcp-server
npm test --prefix mcp-server
```

The main frontend build includes the editor bridge. CI builds and tests this separate server too. After updating its source, rebuild before restarting your assistant.

## Sean's laptop setup

Configuration has been added to the existing user Codex config and Claude Code config, plus a prepared Claude Desktop config. Both use the same protected pairing-token file; no token is in Git or assistant config. Claude installation/activation still needs checking in the client.

| Assistant | Local port | Configuration |
|---|---|---|
| Codex | 8765 | `~/.codex/config.toml`, server `easyschematic` |
| Claude Code | 8766 | `~/.claude.json`, user MCP server `easyschematic` |
| Claude Desktop | 8766 | `%APPDATA%/Claude/claude_desktop_config.json` |

Restart/reload the assistant so it starts the server. Claude Code and Claude Desktop share port 8766, so use one at a time. Codex and Claude can both be running; choose which controls the editor with the port setting. The configured hosted Origin is **https://testschematic.tateside.online**.

1. Copy the token without printing it by running `mcp-server/copy-pairing-token.ps1` in PowerShell.
2. Open testschematic and the schematic you want to work on; choose **File → Preferences → AI (Beta)**.
3. Paste the token, set **8765 for Codex** or **8766 for Claude**, and enable **Let my AI assistant read and edit this schematic**.
4. Wait for **Connection: connected**, then close Preferences.
5. Ask the assistant to inspect the schematic, or open **File → New** first to build from scratch. Normal undo and autosave apply to edits.

Example: “Create a meeting-room schematic with a display, conferencing codec and network switch. Search our library first, connect compatible ports, and propose any missing devices for my review.”

Allow local-network access if the browser requests it. Only one tab can control an assistant connection; enabling another supersedes the first. To switch assistants, disable the toggle, change the port, and enable it again. Multiple assistant sessions on the same port cannot coexist.

## Missing devices

Search existing templates first, then read `get_library_taxonomy` and research official manufacturer specifications using the assistant's own browsing tools. Never invent ports or dimensions; include evidence and record uncertainty.

**Default: `create_local_device`.** This validates and saves a local custom device in the current browser, then places it immediately. No Library Doctor approval is needed. It returns the template and placed device identities; read `get_device` for the actual port IDs before wiring. Use `placeOnCanvas=false` to save only the template. Matching existing identities are reused without overwriting them.

Local devices persist in that browser and are included with schematic saves/exports. They travel with a shared schematic but are not published to everyone's device library. Clearing browser storage removes the browser copy; keep schematic files/server saves as backups. AI-created definitions are marked AI researched, retain evidence/confidence, and still need your engineering review.

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
