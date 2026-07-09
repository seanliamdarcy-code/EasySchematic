# TateSide Taxonomy V2 Design Packet

Branch context: `feature/tateside-taxonomy-v2-design`  
Repo HEAD when drafted: `273026144a6fdf7db3716d10f3318be65d3696bb`  
Runtime code changed: no  
Tests changed: no  
Real DB rerun: no, `.tateside-data/vps-master/tateside.db` is absent on this laptop

This packet is a design document only. It does not propose runtime mutations, import rule changes, migrations, MCP write paths, or UI implementation work in this PR.

## 1. Executive Summary

The current taxonomy is usable enough to drive today's editor, library filtering, validation, and import workflows, but it overloads too much meaning into too few fields. `deviceType` currently carries both object identity and implied workflow behavior. `category` is nominally a grouping field, but it is also auto-derived from `deviceType` and treated like a quasi-classification in import and library flows. `signalType` sometimes represents a true signal family (`hdmi`, `analog-audio`), sometimes a transport (`ethernet`, `fiber`), and sometimes a vendor or protocol nuance (`dante`, `aes67`, `ultranet`, `blu-link`). `connectorType` correctly models physical connectors, but users inevitably read RJ45-like connectors as meaning "Ethernet" when the real intent might be Dante, HDBaseT, AmpLink, or control.

What is already good:

- `connectorType` is already physically oriented and should stay that way.
- `deviceType` is already the best current place to express the primary object type.
- `Port.direction` is explicit and behavior-driving.
- `searchTerms` is already useful as a lightweight alias layer.
- Import metadata and AI metadata exist, which gives us a place to preserve provenance instead of silently rewriting meaning.

What should remain unchanged in principle:

- Wiring logic should continue to depend on ports, not device categories.
- `category` should stay broad and boring as a UI grouping.
- `deviceType` should remain controlled vocabulary, but become less overloaded.
- `signalType` should stay at port level.
- `connectorType` should stay physical only.

What needs to be added before any write/apply workflow:

- `roleTags`
- `deviceCapabilities`
- `protocols`
- optionally `transports` if TateSide wants explicit link-layer semantics separate from protocol
- `brandConventions`
- review and evidence metadata
- alias and deprecation registries

What should be avoided:

- treating manufacturer/model heuristics as truth
- mapping RJ45 directly to "Ethernet"
- exploding the taxonomy into hundreds of device types
- automatic normalization based on ambiguous values
- MCP direct mutation before proposals, previews, and human approval exist

## 2. Current Taxonomy Inventory

### 2.1 Source-of-truth files inspected

- `src/types.ts`
- `src/deviceTypeCategories.ts`
- `src/components/DeviceEditor.tsx`
- `src/components/ManageTatesideTemplateDialog.tsx`
- `src/components/DeviceLibrary.tsx`
- `src/components/CardCreatorDialog.tsx`
- `src/components/ImportDevicesDialog.tsx`
- `src/importNormalization.ts`
- `src/import/validate.ts`
- `src/templateSearch.ts`
- `src/connectorTypes.ts`
- `tateside-api/src/libraryAudit.ts`
- `CODEX_TATESIDE_TAXONOMY_V2_NOTES.md`
- `CODEX_WORK_LAPTOP_SYNC_REVIEW_PACKET.md`

### 2.2 Current `DeviceTemplate` fields

Defined in `src/types.ts`.

Required:

- `deviceType: string`
- `label: string`
- `ports: Port[]`

Optional:

- `id`
- `version`
- `category`
- `shortName`
- `hostname`
- `color`
- `searchTerms`
- `manufacturer`
- `modelNumber`
- `imageUrl`
- `referenceUrl`
- `slots`
- `slotFamily`
- `powerDrawW`
- `powerCapacityW`
- `voltage`
- `thermalBtuh`
- `isVenueProvided`
- `poeBudgetW`
- `poeDrawW`
- `unitCost`
- `heightMm`
- `widthMm`
- `depthMm`
- `weightKg`
- `rackForm`
- `auxiliaryData`
- `facePlateLayout`
- `importNormalization`
- `aiMetadata`

### 2.3 Current `Port` fields

Defined in `src/types.ts`.

Required:

- `id: string`
- `label: string`
- `signalType: SignalType`
- `direction: PortDirection`

Optional:

- `inheritsSignal`
- `section`
- `connectorType`
- `gender`
- `rearConnectorType`
- `rearGender`
- `frontConnectorType`
- `frontGender`
- `normalledTo`
- `normalling`
- `capabilities`
- `networkConfig`
- `addressable`
- `activeConfig`
- `isMulticable`
- `channelCount`
- `multiConnect`
- `directAttach`
- `flipped`
- `notes`
- `poeDrawW`
- `linkSpeed`
- `templatePortId`
- `importNormalization`

### 2.4 Current value sets and where they are defined

`category`

- Type: free string in `src/types.ts`
- Canonical selectable list: derived from `DEVICE_TYPE_TO_CATEGORY` in `src/deviceTypeCategories.ts`
- Current canonical categories:
  `Amplifiers`, `Audio`, `Audio Expansion`, `Audio I/O`, `Cable Accessories`, `Cloud Services`, `Codecs`, `Control`, `Displays`, `Distribution`, `Expansion Cards`, `Infrastructure`, `Intercom`, `KVM / Extenders`, `LED Video`, `Lighting`, `Media Servers`, `Microphones`, `Mixing Consoles`, `Monitoring`, `Networking`, `Peripherals`, `Powered Mixers`, `Processing`, `Projection`, `Recording`, `Sources`, `Speakers`, `Storage`, `Storage Media`, `Switching`, `Wireless`

`deviceType`

- Type: free string in `src/types.ts`
- Canonical selectable list: keys of `DEVICE_TYPE_TO_CATEGORY` in `src/deviceTypeCategories.ts`
- Current canonical values:
  `camera`, `ptz-camera`, `camera-ccu`, `graphics`, `computer`, `media-player`, `mouse`, `keyboard`, `video-bar`, `touch-screen`, `screen`, `switcher`, `router`, `converter`, `scaler`, `adapter`, `frame-sync`, `multiviewer`, `capture-card`, `chromakey`, `da`, `video-wall-controller`, `monitor`, `tv`, `projector`, `recorder`, `audio-mixer`, `audio-embedder`, `audio-interface`, `audio-dsp`, `equalizer`, `stage-box`, `audio-splitter`, `wireless-mic-receiver`, `speaker`, `amplifier`, `headphone-amplifier`, `monitor-controller`, `personal-monitor`, `ndi-encoder`, `ndi-decoder`, `network-switch`, `streaming-encoder`, `av-over-ip`, `kvm-extender`, `usb-extender`, `hdbaset-extender`, `wireless-video`, `intercom`, `led-processor`, `led-cabinet`, `media-server`, `lighting-console`, `moving-light`, `led-fixture`, `dmx-splitter`, `dmx-node`, `control-processor`, `tally-system`, `ptz-controller`, `sync-generator`, `timecode-generator`, `midi-device`, `control-expansion`, `cable-accessory`, `wired-mic`, `iem-transmitter`, `change-over`, `expansion-card`, `fiber-transmitter`, `company-switch`, `frame`, `power-distribution`, `patch-panel`, `wall-plate`, `presentation-system`, `wireless-presentation`, `cloud-service`, `codec`, `expansion-chassis`, `power-mixer`, `hdmi-splitter`, `network-router`, `nas`, `external-storage`, `storage-media`, `lighting-processor`, `network-wifi`, `access-point`, `intercom-transceiver`, `controller`, `button-panel`, `dock`, `studio-monitor`, `video-scope`, `audio-meter`, `assistive-listening`, `battery`, `external-endpoint`, `commentary-box`, `phone-hybrid`, `interpreter-desk`, `table-box`, `antenna`, `antenna-distribution`, `conference-system`, `di-box`, `display`

