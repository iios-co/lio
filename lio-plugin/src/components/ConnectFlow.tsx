// First-run connection, rendered INSIDE the popup panel.
//
// This used to be a separate `options_ui` page. Chrome renders that as a modal
// centred over chrome://extensions — there is no API to anchor an options page
// to the toolbar icon — so an extension with no options page is the only way
// every surface stays attached to the button. Hence: no options entrypoint, and
// this flow lives in the popup like everything else.

import { useEffect, useState } from "react";
import { Logo } from "@/components/Logo";
import { setConfig } from "@/lib/config";

function suggestDeviceName(): string {
  const uaData = (navigator as unknown as { userAgentData?: { brands?: { brand: string }[]; platform?: string } })
    .userAgentData;
  let browserName = "Browser";
  let os = "device";
  if (uaData) {
    const brand = uaData.brands?.find((b) => !/Not.?A.?Brand/i.test(b.brand));
    if (brand) browserName = brand.brand;
    if (uaData.platform) os = uaData.platform;
  } else {
    const ua = navigator.userAgent;
    if (/Firefox\//.test(ua)) browserName = "Firefox";
    else if (/Edg\//.test(ua)) browserName = "Edge";
    else if (/Chrome\//.test(ua)) browserName = "Chrome";
    if (/Mac/.test(ua)) os = "macOS";
    else if (/Win/.test(ua)) os = "Windows";
    else if (/Linux/.test(ua)) os = "Linux";
  }
  const suffix = crypto.randomUUID().slice(0, 4);
  return `${browserName} on ${os} (${suffix})`;
}

type Conn = "idle" | "testing" | "choose" | "ok" | "fail";
type Mode = "merge" | "server" | "browser";

export function ConnectFlow({ onDone }: { onDone: () => void }) {
  const [endpoint, setEndpoint] = useState("");
  const [token, setToken] = useState("");
  const [deviceName, setDeviceName] = useState("");
  const [conn, setConn] = useState<Conn>("idle");
  const [msg, setMsg] = useState("");
  // How many links the server already holds and how many this browser has, so the
  // first-sync choice is made with the real numbers in front of the user rather
  // than in the abstract.
  const [serverLinks, setServerLinks] = useState<number | null>(null);
  const [localLinks, setLocalLinks] = useState<number | null>(null);

  useEffect(() => {
    void (async () => {
      const cfg = await browser.storage.local.get(["endpoint", "token", "deviceName"]);
      setEndpoint((cfg.endpoint as string) || "");
      setToken((cfg.token as string) || "");
      setDeviceName((cfg.deviceName as string) || suggestDeviceName());
    })();
  }, []);

  async function countLocalLinks(): Promise<number> {
    let links = 0;
    const walk = (nodes: Browser.bookmarks.BookmarkTreeNode[]) => {
      for (const n of nodes) {
        if (n.url) links += 1;
        if (n.children) walk(n.children);
      }
    };
    const tree = await browser.bookmarks.getTree().catch(() => null);
    if (tree) walk(tree);
    return links;
  }

  // Step 1: verify endpoint + token together, and read both sides' link counts so
  // the user can choose the first-sync policy from real numbers. Nothing is saved
  // until they choose.
  async function verify() {
    const ep = endpoint.trim();
    const tk = token.trim();
    if (!ep || !tk) { setConn("fail"); setMsg("Endpoint and token are required."); return; }
    try { new URL(ep); } catch { setConn("fail"); setMsg("Endpoint must be a valid URL."); return; }

    setConn("testing"); setMsg("");
    const base = ep.replace(/\/+$/, "");
    let count: number | null = null;
    try {
      const res = await fetch(
        `${base}/api/v1/collections/${encodeURIComponent(tk)}/bookmarks/tree`,
        { headers: { Authorization: `Bearer ${tk}` } }
      );
      if (res.status === 401 || res.status === 403 || res.status === 404) {
        setConn("fail");
        setMsg("Server reachable, but that collection token was rejected. Check the token in your Lio admin console.");
        return; // do NOT save a bad token
      }
      if (!res.ok) throw new Error(`Server returned ${res.status}`);
      const body = (await res.json()) as { nodes?: { is_folder?: boolean; url?: string | null }[] };
      count = (body.nodes ?? []).filter((n) => !n.is_folder && n.url).length;
    } catch (e) {
      setConn("fail");
      setMsg(`Could not reach the server at ${base}. Check the URL and that lio-server is running. (${(e as Error).message})`);
      return; // do NOT save when unconfirmed
    }

    const local = await countLocalLinks();
    setServerLinks(count);
    setLocalLinks(local);

    // If the server is empty there is nothing to decide — a merge and a
    // browser-wins both just upload this browser. Skip straight to connecting.
    if (count === 0) {
      await commit("merge");
      return;
    }
    setConn("choose");
  }

  // Step 2: persist the chosen policy and connect.
  async function commit(mode: Mode) {
    const ep = endpoint.trim();
    const tk = token.trim();
    const r = await browser.runtime.sendMessage({
      type: "SET_CONNECTION", endpoint: ep, token: tk, bootstrapMode: mode,
    }).catch(() => null) as { ok?: boolean; error?: string } | null;

    if (!r?.ok) {
      setConn("fail");
      setMsg(r?.error || "Could not save the connection.");
      return;
    }
    // Also persist the device name (SET_CONNECTION does not carry it).
    await setConfig({ deviceName: deviceName.trim() });

    setConn("ok");
    // State ONLY what is proven. The token was verified and the policy recorded,
    // so "connected" is earned; the first sync has not finished yet, so name what
    // is about to happen rather than claiming an outcome.
    const verb = mode === "server"
      ? "pulling the server's bookmarks into this browser"
      : mode === "browser"
        ? "pushing this browser's bookmarks to the server"
        : "merging this browser with the server";
    setMsg(`Connected — first sync is ${verb}.`);
    void browser.runtime.sendMessage({ type: "SYNC_NOW" }).catch(() => {});
    // Straight into the real popup: the panel stays open, so the user watches the
    // sync they just authorised instead of being sent to another window.
    setTimeout(onDone, 900);
  }

  if (conn === "choose") {
    return (
      <div className="w-96 p-4">
        <ChoosePanel
          serverLinks={serverLinks ?? 0}
          localLinks={localLinks ?? 0}
          onPick={(m) => void commit(m)}
          onBack={() => { setConn("idle"); setMsg(""); }}
        />
      </div>
    );
  }

  return (
    <div className="w-96 p-4 fade-up">
      <div className="grid place-items-center mb-2"><Logo size={36} /></div>
      <h1 className="text-sm font-semibold text-fg mb-1 text-center">Connect a collection</h1>
      <p className="text-[11px] text-fg-subtle mb-4 text-center">
        Link this browser to a self-hosted lio-server collection.
      </p>

      <Field label="Server endpoint" hint="Full base URL to your lio-server (no trailing path)." htmlFor="server-endpoint-input">
        <input id="server-endpoint-input" className="field w-full" type="url" placeholder="https://lio.example.com"
          value={endpoint} onChange={(e) => setEndpoint(e.target.value)} disabled={conn === "testing"} />
      </Field>

      <Field label="Collection token" hint="Any browser using the same token syncs to the same collection." htmlFor="collection-token-input">
        <input id="collection-token-input" className="field w-full" type="text" placeholder="paste your collection token"
          value={token} onChange={(e) => setToken(e.target.value)} disabled={conn === "testing"} />
      </Field>

      <Field label="Device name" hint="Shown to your other devices when adopting tab sessions." htmlFor="device-name-input">
        <input id="device-name-input" className="field w-full" type="text" placeholder="Work Laptop"
          value={deviceName} onChange={(e) => setDeviceName(e.target.value)} disabled={conn === "testing"} />
      </Field>

      <button onClick={() => void verify()} disabled={conn === "testing" || conn === "ok"}
        className="btn-primary w-full py-2 text-sm mt-2">
        {conn === "testing" ? "Connecting…" : conn === "ok" ? "Connected" : "Continue"}
      </button>
      {msg && <p className={`text-[11px] mt-3 ${conn === "fail" ? "text-orange" : "text-green"}`}>{msg}</p>}
    </div>
  );
}

// The first-sync policy, offered with the real counts on both sides. This is the
// decision that used to be made silently (and wrongly) by a blind push.
function ChoosePanel({ serverLinks, localLinks, onPick, onBack }: {
  serverLinks: number; localLinks: number;
  onPick: (m: Mode) => void; onBack: () => void;
}) {
  return (
    <div className="fade-up">
      <button onClick={onBack} className="btn-ghost btn-sm mb-3">← Back</button>
      <h1 className="text-sm font-semibold text-fg mb-1">How should the first sync go?</h1>
      <p className="text-[11px] text-fg-subtle mb-4">
        This browser has <b className="text-fg">{localLinks}</b> link{localLinks === 1 ? "" : "s"};
        the server collection already has <b className="text-fg">{serverLinks}</b>.
        Pick what happens once.
      </p>

      <div className="space-y-2">
        <Choice
          recommended
          title="Merge both"
          body="Union: keep this browser's links AND pull the server's. Links that are the same on both sides are matched and joined (their visit history is kept); only genuinely new links are added to either side. Nothing is lost."
          onClick={() => onPick("merge")}
        />
        <Choice
          title="Use the server's bookmarks"
          body="The server is the truth. Pull its whole tree into this browser; links that exist ONLY here and not on the server are removed to match. Choose this when this browser is stale and another device is up to date."
          destructive={localLinks > 0}
          onClick={() => onPick("server")}
        />
        <Choice
          title="Use this browser's bookmarks"
          body="This browser is the truth. Push its whole tree; server links that don't exist here are removed. Choose this only when the server copy is stale and this browser is the good one."
          destructive={serverLinks > 0}
          onClick={() => onPick("browser")}
        />
      </div>
    </div>
  );
}

function Choice({ title, body, onClick, recommended, destructive }: {
  title: string; body: string; onClick: () => void;
  recommended?: boolean; destructive?: boolean;
}) {
  const accent = destructive ? "var(--red)" : recommended ? "var(--green)" : "var(--cyan)";
  return (
    <button
      onClick={onClick}
      className="w-full text-left rounded-xl px-3 py-2.5 transition-colors border"
      style={{
        borderColor: `color-mix(in srgb, ${accent} ${recommended ? 40 : 24}%, transparent)`,
        background: `color-mix(in srgb, ${accent} ${recommended ? 10 : 6}%, transparent)`,
      }}
    >
      <div className="flex items-center gap-2">
        <span className="text-[12px] font-semibold" style={{ color: accent }}>{title}</span>
        {recommended && (
          <span className="text-[9px] px-1.5 py-0.5 rounded-full"
            style={{ color: "var(--green)", background: "color-mix(in srgb, var(--green) 16%, transparent)" }}>
            recommended
          </span>
        )}
      </div>
      <p className="text-[11px] leading-snug text-fg-muted mt-1">{body}</p>
    </button>
  );
}

function Field({ label, hint, htmlFor, children }: { label: string; hint: string; htmlFor?: string; children: React.ReactNode }) {
  return (
    <div className="mb-3">
      <label htmlFor={htmlFor} className="block text-[11px] font-semibold text-fg mb-1">{label}</label>
      {children}
      <p className="text-[10px] text-fg-subtle mt-1">{hint}</p>
    </div>
  );
}
