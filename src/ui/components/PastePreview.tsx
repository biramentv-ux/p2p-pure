import { useEffect, useRef, useState } from "react";
import { useI18n } from "../../i18n";
import { formatSize } from "../fileSize";

interface PastePreviewProps {
  file: File;
  busy?: boolean;
  onSend: () => void;
  onCancel: () => void;
}

/** A pasted picture waiting above the message box: look at it, then send or drop it. */
export function PastePreview({ file, busy = false, onSend, onCancel }: PastePreviewProps) {
  const { t, locale } = useI18n();
  const [url, setUrl] = useState<string | null>(null);
  const sendButton = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    // An object URL is an external resource: made when the picture arrives, freed when it goes.
    const u = URL.createObjectURL(file);
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setUrl(u);
    return () => URL.revokeObjectURL(u);
  }, [file]);
  // Enter sends straight away; Escape drops the picture.
  useEffect(() => sendButton.current?.focus(), [file]);

  return (
    <div
      className="paste-preview"
      role="group"
      aria-label={t("Поставена снимка")}
      onKeyDown={(e) => {
        if (e.key === "Escape") onCancel();
      }}
    >
      {url && <img src={url} alt={t("Поставена снимка")} />}
      <small>{formatSize(file.size, locale)}</small>
      <span className="call-actions">
        <button ref={sendButton} type="button" disabled={busy} onClick={onSend}>
          {t("Изпрати снимката")}
        </button>
        <button type="button" className="secondary" onClick={onCancel}>
          {t("Откажи")}
        </button>
      </span>
    </div>
  );
}
