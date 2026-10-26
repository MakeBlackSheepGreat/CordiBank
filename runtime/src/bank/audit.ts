import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import type { AuditRecord, RiskLevel } from "./types.ts";

/** 卡号只保留后四位。 */
export function maskCard(value: string): string {
  const digits = value.replace(/\s+/g, "");
  if (digits.length <= 4) return `****${digits}`;
  return `****${digits.slice(-4)}`;
}

/** 手机号保留前三后四。 */
export function maskPhone(value: string): string {
  const digits = value.replace(/\s+/g, "");
  if (digits.length < 7) return "****";
  return `${digits.slice(0, 3)}****${digits.slice(-4)}`;
}

/** 身份证号保留前四后二。 */
export function maskId(value: string): string {
  const text = value.trim();
  if (text.length < 8) return "****";
  return `${text.slice(0, 4)}********${text.slice(-2)}`;
}

const SENSITIVE_KEYS = ["card", "cardno", "cardnumber", "pan", "phone", "mobile", "idcard", "idno", "accountno"];

/** 参数脱敏：按键名判断敏感字段，卡号取后四位、手机号取前三后四。 */
export function sanitizeParams(params: Record<string, unknown>): Record<string, unknown> {
  const output: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(params)) {
    const lower = key.toLowerCase();
    if (typeof value === "string" && SENSITIVE_KEYS.some((needle) => lower.includes(needle))) {
      if (lower.includes("card") || lower.includes("pan") || lower.includes("accountno")) {
        output[key] = maskCard(value);
      } else if (lower.includes("phone") || lower.includes("mobile")) {
        output[key] = maskPhone(value);
      } else {
        output[key] = maskId(value);
      }
      continue;
    }
    output[key] = value;
  }
  return output;
}

/** 文本脱敏：把回复正文里出现的卡号与手机号替换为掩码。 */
export function maskSensitive(text: string): string {
  return text
    .replace(/\b(\d{16,19})\b/g, (match) => maskCard(match))
    .replace(/\b(1\d{10})\b/g, (match) => maskPhone(match));
}

/** 单条记录的哈希：前序哈希与规范化载荷共同决定，任何历史行被改动都会断链。 */
export function hashOf(prevHash: string, payload: string): string {
  return createHash("sha256").update(`${prevHash}\n${payload}`, "utf8").digest("hex");
}

export interface AuditInput {
  sessionId: string;
  actor: string;
  userText: string;
  tool: string;
  params: Record<string, unknown>;
  decision: string;
  policyLevel: RiskLevel | "unknown";
  policyRules: string[];
  tokenDigest?: string;
  intentSource?: "rule" | "model" | "none";
  model?: { name: string; tokens: number; latencyMs: number };
  result: string;
}

export interface ChainVerifyResult {
  ok: boolean;
  total: number;
  brokenAt: number | null;
  reason: string;
}

/** 审计链：只追加的 JSONL 文件，每条记录携带前序哈希。 */
export class AuditChain {
  readonly file: string;
  private lastSeq = 0;
  private lastHash = "GENESIS";

  constructor(storeDir: string) {
    const dir = path.join(storeDir, "bank");
    mkdirSync(dir, { recursive: true });
    this.file = path.join(dir, "audit.jsonl");
    this.rehydrate();
  }

  /** 启动时定位链尾，避免重启后序号与哈希断裂。 */
  private rehydrate(): void {
    if (!existsSync(this.file)) return;
    const lines = readFileSync(this.file, "utf8").split("\n").filter((line) => line.trim() !== "");
    const last = lines.at(-1);
    if (last === undefined) return;
    const record = JSON.parse(last) as AuditRecord;
    this.lastSeq = record.seq;
    this.lastHash = record.hash;
  }

  append(input: AuditInput): AuditRecord {
    const seq = this.lastSeq + 1;
    const params = sanitizeParams(input.params);
    const payload = JSON.stringify({
      seq,
      sessionId: input.sessionId,
      actor: input.actor,
      userText: input.userText,
      tool: input.tool,
      params,
      decision: input.decision,
      policyLevel: input.policyLevel,
      policyRules: input.policyRules,
      tokenDigest: input.tokenDigest ?? "",
      intentSource: input.intentSource ?? "none",
      model: input.model ?? null,
      result: input.result,
    });
    const record: AuditRecord = {
      seq,
      ts: new Date().toISOString(),
      sessionId: input.sessionId,
      actor: input.actor,
      userText: input.userText,
      tool: input.tool,
      params,
      decision: input.decision,
      policyLevel: input.policyLevel,
      policyRules: input.policyRules,
      ...(input.tokenDigest === undefined ? {} : { tokenDigest: input.tokenDigest }),
      intentSource: input.intentSource ?? "none",
      ...(input.model === undefined ? {} : { model: input.model }),
      result: input.result,
      prevHash: this.lastHash,
      hash: hashOf(this.lastHash, payload),
    };
    appendFileSync(this.file, `${JSON.stringify(record)}\n`, "utf8");
    this.lastSeq = seq;
    this.lastHash = record.hash;
    return record;
  }

  read(limit = 200): AuditRecord[] {
    if (!existsSync(this.file)) return [];
    const lines = readFileSync(this.file, "utf8").split("\n").filter((line) => line.trim() !== "");
    return lines.slice(-limit).map((line) => JSON.parse(line) as AuditRecord);
  }

  verify(): ChainVerifyResult {
    if (!existsSync(this.file)) return { ok: true, total: 0, brokenAt: null, reason: "空链" };
    const lines = readFileSync(this.file, "utf8").split("\n").filter((line) => line.trim() !== "");
    let prevHash = "GENESIS";
    let expectedSeq = 1;
    for (const line of lines) {
      const record = JSON.parse(line) as AuditRecord;
      if (record.seq !== expectedSeq) {
        return { ok: false, total: lines.length, brokenAt: record.seq, reason: "序号不连续" };
      }
      if (record.prevHash !== prevHash) {
        return { ok: false, total: lines.length, brokenAt: record.seq, reason: "前序哈希不匹配" };
      }
      const payload = JSON.stringify({
        seq: record.seq,
        sessionId: record.sessionId,
        actor: record.actor,
        userText: record.userText,
        tool: record.tool,
        params: record.params,
        decision: record.decision,
        policyLevel: record.policyLevel,
        policyRules: record.policyRules,
        tokenDigest: record.tokenDigest ?? "",
        intentSource: record.intentSource ?? "none",
        model: record.model ?? null,
        result: record.result,
      });
      const recomputed = hashOf(record.prevHash, payload);
      if (recomputed !== record.hash) {
        return { ok: false, total: lines.length, brokenAt: record.seq, reason: "记录哈希不匹配" };
      }
      prevHash = record.hash;
      expectedSeq += 1;
    }
    return { ok: true, total: lines.length, brokenAt: null, reason: "链完整" };
  }
}
