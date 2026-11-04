import { useId, useState } from "react";
import { fetchInvitation, formatShortCode, shareInvitation, ShortInviteError } from "../../p2p/shortInvite";
import { formatPairingCode, parsePairingCode, type PairingCode } from "../../p2p/pairingCode";
import { copyWithAutoClear } from "../clipboard";
import { useI18n } from "../../i18n";

/** Uploads a signed invitation and shows the short code to read aloud or type on the other device. */
export function ShortCodeShare({ payload }: { payload: string }) {
  const { t } = useI18n();
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
      setError(err instanceof ShortInviteError ? t(err.message) : t("Не успях да създам кратък код."));
    } finally {
      setBusy(false);
    }
  }

  if (!code) {
    return (
      <>
        {error && <p role="alert">{error}</p>}
        <button className="secondary" onClick={onCreate} disabled={busy}>
          {busy ? t("Създавам код…") : t("Покажи кратък код")}
        </button>
      </>
    );
  }
  return (
    <div>
      <p>
        {t("Кратък код:")} <strong className="short-code">{formatShortCode(code)}</strong>
      </p>
      <p>{t("Важи {minutes} минути и работи само веднъж.", { minutes })}</p>
    </div>
  );
}

/** Lets the person type a short code and receives the invitation it stands for. */
export function ShortCodeEnter({ onPayload }: { onPayload: (payload: string) => void | Promise<void> }) {
  const { t } = useI18n();
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
      setError(err instanceof ShortInviteError ? t(err.message) : t("Не успях да прочета кода."));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      {error && <p role="alert">{error}</p>}
      <label>
        {t("Кратък код")}
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
        {busy ? t("Проверявам…") : t("Провери кода")}
      </button>
    </div>
  );
}

/**
 * Demo room pairing code: the room id the Worker issued and the three words made on this
 * device. Shown big, grouped, and copyable. The words never go to the server.
 */
export function PairingCodeShare({ code }: { code: PairingCode }) {
  const { t } = useI18n();
  const [copied, setCopied] = useState(false);
  const full = formatPairingCode(code);
  async function copy() {
    try {
      await copyWithAutoClear(full);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  }
  return (
    <div>
      <p className="short-code pairing-code" aria-label={t("Код за сдвояване: {code}", { code: full })}>
        <span className="pairing-room">{code.room}</span>
        <span aria-hidden="true"> · </span>
        <span className="pairing-words" style={{ letterSpacing: "0.05em" }}>
          {code.words.join("-")}
        </span>
      </p>
      <button type="button" className="secondary" onClick={() => void copy()}>
        {copied ? t("Копирано") : t("Копирай кода")}
      </button>
    </div>
  );
}

/** One field for the whole pairing code (room id and three words), parsed locally. */
export function PairingCodeEnter({ onSubmit }: { onSubmit: (code: PairingCode) => void }) {
  const { t } = useI18n();
  const [value, setValue] = useState("");
  const [tried, setTried] = useState(false);
  const helpId = useId();
  const errorId = useId();
  const parsed = parsePairingCode(value);
  const showError = tried && value.trim() !== "" && !parsed;
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        setTried(true);
        if (parsed) onSubmit(parsed);
      }}
    >
      <label>
        {t("Код за сдвояване")}
        <input
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder="K7M2Q · lemon-rocket-bridge"
          autoComplete="off"
          autoCapitalize="none"
          spellCheck={false}
          maxLength={80}
          aria-describedby={showError ? `${helpId} ${errorId}` : helpId}
          aria-invalid={showError}
        />
      </label>
      <p id={helpId}>{t("Въведи петте знака и трите думи. Стигат първите 4 букви от всяка дума.")}</p>
      {showError && (
        <p id={errorId} role="alert">
          {t("Кодът не е разпознат. Провери петте знака и трите думи.")}
        </p>
      )}
      <button type="submit" disabled={value.trim() === ""}>
        {t("Присъедини се")}
      </button>
    </form>
  );
}
