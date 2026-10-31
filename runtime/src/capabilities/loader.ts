/**
 * 插件装配器：发现（内置 + 插件目录）→ patch 分层覆盖 → inject 拓扑排序 → 注册并挂载。
 *
 * 装配语义对齐 DeepSeek Harness：
 * - 插件带声明清单（cordibank-plugin.json），外部插件投放到插件目录即被发现；
 * - 启用与配置走 patch 分层（顶层 YAML 数组，按 id 定向），不写死在框架代码里；
 * - 插件间依赖走清单的 inject 声明，装配器按依赖序 create + mount，环与缺依赖硬报错。
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { parse } from "yaml";
import type { RuntimeConfig } from "../config.ts";
import type { KernelContext } from "../kernel.ts";
import type { CapabilityPlugin } from "./types.ts";
import type { CapabilityRegistry } from "./registry.ts";
import { readManifestFile, resolveEntry, type PluginManifest } from "./manifest.ts";

/** patch 分层条目：按 id 定向覆盖一个插件。 */
export interface PatchEntry {
  id: string;
  disabled?: boolean;
  config?: Record<string, unknown>;
}

/** 内置插件：清单内联在代码里，create 工厂延迟到装配时调用。 */
export interface BundledPlugin {
  manifest: PluginManifest;
  create: (cfg: RuntimeConfig, deps: PluginDeps) => CapabilityPlugin;
}

/** 外部插件：清单 + 入口来自插件目录。 */
export interface ExternalPlugin {
  manifest: PluginManifest;
  entryPath: string;
}

/** 装载序依赖解析：装配器按依赖序 create，依赖者可取到依赖实例。 */
export interface PluginDeps {
  get(id: string): CapabilityPlugin | undefined;
}

export interface AssembleResult {
  /** 装载成功的插件 id（依赖序）。 */
  loaded: string[];
  /** 被跳过的插件与原因（patch 停用 / id 冲突 / 幂等跳过）。 */
  skipped: Array<{ id: string; reason: string }>;
}

/** 外部入口模块契约：须导出 createCapability(cfg, deps) → CapabilityPlugin。 */
interface ExternalEntryModule {
  createCapability?: (cfg: RuntimeConfig, deps: PluginDeps) => CapabilityPlugin;
}

/** 读 patch 分层文件：顶层 YAML 数组；文件缺失视为空层。 */
export function readPatch(file: string): PatchEntry[] {
  if (!existsSync(file)) return [];
  const parsed: unknown = parse(readFileSync(file, "utf8"));
  if (!Array.isArray(parsed)) {
    throw new Error(`[patch] ${file} 顶层必须是 YAML 数组`);
  }
  return parsed.map((item, index) => {
    if (item === null || typeof item !== "object" || Array.isArray(item)) {
      throw new Error(`[patch] ${file} 第 ${index + 1} 条必须是对象`);
    }
    const record = item as Record<string, unknown>;
    if (typeof record.id !== "string" || record.id === "") {
      throw new Error(`[patch] ${file} 第 ${index + 1} 条缺 id`);
    }
    const entry: PatchEntry = { id: record.id };
    if (record.disabled !== undefined) {
      if (typeof record.disabled !== "boolean") {
        throw new Error(`[patch] ${file} 条目 ${record.id} 的 disabled 必须是布尔`);
      }
      entry.disabled = record.disabled;
    }
    if (record.config !== undefined) {
      if (record.config === null || typeof record.config !== "object" || Array.isArray(record.config)) {
        throw new Error(`[patch] ${file} 条目 ${record.id} 的 config 必须是对象`);
      }
      entry.config = record.config as Record<string, unknown>;
    }
    return entry;
  });
}

/** 目录发现：扫描每个目录的一级子目录，命中 cordibank-plugin.json 即为插件。 */
export function discoverPlugins(dirs: string[]): ExternalPlugin[] {
  const found: ExternalPlugin[] = [];
  for (const dir of dirs) {
    if (!existsSync(dir)) continue;
    for (const item of readdirSync(dir, { withFileTypes: true })) {
      if (!item.isDirectory()) continue;
      const manifestFile = path.join(dir, item.name, "cordibank-plugin.json");
      if (!existsSync(manifestFile)) continue;
      const manifest = readManifestFile(manifestFile);
      found.push({ manifest, entryPath: resolveEntry(manifest, path.dirname(manifestFile)) });
    }
  }
  return found;
}

