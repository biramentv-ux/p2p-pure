import { useState } from "react";
import { createIdentity, isWebAuthnSupported, IdentityError } from "../../identity";
import type { UnlockedIdentity } from "../../identity";
import { useI18n } from "../../i18n";
import { IdentityArt } from "../components/Art";

interface CreateIdentityScreenProps {
  onIdentityCreated: (identity: UnlockedIdentity) => void;
}

const MIN_PASSWORD_LENGTH = 12;

type Stage = "intro" | "password" | "creating" | "show-mnemonic";

export function CreateIdentityScreen({ onIdentityCreated }: CreateIdentityScreenProps) {
  const { t } = useI18n();
  const [stage, setStage] = useState<Stage>("intro");
  const [mnemonic, setMnemonic] = useState("");
  const [identity, setIdentity] = useState<UnlockedIdentity | null>(null);
  const [password, setPassword] = useState("");
  const [passwordConfirm, setPasswordConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [confirmed, setConfirmed] = useState(false);

  async function run(passwordFallback?: string) {
    setStage("creating");
    setError(null);
    try {
      const result = await createIdentity(passwordFallback);
      setMnemonic(result.mnemonic);
      setIdentity(result.identity);
      setStage("show-mnemonic");
    } catch (err) {
      if (err instanceof IdentityError && err.code === "PRF_UNSUPPORTED") {
        // This authenticator can't do PRF: ask for a password instead.
        setError(t("Този passkey не поддържа PRF. Задай парола за това устройство."));
        setStage("password");
        return;
      }
      setError(
        err instanceof Error ? t(err.message) : t("Неочаквана грешка при създаване на идентичност."),
      );
      setStage("intro");
    }
  }

  function onPasswordSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (password.length < MIN_PASSWORD_LENGTH) {
      setError(t("Паролата трябва да е поне {n} символа.", { n: MIN_PASSWORD_LENGTH }));
      return;
    }
    if (password !== passwordConfirm) {
      setError(t("Паролите не съвпадат."));
      return;
    }
    void run(password);
  }

  const webAuthnOk = isWebAuthnSupported();

  if (stage === "show-mnemonic") {
    return (
      <div className="screen">
        <h1>{t("Запиши тези 12 думи")}</h1>
        <p>
          {t(
            "Това е единственият начин да възстановиш идентичността си на ново устройство. Приложението не може да ти ги покаже отново.",
          )}
        </p>
        <ol className="mnemonic-grid">
          {mnemonic.split(" ").map((word, i) => (
            <li key={i}>{word}</li>
          ))}
        </ol>
        <label className="confirm-row">
          <input type="checkbox" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} />
          {t("Записах тези думи на сигурно място")}
        </label>
        <button disabled={!confirmed || !identity} onClick={() => identity && onIdentityCreated(identity)}>
          {t("Продължи")}
        </button>
      </div>
    );
  }

  if (stage === "password") {
    return (
      <form className="screen" onSubmit={onPasswordSubmit}>
        <h1>{t("Парола за устройството")}</h1>
        <p>
          {t(
            "Паролата криптира идентичността на това устройство. Без нея не можеш да я отключиш тук. С 12-те думи обаче можеш да възстановиш идентичността на друго устройство.",
          )}
        </p>
        <label>
          {t("Парола")}
          <input
            type="password"
            autoComplete="new-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            minLength={MIN_PASSWORD_LENGTH}
            required
          />
        </label>
        <label>
          {t("Повтори паролата")}
          <input
            type="password"
            autoComplete="new-password"
            value={passwordConfirm}
            onChange={(e) => setPasswordConfirm(e.target.value)}
            required
          />
        </label>
        {error && <p role="alert">{error}</p>}
        <button type="submit">{t("Създай идентичност")}</button>
      </form>
    );
  }

  return (
    <div className="screen screen-center">
      <IdentityArt />
      <h1>{t("Създай идентичност")}</h1>
      <p>{t("Идентичността се генерира локално на това устройство. Нищо не се изпраща към сървър.")}</p>
      <ul className="chips" aria-hidden="true">
        <li>{t("Локално")}</li>
        <li>{t("Без сървър")}</li>
        <li>{t("Без телефон")}</li>
      </ul>
      {!webAuthnOk && (
        <p>{t("Този браузър няма WebAuthn. Ще използваме парола за защита на идентичността.")}</p>
      )}
      {error && <p role="alert">{error}</p>}
      <button
        onClick={() => (webAuthnOk ? void run() : setStage("password"))}
        disabled={stage === "creating"}
      >
        {stage === "creating" ? t("Създаване…") : t("Създай идентичност")}
      </button>
    </div>
  );
}