`signalType`

- Type: union in `src/types.ts`
- Selectable values come from `SIGNAL_LABELS` and `SIGNAL_GROUPS` in `src/types.ts`
- Current canonical values:
  `sdi`, `hdmi`, `ndi`, `dante`, `avb`, `analog-audio`, `speaker-level`, `bluetooth`, `aes`, `dmx`, `madi`, `usb`, `ethernet`, `fiber`, `displayport`, `hdbaset`, `srt`, `genlock`, `gpio`, `contact-closure`, `rs422`, `serial`, `thunderbolt`, `composite`, `s-video`, `vga`, `dvi`, `power`, `power-l1`, `power-l2`, `power-l3`, `power-neutral`, `power-ground`, `midi`, `tally`, `spdif`, `adat`, `ultranet`, `aes50`, `stageconnect`, `wordclock`, `aes67`, `ydif`, `rf`, `st2110`, `artnet`, `sacn`, `ir`, `timecode`, `gigaace`, `dx5`, `slink`, `soundgrid`, `fibreace`, `dsnake`, `dxlink`, `gps`, `dars`, `rtmp`, `rtsp`, `mpeg-ts`, `component-video`, `digilink`, `ebus`, `control-voltage`, `extron-exp`, `pots`, `blu-link`, `cresnet`, `sensor`, `custom`

`connectorType`

- Type: union in `src/types.ts`
- Selectable values come from `CONNECTOR_LABELS` and `CONNECTOR_GROUPS` in `src/types.ts`
- Current canonical values:
  `bnc`, `hdmi`, `displayport`, `vga`, `xlr-3`, `xlr-4`, `xlr-5`, `trs-quarter`, `trs-eighth`, `combo-xlr-trs`, `rj45`, `ethercon`, `sfp`, `lc`, `sc`, `usb-a`, `usb-b`, `usb-c`, `db7w2`, `db9`, `db15`, `db25`, `din-5`, `phoenix`, `terminal-block`, `powercon`, `edison`, `iec`, `iec-c5`, `iec-c7`, `iec-c15`, `iec-c20`, `speakon`, `socapex`, `multipin`, `rca`, `toslink`, `barrel`, `banana`, `binding-post`, `binding-post-banana`, `dvi`, `mini-xlr`, `opticalcon`, `l5-20`, `l6-20`, `l6-30`, `l21-30`, `cam-lok`, `powercon-true1`, `qsfp`, `qsfp28`, `mpo`, `digilink`, `pcie-6pin`, `mini-din-4`, `mini-din-7`, `mini-hdmi`, `mini-displayport`, `rj11`, `rj12`, `usb-mini`, `usb-micro`, `trs-2.5mm`, `reverse-tnc`, `sma`, `db37`, `d-tap`, `v-mount`, `f-connector`, `lemo-2pin`, `lemo-4pin`, `lemo-5pin`, `wireless`, `solder-cup`, `punch-down-110`, `punch-down-66`, `krone-idc`, `d-hole-insert`, `none`, `other`

`direction`

- Type: union in `src/types.ts`
- Current canonical values: `input`, `output`, `bidirectional`, `passthrough`
- Important mismatch: `src/import/validate.ts` still only accepts `input`, `output`, `bidirectional`

### 2.5 What each field currently means and controls

| Field | Current meaning | Main definitions | UI grouping | Wiring | Validation | Import | Normalization | Rack/layout | Search | Overloaded? |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `category` | Broad library grouping string, often auto-derived from `deviceType` | `src/types.ts`, `src/deviceTypeCategories.ts`, `src/components/DeviceLibrary.tsx` | Yes | No | Light audit only | Yes, often backfilled from chosen `deviceType` | No direct rule today | No | Indirect only through visible library grouping | Yes |
| `deviceType` | Primary template type plus some behavior hints | `src/types.ts`, `src/deviceTypeCategories.ts`, `src/components/DeviceEditor.tsx` | Indirect via category map | Indirect for patch-panel/adapter/power/external-endpoint UI logic | Yes | Yes | Yes, `ImportNormalizationFieldKind` includes it | Indirect | Yes | Yes |
| `ports` | Wiring surface and per-port metadata | `src/types.ts` | No | Yes | Yes | Yes | Port-level raw metadata preserved | Yes, for face layout | Port labels and signal labels searchable | No |
| `signalType` | Signal family, transport, or protocol-like token | `src/types.ts`, `src/connectorTypes.ts`, `tateside-api/src/libraryAudit.ts` | Filtering only | Yes | Yes | Yes | Yes | Yes, colors and labels | Yes | Yes |
| `connectorType` | Physical connector | `src/types.ts`, `src/connectorTypes.ts`, `tateside-api/src/libraryAudit.ts` | No | Yes | Yes | Yes | Yes | Yes, faceplate/passthrough | No | Mildly |
| `direction` | Port direction semantics | `src/types.ts`, `src/import/validate.ts`, store/patch-panel flows | No | Yes | Yes | Yes | No | Yes | No | No |
| `searchTerms` | Curated aliases | `src/types.ts`, `src/templateSearch.ts` | No | No | No | Imported/edited | No | No | Yes | No |
| dimensions + `rackForm` | Physical metadata | `src/types.ts`, `tateside-api/src/libraryAudit.ts`, `src/components/DeviceEditor.tsx` | No | No | Light audit only | Imported/edited | No | Yes | No | No |
| `importNormalization` | Provenance of raw imported values and applied rules | `src/importNormalization.ts`, `src/types.ts` | No | No | No | Yes | Yes | No | No | No |
| `aiMetadata` | AI quote-import provenance and evidence | `src/types.ts`, `src/import/parseJson.ts`, `src/components/ImportQuoteDevicesDialog.tsx` | No | No | No | AI import only | No | No | No | No |
| `networkConfig` | Port IP config metadata | `src/types.ts`, `src/components/DeviceEditor.tsx` | No | Indirect | No | Imported/edited | No | No | No | No |
| `capabilities` on `Port` | Port-level video capability details, not taxonomy `deviceCapabilities` | `src/types.ts`, `src/components/DeviceEditor.tsx` | No | Indirect | No | Imported/edited | No | No | No | Yes, name collision risk |

### 2.6 Behavior notes by field

`category`

- Drives library section grouping in `src/components/DeviceLibrary.tsx`
- Has user reorder state via `categoryOrder`
- Special-cases `Expansion Cards` out of normal library sections
- Does not affect wiring

`deviceType`

- Drives suggested categories on import
- Drives validation as canonical known type
- Drives editor behavior for `patch-panel`, `wall-plate`, `adapter`, `external-endpoint`, and some power UI branches
- Participates in search scoring

`signalType`

- Drives signal colors, labels, filter chips, connection compatibility helpers, and some per-port editor subpanels
- Used in validation and library audit as canonical vocabulary

`connectorType`

- Drives connector labels, default connector inference, compatibility checks, passthrough rendering, patch-panel reports, and audit validation

`direction`

- Drives handle semantics and connection rules
- `passthrough` exists at runtime but is not yet accepted by import validation

## 3. Problems Found

### 3.1 `category` is doing too much despite being weakly typed

`category` is free text on `DeviceTemplate`, but the main UI treats it like controlled taxonomy. It is auto-derived from `deviceType` in import flows, reorderable in the library, and used as the visible top-level grouping. That is exactly why it should be broad and boring. Today it is broad in some places and too semantic in others.

Examples:

