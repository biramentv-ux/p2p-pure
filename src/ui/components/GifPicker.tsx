import { useEffect, useRef, useState } from "react";
import { useI18n } from "../../i18n";
import { GIPHY_KEY } from "../giphy";

/**
 * GIF search through GIPHY (Tenor's API closed on 30 June 2026).
 *
 * Privacy: only the person who searches talks to GIPHY. The chosen GIF is downloaded here and
 * sent like any other file, over the direct encrypted links, so the other members never
 * contact GIPHY and GIPHY never learns who received it. The key is a public client key, set
 * at build time with VITE_GIPHY_API_KEY; without it the GIF button is not shown at all.
 */
const API = "https://api.giphy.com/v1/gifs";
/** A GIF bigger than this is not worth sending to every member. */
const MAX_GIF_BYTES = 8 * 1024 * 1024;
const MEDIA_HOST = /^https:\/\/(media\d?|i)\.giphy\.com\//;

interface GiphyItem {
  id: string;
  title: string;
  preview: string;
  full: string;
}

interface GiphyImage {
  url?: string;
}

function parse(json: unknown): GiphyItem[] {
  const data = (json as { data?: unknown[] })?.data;
  if (!Array.isArray(data)) return [];
  const out: GiphyItem[] = [];
  for (const d of data as Array<{ id?: string; title?: string; images?: Record<string, GiphyImage> }>) {
    const preview = d.images?.fixed_width_small?.url ?? d.images?.fixed_width?.url;
    const full = d.images?.downsized?.url ?? d.images?.fixed_width?.url;
    if (typeof d.id !== "string" || !preview || !full || !MEDIA_HOST.test(preview) || !MEDIA_HOST.test(full)) continue;
    out.push({ id: d.id, title: typeof d.title === "string" ? d.title.slice(0, 80) : "GIF", preview, full });
  }
  return out;
}

interface GifPickerProps {
  onPick: (blob: Blob, name: string) => void;
  onClose: () => void;
}

export function GifPicker({ onPick, onClose }: GifPickerProps) {
  const { t, locale } = useI18n();
  const [q, setQ] = useState("");
  const [items, setItems] = useState<GiphyItem[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => input.current?.focus(), []);

  // Search after a short pause in typing; trending when the box is empty.
  useEffect(() => {
    const ctrl = new AbortController();
    const timer = setTimeout(async () => {
      const params = new URLSearchParams({ api_key: GIPHY_KEY, limit: "24", rating: "pg-13", lang: locale.startsWith("bg") ? "bg" : "en" });
      const url = q.trim() ? `${API}/search?${params}&q=${encodeURIComponent(q.trim().slice(0, 50))}` : `${API}/trending?${params}`;
      try {
        const res = await fetch(url, { signal: ctrl.signal, referrerPolicy: "no-referrer", credentials: "omit" });
        if (!res.ok) throw new Error(String(res.status));
        setItems(parse(await res.json()));
        setError(null);
      } catch (err) {
        if ((err as Error).name !== "AbortError") setError(t("GIPHY не отговаря. Опитай пак след малко."));
      }
    }, 400);
    return () => {
      clearTimeout(timer);
      ctrl.abort();
    };
  }, [q, locale, t]);

  async function choose(item: GiphyItem) {
    setBusy(true);
    try {
      const res = await fetch(item.full, { referrerPolicy: "no-referrer", credentials: "omit" });
      const blob = await res.blob();
      if (!res.ok || blob.size === 0 || blob.size > MAX_GIF_BYTES) throw new Error("size");
      onPick(new Blob([blob], { type: "image/gif" }), `giphy-${item.id.replace(/[^A-Za-z0-9]/g, "").slice(0, 24)}.gif`);
      onClose();
    } catch {
      setError(t("Този GIF не може да се свали."));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="call-panel gif-picker" aria-label={t("Избери GIF")}>
      <div className="gif-head">
        <label className="visually-hidden" htmlFor="gif-q">
          {t("Търси GIF")}
        </label>
        <input id="gif-q" ref={input} value={q} onChange={(e) => setQ(e.target.value)} placeholder={t("Търси GIF")} maxLength={50} />
        <button type="button" className="secondary" onClick={onClose}>
          {t("Затвори")}
        </button>
      </div>
      <p className="gif-note">{t("Търсенето отива до GIPHY. Другите получават само самия GIF, директно от теб.")}</p>
      {error && <p role="alert">{error}</p>}
      <ul className="gif-grid">
        {items.map((it) => (
          <li key={it.id}>
            <button type="button" disabled={busy} onClick={() => void choose(it)} aria-label={it.title || "GIF"}>
              <img src={it.preview} alt="" loading="lazy" referrerPolicy="no-referrer" />
            </button>
          </li>
        ))}
      </ul>
      <p className="gif-attribution">Powered by GIPHY</p>
    </section>
  );
}
