# TateSide live schematic MCP (Beta)

Ported from upstream EasySchematic `e2f178c` (5 October 2026), adapted to the TateSide fork's shared library and store. It provides 45 tools, including Jetbuilt project selection, missing-device research/placement and schematic layout controls. It works with an empty schematic or an existing one.

## Round 3 controls

- `create_local_device({overrideExisting: true, template: ...})` always creates a new local definition, retaining the real manufacturer/model identity and corrected Ports. It never modifies the shared library. Default reuse now reports `portDifferences` and warnings instead of silently discarding different definitions. Placement returns actual `ports` and `portIdMap` from template ids to instance ids.
- Ordinary USB-A/B/C cable combinations, HDMI/mini-HDMI and DisplayPort/mini-DisplayPort connect directly, retaining their real endpoints and cable-schedule entries. Adapter-only combinations and signal/direction/fanout validation remain enforced. This establishes drawable cable compatibility, not USB role, speed or power negotiation.
- `update_room({roomId, label?, x?, y?, width?, height?})` edits unlocked room containers. x/y are absolute canvas coordinates, even for nested rooms; moving carries its children. `fitToChildren: true` (optional padding, default 32, plus header allowance) fits immediate children and preserves their absolute positions. Use fit separately from explicit geometry. `delete_room({roomId})` deletes only the container and unparents its immediate children without deleting Devices or Connections. These actions support undo. Locked rooms must be unlocked in the editor first.
- `place_device_in_room` validates and confirms actual parenting for Devices including feathers. `move_device` now correctly interprets its documented parent-relative coordinates for parented Devices; the store still applies enclosure containment/reparenting rules. Read returned parent/absolute geometry afterward.
- MCP endpoint creation preserves exact requested x/y and returns Port coordinates. Interactive editor feather creation retains its grid snapping.
- `add_note` / `update_note` accept width and height. Omitted height expands conservatively for multiline/wrapped plain text; explicitly undersized height is rejected. `update_note` can omit text to resize without replacing existing rich text. Note text remains HTML-escaped; geometry/text changes share one undo step.
- `configure_sheet({titleBlockLayout: "tateside", titleBlock: {...}})` selects an explicit house preset containing logo, company, project, client, drawn by, drawing title, Drawing No., revision, date, scale and page cells. Set customFields with ids `drawingNo` and `scale` before or with the preset; it also resolves ids through matching field labels (e.g. `Drawing No.`). Existing layouts are retained until this preset is selected. Long text fits horizontally inside its SVG/PDF cell. The real logo still needs an asset supplied by the user.
- `configure_sheet({legend: {labels: {ethernet: "CAT6 / TPX", expansion: "CAT6 / TPX"}}})` replaces custom legend labels; equal custom labels with equal colours/line styles merge visually without changing electrical signal types or cable records. Empty labels map clears customization. Labels persist in schematic saves/exports and apply in print view, PDF and DXF.
- Fit-to-sheet waits for routing to settle, so an old route immediately after a move cannot inflate the fit.
- The MCP server reports version 0.2.0 and sends `notifications/tools/list_changed` on initialization to request fresh schema discovery. Client caches remain client-controlled; reconnect/restart the assistant's MCP connection to load a rebuilt local process. Reload/re-pair the editor after frontend changes. There are now 45 tools; the only new tool names are `update_room` and `delete_room`.

## Layout controls

Keep EasySchematic's appearance and use Tateside drawing conventions for arrangement and routing. The tool guidance and `build-schematic` prompt cover this in every client.

