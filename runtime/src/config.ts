import path from "node:path";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

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
}

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..");

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
  };
}

/** 前端构建产物是否就位；未构建时不阻塞接口，只停用静态托管。 */
export function hasWebBuild(cfg: RuntimeConfig): boolean {
  return existsSync(path.join(cfg.webDistDir, "index.html"));
}

export const defaultConfig = loadConfig();

export default loadConfig;
