/* eslint-disable react-refresh/only-export-components */
import { useEffect, useRef } from "react";
import { DOCUMENT_CHANGE_EVENT, useSchematicStore } from "../store";
import {
  createTatesideSchematic,
  saveTatesideSchematic,
  TatesideApiError,
  type TatesideSchematicDocument,
} from "../tatesideApi";
import type { SchematicFile } from "../types";

const SYNC_DEBOUNCE_MS = 1500;
const SYNC_SOURCE = "easyschematic-autosync";

type SyncStore = {
  exportToJSON: () => SchematicFile;
  isHydrated: boolean;
  isOnline: boolean;
  loadSeq: number;
  setTatesideLink: (id: string | null, savedAt: string | null) => void;
  setTatesideSyncState: (syncState: "idle" | "saving" | "saved" | "offline" | "error", syncError?: string | null) => void;
  tatesideSchematicId: string | null;
};

type SyncResponse = TatesideSchematicDocument & { createdNewVersion?: boolean };

type SchedulerDeps = {
  create: (data: SchematicFile, options?: { source?: string }) => Promise<SyncResponse>;
  getStore: () => SyncStore;
  save: (id: string, data: SchematicFile, options?: { source?: string }) => Promise<SyncResponse>;
  setTimer: typeof setTimeout;
  clearTimer: typeof clearTimeout;
};

export function getSafeTateSideSyncMessage(_error: unknown): string {
  return "Sync failed. Try again later.";
}

export function createTateSideAutoSyncScheduler(deps: SchedulerDeps) {
  let disposed = false;
  let inFlight = false;
  let isHydrated = false;
  let lastConnectivity: boolean | null = null;
  let queued = false;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const clearScheduledRun = () => {
    if (timer !== null) {
      deps.clearTimer(timer);
      timer = null;
    }
  };

  const schedule = (delayMs = SYNC_DEBOUNCE_MS) => {
    if (disposed || !isHydrated) return;
    queued = true;
    clearScheduledRun();
    timer = deps.setTimer(() => {
      timer = null;
      void run();
    }, delayMs);
  };

  const handleOffline = () => {
    if (!isHydrated) return;
    clearScheduledRun();
    queued = false;
    deps.getStore().setTatesideSyncState("offline");
  };

  const run = async () => {
    if (disposed || inFlight) return;

    const store = deps.getStore();
    if (!store.isHydrated) return;
    if (!store.isOnline) {
      handleOffline();
      return;
    }

    queued = false;
    inFlight = true;

    const requestLoadSeq = store.loadSeq;
    const requestSchematicId = store.tatesideSchematicId;
    const data = store.exportToJSON();
    store.setTatesideSyncState("saving");

    try {
      let response: SyncResponse;
      if (requestSchematicId) {
        try {
          response = await deps.save(requestSchematicId, data, { source: SYNC_SOURCE });
        } catch (error) {
          if (error instanceof TatesideApiError && error.status === 404) {
            response = await deps.create(data, { source: SYNC_SOURCE });
          } else {
            throw error;
          }
        }
      } else {
        response = await deps.create(data, { source: SYNC_SOURCE });
      }

      const latestStore = deps.getStore();
      if (!latestStore.isHydrated || latestStore.loadSeq !== requestLoadSeq) return;

      latestStore.setTatesideLink(response.schematic.id, response.schematic.updatedAt);
      latestStore.setTatesideSyncState("saved");
    } catch (error) {
      const latestStore = deps.getStore();
      if (!latestStore.isHydrated || latestStore.loadSeq !== requestLoadSeq) return;
      if (!latestStore.isOnline) {
        latestStore.setTatesideSyncState("offline");
      } else {
        latestStore.setTatesideSyncState("error", getSafeTateSideSyncMessage(error));
      }
    } finally {
      inFlight = false;
      if (!disposed && queued) {
        schedule();
      }
    }
  };

  return {
    dispose() {
      disposed = true;
      clearScheduledRun();
    },
    notifyHydrationChange(nextIsHydrated: boolean) {
      if (disposed) return;
      const becameHydrated = nextIsHydrated && !isHydrated;
      isHydrated = nextIsHydrated;
      if (!becameHydrated) return;

      const store = deps.getStore();
      const online = lastConnectivity ?? store.isOnline;
      if (online) {
        schedule();
      } else {
        handleOffline();
      }
    },
    notifyConnectivityChange(isOnline: boolean) {
      if (disposed) return;
      const changed = lastConnectivity !== isOnline;
      lastConnectivity = isOnline;
      if (!isHydrated || !changed) return;
      if (isOnline) {
        schedule();
      } else {
        handleOffline();
      }
    },
    notifyDocumentChange() {
      if (disposed) return;
      if (!isHydrated) return;
      schedule();
    },
  };
}

