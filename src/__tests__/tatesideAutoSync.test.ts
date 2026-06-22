import { beforeEach, describe, expect, it, vi } from "vitest";
import { TatesideApiError, type TatesideSchematicDocument } from "../tatesideApi";
import {
  createTateSideAutoSyncScheduler,
  mountTateSideAutoSync,
  resetTateSideAutoSyncForTests,
} from "../components/TateSideAutoSync";
import type { SchematicFile } from "../types";

const schematic: SchematicFile = {
  version: 1,
  name: "Test",
  nodes: [],
  edges: [],
};

type SyncState = "idle" | "saving" | "saved" | "offline" | "error";
type SchedulerDeps = Parameters<typeof createTateSideAutoSyncScheduler>[0];
type SyncResponse = TatesideSchematicDocument & { createdNewVersion?: boolean };

function flushMicrotasks() {
  return Promise.resolve().then(() => Promise.resolve());
}

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((nextResolve) => {
    resolve = nextResolve;
  });
  return { promise, resolve };
}

function makeSyncResponse(id: string, createdNewVersion?: boolean): SyncResponse {
  return {
    schematic: {
      id,
      title: "Test",
      createdAt: "2026-06-22T12:00:00.000Z",
      updatedAt: "2026-06-22T12:00:00.000Z",
      currentVersionSequence: 1,
      currentHash: "hash",
      currentSizeBytes: 1,
      createdByEmail: null,
      updatedByEmail: null,
    },
    version: {
      sequence: 1,
      title: "Test",
      contentHash: "hash",
      sizeBytes: 1,
      source: null,
      createdAt: "2026-06-22T12:00:00.000Z",
      createdByEmail: null,
      isCurrent: true,
    },
    data: schematic,
    ...(createdNewVersion === undefined ? {} : { createdNewVersion }),
  };
}

function createStore(overrides: Partial<{
  isHydrated: boolean;
  isOnline: boolean;
  loadSeq: number;
  tatesideSchematicId: string | null;
}> = {}) {
  const calls: { state: SyncState; error?: string | null }[] = [];
  const links: Array<{ id: string | null; savedAt: string | null }> = [];

  const store = {
    exportToJSON: vi.fn(() => schematic),
    isHydrated: overrides.isHydrated ?? true,
    isOnline: overrides.isOnline ?? true,
    loadSeq: overrides.loadSeq ?? 1,
    setTatesideLink: vi.fn((id: string | null, savedAt: string | null) => {
      links.push({ id, savedAt });
      store.tatesideSchematicId = id;
    }),
    setTatesideSyncState: vi.fn((state: SyncState, error?: string | null) => {
      calls.push({ state, error });
    }),
    tatesideSchematicId: overrides.tatesideSchematicId ?? null,
  };

  return { calls, links, store };
}

