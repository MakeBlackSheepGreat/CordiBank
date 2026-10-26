import { yuan } from "./data.ts";
import type { BankPolicy, BankState, Cents, PolicyDecision, PolicyHit, RiskLevel, SceneId } from "./types.ts";

export interface ToolSpec {
  tool: string;
  scene: SceneId;
  label: string;
  baseLevel: RiskLevel;
  reversible: boolean;
  description: string;
}

/** 工具白名单与基础等级：未登记的工具一律按红处理。 */
export const TOOL_SPECS: ReadonlyArray<ToolSpec> = [
  { tool: "query_balance", scene: "bills", label: "查询余额", baseLevel: "green", reversible: true, description: "只读查询账户余额与可用额度" },
  { tool: "analyze_bills", scene: "bills", label: "账单分析", baseLevel: "green", reversible: true, description: "按类别统计、异常识别与报告生成" },
  { tool: "transfer", scene: "transfer", label: "转账", baseLevel: "yellow", reversible: false, description: "向指定收款人转账" },
  { tool: "create_aa", scene: "transfer", label: "发起 AA 收款", baseLevel: "yellow", reversible: true, description: "按人头拆分金额并发起收款" },
  { tool: "schedule_transfer", scene: "transfer", label: "定时转账", baseLevel: "yellow", reversible: true, description: "在指定日期执行转账" },
  { tool: "list_subscriptions", scene: "subscription", label: "查询订阅", baseLevel: "green", reversible: true, description: "列出代扣订阅与下次扣费时间" },
  { tool: "cancel_subscription", scene: "subscription", label: "取消订阅", baseLevel: "yellow", reversible: true, description: "关闭自动续费" },
  { tool: "list_cards", scene: "card", label: "查询卡片", baseLevel: "green", reversible: true, description: "列出卡片状态与额度" },
  { tool: "lock_card", scene: "card", label: "锁定卡片", baseLevel: "yellow", reversible: true, description: "临时锁定交易，可解锁" },
  { tool: "report_loss", scene: "card", label: "卡片挂失", baseLevel: "red", reversible: false, description: "挂失后需换卡，不可撤销" },
  { tool: "apply_card", scene: "card", label: "申请卡片", baseLevel: "yellow", reversible: true, description: "提交新卡申请" },
  { tool: "adjust_limit", scene: "card", label: "调整额度", baseLevel: "red", reversible: false, description: "修改卡片额度或交易限额" },
  { tool: "change_password", scene: "card", label: "修改密码", baseLevel: "red", reversible: false, description: "修改登录或支付密码" },
  { tool: "freeze_account", scene: "card", label: "冻结账户", baseLevel: "red", reversible: false, description: "冻结账户全部交易" },
  { tool: "wealth_list", scene: "wealth", label: "理财产品查询", baseLevel: "green", reversible: true, description: "按风险等级列出产品对比" },
  { tool: "wealth_risk", scene: "wealth", label: "风险测评", baseLevel: "green", reversible: true, description: "根据问答给出风险承受等级" },
  { tool: "wealth_purchase", scene: "wealth", label: "申购理财", baseLevel: "red", reversible: false, description: "资金申购，需强验证" },
  { tool: "birthday_lock", scene: "cross", label: "生日资金预锁", baseLevel: "yellow", reversible: true, description: "锁定资金并在到期前预订服务" },
];

const SPEC_BY_TOOL = new Map(TOOL_SPECS.map((spec) => [spec.tool, spec]));

export function specOf(tool: string): ToolSpec | undefined {
  return SPEC_BY_TOOL.get(tool);
}

function levelRank(level: RiskLevel): number {
  return level === "green" ? 0 : level === "yellow" ? 1 : 2;
}

function maxLevel(a: RiskLevel, b: RiskLevel): RiskLevel {
  return levelRank(a) >= levelRank(b) ? a : b;
}

/** 首次收款人：通讯录未标记常用，且历史转账里没有成功记录。 */
export function isNewPayee(payee: string, state: BankState): boolean {
  const contact = state.contacts.find((item) => item.name === payee || item.remark === payee);
  const known = state.transfers.some((item) => item.payee === payee && item.status === "done");
  if (known) return false;
  return contact === undefined || !contact.trusted;
}

function todayPrefix(): string {
  return new Date().toISOString().slice(0, 10);
}

function todayTransferCount(state: BankState): number {
  const prefix = todayPrefix();
  return state.transfers.filter((item) => item.ts.startsWith(prefix) && item.status === "done").length;
}

function todayTransferSum(state: BankState): Cents {
  const prefix = todayPrefix();
  return state.transfers
    .filter((item) => item.ts.startsWith(prefix) && item.status === "done")
    .reduce((sum, item) => sum + item.amountCents, 0);
}

export interface PolicyInput {
  tool: string;
  params: Record<string, unknown>;
  state: BankState;
}