- `Switching` is a workflow bucket, but `switcher`, `router`, `presentation-system`, and `wireless-presentation` are not equivalent object types.
- `Networking` contains `network-switch`, `network-router`, `access-point`, `ndi-encoder`, `ndi-decoder`, and `av-over-ip`, mixing true network gear with AV endpoints that merely use IP.

### 3.2 `deviceType` has TateSide gaps and mixed granularity

The current list mixes:

- real object types: `amplifier`, `speaker`, `display`, `projector`
- vague functional buckets: `router`, `switcher`, `converter`, `controller`
- technology-specific hybrids: `hdbaset-extender`, `av-over-ip`, `ndi-encoder`
- import-era or legacy distinctions that are not TateSide-friendly: `monitor`, `tv`, `screen`, `display`

This causes semantic drift:

- `Bose EX-1280` fits `audio-dsp`, and the real DB also stores `Bose CSP-428` as `audio-dsp`, which is a better fit than amplifier-first typing for the current observed ports.
- `Blustream IP250UHD-TX` is not best described by generic `av-over-ip`; it is specifically an AVoIP transmitter.
- `Shure MXA910` should remain a microphone-first object, not an `audio-dsp`, even though it contains DSP features.

### 3.3 `signalType` mixes at least four concept layers

Current `signalType` contains:

- physical or media families: `fiber`, `power`
- AV signal families: `hdmi`, `analog-audio`, `speaker-level`
- protocols or ecosystems: `dante`, `aes67`, `avb`, `soundgrid`, `blu-link`
- transports or distribution technologies: `ethernet`, `hdbaset`, `st2110`, `srt`

That makes the field useful for wiring colors, but risky as the only semantic authority.

### 3.4 RJ45 meaning is ambiguous and cannot be inferred safely

Examples:

- RJ45 + `ethernet` might mean control-only network
- RJ45 + `dante` means network audio over Ethernet
- RJ45 + `hdbaset` means point-to-point HDBaseT
- RJ45 + `avb` means AVB audio or control
- RJ45 + physical Bose AmpLink usage should not be normalized to general Ethernet at all

This is exactly why `connectorType` must stay physical and why `protocols` or `transports` must be explicit.

### 3.5 Several current terms are too overloaded

- `switcher`: can mean presentation switcher, matrix, video switcher, or USB switch
- `router`: can mean IP router or SDI/audio matrix
- `hdbaset-extender`: collapses TX and RX into one type
- `av-over-ip`: too vague for endpoints
- `monitor`, `display`, `tv`: likely same broad device family for TateSide
- `audio-dsp`: can swallow mixers, speaker processors, conferencing DSPs, and smart microphones
- `audio-interface`: can mean USB audio box, stage I/O, network endpoint, or control bridge

### 3.6 `custom` and `other` hide uncertainty instead of expressing it

Library audit already treats generic values as suspicious. That is good. The missing piece is a review model that lets the system say "we think this is X, confidence medium, evidence pending" instead of flattening it to `custom`.

### 3.7 Current validation and runtime taxonomy are slightly out of sync

Important example:

- Runtime supports `passthrough`
- `src/import/validate.ts` still rejects it

That is not a V2 migration blocker by itself, but it confirms the current taxonomy surface is already split across multiple concerns.

## 4. Proposed Taxonomy V2 Model

### 4.1 Design principles

- `category` stays UI-only and broad
- `deviceType` names the primary object
- flexible meaning moves into additive fields
- physical connector, signal family, transport, and protocol are modeled separately
- uncertain data stays reviewable, never silently promoted
- brand-specific rules live beside the taxonomy, not inside ad hoc import heuristics

### 4.2 Proposed field model

| Field | Purpose | Shape | Required | User-editable | AI/MCP may propose | AI/MCP may directly write | Affects wiring | Affects import matching | Affects UI grouping |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `category` | broad library grouping only | controlled enum string | yes | yes | yes | no | no | low | yes |
| `deviceType` | primary object type | controlled enum string | yes | yes | yes | no | indirect only | high | indirect |
| `roleTags` | flexible usage/context tags | controlled string[] with aliases | no | yes | yes | no | no | medium | optional filters only |
| `deviceCapabilities` | functions the device can perform | controlled string[] | no | yes | yes | no | indirect | medium | optional filters only |
| `protocols` | application/media/control protocols | controlled string[] | no | yes | yes | no | indirect | high | optional filters only |
| `transports` | link or carriage mechanisms | controlled string[] | no | yes | yes | no | indirect | high | optional filters only |
| `connectorType` | physical connector | controlled enum string at port level | yes for concrete ports | yes | yes | no | yes | high | no |
| `signalType` | broad signal family at port level | controlled enum string | yes for concrete ports | yes | yes | no | yes | high | filter only |
| `brandConventions` | manufacturer/family-specific interpretation rules | structured object or external registry ref | no | limited | yes | no | no | high | no |
| `aliases` | known synonyms for canonical values | registry-level arrays | no | admin only | yes | no | no | high | no |
| `deprecatedValues` | retired synonyms and migration hints | registry-level arrays | no | admin only | yes | no | no | high | no |
| `reviewStatus` | review workflow state | controlled enum | yes for proposal records | human primarily | yes | no | no | yes | yes in review tooling |
| `classificationConfidence` | confidence score/band | enum or number | no | human override | yes | no | no | yes | yes in review tooling |
| `evidenceRefs` | provenance for claims | array of evidence objects | no | yes | yes | no | no | yes | no |
| `lastReviewedBy` | audit trail | string | no | system/human only | no | no | no | no | no |
| `lastReviewedAt` | audit trail | ISO datetime | no | system/human only | no | no | no | no | no |

### 4.3 Shape recommendations

Recommended template-level additions:

```ts
type ReviewStatus =
  | "imported"
  | "ai-researched"
  | "needs-review"
  | "human-reviewed"
  | "trusted-standard"
  | "deprecated";

interface TaxonomyEvidenceRef {
  type:
    | "manufacturer-product-page"
    | "manufacturer-datasheet"
    | "manufacturer-manual"
    | "manufacturer-support"
    | "trusted-human-note"
    | "import-source";
  url?: string;
  title?: string;
  excerpt?: string;
  capturedAt?: string;
}

interface TemplateTaxonomyV2 {
  category: string;
  deviceType: string;
  roleTags?: string[];
  deviceCapabilities?: string[];
  protocols?: string[];
  transports?: string[];
  brandConventions?: string[];
  reviewStatus: ReviewStatus;
  classificationConfidence?: "low" | "medium" | "high";
  evidenceRefs?: TaxonomyEvidenceRef[];
  lastReviewedBy?: string;
  lastReviewedAt?: string;
}
```

Recommended port-level additions:

```ts
interface PortTaxonomyV2 {
  connectorType?: string;
  signalType?: string;
  protocols?: string[];
  transports?: string[];
}
```

Important lazy choice:

- Keep `roleTags`, `deviceCapabilities`, and `protocols` as arrays of canonical strings.
- Defer `transports` from the first implementation unless a concrete workflow proves it earns its extra surface area.
- Do not jump straight to nested ontology objects unless a concrete workflow proves it necessary.

## 5. Category Proposal

Category should stay broad and boring. It is for library browsing, not semantic proof.

Recommended category list:

- `Audio`
- `Amplifiers`
- `Speakers`
- `Displays`
- `Projection`
- `Video Distribution`
- `Networking`
- `Control`
- `Sources`
- `Conferencing`
- `Infrastructure`
- `Accessories`

Per-category rationale:

