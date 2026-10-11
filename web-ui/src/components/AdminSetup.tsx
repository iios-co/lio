import { useState } from "react";
import { admin } from "../api";
import { Logo } from "./Logo";
import { BuildStamp } from "./BuildStamp";

// First-run setup — shown when the server has no admin password yet. Sets it
// (min 8 chars, confirmed) and logs in.
export function AdminSetup({ onDone }: { onDone: () => void }) {
  const [username, setUsername] = useState("");
  const [pw, setPw] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const tooShort = pw.length > 0 && pw.length < 8;
  const mismatch = confirm.length > 0 && pw !== confirm;
  const canSubmit = username.trim().length > 0 && pw.length >= 8 && pw === confirm && !busy;

  async function submit() {
    if (!canSubmit) return;
    setBusy(true);
    setError("");
    try {
      await admin.setup(username.trim(), pw);
      onDone();
    } catch (e) {
      setError((e as Error).message || "Setup failed.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="h-full grid place-items-center px-4">
      <div className="w-full max-w-sm card p-6 fade-up">
        <div className="mb-1"><Logo size={40} /></div>
        <div className="flex items-start justify-between gap-3 mb-5">
          <p className="text-sm text-fg-subtle">
            Welcome — create the admin account to secure this server.
          </p>
          <BuildStamp />
        </div>

        <label className="block text-xs font-medium text-fg-muted mb-1">Username</label>
        <input
          autoFocus
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          className="field"
        />

        <label className="block text-xs font-medium text-fg-muted mb-1 mt-3">
          New password
        </label>
        <input
          type="password"
          value={pw}
          onChange={(e) => setPw(e.target.value)}
          className="field"
        />
        {tooShort && <p className="text-orange text-xs mt-1">At least 8 characters.</p>}

        <label className="block text-xs font-medium text-fg-muted mb-1 mt-3">
          Confirm password
        </label>
        <input
          type="password"
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && submit()}
          className="field"
        />
        {mismatch && <p className="text-orange text-xs mt-1">Passwords don't match.</p>}
        {error && <p className="text-red text-xs mt-2">{error}</p>}

        <button
          onClick={submit}
          disabled={!canSubmit}
          className="btn-primary mt-4 w-full"
        >
          {busy ? "Setting up…" : "Set password & continue"}
        </button>
      </div>
    </div>
  );
}