- `add_external_endpoints` creates independent service/off-sheet feathers; `update_external_endpoint` edits them. They are one-Port Devices, so ordinary connect/delete/room tools apply. Service references use signal/direction compatibility without requiring physical connector matching or an adapter. Real Device-to-Device connector rules are unchanged. Creation/position edits use absolute canvas coordinates. Connected feathers cannot change direction, signal or connector until disconnected.
- `set_connection_stubs` converts/restores paired references for an existing logical cable. Reread ids after conversion. `update_stub` edits presentation labels and placement (coordinates relative to its parent room); empty label restores automatic counterpart text. `delete_connection` cascades both legs and labels.
- `rename_ports` changes only labels on a Device instance and preserves Port ids/Connections and library data.
- `set_connection_properties` exposes cable, endpoint and bundle labels, colour and line style. Linked legs share appearance; cable metadata remains on the canonical source leg. `set_connection_waypoints` edits absolute routing points; empty array clears them.
- `get_schematic` / `get_device` include `absoluteBounds` (x/y/w/h), `geometryMeasured` and `portCoordinates` (portId, handleId, side, absX, absY). Use both faces for bidirectional Ports. Bounds/Port geometry use editor estimates until measured; original `position` remains parent-relative. Use auto-routing first; manual waypoints are a fix-up.
- `configure_sheet` reads/patches existing paper, orientation, scale, title fields, signal colours and legend. `titleBlock.logo` accepts an image URL, /asset path or image data URI; empty text clears it. The existing layout must contain a logo cell to display it. `offset: {x,y}` sets the page-grid origin in absolute canvas coordinates without moving Devices. The result adds `pageCount` and `pages`, each with `rect`, `drawingArea`, `titleBlock` and nullable `legend` rectangles (x/y/w/h, canvas pixels). `referencePage` supplies geometry before placing content on an empty canvas. Settings follow existing persistence; sheet-settings undo and page-specific print layouts are not added.
- Call `configure_sheet({fitToSheet: "preview"})` or `"apply"` separately after configuring paper. Preview returns scale, offset, fit status, content bounds and overflow; apply refuses content too large for the minimum scale. It includes routed Connections and centres content inside the drawing area. Inspect print capture for legend/notes collisions; the helper does not move Devices or route cables.
- `capture_canvas` returns a native MCP PNG image without downloading, maximum dimension 1600px. Default `view: "canvas"` shows the canvas. `view: "print", page: 1` shows that 1-based page with frame, title block, legend and page edges. It uses the existing print-view artwork and leaves the user's viewport/print toggle unchanged. Invalid/nonexistent pages and an empty canvas return errors. Remote logos need to be accessible to the browser/capture; an embedded image is the most reliable option.

Bundle labels do not create individual cable records, physical splitters or junction dots. Model actual splitters as Devices when needed. Layout review uses the canvas image and assistant guidance; no automated geometry audit is claimed. Hardware specifications must still come from verified manufacturer information.

Local stdio connections run on the laptop with token pairing. The shared office connection runs on the VPS with Cloudflare staff sign-in and a separate active editor for each account. Both use the same tools. Pairing stays in memory and turns off on reload.

## Shared office connector

Production uses **https://schematic-mcp-production.tateside.online/mcp**, paired
only with `https://schematic.tateside.online`. It runs independently on loopback
8793 as `easyschematic-office-production.service` from the pinned production
release. The hostname below remains the **test** connector. Use the URL displayed
by the editor's AI preferences, and register production separately in your assistant.
See `../PRODUCTION_DEPLOYMENT.md` for the protected configuration and rollback.

Use `https://schematic-mcp.tateside.online/mcp` in Grok or a remote MCP client. Sign in through Cloudflare Access with your TateSide account. In the test editor, open **Preferences → AI (Beta) → Connect my office account**, sign in with the same account, and connect the schematic. No laptop server or pairing token is needed. Keep the editor tab open. A second paired tab replaces only that account's connection. Library publication still requires human review.

The VPS runs `dist/office-main.js` on loopback port 8792 under `easyschematic-office.service`. Install `deploy/office.service` as the systemd unit and build with `npm ci --prefix mcp-server && npm test --prefix mcp-server`. Its protected `/etc/easyschematic-office.env` contains `EASYSCHEMATIC_ACCESS_ISSUER`, `EASYSCHEMATIC_ACCESS_AUDIENCE`, `EASYSCHEMATIC_OFFICE_EDITOR_ORIGINS`, and `EASYSCHEMATIC_BUILD_HASH`. Cloudflare Tunnel routes the exact hostname to that loopback service; Cloudflare Access supplies managed OAuth and restricts access to verified `tateside.com` email accounts. The origin also verifies the JWT signature, issuer, audience, expiry and staff identity. Connections close when their Access session expires; reconnect in Preferences.

