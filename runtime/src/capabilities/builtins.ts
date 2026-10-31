import { loadConfig, type RuntimeConfig } from "../config.ts";
import type { KernelContext } from "../kernel.ts";
import type { CapabilityPlugin } from "./types.ts";
import type { CapabilityRegistry } from "./registry.ts";
import { createBankAgentPlugin } from "../plugins/bank-agent.ts";
import { createJobsPlugin } from "../plugins/jobs.ts";
import { createSchedulerPlugin } from "../plugins/scheduler.ts";
import { createLlmRegistryPlugin } from "../plugins/llm-registry.ts";
import { createMcpPlugin } from "../plugins/mcp.ts";
import { createSkillPlugin } from "../plugins/skill.ts";
import { createChannelsPlugin } from "../plugins/channels.ts";
import { createSwarmTeamPlugin } from "../plugins/swarm-team.ts";
import {
  assembleCapabilities,
  discoverPlugins,
  readPatch,
  type AssembleResult,
  type BundledPlugin,
} from "./loader.ts";

/**
 * 内置插件清单（学 DeepSeek Harness 预装插件：清单内联，装配语义与外部插件一致）。
 * bank-agent 依赖 mcp（外部工具并入模型工具集），由装配器按 inject 声明解析，
 * 不再手工传递实例。
 */
export const BUNDLED_PLUGINS: BundledPlugin[] = [
  {
    manifest: {
      id: "mcp",
      name: "外部工具",
      version: "1.0.0",
      description: "把外部 MCP 服务器的工具接进运行时，支持 stdio 与 http 传输。",
    },
    create: (cfg) => createMcpPlugin(cfg),
  },
  {
    manifest: {
      id: "skill",
      name: "技能库",
      version: "1.0.0",
      description: "银行业务技能的增删查与语义匹配，供模型按需取用。",
    },
    create: (cfg) => createSkillPlugin(cfg),
  },
  {
    manifest: {
      id: "jobs",
      name: "作业中心",
      version: "1.0.0",
      description: "后台长任务：job id、状态与输出分页拉取、协作式取消。",
    },
    create: (cfg) => createJobsPlugin(cfg),
  },
  {
    manifest: {
      id: "scheduler",
      name: "定时任务",
      version: "1.0.0",
      description: "持久化 interval/daily 计划，到点驱动银行 Agent 提示并落作业中心。",
      inject: ["bank-agent", "jobs"],
    },
    create: (cfg, deps) => createSchedulerPlugin(cfg, deps),
  },
  {
    manifest: {
      id: "bank-agent",
      name: "银行助手",
      version: "1.0.0",
      description: "意图解析、策略链与蜂群协同的银行编排入口。",
      inject: ["mcp"],
    },
    create: (cfg, deps) => createBankAgentPlugin(cfg, deps.get("mcp")),
  },
  {
    manifest: {
      id: "llm-registry",
      name: "模型注册表",
      version: "1.0.0",
      description: "模型供应商目录与激活状态，目录对齐 DeepSeek Harness 内置清单。",
    },
    create: (cfg) => createLlmRegistryPlugin(cfg),
  },
  {
    manifest: {
      id: "channels",
      name: "渠道接入",
      version: "1.0.0",
      description: "IM 渠道接入中心：QQ（OneBot v11 上报）与微信 webhook 桥，回复由银行 Agent 会话生成。",
      inject: ["bank-agent"],
    },
    create: (cfg, deps) => createChannelsPlugin(cfg, deps),
  },
  {
    manifest: {
      id: "swarm-team",
      name: "蜂群编队",
      version: "1.0.0",
      description: "成员花名册、信箱、任务板与目标管理，队友只挂只读工具（写域隔离）。",
    },
    create: (cfg) => createSwarmTeamPlugin(cfg),
  },
];

/**
 * 经装配器装载内置与外部插件：patch 分层覆盖配置与启用，inject 决定依赖序。
 * 旧调用（只传 registry 与 cfg）保持兼容：无 patch 文件、无插件目录时按清单默认装配。
 */
export async function registerBuiltinCapabilities(
  registry: CapabilityRegistry,
  cfg: RuntimeConfig = loadConfig(),
  opts: { ctx?: KernelContext; patchFile?: string; pluginDirs?: string[] } = {},
): Promise<AssembleResult> {
  const external = discoverPlugins(opts.pluginDirs ?? cfg.pluginDirs);
  const patch = readPatch(opts.patchFile ?? cfg.patchFile);
  return assembleCapabilities(registry, opts.ctx, {
    bundled: BUNDLED_PLUGINS,
    external,
    patch,
    cfg,
    idempotent: true,
  });
}
