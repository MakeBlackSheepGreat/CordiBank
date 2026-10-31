import type { StreamDelta } from "../llm/types.ts";

/**
 * 关键词防控。
 *
 * 模型输出（正文与推理）在推给用户前按关键词表扫描，命中即截断：
 * 流式路径只放行安全前缀，整段路径截断后追加危险提醒。
 * 关键词表由配置注入，缺省表覆盖内部指令泄露与凭据泄露两类。
 */

/** 缺省关键词：内部指令泄露与凭据泄露，匹配不区分大小写。 */
export const DEFAULT_GUARD_KEYWORDS: string[] = [
  "系统提示词",
  "系统指令",
  "SYSTEM PROMPT",
  "system prompt",
  "ignore previous",
  "disregard previous",
  "忽略之前的指令",
  "忽略上述指令",
  "跳过安全检查",
  "BEGIN PRIVATE KEY",
  "AKIA",
  "sk-ant-",
];

/** 命中位置：关键词与它在原文中的下标。 */
export interface GuardHit {
  keyword: string;
  index: number;
}

/** 危险提醒：命中后替换或追加在截断点之后，向用户说明原因。 */
export function dangerNotice(hit: GuardHit): string {
  return `……\n\n[已截断] 输出命中安全关键词「${hit.keyword}」，为防止内部信息或指令泄露，后续内容不再展示。如有正常业务需求，请换个说法重试。`;
}

/** 等长变体归一化：全角 ASCII 与全角空格折算为半角，长度不变，命中下标仍对准原文。 */
function normalizeVariants(text: string): string {
  let out = "";
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    if (code === 0x3000) out += " ";
    else if (code >= 0xff01 && code <= 0xff5e) out += String.fromCharCode(code - 0xfee0);
    else out += ch;
  }
  return out;
}

/** 扫描整段文本：返回首个命中，无命中返回 undefined。 */
export function scanOutput(text: string, keywords: string[]): GuardHit | undefined {
  const folded = normalizeVariants(text).toLowerCase();
  for (const keyword of keywords) {
    const needle = keyword.toLowerCase();
    if (needle === "") continue;
    const index = folded.indexOf(needle);
    if (index >= 0) return { keyword, index };
  }
  return undefined;
}

/** 整段守护：命中即截断并追加危险提醒。 */
export function guardFinal(text: string, keywords: string[]): { text: string; hit?: GuardHit } {
  const hit = scanOutput(text, keywords);
  if (hit === undefined) return { text };
  const kept = text.slice(0, hit.index).trimEnd();
  return { text: kept === "" ? dangerNotice(hit) : `${kept}\n\n${dangerNotice(hit)}`, hit };
}

/** 安全前缀长度：留出关键词最大长度，避免关键词跨增量被漏放行。 */
function safeLength(buffered: string, keywords: string[]): number {
  const holdback = Math.max(...keywords.map((keyword) => keyword.length), 1) - 1;
  return Math.max(buffered.length - holdback, 0);
}

/**
 * 流式守护：正文与推理两路独立缓冲，各自只放行安全前缀。
 * 一旦命中，该路后续增量全部丢弃；返回的 finished 由调用方判断终文是否需要整段替换。
 */
export function createGuardedSink(
  sink: (delta: StreamDelta) => void,
  keywords: string[],
): { push: (delta: StreamDelta) => void; hit?: GuardHit } {
  const state = {
    content: "",
    reasoning: "",
    blocked: false,
    hit: undefined as GuardHit | undefined,
  };
  return {
    get hit(): GuardHit | undefined {
      return state.hit;
    },
    push(delta: StreamDelta): void {
      if (state.blocked) return;
      if (delta.reasoning !== "") {
        state.reasoning += delta.reasoning;
        const hit = scanOutput(state.reasoning, keywords);
        if (hit !== undefined) {
          state.blocked = true;
          state.hit = hit;
          return;
        }
        const safe = state.reasoning.slice(0, safeLength(state.reasoning, keywords));
        if (safe !== "") sink({ content: "", reasoning: safe });
        state.reasoning = state.reasoning.slice(safe.length);
      }
      if (delta.content !== "") {
        state.content += delta.content;
        const hit = scanOutput(state.content, keywords);
        if (hit !== undefined) {
          state.blocked = true;
          state.hit = hit;
          return;
        }
        const safe = state.content.slice(0, safeLength(state.content, keywords));
        if (safe !== "") sink({ content: safe, reasoning: "" });
        state.content = state.content.slice(safe.length);
      }
    },
  };
}