| Category | Rationale | Example device types | Migration from current categories | Current data likely already uses it? |
| --- | --- | --- | --- | --- |
| `Audio` | general non-amplifier, non-speaker audio gear | `audio-dsp`, `audio-interface`, `wired-mic` | `Audio`, `Audio I/O`, `Mixing Consoles`, parts of `Microphones` | yes |
| `Amplifiers` | amplifier-first devices deserve their own shelf | `amplifier` | `Amplifiers`, `Powered Mixers` partial | yes |
| `Speakers` | outputs and loudspeakers | `speaker`, `subwoofer`, `studio-monitor` | `Speakers` | yes |
| `Displays` | flat panels and view devices | `display`, `touch-screen` if used as room panel only maybe `Control` instead | `Displays`, parts of `Monitoring` | yes |
| `Projection` | projectors and screens | `projector`, `projection-screen` if ever added | `Projection` | yes |
| `Video Distribution` | switchers, matrices, extenders, AVoIP endpoints | `matrix-switcher`, `hdbaset-transmitter`, `avoip-receiver` | `Switching`, `Distribution`, parts of `Processing`, `KVM / Extenders` | yes |
| `Networking` | true network infrastructure | `network-switch`, `network-router`, `access-point` | `Networking` | yes |
| `Control` | control systems and operator interfaces | `control-processor`, `button-panel`, `control-interface` | `Control` | yes |
| `Sources` | compute, playback, cameras, source endpoints | `media-player`, `room-compute`, `camera` | `Sources`, `Codecs`, parts of `Media Servers` | yes |
| `Conferencing` | devices inherently conferencing-specific rather than merely used in conference rooms | `mtr-compute`, `video-bar`, `codec`, `conference-system` | `Codecs`, parts of `Microphones`, parts of `Switching` | partially |
| `Infrastructure` | patching, power, racks, wall plates | `patch-panel`, `power-distribution`, `wall-plate` | `Infrastructure`, `Expansion Cards` excluded, `Cable Accessories` partial | yes |
| `Accessories` | adapters, batteries, table boxes, non-core items | `adapter`, `battery`, `table-box` | `Cable Accessories`, parts of `Infrastructure`, `Peripherals` | yes |

Notes:

- Keep `Conferencing`, but only for inherently conferencing-specific object families.
- Fold `Wireless`, `Monitoring`, `Recording`, `Cloud Services`, `Storage`, and similar niche shelves into broader buckets unless volume proves otherwise.
- Do not create categories for one manufacturer family.

## 6. Device Type Proposal

Target outcome: 25 to 35 strong device types, not hundreds.

Recommended TateSide-focused device types:

| Canonical value | Label | Category | Examples | Current closest type | Migration implications |
| --- | --- | --- | --- | --- | --- |
| `audio-dsp` | Audio DSP | Audio | Bose EX-1280 | `audio-dsp` | keep |
| `amplifier` | Amplifier | Amplifiers | CSP amplifiers, Powersoft | `amplifier` | keep |
| `speaker` | Speaker | Speakers | passive/active loudspeaker | `speaker` | keep |
| `subwoofer` | Subwoofer | Speakers | install subwoofer | `speaker` | new |
| `display` | Display | Displays | Samsung commercial display | `display`, `monitor`, `tv` | consolidate |
| `projector` | Projector | Projection | Epson, Panasonic | `projector` | keep |
| `media-player` | Media Player | Sources | signage or playback box | `media-player` | keep |
| `signage-player` | Signage Player | Sources | dedicated signage box | `media-player` | new |
| `network-switch` | Network Switch | Networking | Netgear M4250 | `network-switch` | keep |
| `control-processor` | Control Processor | Control | Q-SYS Core used for control, Crestron processor | `control-processor` | keep |
| `touch-screen` | Touch Screen | Control | room control panel | `touch-screen` | keep |
| `room-compute` | Room Compute | Sources | resident room PC | `computer` | new |
| `mtr-compute` | MTR Compute | Conferencing | Teams Rooms compute | `computer`, `codec` | new |
| `camera` | Camera | Sources | fixed camera | `camera` | keep |
| `ptz-camera` | PTZ Camera | Sources | PTZ room camera | `ptz-camera` | keep |
| `wired-mic` | Wired Microphone | Audio | gooseneck mic | `wired-mic` | keep |
| `ceiling-mic` | Ceiling Microphone | Audio | Shure MXA910 | `wired-mic`, `conference-system` | new |
| `wireless-mic-receiver` | Wireless Mic Receiver | Audio | Shure ULX-D receiver | `wireless-mic-receiver` | keep |
| `wireless-presentation` | Wireless Presentation | Conferencing | Barco ClickShare-like endpoint | `wireless-presentation` | keep |
| `audio-interface` | Audio Interface | Audio | USB/network audio I/O | `audio-interface`, `stage-box` | keep |
| `audio-wall-plate` | Audio Wall Plate | Infrastructure | local I/O plate | `wall-plate` | new |
| `video-distribution` | Video Distribution | Video Distribution | generic if more specific unknown | `switcher`, `router`, `da` | fallback only |
| `matrix-switcher` | Matrix Switcher | Video Distribution | HDMI matrix | `switcher`, `router` | new preferred |
| `hdbaset-matrix` | HDBaseT Matrix | Video Distribution | integrated HDBaseT matrix | `switcher`, `hdbaset-extender` | new |
| `hdbaset-transmitter` | HDBaseT Transmitter | Video Distribution | Blustream TX | `hdbaset-extender` | split |
| `hdbaset-receiver` | HDBaseT Receiver | Video Distribution | Blustream RX | `hdbaset-extender` | split |
| `avoip-transmitter` | AVoIP Transmitter | Video Distribution | Blustream IP TX | `av-over-ip`, `ndi-encoder` | split |
| `avoip-receiver` | AVoIP Receiver | Video Distribution | AVoIP decoder | `av-over-ip`, `ndi-decoder` | split |
| `usb-extender` | USB Extender | Video Distribution | USB over CAT extender | `usb-extender` | keep |
| `control-interface` | Control Interface | Control | GPIO/serial bridge, room IO box | `controller`, `control-expansion` | new |
| `power-distribution` | Power Distribution | Infrastructure | PDUs, sequencers | `power-distribution` | keep |

Guidance:

- Keep `video-distribution` as a safe fallback when exact topology is unknown.
- Prefer TX/RX explicit types over generic `hdbaset-extender` and `av-over-ip`.
- Collapse `monitor`, `tv`, and most `screen` usage into `display`.
- Do not create `conferencing-dsp`, `dsp-amplifier`, or `network-amplifier` in the first V2 pass unless a runtime behavior difference appears that cannot be expressed with `roleTags`, `deviceCapabilities`, and `protocols`.

## 7. `roleTags` Proposal

`roleTags` should be a controlled vocabulary with aliases, not free text.

Why:

- free text becomes spelling debt immediately
- TateSide needs flexible semantics, but still needs safe filtering and review

Recommended shape:

- `roleTags: string[]`
- cardinality: zero to many
- aliases allowed in registry, stored value always canonical
- manufacturer-specific tags allowed only when clearly justified and namespaced if needed

Recommended examples:

- `room-display`
- `room-compute`
- `mtr-compute`
- `ceiling-mic`
- `table-mic`
- `dsp`
- `aec`
- `amplifier`
- `network-audio`
- `signage`
- `conferencing`
- `programme-audio`
- `install-control`
- `paging`
- `wireless-presentation`

Protocol names such as `dante`, `aes67`, `avb`, `hdbaset`, `avoip` should not be primary `roleTags` if a `protocols` field exists. They can be allowed as transitional tags, but the cleaner V2 target is:

- role or use in `roleTags`
- function in `deviceCapabilities`
- protocol identity in `protocols`

Automation impact:

- role tags may inform future filters, review queues, and suggestions
- role tags should not directly change wiring logic

## 8. Device Capabilities Proposal

`deviceCapabilities` should express what the device can do, not what it is.

Examples:

