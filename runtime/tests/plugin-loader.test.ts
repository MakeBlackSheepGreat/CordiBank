import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CapabilityRegistry } from "../src/capabilities/registry.ts";
import { assembleCapabilities, discoverPlugins, readPatch } from "../src/capabilities/loader.ts";
import { readManifestFile, resolveEntry, validateManifest } from "../src/capabilities/manifest.ts";
import { registerBuiltinCapabilities } from "../src/capabilities/builtins.ts";
import type { CapabilityPlugin } from "../src/capabilities/types.ts";
import { loadConfig } from "../src/config.ts";

let dir = "";

beforeEach(() => {
  // 用 repo 内长路径：vitest 动态 import 无法加载 Windows 8.3 短路径（876762~1）下的模块
  const base = path.join(process.cwd(), ".test-tmp");
  mkdirSync(base, { recursive: true });
  dir = mkdtempSync(path.join(base, "plugins-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** 写一个外部插件目录：清单 + .mjs 入口。 */
function writePlugin(
  name: string,
  manifest: Record<string, unknown>,
  entry: string | null,
): { manifestFile: string; entryFile: string } {
  const pluginDir = path.join(dir, name);
  mkdirSync(pluginDir, { recursive: true });
  const manifestFile = path.join(pluginDir, "cordibank-plugin.json");
  writeFileSync(manifestFile, JSON.stringify(manifest.entry ? manifest : { ...manifest, entry: "index.mjs" }));
  const entryFile = path.join(pluginDir, manifest.entry ?? "index.mjs");
  if (entry !== null) writeFileSync(entryFile, entry);
  return { manifestFile, entryFile };
}

function makePlugin(name: string, service: string, order: string[], extra: Partial<CapabilityPlugin> = {}): CapabilityPlugin {
  return {
    name,
    def: { service, methods: ["ping"] },
    provider: { ping: () => `${service}:${order.join("|")}` },
    mount() {
      order.push(name);
    },
    ...extra,
  };
}

describe("插件清单", () => {
  it("接受合法清单并归一", () => {
    const manifest = validateManifest(
      { id: "demo.panel", name: "演示", entry: "main.mjs", inject: ["demo.base"], config: { a: 1 } },
      "test",
    );
    expect(manifest.id).toBe("demo.panel");
    expect(manifest.entry).toBe("main.mjs");
    expect(manifest.inject).toEqual(["demo.base"]);
  });

  it("拒绝缺 id / 非法 id / 非法 inject", () => {
    expect(() => validateManifest({}, "test")).toThrow();
    expect(() => validateManifest({ id: "Bad Id" }, "test")).toThrow();
    expect(() => validateManifest({ id: "a", inject: ["Bad!"] }, "test")).toThrow();
    expect(() => validateManifest({ id: "a", inject: "b" }, "test")).toThrow();
  });

  it("入口解析禁止越出插件目录且要求文件存在", () => {
    writePlugin("esc", { id: "esc", entry: "../../evil.mjs" }, null);
    const manifest = readManifestFile(path.join(dir, "esc", "cordibank-plugin.json"));
    expect(() => resolveEntry(manifest, path.join(dir, "esc"))).toThrow("越出");
    writePlugin("missing", { id: "missing", entry: "nope.mjs" }, null);
    const missing = readManifestFile(path.join(dir, "missing", "cordibank-plugin.json"));
    expect(() => resolveEntry(missing, path.join(dir, "missing"))).toThrow("不存在");
  });

  it("清单文件非法 JSON 报错带文件名", () => {
    const file = path.join(dir, "bad.json");
    writeFileSync(file, "{ not json");
    expect(() => readManifestFile(file)).toThrow("bad.json");
  });
});

describe("patch 分层", () => {
  it("文件缺失视为空层", () => {
    expect(readPatch(path.join(dir, "none.yml"))).toEqual([]);
  });

  it("顶层必须为数组且条目须带 id", () => {
    const bad = path.join(dir, "bad.yml");
    writeFileSync(bad, "id: x\n");
    expect(() => readPatch(bad)).toThrow("数组");
    const noId = path.join(dir, "noid.yml");
    writeFileSync(noId, "- name: x\n");
    expect(() => readPatch(noId)).toThrow("缺 id");
  });

  it("解析 disabled 与 config", () => {
    const file = path.join(dir, "ok.yml");
    writeFileSync(file, "- id: a\n  disabled: true\n- id: b\n  config:\n    greet: yo\n");
    const patch = readPatch(file);
    expect(patch).toEqual([
      { id: "a", disabled: true },
      { id: "b", config: { greet: "yo" } },
    ]);
  });
});

describe("装配器", () => {
  it("发现插件目录中的清单", () => {
    writePlugin("p-base", { id: "p-base", name: "基础" }, "export function createCapability(){return null;}");
    writePlugin("p-app", { id: "p-app", entry: "main.mjs" }, "export function createCapability(){return null;}");
    const found = discoverPlugins([dir]);
    expect(found.map((p) => p.manifest.id).sort()).toEqual(["p-app", "p-base"]);
    expect(found[0].entryPath).toContain("main.mjs");
  });

  it("按 inject 依赖序装配，patch config 合并写入 plugin.config", async () => {
    const registry = new CapabilityRegistry();
    writePlugin(
      "p-base",
      { id: "p-base", config: { greet: "hi" } },
      `const log = ["p-base"];
      export function createCapability(){
        const plugin = { name: "p-base", def: { service: "demo.base", methods: ["ping", "note"] },
          provider: {
            ping: () => \`\${log.join("|")}|\${plugin.config?.greet ?? ""}\`,
            note: (msg) => { log.push(String(msg)); return msg; },
          }, mount() {} };
        return plugin; }`,
    );
    writePlugin(
      "p-app",
      { id: "p-app", inject: ["p-base"] },
      `export function createCapability(_cfg, deps){
        return { name: "p-app", def: { service: "demo.app", methods: ["ping"] },
          provider: { ping: () => "" }, mount() { deps.get("p-base").provider.note("p-app"); } }; }`,
    );
    const external = discoverPlugins([dir]);
    const result = await assembleCapabilities(registry, undefined, {
      bundled: [],
      external,
      patch: [{ id: "p-base", config: { greet: "yo" } }],
      cfg: loadConfig({ storeDir: dir }),
    });
    expect(result.loaded).toEqual(["p-base", "p-app"]);
    // p-app 的 mount 在 p-base 之后执行，才通过依赖 provider 写进日志；greet 取 patch 层 yo 而非清单 hi
    await expect(registry.call("demo.base.ping", [])).resolves.toBe("p-base|p-app|yo");
  });

  it("缺依赖与依赖环在装配期硬报错", async () => {
    const registry = new CapabilityRegistry();
    writePlugin("p-lone", { id: "p-lone", inject: ["ghost"] }, "export function createCapability(){return null;}");
    await expect(
      assembleCapabilities(registry, undefined, {
        bundled: [],
        external: discoverPlugins([dir]),
        patch: [],
        cfg: loadConfig({ storeDir: dir }),
      }),
    ).rejects.toThrow("ghost");

    const cycle = new CapabilityRegistry();
    rmSync(path.join(dir, "p-lone"), { recursive: true, force: true });
    writePlugin("c-a", { id: "c-a", inject: ["c-b"] }, "export function createCapability(){return null;}");
    writePlugin("c-b", { id: "c-b", inject: ["c-a"] }, "export function createCapability(){return null;}");
    await expect(
      assembleCapabilities(cycle, undefined, {
        bundled: [],
        external: discoverPlugins([dir]),
        patch: [],
        cfg: loadConfig({ storeDir: dir }),
      }),
    ).rejects.toThrow("环");
  });

  it("patch 停用的插件被跳过", async () => {
    const order: string[] = [];
    const registry = new CapabilityRegistry();
    const base = makePlugin("p-base", "demo.base", order);
    const app = makePlugin("p-app", "demo.app", order);
    const result = await assembleCapabilities(registry, undefined, {
      bundled: [
        { manifest: { id: "p-base" }, create: () => base },
        { manifest: { id: "p-app" }, create: () => app },
      ],
      external: [],
      patch: [{ id: "p-app", disabled: true }],
      cfg: loadConfig({ storeDir: dir }),
    });
    expect(result.loaded).toEqual(["p-base"]);
    expect(result.skipped).toEqual([{ id: "p-app", reason: "patch 层停用" }]);
    expect(registry.isMounted("p-app")).toBe(false);
  });

  it("外部插件与内置 id 冲突时跳过外部", async () => {
    const registry = new CapabilityRegistry();
    writePlugin("skill", { id: "skill" }, "export function createCapability(){return null;}");
    const result = await assembleCapabilities(registry, undefined, {
      bundled: [{ manifest: { id: "skill" }, create: () => makePlugin("skill", "skill.registry", []) }],
      external: discoverPlugins([dir]),
      patch: [],
      cfg: loadConfig({ storeDir: dir }),
    });
    expect(result.loaded).toEqual(["skill"]);
    expect(result.skipped).toEqual([{ id: "skill", reason: expect.stringContaining("冲突") }]);
  });

  it("idempotent 重复装配跳过已注册插件", async () => {
    const registry = new CapabilityRegistry();
    const opts = {
      bundled: [{ manifest: { id: "p-base" }, create: () => makePlugin("p-base", "demo.base", []) }],
      external: [],
      patch: [],
      cfg: loadConfig({ storeDir: dir }),
      idempotent: true,
    };
    await assembleCapabilities(registry, undefined, opts);
    const second = await assembleCapabilities(registry, undefined, opts);
    expect(second.loaded).toEqual([]);
    expect(second.skipped).toEqual([{ id: "p-base", reason: "已注册，幂等跳过" }]);
  });

  it("入口模块缺 createCapability 导出时报错", async () => {
    const registry = new CapabilityRegistry();
    writePlugin("p-bad", { id: "p-bad" }, "export const nope = 1;");
    await expect(
      assembleCapabilities(registry, undefined, {
        bundled: [],
        external: discoverPlugins([dir]),
        patch: [],
        cfg: loadConfig({ storeDir: dir }),
      }),
    ).rejects.toThrow("createCapability");
  });
});

describe("内置装配全链", () => {
  it("registerBuiltinCapabilities 按依赖序装载并挂载四件内置", async () => {
    const registry = new CapabilityRegistry();
    const cfg = loadConfig({
      storeDir: path.join(dir, "store"),
      skillsDir: path.join(dir, "skills"),
      patchFile: path.join(dir, "none.yml"),
      pluginDirs: [],
    });
    const result = await registerBuiltinCapabilities(registry, cfg);
    expect(result.loaded).toEqual(["mcp", "skill", "jobs", "llm-registry", "swarm-team", "bank-agent", "scheduler"]);
    expect(result.skipped).toEqual([]);
    expect(registry.isMounted("mcp")).toBe(true);
    expect(registry.isMounted("skill")).toBe(true);
    expect(registry.isMounted("bank-agent")).toBe(true);
    // 幂等：重复调用不报错也不重复装载
    const second = await registerBuiltinCapabilities(registry, cfg);
    expect(second.loaded).toEqual([]);
  });
});
