import { RuntimeError } from "../core/errors.ts";
import type { ToolDescriptor, ToolSource } from "./types.ts";

/**
 * 工具注册表：内置与外部工具共用一张表。
 * 名称冲突直接报错，不做静默覆盖，避免同名工具互相顶掉。
 */
export class ToolRegistry {
  private readonly tools = new Map<string, ToolDescriptor>();

  /** 登记单个工具；同名且不同来源时报错。 */
  register(descriptor: ToolDescriptor): void {
    const existing = this.tools.get(descriptor.name);
    if (existing !== undefined) {
      throw new RuntimeError("INVALID_INPUT", `工具名冲突：${descriptor.name}，已有来源 ${existing.source}`);
    }
    this.tools.set(descriptor.name, descriptor);
  }

  registerMany(list: ToolDescriptor[]): void {
    for (const descriptor of list) this.register(descriptor);
  }

  /** 移除某个来源的全部工具，用于外部服务重连或下线。 */
  removeBySource(source: ToolSource): void {
    for (const [name, descriptor] of this.tools) {
      if (descriptor.source === source) this.tools.delete(name);
    }
  }

  /** 移除单个服务器的全部工具。 */
  removeByServer(serverId: string): void {
    for (const [name, descriptor] of this.tools) {
      if (descriptor.serverId === serverId) this.tools.delete(name);
    }
  }

  get(name: string): ToolDescriptor | undefined {
    return this.tools.get(name);
  }

  list(): ToolDescriptor[] {
    return [...this.tools.values()];
  }

  byScene(scene: string): ToolDescriptor[] {
    return this.list().filter((descriptor) => descriptor.scene === scene);
  }

  /** 只读工具：循环里可直接执行。 */
  readonlyTools(): ToolDescriptor[] {
    return this.list().filter((descriptor) => !descriptor.risk.write);
  }

  get size(): number {
    return this.tools.size;
  }
}

/** 外部工具名：带服务器前缀，便于路由回原服务。 */
export function mcpToolName(serverId: string, toolName: string): string {
  return `mcp__${serverId}__${toolName}`;
}

/** 从全局名解析服务器与原始名；非外部工具返回 null。 */
export function parseMcpToolName(name: string): { serverId: string; remoteName: string } | null {
  if (!name.startsWith("mcp__")) return null;
  const rest = name.slice("mcp__".length);
  const index = rest.indexOf("__");
  if (index <= 0) return null;
  return { serverId: rest.slice(0, index), remoteName: rest.slice(index + 2) };
}
