import { RuntimeError } from "../core/errors.ts";
import { specOf } from "./policy.ts";
import { TOOL_CONTRACTS } from "./tool-schema.ts";
import type { Intent, IntentSlots } from "./types.ts";

/** 模型输出不合约时抛出，调用方据此降级到规则解析。 */
export class ModelIntentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ModelIntentError";
  }
}

/** 从模型回复中提取 JSON 对象：允许代码块包裹与前后缀文字。 */
export function extractJson(raw: string): Record<string, unknown> {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = fenced === null ? raw : fenced[1];
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start < 0 || end <= start) {
    throw new ModelIntentError("模型输出不含 JSON 对象");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.slice(start, end + 1));
  } catch (error) {
    throw new ModelIntentError(`模型输出 JSON 无法解析：${error instanceof Error ? error.message : String(error)}`);
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new ModelIntentError("模型输出不是对象");
  }
  return parsed as Record<string, unknown>;
}

interface ValidatedSlot {
  value: unknown;
  dropped: boolean;
}

/** 单个槽位校验：类型、枚举、范围、长度逐项检查，不合格即丢弃。 */
export function validateSlotValue(
  spec: { kind: string; values?: readonly string[]; min?: number; max?: number; maxLength?: number },
  raw: unknown,
): ValidatedSlot {
  if (spec.kind === "integer") {
    if (typeof raw !== "number" || !Number.isInteger(raw)) return { value: undefined, dropped: true };
    if (spec.min !== undefined && raw < spec.min) return { value: undefined, dropped: true };
    if (spec.max !== undefined && raw > spec.max) return { value: undefined, dropped: true };
    return { value: raw, dropped: false };
  }
  if (spec.kind === "enum") {
    if (typeof raw !== "string") return { value: undefined, dropped: true };
    if (spec.values !== undefined && !spec.values.includes(raw)) return { value: undefined, dropped: true };
    return { value: raw, dropped: false };
  }
  if (typeof raw !== "string") return { value: undefined, dropped: true };
  const limit = spec.maxLength ?? 64;
  const text = raw.trim().slice(0, limit);
  if (text === "") return { value: undefined, dropped: true };
  return { value: text, dropped: false };
}

export interface ParseOptions {
  /** 低于该置信度视为无效，交回规则或追问。 */
  minConfidence?: number;
}

export interface ParsedModelIntent {
  intent: Intent;
  droppedSlots: string[];
}

/**
 * 把模型输出转成受约束的 Intent。
 * 工具必须在白名单内，槽位必须符合契约，任何越界字段直接丢弃并记录。
 */
export function toIntent(raw: string, options: ParseOptions = {}): ParsedModelIntent {
  const obj = extractJson(raw);
  const toolRaw = typeof obj.tool === "string" ? obj.tool.trim() : "";
  const confidenceRaw = typeof obj.confidence === "number" ? obj.confidence : 0;
  const confidence = Math.max(0, Math.min(1, confidenceRaw));
  const reason = typeof obj.reason === "string" ? obj.reason.trim().slice(0, 80) : "";

  if (toolRaw === "" || toolRaw === "unknown") {
    return {
      intent: { scene: "unknown", tool: "unknown", slots: {}, missing: [], confidence, reason: reason === "" ? "模型未能识别" : reason },
      droppedSlots: [],
    };
  }

  const contract = TOOL_CONTRACTS[toolRaw];
  if (contract === undefined) {
    throw new ModelIntentError(`模型给出未登记的工具：${toolRaw}`);
  }
  const spec = specOf(toolRaw);
  if (spec === undefined) {
    throw new ModelIntentError(`工具缺少策略定义：${toolRaw}`);
  }

  const rawSlots = obj.slots;
  const slotsInput = rawSlots !== null && typeof rawSlots === "object" && !Array.isArray(rawSlots)
    ? (rawSlots as Record<string, unknown>)
    : {};
  const slots: IntentSlots = {};
  const droppedSlots: string[] = [];
  const missing: string[] = [];

  for (const [name, value] of Object.entries(slotsInput)) {
    const slotSpec = contract.slots[name as keyof IntentSlots];
    if (slotSpec === undefined) {
      droppedSlots.push(name);
      continue;
    }
    const checked = validateSlotValue(slotSpec, value);
    if (checked.dropped) {
      droppedSlots.push(name);
      continue;
    }
    slots[name as keyof IntentSlots] = checked.value as never;
  }

  for (const [name, slotSpec] of Object.entries(contract.slots)) {
    if (slotSpec.required && slots[name as keyof IntentSlots] === undefined) missing.push(name);
  }

  const minConfidence = options.minConfidence ?? 0.6;
  if (confidence < minConfidence && missing.length === 0) {
    return {
      intent: { scene: "unknown", tool: "unknown", slots: {}, missing: [], confidence, reason: `置信度不足（${confidence.toFixed(2)}）` },
      droppedSlots,
    };
  }

  return {
    intent: {
      scene: spec.scene,
      tool: toolRaw,
      slots,
      missing,
      confidence,
      reason: reason === "" ? "模型解析" : reason,
    },
    droppedSlots,
  };
}

/** 数值型槽位的严格读取，供上层复用。 */
export function requireInteger(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new RuntimeError("INVALID_INPUT", `${name} 必须是整数`);
  }
  return value;
}

/**
 * 从原生工具调用构造意图。
 * 参数按契约逐项校验，多余字段丢弃，缺必填项记为待追问。
 */
export function toIntentFromCall(name: string, argsJson: string): ParsedModelIntent {
  if (name === "unknown") {
    return {
      intent: { scene: "unknown", tool: "unknown", slots: {}, missing: [], confidence: 0.2, reason: "模型判定无法识别" },
      droppedSlots: [],
    };
  }
  const contract = TOOL_CONTRACTS[name];
  if (contract === undefined) {
    throw new ModelIntentError(`模型调用了未登记的工具：${name}`);
  }
  const spec = specOf(name);
  if (spec === undefined) {
    throw new ModelIntentError(`工具缺少策略定义：${name}`);
  }
  let raw: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(argsJson === "" ? "{}" : argsJson) as unknown;
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
      raw = parsed as Record<string, unknown>;
    }
  } catch {
    throw new ModelIntentError("工具参数不是合法 JSON");
  }

  const slots: IntentSlots = {};
  const droppedSlots: string[] = [];
  const missing: string[] = [];
  for (const [slotName, value] of Object.entries(raw)) {
    const slotSpec = contract.slots[slotName as keyof IntentSlots];
    if (slotSpec === undefined) {
      droppedSlots.push(slotName);
      continue;
    }
    const checked = validateSlotValue(slotSpec, value);
    if (checked.dropped) {
      droppedSlots.push(slotName);
      continue;
    }
    slots[slotName as keyof IntentSlots] = checked.value as never;
  }
  for (const [slotName, slotSpec] of Object.entries(contract.slots)) {
    if (slotSpec.required && slots[slotName as keyof IntentSlots] === undefined) missing.push(slotName);
  }

  return {
    intent: {
      scene: spec.scene,
      tool: name,
      slots,
      missing,
      confidence: 0.9,
      reason: "模型原生工具调用",
    },
    droppedSlots,
  };
}
