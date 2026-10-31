import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BankAgent } from "../src/bank/orchestrator.ts";
import { createBankAgentPlugin } from "../src/plugins/bank-agent.ts";
import { loadConfig } from "../src/config.ts";

let dir = "";
let agent: BankAgent;
let pluginDir = "";

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "cordibank-hard-"));
  agent = new BankAgent({ storeDir: dir });
  pluginDir = mkdtempSync(path.join(tmpdir(), "cordibank-hard-plugin-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  rmSync(pluginDir, { recursive: true, force: true });
});

describe("RPC 参数个数硬校验", () => {
  it("无参方法带多余参数被拒绝", () => {
    const cfg = loadConfig({ storeDir: path.join(pluginDir, "store"), skillsDir: path.join(pluginDir, "skills") });
    const plugin = createBankAgentPlugin(cfg);
    const provider = plugin.provider as unknown as Record<string, (...params: unknown[]) => unknown>;
    expect(() => provider.state(1, 2, 3)).toThrow(/最多接受 0 个参数/);
    expect(() => provider.tools("x")).toThrow(/最多接受 0 个参数/);
  });

  it("有参方法超上限被拒绝，正常参数不受影响", () => {
    const cfg = loadConfig({ storeDir: path.join(pluginDir, "store"), skillsDir: path.join(pluginDir, "skills") });
    const plugin = createBankAgentPlugin(cfg);
    const provider = plugin.provider as unknown as Record<string, (...params: unknown[]) => unknown>;
    expect(() => provider.chat("s", "查询余额", "多余")).toThrow(/最多接受 2 个参数/);
    expect(() => provider.audit("s", 50, true)).toThrow(/最多接受 2 个参数/);
    // 正常调用不被拦截（audit 无需引擎先挂载也能返回链状态）
    const result = provider.audit() as { records: unknown[]; chain: { ok: boolean } };
    expect(Array.isArray(result.records)).toBe(true);
    expect(result.chain.ok).toBe(true);
  });
});

describe("审计查询窗口", () => {
  it("旧会话的留痕不因 limit 窗口丢失", async () => {
    await agent.chat("win-a", "查询余额");
    for (let i = 0; i < 60; i += 1) {
      await agent.chat("win-b", "查询余额");
    }
    const old = agent.auditLog("win-a", 50);
    expect(old.records.length).toBeGreaterThanOrEqual(1);
    expect(old.records.every((r) => (r as { sessionId: string }).sessionId === "win-a")).toBe(true);
    expect(old.chain.ok).toBe(true);
    const recent = agent.auditLog("win-b", 10);
    expect(recent.records.length).toBe(10);
  });
});