describe("createTateSideAutoSyncScheduler", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    resetTateSideAutoSyncForTests();
  });

  it("sets offline and avoids network calls while offline", async () => {
    const { calls, store } = createStore({ isOnline: false, isHydrated: true });
    const create = vi.fn();
    const save = vi.fn();
    const scheduler = createTateSideAutoSyncScheduler({
      clearTimer: clearTimeout,
      create,
      getStore: () => store,
      save,
      setTimer: setTimeout,
    });

    scheduler.notifyDocumentChange();
    scheduler.notifyHydrationChange(true);
    scheduler.notifyConnectivityChange(false);
    await vi.advanceTimersByTimeAsync(1500);

    expect(create).not.toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();
    expect(calls.at(-1)).toEqual({ state: "offline", error: undefined });

    scheduler.dispose();
  });

  it("does not schedule sync work or set sync status before hydration", async () => {
    const { calls, store } = createStore({ isHydrated: false, isOnline: false });
    const create: SchedulerDeps["create"] = vi.fn(async () => makeSyncResponse("created-id")) as SchedulerDeps["create"];
    const save = vi.fn();
    const scheduler = createTateSideAutoSyncScheduler({
      clearTimer: clearTimeout,
      create,
      getStore: () => store,
      save,
      setTimer: setTimeout,
    });

    scheduler.notifyDocumentChange();
    scheduler.notifyConnectivityChange(false);
    await vi.advanceTimersByTimeAsync(1500);

    expect(create).not.toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();
    expect(calls).toEqual([]);

    store.isOnline = true;
    scheduler.notifyConnectivityChange(true);
    store.isHydrated = true;
    scheduler.notifyHydrationChange(true);
    await vi.advanceTimersByTimeAsync(1500);
    await flushMicrotasks();

    expect(create).toHaveBeenCalledTimes(1);
    expect(calls.some((call) => call.state === "saving")).toBe(true);
    expect(calls.some((call) => call.state === "saved")).toBe(true);

    scheduler.dispose();
  });

  it("coalesces edits during an in-flight request into one follow-up sync", async () => {
    const { calls, store } = createStore({ tatesideSchematicId: "schem-1" });
    const deferredSave = createDeferred<SyncResponse>();

    const save: SchedulerDeps["save"] = vi.fn(() => deferredSave.promise) as SchedulerDeps["save"];
    const scheduler = createTateSideAutoSyncScheduler({
      clearTimer: clearTimeout,
      create: vi.fn(async () => makeSyncResponse("schem-created")) as SchedulerDeps["create"],
      getStore: () => store,
      save,
      setTimer: setTimeout,
    });

    scheduler.notifyHydrationChange(true);
    scheduler.notifyDocumentChange();
    await vi.advanceTimersByTimeAsync(1500);
    expect(save).toHaveBeenCalledTimes(1);

    scheduler.notifyDocumentChange();
    await vi.advanceTimersByTimeAsync(1500);
    expect(save).toHaveBeenCalledTimes(1);

    deferredSave.resolve(makeSyncResponse("schem-1", true));
    await flushMicrotasks();

    expect(calls.some((call) => call.state === "saved")).toBe(true);

    await vi.advanceTimersByTimeAsync(1499);
    expect(save).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1);
    expect(save).toHaveBeenCalledTimes(2);

    scheduler.dispose();
  });

  it("creates a replacement record once after a PUT 404", async () => {
    const { links, store } = createStore({ tatesideSchematicId: "missing-id" });
    const save: SchedulerDeps["save"] = vi.fn(async () => {
      throw new TatesideApiError("missing", 404);
    }) as SchedulerDeps["save"];
    const create: SchedulerDeps["create"] = vi.fn(async () => makeSyncResponse("replacement-id")) as SchedulerDeps["create"];
    const scheduler = createTateSideAutoSyncScheduler({
      clearTimer: clearTimeout,
      create,
      getStore: () => store,
      save,
      setTimer: setTimeout,
    });

    scheduler.notifyHydrationChange(true);
    scheduler.notifyDocumentChange();
    await vi.advanceTimersByTimeAsync(1500);
    await flushMicrotasks();

    expect(save).toHaveBeenCalledTimes(1);
    expect(create).toHaveBeenCalledTimes(1);
    expect(links).toEqual([{ id: "replacement-id", savedAt: "2026-06-22T12:00:00.000Z" }]);

    scheduler.dispose();
  });

  it("ignores a stale response after loadSeq changes", async () => {
    const { links, store } = createStore();
    const deferredCreate = createDeferred<SyncResponse>();

    const scheduler = createTateSideAutoSyncScheduler({
      clearTimer: clearTimeout,
      create: vi.fn(() => deferredCreate.promise) as SchedulerDeps["create"],
      getStore: () => store,
      save: vi.fn(async () => makeSyncResponse("saved-id")) as SchedulerDeps["save"],
      setTimer: setTimeout,
    });

    scheduler.notifyHydrationChange(true);
    scheduler.notifyDocumentChange();
    await vi.advanceTimersByTimeAsync(1500);

    store.loadSeq += 1;

    deferredCreate.resolve(makeSyncResponse("stale-id"));
    await flushMicrotasks();

    expect(links).toEqual([]);

    scheduler.dispose();
  });

  it("reuses the shared scheduler across cleanup and remount without a duplicate initial request", async () => {
    const { store } = createStore({ isHydrated: true, isOnline: true });
    const deferredCreate = createDeferred<SyncResponse>();
    const listeners = new EventTarget();
    const create: SchedulerDeps["create"] = vi.fn(() => deferredCreate.promise) as SchedulerDeps["create"];

    const mountDeps = {
      addEventListener: listeners.addEventListener.bind(listeners),
      clearTimer: clearTimeout,
      create,
      getStore: () => store,
      removeEventListener: listeners.removeEventListener.bind(listeners),
      save: vi.fn(async () => makeSyncResponse("saved-id")) as SchedulerDeps["save"],
      setTimer: setTimeout,
    };

    const cleanupFirst = mountTateSideAutoSync(mountDeps);
    await vi.advanceTimersByTimeAsync(1500);
    expect(create).toHaveBeenCalledTimes(1);

    cleanupFirst();
    const cleanupSecond = mountTateSideAutoSync(mountDeps);
    await flushMicrotasks();

    expect(create).toHaveBeenCalledTimes(1);

    deferredCreate.resolve(makeSyncResponse("created-id"));
    await flushMicrotasks();

    cleanupSecond();
  });
});