- `audio-processing`
- `aec`
- `automixing`
- `amplification`
- `video-routing`
- `audio-routing`
- `encode-video`
- `decode-video`
- `usb-bridging`
- `serial-control`
- `gpio-control`
- `network-control`
- `poe-powered`
- `poe-source`
- `matrix-routing`
- `paging`
- `echo-cancellation`

How this differs:

- `deviceType = what the box primarily is`
- `roleTags = how the box is used in the room/system`
- `deviceCapabilities = what functions the box can perform`

Examples:

- Shure MXA910
  - `deviceType`: `ceiling-mic`
  - `roleTags`: `ceiling-mic`, `conferencing`
  - `deviceCapabilities`: only after human review; the current DB row is too sparse and likely misclassified

- Powersoft Unica 8M 2K8
  - `deviceType`: `amplifier`
  - `roleTags`: `amplifier`
  - `deviceCapabilities`: `amplification`, `audio-processing`, `network-control` when evidence supports them

## 9. Protocols / Transports Proposal

This is the critical split, but the real DB suggests the first implementation should stay smaller than the full conceptual model.

### 9.1 Recommended meaning

- `connectorType`: physical connector shape
- `signalType`: broad signal family
- `transport`: how bits or signal are carried at a link level
- `protocol`: specific media/control/network protocol or ecosystem
- `role/capability`: what the port/device does in system use

### 9.2 Proposed controlled examples

Possible `transports` if TateSide later proves a real workflow need:

- `ethernet`
- `fiber`
- `usb`
- `hdbaset`
- `sdi`
- `hdmi`
- `rs-232`
- `rs-485`
- `gpio`
- `poe`

Possible `protocols`:

- `dante`
- `aes67`
- `avb`
- `amplink`
- `q-lan`
- `ndi`
- `st2110`
- `srt`
- `rtsp`
- `rtmp`
- `artnet`
- `sacn`

### 9.3 Multiple RJ45 examples

Example A: ordinary control LAN port

- `connectorType`: `rj45`
- `signalType`: `ethernet`
- `transports`: [`ethernet`]
- `protocols`: [`ip-control`] or empty if unknown

Example B: Dante primary port

- `connectorType`: `ethercon`
- `signalType`: `ethernet`
- `transports`: [`ethernet`]
- `protocols`: [`dante`]

Example C: HDBaseT receiver port

- `connectorType`: `rj45`
- `signalType`: `video-network-link` or keep `hdbaset` if signal family remains broad enough
- `transports`: [`hdbaset`]
- `protocols`: [`hdbaset`]

Example D: Bose AmpLink over RJ45

- `connectorType`: `rj45`
- `signalType`: `digital-audio-link` or current nearest broad audio family
- `transports`: [`digital-pair-link`] if TateSide wants that layer
- `protocols`: [`amplink`]

Example E: Shure networked mic port

- `connectorType`: `rj45`
- `signalType`: `ethernet`
- `transports`: [`ethernet`, `poe`]
- `protocols`: [`dante`]

### 9.4 Recommendation on `signalType`

Two workable paths:

1. Conservative V2:
   Keep current `signalType` field name, but narrow guidance so it is used for broad families only, while exact semantics move to `protocols` and `transports`.

2. Deeper cleanup:
   Eventually replace some current protocol-like signal types with broader families.

Recommended for next phase:

- take path 1 first
- do not try to fully redesign every existing signal value before the metadata and review model exist
- defer a dedicated `transports` field from the first additive implementation PR
- revisit `transports` only if a concrete workflow cannot be served by `signalType` plus `protocols`

## 10. Brand Conventions

`brandConventions` should be a structured manufacturer/family knowledge layer, not runtime magic.

Recommended shape:

```ts
interface BrandConvention {
  manufacturer: string;
  familyMatch?: string;
  rules: Array<{
    when: Record<string, string | string[]>;
    guidance: string;
    preferredDeviceType?: string;
    preferredRoleTags?: string[];
    preferredCapabilities?: string[];
    preferredProtocols?: string[];
    notes?: string;
  }>;
}
```

Examples:

Bose

- AmpLink over RJ45 is digital audio, not generic Ethernet
- Dante ports should stay distinct from general Ethernet ports
- ControlSpace family naming can help distinguish DSP vs amplifier-first devices

Blustream

- `IP` series often implies AVoIP, not generic networking
- `HEX` series often implies HDBaseT
- TX/RX roles matter and should not collapse into one generic extender type

Powersoft

- amplifier remains primary type
- DSP and Dante usually belong in `deviceCapabilities`/`protocols`, not as the primary type

Shure

- MXA arrays remain microphone-first objects
- MXW access point transceivers are not ordinary Wi-Fi access points

Netgear

- M4250 remains `network-switch`
- AV suitability belongs in `roleTags` or `deviceCapabilities`, not primary type

## 11. Concrete Device Examples

These are proposal examples, not confirmed truth. Uncertain fields are intentionally marked with low or medium confidence and evidence placeholders.

### Bose EX-1280

```jsonc
{
  "category": "Audio",
  "deviceType": "audio-dsp",
  "roleTags": ["dsp", "install-control"],
  "deviceCapabilities": ["audio-processing", "matrix-routing", "network-control"],
  "protocols": ["dante", "amplink"],
  "ports": [
    { "label": "Dante Primary", "connectorType": "rj45", "signalType": "dante", "protocols": ["dante"] },
    { "label": "Dante Secondary", "connectorType": "rj45", "signalType": "dante", "protocols": ["dante"] },
    { "label": "AmpLink Output", "connectorType": "rj45", "signalType": "custom", "protocols": ["amplink"] },
    { "label": "RS-232 Serial", "connectorType": "terminal-block", "signalType": "serial", "protocols": [] }
  ],
  "brandConventions": ["bose-controlspace"],
  "reviewStatus": "needs-review",
  "classificationConfidence": "medium",
  "evidenceRefs": [{ "type": "trusted-human-note", "title": "Real DB snapshot shows Dante, AmpLink, USB, serial, and GPIO on EX-1280; no AEC-specific port naming is present." }]
}
```

### Bose EX-1280C

```jsonc
{
  "category": "Audio",
  "deviceType": "audio-dsp",
  "roleTags": ["dsp", "conferencing"],
  "deviceCapabilities": ["audio-processing", "matrix-routing", "aec", "network-control", "usb-soft-codec"],
  "protocols": ["dante", "amplink", "voip"],
  "ports": [
    { "label": "Dante Primary", "connectorType": "rj45", "signalType": "dante", "protocols": ["dante"] },
    { "label": "Dante Secondary", "connectorType": "rj45", "signalType": "dante", "protocols": ["dante"] },
    { "label": "VoIP", "connectorType": "rj45", "signalType": "ethernet", "protocols": ["voip"] },
    { "label": "Micro-B USB Soft Codec", "connectorType": "usb-micro", "signalType": "usb", "protocols": [] },
    { "label": "AmpLink Output", "connectorType": "rj45", "signalType": "custom", "protocols": ["amplink"] },
    { "label": "Telephone Line", "connectorType": "rj11", "signalType": "analog-audio", "protocols": ["pstn"] }
  ],
  "brandConventions": ["bose-controlspace"],
  "reviewStatus": "needs-review",
  "classificationConfidence": "high",
  "evidenceRefs": [{ "type": "trusted-human-note", "title": "Real DB snapshot shows AEC-labelled inputs plus Dante, VoIP, USB soft codec, AmpLink, and telephone line connectivity on EX-1280C." }]
}
```

### Bose CSP-428

