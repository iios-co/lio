// Real-time WebSocket push client for lio-plugin.
// Connects to /api/v1/collections/{token}/ws?device_id={deviceId}
// Listens for server mutation events and triggers immediate sync (< 50ms).
// Reconnects with fast exponential backoff (< 1s initial) when connection drops.

import { getConfig, isConfigured } from "./config";
import { checkGate } from "./gate";

export type PushEventCallback = (event: {
  event: string;
  origin?: string | null;
  timestamp?: number;
  reason?: string;
}) => void | Promise<void>;

class PushService {
  private ws: WebSocket | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private retryDelayMs = 500;
  private onSync: PushEventCallback | null = null;
  private stopped = false;
  private connecting = false;

  public isConnected(): boolean {
    return this.ws !== null && this.ws.readyState === WebSocket.OPEN;
  }

  public start(onSync: PushEventCallback): void {
    this.stopped = false;
    this.onSync = onSync;
    void this.connect();
  }

  public stop(): void {
    this.stopped = true;
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
    if (this.ws) {
      try {
        this.ws.close();
      } catch {
        /* ignore */
      }
      this.ws = null;
    }
  }

  public notifyLocalActivity(): void {
    if (!this.isConnected() && !this.connecting && !this.stopped) {
      if (this.retryTimer) {
        clearTimeout(this.retryTimer);
        this.retryTimer = null;
      }
      this.retryDelayMs = 500;
      void this.connect();
    }
  }

  public async connect(): Promise<void> {
    if (this.stopped || this.connecting || this.isConnected()) return;

    if (!(await isConfigured())) return;
    const cfg = await getConfig();
    if (!cfg.endpoint || !cfg.token) return;

    this.connecting = true;
    const wsBase = cfg.endpoint.trim().replace(/\/+$/, "").replace(/^http/i, "ws");
    const wsUrl = `${wsBase}/api/v1/collections/${encodeURIComponent(cfg.token)}/ws?device_id=${encodeURIComponent(cfg.deviceId)}`;

    try {
      const ws = new WebSocket(wsUrl);
      this.ws = ws;

      ws.onopen = () => {
        this.connecting = false;
        this.retryDelayMs = 500;
        this.startPing();
        // Trigger sync immediately on connect to catch up with anything missed while offline
        if (this.onSync) {
          void this.onSync({ event: "connected" });
        }
      };

      ws.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);
          if (data && typeof data === "object") {
            if (data.event === "bookmarks_updated" || data.event === "tabs_updated") {
              // Ignore if we authored this change
              if (data.origin && data.origin === cfg.deviceId) return;
              if (this.onSync) {
                void this.onSync(data);
              }
            }
          }
        } catch {
          /* ignore non-JSON */
        }
      };

      ws.onerror = () => {
        this.connecting = false;
      };

      ws.onclose = (event) => {
        this.connecting = false;
        this.ws = null;
        this.stopPing();
        if (event.code === 1008) {
          // Invalid token / policy violation - re-check gate to report invalid token
          void checkGate(true);
        }
        if (!this.stopped) {
          this.scheduleReconnect();
        }
      };
    } catch {
      this.connecting = false;
      this.ws = null;
      if (!this.stopped) {
        this.scheduleReconnect();
      }
    }
  }

  private scheduleReconnect(): void {
    if (this.retryTimer || this.stopped) return;
    const delay = this.retryDelayMs;
    // Exponential backoff: 500ms, 1s, 2s, max 5s
    this.retryDelayMs = Math.min(5000, this.retryDelayMs * 2);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      void this.connect();
    }, delay);
  }

  private startPing(): void {
    this.stopPing();
    this.pingTimer = setInterval(() => {
      if (this.isConnected() && this.ws) {
        try {
          this.ws.send(JSON.stringify({ action: "ping" }));
        } catch {
          /* ignore */
        }
      }
    }, 25_000);
  }

  private stopPing(): void {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
  }
}

export const pushService = new PushService();
