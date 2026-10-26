/** Harness 契约：统一描述一个可被模型调用的工具，不关心它来自内置代码还是外部服务。 */

export type RiskLevel = "green" | "yellow" | "red";

export type ToolSource = "builtin" | "mcp";

/** 工具风险画像：由来源决定，内置来自策略表，外部来自服务清单声明。 */
export interface ToolRisk {
  level: RiskLevel;
  reversible: boolean;
  /** 是否改动资金、额度或账户状态。写操作在 Agent 循环内不执行。 */
  write: boolean;
}

export interface ToolDescriptor {
  /** 全局唯一名。外部工具带 mcp__ 前缀，避免与内置冲突。 */
  name: string;
  summary: string;
  source: ToolSource;
  /** 归属场景，用于按场景收窄声明。外部工具由服务清单指定。 */
  scene: string;
  risk: ToolRisk;
  /** JSON Schema，直接进请求体的 tools 声明。 */
  parameters: Record<string, unknown>;
  /** 外部工具所属服务器。 */
  serverId?: string;
  /** 外部工具的原始名，调用时用它而不是全局名。 */
  remoteName?: string;
}

/** 外部工具调用器：由插件注入，把参数转给 MCP 服务器。 */
export type ExternalInvoker = (
  serverId: string,
  remoteName: string,
  args: Record<string, unknown>,
) => Promise<{ ok: boolean; message: string; data?: unknown }>;
