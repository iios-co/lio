import { useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";

export function useCollectionWebSocket(token: string | null | undefined): void {
  const qc = useQueryClient();

  useEffect(() => {
    if (!token) return;

    let stopped = false;
    let ws: WebSocket | null = null;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    let delay = 1000;

    function connect() {
      if (stopped) return;
      const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
      const host = window.location.host;
      const wsUrl = `${proto}//${host}/api/v1/collections/${encodeURIComponent(token!)}/ws?device_id=web-ui`;

      try {
        ws = new WebSocket(wsUrl);

        ws.onopen = () => {
          delay = 1000;
        };

        ws.onmessage = (event) => {
          try {
            const data = JSON.parse(event.data);
            if (data?.event === "bookmarks_updated") {
              qc.invalidateQueries({ queryKey: ["usage", token] });
              qc.invalidateQueries({ queryKey: ["collections"] });
            } else if (data?.event === "tabs_updated") {
              qc.invalidateQueries({ queryKey: ["sessions", token] });
              qc.invalidateQueries({ queryKey: ["collections"] });
            }
          } catch {
            /* ignore non-JSON */
          }
        };

        ws.onclose = () => {
          ws = null;
          if (!stopped) {
            retryTimer = setTimeout(() => {
              delay = Math.min(5000, delay * 1.5);
              connect();
            }, delay);
          }
        };

        ws.onerror = () => {
          // close handler will trigger retry
        };
      } catch {
        if (!stopped) {
          retryTimer = setTimeout(connect, delay);
        }
      }
    }

    connect();

    return () => {
      stopped = true;
      if (retryTimer) clearTimeout(retryTimer);
      if (ws) {
        try {
          ws.close();
        } catch {
          /* ignore */
        }
      }
    };
  }, [token, qc]);
}