/** 三色判定：基础等级叠加金额、收款人、频次、可逆性四个维度。 */
export function evaluate(input: PolicyInput): PolicyDecision {
  const { tool, params, state } = input;
  const policy: BankPolicy = state.policy;
  const spec = specOf(tool);
  const hits: PolicyHit[] = [];

  if (spec === undefined) {
    return {
      level: "red",
      shape: "white-list",
      hits: [{ rule: "tool-whitelist", detail: `工具 ${tool} 不在白名单`, delta: "block" }],
      summary: "该操作不在可执行范围内，已拦截。",
      requiresConfirm: false,
      blocked: true,
      guidance: "请换一种说法，或联系人工客服办理。",
    };
  }

  let level: RiskLevel = spec.baseLevel;
  hits.push({ rule: "base-level", detail: `${spec.label}基础等级为${spec.baseLevel}`, delta: "none" });

  const amountRaw = params.amountCents;
  const amount = typeof amountRaw === "number" ? amountRaw : 0;

  if (amount < 0) {
    hits.push({ rule: "amount-negative", detail: "金额为负", delta: "block" });
    return {
      level: "red",
      shape: "invalid-amount",
      hits,
      summary: "金额不合法，已拦截。",
      requiresConfirm: false,
      blocked: true,
      guidance: "请给出大于零的金额。",
    };
  }

  if (amount > policy.transferLimitCents) {
    level = "red";
    hits.push({
      rule: "single-limit",
      detail: `金额 ${yuan(amount)} 元超过单笔限额 ${yuan(policy.transferLimitCents)} 元`,
      delta: "block",
    });
  }

  const usedToday = todayTransferSum(state);
  if (amount > 0 && usedToday + amount > policy.dailyLimitCents) {
    level = "red";
    hits.push({
      rule: "daily-limit",
      detail: `今日已转 ${yuan(usedToday)} 元，本次将超过日限额 ${yuan(policy.dailyLimitCents)} 元`,
      delta: "block",
    });
  }

  const payee = typeof params.payee === "string" ? params.payee : "";
  if (payee !== "" && policy.newPayeeUpgrade && isNewPayee(payee, state)) {
    if (amount >= 50000) {
      level = "red";
      hits.push({ rule: "new-payee", detail: `收款人 ${payee} 为首次收款，且金额不低于 500 元`, delta: "block" });
    } else {
      level = maxLevel(level, "yellow");
      hits.push({ rule: "new-payee", detail: `收款人 ${payee} 为首次收款`, delta: "upgrade" });
    }
  }

  const countToday = todayTransferCount(state);
  if (tool === "transfer" && countToday >= policy.dailyCountLimit) {
    level = "red";
    hits.push({ rule: "daily-count", detail: `今日转账笔数已达 ${countToday} 笔上限`, delta: "block" });
  }

  if (!spec.reversible) {
    hits.push({ rule: "irreversible", detail: `${spec.label}执行后不可撤销`, delta: "none" });
  }

  const blocked = level === "red";
  const requiresConfirm = level === "yellow";
  const shape = blocked ? "blocked" : requiresConfirm ? "confirm" : "auto";

  let guidance: string | undefined;
  if (blocked) {
    if (hits.some((hit) => hit.rule === "single-limit")) {
      guidance = `本次金额超过单笔限额 ${yuan(policy.transferLimitCents)} 元，可在手机银行完成人脸验证后继续。`;
    } else if (hits.some((hit) => hit.rule === "new-payee")) {
      guidance = "首次收款需要强验证，可在手机银行添加常用收款人后再操作。";
    } else if (hits.some((hit) => hit.rule === "irreversible")) {
      guidance = `${spec.label}涉及不可撤销变更，请携带本人证件到柜面或通过人脸验证办理。`;
    } else {
      guidance = "该操作超出当前权限，请联系人工客服。";
    }
  }

  const summary = blocked
    ? `判定为红：${hits.filter((hit) => hit.delta === "block").map((hit) => hit.detail).join("；")}`
    : requiresConfirm
      ? `判定为黄：${spec.label}，需要你确认后执行`
      : `判定为绿：${spec.label}，可直接执行`;

  return { level, shape, hits, summary, requiresConfirm, blocked, ...(guidance === undefined ? {} : { guidance }) };
}

/** 供前端展示的判定维度说明。 */
export const POLICY_DIMENSIONS: ReadonlyArray<{ key: string; label: string; detail: string }> = [
  { key: "operation", label: "操作类型", detail: "只读、动账、改规则三类，决定基础等级" },
  { key: "amount", label: "金额", detail: "对照单笔限额与当日剩余额度" },
  { key: "payee", label: "收款人", detail: "首次收款人升级，500 元以上需强验证" },
  { key: "frequency", label: "频次", detail: "当日转账笔数达到上限后拦截" },
  { key: "reversibility", label: "可逆性", detail: "不可撤销的操作直接拦截" },
];
