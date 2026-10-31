/** 模型层类型：描述与 OpenAI 兼容及 Anthropic Messages 接口交互所需的最小结构。 */
import type { LlmApi } from "./providers.ts";

export type Role = "system" | "user" | "assistant" | "tool";

export interface ChatMessage {
  role: Role;
  content: string;
  tool_call_id?: string;
  tool_calls?: Array<{ id: string; type: "function"; function: { name: string; arguments: string } }>;
}

export interface ToolSchema {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export interface ToolCall {
  id: string;
  name: string;
  arguments: string;
}

/** 单次调用的用量：缓存字段来自服务端，缺失时按 0 计。 */
export interface Usage {
  promptTokens: number;
  completionTokens: number;
  /** 命中前缀缓存的 token 数，价格约为未命中的十分之一。 */
  cacheHitTokens: number;
  cacheMissTokens: number;
  reasoningTokens: number;
}

export interface ModelReply {
  content: string;
  toolCalls: ToolCall[];
  usage: Usage;
  /** 端到端耗时，毫秒。 */
  latencyMs: number;
  model: string;
  /** 推理过程全文，未开启思考时为空串。仅流式调用会填。 */
  reasoning?: string;
}

/**
 * 思考强度。
 *
 * off 关闭推理，用于结构化抽槽这类确定性任务，reasoning token 归零。
 * low 常规推理，用于日常问答。
 * high 深度推理，用于多步分析。
 */
export type Effort = "off" | "low" | "high";

/** 流式增量：正文与推理两路分开，界面可分别渲染。 */
export interface StreamDelta {
  /** 正文增量，可能为空串。 */
  content: string;
  /** 推理过程增量，模型未开启思考时恒为空串。 */
  reasoning: string;
}

export interface LlmSettings {
  baseUrl: string;
  apiKey: string;
  model: string;
  /** 单次请求超时，毫秒。 */
  timeoutMs: number;
  /** 温度：结构化输出场景取低值。 */
  temperature: number;
  /** 单次回复的最大 token。 */
  maxTokens: number;
  /** 思考强度，映射为服务端的 reasoning_effort 或 thinking 开关。 */
  effort: Effort;
  /** 请求协议；缺省 openai-completions。 */
  api?: LlmApi;
}


/** 模型调用失败分类：供上层决定降级还是报错。 */
export type LlmFailure = "unconfigured" | "timeout" | "http" | "protocol" | "budget";
