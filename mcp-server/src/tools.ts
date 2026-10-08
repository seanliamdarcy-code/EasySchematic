/**
 * MCP tool catalog: the Ship-1 "working core" tools, the Ship-2 "editing & layout"
 * tools (move_device, delete_connection), the Ship-3 "batch" tools (add_devices,
 * connect_devices_batch), the Ship-4 "rooms" tools (create_room,
 * place_device_in_room), the Ship-5 "annotations" tool (add_note), the Ship-6
 * "slots / modular chassis" tools (list_slot_cards, install_card, remove_card), and the
 * Ship-7 "racks / rack elevation" tools (list_racks, create_rack, place_device_in_rack,
 * remove_device_from_rack), the Ship-8 "notes" tools (update_note, delete_note;
 * get_schematic also reports rooms + notes), and the Ship-9 "batch structural" tools
 * (install_card_batch, place_device_in_rack_batch). Each entry is a plain JSON-Schema tool
 * definition; the call is relayed verbatim to the editor over the bridge, which validates
 * and executes it against the live store.
 *
 * In AV terms the user sees Device / Connection / Port; these tool names and the
 * docs use the same AV language.
 */
export interface ToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

const noArgs = { type: "object", properties: {}, additionalProperties: false };
const str = { type: "string" };
const num = { type: "number" };
const endpointFields = { label: str, x: num, y: num, direction: { enum: ["input", "output", "bidirectional"] }, signalType: str, connectorType: str };
const toolObject = (properties: Record<string, unknown>, required: string[] = []) => ({ type: "object", additionalProperties: false, properties, required });

const templateSchema = { type: "object", required: ["manufacturer", "modelNumber", "label", "shortName", "category", "deviceType", "ports"], additionalProperties: false,
        properties: { manufacturer: {type: "string"}, modelNumber: {type: "string"}, label: {type: "string"}, shortName: {type: "string"}, category: {type: "string"}, deviceType: {type: "string"},
          roleTags: {type: "array", items: {type: "string"}}, deviceCapabilities: {type: "array", items: {type: "string"}}, protocols: {type: "array", items: {type: "string"}},
          heightMm: {type: "number"}, widthMm: {type: "number"}, depthMm: {type: "number"}, weightKg: {type: "number"}, rackForm: {enum: ["full", "half", "shelf-only"]},
          searchTerms: {type: "array", items: {type: "string"}}, referenceUrl: {type: "string"},
          ports: {type: "array", maxItems: 500, items: {type: "object", required: ["id", "label", "connectorType", "signalType", "direction"],
            properties: {id: {type: "string"}, label: {type: "string"}, section: {type: "string"}, connectorType: {type: "string"}, signalType: {type: "string"}, direction: {enum: ["input", "output", "bidirectional", "passthrough"]}}} } } };

