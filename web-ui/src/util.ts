// Small presentational helpers.

export function relTime(ms: number | null): string {
  if (!ms) return "never";
  const d = Date.now() - ms;
  const min = Math.round(d / 60000);
  if (min < 1) return "just now";
  if (min < 60) return `${min}m ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.round(hr / 24);
  if (day < 30) return `${day}d ago`;
  return `${Math.round(day / 30)}mo ago`;
}

export function formatDateTime(ms: number | null): string {
  if (!ms) return "";
  const d = new Date(ms);
  const now = new Date();
  const timeStr = d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  const isToday = d.toDateString() === now.toDateString();
  if (isToday) return `Today at ${timeStr}`;
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  if (d.toDateString() === yesterday.toDateString()) return `Yesterday at ${timeStr}`;
  const dateStr = d.toLocaleDateString([], { month: "short", day: "numeric" });
  return `${dateStr} at ${timeStr}`;
}

export function faviconUrl(url: string | null): string | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    // Only http(s) can be fetched from a page. Privileged schemes
    // (chrome://, about:, file:, moz-extension: …) are refused by the browser
    // and log "Not allowed to load local resource", so they fall back to a chip.
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    return `${u.origin}/favicon.ico`;
  } catch {
    return null;
  }
}

export function hostOf(url: string | null): string {
  if (!url) return "";
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

// Many sites declare their icon via <link rel="icon"> instead of serving
// /favicon.ico, so a plain <img> often 404s. Rather than leak every bookmark
// hostname to a third-party favicon service, missing icons fall back to a
// deterministic letter chip derived from the host.
const CHIP_COLORS = [
  "var(--blue)", "var(--cyan)", "var(--magenta)", "var(--green)",
  "var(--orange)", "var(--purple)", "var(--yellow)", "var(--teal)",
];

export function letterChip(url: string | null, title?: string): { letter: string; color: string } {
  const host = hostOf(url);
  const basis = host || (title ?? "");
  const letter = (basis.replace(/[^a-z0-9]/gi, "").charAt(0) || "•").toUpperCase();
  let h = 0;
  for (const ch of basis) h = (h * 31 + ch.charCodeAt(0)) & 0x7fffffff;
  return { letter, color: CHIP_COLORS[h % CHIP_COLORS.length]! };
}

export async function copyToClipboard(text: string): Promise<boolean> {
  if (!text) return false;

  // 1. Modern Clipboard API (works in secure contexts: HTTPS or localhost)
  if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // Fall through to execCommand
    }
  }

  // 2. Fallback for non-secure contexts (e.g. HTTP LAN IP addresses like http://10.0.5.x:8000)
  if (typeof document !== "undefined") {
    const textarea = document.createElement("textarea");
    textarea.value = text;
    textarea.setAttribute("readonly", "");
    textarea.style.position = "fixed";
    textarea.style.top = "-9999px";
    textarea.style.left = "-9999px";
    textarea.style.opacity = "0";
    document.body.appendChild(textarea);
    try {
      textarea.focus();
      textarea.select();
      const success = document.execCommand("copy");
      if (success) return true;
    } catch {
      // Fallback failed
    } finally {
      if (textarea.parentNode === document.body) {
        document.body.removeChild(textarea);
      }
    }
  }

  return false;
}
