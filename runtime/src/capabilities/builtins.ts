import { loadConfig, type RuntimeConfig } from "../config.ts";
import type { CapabilityPlugin } from "./types.ts";
import { CapabilityRegistry } from "./registry.ts";
import { createBankAgentPlugin } from "../plugins/bank-agent.ts";
import { createMcpPlugin } from "../plugins/mcp.ts";
import { createSkillPlugin } from "../plugins/skill.ts";

/** 幂等注册全部内置能力。银行插件持有 MCP 插件引用，用于把外部工具并入模型工具集。 */
export function registerBuiltinCapabilities(
  registry: CapabilityRegistry,
  cfg: RuntimeConfig = loadConfig(),
): void {
  const existing = new Set(registry.describe().map((capability) => capability.name));
  const mcp = createMcpPlugin(cfg);
  const plugins: CapabilityPlugin[] = [createBankAgentPlugin(cfg, mcp), mcp, createSkillPlugin(cfg)];
  for (const plugin of plugins) {
    if (existing.has(plugin.name)) continue;
    registry.register(plugin);
    existing.add(plugin.name);
  }
}