```jsonc
{
  "category": "Audio",
  "deviceType": "audio-dsp",
  "roleTags": ["paging", "dsp"],
  "deviceCapabilities": ["audio-processing", "paging", "network-control"],
  "protocols": ["amplink"],
  "ports": [
    { "label": "AmpLink Output", "connectorType": "rj45", "signalType": "custom", "protocols": ["amplink"] },
    { "label": "Line Output 1", "connectorType": "terminal-block", "signalType": "analog-audio", "protocols": [] },
    { "label": "Ethernet", "connectorType": "rj45", "signalType": "ethernet", "protocols": [] }
  ],
  "brandConventions": ["bose-amplink"],
  "reviewStatus": "needs-review",
  "classificationConfidence": "high",
  "evidenceRefs": [{ "type": "trusted-human-note", "title": "Real DB snapshot stores CSP-428 as audio-dsp with line-level outputs, GPIO, Ethernet, and AmpLink; no speaker-level outputs are present." }]
}
```

### Blustream IP250UHD-TX

```jsonc
{
  "category": "Video Distribution",
  "deviceType": "avoip-transmitter",
  "roleTags": ["avoip"],
  "deviceCapabilities": ["encode-video", "usb-bridging"],
  "protocols": ["dante", "aes67"],
  "ports": [
    { "label": "Video Network / PoE", "connectorType": "rj45", "signalType": "ethernet", "protocols": [] },
    { "label": "Dante / AES67 Network", "connectorType": "rj45", "signalType": "dante", "protocols": ["dante", "aes67"] },
    { "label": "HDMI Input", "connectorType": "hdmi", "signalType": "hdmi", "protocols": [] }
  ],
  "brandConventions": ["blustream-ip-series"],
  "reviewStatus": "needs-review",
  "classificationConfidence": "medium",
  "evidenceRefs": [{ "type": "trusted-human-note", "title": "Real DB snapshot already distinguishes Video Network / PoE from Dante / AES67 on separate RJ45 ports." }]
}
```

### Blustream HEX70CS-RX

```jsonc
{
  "category": "Video Distribution",
  "deviceType": "hdbaset-receiver",
  "roleTags": ["hdbaset"],
  "deviceCapabilities": ["decode-video", "serial-control"],
  "protocols": ["hdbaset"],
  "ports": [
    { "label": "HDBaseT Input", "connectorType": "rj45", "signalType": "hdmi", "protocols": ["hdbaset"] },
    { "label": "HDMI Out", "connectorType": "hdmi", "signalType": "hdmi", "protocols": [] }
  ],
  "brandConventions": ["blustream-hex-series"],
  "reviewStatus": "needs-review",
  "classificationConfidence": "medium",
  "evidenceRefs": [{ "type": "trusted-human-note", "title": "Real DB snapshot still models the HDBaseT input as HDMI signal over RJ45, which is a useful reminder that protocol and signal family are currently conflated." }]
}
```

### Blustream IP300UHD-WP-TX

```jsonc
{
  "category": "Video Distribution",
  "deviceType": "avoip-transmitter",
  "roleTags": ["avoip", "wall-plate"],
  "deviceCapabilities": ["encode-video", "usb-bridging"],
  "protocols": [],
  "ports": [
    { "label": "Video Network / PoE", "connectorType": "rj45", "signalType": "ethernet", "protocols": [] },
    { "label": "HDMI Input", "connectorType": "hdmi", "signalType": "hdmi", "protocols": [] },
    { "label": "USB-C AV Input", "connectorType": "usb-c", "signalType": "usb", "protocols": [] }
  ],
  "brandConventions": ["blustream-ip-series"],
  "reviewStatus": "needs-review",
  "classificationConfidence": "medium",
  "evidenceRefs": [{ "type": "trusted-human-note", "title": "Real DB snapshot supports wall-plate as a role/context marker and does not prove a separate physical taxonomy field is needed." }]
}
```

### Powersoft Unica 8M | 2K8

```jsonc
{
  "category": "Amplifiers",
  "deviceType": "amplifier",
  "roleTags": ["amplifier"],
  "deviceCapabilities": ["amplification", "audio-processing", "network-control"],
  "protocols": ["dante"],
  "ports": [
    { "label": "Network / Control / AoIP RJ45 x3 (one PoE-capable)", "connectorType": "rj45", "signalType": "ethernet", "protocols": ["dante"] },
    { "label": "Amplifier Outputs x8", "connectorType": "terminal-block", "signalType": "speaker-level", "protocols": [] }
  ],
  "brandConventions": ["powersoft-unica"],
  "reviewStatus": "needs-review",
  "classificationConfidence": "medium",
  "evidenceRefs": [{ "type": "trusted-human-note", "title": "The closest real DB match is `Unica 8M | 2K8`, which remains amplifier-first even when DSP and network audio are present." }]
}
```

### Powersoft Mezzo 324 AD

```jsonc
{
  "category": "Amplifiers",
  "deviceType": "amplifier",
  "roleTags": ["amplifier"],
  "deviceCapabilities": ["amplification"],
  "protocols": [],
  "ports": [
    { "label": "SPK 1", "connectorType": "terminal-block", "signalType": "speaker-level", "protocols": [] },
    { "label": "SPK 2", "connectorType": "terminal-block", "signalType": "speaker-level", "protocols": [] }
  ],
  "brandConventions": ["powersoft-mezzo"],
  "reviewStatus": "needs-review",
  "classificationConfidence": "medium",
  "evidenceRefs": [{ "type": "trusted-human-note", "title": "The current real DB template for Mezzo 324 AD is amplifier-first and does not yet carry enough trustworthy extra metadata to justify a specialized deviceType." }]
}
```

### Shure MXA910

```jsonc
{
  "category": "Audio",
  "deviceType": "ceiling-mic",
  "roleTags": ["ceiling-mic", "conferencing"],
  "deviceCapabilities": [],
  "protocols": [],
  "ports": [
    { "label": "NETWORK", "connectorType": "rj45", "signalType": "ethernet", "protocols": [] }
  ],
  "brandConventions": ["shure-mxa"],
  "reviewStatus": "needs-review",
  "classificationConfidence": "low",
  "evidenceRefs": [{ "type": "trusted-human-note", "title": "The current real DB row is likely misclassified and too sparse to support a richer example safely; keep the deviceType recommendation separate from the present template evidence." }]
}
```

### Shure MX415R/C

```jsonc
{
  "category": "Audio",
  "deviceType": "wired-mic",
  "roleTags": ["table-mic"],
  "deviceCapabilities": [],
  "protocols": [],
  "ports": [],
  "brandConventions": ["shure-gooseneck"],
  "reviewStatus": "needs-review",
  "classificationConfidence": "low",
  "evidenceRefs": [{ "type": "trusted-human-note", "title": "The current real DB row appears clearly wrong for MX415R/C, so this template requires human correction before it can be trusted as evidence." }]
}
```

### Samsung commercial display

```jsonc
{
  "category": "Displays",
  "deviceType": "display",
  "roleTags": ["room-display", "signage"],
  "deviceCapabilities": ["network-control"],
  "protocols": [],
  "ports": [
    { "label": "HDMI 1", "connectorType": "hdmi", "signalType": "hdmi", "protocols": [] },
    { "label": "LAN", "connectorType": "rj45", "signalType": "ethernet", "protocols": [] }
  ],
  "brandConventions": ["samsung-commercial-display"],
  "reviewStatus": "needs-review",
  "classificationConfidence": "medium",
  "evidenceRefs": [{ "type": "manufacturer-product-page" }]
}
```

### Netgear M4250 switch

