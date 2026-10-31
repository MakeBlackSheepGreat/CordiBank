import { redactText } from "../core/redact.ts";
import type { ChatMessage, Effort, LlmFailure, LlmSettings, ModelReply, StreamDelta, ToolCall, ToolSchema, Usage } from "./types.ts";

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

interface RawDelta {
  content?: unknown;
  reasoning_content?: unknown;
  tool_calls?: unknown;
}

interface RawChunk {
  model?: unknown;
  choices?: Array<{ delta?: RawDelta }>;
  usage?: RawUsage;
}

interface RawDeltaToolCall {
  index?: unknown;
  id?: unknown;
  function?: { name?: unknown; arguments?: unknown };
}

/** 单次请求的覆盖项：不改动客户端持有的默认配置。 */
export interface ChatOverrides {
  maxTokens?: number;
  effort?: Effort;
  toolChoice?: "auto" | "required" | "none";
}

/** 流式工具调用的累积位：id 与函数名只在首片出现，参数逐片拼接。 */
interface ToolCallSlot {
  id: string;
  name: string;
  arguments: string;
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

/**
 * 思考强度映射到服务端参数。
 *
 * off 发 thinking 关闭开关；low 与 high 发 reasoning_effort。
 * 只发 effort 字段服务端不认，实测 reasoning token 恒为 0。
 */
function applyEffort(body: Record<string, unknown>, effort: Effort): void {
  if (effort === "off") {
    body.thinking = { type: "disabled" };
    return;
  }
  body.reasoning_effort = effort;
}

/** 组装请求体：流式与非流式共用，避免两处字段漂移。 */
function buildBody(
  settings: LlmSettings,
  messages: ChatMessage[],
  tools: ToolSchema[],
  overrides: ChatOverrides,
  stream: boolean,
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: settings.model,
    messages,
    temperature: settings.temperature,
    max_tokens: overrides.maxTokens ?? settings.maxTokens,
    stream,
  };
  // 流式下用量只在末尾分片出现，需要显式索取，否则审计里的 token 统计全是 0。
  if (stream) body.stream_options = { include_usage: true };
  applyEffort(body, overrides.effort ?? settings.effort);
  if (tools.length > 0) {
    body.tools = tools;
    body.tool_choice = overrides.toolChoice ?? "auto";
  }
  return body;
}

/** 从缓冲里切出完整 SSE 帧，返回帧列表与残余未闭合部分。 */
function takeFrames(buffer: string): { frames: string[]; rest: string } {
  const frames: string[] = [];
  let cursor = 0;
  for (;;) {
    const match = /\r?\n\r?\n/.exec(buffer.slice(cursor));
    if (match === null) break;
    frames.push(buffer.slice(cursor, cursor + match.index));
    cursor += match.index + match[0].length;
  }
  return { frames, rest: buffer.slice(cursor) };
}

/** 取帧内的 data 负载；多行 data 按 SSE 规范用换行拼接，注释行忽略。 */
function frameData(frame: string): string | null {
  const lines: string[] = [];
  for (const line of frame.split(/\r?\n/)) {
    if (!line.startsWith("data:")) continue;
    lines.push(line.slice(5).trimStart());
  }
  return lines.length === 0 ? null : lines.join("\n");
}

/** 累积工具调用分片：按 index 归并，参数逐片追加。 */
function accumulateToolCalls(slots: Map<number, ToolCallSlot>, raw: unknown): void {
  if (!Array.isArray(raw)) return;
  for (const item of raw as RawDeltaToolCall[]) {
    const index = typeof item.index === "number" ? item.index : 0;
    const slot = slots.get(index) ?? { id: "", name: "", arguments: "" };
    if (typeof item.id === "string" && item.id !== "") slot.id = item.id;
    if (typeof item.function?.name === "string" && item.function.name !== "") slot.name = item.function.name;
    if (typeof item.function?.arguments === "string") slot.arguments += item.function.arguments;
    slots.set(index, slot);
  }
}

