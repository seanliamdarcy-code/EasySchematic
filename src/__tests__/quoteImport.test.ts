import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { openDatabase, runMigrations } from "../../tateside-api/src/db.ts";
import { inspectQuoteDevicesAgainstLibrary, matchQuoteDevicesAgainstLibrary, normalizedLookupKey } from "../../tateside-api/src/quoteImport.ts";
import { saveTemplates } from "../../tateside-api/src/deviceStore.ts";
import type { DeviceTemplate } from "../types";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function createTemplate(overrides: Partial<DeviceTemplate> = {}): Omit<DeviceTemplate, "id" | "version"> {
  return {
    label: "Shure ULXD4Q",
    manufacturer: "Shure",
    modelNumber: "ULXD4Q",
    deviceType: "wireless-receiver",
    category: "Audio",
    ports: [
      {
        id: "port-1",
        label: "Dante",
        signalType: "dante",
        connectorType: "rj45",
        direction: "bidirectional",
      },
    ],
    ...overrides,
  };
}

describe("quote import matching", () => {
  it("classifies exact, possible, and missing results", () => {
    const templates = [
      { id: "shure-ulxd4q", version: 1, ...createTemplate() },
      { id: "qsys-core", version: 1, ...createTemplate({
        label: "Q-SYS Core 110f",
        manufacturer: "QSC",
        modelNumber: "Core 110f",
        deviceType: "audio-processor",
      }) },
    ];

    const results = matchQuoteDevicesAgainstLibrary(
      [
        {
          manufacturer: "Shure",
          model: "ULXD4Q",
          description: null,
          quantity: 2,
          sourceLineText: "Shure ULXD4Q receiver",
          normalizedLookupKey: normalizedLookupKey("Shure", "ULXD4Q"),
        },
        {
          manufacturer: "QSC",
          model: "Core 110",
          description: null,
          quantity: null,
          sourceLineText: "QSC Core 110",
          normalizedLookupKey: normalizedLookupKey("QSC", "Core 110"),
        },
        {
          manufacturer: "Biamp",
          model: "TesiraFORTE X 400",
          description: null,
          quantity: null,
          sourceLineText: "Biamp TesiraFORTE X 400",
          normalizedLookupKey: normalizedLookupKey("Biamp", "TesiraFORTE X 400"),
        },
      ],
      templates,
    );

    expect(results[0]?.status).toBe("already_in_library");
    expect(results[0]?.exactMatch?.id).toBe("shure-ulxd4q");

    expect(results[1]?.status).toBe("possible_match");
    expect(results[1]?.possibleMatches[0]?.id).toBe("qsys-core");

    expect(results[2]?.status).toBe("missing");
    expect(results[2]?.possibleMatches).toHaveLength(0);
  });

  it("suggests similar library devices for port reuse before AI research", () => {
    const templates = [
      { id: "samsung-qm55c", version: 1, ...createTemplate({
        label: "Samsung QM55C",
        manufacturer: "Samsung",
        modelNumber: "QM55C",
        deviceType: "display",
        category: "Displays",
      }) },
    ];

    const results = matchQuoteDevicesAgainstLibrary(
      [
        {
          manufacturer: "Samsung",
          model: "QM75C",
          description: "75-inch Commercial 4K UHD Display, 500 NIT",
          quantity: 1,
          sourceLineText: "Samsung QM75C 75-inch Commercial 4K UHD Display, 500 NIT",
          normalizedLookupKey: normalizedLookupKey("Samsung", "QM75C"),
        },
      ],
      templates,
    );

    expect(results[0]?.status).toBe("missing");
    expect(results[0]?.portReuseCandidates[0]?.id).toBe("samsung-qm55c");
  });

  it("does not write to SQLite when only inspecting quote matches", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "quote-import-test-"));
    tempDirs.push(dir);

    const db = openDatabase(path.join(dir, "tateside.db"));
    runMigrations(db);

    saveTemplates(db, {
      templates: [createTemplate()],
      source: "test-seed",
    });

    const count = (sql: string): number => {
      const row = db.prepare(sql).get() as { n: number };
      return row.n;
    };

    const before = {
      devices: count("SELECT COUNT(*) AS n FROM devices"),
      versions: count("SELECT COUNT(*) AS n FROM device_versions"),
      audit: count("SELECT COUNT(*) AS n FROM device_audit_log"),
    };

    const results = inspectQuoteDevicesAgainstLibrary(db, [
      {
        manufacturer: "Shure",
        model: "ULXD4Q",
        description: null,
        quantity: 1,
        sourceLineText: "Shure ULXD4Q",
        normalizedLookupKey: normalizedLookupKey("Shure", "ULXD4Q"),
      },
    ]);

    const after = {
      devices: count("SELECT COUNT(*) AS n FROM devices"),
      versions: count("SELECT COUNT(*) AS n FROM device_versions"),
      audit: count("SELECT COUNT(*) AS n FROM device_audit_log"),
    };

    expect(results[0]?.status).toBe("already_in_library");
    expect(after).toEqual(before);

    db.close();
  });

  it("resolves curated commercial SKUs via identityAliases only", () => {
    const templates = [
      { id: "yealink-a40", version: 1, ...createTemplate({
        label: "MeetingBar A40 All-in-One Video Bar",
        manufacturer: "Yealink",
        modelNumber: "MeetingBar A40",
        deviceType: "video-bar",
        category: "Codecs",
        identityAliases: ["A40-031"],
        searchTerms: ["4k", "Teams", "A40"],
      }) },
      { id: "yealink-a50", version: 1, ...createTemplate({
        label: "MeetingBar A50 All-in-One Video Bar",
        manufacturer: "Yealink",
        modelNumber: "MeetingBar A50",
        deviceType: "video-bar",
        category: "Codecs",
        identityAliases: ["A50-031"],
      }) },
      { id: "shure-mxw1", version: 1, ...createTemplate({
        label: "MXW1 Hybrid Bodypack Transmitter",
        manufacturer: "Shure",
        modelNumber: "MXW1",
        deviceType: "wireless-mic-receiver",
        identityAliases: ["MXW1/O"],
      }) },
      { id: "audac-wp225", version: 1, ...createTemplate({
        label: "WP225 Universal Input Panel",
        manufacturer: "AUDAC",
        modelNumber: "WP225",
        deviceType: "audio-interface",
        category: "Audio I/O",
        identityAliases: ["WP225/W"],
      }) },
      { id: "bose-dm5c", version: 1, ...createTemplate({
        label: "DesignMax DM5C",
        manufacturer: "Bose Professional",
        modelNumber: "DM5C",
        deviceType: "speaker",
        category: "Speakers",
      }) },
    ];

    const results = matchQuoteDevicesAgainstLibrary(
      [
        { manufacturer: "Yealink", model: "A40-031", description: null, quantity: 1, sourceLineText: null, normalizedLookupKey: normalizedLookupKey("Yealink", "A40-031") },
        { manufacturer: "Yealink", model: "A50-031", description: null, quantity: 1, sourceLineText: null, normalizedLookupKey: normalizedLookupKey("Yealink", "A50-031") },
        { manufacturer: "Shure", model: "MXW1/O", description: null, quantity: 1, sourceLineText: null, normalizedLookupKey: normalizedLookupKey("Shure", "MXW1/O") },
        { manufacturer: "AUDAC", model: "WP225/W", description: null, quantity: 1, sourceLineText: null, normalizedLookupKey: normalizedLookupKey("AUDAC", "WP225/W") },
        { manufacturer: "Bose", model: "DM5C", description: null, quantity: 1, sourceLineText: null, normalizedLookupKey: normalizedLookupKey("Bose", "DM5C") },
        { manufacturer: "Yealink", model: "4k", description: null, quantity: 1, sourceLineText: null, normalizedLookupKey: normalizedLookupKey("Yealink", "4k") },
      ],
      templates,
    );

    expect(results[0]?.status).toBe("already_in_library");
    expect(results[0]?.exactMatch?.id).toBe("yealink-a40");
    expect(results[0]?.exactMatch?.matchReason).toMatch(/identity alias/i);

    expect(results[1]?.status).toBe("already_in_library");
    expect(results[1]?.exactMatch?.id).toBe("yealink-a50");

    expect(results[2]?.status).toBe("already_in_library");
    expect(results[2]?.exactMatch?.id).toBe("shure-mxw1");

    expect(results[3]?.status).toBe("already_in_library");
    expect(results[3]?.exactMatch?.id).toBe("audac-wp225");

    expect(results[4]?.status).toBe("already_in_library");
    expect(results[4]?.exactMatch?.id).toBe("bose-dm5c");
    expect(results[4]?.exactMatch?.matchReason).toMatch(/manufacturer alias/i);

    // searchTerms like "4k" must never exact-match
    expect(results[5]?.status).not.toBe("already_in_library");
  });

  it("treats colliding identity aliases as possible_match with all candidates", () => {
    const templates = [
      { id: "left", version: 1, ...createTemplate({ label: "Left", manufacturer: "Acme", modelNumber: "L1", identityAliases: ["SHARED"] }) },
      { id: "right", version: 1, ...createTemplate({ label: "Right", manufacturer: "Acme", modelNumber: "R1", identityAliases: ["SHARED"] }) },
    ];
    const results = matchQuoteDevicesAgainstLibrary(
      [{ manufacturer: "Acme", model: "SHARED", description: null, quantity: 1, sourceLineText: null, normalizedLookupKey: normalizedLookupKey("Acme", "SHARED") }],
      templates,
    );
    expect(results[0]?.status).toBe("possible_match");
    expect(results[0]?.exactMatch).toBeNull();
    expect(results[0]?.possibleMatches.map((m) => m.id).sort()).toEqual(["left", "right"]);
    expect(results[0]?.possibleMatches.every((m) => m.matchReason === "Ambiguous library identity")).toBe(true);
  });

  it("does not exact-match Samsung QM75C to QM55C", () => {
    const templates = [
      { id: "samsung-qm55c", version: 1, ...createTemplate({
        label: "Samsung QM55C",
        manufacturer: "Samsung",
        modelNumber: "QM55C",
        deviceType: "display",
        category: "Displays",
        identityAliases: ["QM55C-SKU"],
      }) },
    ];
    const results = matchQuoteDevicesAgainstLibrary(
      [{
        manufacturer: "Samsung",
        model: "QM75C",
        description: null,
        quantity: 1,
        sourceLineText: null,
        normalizedLookupKey: normalizedLookupKey("Samsung", "QM75C"),
      }],
      templates,
    );
    expect(results[0]?.status).not.toBe("already_in_library");
  });
});
