import { checkPayeeOrigin } from "./guard.ts";
import { evaluate, specOf } from "./policy.ts";
import type { BankPolicy, BankState, IntentSlots, PolicyDecision, PolicyHit, RiskLevel } from "./types.ts";

/** 蜂群角色：每个角色只做一件事，结论汇到仲裁者。 */
export type SwarmRole = "intent" | "risk" | "compliance" | "experience" | "arbiter" | "executor" | "auditor";

/** 一次协同的一步，写入回复与审计，用于复盘「为什么这样判」。 */
export interface SwarmStep {
  role: SwarmRole;
  label: string;
  input: string;
  output: string;
  level: RiskLevel | "none";
  elapsedMs: number;
  ok: boolean;
}

/** 协同轨迹：答辩时指着一行行讲分工。 */
export interface SwarmTrace {
  steps: SwarmStep[];
  /** 并行分支数，当前为三个评估器。 */
  parallel: number;
  totalMs: number;
}

export interface AssessInput {
  state: BankState;
  policy: BankPolicy;
  tool: string;
  slots: IntentSlots;
  text: string;
}

/** 评估结论：三个评估器统一用这个结构，便于仲裁合并。 */
export interface AssessResult {
  role: SwarmRole;
  label: string;
  level: RiskLevel | "none";
  blocked: boolean;
  requiresConfirm: boolean;
  hits: PolicyHit[];
  note: string;
}

function now(): number {
  return Date.now();
}

/** 风控评估：走策略引擎，四维度叠加。 */
export function assessRisk(input: AssessInput): AssessResult {
  const decision: PolicyDecision = evaluate({ tool: input.tool, params: input.slots as Record<string, unknown>, state: input.state });
  return {
    role: "risk",
    label: "风控评估",
    level: decision.level,
    blocked: decision.blocked,
    requiresConfirm: decision.requiresConfirm,
    hits: decision.hits.map((hit) => ({ rule: hit.rule, detail: hit.detail, delta: hit.delta })),
    note: decision.summary,
  };
}

/** 合规评估：只查「这次请求的来源是否可信」，不复算风险等级。 */
export function assessCompliance(input: AssessInput): AssessResult {
  const hits: PolicyHit[] = [];
  const payee = typeof input.slots.payee === "string" ? input.slots.payee : "";
  if (input.tool === "transfer" && payee !== "") {
    const origin = checkPayeeOrigin(payee, input.text, input.state);
    if (!origin.trusted) {
      hits.push({ rule: "payee-origin", detail: origin.reason, delta: "block" });
    }
  }
  const spec = specOf(input.tool);
  if (spec === undefined) {
    hits.push({ rule: "tool-whitelist", detail: `工具 ${input.tool} 不在白名单`, delta: "block" });
  }
  return {
    role: "compliance",
    label: "合规评估",
    level: hits.length === 0 ? "green" : "red",
    blocked: hits.length > 0,
    requiresConfirm: false,
    hits,
    note: hits.length === 0 ? "来源可信，工具在白名单" : hits.map((hit) => hit.detail).join("；"),
  };
}

/** 体验评估：只产「还缺什么、该怎么说」，不改判定。 */
export function assessExperience(input: AssessInput): AssessResult {
  const spec = specOf(input.tool);
  const notes: string[] = [];
  if (spec !== undefined && spec.reversible === false && spec.baseLevel === "red") {
    notes.push("该操作不可撤销，需给用户替代路径");
  }
  const amount = typeof input.slots.amountCents === "number" ? input.slots.amountCents : 0;
  if (input.tool === "transfer" && amount === 0) {
    notes.push("缺少金额，先追问再执行");
  }
  return {
    role: "experience",
    label: "体验评估",
    level: "none",
    blocked: false,
    requiresConfirm: false,
    hits: [],
    note: notes.length === 0 ? "无需补充说明" : notes.join("；"),
  };
}

/** 仲裁：任一评估判红即红，理由合并；否则取风控等级。 */
export function arbitrate(results: AssessResult[]): {
  level: RiskLevel;
  blocked: boolean;
  requiresConfirm: boolean;
  hits: PolicyHit[];
  summary: string;
} {
  const hits = results.flatMap((item) => item.hits);
  const blocked = results.some((item) => item.blocked);
  const risk = results.find((item) => item.role === "risk");
  const riskLevel = risk?.level;
  const level: RiskLevel = blocked ? "red" : riskLevel === undefined || riskLevel === "none" ? "green" : riskLevel;
  const requiresConfirm = !blocked && results.some((item) => item.requiresConfirm);
  const labels = results.filter((item) => item.note !== "").map((item) => `${item.label}：${item.note}`);
  return {
    level,
    blocked,
    requiresConfirm,
    hits,
    summary: labels.length === 0 ? `判定为 ${level}` : labels.join("｜"),
  };
}

/** 三个评估器并行：任一失败不影响其余，失败按「该维度无结论」处理。 */
export async function runAssessors(input: AssessInput): Promise<{ results: AssessResult[]; steps: SwarmStep[] }> {
  const tasks: Array<{ role: SwarmRole; label: string; run: () => AssessResult }> = [
    { role: "risk", label: "风控评估", run: () => assessRisk(input) },
    { role: "compliance", label: "合规评估", run: () => assessCompliance(input) },
    { role: "experience", label: "体验评估", run: () => assessExperience(input) },
  ];

  const results = await Promise.all(
    tasks.map(async (task) => {
      const started = now();
      try {
        const value = await Promise.resolve().then(task.run);
        return { value, elapsed: now() - started, ok: true, label: task.label };
      } catch (error) {
        return {
          value: {
            role: task.role,
            label: task.label,
            level: "green" as RiskLevel,
            blocked: false,
            requiresConfirm: false,
            hits: [],
            note: `评估失败：${error instanceof Error ? error.message : String(error)}`,
          },
          elapsed: now() - started,
          ok: false,
          label: task.label,
        };
      }
    }),
  );

  const steps: SwarmStep[] = results.map((item) => ({
    role: item.value.role,
    label: item.label,
    input: `${input.tool} ${JSON.stringify(input.slots).slice(0, 60)}`,
    output: item.value.note === "" ? "无结论" : item.value.note.slice(0, 80),
    level: item.value.level,
    elapsedMs: item.elapsed,
    ok: item.ok,
  }));

  return { results: results.map((item) => item.value), steps };
}

/** 组装轨迹：把串行步骤与并行步骤拼成一条时间线。 */
export function makeTrace(steps: SwarmStep[], startedAt: number): SwarmTrace {
  return { steps, parallel: 3, totalMs: now() - startedAt };
}