export const TOOLS: ToolDef[] = [
  { name: "add_external_endpoints", description: "Create service/off-sheet feathers in a batch: AV NETWORK, MAINS POWER, BYOD, speaker destinations. These are compact one-Port Devices, never library templates. Specify signal/connector metadata and direction. Feathers are service references: signal/direction checks apply, physical connector matching does not; real Device-to-Device rules remain unchanged. Direction: output feeds a Device input; input receives a Device output; bidirectional uses in/out faces. Coordinates are absolute canvas coordinates. Returns independent ids/Ports; wire using connect_devices_batch and group with place_device_in_room. Best-effort per-item results. Delete with delete_device.", inputSchema: toolObject({ endpoints: { type: "array", minItems: 1, maxItems: 100, items: toolObject(endpointFields, ["label", "x", "y", "signalType", "connectorType", "direction"]) } }, ["endpoints"]) },
  { name: "update_external_endpoint", description: "Edit a compact external endpoint label or absolute canvas position. Direction/signal/connector edits are allowed only while disconnected. Retains its Port id. To delete use delete_device.", inputSchema: toolObject({ nodeId: str, ...endpointFields }, ["nodeId"]) },
  { name: "rename_ports", description: "Rename existing Ports on one Device instance without changing their ids, signal types, directions or Connections. Never edits the shared library. Read get_device first; supply actual portIds. Rejects the whole request if any id is invalid or duplicated.", inputSchema: toolObject({ nodeId: str, ports: { type: "array", minItems: 1, maxItems: 500, items: toolObject({ portId: str, label: str }, ["portId", "label"]) } }, ["nodeId", "ports"]) },
  { name: "set_connection_stubs", description: "Convert an existing Connection into paired stubs/feathers (enabled=true), or restore its continuous run (false). Preserves the logical cable and real Device Ports. Conversion changes Connection ids; reread get_schematic afterward. Does not create a new electrical Connection. Deleting either leg via delete_connection deletes the complete pair.", inputSchema: toolObject({ connectionId: str, enabled: { type: "boolean" } }, ["connectionId", "enabled"]) },
  { name: "update_stub", description: "Move a paired stub label and configure counterpart Port/room/page display. Coordinates are relative to its parentId, or absolute if no parent. label overrides the counterpart name/Port/room text; an empty label restores automatic text. Electrical linkage stays intact.", inputSchema: toolObject({ stubId: str, label: str, x: num, y: num, showPort: { type: "boolean" }, showRoom: { type: "boolean" }, pageMode: { enum: ["always", "cross-page", "never"] } }, ["stubId"]) },
  { name: "set_connection_properties", description: "Set Connection labels, per-end labels, cableId, cableLength, multicableLabel (e.g. 8x CAT6), color or lineStyle. Does not change topology or compatibility. A bundle label describes an existing run; it does not create individual cables or a physical tee/junction. For paired-stub presentation text use update_stub.label. Color is #RRGGBB.", inputSchema: toolObject({ connectionId: str, properties: toolObject({ label: str, sourceLabel: str, targetLabel: str, cableId: str, cableLength: str, multicableLabel: str, color: str, lineStyle: { enum: ["solid", "dashed", "dotted", "dash-dot"] } }) }, ["connectionId", "properties"]) },
  { name: "set_connection_waypoints", description: "Set manual routing points in absolute canvas coordinates, preserving the editor's orthogonal router. An empty array clears manual routing. Use auto-routing first. Read get_device/get_schematic absoluteBounds and portCoordinates to calculate points, never guess from parent-relative position. Inspect capture_canvas for crossings and readability.", inputSchema: toolObject({ connectionId: str, waypoints: { type: "array", maxItems: 100, items: toolObject({ x: num, y: num }, ["x", "y"]) } }, ["connectionId", "waypoints"]) },
  {
    name: "configure_sheet",
    description: "Read settings, pageCount and page/drawing-area/title-block/legend rectangles in absolute canvas coordinates. referencePage gives geometry on an empty canvas. Patch paper/orientation/scale, offset (page-grid origin in canvas coordinates), title fields, colours and legend. A3 is iso-a3. logo accepts an image URL, /asset path or image data URI; empty text clears it. showName is project, venue is client/location, designer is drawn by. customFields replaces metadata; existing layout cells refer to ids. Call fitToSheet=preview or apply separately after configuring paper: fits content and routed Connections on one page within scale limits; inspect print capture for legend collisions. No PDF/download/external save. Uses existing persistence; page-specific print layouts remain separate.",
    inputSchema: toolObject({
      paperId: str,
      orientation: { enum: ["landscape", "portrait"] },
      scale: { type: "number", minimum: 0.25, maximum: 2 },
      offset: toolObject({ x: num, y: num }, ["x", "y"]),
      fitToSheet: { enum: ["preview", "apply"] },
      titleBlock: toolObject({ showName: str, venue: str, designer: str, engineer: str, date: str, drawingTitle: str, company: str, revision: str, logo: str,
        customFields: { type: "array", maxItems: 50, items: toolObject({ id: str, label: str, value: str }, ["id", "label", "value"]) } }),
      signalColors: { type: "object", additionalProperties: str },
      legend: toolObject({ enabled: { type: "boolean" }, corner: { enum: ["top-left", "top-right", "bottom-left", "bottom-right"] },
        columns: { type: "integer", minimum: 1, maximum: 4 }, page: { enum: ["first", "last", "all"] } }),
    }),
  },
  { name: "capture_canvas", description: "Return a PNG image to inspect Device spacing, routing and labels. view=print includes page edges, frame, title block and legend; page is 1-based, default 1. Read configure_sheet for pageCount/geometry. Read-only; no download or on-screen view change. Maximum dimension 1600 pixels. An empty/unmounted canvas or invalid page returns an error.", inputSchema: toolObject({ view: { enum: ["canvas", "print"] }, page: { type: "integer", minimum: 1 } }) },
  { name: "search_jetbuilt_projects", description: "Read-only project search by P number, name or Jetbuilt id through the paired editor's authenticated API. Returns project ids for get_jetbuilt_project. Never changes the canvas or writes Jetbuilt.", inputSchema: {
    type: "object", additionalProperties: false, required: ["query"], properties: { query: { type: "string", minLength: 1 } }
  } },
  { name: "get_jetbuilt_project", description: "Read a Jetbuilt project's room/kit list, quantities, library matches, possible matches and unresolved bundles. Use a projectId from search_jetbuilt_projects. Returns previewId and itemIds for start_jetbuilt_schematic; no canvas change. Preview is held only in this editor tab (latest three previews). Ask which rooms/kit the user wants before starting.", inputSchema: {
    type: "object", additionalProperties: false, required: ["projectId"], properties: { projectId: { type: "string", minLength: 1 } }
  } },
  { name: "start_jetbuilt_schematic", description: "Start a NEW schematic from a reviewed Jetbuilt preview, optionally limited to exact room names and itemIds. Separate instances are placed for quantities by default. Exact library matches are placed; unmatched kit is returned for official research and create_local_device (its room container is created). includeUnmatched=true instead places portless placeholders. Does not save/publish externally. Replaces the open schematic: read get_schematic first, have the user save existing work, and set replaceCurrent=true only on their explicit instruction. Refuses unknown selections and expired previews.", inputSchema: {
    type: "object", additionalProperties: false, required: ["previewId"], properties: {
      previewId: { type: "string", minLength: 1 }, name: { type: "string", minLength: 1 },
      rooms: { type: "array", minItems: 1, maxItems: 1000, items: { type: "string", minLength: 1 } },
      itemIds: { type: "array", minItems: 1, maxItems: 1000, items: { type: "string", minLength: 1 } },
      replaceCurrent: { type: "boolean", default: false }, expandQuantities: { type: "boolean", default: true }, includeUnmatched: { type: "boolean", default: false }
    }
  } },
  { name: "create_local_device", description: "Default for a missing device: research official specifications, then create a LOCAL custom device and place it immediately, without Library Doctor approval. Search existing templates first; exact matches are reused. Never invent ports or specifications. Saved in this browser and included with schematic saves/exports; never published to the shared library. Read get_device afterward for actual port ids. Set placeOnCanvas=false to save only the template.", inputSchema: {
    type: "object", additionalProperties: false, required: ["template"], properties: {
      template: { ...templateSchema, properties: { ...templateSchema.properties,
        classificationConfidence: {enum: ["high", "medium", "low"]},
        evidenceRefs: {type: "array", items: {type: "object", properties: {type: {type: "string"}, url: {type: "string"}, title: {type: "string"}, excerpt: {type: "string"}, note: {type: "string"}}}},
        identityAliases: {type: "array", items: {type: "string"}} } },
      x: {type: "number"}, y: {type: "number"}, placeOnCanvas: {type: "boolean", default: true}
    }
  } },
  { name: "get_library_taxonomy", description: "Read active device taxonomy before creating or proposing a missing device. Use exact values returned.", inputSchema: noArgs },
  { name: "get_device_proposal", description: "Check human review and publication status of a missing-device proposal.", inputSchema: { type: "object", required: ["proposalId"], properties: { proposalId: {type: "string"} }, additionalProperties: false } },
  { name: "add_approved_device", description: "Place a missing device ONLY after human acceptance and explicit publication in Library Doctor. This tool never approves or publishes.", inputSchema: { type: "object", required: ["proposalId"], properties: { proposalId: {type: "string"}, label: {type: "string"}, x: {type: "number"}, y: {type: "number"} }, additionalProperties: false } },
  { name: "propose_missing_device", description: "Create a review proposal only. First search_templates, read taxonomy, and research official manufacturer documentation using your browsing tools. Never invent ports or dimensions. Quality gates are caller declarations; set them only after verification. A human must accept and Publish approved device in Library Doctor before placement.", inputSchema: {
    type: "object", additionalProperties: false,
    required: ["proposedTemplate", "evidenceRefs", "rationale", "classificationConfidence", "qualityGates"],
    properties: {
      proposedTemplate: templateSchema,
      identityAliases: {type: "array", items: {type: "string"}}, operationalNotes: {type: "array", items: {type: "string"}},
      evidenceRefs: {type: "array", minItems: 1, items: {type: "object", required: ["type", "url"], properties: {type: {type: "string"}, url: {type: "string"}, title: {type: "string"}, excerpt: {type: "string"}, note: {type: "string"}}}},
      rationale: {type: "string"}, classificationConfidence: {enum: ["high"]},
      qualityGates: {type: "object", additionalProperties: false, required: ["identityVerifiedByCaller", "officialEvidenceDeclaredByCaller", "noValidDataOmittedConfirmedByCaller", "dimensionsDeclaration", "physicalPortsDeclaration"],
        properties: {identityVerifiedByCaller: {enum: [true]}, officialEvidenceDeclaredByCaller: {enum: [true]}, noValidDataOmittedConfirmedByCaller: {enum: [true]}, dimensionsDeclaration: {enum: ["complete", "unavailable"]}, physicalPortsDeclaration: {enum: ["complete", "not-applicable"]}}}
    }
  } },
  {
    name: "get_schematic",
    description:
      "Get a summary of the current schematic: its name, every device (with ports), every connection, every room (container) and every note (text annotation). Devices include absoluteBounds (x/y/w/h), geometryMeasured, and portCoordinates (portId/handleId/side/absX/absY) for routing. position remains parent-relative; geometry uses estimates until measured. Includes sheet geometry/pageCount. Call this first to see what already exists. Note ids and room ids here feed update_note/delete_note and place_device_in_room.",
    inputSchema: noArgs,
  },
  {
    name: "list_devices",
    description: "List the devices on the canvas with their ids, labels, type, manufacturer and position.",
    inputSchema: noArgs,
  },
  {
    name: "get_device",
    description:
      "Get one device's details: absoluteBounds (x/y/w/h), geometryMeasured, portCoordinates (portId/handleId/side/absX/absY, both faces for bidirectional Ports) and parent-relative position. Geometry uses estimates until measured. Includes its ports (id, label, direction, signal type) and, for a modular chassis, its slots (id and slot family) â€” the slotId values that list_slot_cards and install_card need.",
    inputSchema: {
      type: "object",
      properties: { nodeId: { type: "string", description: "The device id." } },
      required: ["nodeId"],
      additionalProperties: false,
    },
  },
  {
    name: "search_templates",
    description:
      "Search the device template library (community library + this schematic's custom devices) by name, type or manufacturer. Returns templateId values to pass to add_device.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Free-text search, e.g. 'crestron switcher' or 'display'." },
        limit: { type: "number", description: "Max results (default 25)." },
      },
      required: ["query"],
      additionalProperties: false,
    },
  },
  {
    name: "add_device",
    description:
      "Add a device to the canvas from a template. Use search_templates to get a templateId. Returns the new device's id.",
    inputSchema: {
      type: "object",
      properties: {
        templateId: { type: "string", description: "Template id from search_templates." },
        label: { type: "string", description: "Optional custom name; defaults to the template name." },
        x: { type: "number", description: "Optional canvas X position." },
        y: { type: "number", description: "Optional canvas Y position." },
      },
      required: ["templateId"],
      additionalProperties: false,
    },
  },
  {
    name: "set_device_property",
    description:
      "Set safe properties on a device (e.g. label, shortName, manufacturer, modelNumber, note, serialNumber, unitCost, power figures). Structural fields like ports and slots are not editable in this Beta and are rejected.",
    inputSchema: {
      type: "object",
      properties: {
        nodeId: { type: "string", description: "The device id." },
        properties: {
          type: "object",
          description: "Map of field name to new value (string, number or boolean).",
        },
      },
      required: ["nodeId", "properties"],
      additionalProperties: false,
    },
  },
  {
    name: "connect_devices",
    description:
      "Create a connection from one device's port to another's. For two-sided ports give the face: bidirectional ports use 'in'/'out'; passthrough ports use 'rear'/'front'. Plain ports need no face. The connection is validated before it is made.",
    inputSchema: {
      type: "object",
      properties: {
        sourceNodeId: { type: "string" },
        sourcePortId: { type: "string" },
        sourceFace: { type: "string", enum: ["in", "out", "rear", "front"], description: "Required only for two-sided source ports." },
        targetNodeId: { type: "string" },
        targetPortId: { type: "string" },
        targetFace: { type: "string", enum: ["in", "out", "rear", "front"], description: "Required only for two-sided target ports." },
      },
      required: ["sourceNodeId", "sourcePortId", "targetNodeId", "targetPortId"],
      additionalProperties: false,
    },
  },
  {
    name: "delete_device",
    description: "Delete a device (and its connections) from the canvas.",
    inputSchema: {
      type: "object",
      properties: { nodeId: { type: "string", description: "The device id." } },
      required: ["nodeId"],
      additionalProperties: false,
    },
  },
  {
    name: "move_device",
    description:
      "Reposition a device on the canvas. x and y are in the same coordinate space get_device/get_schematic report for that device â€” canvas coordinates for a top-level device, or coordinates relative to its room/rack when the device has a parentId. This moves the device within its current container; it does not move a device into or out of a room or rack.",
    inputSchema: {
      type: "object",
      properties: {
        nodeId: { type: "string", description: "The device id." },
        x: { type: "number", description: "New X position." },
        y: { type: "number", description: "New Y position." },
      },
      required: ["nodeId", "x", "y"],
      additionalProperties: false,
    },
  },
  {
    name: "delete_connection",
    description:
      "Remove a Connection by its id. For paired stubs, removes both legs and both labels as one logical cable; Device Ports remain intact.",
    inputSchema: {
      type: "object",
      properties: {
        connectionId: { type: "string", description: "The connection (edge) id to remove." },
      },
      required: ["connectionId"],
      additionalProperties: false,
    },
  },
  {
    name: "add_devices",
    description:
      "Add several devices to the canvas in one call â€” use this instead of repeated add_device calls when placing many devices. Best-effort: each device is added independently, and the result lists per-device success or failure (with the new device id) so you can retry only the ones that failed.",
    inputSchema: {
      type: "object",
      properties: {
        devices: {
          type: "array",
          minItems: 1,
          maxItems: 100,
          description: "The devices to add.",
          items: {
            type: "object",
            properties: {
              templateId: { type: "string", description: "Template id from search_templates." },
              label: { type: "string", description: "Optional custom name; defaults to the template name." },
              x: { type: "number", description: "Optional canvas X position." },
              y: { type: "number", description: "Optional canvas Y position." },
            },
            required: ["templateId"],
            additionalProperties: false,
          },
        },
      },
      required: ["devices"],
      additionalProperties: false,
    },
  },
  {
    name: "connect_devices_batch",
    description:
      "Make several connections in one call â€” use this instead of repeated connect_devices calls. Best-effort: each connection is attempted independently and the result lists per-connection success or failure. Connections are applied in array order, so an earlier one can affect a later one (for example, using up a single-link port). For two-sided ports give the face: bidirectional ports use 'in'/'out'; passthrough ports use 'rear'/'front'.",
    inputSchema: {
      type: "object",
      properties: {
        connections: {
          type: "array",
          minItems: 1,
          maxItems: 100,
          description: "The connections to make.",
          items: {
            type: "object",
            properties: {
              sourceNodeId: { type: "string" },
              sourcePortId: { type: "string" },
              sourceFace: { type: "string", enum: ["in", "out", "rear", "front"], description: "Required only for two-sided source ports." },
              targetNodeId: { type: "string" },
              targetPortId: { type: "string" },
              targetFace: { type: "string", enum: ["in", "out", "rear", "front"], description: "Required only for two-sided target ports." },
            },
            required: ["sourceNodeId", "sourcePortId", "targetNodeId", "targetPortId"],
            additionalProperties: false,
          },
        },
      },
      required: ["connections"],
      additionalProperties: false,
    },
  },
  {
    name: "create_room",
    description:
      "Create a room â€” a labelled container on the canvas that devices can be placed inside (use place_device_in_room). Returns the new room's id. width/height are optional (default 400x300; minimums 200x150). Any existing devices already inside the new room's bounds are absorbed into it and listed in absorbedDeviceIds (their coordinates become relative to the room, so re-read them before reusing old positions).",
    inputSchema: {
      type: "object",
      properties: {
        label: { type: "string", description: "The room's name, shown on the canvas." },
        x: { type: "number", description: "Room top-left X position on the canvas." },
        y: { type: "number", description: "Room top-left Y position on the canvas." },
        width: { type: "number", description: "Optional room width (minimum 200; default 400)." },
        height: { type: "number", description: "Optional room height (minimum 150; default 300)." },
      },
      required: ["label", "x", "y"],
      additionalProperties: false,
    },
  },
  {
    name: "place_device_in_room",
    description:
      "Place a device inside a room. x and y are the device's position relative to the room's top-left corner (default 16,16). The device's center must land inside the room or the call fails without changing anything, so a device is never reported as placed when it isn't. To reposition a device that is already in a room, use move_device instead.",
    inputSchema: {
      type: "object",
      properties: {
        deviceId: { type: "string", description: "The device id." },
        roomId: { type: "string", description: "The room id (from get_schematic or create_room)." },
        x: { type: "number", description: "Optional X relative to the room's top-left corner (default 16)." },
        y: { type: "number", description: "Optional Y relative to the room's top-left corner (default 16)." },
      },
      required: ["deviceId", "roomId"],
      additionalProperties: false,
    },
  },
  {
    name: "add_note",
    description:
      "Add a text note (a sticky-note card) to the canvas to annotate or explain the schematic. The text is shown literally (it is escaped, and line breaks are kept). Returns the new note's id. Notes can't yet be listed, edited, or deleted through the assistant â€” do that in the editor.",
    inputSchema: {
      type: "object",
      properties: {
        text: { type: "string", description: "The note's text. Shown literally; newlines become line breaks." },
        x: { type: "number", description: "Note top-left X position on the canvas." },
        y: { type: "number", description: "Note top-left Y position on the canvas." },
      },
      required: ["text", "x", "y"],
      additionalProperties: false,
    },
  },
  {
    name: "list_slot_cards",
    description:
      "List the expansion cards that fit a given slot on a modular device (chassis). A device's slots come from get_device. Returns the card templateId values to pass to install_card. If the full community library hasn't been loaded yet this session, call search_templates once first so live-library cards are included.",
    inputSchema: {
      type: "object",
      properties: {
        deviceId: { type: "string", description: "The modular device (chassis) id." },
        slotId: { type: "string", description: "The slot id from get_device's slots." },
      },
      required: ["deviceId", "slotId"],
      additionalProperties: false,
    },
  },
  {
    name: "install_card",
    description:
      "Install an expansion card into an empty slot on a modular device. Use list_slot_cards to get a compatible card templateId. The card's slot family must match the slot's, or the call is refused. If the slot already holds a card, remove it first with remove_card (installing never silently replaces a card). Returns the installed card and the ids of the ports it added.",
    inputSchema: {
      type: "object",
      properties: {
        deviceId: { type: "string", description: "The modular device (chassis) id." },
        slotId: { type: "string", description: "The empty slot's id from get_device's slots." },
        cardTemplateId: { type: "string", description: "A card templateId from list_slot_cards." },
      },
      required: ["deviceId", "slotId", "cardTemplateId"],
      additionalProperties: false,
    },
  },
  {
    name: "remove_card",
    description:
      "Remove the card from a filled slot on a modular device, emptying the slot. This also removes the card's ports and any connections on them. Fails if the slot is already empty.",
    inputSchema: {
      type: "object",
      properties: {
        deviceId: { type: "string", description: "The modular device (chassis) id." },
        slotId: { type: "string", description: "The filled slot's id from get_device's slots." },
      },
      required: ["deviceId", "slotId"],
      additionalProperties: false,
    },
  },
  {
    name: "list_racks",
    description:
      "List the rack elevations: every rack-elevation page, each rack on it (id, label, type, height in U, depth) and the devices currently placed in each rack (placementId, device, U position, face). Rack elevations are a separate view from the schematic canvas. Call this first to get the pageId/rackId/placementId values the other rack tools need.",
    inputSchema: noArgs,
  },
  {
    name: "create_rack",
    description:
      "Create an equipment rack. If pageId is omitted a new rack-elevation page is created to hold it; pass a pageId from list_racks to add the rack to an existing page. Returns the new pageId and rackId. Height (U) and depth (mm) are clamped to the editor's ranges (2â€“60U, 100â€“2000mm).",
    inputSchema: {
      type: "object",
      properties: {
        label: { type: "string", description: "Rack name (default \"Rack\")." },
        heightU: { type: "number", description: "Rack height in rack units (2â€“60, default 42)." },
        rackType: {
          type: "string",
          enum: ["floor-19", "wall-mount", "desktop", "open-2post", "open-4post"],
          description: "Rack enclosure type (default \"floor-19\").",
        },
        depthMm: { type: "number", description: "Rack depth in mm (100â€“2000, default 600)." },
        pageId: { type: "string", description: "Existing rack-elevation page id from list_racks. Omit to create a new page." },
        pageLabel: { type: "string", description: "Name for the new rack page (used only when pageId is omitted; default \"Rack Elevation\")." },
      },
      additionalProperties: false,
    },
  },
  {
    name: "place_device_in_rack",
    description:
      "Mount a device from the schematic into a rack at a U position. The device's height in U is inferred from its physical dimensions, and half-rack gear is placed on a free side automatically. Gear too small to rack-mount directly is placed on an auto-created 1U shelf (the response includes that shelfId; shelves are preserved when removing a device in this TateSide fork). Fails if the U span is occupied or out of the rack's bounds, if the device is already placed in a rack (remove it first), for a rear placement on a 2-post rack, or if the device is too wide to fit a 19\" rack. uPosition is 1-based from the bottom.",
    inputSchema: {
      type: "object",
      properties: {
        deviceId: { type: "string", description: "The device id from get_schematic / list_devices." },
        rackId: { type: "string", description: "The target rack id from list_racks." },
        uPosition: { type: "number", description: "Bottom U position (1-based, from the bottom)." },
        face: { type: "string", enum: ["front", "rear"], description: "Which face to mount on (default \"front\")." },
      },
      required: ["deviceId", "rackId", "uPosition"],
      additionalProperties: false,
    },
  },
  {
    name: "remove_device_from_rack",
    description:
      "Remove a device's rack placement (from list_racks) so its U position frees up. The device stays on the schematic; only its position in the rack is removed. The TateSide fork preserves shelves; remove unused shelves explicitly in the editor.",
    inputSchema: {
      type: "object",
      properties: {
        placementId: { type: "string", description: "The placement id from list_racks." },
      },
      required: ["placementId"],
      additionalProperties: false,
    },
  },
  {
    name: "update_note",
    description:
      "Replace the text of an existing note (text annotation). Get note ids from get_schematic. The text is shown literally (HTML-escaped) and newlines become line breaks; this replaces the note's whole content, so a note with rich formatting from the editor becomes plain text.",
    inputSchema: {
      type: "object",
      properties: {
        noteId: { type: "string", description: "The note id from get_schematic's notes." },
        text: { type: "string", description: "The new note text." },
      },
      required: ["noteId", "text"],
      additionalProperties: false,
    },
  },
  {
    name: "delete_note",
    description:
      "Delete a note (text annotation) by id. Get note ids from get_schematic. Only the note is removed; devices, rooms and connections are untouched.",
    inputSchema: {
      type: "object",
      properties: {
        noteId: { type: "string", description: "The note id from get_schematic's notes." },
      },
      required: ["noteId"],
      additionalProperties: false,
    },
  },
  {
    name: "install_card_batch",
    description:
      "Install several expansion cards into modular-chassis slots in one call â€” use this instead of repeated install_card calls. Best-effort: each install is attempted independently and the result lists per-item success or failure. Items are applied in array order, so an earlier install can affect a later one (two installs into the same slot leave only the first; a card that adds sub-slots can make a later install into one of them valid). Each card's slot family must match its slot, and a filled slot is never silently overwritten.",
    inputSchema: {
      type: "object",
      properties: {
        installs: {
          type: "array",
          minItems: 1,
          maxItems: 100,
          description: "The cards to install.",
          items: {
            type: "object",
            properties: {
              deviceId: { type: "string", description: "The modular device (chassis) id." },
              slotId: { type: "string", description: "The empty slot's id from get_device's slots." },
              cardTemplateId: { type: "string", description: "A card templateId from list_slot_cards." },
            },
            required: ["deviceId", "slotId", "cardTemplateId"],
            additionalProperties: false,
          },
        },
      },
      required: ["installs"],
      additionalProperties: false,
    },
  },
  {
    name: "place_device_in_rack_batch",
    description:
      "Mount several devices into racks in one call â€” use this instead of repeated place_device_in_rack calls. Best-effort: each placement is attempted independently and the result lists per-item success or failure. Placements are applied in array order, so an earlier one can affect a later one (it consumes the U span / half-rack side; a device already placed by an earlier item is rejected by a later one). Each item names its own rack; the same occupancy, 2-post-rear, already-placed, oversize and shelf-only (auto-shelf) handling as place_device_in_rack applies per item.",
    inputSchema: {
      type: "object",
      properties: {
        placements: {
          type: "array",
          minItems: 1,
          maxItems: 100,
          description: "The rack placements to make.",
          items: {
            type: "object",
            properties: {
              deviceId: { type: "string", description: "The device id from get_schematic / list_devices." },
              rackId: { type: "string", description: "The target rack id from list_racks." },
              uPosition: { type: "number", description: "Bottom U position (1-based, from the bottom)." },
              face: { type: "string", enum: ["front", "rear"], description: "Which face to mount on (default \"front\")." },
            },
            required: ["deviceId", "rackId", "uPosition"],
            additionalProperties: false,
          },
        },
      },
      required: ["placements"],
      additionalProperties: false,
    },
  },
];