```jsonc
{
  "category": "Networking",
  "deviceType": "network-switch",
  "roleTags": ["network-audio", "avoip"],
  "deviceCapabilities": ["poe-source", "network-control"],
  "protocols": [],
  "ports": [
    { "label": "NETWORK", "connectorType": "rj45", "signalType": "ethernet", "protocols": [] },
    { "label": "PoE", "connectorType": "edison", "signalType": "power", "protocols": [] }
  ],
  "brandConventions": ["netgear-av-line"],
  "reviewStatus": "needs-review",
  "classificationConfidence": "high",
  "evidenceRefs": [{ "type": "trusted-human-note", "title": "Real DB M4250 templates are already consistently network-switch in Networking; AV suitability belongs in tags/capabilities, not a special primary type." }]
}
```

## 12. Alias And Deprecation Strategy

The lazy safe rule is:

- templates store canonical values only
- aliases and deprecated terms live in a registry
- migration mappings are reviewed, not blindly applied

Recommended registry concepts:

- `canonicalValue`
- `aliases`
- `deprecatedValues`
- `migrationRisk`
- `notes`

Examples:

| Raw value | Candidate canonical target | Risk | Recommendation |
| --- | --- | --- | --- |
| `euroblock` | `phoenix` or `terminal-block` | high | do not auto-choose globally; store as alias candidate pending review |
| `3.5mm` | `trs-eighth` | low | safe alias once confirmed scope is audio jack, not TS/TRRS nuance |
| `inout` | `bidirectional` | medium | probably correct, but still reviewable |
| `DSP` category | `Audio` category | medium | depends on whether category is UI-only and deviceType carries truth |
| `Video` category | likely `Displays`, `Sources`, or `Video Distribution` | high | no blind mapping |
| `VC` category | `Conferencing` | medium | likely good, but context-dependent |

Backward compatibility:

- keep reading deprecated values during import and audit
- expose suggested mappings
- do not auto-rewrite existing templates until review status supports it

## 13. Review / Evidence Model

Recommended statuses:

- `imported`
- `ai-researched`
- `needs-review`
- `human-reviewed`
- `trusted-standard`
- `deprecated`

Recommended confidence:

- `low`
- `medium`
- `high`

Recommended evidence fields:

- source type
- title
- URL if available
- excerpt or note
- captured timestamp

Recommended rules:

- AI may propose values at `ai-researched` or `needs-review`
- only `human-reviewed` or `trusted-standard` templates should be eligible for future Library Doctor apply workflows
- `trusted-standard` should require clear evidence and a canonical family decision

## 14. Import / Normalisation Implications

Taxonomy V2 should not discard any raw source values.

Recommended behavior:

- keep current `importNormalization.rawSignalType`, `rawConnectorType`, `rawDeviceType`
- add raw category or raw taxonomy note fields later only if needed
- preserve source manufacturer/model/category text exactly as imported
- treat aliases as matching aids, not truth
- let import suggest `deviceType`, `category`, and future tags/`deviceCapabilities`/`protocols` separately
- route uncertain cases into review, not direct mutation

Jetbuilt implications:

- preserve original imported labels and raw values
- use taxonomy V2 as an overlay, not a destructive rewrite

Template matching implications:

- matching should prioritize manufacturer/model and trusted-standard templates
- aliases can widen search
- confidence should accompany any AI-assisted suggestion

## 15. UI Implications

Do not build the UI yet, but the model implies a simpler future edit surface.

Double-clicking a device:

- user should see primary fields first: category, deviceType, roleTags, `deviceCapabilities`
- protocol and transport details should appear in advanced taxonomy sections, especially at port level
- review status and evidence should be visible but not intrusive

Editing a template:

- same fields as device edit, but with stronger provenance and review visibility
- brand convention hints should appear as guidance, not forced rewrites

Viewing the library:

- group by broad category
- filter by deviceType, roleTags, `deviceCapabilities`, protocols
- show review badges only when useful

Reviewing taxonomy problems:

- show current value, proposed value, confidence, and evidence side by side
- make ambiguity obvious instead of hiding it behind `custom`

Approving an AI/MCP proposal:

- preview only
- diff first
- evidence visible
- reviewer decision required

## 16. Library Doctor / MCP Implications

Read-only capabilities that are safe first:

- list taxonomy values
- list aliases and deprecated values
- get template
- get template issues
- get manufacturer family
- get brand conventions
- preview proposed changes

Later write path:

- create proposal
- preview diff
- approve
- apply
- audit log

Hard rule:

- no blind direct mutation
- no "fix this taxonomy" tool that writes immediately

## 17. Migration Strategy

### Phase A

- add schema fields only
- no behavior change
- no import rewrites

### Phase B

- expose read APIs and canonical vocab endpoints
- keep current runtime taxonomy active

### Phase C

- manually classify one small trusted manufacturer family
- likely candidates: Netgear M4250, a small Bose family, or one Blustream line

### Phase D

- add proposal/review workflow
- human approval only

### Phase E

- add MCP-assisted research and proposal generation
- still no direct apply without approval

### Phase F

- promote reviewed templates to `trusted-standard`
- use those families as the basis for safer import suggestions

Rollback and compatibility:

- keep old fields readable until rollout completes
- do not remove current `deviceType`, `category`, `signalType`, `connectorType`
- treat V2 additions as additive until reviewed data volume proves the model

## 18. Recommendation

Concrete recommendation:

Implement next:

1. schema-only V2 additions for template-level review metadata and additive taxonomy fields
2. canonical registries for deviceType, category, roleTags, `deviceCapabilities`, protocols, and aliases
3. read-only API surfaces to list vocabularies, show template taxonomy state, and preview proposals

Do not implement yet:

- auto-normalization rules
- automatic migration mappings
- MCP write/apply flows
- broad runtime behavior changes tied to the new taxonomy

What belongs in the next PR:

- type additions
- read-only taxonomy registry definitions
- read-only API endpoints
- maybe audit/report extensions that expose ambiguity and review status

What belongs later:

- human review tooling
- family-by-family curation
- AI/MCP proposal generation
- approved apply workflow with audit logs

Bottom line:

The strongest direction is not to make `category` smarter. It is to make `category` dumber, keep `deviceType` primary, and move all nuanced AV meaning into additive reviewed fields with evidence.

## 19. Real Database Validation

Local DB path:

- `.tateside-data/vps-master/tateside.db`

Remote source identified:

- VPS host identified and reached over SSH using the laptop's TateSide-specific SSH key
- remote app path confirmed as `/home/debian/EasySchematic`
- remote DB path confirmed as `/var/lib/tateside-schematic/tateside.db`
- storage method confirmed as a host file used by the host-side `tateside-schematic-api.service`, not a container-internal DB path

Copy and snapshot method:

- the live DB had active WAL companions:
  - `/var/lib/tateside-schematic/tateside.db-wal`
  - `/var/lib/tateside-schematic/tateside.db-shm`
- because WAL was active, the snapshot was not taken with a raw `scp` of the live DB file
- the safe method used was:
  1. open the live DB read-only on the VPS with Python's `sqlite3`
  2. create a SQLite backup snapshot to `/tmp/tateside.db.snapshot-work-laptop`
  3. `scp` that snapshot to `.tateside-data/vps-master/tateside.db`
- this avoided mutating the source DB and avoided a potentially inconsistent raw copy of only the main file

Read-only confirmation:

- no remote DB writes were made to the source database
- no services were restarted
- no containers were changed
- no migrations were run
- the local snapshot path is Git-ignored by `.gitignore`

Headline audit counts from the copied snapshot:

```json
{
  "templatesScanned": 1137,
  "totalIssues": 3530,
  "actionableIssues": 2682,
  "errorCount": 906,
  "warningCount": 12,
  "infoCount": 2612,
  "completenessIssueCount": 848
}
```

Comparison with the previous known result:

- exact match on all seven headline values
- that strongly suggests the copied snapshot is the same real TateSide library lineage that was audited on the previous machine

Taxonomy pressure points found in real data:

