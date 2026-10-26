import { useEffect, useState } from "react";
import type { FileCard } from "../../history/messageStore";
import { DOWNLOAD_MIME } from "../../p2p/fileTransfer";
import { useI18n } from "../../i18n";
import { formatSize } from "../fileSize";
import { AudioPlayer } from "./AudioPlayer";

interface FileBubbleProps {
  card: FileCard;
  /** Object URL from this session (just sent or received). */
  url?: string;
  /** Reads the kept file from the device, or null when it was not kept. */
  load: () => Promise<Blob | null>;
}

/**
 * One file in the chat. Images and GIFs show inline, videos play inline, anything else is a
 * download link. The blob is labelled with the sniffed type, and only real media get an inline
 * element, so an HTML or SVG file can never render as a page here.
 */
export function FileBubble({ card, url, load }: FileBubbleProps) {
  const { t, locale } = useI18n();
  const [src, setSrc] = useState<string | null>(url ?? null);
  const [missing, setMissing] = useState(false);
  const isImage = card.mime.startsWith("image/");
  const isVideo = card.mime.startsWith("video/");
  const isAudio = card.mime.startsWith("audio/");
  // A track starts by itself only when the person tapped "Play" here.
  const [tapped, setTapped] = useState(false);

  async function open(): Promise<string | null> {
    if (src) return src;
    const blob = card.stored ? await load() : null;
    if (!blob) {
      setMissing(true);
      return null;
    }
    const u = URL.createObjectURL(blob);
    setSrc(u);
    return u;
  }

  // Images from the history load by themselves; videos and other files wait for a tap.
  useEffect(() => {
    if (!src && isImage && card.stored) void open();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  // Object URLs made here are released when the bubble goes away.
  useEffect(() => () => {
    if (src && src !== url) URL.revokeObjectURL(src);
  }, [src, url]);

  const size = formatSize(card.size, locale);
  if (missing) {
    return (
      <span className="msg-file">
        <strong>{card.name}</strong> <small>{size}</small>
        <br />
        <small>{t("Файлът не е запазен на това устройство.")}</small>
      </span>
    );
  }
  if (isImage && src) return <img className="msg-image" src={src} alt={card.name} />;
  if (isAudio && src) return <AudioPlayer src={src} name={card.name} autoPlay={tapped} />;
  if (isVideo && src) return <video className="msg-video" src={src} controls playsInline preload="metadata" aria-label={card.name} />;
  return (
    <span className="msg-file">
      <span className="file-icon" aria-hidden="true">
        {isVideo ? "▶" : isAudio ? "♪" : "⎙"}
      </span>
      <span className="file-meta">
        <strong>{card.name}</strong>
        <small>{size}</small>
      </span>
      {(isVideo || isAudio) && !src ? (
        <button
          type="button"
          className="secondary"
          onClick={() => {
            setTapped(true);
            void open();
          }}
        >
          {t("Пусни")}
        </button>
      ) : (
        <a
          className="file-download"
          href={src ?? "#"}
          download={card.name}
          type={card.mime === DOWNLOAD_MIME ? DOWNLOAD_MIME : undefined}
          onClick={async (e) => {
            if (src) return;
            e.preventDefault();
            const u = await open();
            if (!u) return;
            const a = document.createElement("a");
            a.href = u;
            a.download = card.name;
            a.click();
          }}
        >
          {t("Изтегли")}
        </a>
      )}
    </span>
  );
}

export interface ActiveTransfer {
  id: string;
  name: string;
  size: number;
  direction: "in" | "out";
  /** offer: waiting for this side to accept; waiting: our offer waits for the peer; moving: bytes flow. */
  phase: "offer" | "waiting" | "moving";
  done: number;
}

interface TransferListProps {
  items: ActiveTransfer[];
  onAccept: (id: string) => void;
  onCancel: (id: string) => void;
}

/** Incoming offers (accept or decline) and transfers in progress (with a stop button). */
export function TransferList({ items, onAccept, onCancel }: TransferListProps) {
  const { t, locale } = useI18n();
  if (items.length === 0) return null;
  return (
    <ul className="transfers" aria-label={t("Файлове")}>
      {items.map((it) => {
        const percent = it.size ? Math.min(100, Math.round((it.done / it.size) * 100)) : 0;
        return (
          <li key={it.id} className="transfer">
            <span className="file-meta">
              <strong>{it.name}</strong>
              <small>
                {formatSize(it.size, locale)}
                {" · "}
                {it.phase === "offer"
                  ? t("иска да ти изпрати файл")
                  : it.phase === "waiting"
                    ? t("чака другият да приеме")
                    : it.direction === "in"
                      ? t("получавам {percent}%", { percent })
                      : t("изпращам {percent}%", { percent })}
              </small>
              {it.phase === "moving" && (
                <progress max={100} value={percent} aria-label={t("Напредък на {name}", { name: it.name })} />
              )}
            </span>
            {it.phase === "offer" ? (
              <span className="call-actions">
                <button type="button" onClick={() => onAccept(it.id)}>
                  {t("Приеми")}
                </button>
                <button type="button" className="secondary" onClick={() => onCancel(it.id)}>
                  {t("Откажи")}
                </button>
              </span>
            ) : (
              <button type="button" className="secondary" onClick={() => onCancel(it.id)} aria-label={t("Спри {name}", { name: it.name })}>
                {t("Спри")}
              </button>
            )}
          </li>
        );
      })}
    </ul>
  );
}
