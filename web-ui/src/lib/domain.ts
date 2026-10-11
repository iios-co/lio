// Registrable-domain extraction, for grouping bookmarks into folders.
//
// The rule the folder names follow: take the REGISTRABLE domain (so every
// subdomain collapses into its parent — mail.google.com and drive.google.com are
// both "google"), then drop the public suffix for the folder title, because
// "google" reads better than "google.com" in a folder list.
//
// A full Public Suffix List is ~10k entries and would have to be fetched and kept
// current; that is a poor trade for naming folders. Instead this carries the
// multi-part suffixes that actually appear in browser bookmarks. Anything not
// listed falls back to "last two labels", which is correct for every single-label
// TLD (.com, .org, .dev, .io …).

/** Multi-part public suffixes where the registrable domain is the THIRD label
 *  from the right (bbc.co.uk -> bbc), not the second. */
const MULTI_PART_SUFFIXES = new Set([
  // UK
  "co.uk", "org.uk", "me.uk", "ltd.uk", "plc.uk", "net.uk", "sch.uk", "ac.uk", "gov.uk", "nhs.uk",
  // Australia / NZ
  "com.au", "net.au", "org.au", "edu.au", "gov.au", "id.au",
  "co.nz", "net.nz", "org.nz", "govt.nz", "ac.nz",
  // Japan / Korea / China / HK / TW / SG / IN
  "co.jp", "or.jp", "ne.jp", "ac.jp", "go.jp",
  "co.kr", "or.kr", "ne.kr",
  "com.cn", "net.cn", "org.cn", "gov.cn", "edu.cn",
  "com.hk", "org.hk", "edu.hk",
  "com.tw", "org.tw",
  "com.sg", "edu.sg",
  "co.in", "net.in", "org.in", "gov.in", "ac.in",
  // Europe / Americas / Africa
  "co.za", "org.za", "com.br", "net.br", "org.br", "com.mx", "com.ar",
  "co.il", "com.tr", "com.ua", "com.pl", "com.es", "com.pt", "com.gr",
  // Platform suffixes where the label before them is the real identity
  "github.io", "gitlab.io", "pages.dev", "workers.dev", "vercel.app", "netlify.app",
  "herokuapp.com", "firebaseapp.com", "web.app", "blogspot.com", "wordpress.com",
  "s3.amazonaws.com", "readthedocs.io", "substack.com", "notion.site",
]);

/** The hostname of a URL, lowercased, `www.` stripped. Empty when unparseable. */
export function hostOf(url: string | null | undefined): string {
  if (!url) return "";
  try {
    const h = new URL(url).hostname.toLowerCase();
    return h.startsWith("www.") ? h.slice(4) : h;
  } catch {
    return "";
  }
}

/**
 * The registrable domain: `mail.google.com` -> `google.com`, `bbc.co.uk` ->
 * `bbc.co.uk`, `user.github.io` -> `user.github.io`.
 */
export function registrableDomain(url: string | null | undefined): string {
  const host = hostOf(url);
  if (!host || !host.includes(".")) return host;
  // An IP address has no registrable domain; group it under itself.
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return host;

  const parts = host.split(".");
  // Try the longest multi-part suffix first (s3.amazonaws.com before amazonaws.com).
  for (let take = Math.min(3, parts.length - 1); take >= 2; take--) {
    const candidate = parts.slice(-take).join(".");
    if (MULTI_PART_SUFFIXES.has(candidate)) {
      return parts.slice(-(take + 1)).join(".");
    }
  }
  return parts.slice(-2).join(".");
}

/**
 * The folder title for a domain: the registrable domain with its public suffix
 * dropped. `mail.google.com` -> `google`, `bbc.co.uk` -> `bbc`,
 * `me.github.io` -> `me`. Falls back to the host when there is nothing to strip.
 */
export function domainLabel(url: string | null | undefined): string {
  const reg = registrableDomain(url);
  if (!reg) return "";
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(reg)) return reg;
  const first = reg.split(".")[0] ?? "";
  return first || reg;
}

/**
 * Normalised URL for duplicate detection: lowercase scheme+host, drop a
 * trailing slash and any #fragment, KEEP the query (`?v=abc` is a different
 * video, not the same page). Two bookmarks are duplicates when these match.
 */
export function normalizedUrl(url: string | null | undefined): string {
  if (!url) return "";
  try {
    const u = new URL(url);
    u.hash = "";
    u.hostname = u.hostname.toLowerCase();
    u.protocol = u.protocol.toLowerCase();
    let s = u.toString();
    if (s.endsWith("/")) s = s.slice(0, -1);
    return s;
  } catch {
    return (url || "").trim().toLowerCase().replace(/\/+$/, "");
  }
}
