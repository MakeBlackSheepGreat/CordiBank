/** 模型层类型：只描述与 OpenAI 兼容接口交互所需的最小结构。 */

export type Role = "system" | "user" | "assistant" | "tool";

export interface ChatMessage {
  role: Role;
  content: string;
  tool_call_id?: string;
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

export interface ModelReply {
  content: string;
  toolCalls: ToolCall[];
  /** 消耗的 token 总数；服务端未返回时为 0。 */
  tokens: number;
  /** 端到端耗时，毫秒。 */
  latencyMs: number;
  model: string;
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
}

/** 模型调用失败分类：供上层决定降级还是报错。 */
export type LlmFailure = "unconfigured" | "timeout" | "http" | "protocol" | "budget";