/** 拓扑排序：inject 指向其他候选 id；缺失依赖与环在装配期硬报错（fail-fast）。 */
function topoSort(ids: string[], injectOf: Map<string, string[]>): string[] {
  const idSet = new Set(ids);
  for (const id of ids) {
    for (const dep of injectOf.get(id) ?? []) {
      if (!idSet.has(dep)) {
        throw new Error(`[loader] 插件 "${id}" 依赖的 "${dep}" 不存在`);
      }
    }
  }
  const indegree = new Map<string, number>();
  const dependents = new Map<string, string[]>();
  for (const id of ids) {
    const deps = injectOf.get(id) ?? [];
    indegree.set(id, deps.length);
    for (const dep of deps) {
      const list = dependents.get(dep) ?? [];
      list.push(id);
      dependents.set(dep, list);
    }
  }
  const queue = ids.filter((id) => (indegree.get(id) ?? 0) === 0);
  const order: string[] = [];
  while (queue.length > 0) {
    const id = queue.shift()!;
    order.push(id);
    for (const next of dependents.get(id) ?? []) {
      const left = (indegree.get(next) ?? 0) - 1;
      indegree.set(next, left);
      if (left === 0) queue.push(next);
    }
  }
  if (order.length !== ids.length) {
    const stuck = ids.filter((id) => !order.includes(id));
    throw new Error(`[loader] 插件依赖存在环：${stuck.join(" → ")}`);
  }
  return order;
}

/** 装配：patch 覆盖与幂等过滤 → 拓扑排序 → 按序 create → 校验名 → 写配置 → 注册 → 挂载。 */
export async function assembleCapabilities(
  registry: CapabilityRegistry,
  ctx: KernelContext | undefined,
  opts: {
    bundled: BundledPlugin[];
    external: ExternalPlugin[];
    patch: PatchEntry[];
    cfg: RuntimeConfig;
    /** 幂等：已注册同 id 时跳过而不是抛错。 */
    idempotent?: boolean;
  },
): Promise<AssembleResult> {
  const patchById = new Map(opts.patch.map((entry) => [entry.id, entry]));
  const skipped: AssembleResult["skipped"] = [];

  // 内置优先：外部插件与内置 id 冲突时跳过外部
  const bundledIds = new Set(opts.bundled.map((p) => p.manifest.id));
  const external = opts.external.filter((p) => {
    if (!bundledIds.has(p.manifest.id)) return true;
    skipped.push({ id: p.manifest.id, reason: "与内置插件 id 冲突，外部插件被忽略" });
    return false;
  });

  type Candidate = {
    id: string;
    manifest: PluginManifest;
    make: (deps: PluginDeps) => Promise<CapabilityPlugin> | CapabilityPlugin;
  };
  const candidates: Candidate[] = [
    ...opts.bundled.map((p) => ({
      id: p.manifest.id,
      manifest: p.manifest,
      make: (deps: PluginDeps) => p.create(opts.cfg, deps),
    })),
    ...external.map((p) => ({
      id: p.manifest.id,
      manifest: p.manifest,
      make: async (deps: PluginDeps) => {
        // 传普通绝对路径而非 file URL：vitest(vite) 会把含非 ASCII 字符的 file URL 百分号编码后按字面找文件导致加载失败；Node 与 vitest 均接受绝对路径
        const mod = (await import(p.entryPath)) as ExternalEntryModule;
        if (typeof mod.createCapability !== "function") {
          throw new Error(`[${p.manifest.id}] 入口模块须导出 createCapability(cfg, deps)`);
        }
        return mod.createCapability(opts.cfg, deps);
      },
    })),
  ];

  // patch 停用的插件直接跳过，不进入依赖排序
  const active = candidates.filter((cand) => {
    if (patchById.get(cand.id)?.disabled === true) {
      skipped.push({ id: cand.id, reason: "patch 层停用" });
      return false;
    }
    return true;
  });

  // 幂等：已注册的同 id 直接跳过（重复调用 registerBuiltinCapabilities 安全）
  const known = new Set(registry.describe().map((item) => item.name));
  const pending = active.filter((cand) => {
    if (!opts.idempotent || !known.has(cand.id)) return true;
    skipped.push({ id: cand.id, reason: "已注册，幂等跳过" });
    return false;
  });

  const order = topoSort(
    pending.map((cand) => cand.id),
    new Map(pending.map((cand) => [cand.id, cand.manifest.inject ?? []])),
  );

  const created = new Map<string, CapabilityPlugin>();
  const deps: PluginDeps = { get: (id) => created.get(id) };
  const loaded: string[] = [];
  for (const id of order) {
    const cand = pending.find((item) => item.id === id)!;
    const plugin = await cand.make(deps);
    if (plugin.name !== id) {
      throw new Error(`[loader] 插件名与清单 id 不一致：${plugin.name} ≠ ${id}`);
    }
    // 配置：清单默认与 patch 层浅合并，注册前写入，插件 mount 与 provider 均可读
    plugin.config = { ...cand.manifest.config, ...patchById.get(id)?.config };
    registry.register(plugin);
    await registry.mount(id, ctx);
    created.set(id, plugin);
    loaded.push(id);
  }
  return { loaded, skipped };
}
