import path from "node:path";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { DEFAULT_GUARD_KEYWORDS } from "./core/output-guard.ts";
import { findProvider, LEGACY_SILICONFLOW } from "./llm/providers.ts";
import type { LlmApi } from "./llm/providers.ts";
import type { Effort, LlmSettings } from "./llm/types.ts";

/** 运行时配置：从环境变量与仓库位置推导，缺省值面向本机开发。 */
export interface RuntimeConfig {
  /** 项目根目录（含 runtime、web、skills、mcp）。 */
  repoRoot: string;
  /** 运行数据目录：银行状态、审计链、确认密钥、MCP 清单。 */
  storeDir: string;
  /** 银行业务技能目录。 */
  skillsDir: string;
  /** 前端构建产物目录。 */
  webDistDir: string;
  /** 预置 MCP 服务器清单。 */
  mcpPresetFile: string;
  /** RPC 与静态托管端口。 */
  rpcPort: number;
  /** 模型配置。缺省从环境变量解析，未配置时系统只用规则解析。 */
  llm: LlmSettings;
  /** 激活的模型供应商 id；空串表示未配置任何供应商。 */
  llmProvider: string;
  /** 意图解析模式：rule 只用规则，hybrid 规则优先模型兜底，model 全部走模型。 */
  llmIntentMode: "rule" | "hybrid" | "model";
  /** 工具声明范围：all 全量声明（缓存最热），scene 按规则粗判场景收窄声明。 */
  llmToolScope: "all" | "scene";
  /** 插件清单扫描目录（外部插件投放点），按序扫描。 */
  pluginDirs: string[];
  /** 插件 patch 分层文件：顶层 YAML 数组，按 id 定向覆盖启用与配置。 */
  patchFile: string;
  /** 关键词防控表：模型输出命中即截断；缺省表叠加 CORDIBANK_GUARD_KEYWORDS 追加项。 */
  guardKeywords: string[];
  /** 内置评估模型守卫开关；CORDIBANK_REVIEWER=off 关闭，默认开启。 */
  reviewerEnabled: boolean;
  injectionClassifierEnabled: boolean;
  /** Web 只读工具开关：CORDIBANK_WEB_SEARCH=off 时不下发 web_search/web_fetch，默认开启。 */
  webToolsEnabled: boolean;
  /** 搜索端点 URL；空串时不注册 web_search。 */
  webSearchUrl: string;
  /** 搜索端点密钥（Bearer），可空。 */
  webSearchKey: string;
  /** OPS 沙箱执行层开关：CORDIBANK_OPS=off 时不下发 ops_run，默认开启。 */
  opsEnabled: boolean;
  /** OPS 沙箱工作目录：子进程 cwd、spill 与审计的落点，默认 repoRoot/.ops-sandbox。 */
  opsDir: string;
}

/** 工具声明范围；非法值回落到全量。 */
export function resolveToolScope(raw?: string): "all" | "scene" {
  const value = raw ?? process.env.LLM_TOOL_SCOPE ?? "all";
  return value === "scene" ? "scene" : "all";
}

/** 解析意图模式；非法值回落到 hybrid。 */
export function resolveIntentMode(raw?: string): "rule" | "hybrid" | "model" {
  const value = raw ?? process.env.LLM_INTENT_MODE ?? "hybrid";
  return value === "rule" || value === "model" ? value : "hybrid";
}

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..");

/** 解析激活的供应商 id：显式 CORDIBANK_LLM_PROVIDER 优先，其次 LLM_API_KEY，再按已有密钥推断。 */
export function resolveProviderId(): string {
  const explicit = process.env.CORDIBANK_LLM_PROVIDER?.trim() ?? "";
  if (explicit !== "") return explicit;
  if ((process.env.LLM_API_KEY ?? "") !== "" || (process.env.DEEPSEEK_API_KEY ?? "") !== "") return "deepseek";
  if ((process.env.SILICONFLOW_API_KEY ?? "") !== "") return LEGACY_SILICONFLOW.id;
  return "";
}

/** 模型供应商缺省值：按激活目录条目取端点与缺省模型，显式 LLM_* 环境变量优先。 */
export function resolveLlm(overrides: Partial<LlmSettings> = {}): LlmSettings {
  const providerId = resolveProviderId();
  const entry = providerId === "" ? undefined : (findProvider(providerId) ?? (providerId === LEGACY_SILICONFLOW.id ? LEGACY_SILICONFLOW : undefined));
  const explicitKey = process.env.LLM_API_KEY ?? "";
  const providerKey = entry === undefined ? "" : (process.env[entry.envVar] ?? "");

  const baseUrl = overrides.baseUrl ?? process.env.LLM_BASE_URL ?? entry?.baseUrl ?? "";
  const apiKey = overrides.apiKey ?? (explicitKey !== "" ? explicitKey : providerKey);
  const model = overrides.model ?? process.env.LLM_MODEL ?? entry?.defaultModel ?? "";
  const api: LlmApi = overrides.api ?? entry?.api ?? "openai-completions";

  return {
    baseUrl,
    apiKey,
    model,
    api,
    timeoutMs: overrides.timeoutMs ?? Number(process.env.LLM_TIMEOUT_MS ?? 20000),
    temperature: overrides.temperature ?? Number(process.env.LLM_TEMPERATURE ?? 0),
    maxTokens: overrides.maxTokens ?? Number(process.env.LLM_MAX_TOKENS ?? 400),
    effort: overrides.effort ?? resolveEffort(),
  };
}

