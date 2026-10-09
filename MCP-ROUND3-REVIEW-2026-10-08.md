# EasySchematic MCP Round 3

Implemented locally in `staging-candidate`; not deployed. The catalog now contains **45 tools** (previously 43), with MCP server version **0.2.0**.

## Changes

1. `create_local_device({overrideExisting:true,...})` creates a separate local template even when manufacturer/model match. Default reuse reports supplied-versus-existing port differences. Creation returns placed instance ports and `portIdMap` from template IDs to instance IDs.
2. Ordinary USB-A/B/C, HDMI/mini-HDMI and DisplayPort/mini-DisplayPort cables pass connector compatibility checks. Signal and direction checks remain in place.
3. Feather room placement verifies actual parenting. `move_device` correctly interprets room-relative coordinates for parented Devices and feathers.
4. Feather creation preserves exact requested coordinates and returns `portCoordinates`.
5. New `update_room` supports label, absolute x/y together, width/height, or `fitToChildren:true` with optional padding. Fit preserves child absolute positions. `delete_room` preserves and unparents children and retains Connections; undo restores containment.
6. Notes accept width/height; omitted height sizes conservatively for text. Size-only updates preserve rich HTML. Explicit heights that would truncate text are rejected before mutation.
7. `configure_sheet({titleBlockLayout:"tateside",...})` applies a layout with logo, company, client, project, drawing title, drawing number, revision, date, drawn by, scale and page. Existing showName/venue/designer fields supply project/client/drawn by. Long titles shrink to their cell width; custom drawing number and scale fields are resolved by ID or label.
8. `configure_sheet({legend:{labels:{ethernet:"CAT6 / TPX",expansion:"CAT6 / TPX"}}})` renames legend entries. Equal labels merge when colour and line style also match. Saved schematics and print/PDF/DXF legends retain labels; cable data is unchanged.
9. Tool schemas and playbook guidance reflect the new controls. Initialization advertises catalog-change support and sends a change notification. Already-running old MCP processes must still be restarted; client-side schema caching can require reconnection.

Sheet fitting now waits for pending route updates, preventing stale Connection routes from shrinking the drawing after a Device move.

## Verification

- Lint and frontend build passed.
- 285 application tests and 17 MCP tests passed.
- 12 Playwright browser tests passed, including exact feather placement, room moves/fit/delete, real USB Connection compatibility, full seven-line note rendering, title fields, merged legend, routing-aware fit and print capture.
- Print capture was visually inspected using a fixture logo and a long title.

## Limits

The shared TX20, RX107, Neat Bar Pro and Samsung library records were not changed. This implements the corrected-local-template route; manufacturer verification and shared-library publication remain separate work. The real Tateside logo asset and Joby's source PDF were not supplied, so those exact assets were not verified. The user's live schematic was not modified.
