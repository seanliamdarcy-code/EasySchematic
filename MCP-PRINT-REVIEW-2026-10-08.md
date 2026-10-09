# MCP print and geometry update

Implemented locally in `staging-candidate` in response to Update 2. No hosted deployment, live canvas deletion, library changes, or skill replacement was performed. Claude's new separate Tateside skill remains the plan; Joby's PDF skill is unchanged.

## Calls for the new skill

```js
configure_sheet({ paperId: "iso-a3", orientation: "landscape",
  titleBlock: { company: "Tateside", showName: "Project", venue: "Client",
    designer: "Drawn by", date: "08.10.26", revision: "A",
    customFields: [{ id: "drawing-no", label: "Drawing No.", value: "TS-AV-ROOM-001" },
      { id: "scale", label: "Scale", value: "NTS" }] } })
configure_sheet({ offset: { x: -100, y: -100 } })
configure_sheet({ fitToSheet: "preview" })
configure_sheet({ fitToSheet: "apply" })
capture_canvas({ view: "print", page: 1 })
```

- `configure_sheet` returns `pageCount`, `offset`, and `pages` with 1-based `page` and `rect`, `drawingArea`, `titleBlock`, and nullable `legend` rectangles. All rectangles use absolute canvas pixels and x/y/w/h. `referencePage` provides a sheet geometry reference even when pageCount is zero on an empty canvas.
- Offset is the page-grid origin, not a Device translation. Fit preview does not mutate settings; apply sets scale/offset without moving Devices. Configure paper first, then call fit separately. Fit includes routed Connection waypoints, reports overflow and refuses apply when content cannot fit within the existing scale limits (0.25–2). It does not resolve legend/notes collisions.
- `get_schematic` and `get_device` now provide `absoluteBounds`, `geometryMeasured`, and `portCoordinates` with portId/handleId/side/absX/absY. Coordinates include room-parent offsets and both bidirectional faces. Original position is still parent-relative. Unmeasured geometry uses the editor's estimates. Prefer auto-routing; use manual waypoints only for fixes calculated from these coordinates.
- External endpoints are service references: signal/direction rules still apply, but physical connector mismatch no longer triggers an adapter. Real Device-to-Device checks remain intact. Connector metadata is retained rather than silently rewritten.
- `titleBlock.logo` accepts an image URL, /asset path, image data URI, or empty text to clear. Existing title-block layout cells control what is displayed: metadata/customFields alone do not add layout cells, including a logo cell. No Tateside logo asset was supplied. Remote assets need browser access; embedded images are more reliable for capture.
- Print capture uses the existing print-view frame/title-block/legend artwork. It returns a PNG up to 1600px, with no download and no print-toggle/viewport change. Page selection is 1-based, default 1. Empty/unmounted canvases and nonexistent pages return errors. This is visual QA, not an issued PDF.

## Verification

Lint and frontend build passed; the existing build chunk-size warning remains. All 279 application tests, 16 MCP tests and 12 isolated browser tests passed. Added coverage includes service-reference compatibility versus real hardware, nested absolute bounds and bidirectional Port faces, atomic sheet validation, logo metadata, fit preview/apply/overflow, real print PNG content and Connections, multipage selection and invalid-page errors. The fixture print PNG was visually inspected.

The original meeting-room example, reference PDF and Tateside logo were not supplied, so a comparison against Joby's PDF was not performed. The existing draft skill/archive has not been revised or repackaged; its previous canvas-only capture instructions need replacing in Claude's new skill. Bidirectional Port appearance and default application colours remain unchanged; house colours can be applied with signalColors as requested.