/**
 * 思考强度。
 *
 * 三档与 DeepSeek 的实际参数对齐：off 发 thinking 关闭，low 与 high 发 reasoning_effort。
 * 只写 effort 字段服务端不认，实测 reasoning token 恒为 0。
 */
export function resolveEffort(raw?: string): Effort {
  const value = raw ?? process.env.LLM_EFFORT ?? "low";
  if (value === "off" || value === "high") return value;
  return "low";
}

function envPort(): number {
  const raw = process.env.RUNTIME_PORT ?? process.env.CORDIBANK_PORT ?? "";
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 8123;
}

/** 读取配置；传入 overrides 时按字段覆盖，供测试与 CLI 使用。 */
export function loadConfig(overrides: Partial<RuntimeConfig> = {}): RuntimeConfig {
  const storeDir =
    overrides.storeDir ??
    process.env.CORDIBANK_STORE_DIR ??
    process.env.SWARM_STORE_DIR ??
    path.join(repoRoot, "runtime", "store");

  return {
    repoRoot: overrides.repoRoot ?? repoRoot,
    storeDir,
    skillsDir: overrides.skillsDir ?? process.env.CORDIBANK_SKILLS_DIR ?? path.join(repoRoot, "skills"),
    webDistDir: overrides.webDistDir ?? path.join(repoRoot, "web", "dist"),
    mcpPresetFile: overrides.mcpPresetFile ?? path.join(repoRoot, "mcp", "servers.json"),
    rpcPort: overrides.rpcPort ?? envPort(),
    llm: overrides.llm ?? resolveLlm(),
    llmProvider: overrides.llmProvider ?? resolveProviderId(),
    llmIntentMode: overrides.llmIntentMode ?? resolveIntentMode(),
    llmToolScope: overrides.llmToolScope ?? resolveToolScope(),
    pluginDirs: overrides.pluginDirs ?? resolvePluginDirs(),
    patchFile: overrides.patchFile ?? process.env.CORDIBANK_PATCH_FILE ?? path.join(repoRoot, "cordibank.patch.yml"),
    guardKeywords: overrides.guardKeywords ?? resolveGuardKeywords(),
    reviewerEnabled: overrides.reviewerEnabled ?? process.env.CORDIBANK_REVIEWER !== "off",
      injectionClassifierEnabled: overrides.injectionClassifierEnabled ?? process.env.CORDIBANK_INJECTION_CLASSIFIER !== "off",
    webToolsEnabled: overrides.webToolsEnabled ?? process.env.CORDIBANK_WEB_SEARCH !== "off",
    webSearchUrl: overrides.webSearchUrl ?? process.env.CORDIBANK_WEB_SEARCH_URL?.trim() ?? "",
    webSearchKey: overrides.webSearchKey ?? process.env.CORDIBANK_WEB_SEARCH_KEY?.trim() ?? "",
    opsEnabled: overrides.opsEnabled ?? process.env.CORDIBANK_OPS !== "off",
    opsDir: overrides.opsDir ?? process.env.CORDIBANK_OPS_DIR?.trim() ?? path.join(repoRoot, ".ops-sandbox"),
  };
}

/** 关键词防控表：默认表为底，CORDIBANK_GUARD_KEYWORDS 逗号分隔追加自定义项。 */
function resolveGuardKeywords(): string[] {
  const raw = process.env.CORDIBANK_GUARD_KEYWORDS?.trim() ?? "";
  const extra = raw === "" ? [] : raw.split(",").map((item) => item.trim()).filter((item) => item !== "");
  return [...DEFAULT_GUARD_KEYWORDS, ...extra];
}

/** 插件目录：默认 runtime/plugins，CORDIBANK_PLUGIN_DIRS 逗号分隔可覆盖。 */
function resolvePluginDirs(): string[] {
  const raw = process.env.CORDIBANK_PLUGIN_DIRS?.trim() ?? "";
  if (raw === "") return [path.join(repoRoot, "runtime", "plugins")];
  return raw
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item !== "");
}

/** 前端构建产物是否就位；未构建时不阻塞接口，只停用静态托管。 */
export function hasWebBuild(cfg: RuntimeConfig): boolean {
  return existsSync(path.join(cfg.webDistDir, "index.html"));
}

export const defaultConfig = loadConfig();

export default loadConfig;
