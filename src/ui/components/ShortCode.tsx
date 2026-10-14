import { useState } from "react";
import { fetchInvitation, formatShortCode, shareInvitation, ShortInviteError } from "../../p2p/shortInvite";

/** Uploads a signed invitation and shows the short code to read aloud or type on the other device. */
export function ShortCodeShare({ payload }: { payload: string }) {
  const [code, setCode] = useState<string | null>(null);
  const [minutes, setMinutes] = useState(10);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onCreate() {
    setBusy(true);
    setError(null);
    try {
      const out = await shareInvitation(payload);
      setCode(out.code);
      setMinutes(Math.round(out.expiresInSec / 60));
    } catch (err) {
      setError(err instanceof ShortInviteError ? err.message : "Не успях да създам кратък код.");
    } finally {
      setBusy(false);
    }
  }

  if (!code) {
    return (
      <>
        {error && <p role="alert">{error}</p>}
        <button className="secondary" onClick={onCreate} disabled={busy}>
          {busy ? "Създавам код…" : "Покажи кратък код"}
        </button>
      </>
    );
  }
  return (
    <div>
      <p>
        Кратък код: <strong className="short-code">{formatShortCode(code)}</strong>
      </p>
      <p>Важи {minutes} минути и работи само веднъж.</p>
    </div>
  );
}

/** Lets the person type a short code and receives the invitation it stands for. */
export function ShortCodeEnter({ onPayload }: { onPayload: (payload: string) => void | Promise<void> }) {
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onUse() {
    setBusy(true);
    setError(null);
    try {
      const payload = await fetchInvitation(value);
      await onPayload(payload);
    } catch (err) {
      setError(err instanceof ShortInviteError ? err.message : "Не успях да прочета кода.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      {error && <p role="alert">{error}</p>}
      <label>
        Кратък код
        <input
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder="ABCDE-FGHJK"
          autoCapitalize="characters"
          autoComplete="off"
          spellCheck={false}
          maxLength={14}
        />
      </label>
      <button className="secondary" onClick={onUse} disabled={busy || value.trim() === ""}>
        {busy ? "Проверявам…" : "Използвай кода"}
      </button>
    </div>
  );
}
