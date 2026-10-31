import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "../src/config.ts";
import { createOpsExtras, opsToolDescriptors } from "../src/plugins/ops.ts";

let dir: string;

beforeEach(() => {
  const base = join(process.cwd(), ".test-tmp");
  mkdirSync(base, { recursive: true });
  dir = mkdtempSync(join(base, "ops-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function cfg(opsEnabled = true) {
  return loadConfig({
    storeDir: join(dir, "store"),
    skillsDir: join(dir, "skills"),
    opsDir: join(dir, "ops"),
    opsEnabled,
  });
}

describe("ops sandbox", () => {
  it("开关关闭时不下发描述符，开启时下发 green 只读工具", () => {
    expect(opsToolDescriptors(cfg(false))).toEqual([]);
    const list = opsToolDescriptors(cfg());
    expect(list).toHaveLength(1);
    expect(list[0]?.name).toBe("ops_run");
    expect(list[0]?.risk).toEqual({ level: "green", reversible: true, write: false });
  });

  it("在沙箱目录执行 node 脚本并落审计", async () => {
    const extras = createOpsExtras(cfg());
    const result = await extras.ops_run({ command: "node", args: ["-e", "console.log('ops-ok-123')"] });
    expect(result.ok).toBe(true);
    expect(result.summary).toContain("ops-ok-123");
    const audit = readFileSync(join(dir, "ops", "audit.log"), "utf8").trim().split("\n");
    expect(audit).toHaveLength(1);
    expect(JSON.parse(audit[0] ?? "{}")).toMatchObject({ command: "node", exitCode: 0, timedOut: false });
  });

  it("白名单外命令与带路径命令被拒绝", async () => {
    const extras = createOpsExtras(cfg());
    const denied = await extras.ops_run({ command: "del", args: ["foo"] });
    expect(denied.ok).toBe(false);
    expect(denied.summary).toContain("白名单");
    const pathed = await extras.ops_run({ command: "C:\\evil\\node.exe", args: [] });
    expect(pathed.ok).toBe(false);
    expect(pathed.summary).toContain("不能带路径");
  });

  it("shell 元字符被拒绝", async () => {
    const extras = createOpsExtras(cfg());
    const result = await extras.ops_run({ command: "node & whoami" });
    expect(result.ok).toBe(false);
    expect(result.summary).toContain("元字符");
  });

  it("超长输出截断并落 spill 文件", async () => {
    const extras = createOpsExtras(cfg());
    const result = await extras.ops_run({
      command: "node",
      args: ["-e", "for(let i=0;i<3000;i++)console.log('x'.repeat(20))"],
    });
    expect(result.ok).toBe(true);
    expect(result.summary).toContain("已截断");
    const spillPath = result.summary.match(/落盘 (.+)）$/)?.[1] ?? "";
    expect(spillPath).not.toBe("");
    expect(readFileSync(spillPath, "utf8").length).toBeGreaterThan(2000);
  });

  it("超时终止并报告部分输出", async () => {
    const extras = createOpsExtras(cfg());
    const result = await extras.ops_run({
      command: "node",
      args: ["-e", "setInterval(()=>{},1000)"],
      timeoutMs: 1000,
    });
    expect(result.ok).toBe(false);
    expect(result.summary).toContain("超时");
  });

  it("子进程环境不含业务密钥", async () => {
    process.env.DEEPSEEK_API_KEY = "sk-ops-secret";
    try {
      const extras = createOpsExtras(cfg());
      const result = await extras.ops_run({
        command: "node",
        args: ["-e", "console.log('KEY=' + (process.env.DEEPSEEK_API_KEY ?? 'absent'))"],
      });
      expect(result.ok).toBe(true);
      expect(result.summary).toContain("KEY=absent");
      expect(result.summary).not.toContain("sk-ops-secret");
    } finally {
      delete process.env.DEEPSEEK_API_KEY;
    }
  });

  it("loadConfig 默认开启且默认目录在 repoRoot/.ops-sandbox", () => {
    const loaded = loadConfig({ storeDir: join(dir, "store"), skillsDir: join(dir, "skills") });
    expect(loaded.opsEnabled).toBe(true);
    expect(loaded.opsDir.endsWith(".ops-sandbox")).toBe(true);
  });
});