type AutoSyncMountDeps = {
  addEventListener: (type: string, listener: EventListener) => void;
  clearTimer: typeof clearTimeout;
  create: SchedulerDeps["create"];
  getStore: () => SyncStore;
  removeEventListener: (type: string, listener: EventListener) => void;
  save: SchedulerDeps["save"];
  setTimer: typeof setTimeout;
};

let sharedScheduler: ReturnType<typeof createTateSideAutoSyncScheduler> | null = null;
let sharedSchedulerMountCount = 0;
let sharedSchedulerDisposeTimer: ReturnType<typeof setTimeout> | null = null;

function getOrCreateSharedScheduler(deps: AutoSyncMountDeps) {
  if (!sharedScheduler) {
    sharedScheduler = createTateSideAutoSyncScheduler({
      clearTimer: deps.clearTimer,
      create: deps.create,
      getStore: deps.getStore,
      save: deps.save,
      setTimer: deps.setTimer,
    });
  }
  return sharedScheduler;
}

export function mountTateSideAutoSync(deps: AutoSyncMountDeps) {
  if (sharedSchedulerDisposeTimer !== null) {
    deps.clearTimer(sharedSchedulerDisposeTimer);
    sharedSchedulerDisposeTimer = null;
  }

  sharedSchedulerMountCount += 1;
  const scheduler = getOrCreateSharedScheduler(deps);
  const handleDocumentChange: EventListener = () => {
    scheduler.notifyDocumentChange();
  };

  deps.addEventListener(DOCUMENT_CHANGE_EVENT, handleDocumentChange);
  scheduler.notifyHydrationChange(deps.getStore().isHydrated);
  scheduler.notifyConnectivityChange(deps.getStore().isOnline);

  return () => {
    deps.removeEventListener(DOCUMENT_CHANGE_EVENT, handleDocumentChange);
    sharedSchedulerMountCount = Math.max(0, sharedSchedulerMountCount - 1);
    if (sharedSchedulerMountCount === 0) {
      sharedSchedulerDisposeTimer = deps.setTimer(() => {
        sharedSchedulerDisposeTimer = null;
        if (sharedSchedulerMountCount === 0 && sharedScheduler) {
          sharedScheduler.dispose();
          sharedScheduler = null;
        }
      }, 0);
    }
  };
}

export function resetTateSideAutoSyncForTests() {
  if (sharedSchedulerDisposeTimer !== null) {
    clearTimeout(sharedSchedulerDisposeTimer);
    sharedSchedulerDisposeTimer = null;
  }
  sharedSchedulerMountCount = 0;
  sharedScheduler?.dispose();
  sharedScheduler = null;
}

export default function TateSideAutoSync() {
  const isHydrated = useSchematicStore((s) => s.isHydrated);
  const isOnline = useSchematicStore((s) => s.isOnline);
  const schedulerRef = useRef<ReturnType<typeof createTateSideAutoSyncScheduler> | null>(null);

  useEffect(() => {
    const cleanup = mountTateSideAutoSync({
      addEventListener: window.addEventListener.bind(window),
      clearTimer: clearTimeout,
      create: createTatesideSchematic,
      getStore: () => useSchematicStore.getState(),
      removeEventListener: window.removeEventListener.bind(window),
      save: saveTatesideSchematic,
      setTimer: setTimeout,
    });
    schedulerRef.current = sharedScheduler;

    return () => {
      cleanup();
      schedulerRef.current = null;
    };
  }, []);

  useEffect(() => {
    schedulerRef.current?.notifyHydrationChange(isHydrated);
  }, [isHydrated]);

  useEffect(() => {
    schedulerRef.current?.notifyConnectivityChange(isOnline);
  }, [isOnline]);

  return null;
}
