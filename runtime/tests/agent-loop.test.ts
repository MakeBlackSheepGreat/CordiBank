import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { BankStore } from "../src/bank/data.ts";
import { buildLoopTools, readonlyToolNames } from "../src/bank/loop-tools.ts";
import { ModelBrain } from "../src/bank/model-brain.ts";
import { BankAgent } from "../src/bank/orchestrator.ts";
import { resolveLlm } from "../src/config.ts";
import { LlmClient } from "../src/llm/client.ts";
import { runAgentLoop } from "../src/llm/loop.ts";
import { INTENT_SYSTEM_PROMPT } from "../src/llm/prompts.ts";
import type { ModelReply } from "../src/llm/types.ts";

const base = resolveLlm();
const settings = { ...base, model: process.env.LLM_LOOP_MODEL ?? "deepseek-flash", timeoutMs: 90000, effort: "low" as const };
const configured = settings.apiKey !== "" && settings.baseUrl !== "";

const dir = configured ? mkdtempSync(path.join(tmpdir(), "cordibank-loop-")) : "";

function brain(): ModelBrain {
  const store = new BankStore(dir);
  return new ModelBrain(new LlmClient(settings), () => store.load());
}

function agent(): BankAgent {
  const store = new BankStore(dir);
  const model = new ModelBrain(new LlmClient(settings), () => store.load());
  return new BankAgent({ storeDir: dir, brain: model, intentMode: "model" });
}

afterAll(() => {
  if (dir !== "") rmSync(dir, { recursive: true, force: true });
});

describe("提示词体积", () => {
  it("意图提示词压到 900 字符以内", () => {
    expect(INTENT_SYSTEM_PROMPT.length).toBeLessThan(900);
  });

  it("只读工具与写操作严格分开", () => {
    const readonly = readonlyToolNames();
    expect(readonly).toContain("analyze_bills");
    expect(readonly).toContain("query_balance");
    expect(readonly).toContain("subscription_reminder");
    expect(readonly).not.toContain("transfer");
    expect(readonly).not.toContain("report_loss");
    expect(readonly).not.toContain("wealth_redeem");
  });
});

describe.skipIf(!configured)("DeepSeek V4.1 Flash 循环", () => {
  it(
    "只读问题会触发工具调用并给出结论",
    async () => {
      const outcome = await brain().converse("我这个月的订阅一共多少钱？");
      expect(["final", "steps"]).toContain(outcome.stopReason);
      expect(outcome.usage.calls).toBeGreaterThanOrEqual(1);
      expect(outcome.steps.length).toBeGreaterThanOrEqual(1);
      const toolNames = outcome.steps.flatMap((step) => step.calls.map((call) => call.name));
      expect(toolNames.length).toBeGreaterThanOrEqual(1);
      expect(toolNames.every((name) => readonlyToolNames().includes(name))).toBe(true);
      if (outcome.stopReason === "final") expect(outcome.text.length).toBeGreaterThan(0);
    },
    120000,
  );

  it(
    "第二轮命中前缀缓存",
    async () => {
      const model = brain();
      const first = await model.converse("我这个月的订阅一共多少钱？");
      const second = await model.converse("我这个月的订阅一共多少钱？");
      expect(first.usage.promptTokens).toBeGreaterThan(0);
      expect(second.usage.cacheHitTokens).toBeGreaterThan(0);
      expect(second.usage.cacheHitTokens).toBeLessThanOrEqual(second.usage.promptTokens);
    },
    180000,
  );

  it(
    "写操作意图不执行，交回编排层",
    async () => {
      const runner = agent();
      const before = runner.snapshot().account.balance;
      const outcome = await brain().converse("帮我给王晓明转五百块");
      if (outcome.stopReason === "write-intent") {
        expect(outcome.proposedWrite?.name).toBe("transfer");
      }
      expect(runner.snapshot().account.balance).toBe(before);
    },
    120000,
  );

  it(
    "预算耗尽时立刻停下",
    async () => {
      const reply: ModelReply = {
        content: "",
        toolCalls: [{ id: "call-1", name: "query_balance", arguments: "{}" }],
        usage: { promptTokens: 400, completionTokens: 120, cacheHitTokens: 0, cacheMissTokens: 400, reasoningTokens: 0 },
        latencyMs: 1,
        model: "stub",
      };
      let calls = 0;
      const stub = {
        chat: async (): Promise<ModelReply> => {
          calls += 1;
          return reply;
        },
      } as unknown as LlmClient;
      const outcome = await runAgentLoop({
        client: stub,
        messages: [],
        tools: buildLoopTools(),
        execute: async () => ({ ok: true, summary: "余额 38642.50 元" }),
        tokenBudget: 300,
      });
      expect(outcome.stopReason).toBe("budget");
      expect(calls).toBe(1);
      expect(outcome.usage.calls).toBe(1);
    },
    30000,
  );

  it(
    "步数上限生效",
    async () => {
      const reply: ModelReply = {
        content: "",
        toolCalls: [{ id: "call-1", name: "query_balance", arguments: "{}" }],
        usage: { promptTokens: 10, completionTokens: 5, cacheHitTokens: 0, cacheMissTokens: 10, reasoningTokens: 0 },
        latencyMs: 1,
        model: "stub",
      };
      const stub = { chat: async (): Promise<ModelReply> => reply } as unknown as LlmClient;
      const outcome = await runAgentLoop({
        client: stub,
        messages: [],
        tools: buildLoopTools(),
        execute: async () => ({ ok: true, summary: "ok" }),
        maxSteps: 2,
      });
      expect(outcome.stopReason).toBe("steps");
      expect(outcome.usage.calls).toBe(2);
    },
    30000,
  );

  it(
    "写操作在循环内不执行",
    async () => {
      const reply: ModelReply = {
        content: "",
        toolCalls: [{ id: "call-1", name: "transfer", arguments: '{"payee":"王晓明","amountCents":50000}' }],
        usage: { promptTokens: 10, completionTokens: 5, cacheHitTokens: 0, cacheMissTokens: 10, reasoningTokens: 0 },
        latencyMs: 1,
        model: "stub",
      };
      const stub = { chat: async (): Promise<ModelReply> => reply } as unknown as LlmClient;
      let executed = 0;
      const outcome = await runAgentLoop({
        client: stub,
        messages: [],
        tools: buildLoopTools(),
        execute: async () => {
          executed += 1;
          return { ok: true, summary: "should not run" };
        },
      });
      expect(outcome.stopReason).toBe("write-intent");
      expect(outcome.proposedWrite?.name).toBe("transfer");
      expect(executed).toBe(0);
    },
    30000,
  );

  it(
    "写操作走完整策略链后仍被限额拦截",
    async () => {
      const runner = agent();
      const reply = await runner.chat("loop-write", "帮我给王晓明转五千块");
      expect(reply.decision.blocked).toBe(true);
      expect(runner.snapshot().account.balance).toBe(3864250);
    },
    120000,
  );
});
