import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { builtinToolDescriptors } from "../src/bank/builtin-tools.ts";
import { BankAgent } from "../src/bank/orchestrator.ts";
import { parseIntent } from "../src/bank/intent.ts";
import { TOOL_SPECS } from "../src/bank/policy.ts";
import { mcpToolName, parseMcpToolName, ToolRegistry } from "../src/harness/registry.ts";
import { mcpToolDescriptors } from "../src/plugins/mcp-tools.ts";

let dir = "";
let agent: BankAgent;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "cordibank-harness-"));
  agent = new BankAgent({ storeDir: dir });
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("工具注册表", () => {
  it("内置工具全部登记且与策略表一致", () => {
    const registry = new ToolRegistry();
    registry.registerMany(builtinToolDescriptors());
    expect(registry.size).toBe(TOOL_SPECS.length);
    expect(registry.get("transfer")?.risk.write).toBe(true);
    expect(registry.get("query_balance")?.risk.write).toBe(false);
  });

  it("同名工具重复登记直接报错", () => {
    const registry = new ToolRegistry();
    registry.registerMany(builtinToolDescriptors());
    expect(() => registry.registerMany(builtinToolDescriptors())).toThrow();
  });

  it("按场景筛选只返回该场景工具", () => {
    const registry = new ToolRegistry();
    registry.registerMany(builtinToolDescriptors());
    const wealth = registry.byScene("wealth").map((item) => item.name);
    expect(wealth).toContain("wealth_redeem");
    expect(wealth).toContain("wealth_purchase");
    expect(wealth).not.toContain("transfer");
  });

  it("只读清单不含写操作", () => {
    const registry = new ToolRegistry();
    registry.registerMany(builtinToolDescriptors());
    const readonly = registry.readonlyTools().map((item) => item.name);
    expect(readonly).toContain("subscription_reminder");
    expect(readonly).toContain("query_balance");
    expect(readonly).not.toContain("birthday_book");
    expect(readonly).not.toContain("wealth_redeem");
  });

  it("外部工具名带前缀且可反解", () => {
    const name = mcpToolName("bank-gift", "place_order");
    expect(name).toBe("mcp__bank-gift__place_order");
    expect(parseMcpToolName(name)).toEqual({ serverId: "bank-gift", remoteName: "place_order" });
    expect(parseMcpToolName("transfer")).toBeNull();
  });
});

describe("外部工具风险判定", () => {
  const tools = [
    { serverId: "bank-gift", name: "list_gifts", description: "列出套餐", inputSchema: { type: "object" } },
    { serverId: "bank-gift", name: "place_order", description: "下单", inputSchema: { type: "object" } },
  ];

  it("服务级只读声明为绿", () => {
    const [descriptor] = mcpToolDescriptors("bank-fx", tools, { risk: "read" });
    expect(descriptor.risk.level).toBe("green");
    expect(descriptor.risk.write).toBe(false);
  });

  it("服务级写声明为黄", () => {
    const [descriptor] = mcpToolDescriptors("bank-gift", tools, { risk: "write" });
    expect(descriptor.risk.level).toBe("yellow");
    expect(descriptor.risk.write).toBe(true);
  });

  it("不可逆声明为红", () => {
    const [descriptor] = mcpToolDescriptors("bank-gift", tools, { irreversible: true });
    expect(descriptor.risk.level).toBe("red");
  });

  it("工具级覆盖优先于服务级", () => {
    const [read, write] = mcpToolDescriptors("bank-gift", tools, {
      risk: "read",
      tools: { place_order: "write" },
    });
    expect(read.risk.level).toBe("green");
    expect(write.risk.level).toBe("yellow");
  });
});

describe("新增业务工具", () => {
  it("赎回把资金放回活期账户", async () => {
    const before = agent.snapshot();
    expect(before.holdings.length).toBeGreaterThan(0);
    const held = before.holdings.reduce((sum, item) => sum + item.amountCents, 0);
    const reply = await agent.chat("h1", "把理财全部赎回");
    expect(reply.decision.level).toBe("red");
    expect(reply.confirmation).toBeUndefined();
    expect(reply.decision.hits.some((hit) => hit.rule === "irreversible")).toBe(true);
    expect(agent.snapshot().account.balance).toBe(before.account.balance);
    expect(held).toBeGreaterThan(0);
  });

  it("续费提醒列出待扣费订阅且不改状态", async () => {
    const reply = await agent.chat("h1", "帮我看看订阅什么时候扣费");
    expect(reply.decision.level).toBe("green");
    expect(reply.execution?.ok).toBe(true);
    const data = reply.execution?.data as { items: unknown[]; totalCents: number };
    expect(Array.isArray(data.items)).toBe(true);
    expect(data.totalCents).toBeGreaterThanOrEqual(0);
  });

  it("礼遇下单优先抵扣锁定资金", async () => {
    const locked = await agent.chat("h1", "帮我准备生日，锁定 500 元");
    const done = await agent.confirm("h1", locked.confirmation?.token ?? "");
    expect(done.execution?.ok).toBe(true);
    const book = await agent.chat("h1", "帮我把生日的蛋糕和鲜花都订了");
    expect(book.decision.level).toBe("yellow");
    const placed = await agent.confirm("h1", book.confirmation?.token ?? "");
    expect(placed.execution?.ok).toBe(true);
    const data = placed.execution?.data as { usedLockedCents: number; fromBalanceCents: number };
    expect(data.usedLockedCents).toBeGreaterThan(0);
    const fund = agent.snapshot().lockedFunds[0];
    expect(fund.amountCents).toBe(50000 - data.usedLockedCents);
  });
});

describe("新增意图解析", () => {
  it("赎回说法落到赎回工具", () => {
    const state = agent.snapshot();
    expect(parseIntent("把稳盈货币赎回 1000", state).tool).toBe("wealth_redeem");
    expect(parseIntent("理财全部取出", state).tool).toBe("wealth_redeem");
  });

  it("续费提醒说法落到提醒工具", () => {
    const state = agent.snapshot();
    expect(parseIntent("订阅什么时候扣费", state).tool).toBe("subscription_reminder");
    expect(parseIntent("下个月有哪些要续费的", state).tool).toBe("subscription_reminder");
  });

  it("预订礼遇说法落到下单工具", () => {
    const state = agent.snapshot();
    expect(parseIntent("生日帮我订个蛋糕", state).tool).toBe("birthday_book");
    expect(parseIntent("生日订鲜花", state).tool).toBe("birthday_book");
  });
});
