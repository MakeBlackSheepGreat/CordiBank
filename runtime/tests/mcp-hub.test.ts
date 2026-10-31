import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createMcpPlugin, expandSecretRefs, normalizeMcpServer } from "../src/plugins/mcp.ts";
import { loadConfig } from "../src/config.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..");
const fxServer = path.join(repoRoot, "mcp", "fx-server.mjs");
const ENV_REF = "${MCP_HUB_TEST_TOKEN}";

let dir: string;
let savedEnv: { mcpFile?: string; token?: string };

beforeAll(() => {
  dir = mkdtempSync(path.join(tmpdir(), "mcp-hub-"));
  savedEnv = { mcpFile: process.env.CORDISWARM_MCP_FILE, token: process.env.MCP_HUB_TEST_TOKEN };
  process.env.CORDISWARM_MCP_FILE = path.join(dir, "mcp.json");
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
  if (savedEnv.mcpFile === undefined) delete process.env.CORDISWARM_MCP_FILE;
  else process.env.CORDISWARM_MCP_FILE = savedEnv.mcpFile;
  if (savedEnv.token === undefined) delete process.env.MCP_HUB_TEST_TOKEN;
  else process.env.MCP_HUB_TEST_TOKEN = savedEnv.token;
});

describe("expandSecretRefs", () => {
  it("从环境变量解析凭据引用", () => {
    process.env.MCP_HUB_TEST_TOKEN = "tok-123";
    expect(expandSecretRefs("Bearer " + ENV_REF)).toBe("Bearer tok-123");
  });

  it("环境变量缺失时报 INVALID_INPUT", () => {
    delete process.env.MCP_HUB_TEST_TOKEN;
    expect(() => expandSecretRefs(ENV_REF)).toThrowError(/环境变量未设置/);
  });

  it("无引用的值原样返回", () => {
    expect(expandSecretRefs("plain-value")).toBe("plain-value");
  });
});

describe("mcp 连接器中心", () => {
  it("add 带 category 元数据并回显", () => {
    const cfg = loadConfig({ storeDir: path.join(dir, "store") });
    const plugin = createMcpPlugin(cfg);
    const added = plugin.provider.add({
      id: "hub-fx",
      name: "汇率服务",
      transport: "stdio",
      command: "node",
      args: [fxServer],
      category: "汇率",
    });
    expect(added.servers[0]?.category).toBe("汇率");
    expect(plugin.provider.list().servers[0]?.category).toBe("汇率");
    expect(plugin.provider.list().servers[0]?.connected).toBe(false);
  });

  it("normalizeMcpServer：未写分类时为 undefined", () => {
    const server = normalizeMcpServer({ id: "a", name: "A", transport: "http", url: "http://127.0.0.1:9" });
    expect(server.category).toBeUndefined();
  });

  it("connect → ready；disconnect → idle；health 计时", async () => {
    const cfg = loadConfig({ storeDir: path.join(dir, "store") });
    const plugin = createMcpPlugin(cfg);
    const connected = await plugin.provider.connect("hub-fx");
    const summary = connected.servers.find((item) => item.id === "hub-fx");
    expect(summary?.status).toBe("ready");
    expect(summary?.connected).toBe(true);
    expect(summary?.toolCount ?? 0).toBeGreaterThan(0);

    const health = await plugin.provider.health("hub-fx");
    expect(health.ok).toBe(true);
    expect(health.latencyMs).toBeGreaterThanOrEqual(0);
    expect(health.toolCount).toBeGreaterThan(0);

    const disconnected = plugin.provider.disconnect("hub-fx");
    const after = disconnected.servers.find((item) => item.id === "hub-fx");
    expect(after?.connected).toBe(false);
    expect(after?.status).toBe("idle");
  });

  it("health 对未配置 id 报 NOT_FOUND", async () => {
    const cfg = loadConfig({ storeDir: path.join(dir, "store") });
    const plugin = createMcpPlugin(cfg);
    await expect(Promise.resolve().then(() => plugin.provider.health("ghost"))).rejects.toThrowError(/未配置/);
  });
});
