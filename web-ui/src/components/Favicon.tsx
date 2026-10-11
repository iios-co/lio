import { useState } from "react";
import { faviconUrl, letterChip } from "../util";

// THE favicon renderer for every list row in the app (bookmarks tree and device
// tabs). Many sites don't serve /favicon.ico, so a failed load falls back to a
// deterministic letter chip rather than a blank gap. No third-party favicon
// service is used — that would leak every hostname off-device.
export function Favicon({ url, title }: { url: string | null; title?: string }) {
  const [failed, setFailed] = useState(false);
  const src = faviconUrl(url);

  if (!src || failed) {
    const { letter, color } = letterChip(url, title);
    return (
      <span
        aria-hidden
        className="grid place-items-center w-4 h-4 rounded-[4px] text-[9px] font-bold shrink-0"
        style={{ color, background: `color-mix(in srgb, ${color} 20%, transparent)` }}
      >
        {letter}
      </span>
    );
  }
  return (
    <img
      src={src}
      alt=""
      loading="lazy"
      onError={() => setFailed(true)}
      className="w-4 h-4 rounded-[4px] object-contain shrink-0"
    />
  );
}
