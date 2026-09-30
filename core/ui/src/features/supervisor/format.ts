/**
 * supervisor 共享格式化：页面一律走这里，禁止页面级重定义 fmt 函数。
 * 覆盖后端时间形态：ISO 字符串 / 毫秒时间戳 / Date。
 */
const pad = (n: number) => String(n).padStart(2, "0");

function toDate(v: string | number | Date | null | undefined): Date | null {
  if (v == null) return null;
  const d = v instanceof Date ? v : new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

export function formatClockTime(v?: string | number | Date | null, empty = "—"): string {
  const d = toDate(v);
  if (!d) return empty;
  return pad(d.getHours()) + ":" + pad(d.getMinutes());
}

export function formatDateTime(v?: string | number | Date | null, withSeconds = false, empty = "—"): string {
  const d = toDate(v);
  if (!d) return empty;
  const base = pad(d.getMonth() + 1) + "-" + pad(d.getDate()) + " " + pad(d.getHours()) + ":" + pad(d.getMinutes());
  return withSeconds ? base + ":" + pad(d.getSeconds()) : base;
}

export function formatCount(n?: number | null): string {
  return Number(n ?? 0).toLocaleString("en-US");
}
