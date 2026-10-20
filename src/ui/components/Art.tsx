/*
 * Decorative art and avatars. Everything here is inline SVG or CSS so it works
 * offline and never fetches anything. All art is aria-hidden: meaning is always
 * carried by the real text next to it.
 */

const PALETTES = [
  ["#e9a23b", "#c2410c"],
  ["#6fd3c4", "#1d4ed8"],
  ["#f29bb0", "#9333ea"],
  ["#8fc39a", "#0f766e"],
  ["#f4b65a", "#be185d"],
] as const;

function hash(text: string): number {
  let h = 0;
  for (let i = 0; i < text.length; i++) h = (h * 31 + text.charCodeAt(i)) >>> 0;
  return h;
}

/** Deterministic gradient avatar from a contact's DID, with the name's initial. */
export function Avatar({ seed, name }: { seed: string; name: string }) {
  const [from, to] = PALETTES[hash(seed) % PALETTES.length];
  const initial = (Array.from(name.trim())[0] ?? "?").toLocaleUpperCase("bg-BG");
  return (
    <span
      className="avatar"
      aria-hidden="true"
      style={{ background: `linear-gradient(135deg, ${from}, ${to})` }}
    >
      {initial}
    </span>
  );
}

/** Sealed key orb: a lock inside rotating rings. Used on the identity screens. */
export function IdentityArt() {
  return (
    <div className="art art-orb" aria-hidden="true">
      <svg viewBox="0 0 200 200" width="200" height="200">
        <defs>
          <linearGradient id="orb-g" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" stopColor="#f4b65a" />
            <stop offset="1" stopColor="#c2410c" />
          </linearGradient>
          <radialGradient id="orb-glow" cx="50%" cy="50%" r="50%">
            <stop offset="0" stopColor="#e9a23b" stopOpacity="0.35" />
            <stop offset="1" stopColor="#e9a23b" stopOpacity="0" />
          </radialGradient>
        </defs>
        <circle cx="100" cy="100" r="96" fill="url(#orb-glow)" />
        <circle className="ring ring-1" cx="100" cy="100" r="78" fill="none" stroke="#e9a23b" strokeOpacity="0.45" strokeWidth="1.5" strokeDasharray="4 10" />
        <circle className="ring ring-2" cx="100" cy="100" r="60" fill="none" stroke="#6fd3c4" strokeOpacity="0.5" strokeWidth="1.5" strokeDasharray="60 14" />
        <circle cx="100" cy="100" r="42" fill="url(#orb-g)" />
        <rect x="88" y="94" width="24" height="20" rx="4" fill="#1a1206" />
        <path d="M92 94 v-6 a8 8 0 0 1 16 0 v6" fill="none" stroke="#1a1206" strokeWidth="4" strokeLinecap="round" />
        <circle className="dot" cx="100" cy="104" r="2.5" fill="#f4b65a" />
      </svg>
    </div>
  );
}

/** Constellation of nodes linked together: the empty state for contacts. */
export function ConstellationArt() {
  const nodes = [
    [40, 60, "#e9a23b"],
    [160, 46, "#6fd3c4"],
    [100, 110, "#f29bb0"],
    [46, 160, "#8fc39a"],
    [164, 152, "#f4b65a"],
  ] as const;
  return (
    <div className="art art-constellation" aria-hidden="true">
      <svg viewBox="0 0 200 200" width="200" height="200">
        <g stroke="#8b877c" strokeOpacity="0.45" strokeWidth="1.2" fill="none">
          <path className="link" d="M40 60 L100 110 L160 46" />
          <path className="link" d="M100 110 L46 160 L164 152" />
          <path className="link" d="M40 60 L46 160" />
          <path className="link" d="M160 46 L164 152" />
        </g>
        {nodes.map(([x, y, c], i) => (
          <g key={i} className={`node node-${i}`}>
            <circle cx={x} cy={y} r="16" fill={c} fillOpacity="0.16" />
            <circle cx={x} cy={y} r="7" fill={c} />
          </g>
        ))}
      </svg>
    </div>
  );
}
