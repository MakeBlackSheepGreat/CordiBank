import { afterEach, describe, expect, it } from "vitest";
import { loadConfig, resolveLlm, resolveProviderId } from "../src/config.ts";
import { LEGACY_SILICONFLOW, PROVIDER_CATALOG, findProvider } from "../src/llm/providers.ts";
import { LlmClient } from "../src/llm/client.ts";
import type { LlmSettings } from "../src/llm/types.ts";

/** 环境变量快照：测试里改动的键在用例结束后恢复。 */
const ENV_KEYS = [
  "CORDIBANK_LLM_PROVIDER",
  "LLM_API_KEY",
  "LLM_BASE_URL",
  "LLM_MODEL",
  "DEEPSEEK_API_KEY",
  "SILICONFLOW_API_KEY",
  "ANTHROPIC_API_KEY",
];
const savedEnv = new Map<string, string | undefined>();
function withEnv(mutate: () => void): void {
  for (const key of ENV_KEYS) {
    if (savedEnv.has(key) === false) savedEnv.set(key, process.env[key]);
    delete process.env[key];
  }
  mutate();
}

afterEach(() => {
  for (const [key, value] of savedEnv) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  savedEnv.clear();
});

describe("provider catalog", () => {
  it("目录条目 id 唯一且字段合法", () => {
    const ids = new Set(PROVIDER_CATALOG.map((entry) => entry.id));
    expect(ids.size).toBe(PROVIDER_CATALOG.length);
    for (const entry of PROVIDER_CATALOG) {
      expect(entry.name).not.toBe("");
      expect(entry.envVar).not.toBe("");
      // sdk 协议需要官方 SDK，允许空 baseUrl；HTTP 协议必须给端点
      if (entry.api !== "sdk") expect(entry.baseUrl.startsWith("https://")).toBe(true);
    }
  });

  it("deepseek 与历史 siliconflow 条目带缺省模型", () => {
    expect(findProvider("deepseek")?.defaultModel).toBe("deepseek-chat");
    expect(LEGACY_SILICONFLOW.defaultModel).toBe("Qwen/Qwen2.5-7B-Instruct");
    expect(findProvider("siliconflow")).toBeUndefined();
    expect(findProvider("nonexistent")).toBeUndefined();
  });
});

describe("resolveLlm 分支", () => {
  it("未配置任何密钥时空串缺省", () => {
    withEnv(() => {
      const llm = resolveLlm();
      expect(resolveProviderId()).toBe("");
      expect(llm.baseUrl).toBe("");
      expect(llm.apiKey).toBe("");
      expect(llm.model).toBe("");
    });
  });

  it("DEEPSEEK_API_KEY 推断 deepseek 并取目录端点与缺省模型", () => {
    withEnv(() => {
      process.env.DEEPSEEK_API_KEY = "sk-test";
      const llm = resolveLlm();
      expect(resolveProviderId()).toBe("deepseek");
      expect(llm.baseUrl).toBe("https://api.deepseek.com/v1");
      expect(llm.apiKey).toBe("sk-test");
      expect(llm.model).toBe("deepseek-chat");
      expect(llm.api).toBe("openai-completions");
    });
  });

  it("仅 SILICONFLOW_API_KEY 时回落历史 siliconflow", () => {
    withEnv(() => {
      process.env.SILICONFLOW_API_KEY = "sk-sf";
      const llm = resolveLlm();
      expect(resolveProviderId()).toBe("siliconflow");
      expect(llm.baseUrl).toBe("https://api.siliconflow.cn/v1");
      expect(llm.model).toBe("Qwen/Qwen2.5-7B-Instruct");
    });
  });

  it("CORDIBANK_LLM_PROVIDER 显式指定 anthropic 走 messages 协议", () => {
    withEnv(() => {
      process.env.CORDIBANK_LLM_PROVIDER = "anthropic";
      process.env.ANTHROPIC_API_KEY = "sk-ant";
      const llm = resolveLlm();
      expect(llm.baseUrl).toBe("https://api.anthropic.com");
      expect(llm.api).toBe("anthropic-messages");
      expect(llm.apiKey).toBe("sk-ant");
      expect(llm.model).toBe("");
    });
  });

  it("LLM_* 环境变量覆盖目录值", () => {
    withEnv(() => {
      process.env.DEEPSEEK_API_KEY = "sk-test";
      process.env.LLM_BASE_URL = "https://proxy.example.com/v1";
      process.env.LLM_MODEL = "deepseek-reasoner";
      const llm = resolveLlm();
      expect(llm.baseUrl).toBe("https://proxy.example.com/v1");
      expect(llm.model).toBe("deepseek-reasoner");
    });
  });

  it("loadConfig 透传 llmProvider", () => {
    withEnv(() => {
      process.env.DEEPSEEK_API_KEY = "sk-test";
      const cfg = loadConfig({ storeDir: "cordibank-test-tmp/store", skillsDir: "cordibank-test-tmp/skills" });
      expect(cfg.llmProvider).toBe("deepseek");
    });
  });
});

