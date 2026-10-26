/** 1536 -> "1,5 KB", 52428800 -> "50 MB". */
export function formatSize(bytes: number, locale: string): string {
  const units = ["B", "KB", "MB", "GB"];
  let v = bytes;
  let u = 0;
  while (v >= 1024 && u < units.length - 1) {
    v /= 1024;
    u++;
  }
  return `${new Intl.NumberFormat(locale, { maximumFractionDigits: u === 0 ? 0 : 1 }).format(v)} ${units[u]}`;
}
