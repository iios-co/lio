// Background service worker (WXT). Registers bookmark/tab/visit listeners, runs
// a periodic sync alarm (pull remote deltas + flush queue + flush visits), and
// answers messages from the popup.

import { isConfigured, getConfig, getSyncConfig, setConfig, setSyncConfig, setWatermark, ensureOnboardingBookmarkPair, type SyncPair } from "@/lib/config";
import {
  onCreated, onChanged, onMoved, onRemoved, syncTransaction,
  invalidateScopeCache, listFolders, fullPushInScope, inSyncScope, pushLocalOnlyNodes,
  bootstrap, drainBookmarkEvents, setBookmarkSyncRequester, clearKnownServerIds, reconcileFromServer,
  restoreBaselineFromLocal,
} from "@/lib/bookmarks";
import {
  diffTrees, describeDiff, linkCount, localNodes, folderNodes, serverNodes, type LeafRef,
} from "@/lib/reconcile";
import { scheduleTabSync, pushNow, markSessionBoundary, resetTabPushCache, adoptSession, restoreHistorySession, localTabs, lastTabPush, compareTabsWithServer } from "@/lib/tabs";
import { recordVisit, flushVisits, invalidateVisitIndex } from "@/lib/visits";
import { size as queueSize, clear as clearQueue } from "@/lib/queue";
import { getLog, clearLog, log } from "@/lib/log";
import { checkGate, resetGate } from "@/lib/gate";
import { api } from "@/lib/api";
import { pushService } from "@/lib/push";
import { getServerId } from "@/lib/idMap";

import { SyncCoordinator } from "@/lib/syncCoordinator";
const SYNC_ALARM = "lio-sync";
// MV3 clamps alarms to a 1-minute floor; this is the real retry cadence and is
// reported to the popup so the UI never states a number the code doesn't use.
const SYNC_PERIOD_MINUTES = 1;

