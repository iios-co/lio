// Persisted setup + sync watermark + sync configuration, in browser.storage.local.

export interface LioConfig {
  endpoint: string;
  token: string;
  collectionId: string;
  deviceName: string;
  deviceId: string;
  lastPulledTs: number;
  lastServerVersion: number;
  clientSeq: number;
  /** One-time instruction for the FIRST sync after connecting, when both this
   *  browser and the server already hold bookmarks. Decided at setup:
   *    "merge"   — union: adopt the server's links, push this browser's extras,
   *                pull server-only links down (dedupe by content, guarded).
   *    "server"  — the server is the truth: pull its tree, drop local-only links.
   *    "browser" — this browser is the truth: push everything, drop server-only.
   *  Empty means "no decision needed/recorded" — the first sync defaults to
   *  merge, and the value is cleared once the bootstrap has run. */
  bootstrapMode: "merge" | "server" | "browser" | "";
}

// A sync pair maps a LOCAL browser folder subtree to a COLLECTION folder subtree.
// "Sync everything" is simply a pair with both paths at the root ("").
// type 'bookmark' syncs bookmarks; 'tab' is the tab-session pairing.
export interface SyncPair {
  id: string;
  type: "bookmark" | "tab";
  localFolderId: string; // browser bookmark folder id ("" or root id = everything)
  localFolderName: string;
  collectionPath: string; // "" = collection root; else e.g. "Work" / "Work/Docs"
  enabled: boolean;
}

export interface SyncConfig {
  globalEnabled: boolean;
  pairs: SyncPair[];
}

const DEFAULTS: LioConfig = {
  endpoint: "",
  token: "",
  collectionId: "",
  deviceName: "",
  deviceId: "",
  lastPulledTs: 0,
  lastServerVersion: 0,
  clientSeq: 0,
  bootstrapMode: "",
};
const SYNC_DEFAULTS: SyncConfig = { globalEnabled: true, pairs: [] };

export function ensureOnboardingBookmarkPair(
  syncCfg: SyncConfig,
  isOnboarding: boolean
): { sync: SyncConfig; provisioned: boolean } {
  if (!isOnboarding) {
    return { sync: syncCfg, provisioned: false };
  }
  const hasBookmarkPair = syncCfg.pairs.some((p) => p.type === "bookmark");
  if (hasBookmarkPair) {
    return { sync: syncCfg, provisioned: false };
  }
  const defaultPair: SyncPair = {
    id: "p_everything",
    type: "bookmark",
    localFolderId: "",
    localFolderName: "Everything",
    collectionPath: "/",
    enabled: true,
  };
  return {
    sync: {
      globalEnabled: true,
      pairs: [...syncCfg.pairs, defaultPair],
    },
    provisioned: true,
  };
}

const KEYS = Object.keys(DEFAULTS) as (keyof LioConfig)[];
const SYNC_KEY = "syncConfig";

export async function getConfig(): Promise<LioConfig> {
  const stored = await browser.storage.local.get(KEYS);
  const cfg = { ...DEFAULTS, ...stored } as LioConfig;
  if (!cfg.deviceId) {
    cfg.deviceId = "dev_" + crypto.randomUUID();
    await browser.storage.local.set({ deviceId: cfg.deviceId });
  }
  return cfg;
}

export async function setConfig(patch: Partial<LioConfig>): Promise<void> {
  const clean: Partial<LioConfig> = {};
  for (const k of KEYS) if (k in patch) (clean as Record<string, unknown>)[k] = patch[k];
  await browser.storage.local.set(clean);
}

export async function getSyncConfig(): Promise<SyncConfig> {
  const { [SYNC_KEY]: s } = await browser.storage.local.get(SYNC_KEY);
  return { ...SYNC_DEFAULTS, ...(s as Partial<SyncConfig> | undefined) };
}

export async function setSyncConfig(patch: Partial<SyncConfig>): Promise<SyncConfig> {
  const current = await getSyncConfig();
  const next = { ...current, ...patch };
  await browser.storage.local.set({ [SYNC_KEY]: next });
  return next;
}

export async function setWatermark(ts: number, serverVersion?: number): Promise<void> {
  const patch: Partial<LioConfig> = { lastPulledTs: ts };
  if (serverVersion !== undefined) {
    patch.lastServerVersion = serverVersion;
  }
  await setConfig(patch);
}

export async function setServerVersion(version: number): Promise<void> {
  await setConfig({ lastServerVersion: version });
}

let seqLock: Promise<unknown> = Promise.resolve();

export async function nextClientSequence(count = 1): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    seqLock = seqLock.then(async () => {
      try {
        const cfg = await getConfig();
        const current = cfg.clientSeq || 0;
        const next = current + count;
        await setConfig({ clientSeq: next });
        resolve(current + 1);
      } catch (err) {
        reject(err);
      }
    });
  });
}

export async function isConfigured(): Promise<boolean> {
  const cfg = await getConfig();
  return Boolean(cfg.endpoint && cfg.token);
}
