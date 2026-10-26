import { LlmError } from "./client.ts";
import type { LlmClient } from "./client.ts";
import type { ChatMessage, Effort, ToolSchema } from "./types.ts";

/** 循环里可见的工具：write 为真表示资金或规则变更操作，循环内不执行。 */
export interface LoopToolSpec {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  write: boolean;
}

export type LoopExecutor = (name: string, args: Record<string, unknown>) => Promise<{ ok: boolean; summary: string }>;

export interface LoopStep {
  step: number;
  calls: Array<{ name: string; ok: boolean; summary: string; latencyMs: number }>;
}

export interface LoopUsage {
  promptTokens: number;
  completionTokens: number;
  cacheHitTokens: number;
  cacheMissTokens: number;
  reasoningTokens: number;
  calls: number;
}

export type StopReason = "final" | "steps" | "budget" | "write-intent" | "error";

export interface LoopOutcome {
  text: string;
  steps: LoopStep[];
  usage: LoopUsage;
  stopReason: StopReason;
  proposedWrite?: { name: string; args: Record<string, unknown> };
  error?: string;
}

export interface LoopOptions {
  client: LlmClient;
  messages: ChatMessage[];
  tools: LoopToolSpec[];
  execute: LoopExecutor;
  maxSteps?: number;
  /** 累计 prompt 与 completion 的 token 上限。 */
  tokenBudget?: number;
  /** 单条工具结果回填的字符上限，超出截断。 */
  maxResultChars?: number;
  effort?: Effort;
  maxTokens?: number;
  /** 是否开启思考模式；只读查询类对话可以关掉以省 token。 */
  thinking?: boolean;
}

const DEFAULT_MAX_STEPS = 4;
const DEFAULT_TOKEN_BUDGET = 6000;
const DEFAULT_RESULT_CHARS = 600;

/** 结果截断：只保留前若干字符，明确告知已截断，避免模型误以为数据完整。 */
function compress(text: string, limit: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat.length <= limit) return flat;
  return `${flat.slice(0, limit)}……（已截断，原文 ${flat.length} 字符）`;
}

/** 工具声明：由契约转换为 OpenAI tools 格式，描述保持一句话。 */
function toSchemas(tools: LoopToolSpec[]): ToolSchema[] {
  return tools.map((tool) => ({
    type: "function" as const,
    function: { name: tool.name, description: tool.description, parameters: tool.parameters },
  }));
}

/**
 * Agent 循环：多轮工具调用直到模型给出最终答复。
 * 写操作不执行，直接中断循环并把意图交回编排层，由策略引擎与确认令牌处理。
 */
export async function runAgentLoop(options: LoopOptions): Promise<LoopOutcome> {
  const { client, messages, tools, execute } = options;
  const maxSteps = options.maxSteps ?? DEFAULT_MAX_STEPS;
  const budget = options.tokenBudget ?? DEFAULT_TOKEN_BUDGET;
  const resultLimit = options.maxResultChars ?? DEFAULT_RESULT_CHARS;
  const toolNames = new Map(tools.map((tool) => [tool.name, tool]));
  const schemas = toSchemas(tools);
  const steps: LoopStep[] = [];
  const usage: LoopUsage = {
    promptTokens: 0,
    completionTokens: 0,
    cacheHitTokens: 0,
    cacheMissTokens: 0,
    reasoningTokens: 0,
    calls: 0,
  };

  for (let step = 1; step <= maxSteps; step += 1) {
    if (usage.promptTokens + usage.completionTokens >= budget) {
      return { text: "", steps, usage, stopReason: "budget" };
    }

    let reply;
    try {
      reply = await client.chat(messages, schemas, {
        ...(options.maxTokens === undefined ? {} : { maxTokens: options.maxTokens }),
        ...(options.effort === undefined ? {} : { effort: options.effort }),
        ...(options.thinking === undefined ? {} : { thinking: options.thinking }),
      });
    } catch (error) {
      if (error instanceof LlmError) {
        return { text: "", steps, usage, stopReason: "error", error: error.message };
      }
      throw error;
    }

    usage.calls += 1;
    usage.promptTokens += reply.usage.promptTokens;
    usage.completionTokens += reply.usage.completionTokens;
    usage.cacheHitTokens += reply.usage.cacheHitTokens;
    usage.cacheMissTokens += reply.usage.cacheMissTokens;
    usage.reasoningTokens += reply.usage.reasoningTokens;

    if (reply.toolCalls.length === 0) {
      return { text: reply.content, steps, usage, stopReason: "final" };
    }

    messages.push({
      role: "assistant",
      content: reply.content,
      tool_calls: reply.toolCalls.map((call) => ({
        id: call.id,
        type: "function" as const,
        function: { name: call.name, arguments: call.arguments },
      })),
    });

    const calls: LoopStep["calls"] = [];
    for (const call of reply.toolCalls) {
      const started = Date.now();
      let args: Record<string, unknown> = {};
      try {
        const parsed = JSON.parse(call.arguments) as unknown;
        if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
          args = parsed as Record<string, unknown>;
        }
      } catch {
        messages.push({ role: "tool", tool_call_id: call.id, content: "参数不是合法 JSON，本次调用作废。" });
        calls.push({ name: call.name, ok: false, summary: "参数非法", latencyMs: Date.now() - started });
        continue;
      }

      const spec = toolNames.get(call.name);
      if (spec === undefined) {
        messages.push({ role: "tool", tool_call_id: call.id, content: "未注册的工具，调用被拒绝。" });
        calls.push({ name: call.name, ok: false, summary: "未注册工具", latencyMs: Date.now() - started });
        continue;
      }

      if (spec.write) {
        return { text: reply.content, steps, usage, stopReason: "write-intent", proposedWrite: { name: call.name, args } };
      }

      const result = await execute(call.name, args);
      const summary = compress(result.summary, resultLimit);
      messages.push({ role: "tool", tool_call_id: call.id, content: summary });
      calls.push({ name: call.name, ok: result.ok, summary, latencyMs: Date.now() - started });
    }

    steps.push({ step, calls });
  }

  return { text: "", steps, usage, stopReason: "steps" };
}
