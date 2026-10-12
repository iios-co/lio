export interface ConnectDrafts {
  endpoint: string;
  token: string;
  deviceName: string;
}

export interface SettingsDrafts {
  endpoint?: string;
  token?: string;
}

const ONBOARDING_KEYS = [
  "draft_endpoint",
  "draft_token",
  "draft_deviceName",
  "endpoint",
  "token",
  "deviceName",
] as const;

const SETTINGS_KEYS = [
  "draft_settings_endpoint",
  "draft_settings_token",
] as const;

export async function loadConnectDrafts(
  suggestDeviceName: () => string
): Promise<ConnectDrafts> {
  const cfg = await browser.storage.local.get([...ONBOARDING_KEYS]);
  const endpoint =
    (typeof cfg.draft_endpoint === "string"
      ? cfg.draft_endpoint
      : (cfg.endpoint as string)) || "";
  const token =
    (typeof cfg.draft_token === "string"
      ? cfg.draft_token
      : (cfg.token as string)) || "";
  const deviceName =
    (typeof cfg.draft_deviceName === "string"
      ? cfg.draft_deviceName
      : (cfg.deviceName as string)) || suggestDeviceName();
  return { endpoint, token, deviceName };
}

export async function saveConnectDraftField(
  field: "endpoint" | "token" | "deviceName",
  value: string
): Promise<void> {
  const key = `draft_${field}`;
  await browser.storage.local.set({ [key]: value });
}

export async function clearConnectDrafts(): Promise<void> {
  await browser.storage.local.remove([
    "draft_endpoint",
    "draft_token",
    "draft_deviceName",
  ]);
}

export async function loadSettingsDrafts(): Promise<SettingsDrafts> {
  const cfg = await browser.storage.local.get([...SETTINGS_KEYS]);
  const out: SettingsDrafts = {};
  if (typeof cfg.draft_settings_endpoint === "string") {
    out.endpoint = cfg.draft_settings_endpoint;
  }
  if (typeof cfg.draft_settings_token === "string") {
    out.token = cfg.draft_settings_token;
  }
  return out;
}

export async function saveSettingsDraftField(
  field: "endpoint" | "token",
  value: string
): Promise<void> {
  const key = `draft_settings_${field}`;
  await browser.storage.local.set({ [key]: value });
}

export async function clearSettingsDrafts(): Promise<void> {
  await browser.storage.local.remove([
    "draft_settings_endpoint",
    "draft_settings_token",
  ]);
}

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i];
    if (b !== undefined) binary += String.fromCharCode(b);
  }
  const b64 = globalThis.btoa(binary);
  return b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64UrlToBytes(b64url: string): Uint8Array {
  let b64 = b64url.replace(/-/g, "+").replace(/_/g, "/");
  while (b64.length % 4 !== 0) {
    b64 += "=";
  }
  const binary = globalThis.atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

export function formatConnectionString(payload: {
  endpoint: string;
  token: string;
}): string {
  const ep = payload.endpoint.trim().replace(/\/+$/, "");
  const tk = payload.token.trim();
  if (!ep || !tk) {
    throw new Error("Endpoint and token must be non-empty");
  }
  const url = new URL(ep);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Endpoint must be an http or https URL");
  }
  if (url.username || url.password) {
    throw new Error("Endpoint cannot contain credentials");
  }
  if (url.search || url.hash) {
    throw new Error("Endpoint cannot contain query or hash fragment");
  }
  const cleanBase =
    url.origin + (url.pathname === "/" ? "" : url.pathname.replace(/\/+$/, ""));
  const json = JSON.stringify({ endpoint: cleanBase, token: tk });
  const bytes = new TextEncoder().encode(json);
  return `lio-connect:v1:${bytesToBase64Url(bytes)}`;
}

export function parseConnectionString(
  input: string
): { endpoint: string; token: string } | null {
  const trimmed = input.trim();
  const match = trimmed.match(/^lio-connect:v1:([A-Za-z0-9_-]+)$/);
  const payload = match?.[1];
  if (!payload) return null;

  try {
    const bytes = base64UrlToBytes(payload);
    const rawJson = new TextDecoder().decode(bytes);
    const parsed = JSON.parse(rawJson) as {
      endpoint?: unknown;
      token?: unknown;
    };
    if (
      typeof parsed.endpoint !== "string" ||
      typeof parsed.token !== "string"
    ) {
      return null;
    }
    const ep = parsed.endpoint.trim().replace(/\/+$/, "");
    const tk = parsed.token.trim();
    if (!ep || !tk) return null;

    const url = new URL(ep);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return null;
    }
    if (url.username || url.password) {
      return null;
    }
    if (url.search || url.hash) {
      return null;
    }
    const cleanBase =
      url.origin + (url.pathname === "/" ? "" : url.pathname.replace(/\/+$/, ""));
    return { endpoint: cleanBase, token: tk };
  } catch {
    return null;
  }
}