function anthropicSettings(): LlmSettings {
  return {
    baseUrl: "https://api.anthropic.com",
    apiKey: "sk-ant-test",
    model: "claude-test",
    timeoutMs: 2000,
    temperature: 0,
    maxTokens: 1024,
    effort: "off",
    api: "anthropic-messages",
  };
}

function sseResponse(chunks: string[]): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
  return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
}

describe("LlmClient anthropic-messages 协议", () => {
  it("非流式：请求体提升 system、工具结果转 tool_result，响应解析 text 与 tool_use", async () => {
    const calls: Array<{ url: string; headers: Record<string, string>; body: Record<string, unknown> }> = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
      calls.push({
        url: String(url),
        headers: { ...(init?.headers as Record<string, string>) },
        body: JSON.parse(String(init?.body)) as Record<string, unknown>,
      });
      return new Response(
        JSON.stringify({
          model: "claude-test",
          content: [
            { type: "text", text: "余额查询中" },
            { type: "tool_use", id: "toolu_1", name: "query_balance", input: { account: "A1" } },
          ],
          usage: { input_tokens: 20, output_tokens: 5, cache_read_input_tokens: 8 },
        }),
        { status: 200 },
      );
    }) as typeof fetch;
    try {
      const client = new LlmClient(anthropicSettings());
      const reply = await client.chat(
        [
          { role: "system", content: "你是银行助手" },
          { role: "user", content: "查余额" },
          { role: "assistant", content: "", tool_calls: [{ id: "toolu_0", type: "function", function: { name: "query_balance", arguments: "{\"account\":\"A0\"}" } }] },
          { role: "tool", content: "balance=100", tool_call_id: "toolu_0" },
        ],
        [{ type: "function", function: { name: "query_balance", description: "查余额", parameters: {} } }],
      );
      expect(calls).toHaveLength(1);
      expect(calls[0].url).toBe("https://api.anthropic.com/v1/messages");
      expect(calls[0].headers["x-api-key"]).toBe("sk-ant-test");
      expect(calls[0].headers["anthropic-version"]).toBe("2023-06-01");
      const body = calls[0].body;
      expect(body.system).toBe("你是银行助手");
      expect(body.thinking).toEqual({ type: "disabled" });
      const tools = body.tools as Array<Record<string, unknown>>;
      expect(tools[0]).toEqual({ name: "query_balance", description: "查余额", input_schema: {} });
      const turns = body.messages as Array<{ role: string; content: unknown }>;
      expect(turns).toHaveLength(3);
      expect(turns[1]).toEqual({
        role: "assistant",
        content: [{ type: "tool_use", id: "toolu_0", name: "query_balance", input: { account: "A0" } }],
      });
      expect(turns[2]).toEqual({
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "toolu_0", content: "balance=100" }],
      });
      expect(reply.content).toBe("余额查询中");
      expect(reply.toolCalls).toEqual([{ id: "toolu_1", name: "query_balance", arguments: "{\"account\":\"A1\"}" }]);
      expect(reply.usage.promptTokens).toBe(20);
      expect(reply.usage.completionTokens).toBe(5);
      expect(reply.usage.cacheHitTokens).toBe(8);
      expect(reply.model).toBe("claude-test");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("流式：text_delta 与 thinking_delta 分路回调，tool_use 分片拼接", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      sseResponse([
        "event: message_start\n",
        'data: {"type":"message_start","message":{"model":"claude-test","usage":{"input_tokens":12}}}\n\n',
        "event: content_block_start\n",
        'data: {"type":"content_block_start","index":0,"content_block":{"type":"text"}}\n\n',
        "event: content_block_delta\n",
        'data: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"想想"}}\n\n',
        'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"你好"}}\n\n',
        "event: content_block_start\n",
        'data: {"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"toolu_9","name":"query_balance"}}\n\n',
        'data: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\\\"acc"}}\n\n',
        'data: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"ount\\\":1}"}}\n\n',
        "event: message_delta\n",
        'data: {"type":"message_delta","usage":{"output_tokens":9}}\n\n',
        "event: message_stop\n",
        'data: {"type":"message_stop"}\n\n',
      ])) as typeof fetch;
    try {
      const client = new LlmClient(anthropicSettings());
      const deltas: string[] = [];
      const reply = await client.chatStream(
        [{ role: "user", content: "你好" }],
        [],
        (delta) => deltas.push(delta.reasoning === "" ? `c:${delta.content}` : `r:${delta.reasoning}`),
        { effort: "low", maxTokens: 2048 },
      );
      expect(deltas).toEqual(["r:想想", "c:你好"]);
      expect(reply.content).toBe("你好");
      expect(reply.reasoning).toBe("想想");
      expect(reply.toolCalls).toEqual([{ id: "toolu_9", name: "query_balance", arguments: "{\"account\":1}" }]);
      expect(reply.usage.promptTokens).toBe(12);
      expect(reply.usage.completionTokens).toBe(9);
      expect(reply.model).toBe("claude-test");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
