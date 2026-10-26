import type { LoopExecutor, LoopToolSpec } from "../llm/loop.ts";
import { buildToolSchema } from "../llm/prompts.ts";
import { validateSlotValue } from "./model-intent.ts";
import { TOOL_CONTRACTS } from "./tool-schema.ts";
import { executeTool } from "./tools.ts";
import type { BankState, IntentSlots } from "./types.ts";

/** 资金或规则变更类工具：循环内不执行，交回编排层走确认令牌。 */
const WRITE_TOOLS: ReadonlySet<string> = new Set([
  "transfer",
  "create_aa",
  "schedule_transfer",
  "cancel_subscription",
  "lock_card",
  "report_loss",
  "apply_card",
  "adjust_limit",
  "wealth_purchase",
  "change_password",
  "freeze_account",
  "birthday_lock",
]);

/** 只读工具：循环内可直接执行，结果压缩后回填。 */
export const READONLY_TOOLS: readonly string[] = Object.keys(TOOL_CONTRACTS).filter((name) => !WRITE_TOOLS.has(name));

/** 循环可见的工具声明：只读与写操作都声明，写操作由循环识别后中断。 */
export function buildLoopTools(): LoopToolSpec[] {
  return Object.values(TOOL_CONTRACTS).map((contract) => ({
    name: contract.tool,
    description: contract.summary,
    parameters: buildToolSchema(contract).function.parameters,
    write: WRITE_TOOLS.has(contract.tool),
  }));
}

/** 参数收敛：只保留契约声明的键，类型越界即丢弃，防止模型塞入额外字段。 */
export function sanitizeLoopArgs(tool: string, args: Record<string, unknown>): IntentSlots {
  const contract = TOOL_CONTRACTS[tool];
  if (contract === undefined) return {};
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

/** 只读执行器：查真实状态后调用工具，返回压缩前的摘要文本。 */
export function createReadOnlyExecutor(loadState: () => BankState): LoopExecutor {
  return async (name, args) => {
    if (WRITE_TOOLS.has(name)) {
      return { ok: false, summary: `${name} 属于写操作，循环内不执行。` };
    }
    const contract = TOOL_CONTRACTS[name];
    if (contract === undefined) {
      return { ok: false, summary: `未注册的工具：${name}` };
    }
    const slots = sanitizeLoopArgs(name, args);
    const missing = Object.entries(contract.slots)
      .filter(([slotName, spec]) => spec.required && slots[slotName as keyof IntentSlots] === undefined)
      .map(([slotName]) => slotName);
    if (missing.length > 0) {
      return { ok: false, summary: `缺少参数：${missing.join("、")}` };
    }
    const result = executeTool({ tool: name, slots, state: loadState() });
    return { ok: result.ok, summary: result.ok ? result.message : (result.error ?? "执行失败") };
  };
}
