/**
 * 前置路由层。
 *
 * 作用是在意图解析之前先判一件事：这句话该走哪条链路。
 * 三条链路的能力面完全不同，混在一起就会出现「问他你是谁，只回一句没听懂」。
 *
 * - business：六个业务场景的只读请求，装配该场景真正需要的只读工具与技能，交给模型问答。
 * - write：资金或账户状态变更，交给编排层的策略判定与确认令牌，模型只做意图解析。
 * - social：身份询问、能力介绍、寒暄、闲聊与常识，只给人格提示词，不挂业务工具。
 *
 * 路由本身不回答用户，只输出一个 JSON 分派结果；名字一律按候选清单校验，
 * 模型臆造的工具名与技能名直接丢弃，不进入装配。
 */

import type { LlmClient } from "../llm/client.ts";
import { ROUTER_SYSTEM_PROMPT, renderRouteOptions } from "../llm/prompts.ts";
import type { ChatMessage } from "../llm/types.ts";
import { parseIntent } from "./intent.ts";
import type { BankState } from "./types.ts";

/** 三条链路：业务只读、写操作、社交闲聊。 */
export type RouteKind = "business" | "write" | "social";

/** 路由结果：kind 决定链路，tools 与 skills 决定这条链路装哪些能力。 */
export interface RouteDecision {
  kind: RouteKind;
  scene: string;
  tools: string[];
  skills: string[];
  reason: string;
  source: "rule" | "model";
}

/** 路由候选：只列这次真正可以被选中的名字。 */
export interface RouteCandidates {
  scenes: string[];
  tools: string[];
  skills: string[];
}

/** 社交话术：身份询问、寒暄、致谢与告别。命中即走 social，不进意图解析。 */
const SOCIAL_PATTERNS: ReadonlyArray<RegExp> = [
  /^(你好|您好|hi|hello|嗨|哈喽|在吗|在不在)[\s!！。,.，~]*$/i,
  /(你是谁|你叫什么|你是什么|介绍.{0,4}你自己|你能做什么|你会做什么|你会什么|你有什么功能|你有哪些能力|你是什么模型|你是机器人吗|你是ai吗)/i,
  /^(谢谢|多谢|感谢|辛苦了|再见|拜拜|晚安|早上好|晚上好)/,
  /^(嗯+|哦+|好的?|ok|收到)$/i,
];

const KIND_OF_ROUTE: Record<string, RouteKind> = {
  business: "business",
  write: "write",
  social: "social",
};

/** 规则快速判定：命中则不必调用模型，省一次往返。判不了返回 null 交给模型。 */
export function routeByRule(text: string, state: BankState, writeTools: ReadonlySet<string>): RouteDecision | null {
  const trimmed = text.trim();
  if (trimmed === "") return null;
  const intent = parseIntent(trimmed, state);
  if (intent.scene !== "unknown") {
    const kind: RouteKind = writeTools.has(intent.tool) ? "write" : "business";
    return {
      kind,
      scene: intent.scene,
      tools: [],
      skills: [],
      reason: `规则命中场景 ${intent.scene}，工具 ${intent.tool}`,
      source: "rule",
    };
  }
  if (SOCIAL_PATTERNS.some((pattern) => pattern.test(trimmed))) {
    return { kind: "social", scene: "unknown", tools: [], skills: [], reason: "命中社交话术", source: "rule" };
  }
  return null;
}

/** 从回包里取 JSON 对象：模型可能带围栏或前后缀，取最外层花括号区间。 */
function readJsonObject(raw: string): Record<string, unknown> | null {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    const parsed = JSON.parse(raw.slice(start, end + 1)) as unknown;
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** 取字符串数组，并按候选清单过滤：模型臆造的名字一律丢弃。 */
function readNames(value: unknown, allowed: string[]): string[] {
  if (!Array.isArray(value)) return [];
  const set = new Set(allowed);
  const picked: string[] = [];
  for (const item of value) {
    if (typeof item === "string" && set.has(item) && !picked.includes(item)) picked.push(item);
  }
  return picked;
}

/** 模型路由器：一次不思考的 JSON 调用，失败按 social 兜底。 */
export class Router {
  private readonly client: LlmClient;

  constructor(client: LlmClient) {
    this.client = client;
  }

  /** 判定链路；任何异常都退回 social，保证对话不至于变成「没听懂」。 */
  async decide(text: string, candidates: RouteCandidates): Promise<RouteDecision> {
    const messages: ChatMessage[] = [
      { role: "system", content: ROUTER_SYSTEM_PROMPT },
      {
        role: "user",
        content: [renderRouteOptions(candidates), "", "【用户原话】", text].join("\n"),
      },
    ];
    try {
      const reply = await this.client.chat(messages, [], { effort: "off", maxTokens: 300 });
      const parsed = readJsonObject(reply.content);
      if (parsed === null) {
        return { kind: "social", scene: "unknown", tools: [], skills: [], reason: "路由回包非 JSON，按社交兜底", source: "model" };
      }
      const rawKind = typeof parsed.route === "string" ? parsed.route.trim().toLowerCase() : "";
      const kind = KIND_OF_ROUTE[rawKind] ?? "social";
      const scene = typeof parsed.scene === "string" && candidates.scenes.includes(parsed.scene) ? parsed.scene : "unknown";
      return {
        kind,
        scene,
        tools: readNames(parsed.tools, candidates.tools),
        skills: readNames(parsed.skills, candidates.skills),
        reason: typeof parsed.reason === "string" ? parsed.reason.slice(0, 120) : "",
        source: "model",
      };
    } catch (error) {
      return {
        kind: "social",
        scene: "unknown",
        tools: [],
        skills: [],
        reason: `路由调用失败，按社交兜底：${error instanceof Error ? error.message : String(error)}`,
        source: "model",
      };
    }
  }
}
