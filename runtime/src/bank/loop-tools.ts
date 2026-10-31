import { parseMcpToolName } from "../harness/registry.ts";
import type { ExternalInvoker, ToolDescriptor } from "../harness/types.ts";
import type { LoopExecutor, LoopToolSpec } from "../llm/loop.ts";
import { builtinToolDescriptors } from "./builtin-tools.ts";
import { validateSlotValue } from "./model-intent.ts";
import { TOOL_CONTRACTS } from "./tool-schema.ts";
import { executeTool } from "./tools.ts";
import type { BillReport } from "./tools.ts";
import { yuan } from "./data.ts";
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

/** 账单回包摊平：headline 只有总量，分类占比与异常明细要显式列出，模型才答得出细节。 */
function renderBillDigest(data: unknown): string {
  if (data === null || typeof data !== "object") return "";
  const report = data as BillReport;
  if (!Array.isArray(report.categories) || report.categories.length === 0) return "";
  const lines: string[] = [];
  const categories = report.categories
    .slice(0, 5)
    .map((item) => `${item.category} ${yuan(item.totalCents)} 元 / ${item.count} 笔 / 占比 ${(item.share * 100).toFixed(1)}%`);
  lines.push(`分类占比：${categories.join("；")}`);
  const anomalies = Array.isArray(report.anomalies) ? report.anomalies : [];
  lines.push(anomalies.length === 0
    ? "异常交易：无"
    : `异常交易 ${anomalies.length} 条：${anomalies
        .slice(0, 4)
        .map((item) => `${item.ts.slice(0, 10)} ${item.merchant} ${yuan(item.amountCents)} 元（${item.reason}）`)
        .join("；")}`);
  const merchants = Array.isArray(report.topMerchants) ? report.topMerchants.slice(0, 3) : [];
  if (merchants.length > 0) {
    lines.push(`商户前三：${merchants.map((item) => `${item.merchant} ${yuan(item.totalCents)} 元 / ${item.count} 笔`).join("；")}`);
  }
  lines.push(`订阅扣费合计 ${yuan(report.subscriptionCharge)} 元`);
  return lines.join("\n");
}

/** 订阅回包摊平：headline 只有总数，逐项名称与金额要列出来，模型才答得出细节。 */
function renderSubscriptionDigest(data: unknown): string {
  if (data === null || typeof data !== "object") return "";
  const items = (data as { items?: unknown }).items;
  if (!Array.isArray(items) || items.length === 0) return "";
  return `订阅明细：${items
    .map((raw) => {
      const item = raw as { name?: unknown; amountCents?: unknown; cycle?: unknown; nextChargeAt?: unknown; cancelable?: unknown };
      const name = typeof item.name === "string" ? item.name : "";
      if (name === "") return "";
      const amount = typeof item.amountCents === "number" ? `${yuan(item.amountCents)} 元` : "";
      const cycle = item.cycle === "yearly" ? "按年" : "按月";
      const next = typeof item.nextChargeAt === "string" ? `下次 ${item.nextChargeAt.slice(0, 10)}` : "";
      const cancelable = item.cancelable === false ? "不可自助取消" : "可自助取消";
      return [name, amount, cycle, next, cancelable].filter((part) => part !== "").join(" ");
    })
    .filter((line) => line !== "")
    .join("；")}`;
}

/** 工具回包转循环内摘要：成功时把结构化字段摊平，失败时只回错误原因。 */
function renderToolSummary(name: string, result: { ok: boolean; message: string; error?: string; data?: unknown }): string {
  if (!result.ok) return result.error ?? "执行失败";
  if (name === "analyze_bills") {
    const digest = renderBillDigest(result.data);
    return digest === "" ? result.message : `${result.message}\n${digest}`;
  }
  if (name === "list_subscriptions" || name === "subscription_reminder") {
    const digest = renderSubscriptionDigest(result.data);
    return digest === "" ? result.message : `${result.message}\n${digest}`;
  }
  return result.message;
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
    return { ok: result.ok, summary: renderToolSummary(name, result) };
  };
}
