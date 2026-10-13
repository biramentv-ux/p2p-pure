import { useState } from "react";
import { unlockIdentity, IdentityError } from "../../identity";
import type { UnlockedIdentity, UnlockMethod } from "../../identity";

interface UnlockScreenProps {
  method: UnlockMethod;
  onUnlocked: (identity: UnlockedIdentity) => void;
}

export function UnlockScreen({ method, onUnlocked }: UnlockScreenProps) {
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function unlock(pw?: string) {
    setBusy(true);
    setError(null);
    try {
      const identity = await unlockIdentity(pw);
      onUnlocked(identity);
    } catch (err) {
      if (err instanceof IdentityError && err.code === "DECRYPTION_FAILED") {
        setError(method === "password" ? "Грешна парола." : "Не успяхме да отключим идентичността.");
      } else {
        setError(err instanceof Error ? err.message : "Грешка при отключване.");
      }
    } finally {
      setBusy(false);
    }
  }

  if (method === "password") {
    return (
      <form
        className="screen"
        onSubmit={(e) => {
          e.preventDefault();
          void unlock(password);
        }}
      >
        <h1>Отключи</h1>
        <label>
          Парола
          <input
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
          />
        </label>
        {error && <p role="alert">{error}</p>}
        <button type="submit" disabled={busy}>
          {busy ? "Отключване…" : "Отключи"}
        </button>
      </form>
    );
  }

  return (
    <div className="screen">
      <h1>Добре дошъл отново</h1>
      <p>Отключи с passkey, за да продължиш.</p>
      {error && <p role="alert">{error}</p>}
      <button onClick={() => void unlock()} disabled={busy}>
        {busy ? "Отключване…" : "Отключи"}
      </button>
    </div>
  );
}
