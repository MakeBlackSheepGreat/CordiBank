import { mcpToolName } from "../harness/registry.ts";
import type { RiskLevel, ToolDescriptor } from "../harness/types.ts";
import { registerToolSpec, unregisterToolSpec } from "../bank/policy.ts";
import type { McpTool } from "./mcp.ts";

/** 服务清单里的风险声明：默认只读，写操作可整体或按工具标注。 */
export interface McpRiskDecl {
  risk?: "read" | "write";
  scene?: string;
  irreversible?: boolean;
  /** 工具级覆盖：同一服务里读工具与写工具混排时使用。 */
  tools?: Record<string, "read" | "write">;
}

const DEFAULT_SCENE = "transfer";

/** 工具级风险优先，其次服务级，最后默认只读。 */
function levelOf(decl: McpRiskDecl, toolName: string): RiskLevel {
  if (decl.irreversible === true) return "red";
  const risk = decl.tools?.[toolName] ?? decl.risk ?? "read";
  return risk === "write" ? "yellow" : "green";
}

/**
 * 把 MCP 工具转成统一描述符，同时注入策略表。
 * 外部工具的输入 schema 由服务端给出，此处只做透传与兜底。
 */
export function mcpToolDescriptors(
  serverId: string,
  tools: McpTool[],
  decl: McpRiskDecl = {},
): ToolDescriptor[] {
  const scene = decl.scene ?? DEFAULT_SCENE;
  return tools.map((tool) => {
    const name = mcpToolName(serverId, tool.name);
    const level = levelOf(decl, tool.name);
    const write = level !== "green";
    const schema =
      tool.inputSchema !== null && typeof tool.inputSchema === "object" && !Array.isArray(tool.inputSchema)
        ? (tool.inputSchema as Record<string, unknown>)
        : { type: "object", properties: {}, required: [], additionalProperties: false };
    registerToolSpec({
      tool: name,
      scene: scene as never,
      label: `${serverId} / ${tool.name}`,
      baseLevel: level,
      reversible: decl.irreversible !== true,
      description: tool.description === "" ? `${serverId} 提供的 ${tool.name}` : tool.description,
    });
    return {
      name,
      summary: tool.description === "" ? `${serverId} 提供的 ${tool.name}` : tool.description,
      source: "mcp" as const,
      scene,
      risk: { level, reversible: decl.irreversible !== true, write },
      parameters: schema,
      serverId,
      remoteName: tool.name,
    };
  });
}

/** 卸载服务器的工具登记，避免策略表里留下悬空条目。 */
export function unregisterMcpTools(serverId: string, tools: McpTool[]): void {
  for (const tool of tools) unregisterToolSpec(mcpToolName(serverId, tool.name));
}

/** 把 MCP 返回的 content 块压成一行文本，供模型回填。 */
export function flattenMcpResult(result: unknown[]): string {
  return result
    .map((block) => {
      if (block !== null && typeof block === "object" && "text" in block) {
        const text = (block as { text?: unknown }).text;
        return typeof text === "string" ? text : "";
      }
      return JSON.stringify(block);
    })
    .filter((text) => text !== "")
    .join("\n");
}
