import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { ConfirmationTicket, IntentSlots } from "./types.ts";

/** 令牌载荷的稳定序列化：键序固定，避免同一组参数产生不同摘要。 */
export function digestOf(tool: string, slots: IntentSlots): string {
  const keys = Object.keys(slots).sort();
  const normalized: Record<string, unknown> = {};
  for (const key of keys) {
    const value = slots[key as keyof IntentSlots];
    if (value !== undefined) normalized[key] = value;
  }
  return createHmac("sha256", "bank-param-digest")
    .update(`${tool}|${JSON.stringify(normalized)}`, "utf8")
    .digest("hex");
}

/** 确认令牌：绑定会话、工具、参数摘要与过期时间，篡改任一字段即失效。 */
export class ConfirmIssuer {
  private readonly secret: Buffer;

  constructor(storeDir: string) {
    const dir = path.join(storeDir, "bank");
    mkdirSync(dir, { recursive: true });
    const file = path.join(dir, "confirm.key");
    if (!existsSync(file)) {
      writeFileSync(file, randomBytes(32).toString("hex"), "utf8");
    }
    this.secret = Buffer.from(readFileSync(file, "utf8").trim(), "hex");
  }

  private sign(payload: string): string {
    return createHmac("sha256", this.secret).update(payload, "utf8").digest("base64url").slice(0, 32);
  }

  issue(input: { sessionId: string; tool: string; slots: IntentSlots; ttlSeconds: number; preview: string }): ConfirmationTicket {
    const digest = digestOf(input.tool, input.slots);
    const expiresAt = new Date(Date.now() + input.ttlSeconds * 1000).toISOString();
    const payload = Buffer.from(
      JSON.stringify({ sessionId: input.sessionId, tool: input.tool, digest, expiresAt }),
      "utf8",
    ).toString("base64url");
    const token = `${payload}.${this.sign(payload)}`;
    return { token, digest, expiresAt, preview: input.preview };
  }

  verify(input: { token: string; sessionId: string; tool: string; slots: IntentSlots }): { ok: boolean; reason: string } {
    const parts = input.token.split(".");
    if (parts.length !== 2) return { ok: false, reason: "令牌格式不合法" };
    const [payload, signature] = parts;
    const expected = this.sign(payload);
    const left = Buffer.from(signature, "utf8");
    const right = Buffer.from(expected, "utf8");
    if (left.length !== right.length || !timingSafeEqual(left, right)) {
      return { ok: false, reason: "令牌签名不匹配" };
    }
    let decoded: { sessionId: string; tool: string; digest: string; expiresAt: string };
    try {
      decoded = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as typeof decoded;
    } catch {
      return { ok: false, reason: "令牌载荷无法解析" };
    }
    if (decoded.sessionId !== input.sessionId) return { ok: false, reason: "令牌与会话不匹配" };
    if (decoded.tool !== input.tool) return { ok: false, reason: "令牌与工具不匹配" };
    if (Date.parse(decoded.expiresAt) < Date.now()) return { ok: false, reason: "令牌已过期" };
    const current = digestOf(input.tool, input.slots);
    if (current !== decoded.digest) return { ok: false, reason: "参数与确认时不一致" };
    return { ok: true, reason: "令牌有效" };
  }
}
