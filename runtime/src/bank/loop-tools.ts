import { parseMcpToolName } from "../harness/registry.ts";
import type { ExternalInvoker, ToolDescriptor } from "../harness/types.ts";
import type { LoopExecutor, LoopToolSpec } from "../llm/loop.ts";
import { builtinToolDescriptors } from "./builtin-tools.ts";
import { validateSlotValue } from "./model-intent.ts";
import { TOOL_CONTRACTS } from "./tool-schema.ts";
import { executeTool } from "./tools.ts";
import type { BankState, IntentSlots } from "./types.ts";

const EMPTY_PARAMS: Record<string, unknown> = {
  type: "object",
  properties: {},
  required: [],
  additionalProperties: true,
};

/** 描述符转循环声明：写操作只留名字与空参数，参数等确认后重新解析。 */
export function toLoopSpec(descriptor: ToolDescriptor): LoopToolSpec {
  return {
    name: descriptor.name,
    description: descriptor.risk.write ? `${descriptor.summary}（写操作，需用户确认，调用即中断本轮）` : descriptor.summary,
    parameters: descriptor.risk.write ? EMPTY_PARAMS : descriptor.parameters,
    write: descriptor.risk.write,
  };
}

export function buildLoopTools(descriptors: ToolDescriptor[] = builtinToolDescriptors()): LoopToolSpec[] {
  return descriptors.map(toLoopSpec);
}

/** 只读工具名清单，供测试与界面展示。 */
export function readonlyToolNames(descriptors: ToolDescriptor[] = builtinToolDescriptors()): string[] {
  return descriptors.filter((descriptor) => !descriptor.risk.write).map((descriptor) => descriptor.name);
}

/** 参数收敛：内置工具按契约裁剪，外部工具交给服务端 schema 校验。 */
export function sanitizeLoopArgs(tool: string, args: Record<string, unknown>): IntentSlots {
  const contract = TOOL_CONTRACTS[tool];
  if (contract === undefined) return args as IntentSlots;
  const slots: IntentSlots = {};
  for (const [name, raw] of Object.entries(args)) {
    const spec = contract.slots[name as keyof IntentSlots];
    if (spec === undefined) continue;
    const checked = validateSlotValue(spec, raw);
    if (checked.dropped) continue;
    slots[name as keyof IntentSlots] = checked.value as never;
  }
  return slots;
}

/** 循环执行器：内置工具查本地状态执行，外部工具转给 MCP，额外工具走注入的执行器。 */
export function createLoopExecutor(
  loadState: () => BankState,
  invoker?: ExternalInvoker,
  extras: Record<string, (args: Record<string, unknown>) => Promise<{ ok: boolean; summary: string }>> = {},
): LoopExecutor {
  return async (name, args) => {
    const extra = extras[name];
    if (extra !== undefined) return await extra(args);
    const external = parseMcpToolName(name);
    if (external !== null) {
      if (invoker === undefined) return { ok: false, summary: `外部工具不可用：${name}` };
      const result = await invoker(external.serverId, external.remoteName, args);
      return { ok: result.ok, summary: result.message };
    }
    const contract = TOOL_CONTRACTS[name];
    if (contract === undefined) return { ok: false, summary: `未注册的工具：${name}` };
    const slots = sanitizeLoopArgs(name, args);
    const missing = Object.entries(contract.slots)
      .filter(([slotName, spec]) => spec.required && slots[slotName as keyof IntentSlots] === undefined)
      .map(([slotName]) => slotName);
    if (missing.length > 0) return { ok: false, summary: `缺少参数：${missing.join("、")}` };
    const result = executeTool({ tool: name, slots, state: loadState() });
    return { ok: result.ok, summary: result.ok ? result.message : (result.error ?? "执行失败") };
  };
}
