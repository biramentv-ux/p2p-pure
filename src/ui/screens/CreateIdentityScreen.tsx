import { useState } from "react";
import { createIdentity, isWebAuthnSupported, IdentityError } from "../../identity";
import type { UnlockedIdentity } from "../../identity";
import { IdentityArt } from "../components/Art";

interface CreateIdentityScreenProps {
  onIdentityCreated: (identity: UnlockedIdentity) => void;
}

const MIN_PASSWORD_LENGTH = 12;

type Stage = "intro" | "password" | "creating" | "show-mnemonic";

export function CreateIdentityScreen({ onIdentityCreated }: CreateIdentityScreenProps) {
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
        setError("Този passkey не поддържа PRF. Задай парола за това устройство.");
        setStage("password");
        return;
      }
      setError(err instanceof Error ? err.message : "Неочаквана грешка при създаване на идентичност.");
      setStage("intro");
    }
  }

  function onPasswordSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (password.length < MIN_PASSWORD_LENGTH) {
      setError(`Паролата трябва да е поне ${MIN_PASSWORD_LENGTH} символа.`);
      return;
    }
    if (password !== passwordConfirm) {
      setError("Паролите не съвпадат.");
      return;
    }
    void run(password);
  }

  const webAuthnOk = isWebAuthnSupported();

  if (stage === "show-mnemonic") {
    return (
      <div className="screen">
        <h1>Запиши тези 12 думи</h1>
        <p>
          Това е единственият начин да възстановиш идентичността си на ново устройство. Приложението
          не може да ти ги покаже отново.
        </p>
        <ol className="mnemonic-grid">
          {mnemonic.split(" ").map((word, i) => (
            <li key={i}>{word}</li>
          ))}
        </ol>
        <label className="confirm-row">
          <input type="checkbox" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} />
          Записах тези думи на сигурно място
        </label>
        <button disabled={!confirmed || !identity} onClick={() => identity && onIdentityCreated(identity)}>
          Продължи
        </button>
      </div>
    );
  }

  if (stage === "password") {
    return (
      <form className="screen" onSubmit={onPasswordSubmit}>
        <h1>Парола за устройството</h1>
        <p>
          Паролата криптира идентичността на това устройство. Без нея не можеш да я отключиш тук. С
          12-те думи обаче можеш да възстановиш идентичността на друго устройство.
        </p>
        <label>
          Парола
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
          Повтори паролата
          <input
            type="password"
            autoComplete="new-password"
            value={passwordConfirm}
            onChange={(e) => setPasswordConfirm(e.target.value)}
            required
          />
        </label>
        {error && <p role="alert">{error}</p>}
        <button type="submit">Създай идентичност</button>
      </form>
    );
  }

  return (
    <div className="screen screen-center">
      <IdentityArt />
      <h1>Създай идентичност</h1>
      <p>Идентичността се генерира локално на това устройство. Нищо не се изпраща към сървър.</p>
      <ul className="chips" aria-hidden="true">
        <li>Локално</li>
        <li>Без сървър</li>
        <li>Без телефон</li>
      </ul>
      {!webAuthnOk && (
        <p>
          Този браузър няма WebAuthn. Ще използваме парола за защита на идентичността.
        </p>
      )}
      {error && <p role="alert">{error}</p>}
      <button
        onClick={() => (webAuthnOk ? void run() : setStage("password"))}
        disabled={stage === "creating"}
      >
        {stage === "creating" ? "Създаване…" : "Създай идентичност"}
      </button>
    </div>
  );
}
