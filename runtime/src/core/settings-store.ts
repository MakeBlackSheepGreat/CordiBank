/**
 * 用户设置存储：模型密钥与 IM 渠道的运行时配置。
 *
 * 落盘位置固定在 storeDir/settings.json。语义与环境变量一致：
 * 用户设置优先于环境变量，空串表示「不修改」，所以清空某字段不会被静默写入。
 */
import path from "node:path";
import { readJsonFile, writeJsonAtomic } from "../shared/json-store.ts";
import type { RuntimeConfig } from "../config.ts";
import { findProvider, LEGACY_SILICONFLOW } from "../llm/providers.ts";
import type { ProviderEntry } from "../llm/providers.ts";
import type { Effort } from "../llm/types.ts";

/** 模型侧的用户设置：只放用户可改的字段，其余沿用环境变量基线。 */
export interface UserLlmSettings {
  provider?: string;
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  effort?: Effort;
  intentMode?: "rule" | "hybrid" | "model";
}

/** IM 渠道侧的用户设置：字段名与 channels 插件使用的 cfg 字段一一对应。 */
export interface UserChannelSettings {
  qqBotAppId?: string;
  qqBotAppSecret?: string;
  dingtalkSecret?: string;
  feishuAppId?: string;
  feishuAppSecret?: string;
  feishuToken?: string;
  wechatToken?: string;
  wechatAccount?: string;
}

/** 完整用户设置：两部分都可缺省。 */
export interface UserSettings {
  llm?: UserLlmSettings;
  channels?: UserChannelSettings;
}

/** 设置文件名：落在 storeDir 下。 */
export const SETTINGS_FILE = "settings.json";

/** 设置文件绝对路径。 */
export function settingsPath(storeDir: string): string {
  return path.join(storeDir, SETTINGS_FILE);
}

/** 非空字符串判定：空串与空白串都视为「不修改」。 */
function filled(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

/** 从任意值里挑出字符串字段，非法类型直接丢弃而不是抛错。 */
function pickStrings<T extends object>(raw: unknown, keys: readonly string[]): T {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return {} as T;
  const record = raw as Record<string, unknown>;
  const picked: Record<string, string> = {};
  for (const key of keys) {
    if (typeof record[key] === "string") picked[key] = record[key];
  }
  return picked as T;
}

const LLM_KEYS = ["provider", "apiKey", "baseUrl", "model", "effort", "intentMode"] as const;
const CHANNEL_KEYS = ["qqBotAppId", "qqBotAppSecret", "dingtalkSecret", "feishuAppId", "feishuAppSecret", "feishuToken", "wechatToken", "wechatAccount"] as const;

/** 归一化：只保留已知字段与字符串值；文件缺失或损坏一律返回空设置，不抛错。 */
function normalize(raw: unknown): UserSettings {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return {};
  const record = raw as Record<string, unknown>;
  const settings: UserSettings = {};
  const llm = pickStrings<UserLlmSettings>(record.llm, LLM_KEYS);
  if (Object.keys(llm).length > 0) settings.llm = llm;
  const channels = pickStrings<UserChannelSettings>(record.channels, CHANNEL_KEYS);
  if (Object.keys(channels).length > 0) settings.channels = channels;
  return settings;
}

/** 读取用户设置：文件缺失或 JSON 损坏一律返回 {}，不抛错。 */
export function readUserSettings(storeDir: string): UserSettings {
  return normalize(readJsonFile<unknown>(settingsPath(storeDir), {}));
}

/** 深合并写回：已有设置与 patch 逐字段合并，undefined 不覆盖旧值。 */
export function writeUserSettings(storeDir: string, patch: UserSettings): UserSettings {
  const current = readUserSettings(storeDir);
  const next: UserSettings = {};
  const llm: UserLlmSettings = { ...current.llm };
  for (const key of LLM_KEYS) {
    const value = patch.llm?.[key];
    if (value !== undefined) (llm as Record<string, unknown>)[key] = value;
  }
  if (Object.keys(llm).length > 0) next.llm = llm;
  const channels: UserChannelSettings = { ...current.channels };
  for (const key of CHANNEL_KEYS) {
    const value = patch.channels?.[key];
    if (value !== undefined) (channels as Record<string, unknown>)[key] = value;
  }
  if (Object.keys(channels).length > 0) next.channels = channels;
  writeJsonAtomic(settingsPath(storeDir), next);
  return next;
}

/** 按 id 取目录条目：PROVIDER_CATALOG 之外还认历史 siliconflow。 */
export function catalogEntry(id: string): ProviderEntry | undefined {
  const found = findProvider(id);
  if (found !== undefined) return found;
  return id === LEGACY_SILICONFLOW.id ? LEGACY_SILICONFLOW : undefined;
}

/** 供应商 id 是否可接受（写入前校验用）。 */
export function isKnownProvider(id: string): boolean {
  return catalogEntry(id) !== undefined;
}

/**
 * 就地覆盖 cfg：用户设置优先于环境变量。
 *
 * 切换供应商时先按目录条目重设 baseUrl/api/defaultModel 作为新基线，
 * 再让显式的 apiKey/baseUrl/model 覆盖它，避免旧供应商端点残留。
 */
export function applyUserSettings(cfg: RuntimeConfig, settings: UserSettings): void {
  const llm = settings.llm ?? {};

  if (filled(llm.provider)) {
    const entry = catalogEntry(llm.provider.trim());
    cfg.llmProvider = llm.provider.trim();
    if (entry !== undefined) {
      cfg.llm.baseUrl = entry.baseUrl;
      cfg.llm.api = entry.api;
      if (entry.defaultModel !== undefined) cfg.llm.model = entry.defaultModel;
    }
  }
  if (filled(llm.apiKey)) cfg.llm.apiKey = llm.apiKey;
  if (filled(llm.baseUrl)) cfg.llm.baseUrl = llm.baseUrl;
  if (filled(llm.model)) cfg.llm.model = llm.model;
  if (llm.effort !== undefined) cfg.llm.effort = llm.effort;
  if (llm.intentMode !== undefined) cfg.llmIntentMode = llm.intentMode;

  const channels = settings.channels ?? {};
  if (filled(channels.qqBotAppId)) cfg.channelQqBotAppId = channels.qqBotAppId;
  if (filled(channels.qqBotAppSecret)) cfg.channelQqBotAppSecret = channels.qqBotAppSecret;
  if (filled(channels.dingtalkSecret)) cfg.channelDingtalkSecret = channels.dingtalkSecret;
  if (filled(channels.feishuAppId)) cfg.channelFeishuAppId = channels.feishuAppId;
  if (filled(channels.feishuAppSecret)) cfg.channelFeishuAppSecret = channels.feishuAppSecret;
  if (filled(channels.feishuToken)) cfg.channelFeishuToken = channels.feishuToken;
  if (filled(channels.wechatToken)) cfg.channelWechatBotToken = channels.wechatToken;
  if (filled(channels.wechatAccount)) cfg.channelWechatAccountId = channels.wechatAccount;
}

/** 密钥脱敏：空串返回空串；长度 <= 8 全星号；更长保留前 4 与后 4。 */
export function maskSecret(value: string): string {
  if (value === "") return "";
  if (value.length <= 8) return "*".repeat(value.length);
  return value.slice(0, 4) + "*".repeat(value.length - 8) + value.slice(-4);
}
