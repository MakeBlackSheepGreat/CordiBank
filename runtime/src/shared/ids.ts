import { randomBytes } from "node:crypto";

/** 统一的可读时间戳入口。 */
export function nowIso(): string {
  return new Date().toISOString();
}

/** 统一的短标识生成入口。 */
export function shortId(prefix: string): string {
  const bytes = randomBytes(5);
  let n = 0n;
  for (const b of bytes) n = (n << 8n) | BigInt(b);
  const chars = "0123456789abcdefghijklmnopqrstuvwxyz";
  let s = "";
  do {
    s = chars[Number(n % 36n)] + s;
    n /= 36n;
  } while (n > 0n);
  return `${prefix}${s.padStart(8, "0")}`;
}
