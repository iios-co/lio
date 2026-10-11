import { useState } from "react";
import { admin, ApiError } from "../api";
import { Logo } from "./Logo";
import { BuildStamp } from "./BuildStamp";

// Admin login — gates the whole console. Server-wide password, no token.
export function AdminLogin({ onLoggedIn }: { onLoggedIn: () => void }) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit() {
    if (!username || !password) return;
    setBusy(true);
    setError("");
    try {
      await admin.login(username, password);
      onLoggedIn();
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) {
        setError("Incorrect username or password.");
      } else {
        setError((e as Error).message || "Login failed.");
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="h-full grid place-items-center px-4">
      <div className="w-full max-w-sm card p-6 fade-up">
        <div className="mb-1"><Logo size={40} /></div>
        <div className="flex items-center justify-between mb-5">
          <p className="text-sm text-fg-subtle">Admin console</p>
          <BuildStamp />
        </div>
        <label className="block text-xs font-medium text-fg-muted mb-1">Username</label>
        <input
          autoFocus
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && submit()}
          className="field"
        />
        <label className="block text-xs font-medium text-fg-muted mb-1 mt-3">Password</label>
        <input
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && submit()}
          className="field"
        />
        {error && <p className="text-red text-xs mt-2">{error}</p>}
        <button
          onClick={submit}
          disabled={!username || !password || busy}
          className="btn-primary mt-4 w-full"
        >
          {busy ? "Signing in…" : "Sign in"}
        </button>
      </div>
    </div>
  );
}
