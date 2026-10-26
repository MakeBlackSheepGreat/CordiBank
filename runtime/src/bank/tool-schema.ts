import type { IntentSlots } from "./types.ts";

/** 槽位契约：约束模型输出，也约束规则输出的字段形状。 */
export interface SlotSpec {
  kind: "string" | "integer" | "enum";
  description: string;
  required: boolean;
  values?: readonly string[];
  min?: number;
  max?: number;
  maxLength?: number;
}

export interface ToolContract {
  tool: string;
  summary: string;
  slots: Partial<Record<keyof IntentSlots, SlotSpec>>;
}

/** 全部可执行工具的参数契约。未登记的槽位一律丢弃，未登记的工具一律拒绝。 */
export const TOOL_CONTRACTS: Readonly<Record<string, ToolContract>> = {
  query_balance: { tool: "query_balance", summary: "查询账户余额与可用额度", slots: {} },
  analyze_bills: {
    tool: "analyze_bills",
    summary: "统计消费分类、识别异常交易、生成账单报告",
    slots: { period: { kind: "enum", description: "统计周期", required: false, values: ["month", "last-month", "year", "week"] } },
  },
  transfer: {
    tool: "transfer",
    summary: "向指定收款人转账",
    slots: {
      payee: { kind: "string", description: "收款人姓名、备注或手机号", required: true, maxLength: 32 },
      amountCents: { kind: "integer", description: "金额，单位分", required: true, min: 1, max: 10_000_000 },
    },
  },
  create_aa: {
    tool: "create_aa",
    summary: "发起 AA 收款，按人头拆分金额",
    slots: {
      payee: { kind: "string", description: "收款对象姓名或备注", required: true, maxLength: 32 },
      amountCents: { kind: "integer", description: "每人金额，单位分", required: true, min: 1, max: 1_000_000 },
      shares: { kind: "integer", description: "参与人数", required: false, min: 2, max: 20 },
    },
  },
  schedule_transfer: {
    tool: "schedule_transfer",
    summary: "在指定日期执行转账",
    slots: {
      payee: { kind: "string", description: "收款人姓名或备注", required: true, maxLength: 32 },
      amountCents: { kind: "integer", description: "金额，单位分", required: true, min: 1, max: 10_000_000 },
      at: {
        kind: "enum",
        description: "执行时机",
        required: false,
        values: ["today", "tomorrow", "day-after-tomorrow", "next-month", "birthday"],
      },
    },
  },
  list_subscriptions: { tool: "list_subscriptions", summary: "列出订阅与下次扣费时间", slots: {} },
  cancel_subscription: {
    tool: "cancel_subscription",
    summary: "取消指定订阅的自动续费",
    slots: { subscriptionName: { kind: "string", description: "订阅名称", required: true, maxLength: 32 } },
  },
  list_cards: { tool: "list_cards", summary: "列出卡片状态与额度", slots: {} },
  lock_card: {
    tool: "lock_card",
    summary: "锁定或解锁卡片",
    slots: { cardId: { kind: "enum", description: "卡片标识", required: true, values: ["card-001", "card-002"] } },
  },
  report_loss: {
    tool: "report_loss",
    summary: "挂失卡片，不可撤销",
    slots: { cardId: { kind: "enum", description: "卡片标识", required: false, values: ["card-001", "card-002"] } },
  },
  apply_card: {
    tool: "apply_card",
    summary: "提交新卡申请",
    slots: { purpose: { kind: "string", description: "申请用途", required: false, maxLength: 32 } },
  },
  adjust_limit: {
    tool: "adjust_limit",
    summary: "调整卡片额度，改规则类操作",
    slots: {
      cardId: { kind: "enum", description: "卡片标识", required: false, values: ["card-001", "card-002"] },
      amountCents: { kind: "integer", description: "目标额度，单位分", required: true, min: 1, max: 100_000_000 },
    },
  },
  wealth_list: {
    tool: "wealth_list",
    summary: "列出理财产品或查询单款产品",
    slots: {
      productId: { kind: "enum", description: "产品标识", required: false, values: ["p-001", "p-002", "p-003", "p-004", "p-005"] },
    },
  },
  wealth_risk: { tool: "wealth_risk", summary: "按持仓结构给出风险承受等级", slots: {} },
  wealth_purchase: {
    tool: "wealth_purchase",
    summary: "申购理财产品，不可撤销",
    slots: {
      productId: {
        kind: "enum",
        description: "产品标识",
        required: true,
        values: ["p-001", "p-002", "p-003", "p-004", "p-005"],
      },
      amountCents: { kind: "integer", description: "申购金额，单位分", required: true, min: 1, max: 100_000_000 },
    },
  },
  wealth_redeem: {
    tool: "wealth_redeem",
    summary: "赎回理财产品，资金回到活期",
    slots: {
      productId: {
        kind: "enum",
        description: "产品标识，省略表示全部赎回",
        required: false,
        values: ["p-001", "p-002", "p-003", "p-004", "p-005"],
      },
      amountCents: { kind: "integer", description: "赎回金额，单位分，省略表示全部", required: false, min: 1, max: 100_000_000 },
    },
  },
  subscription_reminder: {
    tool: "subscription_reminder",
    summary: "列出未来三十天待扣费的订阅与合计金额",
    slots: {},
  },
  change_password: { tool: "change_password", summary: "修改登录或支付密码", slots: {} },
  freeze_account: { tool: "freeze_account", summary: "冻结账户全部交易", slots: {} },
  birthday_lock: {
    tool: "birthday_lock",
    summary: "锁定资金用于生日礼遇，到期前预订服务",
    slots: {
      amountCents: { kind: "integer", description: "锁定金额，单位分", required: true, min: 1, max: 5_000_000 },
      purpose: { kind: "string", description: "用途说明", required: false, maxLength: 32 },
    },
  },
  birthday_book: {
    tool: "birthday_book",
    summary: "预订生日礼遇，优先抵扣已锁定资金",
    slots: {
      gift: {
        kind: "enum",
        description: "礼遇类型",
        required: true,
        values: ["cake", "flower", "both"],
      },
      purpose: { kind: "string", description: "用途说明", required: false, maxLength: 32 },
    },
  },
};

export const TOOL_NAMES: readonly string[] = Object.keys(TOOL_CONTRACTS);

/** 写操作清单：改动资金、额度或账户状态，Agent 循环内不执行。 */
export const WRITE_TOOL_NAMES: ReadonlySet<string> = new Set([
  "transfer",
  "create_aa",
  "schedule_transfer",
  "cancel_subscription",
  "lock_card",
  "report_loss",
  "apply_card",
  "adjust_limit",
  "wealth_purchase",
  "wealth_redeem",
  "change_password",
  "freeze_account",
  "birthday_lock",
  "birthday_book",
]);
