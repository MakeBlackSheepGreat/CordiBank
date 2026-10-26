import path from "node:path";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
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
  /** 意图解析模式：rule 只用规则，hybrid 规则优先模型兜底，model 全部走模型。 */
  llmIntentMode: "rule" | "hybrid" | "model";
  /** 工具声明范围：all 全量声明（缓存最热），scene 按规则粗判场景收窄声明。 */
  llmToolScope: "all" | "scene";
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

/** 模型供应商缺省值：显式 LLM_* 优先，其次按已有密钥推断。 */
export function resolveLlm(overrides: Partial<LlmSettings> = {}): LlmSettings {
  const explicitKey = process.env.LLM_API_KEY ?? "";
  const deepseekKey = process.env.DEEPSEEK_API_KEY ?? "";
  const siliconKey = process.env.SILICONFLOW_API_KEY ?? "";

  const baseUrl =
    overrides.baseUrl ??
    process.env.LLM_BASE_URL ??
    (explicitKey !== ""
      ? "https://api.deepseek.com/v1"
      : deepseekKey !== ""
        ? "https://api.deepseek.com/v1"
        : siliconKey !== ""
          ? "https://api.siliconflow.cn/v1"
          : "");
  const apiKey = overrides.apiKey ?? (explicitKey !== "" ? explicitKey : deepseekKey !== "" ? deepseekKey : siliconKey);
  const model =
    overrides.model ??
    process.env.LLM_MODEL ??
    (deepseekKey !== "" || explicitKey !== "" ? "deepseek-chat" : siliconKey !== "" ? "Qwen/Qwen2.5-7B-Instruct" : "");

  return {
    baseUrl,
    apiKey,
    model,
    timeoutMs: overrides.timeoutMs ?? Number(process.env.LLM_TIMEOUT_MS ?? 20000),
    temperature: overrides.temperature ?? Number(process.env.LLM_TEMPERATURE ?? 0),
    maxTokens: overrides.maxTokens ?? Number(process.env.LLM_MAX_TOKENS ?? 400),
    effort: overrides.effort ?? resolveEffort(),
    thinking: overrides.thinking ?? (process.env.LLM_THINKING ?? "on") !== "off",
  };
}

/** 推理强度：抽槽用 low 省推理 token，多步对话可调到 high。 */
function resolveEffort(): Effort {
  const raw = process.env.LLM_EFFORT ?? "low";
  return raw === "high" || raw === "max" ? raw : "low";
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
    llmIntentMode: overrides.llmIntentMode ?? resolveIntentMode(),
    llmToolScope: overrides.llmToolScope ?? resolveToolScope(),
  };
}

/** 前端构建产物是否就位；未构建时不阻塞接口，只停用静态托管。 */
export function hasWebBuild(cfg: RuntimeConfig): boolean {
  return existsSync(path.join(cfg.webDistDir, "index.html"));
}

export const defaultConfig = loadConfig();

export default loadConfig;