export default defineBackground(() => {
  // Bookmark events → deltas.
  browser.bookmarks.onCreated.addListener(onCreated);
  browser.bookmarks.onChanged.addListener(onChanged);
  browser.bookmarks.onMoved.addListener(onMoved);
  browser.bookmarks.onRemoved.addListener(onRemoved);
  browser.bookmarks.onCreated.addListener(() => { invalidateVisitIndex(); invalidateScopeCache(); });
  browser.bookmarks.onRemoved.addListener(() => { invalidateVisitIndex(); invalidateScopeCache(); });
  browser.bookmarks.onChanged.addListener(() => invalidateVisitIndex());
  browser.bookmarks.onMoved.addListener(() => invalidateScopeCache());

  // Visit tracking on navigation complete.
  browser.tabs.onUpdated.addListener((_id, changeInfo, tab) => {
    if (changeInfo.status === "complete" && tab?.url) void recordVisit(tab.url);
  });

  // Debounced tab snapshot on any tab/window change.
  const tabEvents = [
    browser.tabs.onCreated, browser.tabs.onUpdated, browser.tabs.onRemoved,
    browser.tabs.onMoved, browser.tabs.onAttached, browser.tabs.onDetached,
    browser.windows.onCreated, browser.windows.onRemoved,
  ];
  for (const ev of tabEvents) ev.addListener(() => scheduleTabSync());


  async function ensureAlarm() {
    const existing = await browser.alarms.get(SYNC_ALARM);
    if (!existing) browser.alarms.create(SYNC_ALARM, { periodInMinutes: SYNC_PERIOD_MINUTES });
  }

  // True only while a sync cycle is actually running. The popup animates from
  // this, so motion always corresponds to real work.
  let syncInProgress = false;
  let syncPromise: Promise<void> | null = null;
  let lastGateState: string | null = null;
  let reconnecting = false;
  async function runSync(): Promise<void> {
    if (syncPromise) return syncPromise;
    syncPromise = (async () => {
      syncInProgress = true;
      try {
        if (!(await isConfigured())) return;
        const syncCfg = await getSyncConfig();
        if (!syncCfg.globalEnabled || syncCfg.pairs.length === 0) return;

        // THE GATE. Reachable? -> token valid? -> only then do anything. A failed
        // preflight stops every step (push, pull, visits, tab snapshot); the alarm
        // retries on its next tick.
        const gate = await checkGate(true);
        if (lastGateState && lastGateState !== "ok" && gate.state === "ok") {
          reconnecting = true;
        }
        lastGateState = gate.state;
        if (gate.state !== "ok") {
          console.warn(`Lio: sync skipped — ${gate.state}: ${gate.detail ?? ""}`);
          return;
        }

        // ---- initial bootstrap: a fresh browser joining a populated server --
        // lastPulledTs=0 means this browser has never synced. Individual delta ops
        // can't reconstruct the tree (parent folder ids minted by other browsers
        // don't exist locally) and a blind push duplicates every link the server
        // already holds under a different id. So run the merge once, in the mode
        // the user chose at connection time (default: union merge).
        const cfg = await getConfig();
        let step = "push";
        try {
          if (cfg.lastPulledTs === 0 && (cfg.lastServerVersion === 0 || !cfg.lastServerVersion)) {
            step = "bootstrap";
            const mode = cfg.bootstrapMode || "merge";
            const r = await bootstrap(mode);
            step = "watermark";
            const tree = await api.getTree();
            if (tree?.server_timestamp) {
              await setWatermark(tree.server_timestamp, tree.server_version ?? 0);
            }
            if (cfg.bootstrapMode) await setConfig({ bootstrapMode: "" });
            await log({
              kind: "synced",
              title: "Initial sync complete",
              detail: `${r.matched} matched, ${r.pulled} pulled, ${r.pushed} sent.`,
            });
          } else {
            step = "sync";
            const applied = await syncTransaction();
            step = "repair";
            const repair = await pushLocalOnlyNodes();
            if (repair.pushed > 0 || repair.deletedLocally > 0 || repair.unresolved > 0) {
              await log({
                kind: "synced",
                title: repair.unresolved > 0
                  ? `${repair.unresolved} difference${repair.unresolved === 1 ? "" : "s"} need your decision`
                  : `Repaired divergence: sent ${repair.pushed}, removed ${repair.deletedLocally} locally`,
              });
            }
            if (applied > 0) {
              await log({ kind: "synced", title: `Synced ${applied} bookmark change${applied === 1 ? "" : "s"}` });
            }
          }
          step = "visits";
          await flushVisits();
          await browser.storage.local.set({ lastSyncOkAt: Date.now(), lastSyncError: null });
          reconnecting = false;
        } catch (e) {
          reconnecting = false;
          let message = "Unknown error";
          if (e instanceof Error) {
            message = e.message;
          } else if (typeof e === "string") {
            message = e;
          } else if (e && typeof e === "object") {
            try {
              message = JSON.stringify(e);
            } catch {
              message = String(e);
            }
          }
          await browser.storage.local.set({
            lastSyncError: { at: Date.now(), step, message },
          });
          await log({ kind: "error", title: "Sync cycle failed", detail: `${step}: ${message}` });
        }
      } finally {
        syncInProgress = false;
        syncPromise = null;
      }
    })();
    return syncPromise;
  }

  const syncCoordinator = new SyncCoordinator(drainBookmarkEvents, runSync);
  setBookmarkSyncRequester(() => {
    void syncCoordinator.requestSync().catch((e) => {
      console.error("Bookmark sync requester error:", e);
    });
  });

  browser.alarms.onAlarm.addListener((a) => {
    if (a.name === SYNC_ALARM) {
      void syncCoordinator.requestSync().catch((e) => {
        console.error("Alarm sync error:", e);
      });
      if (!pushService.isConnected()) {
        void pushService.connect();
      }
    } else if (a.name === "tabSyncDebounce") {
      void pushNow();
    }
  });
  browser.runtime.onInstalled.addListener(() => {
    void ensureAlarm();
    // A fresh install/update begins a new browsing session: the snapshot the
    // server still holds belongs to the previous one, so it is archived once.
    markSessionBoundary();
    scheduleTabSync();
    pushService.start(async () => {
      await syncCoordinator.requestSync();
    });
  });
  browser.runtime.onStartup.addListener(() => {
    void ensureAlarm();
    // Browser started (or the machine restarted). THIS is a real session
    // boundary — the only thing that archives a past session.
    markSessionBoundary();
    scheduleTabSync();
    pushService.start(async () => {
      await syncCoordinator.requestSync();
    });
  });
  void ensureAlarm();
  pushService.start(async () => {
    await syncCoordinator.requestSync();
  });

  browser.runtime.onMessage.addListener((msg: {
    type?: string; deviceId?: string; pair?: SyncPair; pairId?: string; enabled?: boolean;
    endpoint?: string; token?: string;
    bootstrapMode?: "merge" | "server" | "browser";
    mode?: "merge" | "server" | "browser";
    historyId?: number; confirmed?: boolean; label?: string;
  }, _s, sendResponse) => {
    void (async () => {
      try {
        switch (msg?.type) {
          case "STATUS": {
            const cfg = await getConfig();
            const configured = Boolean(cfg.endpoint && cfg.token);
            // FORCE a fresh probe: the popup being open means the user is
            // watching, and a cached verdict is exactly how a stale "connected"
            // state got shown after going offline.
            const gate = configured ? await checkGate(true) : null;
            const { lastSyncOkAt, lastSyncError, recoveryRequired } = await browser.storage.local.get(["lastSyncOkAt", "lastSyncError", "recoveryRequired"]);
            const tabPush = await lastTabPush();
            const live = await localTabs();

            // The BROWSER's own bookmark truth, plus an actual node-for-node
            // comparison against the server. Previously the popup rendered the
            // server's bookmark_count, so it could never disagree with the web
            // UI and told the user nothing about their real browser tree.
            const localTree = await localNodes();
            const serverTree = gate?.state === "ok" ? await serverNodes() : null;
            const diff = serverTree ? diffTrees(localTree, serverTree) : null;
            // Same standard for the tabs card: an observed match, not a past push.
            const tabDiff = gate?.state === "ok" ? await compareTabsWithServer(live) : null;
            // Per-pair counts and match states. The LOCAL side is a plain
            // subtree read of the chosen folder, so pausing syncing can never
            // change what the browser is reported to hold.
            const syncCfg = await getSyncConfig();
            const bookmarkPairs = syncCfg.pairs.filter((p) => p.type === "bookmark");
            const pairLocalNodes = new Map<string, LeafRef[]>();
            for (const pair of bookmarkPairs) {
              pairLocalNodes.set(pair.id, await folderNodes(pair.localFolderId));
            }
            const localUnion = new Map<string, LeafRef>();
            for (const nodes of pairLocalNodes.values()) {
              for (const n of nodes) localUnion.set(n.id, n);
            }
            const localAll = bookmarkPairs.length > 0
              ? [...localUnion.values()]
              : await folderNodes("");

            const pairStats: Record<string, {
              localCount: number;
              serverCount: number;
              identical: boolean;
              differences: number;
              detail: string;
            }> = {};

            if (bookmarkPairs.length > 0) {
              const getSubtreeIds = (rootId: string, nodes: LeafRef[]): Set<string> => {
                if (!rootId) return new Set(nodes.map((n) => n.id));
                const byParent = new Map<string, string[]>();
                for (const n of nodes) {
                  if (n.parentId) {
                    const list = byParent.get(n.parentId) ?? [];
                    list.push(n.id);
                    byParent.set(n.parentId, list);
                  }
                }
                const out = new Set<string>([rootId]);
                const queue = [rootId];
                while (queue.length > 0) {
                  const cur = queue.pop()!;
                  const children = byParent.get(cur) ?? [];
                  for (const c of children) {
                    if (!out.has(c)) {
                      out.add(c);
                      queue.push(c);
                    }
                  }
                }
                return out;
              };

              for (const pair of bookmarkPairs) {
                const rawLocal = pairLocalNodes.get(pair.id) ?? [];
                const pairLocalCount = linkCount(rawLocal);

                if (!serverTree) {
                  pairStats[pair.id] = {
                    localCount: pairLocalCount,
                    serverCount: 0,
                    identical: false,
                    differences: 0,
                    detail: "Server unreadable",
                  };
                  continue;
                }

                if (!pair.localFolderId && diff) {
                  // "Everything" pair covers the entire in-scope tree, which is exactly diff.
                  pairStats[pair.id] = {
                    localCount: pairLocalCount,
                    serverCount: diff.serverLinks,
                    identical: diff.identical,
                    differences: diff.differences,
                    detail: describeDiff(diff),
                  };
                  continue;
                }

                const serverFolderId = pair.localFolderId
                  ? await getServerId(pair.localFolderId).catch(() => null)
                  : "";

                if (pair.localFolderId && !serverFolderId) {
                  pairStats[pair.id] = {
                    localCount: pairLocalCount,
                    serverCount: 0,
                    identical: false,
                    differences: pairLocalCount,
                    detail: "Folder not yet on server",
                  };
                  continue;
                }

                const serverIds = getSubtreeIds(serverFolderId ?? "", serverTree);
                const pairServer = serverTree.filter(
                  (n) => serverIds.has(n.id) && (serverFolderId ? n.id !== serverFolderId : true)
                );
                const pairServerCount = linkCount(pairServer);

                const localIds = getSubtreeIds(serverFolderId ?? "", localTree);
                const pairLocalMapped = localTree.filter(
                  (n) => localIds.has(n.id) && (serverFolderId ? n.id !== serverFolderId : true)
                );
                const pairDiff = diffTrees(pairLocalMapped, pairServer);

                pairStats[pair.id] = {
                  localCount: pairLocalCount,
                  serverCount: pairServerCount,
                  identical: pairDiff.identical,
                  differences: pairDiff.differences,
                  detail: describeDiff(pairDiff),
                };
              }
            }

            // A DIFFERENCE IS A TRIGGER, NOT A READOUT.
            //
            // Finding a divergence and then sitting there displaying "1678 differ"
            // until the next alarm tick (or until the user does something) is the
            // wrong behaviour: the whole point of detecting it is to converge. So
            // detecting one starts a real sync immediately, and `syncing` goes true
            // so the animation reflects work that is genuinely running.
            const bookmarkDiverged = gate?.state === "ok" && !!diff && !diff.identical;
            if (bookmarkDiverged && !syncInProgress) {
              void runSync();
            }
            if (gate?.state === "ok" && tabDiff && !tabDiff.identical) {
              scheduleTabSync();
            }
            const diverged = bookmarkDiverged || (gate?.state === "ok" && !!tabDiff && !tabDiff.identical);
            sendResponse({
              ok: true,
              // The popup shows the setup gate on `!configured`. This was
              // computed above and then never sent, so the popup read
              // `undefined` and pushed a connected browser to Settings.
              configured,
              localBookmarkCount: linkCount(localAll),
              gateState: gate?.state ?? "unconfigured",
              reachable: gate ? gate.state !== "unreachable" : null,
              tokenValid: gate ? (gate.state === "ok" ? true : gate.state === "invalid-token" ? false : null) : null,
              collectionName: gate?.collectionName ?? null,
              // The server's own figure, labelled as the server's.
              serverBookmarkCount: gate?.serverBookmarkCount ?? null,
              // Null when the server could not be read. The popup must NOT
              // treat "unknown" as "matched".
              treeDiff: diff
                ? {
                    identical: diff.identical,
                    differences: diff.differences,
                    detail: describeDiff(diff),
                    localCount: diff.localCount,
                    serverCount: diff.serverCount,
                    localLinks: diff.localLinks,
                    serverLinks: diff.serverLinks,
                  }
                : null,
              lastError: gate?.detail ?? null,
              checkedAt: gate?.checkedAt ?? null,
              // True only while real sync execution is active
              syncing: syncInProgress,
              // Why it is working, so the popup can say "converging" honestly.
              converging: !!diverged,
              lastSyncOkAt: (lastSyncOkAt as number | undefined) ?? null,
              lastSyncError: (lastSyncError as { at: number; step: string; message: string } | null | undefined) ?? null,
              lastTabPush: tabPush,
              // Null when the server's session could not be read — the popup must
              // NOT treat unknown as matched.
              tabDiff,
              localTabCount: live.count,
              localWindowCount: live.windows,
              deviceName: cfg.deviceName,
              deviceId: cfg.deviceId,
              endpoint: cfg.endpoint,
              token: cfg.token,
              syncIntervalSecs: SYNC_PERIOD_MINUTES * 60,
              queued: await queueSize(),
              version: browser.runtime.getManifest().version,
              pairStats,
              recoveryRequired: recoveryRequired ?? null,
            });
            break;
          }
          case "SET_CONNECTION": {
            const endpoint = String(msg.endpoint ?? "").trim().replace(/\/+$/, "");
            const token = String(msg.token ?? "").trim();
            if (!endpoint || !token) {
              sendResponse({ ok: false, error: "Both server address and token are required." });
              break;
            }
            // Verify BEFORE persisting, so a typo can't silently replace a
            // working configuration.
            let verified = false;
            let error: string | null = null;
            let collectionName: string | null = null;
            let collectionId: string | null = null;
            try {
              const r = await fetch(
                `${endpoint}/api/v1/collections/${encodeURIComponent(token)}/info`,
                { headers: { Authorization: `Bearer ${token}` } }
              );
              if (r.ok) {
                const info = await r.json();
                verified = true;
                collectionName = info?.name ?? null;
                collectionId = info?.id ?? null;
              } else if (r.status === 404) {
                error = "That server does not recognise this token.";
              } else {
                error = `Server responded ${r.status}.`;
              }
            } catch (e) {
              error = `Can't reach ${endpoint}: ${(e as Error).message}`;
            }
            if (!verified || !collectionId) {
              sendResponse({ ok: false, error: error || "Server did not provide a valid collection ID." });
              break;
            }
            const isOnboarding = msg.bootstrapMode === "merge" || msg.bootstrapMode === "server" || msg.bootstrapMode === "browser";
            const mode = isOnboarding ? msg.bootstrapMode : "merge";
            const currentCfg = await getConfig();
            // Token rotation preserves collectionId: only a different collectionId counts as switching
            const isSwitchingCollection = currentCfg.collectionId
              ? currentCfg.collectionId !== collectionId
              : currentCfg.endpoint !== endpoint || currentCfg.token !== token;

            // When onboarding or switching collections, atomically reset watermark,
            // queue, and stale knownServerIds so state from a prior collection or
            // sync session can NEVER poison the new collection.
            if (isOnboarding || isSwitchingCollection) {
              await clearQueue();
              await clearKnownServerIds();
              await setConfig({
                endpoint,
                token,
                collectionId,
                bootstrapMode: mode,
                lastPulledTs: 0,
                lastServerVersion: 0,
              });
            } else {
              await setConfig({ endpoint, token, collectionId, bootstrapMode: mode });
            }
            const syncCfg = await getSyncConfig();
            const { sync: nextSync, provisioned } = ensureOnboardingBookmarkPair(syncCfg, isOnboarding);
            if (provisioned) {
              await setSyncConfig(nextSync);
            }
            await log({
              kind: "info",
              title: `Connected to ${collectionName ?? "collection"}`,
              detail: `First sync will ${mode === "merge" ? "merge this browser with the server" : mode === "server" ? "take the server's tree" : "push this browser's tree"}.`,
            });
            resetGate();
            await checkGate(true);
            invalidateScopeCache();
            invalidateVisitIndex();
            resetTabPushCache();
            pushService.stop();
            pushService.start(async () => {
              await runSync();
            });
            void runSync();
            scheduleTabSync();
            sendResponse({ ok: true, collectionName });
            break;
          }
          case "LOCAL_TABS": {
            sendResponse({ ok: true, ...(await localTabs()) });
            break;
          }
          case "LIST_SESSIONS": {
            const res = await api.listSessions();
            const cfg = await getConfig();
            const sessions = (res?.sessions || []).filter((s) => s.device_id !== cfg.deviceId);
            sendResponse({ ok: true, sessions });
            break;
          }
          case "ADOPT": {
            const result = await adoptSession(msg.deviceId!);
            sendResponse({ ok: true, ...result });
            break;
          }
          case "LIST_TAB_HISTORY": {
            const res = await api.listTabHistory(msg.deviceId);
            sendResponse({ ok: true, history: res?.history || [] });
            break;
          }
          case "RESTORE_HISTORY": {
            const result = await restoreHistorySession(Number(msg.historyId));
            sendResponse({ ok: true, ...result });
            break;
          }
          case "SYNC_NOW": {
            try {
              await syncCoordinator.requestSync();
              scheduleTabSync();
              sendResponse({ ok: true });
            } catch (e) {
              sendResponse({ ok: false, error: (e as Error).message || String(e) });
            }
            break;
          }
          case "FORCE_RECONCILE": {
            try {
              await reconcileFromServer();
              await runSync();
              sendResponse({ ok: true });
            } catch (e) {
              await log({ kind: "error", title: "Force reconcile failed", detail: String(e) });
              sendResponse({ ok: false, error: String(e) });
            }
            break;
          }
          case "GET_SYNC_CONFIG": {
            sendResponse({ ok: true, sync: await getSyncConfig() });
            break;
          }
          case "LIST_FOLDERS": {
            sendResponse({ ok: true, folders: await listFolders() });
            break;
          }
          case "ADD_PAIR": {
            const sync = await getSyncConfig();
            const pair = msg.pair as SyncPair;
            const next = await setSyncConfig({ pairs: [...sync.pairs, pair] });
            invalidateScopeCache();
            await log({ kind: "info", title: `Added sync pair: ${pair.localFolderName || "Everything"}` });
            // A fresh browser (never synced) must NOT blind-push here: that is
            // exactly what duplicated every link the server already held under a
            // different id. The bootstrap merge in runSync owns the first push.
            // An already-synced browser adding a SECOND pair still pushes it now.
            const fresh = (await getConfig()).lastPulledTs === 0;
            if (!fresh) {
              const pushed = await fullPushInScope().catch(() => 0);
              if (pushed) await log({ kind: "synced", title: `Synced ${pushed} bookmarks` });
            }
            void runSync();
            sendResponse({ ok: true, sync: next });
            break;
          }
          case "REMOVE_PAIR": {
            const sync = await getSyncConfig();
            const next = await setSyncConfig({ pairs: sync.pairs.filter((p) => p.id !== msg.pairId) });
            invalidateScopeCache();
            sendResponse({ ok: true, sync: next });
            break;
          }
          case "TOGGLE_PAIR": {
            const sync = await getSyncConfig();
            const next = await setSyncConfig({
              pairs: sync.pairs.map((p) => (p.id === msg.pairId ? { ...p, enabled: !!msg.enabled } : p)),
            });
            invalidateScopeCache();
            sendResponse({ ok: true, sync: next });
            break;
          }
          case "TOGGLE_GLOBAL": {
            await setSyncConfig({ globalEnabled: !!msg.enabled });
            if (msg.enabled) await runSync();
            const current = await getSyncConfig();
            sendResponse({ ok: true, sync: current });
            break;
          }
          case "RESTORE_BASELINE": {
            if (!msg.confirmed) {
              sendResponse({ ok: false, error: "Confirmation required to restore baseline." });
              break;
            }
            const { recoveryRequired } = (await browser.storage.local.get("recoveryRequired")) as {
              recoveryRequired?: { reason?: string } | null;
            };
            if (!recoveryRequired || recoveryRequired.reason !== "tombstone_rejection") {
              sendResponse({ ok: false, error: "No active tombstone rejection incident requires baseline restore." });
              break;
            }
            try {
              const r = await restoreBaselineFromLocal(msg.label || "Restore browser as baseline");
              sendResponse({ ok: true, restored: r.restored, server_version: r.server_version });
            } catch (e) {
              sendResponse({ ok: false, error: (e as Error).message || String(e) });
            }
            break;
          }
          case "RESOLVE_BOOTSTRAP": {
            const mode = msg.mode as "merge" | "server" | "browser";
            if (mode !== "merge" && mode !== "server" && mode !== "browser") {
              sendResponse({ ok: false, error: "Invalid bootstrap mode." });
              break;
            }
            const { recoveryRequired } = (await browser.storage.local.get("recoveryRequired")) as {
              recoveryRequired?: { reason?: string } | null;
            };
            const isBootstrapIncident =
              recoveryRequired?.reason === "bootstrap_needed" ||
              recoveryRequired?.reason === "empty_server_tree" ||
              recoveryRequired?.reason === "unstable_server_tree";
            if (!recoveryRequired || !isBootstrapIncident) {
              sendResponse({ ok: false, error: "No active bootstrap incident requires resolution." });
              break;
            }
            if ((mode === "server" || mode === "browser") && !msg.confirmed) {
              sendResponse({ ok: false, error: "Confirmation required for destructive bootstrap mode." });
              break;
            }
            try {
              await setSyncConfig({ globalEnabled: false });
              const result = await bootstrap(mode, !!msg.confirmed);
              const tree = await api.getTree();
              if (!tree) {
                throw new Error("Cannot verify bootstrap: server tree could not be read.");
              }
              await setWatermark(tree.server_timestamp, tree.server_version || 0);

              const local = await localNodes();
              const sNodes = await serverNodes();
              if (!sNodes) {
                throw new Error("Cannot verify convergence: server tree could not be read.");
              }
              const diff = diffTrees(local, sNodes);
              if (!diff.identical) {
                throw new Error(`Bootstrap failed to converge: ${diff.differences} differences remain.`);
              }

              const cfg = await getConfig();
              const migrationKey = `lio_migrated_${cfg.collectionId || "default"}`;
              await browser.storage.local.set({ [migrationKey]: true });
              await browser.storage.local.remove(["recoveryRequired"]);
              await setConfig({ bootstrapMode: "" });
              await setSyncConfig({ globalEnabled: true });
              sendResponse({ ok: true, result });
            } catch (e) {
              await setSyncConfig({ globalEnabled: false });
              sendResponse({ ok: false, error: (e as Error).message || String(e) });
            }
            break;
          }
          case "GET_LOG": {
            sendResponse({ ok: true, log: await getLog() });
            break;
          }
          case "CLEAR_LOG": {
            await clearLog();
            sendResponse({ ok: true });
            break;
          }
          default:
            sendResponse({ ok: false, error: "Unknown message type." });
        }
      } catch (e) {
        sendResponse({ ok: false, error: (e as Error).message });
      }
    })();
    return true;
  });
});
