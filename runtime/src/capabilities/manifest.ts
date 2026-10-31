/**
 * 插件清单：与 DeepSeek Harness 的 dsh-plugin.json 同构的声明文件。
 *
 * 一个插件目录 = cordibank-plugin.json + 入口模块；运行时按清单发现插件，
 * 装配顺序、启用与配置由插件目录投放与 patch 分层（cordibank.patch.yml）决定，
 * 框架代码不再硬编码插件名单。
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { resolveWithin } from "../shared/path-containment.ts";

/** 清单文件名：扫描插件目录时的发现标记。 */
export const MANIFEST_FILE = "cordibank-plugin.json";

/** 插件 id：小写字母数字开头，允许 . _ - 作分隔符。 */
const PLUGIN_ID_PATTERN = /^[a-z0-9][a-z0-9._-]*$/;

/** 插件清单（声明面）。 */
export interface PluginManifest {
  /** 全局唯一 id；inject 与 patch 层按 id 引用插件。 */
  id: string;
  /** 显示名，用于日志与运维界面。 */
  name?: string;
  /** 语义版本。 */
  version?: string;
  /** 一句话说明。 */
  description?: string;
  /** 入口模块相对清单文件的路径；缺省 index.ts。 */
  entry?: string;
  /** 依赖的其他插件 id：装配器按此拓扑排序，缺失或成环在装配期硬报错。 */
  inject?: string[];
  /** 默认配置；patch 层按 id 浅合并覆盖，装配器写入 plugin.config。 */
  config?: Record<string, unknown>;
}

/** 校验并归一清单原文；source 用于报错定位。 */
export function validateManifest(raw: unknown, source: string): PluginManifest {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(`[${source}] 清单必须是 JSON 对象`);
  }
  const record = raw as Record<string, unknown>;
  if (typeof record.id !== "string" || !PLUGIN_ID_PATTERN.test(record.id)) {
    throw new Error(`[${source}] 清单 id 缺失或非法：${String(record.id)}（须匹配 ${PLUGIN_ID_PATTERN}）`);
  }
  const manifest: PluginManifest = { id: record.id };
  for (const key of ["name", "version", "description"] as const) {
    const value = record[key];
    if (value === undefined) continue;
    if (typeof value !== "string") {
      throw new Error(`[${source}] 清单 ${key} 必须是字符串`);
    }
    manifest[key] = value;
  }
  if (record.entry !== undefined) {
    if (typeof record.entry !== "string" || record.entry === "") {
      throw new Error(`[${source}] 清单 entry 必须是非空字符串`);
    }
    manifest.entry = record.entry;
  }
  if (record.inject !== undefined) {
    if (!Array.isArray(record.inject) || record.inject.some((item) => typeof item !== "string" || !PLUGIN_ID_PATTERN.test(item))) {
      throw new Error(`[${source}] 清单 inject 必须是插件 id 字符串数组`);
    }
    manifest.inject = record.inject as string[];
  }
  if (record.config !== undefined) {
    if (record.config === null || typeof record.config !== "object" || Array.isArray(record.config)) {
      throw new Error(`[${source}] 清单 config 必须是对象`);
    }
    manifest.config = record.config as Record<string, unknown>;
  }
  return manifest;
}

/** 读取清单文件；解析失败带文件名抛错。 */
export function readManifestFile(file: string): PluginManifest {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    throw new Error(`[${file}] 清单不是合法 JSON：${error instanceof Error ? error.message : String(error)}`);
  }
  return validateManifest(parsed, file);
}

/** 解析入口模块绝对路径：必须落在清单目录内且文件存在（防清单声明越出插件目录）。 */
export function resolveEntry(manifest: PluginManifest, manifestDir: string): string {
  let entry: string;
  try {
    entry = resolveWithin(manifestDir, manifest.entry ?? "index.ts");
  } catch {
    throw new Error(`[${manifest.id}] 入口声明越出插件目录：${manifest.entry}`);
  }
  if (!existsSync(entry) || !statSync(entry).isFile()) {
    throw new Error(`[${manifest.id}] 入口模块不存在：${entry}`);
  }
  return entry;
}
