---
name: tateside-easyschematic
description: Arrange and edit AV schematics in the connected EasySchematic editor using Tateside layout conventions. Use for room, rack, desk and signal-flow drawings through the EasySchematic MCP connector, including Jetbuilt P-number kit imports.
---

# Tateside layout in EasySchematic

Use EasySchematic's native appearance. Apply Joby's layout and engineering conventions through the connector; the editable drawing is the source for revisions. Follow the user's specified Connections. A kit list establishes equipment and quantities, not wiring. Do not replace this workflow with Python-generated PDFs unless the user explicitly requests a standalone drawing.

## Establish the drawing

Read `get_schematic` before editing. For a P number, use `search_jetbuilt_projects` then `get_jetbuilt_project`; present rooms and kit quantities and obtain the requested scope. `start_jetbuilt_schematic` takes exact room/item selections from that preview. It replaces the canvas: existing work must be saved and replacement explicitly requested before setting `replaceCurrent=true`.

Search templates first. For missing kit, read taxonomy and research official manufacturer information with your browsing tools, then use `create_local_device`. Preserve evidence and uncertainty. Read `get_device` for actual Port ids before wiring. Library publication remains a separate human review in Device Properties or Library Doctor.

If the required layout tools are absent, report the connector version gap. Do not approximate paired stubs by deleting electrical Connections or invent tool names.

## Layout and Connections

- Arrange sources → switching/extension → codec/DSP/processing → displays/speakers/destinations. For racks, functional columns often work better than physical rack order.
- Keep inputs on the left and outputs on the right. Retain physical Port definitions; don't flip an input merely to make a run tidy. Align Devices and choose separate routing lanes to reduce crossings.
- Group Devices into room, rack and desk enclosures with `create_room` and `place_device_in_room`. Creating rooms can absorb existing Devices; reread positions and parent ids afterward.
- Use `connect_devices_batch` for the user's wiring, checking each result. Re-read Ports after installing cards. Never invent missing Ports or silently substitute a different Connection.
- Keep routes orthogonal and clear of Devices and labels. `set_connection_waypoints` takes absolute canvas points; an empty list restores ordinary routing. Prefer adjusting layout or paired stubs to long return runs across a sheet.
- `rename_ports` changes labels only on an instance. Preserve all physical Ports and spare capacity; do not remove unused Ports for appearance. Grouped labels must not conceal separate independently wired Ports.

## Services, feathers and paired references

`add_external_endpoints` creates compact one-Port feathers in a best-effort batch. Specify label, actual signal/connector, direction and absolute position. An output feather feeds a Device input; an input feather receives a Device output. Bidirectional Ports require in/out faces when connecting. These are Devices: ordinary room placement and deletion tools apply. `update_external_endpoint` edits labels/positions; electrical changes require disconnection first.

Use feathers for networks, power and off-sheet destinations. Identify each network explicitly (CLIENT NETWORK, AV NETWORK, VIDEO NETWORK or DANTE as applicable), one feather per physical network Port. Mark PoE/PoE+ only when confirmed; don't add mains to a solely PoE-powered Device. DC-powered equipment retains its real DC Port and a note identifying the PSU and power source.

Identify power sources by PDU outlet where known. Label PDU outlets with their loads/spares and each powered Device with the corresponding outlet reference. Keep redundant PSUs separate. For extension leads, note capacity and connected loads. Leave space inside enclosures so feathers don't cross their borders.

`set_connection_stubs(enabled=true)` converts an existing cable into paired references without losing topology. Reread Connection/stub ids afterward. `update_stub` sets label, placement, Port/room display and page reference mode; coordinates are parent-relative. An empty label restores automatic counterpart text. Set labels at each end to identify its destination and circuit when useful. `set_connection_stubs(enabled=false)` restores the continuous cable. Deleting either leg with `delete_connection` deletes the whole pair.

## Annotation and review

Use `set_connection_properties` for cable ids, per-end labels, lengths, bundle descriptions, colour and line style. Bundle text such as "8x CAT6" does not create eight cable records, sending-card arithmetic or a physical splitter/junction; represent actual splitting equipment as Devices.

Keep EasySchematic's default colours unless requested otherwise. Optional house colours: network/CAT6 black #111111, HDMI #8B1E3F, USB #B0007A, Dante #1F6FB2, analogue #7B3FA0, speaker #C05A00, power #1E7B34. A visual colour must not change electrical signal type.

Use notes for network assignment, power/PSU location, speaker circuits, spare capacity, engineering assumptions and unresolved items. Raise hardware conflicts with the user before changing their wiring. Don't treat a historical port list or reference PDF as verified manufacturer specifications.

`configure_sheet` reads/patches existing paper, orientation, scale, title metadata, colours and legend. A3 is `iso-a3`; use only colours relevant to the drawing. Preserve existing title information when updating individual fields. Settings use the editor's existing persistence; no new PDF template is needed.

Inspect `capture_canvas` after editing. Check overlap, readability, crossings, enclosure containment and misleading references, then correct problems. It returns the current canvas PNG, not the print title block or other pages. There is no automated geometry audit. PDF export/publishing remains the editor workflow; don't claim a PDF has been issued from a canvas capture. Report what changed and remaining assumptions briefly.
