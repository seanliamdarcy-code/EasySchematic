import { beforeEach, describe, expect, it, vi } from "vitest";
import { DOCUMENT_CHANGE_EVENT, useSchematicStore } from "../store";
import type { SchematicFile } from "../types";

const AUTOSAVE_KEY = "easyschematic-autosave";

const initialSchematic: SchematicFile = {
  version: 1,
  name: "Initial",
  nodes: [],
  edges: [],
};

const importedSchematic: SchematicFile = {
  version: 1,
  name: "Imported",
  nodes: [],
  edges: [],
};

const storage = new Map<string, string>();

beforeEach(() => {
  storage.clear();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => {
      storage.set(key, value);
    },
    removeItem: (key: string) => {
      storage.delete(key);
    },
    clear: () => {
      storage.clear();
    },
  });
  vi.stubGlobal("window", new EventTarget());
  useSchematicStore.setState({
    nodes: [],
    edges: [],
    pages: [],
    schematicName: "Untitled Schematic",
    isHydrated: false,
    tatesideSchematicId: null,
    tatesideSavedAt: null,
    tatesideSyncState: "idle",
    tatesideSyncError: null,
  });
});

describe("TateSide metadata", () => {
  it("tracks explicit hydration state across restore, parse failure, and async demo fallback", async () => {
    expect(useSchematicStore.getState().isHydrated).toBe(false);

    storage.set(AUTOSAVE_KEY, JSON.stringify(initialSchematic));
    expect(useSchematicStore.getState().loadFromLocalStorage()).toBe(true);
    expect(useSchematicStore.getState().isHydrated).toBe(true);

    useSchematicStore.setState({
      nodes: [],
      edges: [],
      pages: [],
      schematicName: "Untitled Schematic",
      isHydrated: false,
    });
    storage.set(AUTOSAVE_KEY, "{");
    expect(useSchematicStore.getState().loadFromLocalStorage()).toBe(false);
    expect(useSchematicStore.getState().isHydrated).toBe(true);

    useSchematicStore.setState({
      nodes: [],
      edges: [],
      pages: [],
      schematicName: "Untitled Schematic",
      isHydrated: false,
    });
    vi.stubGlobal("localStorage", undefined);
    expect(useSchematicStore.getState().loadFromLocalStorage()).toBe(false);
    expect(useSchematicStore.getState().isHydrated).toBe(true);

    vi.stubGlobal("localStorage", {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => {
        storage.set(key, value);
      },
      removeItem: (key: string) => {
        storage.delete(key);
      },
      clear: () => {
        storage.clear();
      },
    });
    useSchematicStore.setState({
      nodes: [],
      edges: [],
      pages: [],
      schematicName: "Untitled Schematic",
      isHydrated: false,
    });
    storage.delete(AUTOSAVE_KEY);
    expect(useSchematicStore.getState().loadFromLocalStorage()).toBe(false);
    expect(useSchematicStore.getState().isHydrated).toBe(false);

    await vi.waitFor(() => {
      expect(useSchematicStore.getState().isHydrated).toBe(true);
    });
  });

  it("emits only for document payload changes and suppresses TateSide metadata-only persistence", () => {
    storage.set(AUTOSAVE_KEY, JSON.stringify(initialSchematic));

    const events: string[] = [];
    window.addEventListener(DOCUMENT_CHANGE_EVENT, () => {
      events.push("changed");
    });

    expect(useSchematicStore.getState().loadFromLocalStorage()).toBe(true);
    useSchematicStore.getState().saveToLocalStorage();

    expect(events).toHaveLength(0);

    const store = useSchematicStore.getState();
    store.importFromJSON(importedSchematic);

    expect(events).toHaveLength(1);
    expect(useSchematicStore.getState().tatesideSchematicId).toBeNull();

    store.setTatesideLink("ts-123", "2026-06-22T12:00:00.000Z");
    store.setTatesideSyncState("saved");
    store.saveToLocalStorage();

    expect(events).toHaveLength(1);
    expect(JSON.parse(storage.get(AUTOSAVE_KEY) ?? "{}")).toMatchObject({
      name: "Imported",
      tatesideSchematicId: "ts-123",
      tatesideSavedAt: "2026-06-22T12:00:00.000Z",
    });

    store.newSchematic();

    expect(events).toHaveLength(2);
    expect(JSON.parse(storage.get(AUTOSAVE_KEY) ?? "{}")).toMatchObject({
      name: "Untitled Schematic",
      nodes: [],
      edges: [],
    });
    expect(JSON.parse(storage.get(AUTOSAVE_KEY) ?? "{}").tatesideSchematicId).toBeUndefined();
    expect(JSON.parse(storage.get(AUTOSAVE_KEY) ?? "{}").tatesideSavedAt).toBeUndefined();
  });
});
