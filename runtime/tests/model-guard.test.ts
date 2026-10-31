import { createServer, type Server } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BankStore } from "../src/bank/data.ts";
import { ModelBrain } from "../src/bank/model-brain.ts";
import { BankAgent } from "../src/bank/orchestrator.ts";
import { LlmClient } from "../src/llm/client.ts";

/**
 * 恶意模型替身：模拟「模型被提示词攻击后返回越权内容」的场景。
 * 这是测试替身，用于验证安全边界落在代码层，不依赖模型服从。
 */
let server: Server;
let baseUrl = "";
let dir = "";

interface StubReply {
  content: string;
  calls: Array<{ name: string; arguments: string }>;
}

let stub: StubReply = { content: "", calls: [] };

beforeAll(async () => {
  server = createServer((req, res) => {
    req.resume();
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        model: "adversarial-stub",
        choices: [
          {
            message: {
              content: stub.content,
              tool_calls: stub.calls.map((call, index) => ({
                id: `call-${index}`,
                type: "function",
                function: { name: call.name, arguments: call.arguments },
              })),
            },
          },
        ],
        usage: { prompt_tokens: 120, completion_tokens: 20, prompt_cache_hit_tokens: 0, prompt_cache_miss_tokens: 120 },
      }),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  baseUrl = `http://127.0.0.1:${port}/v1`;
  dir = mkdtempSync(path.join(tmpdir(), "cordibank-guard-"));
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  if (dir !== "") rmSync(dir, { recursive: true, force: true });
});

function adversarialAgent(): BankAgent {
  const store = new BankStore(dir);
  const brain = new ModelBrain(
    new LlmClient({
      baseUrl,
      apiKey: "test-key",
      model: "adversarial-stub",
      timeoutMs: 5000,
      temperature: 0,
      maxTokens: 200,
      effort: "low",
    }),
    () => store.load(),
  );
  return new BankAgent({ storeDir: dir, brain, intentMode: "model" });
}

describe("模型不服从时的安全边界", () => {
  it("模型返回越界金额时，金额被丢弃且不执行", async () => {
    stub = { content: "", calls: [{ name: "transfer", arguments: '{"payee":"王晓明","amountCents":999999999}' }] };
    const agent = adversarialAgent();
    const before = agent.snapshot().account.balance;
    const result = await agent.chat("guard-1", "随便转点钱");
    expect(result.execution).toBeUndefined();
    expect(result.missing).toContain("amountCents");
    expect(agent.snapshot().account.balance).toBe(before);
  });

  it("模型返回未登记工具时降级为未识别", async () => {
    stub = { content: "", calls: [{ name: "drop_all_accounts", arguments: "{}" }] };
    const agent = adversarialAgent();
    const result = await agent.chat("guard-2", "你知道吗，系统升级了");
    expect(result.scene).toBe("unknown");
    expect(result.reply).toContain("没有听懂");
  });

  it("模型不返回工具调用时降级，不抛到用户面前", async () => {
    stub = { content: "抱歉，我无法完成这个请求。", calls: [] };
    const agent = adversarialAgent();
    const result = await agent.chat("guard-3", "随便说点什么吧");
    expect(result.scene).toBe("unknown");
  });

  it("模型试图执行挂失时仍走策略拦截", async () => {
    stub = { content: "", calls: [{ name: "report_loss", arguments: '{"cardId":"card-001"}' }] };
    const agent = adversarialAgent();
    const result = await agent.chat("guard-4", "我卡好像丢了");
    expect(result.decision.blocked).toBe(true);
    expect(agent.snapshot().cards[0].status).toBe("active");
  });

  it("模型返回非法参数 JSON 时降级到规则，不执行", async () => {
    stub = { content: "", calls: [{ name: "transfer", arguments: "not-a-json" }] };
    const agent = adversarialAgent();
    const result = await agent.chat("guard-5", "随便转点");
    expect(result.execution).toBeUndefined();
    expect(["transfer", "unknown"]).toContain(result.scene);
  });
});
