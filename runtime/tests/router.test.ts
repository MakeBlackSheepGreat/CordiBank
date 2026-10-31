import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BankStore } from "../src/bank/data.ts";
import { createLoopExecutor } from "../src/bank/loop-tools.ts";
import { Router, routeByRule } from "../src/bank/router.ts";
import type { LlmClient } from "../src/llm/client.ts";
import type { ModelReply } from "../src/llm/types.ts";

let dir = "";

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "cordibank-router-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const WRITE_TOOLS = new Set(["transfer", "lock_card", "change_password"]);

/** 假客户端：按固定回包或异常返回，替身只用于路由判定。 */
function fakeClient(content: string | Error): LlmClient {
  return {
    chat: async (): Promise<ModelReply> => {
      if (content instanceof Error) throw content;
      return { content, toolCalls: [], usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 }, latencyMs: 1, model: "fake" };
    },
  } as unknown as LlmClient;
}

const CANDIDATES = {
  scenes: ["transfer", "bills", "wealth"],
  tools: ["query_balance", "analyze_bills"],
  skills: ["订阅代扣管理"],
};

describe("规则路由", () => {
  it("只读业务请求判为 business", () => {
    const state = new BankStore(dir).load();
    const route = routeByRule("查一下余额", state, WRITE_TOOLS);
    expect(route?.kind).toBe("business");
    expect(route?.source).toBe("rule");
  });

  it("写操作请求判为 write", () => {
    const state = new BankStore(dir).load();
    const route = routeByRule("帮我转 500 元给小王", state, WRITE_TOOLS);
    expect(route?.kind).toBe("write");
  });

  it("身份与寒暄判为 social", () => {
    const state = new BankStore(dir).load();
    expect(routeByRule("你是谁", state, WRITE_TOOLS)?.kind).toBe("social");
    expect(routeByRule("你好", state, WRITE_TOOLS)?.kind).toBe("social");
  });

  it("判不出来时返回 null 交给模型", () => {
    const state = new BankStore(dir).load();
    expect(routeByRule("今天天气怎么样", state, WRITE_TOOLS)).toBeNull();
  });
});

describe("模型路由", () => {
  it("按回包装配，臆造的工具名与技能名被丢弃", async () => {
    const router = new Router(
      fakeClient(
        JSON.stringify({
          route: "business",
          scene: "bills",
          tools: ["analyze_bills", "delete_all_bills"],
          skills: ["订阅代扣管理", "不存在的技能"],
          reason: "账单分析",
        }),
      ),
    );
    const route = await router.decide("这个月花了多少", CANDIDATES);
    expect(route.kind).toBe("business");
    expect(route.scene).toBe("bills");
    expect(route.tools).toEqual(["analyze_bills"]);
    expect(route.skills).toEqual(["订阅代扣管理"]);
    expect(route.source).toBe("model");
  });

  it("回包不是 JSON 时按 social 兜底", async () => {
    const router = new Router(fakeClient("我觉得你可以看看账单"));
    const route = await router.decide("随便聊聊", CANDIDATES);
    expect(route.kind).toBe("social");
    expect(route.source).toBe("model");
  });

  it("调用抛错时也按 social 兜底，不让对话卡死", async () => {
    const router = new Router(fakeClient(new Error("网络不可达")));
    const route = await router.decide("随便聊聊", CANDIDATES);
    expect(route.kind).toBe("social");
    expect(route.reason).toContain("网络不可达");
  });
});

describe("账单回包摘要", () => {
  it("analyze_bills 的工具摘要带分类占比与异常明细", async () => {
    const store = new BankStore(dir);
    const executor = createLoopExecutor(() => store.load());
    const result = await executor("analyze_bills", { period: "month" });
    expect(result.ok).toBe(true);
    expect(result.summary).toContain("分类占比");
    expect(result.summary).toContain("订阅扣费合计");
    expect(result.summary).toContain("异常交易");
  });

  it("list_subscriptions 的工具摘要列出逐项名称与金额", async () => {
    const store = new BankStore(dir);
    const executor = createLoopExecutor(() => store.load());
    const result = await executor("list_subscriptions", {});
    expect(result.ok).toBe(true);
    expect(result.summary).toContain("订阅明细");
    const state = store.load();
    for (const item of state.subscriptions) {
      expect(result.summary).toContain(item.name);
    }
  });

  it("未知工具直接失败，不进执行器", async () => {
    const store = new BankStore(dir);
    const executor = createLoopExecutor(() => store.load());
    const result = await executor("definitely_not_a_tool", {});
    expect(result.ok).toBe(false);
    expect(result.summary).toContain("未注册");
  });
});
