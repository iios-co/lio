// Background service worker (WXT). Registers bookmark/tab/visit listeners, runs
// a periodic sync alarm (pull remote deltas + flush queue + flush visits), and
// answers messages from the popup.

import { isConfigured, getConfig, getSyncConfig, setConfig, setSyncConfig, setWatermark, type SyncPair } from "@/lib/config";
import {
  onCreated, onChanged, onMoved, onRemoved, syncTransaction,
  invalidateScopeCache, listFolders, fullPushInScope, inSyncScope, pushLocalOnlyNodes,
  bootstrap, drainBookmarkEvents, setBookmarkSyncRequester,
} from "@/lib/bookmarks";
import {
  diffTrees, describeDiff, linkCount, localNodes, folderNodes, serverNodes, type LeafRef,
} from "@/lib/reconcile";
import { scheduleTabSync, pushNow, markSessionBoundary, adoptSession, restoreHistorySession, localTabs, lastTabPush, compareTabsWithServer } from "@/lib/tabs";
import { recordVisit, flushVisits, invalidateVisitIndex } from "@/lib/visits";
import { size as queueSize } from "@/lib/queue";
import { getLog, clearLog, log } from "@/lib/log";
import { checkGate, resetGate } from "@/lib/gate";
import { api } from "@/lib/api";
import { pushService } from "@/lib/push";

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
          scheduleTabSync();
          await browser.storage.local.set({ lastSyncOkAt: Date.now(), lastSyncError: null });
          reconnecting = false;
        } catch (e) {
          reconnecting = false;
          const message = (e as Error).message || String(e);
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
    historyId?: number;
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
            const { lastSyncOkAt, lastSyncError } = await browser.storage.local.get(["lastSyncOkAt", "lastSyncError"]);
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
                const pairLocal = pairLocalNodes.get(pair.id) ?? [];
                const pairLocalCount = linkCount(pairLocal);

                if (serverTree) {
                  const serverIds = getSubtreeIds(pair.localFolderId, serverTree);
                  const pairServer = serverTree.filter((n) => serverIds.has(n.id) && (pair.localFolderId ? n.id !== pair.localFolderId : true));
                  const pairServerCount = linkCount(pairServer);
                  const pairDiff = diffTrees(pairLocal, pairServer);
                  pairStats[pair.id] = {
                    localCount: pairLocalCount,
                    serverCount: pairServerCount,
                    identical: pairDiff.identical,
                    differences: pairDiff.differences,
                    detail: describeDiff(pairDiff),
                  };
                } else {
                  pairStats[pair.id] = {
                    localCount: pairLocalCount,
                    serverCount: 0,
                    identical: false,
                    differences: 0,
                    detail: "Server unreadable",
                  };
                }
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
            try {
              const r = await fetch(
                `${endpoint}/api/v1/collections/${encodeURIComponent(token)}/info`,
                { headers: { Authorization: `Bearer ${token}` } }
              );
              if (r.ok) {
                verified = true;
                collectionName = (await r.json())?.name ?? null;
              } else if (r.status === 404) {
                error = "That server does not recognise this token.";
              } else {
                error = `Server responded ${r.status}.`;
              }
            } catch (e) {
              error = `Can't reach ${endpoint}: ${(e as Error).message}`;
            }
            if (!verified) {
              sendResponse({ ok: false, error });
              break;
            }
            const mode = msg.bootstrapMode === "server" || msg.bootstrapMode === "browser"
              ? msg.bootstrapMode : "merge";
            await setConfig({ endpoint, token, bootstrapMode: mode });
            await log({
              kind: "info",
              title: `Connected to ${collectionName ?? "collection"}`,
              detail: `First sync will ${mode === "merge" ? "merge this browser with the server" : mode === "server" ? "take the server's tree" : "push this browser's tree"}.`,
            });
            resetGate();
            await checkGate(true);
            invalidateScopeCache();
            invalidateVisitIndex();
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
            const { reconcileFromServer } = await import("@/lib/bookmarks");
            const { log } = await import("@/lib/log");
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
            const next = await setSyncConfig({ globalEnabled: !!msg.enabled });
            if (next.globalEnabled) void runSync();
            sendResponse({ ok: true, sync: next });
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