OAuth access tokens last 15 minutes and refresh grants last up to 30 days, with Access policy re-evaluation on refresh. Allowed remote-client callbacks are restricted to Grok/xAI and Claude HTTPS URLs. The service stores no grants or pairing secrets; restarting disconnects editors, which reconnect automatically while their Access session is valid.

## Build and test

### Checking an office connection

In Preferences → AI (Beta), compare the exact connector URL with the URL configured
in Claude/Grok. Production is `https://schematic-mcp-production.tateside.online/mcp`;
test is `https://schematic-mcp.tateside.online/mcp`. These select environments, not
assistant platforms. They deliberately cannot reach each other's editor tabs.

After the relay handshake, Preferences shows the verified office email and the
last assistant tool call received by this tab. Use the same email in the assistant.
An empty/unsaved schematic is supported: routing uses the active tab's WebSocket,
not a saved schematic ID. Pairing is held only in browser/process memory, and a
reload disables it. Another tab takes over only that account in that environment.

The connector's authenticated `/status` route reports only the caller's email,
editor origin and connection condition. Tool errors distinguish an account never
linked in this process, a relay that has disconnected/not completed its handshake,
expired editor sign-in, and an unresponsive editor. They identify the MCP account
and served editor environment. A different account is not inferred from other
staff members' connections; compare the MCP error's email with Preferences.

On the VPS, `journalctl -u easyschematic-office-production` records
`office_pair_sign_in`, `office_editor_connected`, `office_mcp_call`, disconnections
and rejected authentication/upgrades. Compare the signed Access email/subject on
the editor and MCP events. Routing uses normalized email; subject is verified but
is not the routing key. JWT issuer, audience and expiry remain validated on both
paths. Logs exclude JWTs, cookies, command arguments and schematic contents.

Use Node 24 from the repository root:

```sh
npm ci --prefix mcp-server
npm test --prefix mcp-server
```

The main frontend build includes the editor bridge. CI builds and tests this separate server too. After updating its source, rebuild before restarting your assistant.

## Grok website / app connector (Windows)

Grok's web connector calls a public HTTPS MCP URL, so it cannot use the stdio entry point or the editor's localhost WebSocket directly. The optional `dist/http.js` entry point exposes the same tools with Streamable HTTP and OAuth, using the existing workstation bridge and protected pairing token. Codex and Claude's stdio setup remains supported.

