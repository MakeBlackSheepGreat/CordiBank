import { loadConfig, type RuntimeConfig } from "../config.ts";
import type { CapabilityPlugin } from "./types.ts";
import { CapabilityRegistry } from "./registry.ts";
import { createBankAgentPlugin } from "../plugins/bank-agent.ts";
import { createMcpPlugin } from "../plugins/mcp.ts";
import { createSkillPlugin } from "../plugins/skill.ts";

export type CapabilityFactory = (cfg: RuntimeConfig) => CapabilityPlugin;

/** 内置能力登记表：银行智能体、MCP 客户端、技能库。 */
export const BUILTIN_CAPABILITY_FACTORIES: readonly CapabilityFactory[] = [
  (cfg) => createBankAgentPlugin(cfg),
  (cfg) => createMcpPlugin(cfg),
  (cfg) => createSkillPlugin(cfg),
];

/** 幂等注册全部内置能力。 */
export function registerBuiltinCapabilities(
  registry: CapabilityRegistry,
  cfg: RuntimeConfig = loadConfig(),
): void {
  const existing = new Set(registry.describe().map((capability) => capability.name));
  for (const factory of BUILTIN_CAPABILITY_FACTORIES) {
    const plugin = factory(cfg);
    if (existing.has(plugin.name)) continue;
    registry.register(plugin);
    existing.add(plugin.name);
  }
}