- `euroblock` is the dominant noncanonical connector term by far with 895 occurrences
- `custom` and `other` are heavily concentrated in real manufacturers, especially Powersoft and Blustream, so ambiguous port meaning is not theoretical
- noncanonical categories in real use are small but telling: `DSP`, `Video`, `USB`, `VC`, `Accessories`, `Video Conferencing`
- there were no noncanonical `deviceType` values in the real snapshot, which supports keeping `deviceType` as the primary controlled object field
- there were no noncanonical `signalType` values in the real snapshot, which suggests the current signal vocabulary is broad enough for import survival, even if semantically overloaded
- there were 2 real `inout` direction values, confirming alias/deprecation handling is needed
- missing dimensions remain a large real-data issue, especially across displays, speakers, amplifiers, and related install gear

Top real-data issue clusters that matter most for V2:

- Powersoft `custom` and `other` port values
- Bose Professional `euroblock`
- Biamp `euroblock`
- Blaze Audio `euroblock`
- Blustream `custom` and `other`
- wide missing-dimensions clusters for Samsung, LG Electronics, 1 SOUND, AUDAC, and Powersoft

Impact on sections 1-18:

- sections 1-18 remain directionally valid
- the real data strengthens the case that:
  - `category` should stay broad and boring
  - `deviceType` should remain the primary controlled object field
  - `connectorType` needs alias/deprecation handling before any automatic correction
  - `protocols` and `brandConventions` are necessary because real vendors overload the same physical connector and generic placeholders differently

Recommendations that become stronger after real-data validation:

- alias/deprecation strategy should explicitly handle `euroblock`, `xlr-trs-combo`, `3.5mm`, `dc-barrel`, and `inout`
- brand conventions should start with the manufacturers that dominate real issue counts:
  - Powersoft
  - Bose Professional
  - Blustream
  - Biamp
  - Blaze Audio
- the first human-reviewed manufacturer family should probably be chosen from those high-pressure groups, not from a cleaner edge case

New risks or contradictions discovered:

- no contradiction was found strong enough to change the V2 direction
- the only meaningful contradiction to a simplistic cleanup plan is that the current `deviceType` vocabulary is cleaner in real data than `category` and `connectorType`, so V2 should not over-rotate into making `deviceType` looser
- real data confirms that the highest-risk write automation would be connector alias normalization and semantic interpretation of generic port values, especially where manufacturer conventions matter

## 20. Final Architecture Decisions Before Implementation

### Category meaning

- `category` remains a broad, boring UI grouping only.
- It is not semantic proof.
- It should be small, stable, and useful for browsing.

### DeviceType specialization threshold

Firm decision:

- create a separate `deviceType` only when it represents a genuinely distinct physical/object class, or when EasySchematic needs materially different runtime behavior for that type
- do not create device-type variants merely to encode feature bundles

Therefore:

- keep `amplifier`
- keep `audio-dsp`
- keep `ceiling-mic`
- keep `ptz-camera`
- keep `avoip-transmitter` and `avoip-receiver`
- keep `hdbaset-transmitter` and `hdbaset-receiver`
- do not add `conferencing-dsp` in the first implementation
- do not add `dsp-amplifier` in the first implementation
- do not add `network-amplifier` in the first implementation

Concrete recommendation:

- Powersoft Unica stays `deviceType: amplifier`
- Bose EX-1280C stays `deviceType: audio-dsp`
- flexible meaning moves to `roleTags`, `deviceCapabilities`, and `protocols`

### RoleTags

- include `roleTags` in the first implementation
- keep them controlled-vocabulary, multi-valued, and alias-aware
- use them for deployment context and room/system role, not primary identity

### DeviceCapabilities

- include `deviceCapabilities` in the first implementation
- use the explicit name `deviceCapabilities`
- do not use plain `capabilities` at template level because `Port.capabilities` already exists

### Protocols

- include `protocols` in the first implementation
- use them for things like `dante`, `aes67`, `amplink`, `voip`, `ndi`, `hdbaset`
- they are additive semantics, not replacements for `deviceType`

### Transports included or deferred

Firm decision:

- defer `transports` from the first implementation

Why:

- the proposed values do not yet form one clearly useful workflow layer
- many candidate transport concepts are already partly represented by `signalType`, `connectorType`, or future `protocols`
- the first additive PR does not need this extra field to solve the real pain points visible in the DB

Revisit only when:

- a concrete workflow cannot be expressed cleanly with `signalType` plus `protocols`

### ConnectorType

- keep `connectorType` physical only
- do not overload it with protocol meaning
- add alias/deprecation machinery before any automatic correction

### SignalType

- keep `signalType` in the first implementation
- continue using it as the broad signal family field
- do not attempt a full signal vocabulary rewrite in the next PR

### Conferencing category boundary

Firm decision:

- keep `Conferencing` as a category only for inherently conferencing-specific objects

Examples that belong in `Conferencing`:

- `mtr-compute`
- `video-bar`
- `codec`
- `conference-system`

Examples that should usually stay in inherent object-family categories and gain `roleTags: ["conferencing"]` where needed:

- `ceiling-mic` -> `Audio`
- `ptz-camera` -> `Sources`
- `wireless-presentation` -> `Conferencing` only if TateSide treats it as conferencing-specific workflow gear; otherwise `Sources` or `Video Distribution` can still be argued later

Practical boundary:

- if the object is still fundamentally a microphone, camera, display, or switch, prefer the broad family category and use `roleTags` for deployment context

### Naming collision resolution

Firm decision:

- template-level taxonomy field name is `deviceCapabilities`
- keep existing `Port.capabilities` unchanged

### Alias / deprecation strategy

Minimum first-pass strategy:

- canonical values remain the stored target
- aliases and deprecated values live in registries
- mappings expose semantic risk
- high-risk mappings require human review

Real-data decisions:

- `euroblock` -> candidate alias to `phoenix` or `terminal-block`, but not safe globally without manufacturer/family context
- `xlr-trs-combo` -> likely safe alias to `combo-xlr-trs`
- `3.5mm` -> likely safe alias to `trs-eighth`
- `dc-barrel` -> likely safe alias to `barrel`
- `inout` -> likely safe alias to `bidirectional`, but still reviewable
- noncanonical categories like `DSP`, `Video`, `VC`, and `Video Conferencing` need human-reviewed migration because they collapse meaning, not just spelling

### Minimum review / evidence model

First implementation should include only the minimum safe structure:

- `reviewStatus`
- `classificationConfidence`
- `evidenceRefs`
- `lastReviewedBy`
- `lastReviewedAt`

Required principle:

- AI may propose
- humans approve
- no blind direct mutation

### What the next implementation PR should contain

The next PR should be small and additive:

1. type additions only for:
   - `roleTags`
   - `deviceCapabilities`
   - `protocols`
   - review/evidence metadata
2. canonical registry definitions for:
   - category
   - deviceType
   - roleTags
   - deviceCapabilities
   - protocols
   - aliases/deprecations
3. read-only helpers or API surfaces to:
   - list canonical values
   - list aliases/deprecations
   - inspect template taxonomy state
   - preview proposal candidates without applying them

### What the next implementation PR should explicitly not contain

- no runtime taxonomy rewrites
- no migrations of existing stored data
- no import normalization rules
- no automatic alias application
- no MCP write/apply workflow
- no UI editor expansion beyond what is required for harmless additive field visibility
- no `transports` field
- no new specialized amplifier/DSP hybrid `deviceType`s

Bottom line:

- Taxonomy V2 is settled enough for a small additive implementation PR.
- The first implementation should be deliberately narrow: `category`, `deviceType`, `roleTags`, `deviceCapabilities`, `protocols`, aliases/deprecations, and review/evidence metadata.
- Everything else should wait until those basics exist and real reviewed data starts to accumulate.
