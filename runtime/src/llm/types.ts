/** 模型层类型：只描述与 OpenAI 兼容接口交互所需的最小结构。 */

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
}

/** 推理强度：low 用于结构化抽槽，high 用于多步推理。 */
export type Effort = "low" | "high" | "max";

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
  /** 推理强度，透传给服务端的 effort 字段。 */
  effort: Effort;
  /** 是否开启思考模式。关闭后 reasoning token 归零，适合结构化抽槽。 */
  thinking: boolean;
}

/** 模型调用失败分类：供上层决定降级还是报错。 */
export type LlmFailure = "unconfigured" | "timeout" | "http" | "protocol" | "budget";
