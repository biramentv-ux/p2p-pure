/**
 * Pure helpers for the download section (no DOM, no network). Used by the page in the browser
 * and by scripts/site/build.mjs in Node, which turns the GitHub releases list into
 * releases.json at build time, so visitors never call the GitHub API themselves.
 */

export const REPO = "biramentv-ux/p2p-pure";
export const RELEASES_URL = `https://github.com/${REPO}/releases`;

/** Each file the site offers: which release family it comes from and how its name looks. */
export const KINDS = {
  windowsSetup: { family: "desktop", re: /^P2P-Messenger-Setup-x64\.exe$/ },
  windowsPortable: { family: "desktop", re: /^P2P-Messenger-portable-x64\.zip$/ },
  windowsWinget: { family: "desktop", re: /^P2P-Messenger-winget-manifests\.zip$/ },
  windowsSums: { family: "desktop", re: /^SHA256SUMS\.txt$/ },
  deb: { family: "desktop", re: /^P2P-Messenger-.+-amd64\.deb$/ },
  rpm: { family: "desktop", re: /^P2P-Messenger-.+-x86_64\.rpm$/ },
  appimage: { family: "desktop", re: /^P2P-Messenger-.+-x86_64\.AppImage$/ },
  flatpak: { family: "desktop", re: /^P2P-Messenger-.+\.flatpak$/ },
  linuxInstall: { family: "desktop", re: /^install\.sh$/ },
  linuxSums: { family: "desktop", re: /^SHA256SUMS-linux\.txt$/ },
  apk: { family: "android", re: /^P2P-Messenger-.+-android\.apk$/ },
  androidSums: { family: "android", re: /^SHA256SUMS-android\.txt$/ },
};

const STABLE = /^(desktop|android)-v(\d+)\.(\d+)\.(\d+)$/;
const ANY = /^(desktop|android)-v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

/**
 * Picks, for every kind of file, the newest published release that has it. Stable tags
 * (desktop-v1.2.3) win over test tags (android-v0.0.0-preview.4); a test build is only
 * offered when no stable release has that file, and is marked `preview: true`.
 * @param {Array<{tag_name:string,draft:boolean,published_at:string|null,html_url?:string,assets?:Array<{name:string,size:number,browser_download_url:string}>}>} releases
 */
export function pickDownloads(releases) {
  const published = (releases ?? [])
    .filter((r) => r && !r.draft && r.published_at && ANY.test(r.tag_name))
    .sort((a, b) => Date.parse(b.published_at) - Date.parse(a.published_at));
  /** @type {Record<string, {name:string,url:string,size:number,tag:string,version:string,preview:boolean,published:string}>} */
  const out = {};
  for (const [kind, { family, re }] of Object.entries(KINDS)) {
    for (const stableFirst of [true, false]) {
      if (out[kind]) break;
      for (const r of published) {
        if (!r.tag_name.startsWith(family + "-")) continue;
        const stable = STABLE.test(r.tag_name);
        if (stableFirst !== stable) continue;
        const a = (r.assets ?? []).find((x) => re.test(x.name));
        if (!a) continue;
        out[kind] = {
          name: a.name,
          url: a.browser_download_url,
          size: a.size,
          tag: r.tag_name,
          version: versionOf(r.tag_name, a.name),
          preview: !stable,
          published: r.published_at,
        };
        break;
      }
    }
  }
  return out;
}

/** The app version: from the file name when it has one (preview tags say 0.0.0), else the tag. */
export function versionOf(tag, fileName = "") {
  const fromName = /-(\d+\.\d+\.\d+)-/.exec(fileName);
  if (fromName) return fromName[1];
  const fromTag = /-v(\d+\.\d+\.\d+)/.exec(tag);
  return fromTag ? fromTag[1] : "";
}

/** "3.2 MB" / "980 KB"; the unit names are the same in both languages. */
export function formatSize(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return "";
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

/**
 * The visitor's system, from what the browser reports. Only used to put the matching download
 * first; nothing is sent anywhere.
 * @returns {"windows"|"linux"|"android"|"ios"|"mac"|"other"}
 */
export function detectOS(ua = "", platform = "", maxTouchPoints = 0) {
  const s = `${ua} ${platform}`.toLowerCase();
  if (/android/.test(s)) return "android";
  if (/iphone|ipad|ipod/.test(s)) return "ios";
  // iPadOS reports itself as a Mac with a touch screen.
  if (/macintosh|mac os x|macintel/.test(s)) return maxTouchPoints > 1 ? "ios" : "mac";
  if (/windows|win32|win64/.test(s)) return "windows";
  if (/linux|x11|cros/.test(s)) return "linux";
  return "other";
}
