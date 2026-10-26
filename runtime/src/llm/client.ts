import { redactText } from "../core/redact.ts";
import type { ChatMessage, LlmFailure, LlmSettings, ModelReply, ToolCall, ToolSchema, Usage } from "./types.ts";

/** 模型调用错误：kind 供上层决定降级策略。 */
export class LlmError extends Error {
  readonly kind: LlmFailure;

  constructor(kind: LlmFailure, message: string) {
    super(message);
    this.name = "LlmError";
    this.kind = kind;
  }
}

interface RawToolCall {
  id?: unknown;
  function?: { name?: unknown; arguments?: unknown };
}

interface RawUsage {
  prompt_tokens?: unknown;
  completion_tokens?: unknown;
  prompt_cache_hit_tokens?: unknown;
  prompt_cache_miss_tokens?: unknown;
  prompt_tokens_details?: { cached_tokens?: unknown };
  completion_tokens_details?: { reasoning_tokens?: unknown };
}

interface RawResponse {
  model?: unknown;
  choices?: Array<{ message?: { content?: unknown; tool_calls?: unknown } }>;
  usage?: RawUsage;
}

/** 读取工具调用：字段缺失或类型不符一律跳过，不猜测。 */
function readToolCalls(raw: unknown): ToolCall[] {
  if (!Array.isArray(raw)) return [];
  const calls: ToolCall[] = [];
  for (const item of raw as RawToolCall[]) {
    const id = typeof item.id === "string" ? item.id : "";
    const name = typeof item.function?.name === "string" ? item.function.name : "";
    const args = typeof item.function?.arguments === "string" ? item.function.arguments : "{}";
    if (id === "" || name === "") continue;
    calls.push({ id, name, arguments: args });
  }
  return calls;
}

function asNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/** 读取用量：缓存命中兼容两种字段写法，取先出现的那个。 */
function readUsage(raw: RawUsage | undefined): Usage {
  const hit = asNumber(raw?.prompt_cache_hit_tokens ?? raw?.prompt_tokens_details?.cached_tokens);
  const prompt = asNumber(raw?.prompt_tokens);
  const miss = asNumber(raw?.prompt_cache_miss_tokens);
  return {
    promptTokens: prompt,
    completionTokens: asNumber(raw?.completion_tokens),
    cacheHitTokens: hit,
    cacheMissTokens: miss > 0 ? miss : Math.max(0, prompt - hit),
    reasoningTokens: asNumber(raw?.completion_tokens_details?.reasoning_tokens),
  };
}

/** OpenAI 兼容客户端：只依赖 fetch，不引入 SDK。 */
export class LlmClient {
  private readonly settings: LlmSettings;

  constructor(settings: LlmSettings) {
    this.settings = settings;
  }

  get configured(): boolean {
    return this.settings.baseUrl !== "" && this.settings.apiKey !== "" && this.settings.model !== "";
  }

  get model(): string {
    return this.settings.model;
  }

  get endpoint(): string {
    return this.settings.baseUrl;
  }

  get effort(): string {
    return this.settings.effort;
  }

  /** 一次对话请求；超时、HTTP 错误与协议异常都转成带分类的错误。 */
  async chat(
    messages: ChatMessage[],
    tools: ToolSchema[] = [],
    overrides: { maxTokens?: number; effort?: LlmSettings["effort"]; toolChoice?: "auto" | "required"; thinking?: boolean } = {},
  ): Promise<ModelReply> {
    if (!this.configured) {
      throw new LlmError("unconfigured", "模型未配置：缺少 baseUrl、apiKey 或 model");
    }
    const started = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.settings.timeoutMs);
    try {
      const body: Record<string, unknown> = {
        model: this.settings.model,
        messages,
        temperature: this.settings.temperature,
        max_tokens: overrides.maxTokens ?? this.settings.maxTokens,
        stream: false,
        effort: overrides.effort ?? this.settings.effort,
      };
      // 关闭思考模式：结构化抽槽不需要推理，可省去全部 reasoning token。
      if (!(overrides.thinking ?? this.settings.thinking)) {
        body.thinking = { type: "disabled" };
      }
      if (tools.length > 0) {
        body.tools = tools;
        body.tool_choice = overrides.toolChoice ?? "auto";
      }
      const response = await fetch(`${this.settings.baseUrl.replace(/\/+$/, "")}/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${this.settings.apiKey}`,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (!response.ok) {
        const detail = redactText((await response.text()).slice(0, 300));
        throw new LlmError("http", `模型服务返回 ${response.status}：${detail}`);
      }
      const payload = (await response.json()) as RawResponse;
      const choice = payload.choices?.[0];
      if (choice === undefined) {
        throw new LlmError("protocol", "模型响应缺少 choices");
      }
      const content = typeof choice.message?.content === "string" ? choice.message.content : "";
      return {
        content,
        toolCalls: readToolCalls(choice.message?.tool_calls),
        usage: readUsage(payload.usage),
        latencyMs: Date.now() - started,
        model: typeof payload.model === "string" ? payload.model : this.settings.model,
      };
    } catch (error) {
      if (error instanceof LlmError) throw error;
      if (controller.signal.aborted) {
        throw new LlmError("timeout", `模型请求超时（${this.settings.timeoutMs}ms）`);
      }
      throw new LlmError("http", redactText(error instanceof Error ? error.message : String(error)));
    } finally {
      clearTimeout(timer);
    }
  }
}