/** 累积结果转成正式工具调用：缺 id 或函数名的条目丢弃。 */
function finalizeToolCalls(slots: Map<number, ToolCallSlot>): ToolCall[] {
  const ordered = [...slots.entries()].sort((left, right) => left[0] - right[0]);
  const calls: ToolCall[] = [];
  for (const [, slot] of ordered) {
    if (slot.id === "" || slot.name === "") continue;
    calls.push({ id: slot.id, name: slot.name, arguments: slot.arguments === "" ? "{}" : slot.arguments });
  }
  return calls;
}

// ---------- Anthropic Messages 协议：anthropic 与 minimax 系列提供商使用 ----------

interface AnthropicBlock {
  type?: string;
  text?: string;
  thinking?: string;
  id?: string;
  name?: string;
  input?: unknown;
  tool_use_id?: string;
}

interface AnthropicUsage {
  input_tokens?: unknown;
  output_tokens?: unknown;
  cache_read_input_tokens?: unknown;
  cache_creation_input_tokens?: unknown;
}

interface AnthropicResponse {
  model?: unknown;
  content?: AnthropicBlock[];
  usage?: AnthropicUsage;
}

interface AnthropicEvent {
  type?: string;
  index?: number;
  message?: { model?: unknown; usage?: AnthropicUsage };
  content_block?: AnthropicBlock;
  delta?: { type?: string; text?: string; thinking?: string; partial_json?: string };
  usage?: { output_tokens?: unknown };
}

