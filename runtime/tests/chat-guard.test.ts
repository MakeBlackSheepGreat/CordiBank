import { createServer, type Server } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createBankAgentPlugin } from "../src/plugins/bank-agent.ts";
import { loadConfig } from "../src/config.ts";

/**
 * 对话链路的输出审查：编排层与写链路产生的回复同样要过评估模型。
 *
 * 这里用一个本地替身服务扮演「模型 + 审查器」两种角色：
 * 系统提示含「输出安全审查器」即为审查请求，其余按对话请求处理。
 */
let server: Server;
let baseUrl = "";
let dir = "";
let reviewerSeen: string[] = [];
let reviewOk = true;
let reviewReason = "测试拦截：输出不符合要求";

beforeAll(async () => {
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") as {
        messages?: Array<{ role: string; content: string }>;
      };
      const messages = body.messages ?? [];
      const system = messages.find((item) => item.role === "system")?.content ?? "";
      const isReviewer = system.includes("输出安全审查器");
      if (isReviewer) reviewerSeen.push(messages.map((item) => item.content).join("\n"));
      const content = isReviewer
        ? JSON.stringify({ ok: reviewOk, reason: reviewOk ? "" : reviewReason })
        : "我是 CordiBank 的银行智能助手小蜂，可以帮你查余额、看账单、管理订阅。";
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        model: "review-stub",
        choices: [{ message: { content } }],
        usage: { prompt_tokens: 60, completion_tokens: 20, prompt_cache_hit_tokens: 0, prompt_cache_miss_tokens: 60 },
      }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  baseUrl = `http://127.0.0.1:${port}/v1`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  if (dir !== "") rmSync(dir, { recursive: true, force: true });
});

function makeProvider(): Record<string, (...params: unknown[]) => unknown> {
  dir = mkdtempSync(path.join(tmpdir(), "cordibank-chatguard-"));
  reviewerSeen = [];
  const cfg = loadConfig({
    storeDir: dir,
    skillsDir: path.join(dir, "skills"),
    patchFile: path.join(dir, "none.yml"),
    pluginDirs: [],
    llmIntentMode: "rule",
    reviewerEnabled: true,
    injectionClassifierEnabled: false,
    webToolsEnabled: false,
    opsEnabled: false,
    llm: {
      baseUrl,
      apiKey: "test-key",
      model: "review-stub",
      timeoutMs: 5000,
      temperature: 0,
      maxTokens: 200,
      effort: "off",
      api: "openai-completions",
    },
  });
  const plugin = createBankAgentPlugin(cfg);
  return plugin.provider as unknown as Record<string, (...params: unknown[]) => unknown>;
}

describe("对话链路的输出审查", () => {
  it("写链路与闲聊回复都经过审查器", async () => {
    const provider = makeProvider();
    reviewOk = true;
    await provider.chat("cg-1", "你好");
    expect(reviewerSeen.length).toBeGreaterThan(0);
  });

  it("审查不通过时回复被整段替换并带回 guard", async () => {
    const provider = makeProvider();
    reviewOk = false;
    reviewReason = "测试拦截：输出不符合要求";
    const reply = (await provider.chat("cg-2", "查一下余额")) as { reply: string; guard?: string };
    expect(reply.guard).toBe("测试拦截：输出不符合要求");
    expect(reply.reply).toContain("[已拦截]");
    expect(reply.reply).not.toContain("38642.50");
  });

  it("审查不通过不影响执行本身，账本余额仍然可查", async () => {
    const provider = makeProvider();
    reviewOk = false;
    await provider.chat("cg-3", "查一下余额");
    reviewOk = true;
    const state = plugin_state(provider);
    expect(state).toBeGreaterThan(0);
  });

  it("审查器拿到的证据包含本轮工具回包", async () => {
    const provider = makeProvider();
    reviewOk = true;
    await provider.chat("cg-4", "分析这个月账单");
    const joined = reviewerSeen.join("\n");
    expect(joined).toContain("本轮工具回包");
    expect(joined).toContain("analyze_bills");
  });
});

/** 取余额（分）：执行过查余额后账本可读。 */
function plugin_state(provider: Record<string, (...params: unknown[]) => unknown>): number {
  const snapshot = provider.state() as { account: { balance: number } };
  return snapshot.account.balance;
}
