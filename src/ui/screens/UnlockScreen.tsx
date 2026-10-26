import { useEffect, useState } from "react";
import {
  unlockIdentity,
  IdentityError,
  unlockWithWindowsHello,
  canEnableWindowsHello,
  enableWindowsHello,
} from "../../identity";
import type { UnlockedIdentity, UnlockMethod } from "../../identity";
import { useI18n } from "../../i18n";

interface UnlockScreenProps {
  method: UnlockMethod;
  onUnlocked: (identity: UnlockedIdentity) => void;
}

export function UnlockScreen({ method, onUnlocked }: UnlockScreenProps) {
  const { t } = useI18n();
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Windows desktop app only: Hello can be added after a password unlock, or used instead of it.
  const [helloOffer, setHelloOffer] = useState(false);
  const [enableHello, setEnableHello] = useState(false);
  const [showPassword, setShowPassword] = useState(method !== "windows-hello");

  useEffect(() => {
    if (method !== "password") return;
    let alive = true;
    canEnableWindowsHello()
      .then((ok) => alive && setHelloOffer(ok))
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [method]);

  async function unlockHello() {
    setBusy(true);
    setError(null);
    try {
      onUnlocked(await unlockWithWindowsHello());
    } catch {
      // Any Hello problem: the password always works, so offer it.
      setError(t("Windows Hello не успя. Отключи с паролата."));
      setShowPassword(true);
    } finally {
      setBusy(false);
    }
  }

  async function unlock(pw?: string) {
    setBusy(true);
    setError(null);
    try {
      const identity = await unlockIdentity(pw);
      if (pw && enableHello) {
        // Best effort: a failed or cancelled Hello prompt never blocks the unlock.
        await enableWindowsHello(pw).catch(() => undefined);
      }
      onUnlocked(identity);
    } catch (err) {
      if (err instanceof IdentityError && err.code === "DECRYPTION_FAILED") {
        setError(method === "password" ? t("Грешна парола.") : t("Не успяхме да отключим идентичността."));
      } else {
        setError(err instanceof Error ? t(err.message) : t("Грешка при отключване."));
      }
    } finally {
      setBusy(false);
    }
  }

  if (method === "password" || (method === "windows-hello" && showPassword)) {
    return (
      <form
        className="screen"
        onSubmit={(e) => {
          e.preventDefault();
          void unlock(password);
        }}
      >
        <h1>{t("Отключи")}</h1>
        <label>
          {t("Парола")}
          <input
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
          />
        </label>
        {helloOffer && (
          <label>
            <input
              type="checkbox"
              checked={enableHello}
              onChange={(e) => setEnableHello(e.target.checked)}
            />{" "}
            {t("Включи Windows Hello (лице, пръстов отпечатък или PIN) за следващите отключвания")}
          </label>
        )}
        {error && <p role="alert">{error}</p>}
        <button type="submit" disabled={busy}>
          {busy ? t("Отключване…") : t("Отключи")}
        </button>
        {method === "windows-hello" && (
          <button type="button" onClick={() => void unlockHello()} disabled={busy}>
            {t("Отключи с Windows Hello")}
          </button>
        )}
      </form>
    );
  }

  if (method === "windows-hello") {
    return (
      <div className="screen">
        <h1>{t("Добре дошъл отново")}</h1>
        <p>{t("Отключи с Windows Hello, за да продължиш.")}</p>
        {error && <p role="alert">{error}</p>}
        <button onClick={() => void unlockHello()} disabled={busy}>
          {busy ? t("Отключване…") : t("Отключи с Windows Hello")}
        </button>
        <button type="button" onClick={() => setShowPassword(true)} disabled={busy}>
          {t("Използвай паролата")}
        </button>
      </div>
    );
  }

  return (
    <div className="screen">
      <h1>{t("Добре дошъл отново")}</h1>
      <p>{t("Отключи с passkey, за да продължиш.")}</p>
      {error && <p role="alert">{error}</p>}
      <button onClick={() => void unlock()} disabled={busy}>
        {busy ? t("Отключване…") : t("Отключи")}
      </button>
    </div>
  );
}