/** 工具入参宽容解析：模型给出的 arguments 串不合法时按空对象处理。 */
function safeParseArguments(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** 组装 Anthropic Messages 请求体；system 提升为顶层字段，工具结果转为 tool_result 块。 */
function buildAnthropicBody(
  settings: LlmSettings,
  messages: ChatMessage[],
  tools: ToolSchema[],
  overrides: ChatOverrides,
  stream: boolean,
): Record<string, unknown> {
  const maxTokens = overrides.maxTokens ?? settings.maxTokens;
  const systemParts: string[] = [];
  const turns: Array<Record<string, unknown>> = [];
  for (const message of messages) {
    if (message.role === "system") {
      if (message.content !== "") systemParts.push(message.content);
      continue;
    }
    if (message.role === "tool") {
      turns.push({ role: "user", content: [{ type: "tool_result", tool_use_id: message.tool_call_id ?? "", content: message.content }] });
      continue;
    }
    if (message.role === "assistant" && message.tool_calls !== undefined && message.tool_calls.length > 0) {
      const blocks: Record<string, unknown>[] = [];
      if (message.content !== "") blocks.push({ type: "text", text: message.content });
      for (const call of message.tool_calls) {
        blocks.push({ type: "tool_use", id: call.id, name: call.function.name, input: safeParseArguments(call.function.arguments) });
      }
      turns.push({ role: "assistant", content: blocks });
      continue;
    }
    turns.push({ role: message.role, content: message.content });
  }

  const body: Record<string, unknown> = { model: settings.model, max_tokens: maxTokens, stream, messages: turns };
  if (systemParts.length > 0) body.system = systemParts.join("\n\n");

  const effort = overrides.effort ?? settings.effort;
  // thinking 开启要求 max_tokens 大于 budget；预算不足时直接关思考，保证请求合法。
  if (effort === "off" || maxTokens <= 2048) {
    body.thinking = { type: "disabled" };
    body.temperature = settings.temperature;
  } else {
    body.thinking = { type: "enabled", budget_tokens: effort === "high" ? 8192 : 2048 };
  }
  if (tools.length > 0) {
    body.tools = tools.map((tool) => ({
      name: tool.function.name,
      description: tool.function.description,
      input_schema: tool.function.parameters,
    }));
  }
  return body;
}

/** Anthropic 内容块转运行时结构：text 块拼接为正文，tool_use 块转为工具调用。 */
function readAnthropicBlocks(blocks: AnthropicBlock[]): { content: string; toolCalls: ToolCall[] } {
  const texts: string[] = [];
  const toolCalls: ToolCall[] = [];
  for (const block of blocks) {
    if (block.type === "text" && typeof block.text === "string") texts.push(block.text);
    if (block.type === "tool_use" && typeof block.id === "string" && typeof block.name === "string") {
      toolCalls.push({ id: block.id, name: block.name, arguments: JSON.stringify(block.input ?? {}) });
    }
  }
  return { content: texts.join(""), toolCalls };
}

function readAnthropicUsage(raw: AnthropicUsage | undefined): Usage {
  const hit = asNumber(raw?.cache_read_input_tokens);
  const prompt = asNumber(raw?.input_tokens);
  return {
    promptTokens: prompt,
    completionTokens: asNumber(raw?.output_tokens),
    cacheHitTokens: hit,
    cacheMissTokens: Math.max(0, prompt - hit),
    reasoningTokens: 0,
  };
}

/** 协议分流：anthropic-messages 与 openai-completions 共用一个入口。 */
function requestPayload(
  settings: LlmSettings,
  messages: ChatMessage[],
  tools: ToolSchema[],
  overrides: ChatOverrides,
  stream: boolean,
): Record<string, unknown> {
  return settings.api === "anthropic-messages"
    ? buildAnthropicBody(settings, messages, tools, overrides, stream)
    : buildBody(settings, messages, tools, overrides, stream);
}

/** OpenAI 兼容客户端：只依赖 fetch，不引入 SDK。 */
export class LlmClient {
  private settings: LlmSettings;

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

  get effort(): Effort {
    return this.settings.effort;
  }

  /** 运行时调整思考强度；配置对象与调用方共享引用，改动立即对后续请求生效。 */
  setEffort(effort: Effort): void {
    this.settings.effort = effort;
  }

  /** 一次对话请求；超时、HTTP 错误与协议异常都转成带分类的错误。 */
  async chat(
    messages: ChatMessage[],
    tools: ToolSchema[] = [],
    overrides: ChatOverrides = {},
  ): Promise<ModelReply> {
    if (!this.configured) {
      throw new LlmError("unconfigured", "模型未配置：缺少 baseUrl、apiKey 或 model");
    }
    const started = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.settings.timeoutMs);
    try {
      const response = await fetch(this.requestUrl(), {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify(requestPayload(this.settings, messages, tools, overrides, false)),
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new LlmError("http", await this.describeFailure(response));
      }
      if (this.settings.api === "anthropic-messages") {
        const payload = (await response.json()) as AnthropicResponse;
        const parsed = readAnthropicBlocks(payload.content ?? []);
        return {
          content: parsed.content,
          toolCalls: parsed.toolCalls,
          usage: readAnthropicUsage(payload.usage),
          latencyMs: Date.now() - started,
          model: typeof payload.model === "string" ? payload.model : this.settings.model,
        };
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
      throw this.normalizeError(error, controller);
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * 流式对话请求。
   *
   * 每收到一片增量就回调一次，正文与推理分开。工具调用分片在内部累积，
   * 返回结构与 chat 一致，调用方无需区分两种模式。
   */
  async chatStream(
    messages: ChatMessage[],
    tools: ToolSchema[],
    onDelta: (delta: StreamDelta) => void,
    overrides: ChatOverrides = {},
  ): Promise<ModelReply> {
    if (!this.configured) {
      throw new LlmError("unconfigured", "模型未配置：缺少 baseUrl、apiKey 或 model");
    }
    const started = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.settings.timeoutMs);
    try {
      const response = await fetch(this.requestUrl(), {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify(requestPayload(this.settings, messages, tools, overrides, true)),
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new LlmError("http", await this.describeFailure(response));
      }
      if (response.body === null) {
        throw new LlmError("protocol", "流式响应没有正文");
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      const slots = new Map<number, ToolCallSlot>();
      let buffer = "";
      let content = "";
      let reasoning = "";
      let usage: Usage = readUsage(undefined);
      let model = this.settings.model;

      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        buffer += decoder.decode(chunk.value, { stream: true });
        const { frames, rest } = takeFrames(buffer);
        buffer = rest;
        for (const frame of frames) {
          const data = frameData(frame);
          if (data === null || data === "[DONE]") continue;
          if (this.settings.api === "anthropic-messages") {
            const event = JSON.parse(data) as AnthropicEvent;
            if (event.type === "message_start") {
              if (typeof event.message?.model === "string" && event.message.model !== "") model = event.message.model;
              if (event.message?.usage !== undefined) usage = readAnthropicUsage(event.message.usage);
            } else if (event.type === "content_block_start" && event.content_block?.type === "tool_use") {
              const index = typeof event.index === "number" ? event.index : 0;
              slots.set(index, { id: event.content_block.id ?? "", name: event.content_block.name ?? "", arguments: "" });
            } else if (event.type === "content_block_delta" && event.delta !== undefined) {
              const index = typeof event.index === "number" ? event.index : 0;
              if (event.delta.type === "input_json_delta" && typeof event.delta.partial_json === "string" && event.delta.partial_json !== "") {
                const slot = slots.get(index) ?? { id: "", name: "", arguments: "" };
                slot.arguments += event.delta.partial_json;
                slots.set(index, slot);
              } else if (event.delta.type === "thinking_delta" && typeof event.delta.thinking === "string" && event.delta.thinking !== "") {
                reasoning += event.delta.thinking;
                onDelta({ content: "", reasoning: event.delta.thinking });
              } else if (event.delta.type === "text_delta" && typeof event.delta.text === "string" && event.delta.text !== "") {
                content += event.delta.text;
                onDelta({ content: event.delta.text, reasoning: "" });
              }
            } else if (event.type === "message_delta" && event.usage !== undefined) {
              usage = { ...usage, completionTokens: asNumber(event.usage.output_tokens) };
            }
            continue;
          }
          const parsed = JSON.parse(data) as RawChunk;
          if (typeof parsed.model === "string" && parsed.model !== "") model = parsed.model;
          if (parsed.usage !== undefined) usage = readUsage(parsed.usage);

          const delta = parsed.choices?.[0]?.delta;
          if (delta === undefined) continue;
          const reasoningPiece = typeof delta.reasoning_content === "string" ? delta.reasoning_content : "";
          const contentPiece = typeof delta.content === "string" ? delta.content : "";
          if (reasoningPiece !== "") {
            reasoning += reasoningPiece;
            onDelta({ content: "", reasoning: reasoningPiece });
          }
          if (contentPiece !== "") {
            content += contentPiece;
            onDelta({ content: contentPiece, reasoning: "" });
          }
          accumulateToolCalls(slots, delta.tool_calls);
        }
      }

      return {
        content,
        toolCalls: finalizeToolCalls(slots),
        usage,
        latencyMs: Date.now() - started,
        model,
        reasoning,
      };
    } catch (error) {
      throw this.normalizeError(error, controller);
    } finally {
      clearTimeout(timer);
    }
  }

  private requestUrl(): string {
    const base = this.settings.baseUrl.replace(/\/+$/, "");
    return this.settings.api === "anthropic-messages" ? `${base}/v1/messages` : `${base}/chat/completions`;
  }

  private headers(): Record<string, string> {
    if (this.settings.api === "anthropic-messages") {
      return {
        "content-type": "application/json",
        "x-api-key": this.settings.apiKey,
        "anthropic-version": "2023-06-01",
      };
    }
    return {
      "content-type": "application/json",
      authorization: `Bearer ${this.settings.apiKey}`,
    };
  }

  /** 把 HTTP 失败转成带状态码的可读信息，正文过长时截断。 */
  private async describeFailure(response: Response): Promise<string> {
    const detail = redactText((await response.text()).slice(0, 300));
    return `模型服务返回 ${response.status}：${detail}`;
  }

  /** 统一错误转换：超时与网络异常都归到具体分类，便于上层决定是否降级。 */
  private normalizeError(error: unknown, controller: AbortController): LlmError {
    if (error instanceof LlmError) return error;
    if (controller.signal.aborted) {
      return new LlmError("timeout", `模型请求超时（${this.settings.timeoutMs}ms）`);
    }
    return new LlmError("http", redactText(error instanceof Error ? error.message : String(error)));
  }
}
