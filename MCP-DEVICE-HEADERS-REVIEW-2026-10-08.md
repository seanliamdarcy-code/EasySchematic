# Device make/model headers

Implemented locally; not deployed. Tool count remains 45.

Enable with `configure_sheet({deviceHeader:{showManufacturerModel:true}})`, or Preferences → Show manufacturer and model on Devices. Device headers then use the label first and manufacturer/model second, without repeating a manufacturer prefix already in the model. Feathers never receive a make/model line. The default device-type auxiliary row hides when a model line is shown; other auxiliary rows remain intact. Explicit showDeviceType controls the subtitle.

Device Properties and the Beta property whitelist support headerLine2, showManufacturerModel and showDeviceType. Empty headerLine2 restores the computed value. Full rendered lines are exposed as displayHeader in get_device/get_schematic. Both lines truncate at the existing 180px block width and have full-text tooltips. Port geometry uses the same header rules, including the taller header when both model and type are shown. Canvas, print and DXF share the presentation logic.

Settings persist through autosave, schematic JSON export/import and server document loading. Legacy documents without deviceHeader retain their old presentation. Disabling the make/model option restores the old label presentation; if showDeviceType was explicitly disabled, enable it separately to restore the subtitle. Per-Device visibility overrides remain deliberate exceptions to sheet defaults.

Reused templates now return ignoredFields and warnings for differences in label, manufacturer, modelNumber, deviceType or shortName. The existing template stays intact; overrideExisting creates a corrected local template.

Validation: lint, frontend build, 295 application tests, 17 MCP tests and all 13 browser tests passed. The new browser test uses isolated Neat Bar Pro, Lightware RX107/TX20 and Samsung presentation fixtures with synthetic minimal Port inventories. It checks the Samsung text override, fixed width, long-text ellipsis/tooltip, no Port overlap, geometry changes for the subtitle, persistence, feathers, and restoration of the legacy view. Canvas and print PNG captures were visually inspected. Artifacts are in the parent workspace at artifacts/device-headers.

The user's live schematic and shared library were not modified. This validates presentation, not the real hardware Port inventories. Deployment remains pending.