1. Install Node.js 24 and Cloudflare's official `cloudflared` client (if needed: `winget install --id Cloudflare.cloudflared`). Run `npm ci --prefix mcp-server` and `npm test --prefix mcp-server`.
2. Run `./mcp-server/start-grok.ps1`. It starts hidden HTTP/tunnel processes, protects their state/log directory, and prints the connector URL.
3. Sign in at [Grok Connectors](https://grok.com/connectors), choose **New Connector → Custom**, and enter that URL. For Business/Enterprise, a team admin first provisions the URL in the xAI console.
4. On the EasySchematic authorization page, review the requested access, run `./mcp-server/copy-pairing-token.ps1`, paste the existing token, and choose **Allow Grok access**. This issues a separate OAuth token; the pairing token is not sent to Grok. It travels through the Cloudflare tunnel to your local server during approval. Only HTTPS Grok/xAI callbacks can register. Requests use PKCE and expiring tokens; refresh consent lasts up to 24 hours. Server restart revokes its grants.
5. Pair the test editor on **8765**, using the same existing token, then ask Grok for a Jetbuilt P number and a room. This connection shares the paired editor with Codex. Shared-library publication still happens through human review in EasySchematic.

Keep the workstation and tunnel running. The temporary URL changes on restart, requiring an updated Grok connector. Stop both managed processes with `./mcp-server/start-grok.ps1 -Stop`. A stable office-wide connector needs a permanent hostname and per-user routing; this entry point is deliberately for one workstation and one paired editor. It does not deploy any VPS or frontend change.

References: [Grok custom connectors](https://docs.x.ai/grok/connectors), [tunnel requirements](https://docs.x.ai/grok/connectors/custom-mcp-tunneling), [team connector management](https://docs.x.ai/grok/connector-management).

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

Restart/reload the assistant so it starts the server. Claude Code and Claude Desktop share port 8766 through the authenticated relay when both run the updated build. Codex and Claude use different ports; choose which controls the editor with the port setting. Sean's configured hosted Origins are **https://testschematic.tateside.online** and **https://schematic.tateside.online**. Restart the assistant to pick up origin changes; existing processes retain their original configuration.

1. Copy the token without printing it by running `mcp-server/copy-pairing-token.ps1` in PowerShell.
2. Open testschematic and the schematic you want to work on; choose **File → Preferences → AI (Beta)**.
3. Paste the token, set **8765 for Codex** or **8766 for Claude**, and enable **Let my AI assistant read and edit this schematic**.
4. Wait for **Connection: connected**, then close Preferences.
5. Ask the assistant to inspect the schematic, or open **File → New** first to build from scratch. Normal undo and autosave apply to edits.

Example: “Create a meeting-room schematic with a display, conferencing codec and network switch. Search our library first, connect compatible ports, and propose any missing devices for my review.”

Allow local-network access if the browser requests it. Only one editor tab can control a port; enabling another supersedes the first. To switch assistants, disable the toggle, change the port, and enable it again. Multiple assistant chats on the same port share the first process's authenticated editor connection. Each chat still has its own MCP stdio process; additional processes relay tool calls through the port owner using the same pairing token.

If the editor says connected but a chat reports no editor, check which process owns port 8765 and whether additional processes are running an old build. Older builds logged `EADDRINUSE` but continued serving disconnected tools. Rebuild and reload those MCP processes to load the sharing fix; repeatedly reconnecting the editor cannot repair an old process that failed to bind its port. If the port owner exits, reload the MCP sessions and reconnect the editor.

## Device make/model headers

Existing schematics keep their appearance until enabled:

```json
{"deviceHeader":{"showManufacturerModel":true}}
```

Pass this to `configure_sheet`. The first line uses the Device label; the second combines manufacturer/model without repeating a manufacturer already at the start of the model. The default device-type subtitle hides when the second line is present. `showDeviceType` explicitly shows or hides it; omitted visibility uses the automatic behavior. Preferences provides the same saved sheet controls.

`set_device_property({nodeId,properties:{headerLine2:"Samsung – model TBC"}})` replaces the computed second line when enabled. Empty text restores the computed value. Per-Device `showManufacturerModel`/`showDeviceType` booleans override sheet defaults; these controls are also in Device Properties. Feathers never show a make/model line. Width stays fixed, long text has an ellipsis and tooltip, and `get_device`/`get_schematic` return full `displayHeader` lines. Canvas, print capture and DXF use the same header rules.

Set `showManufacturerModel:false` to disable the second line. If you explicitly hid the subtitle, also set `showDeviceType:true` to restore it. Local-template reuse returns `ignoredFields` and a warning when supplied identity/display fields differ; `overrideExisting:true` creates a separate corrected template.

## Missing devices

Search existing templates first, then read `get_library_taxonomy` and research official manufacturer specifications using the assistant's own browsing tools. Never invent ports or dimensions; include evidence and record uncertainty.

**Default: `create_local_device`.** This validates and saves a local custom device in the current browser, then places it immediately. No Library Doctor approval is needed. It returns the template, placed instance ports and `portIdMap` for wiring. Use `placeOnCanvas=false` to save only the template. Matching existing identities are reused without overwriting them, with warnings for differing ports; use `overrideExisting=true` to create a separate corrected local template.

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
