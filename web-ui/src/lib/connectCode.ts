function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i];
    if (b !== undefined) binary += String.fromCharCode(b);
  }
  const b64 = globalThis.btoa(binary);
  return b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
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
