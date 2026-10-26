import { SEED_NOW, yuan } from "./data.ts";
import type { BankState, Bill, Cents, Card, IntentSlots, ToolResult } from "./types.ts";

/** 银行系统的「现在」：与合成数据同基准，保证统计口径稳定可复现。 */
function bankNow(): Date {
  return new Date(SEED_NOW);
}

function monthPrefix(offsetMonths: number): string {
  const now = bankNow();
  const date = new Date(now.getFullYear(), now.getMonth() + offsetMonths, 1);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
}

function yearPrefix(offsetYears: number): string {
  return String(bankNow().getFullYear() + offsetYears);
}

function selectBills(state: BankState, period: string | undefined): Bill[] {
  const prefix =
    period === "last-month"
      ? monthPrefix(-1)
      : period === "year"
        ? yearPrefix(0)
        : monthPrefix(0);
  return state.bills.filter((bill) => bill.ts.startsWith(prefix));
}

function fail(tool: string, message: string): ToolResult {
  return { ok: false, tool, message, error: message };
}

export function queryBalance(state: BankState): ToolResult {
  return {
    ok: true,
    tool: "query_balance",
    message: `当前余额 ${yuan(state.account.balance)} 元`,
    data: {
      balanceCents: state.account.balance,
      availableCents: state.account.available,
      cardTail: state.account.cardNo.slice(-4),
      holder: state.account.holder,
    },
  };
}

interface CategoryStat {
  category: string;
  totalCents: Cents;
  count: number;
  share: number;
}

interface Anomaly {
  billId: string;
  ts: string;
  merchant: string;
  amountCents: Cents;
  reason: string;
}

export interface BillReport {
  period: string;
  totalCents: Cents;
  count: number;
  categories: CategoryStat[];
  anomalies: Anomaly[];
  topMerchants: Array<{ merchant: string; totalCents: Cents; count: number }>;
  subscriptionCharge: Cents;
  headline: string;
}

/** 账单分析：分类统计、异常识别、商户排行、订阅扣费汇总。 */
export function analyzeBills(state: BankState, period: string | undefined): ToolResult {
  const bills = selectBills(state, period);
  if (bills.length === 0) return fail("analyze_bills", "该周期没有账单记录");
  const totalCents = bills.reduce((sum, bill) => sum + bill.amountCents, 0);

  const byCategory = new Map<string, { totalCents: Cents; count: number }>();
  for (const bill of bills) {
    const current = byCategory.get(bill.category) ?? { totalCents: 0, count: 0 };
    current.totalCents += bill.amountCents;
    current.count += 1;
    byCategory.set(bill.category, current);
  }
  const categories: CategoryStat[] = [...byCategory.entries()]
    .map(([category, value]) => ({
      category,
      totalCents: value.totalCents,
      count: value.count,
      share: totalCents === 0 ? 0 : Number((value.totalCents / totalCents).toFixed(4)),
    }))
    .sort((a, b) => b.totalCents - a.totalCents);

  const averageByCategory = new Map(categories.map((item) => [item.category, item.totalCents / item.count]));
  const anomalies: Anomaly[] = [];
  for (const bill of bills) {
    const hour = (new Date(bill.ts).getUTCHours() + 8) % 24;
    const average = averageByCategory.get(bill.category) ?? 0;
    if (hour >= 0 && hour < 6 && bill.amountCents >= 50000) {
      anomalies.push({
        billId: bill.id,
        ts: bill.ts,
        merchant: bill.merchant,
        amountCents: bill.amountCents,
        reason: `凌晨 ${hour} 点发生 ${yuan(bill.amountCents)} 元大额交易`,
      });
      continue;
    }
    if (average > 0 && bill.amountCents >= average * 3 && bill.amountCents >= 30000) {
      anomalies.push({
        billId: bill.id,
        ts: bill.ts,
        merchant: bill.merchant,
        amountCents: bill.amountCents,
        reason: `金额为同类均值 ${yuan(Math.round(average))} 元的 ${(bill.amountCents / average).toFixed(1)} 倍`,
      });
    }
  }

  const byMerchant = new Map<string, { totalCents: Cents; count: number }>();
  for (const bill of bills) {
    const current = byMerchant.get(bill.merchant) ?? { totalCents: 0, count: 0 };
    current.totalCents += bill.amountCents;
    current.count += 1;
    byMerchant.set(bill.merchant, current);
  }
  const topMerchants = [...byMerchant.entries()]
    .map(([merchant, value]) => ({ merchant, totalCents: value.totalCents, count: value.count }))
    .sort((a, b) => b.totalCents - a.totalCents)
    .slice(0, 5);

  const subscriptionCharge = bills
    .filter((bill) => bill.channel === "subscription")
    .reduce((sum, bill) => sum + bill.amountCents, 0);

  const top = categories[0];
  const report: BillReport = {
    period: period ?? "month",
    totalCents,
    count: bills.length,
    categories,
    anomalies,
    topMerchants,
    subscriptionCharge,
    headline: `共 ${bills.length} 笔，合计 ${yuan(totalCents)} 元，最大类别为${top?.category ?? "无"}`,
  };
  return { ok: true, tool: "analyze_bills", message: report.headline, data: report };
}

export function transfer(state: BankState, payee: string, amountCents: Cents): ToolResult {
  if (amountCents <= 0) return fail("transfer", "金额必须大于零");
  if (amountCents > state.account.balance) return fail("transfer", "余额不足");
  const contact = state.contacts.find((item) => item.name === payee || item.remark === payee);
  const resolved = contact === undefined ? payee : contact.name;
  state.account.balance -= amountCents;
  state.account.available -= amountCents;
  state.transfers.unshift({
    id: `t-${String(state.transfers.length + 1).padStart(3, "0")}`,
    payee: resolved,
    amountCents,
    ts: new Date().toISOString(),
    status: "done",
  });
  return {
    ok: true,
    tool: "transfer",
    message: `已向 ${resolved} 转账 ${yuan(amountCents)} 元`,
    data: { payee: resolved, amountCents, balanceCents: state.account.balance },
  };
}

export function createAa(state: BankState, payee: string, amountCents: Cents, shares: number): ToolResult {
  if (amountCents <= 0) return fail("create_aa", "每人金额必须大于零");
  if (shares < 2 || shares > 20) return fail("create_aa", "人数需要在 2 至 20 之间");
  const totalCents = amountCents * shares;
  state.aaCollections.unshift({
    id: `aa-${String(state.aaCollections.length + 1).padStart(3, "0")}`,
    title: `AA 收款：${payee}`,
    totalCents,
    shares,
    participants: [state.account.holder],
    collectedCents: amountCents,
    createdAt: new Date().toISOString(),
  });
  return {
    ok: true,
    tool: "create_aa",
    message: `已发起 AA 收款，每人 ${yuan(amountCents)} 元，共 ${shares} 人，合计 ${yuan(totalCents)} 元`,
    data: { shares, perPersonCents: amountCents, totalCents },
  };
}

export function scheduleTransfer(state: BankState, payee: string, amountCents: Cents, at: string | undefined): ToolResult {
  if (amountCents <= 0) return fail("schedule_transfer", "金额必须大于零");
  const contact = state.contacts.find((item) => item.name === payee || item.remark === payee);
  const resolved = contact === undefined ? payee : contact.name;
  const repeat = at === "next-month" ? "monthly" : "once";
  const dueHours = at === "tomorrow" ? 24 : at === "day-after-tomorrow" ? 48 : 24;
  state.scheduled.unshift({
    id: `sch-${String(state.scheduled.length + 1).padStart(3, "0")}`,
    payee: resolved,
    amountCents,
    at: new Date(Date.now() + dueHours * 3600000).toISOString(),
    repeat,
  });
  return {
    ok: true,
    tool: "schedule_transfer",
    message: `已预约向 ${resolved} 转账 ${yuan(amountCents)} 元，执行时间 ${new Date(Date.now() + dueHours * 3600000).toLocaleString("zh-CN")}`,
    data: { payee: resolved, amountCents, repeat },
  };
}

export function listSubscriptions(state: BankState): ToolResult {
  const totalMonthly = state.subscriptions
    .filter((item) => item.cycle === "monthly")
    .reduce((sum, item) => sum + item.amountCents, 0);
  return {
    ok: true,
    tool: "list_subscriptions",
    message: `共 ${state.subscriptions.length} 项订阅，每月固定扣费 ${yuan(totalMonthly)} 元`,
    data: {
      items: state.subscriptions.map((item) => ({
        name: item.name,
        amountCents: item.amountCents,
        cycle: item.cycle,
        nextChargeAt: item.nextChargeAt,
        cancelable: item.cancelable,
      })),
      monthlyTotalCents: totalMonthly,
    },
  };
}

export function cancelSubscription(state: BankState, name: string | undefined): ToolResult {
  const target = name === undefined ? state.subscriptions : state.subscriptions.filter((item) => item.name === name);
  if (target.length === 0) return fail("cancel_subscription", `没有找到订阅：${name ?? "全部"}`);
  const blocked = target.filter((item) => !item.cancelable);
  if (blocked.length > 0) {
    return fail("cancel_subscription", `${blocked.map((item) => item.name).join("、")} 属于合约期内，需到期后取消`);
  }
  state.subscriptions = state.subscriptions.filter((item) => !target.some((hit) => hit.id === item.id));
  return {
    ok: true,
    tool: "cancel_subscription",
    message: `已取消 ${target.map((item) => item.name).join("、")}`,
    data: { cancelled: target.map((item) => item.name), remaining: state.subscriptions.length },
  };
}

function cardView(card: Card): Record<string, unknown> {
  return {
    cardId: card.id,
    tail: card.number.slice(-4),
    kind: card.kind,
    status: card.status,
    limitCents: card.limitCents,
    usedCents: card.usedCents,
    availableCents: Math.max(0, card.limitCents - card.usedCents),
    dailyLimitCents: card.dailyLimitCents,
  };
}

export function listCards(state: BankState): ToolResult {
  return {
    ok: true,
    tool: "list_cards",
    message: `名下共 ${state.cards.length} 张卡`,
    data: { cards: state.cards.map(cardView) },
  };
}

export function lockCard(state: BankState, cardId: string): ToolResult {
  const card = state.cards.find((item) => item.id === cardId);
  if (card === undefined) return fail("lock_card", `卡片不存在：${cardId}`);
  if (card.status === "lost") return fail("lock_card", "卡片已挂失，无法重复锁定");
  const unlocking = card.status === "locked";
  card.status = unlocking ? "active" : "locked";
  return {
    ok: true,
    tool: "lock_card",
    message: unlocking ? `已解锁尾号 ${card.number.slice(-4)} 的卡片` : `已锁定尾号 ${card.number.slice(-4)} 的卡片`,
    data: { cardId: card.id, status: card.status },
  };
}

export function reportLoss(state: BankState, cardId: string): ToolResult {
  const card = state.cards.find((item) => item.id === cardId);
  if (card === undefined) return fail("report_loss", `卡片不存在：${cardId}`);
  card.status = "lost";
  return {
    ok: true,
    tool: "report_loss",
    message: `尾号 ${card.number.slice(-4)} 的卡片已挂失，新卡将在 3 个工作日内寄出`,
    data: { cardId: card.id, status: card.status },
  };
}

export function applyCard(state: BankState, purpose: string | undefined): ToolResult {
  return {
    ok: true,
    tool: "apply_card",
    message: "新卡申请已提交，审核结果会在 1 个工作日内通知",
    data: { purpose: purpose ?? "新卡申请", applicationId: `app-${String(state.cards.length + 1).padStart(3, "0")}` },
  };
}

export function adjustLimit(state: BankState, cardId: string, limitCents: Cents): ToolResult {
  const card = state.cards.find((item) => item.id === cardId);
  if (card === undefined) return fail("adjust_limit", `卡片不存在：${cardId}`);
  if (limitCents <= 0) return fail("adjust_limit", "额度必须大于零");
  const previous = card.limitCents;
  card.limitCents = limitCents;
  return {
    ok: true,
    tool: "adjust_limit",
    message: `尾号 ${card.number.slice(-4)} 的额度已从 ${yuan(previous)} 元调整为 ${yuan(limitCents)} 元`,
    data: { cardId: card.id, previousCents: previous, limitCents },
  };
}

export function listWealth(state: BankState, productId: string | undefined): ToolResult {
  const products = productId === undefined ? state.products : state.products.filter((item) => item.id === productId);
  if (products.length === 0) return fail("wealth_list", "没有找到对应的理财产品");
  const rows = products.map((item) => ({
    productId: item.id,
    name: item.name,
    riskLevel: item.riskLevel,
    annualRate: `${(item.annualRateBp / 100).toFixed(2)}%`,
    minAmountCents: item.minAmountCents,
    termDays: item.termDays,
    feeBp: item.feeBp,
    issuer: item.issuer,
  }));
  return {
    ok: true,
    tool: "wealth_list",
    message: productId === undefined ? `共 ${rows.length} 款在售产品` : `已找到 ${rows[0].name}`,
    data: { products: rows },
  };
}

export function riskProfile(state: BankState): ToolResult {
  const holding = state.holdings.reduce((sum, item) => sum + item.amountCents, 0);
  const ratio = state.account.balance === 0 ? 0 : holding / (holding + state.account.balance);
  const level = ratio < 0.2 ? 2 : ratio < 0.5 ? 3 : 4;
  const labels: Record<number, string> = { 1: "保守型", 2: "稳健型", 3: "平衡型", 4: "成长型", 5: "进取型" };
  return {
    ok: true,
    tool: "wealth_risk",
    message: `根据当前持仓结构，风险承受等级为 ${level} 级（${labels[level]}）`,
    data: { level, label: labels[level], holdingCents: holding, cashRatio: Number((1 - ratio).toFixed(4)) },
  };
}

/** 申购属于红色操作，正常情况下不会被调用；此处保留完整校验以便红队验证。 */
export function purchaseWealth(state: BankState, productId: string, amountCents: Cents): ToolResult {
  const product = state.products.find((item) => item.id === productId);
  if (product === undefined) return fail("wealth_purchase", `产品不存在：${productId}`);
  if (amountCents < product.minAmountCents) {
    return fail("wealth_purchase", `起购金额为 ${yuan(product.minAmountCents)} 元`);
  }
  if (amountCents > state.account.balance) return fail("wealth_purchase", "余额不足");
  state.account.balance -= amountCents;
  state.account.available -= amountCents;
  state.holdings.unshift({
    id: `h-${String(state.holdings.length + 1).padStart(3, "0")}`,
    productId,
    amountCents,
    purchasedAt: new Date().toISOString(),
  });
  return {
    ok: true,
    tool: "wealth_purchase",
    message: `已申购 ${product.name} ${yuan(amountCents)} 元`,
    data: { productId, amountCents },
  };
}

/** 生日资金预锁：锁定资金并生成预订计划，可撤销。 */
export function lockBirthdayFunds(state: BankState, amountCents: Cents, purpose: string | undefined): ToolResult {
  if (amountCents <= 0) return fail("birthday_lock", "锁定金额必须大于零");
  if (amountCents > state.account.available) return fail("birthday_lock", "可用余额不足");
  const lockUntil = new Date(bankNow().getTime() + 14 * 86400000).toISOString();
  state.account.available -= amountCents;
  state.lockedFunds.unshift({
    id: `lf-${String(state.lockedFunds.length + 1).padStart(3, "0")}`,
    purpose: purpose ?? "生日礼遇",
    amountCents,
    lockUntil,
    status: "locked",
  });
  return {
    ok: true,
    tool: "birthday_lock",
    message: `已锁定 ${yuan(amountCents)} 元用于${purpose ?? "生日礼遇"}，锁定至 ${lockUntil.slice(0, 10)}，到期前两天下单鲜花与蛋糕`,
    data: { amountCents, lockUntil, purpose: purpose ?? "生日礼遇", nextAction: "生日前两天自动下单鲜花与蛋糕" },
  };
}

/** 赎回持仓：按产品赎回，金额缺省为全部。回款按本金结算，演示不计收益。 */
export function redeemWealth(state: BankState, productId: string | undefined, amountCents: Cents | undefined): ToolResult {
  const positions = productId === undefined
    ? state.holdings
    : state.holdings.filter((item) => item.productId === productId);
  if (positions.length === 0) {
    return fail("wealth_redeem", productId === undefined ? "当前没有持仓" : `没有该产品的持仓：${productId}`);
  }
  const total = positions.reduce((sum, item) => sum + item.amountCents, 0);
  const amount = amountCents ?? total;
  if (amount <= 0) return fail("wealth_redeem", "赎回金额必须大于零");
  if (amount > total) return fail("wealth_redeem", `可赎回金额为 ${yuan(total)} 元`);

  let remaining = amount;
  for (const position of positions) {
    if (remaining <= 0) break;
    const take = Math.min(position.amountCents, remaining);
    position.amountCents -= take;
    remaining -= take;
  }
  state.holdings = state.holdings.filter((item) => item.amountCents > 0);
  state.account.balance += amount;
  state.account.available += amount;
  return {
    ok: true,
    tool: "wealth_redeem",
    message: `已赎回 ${yuan(amount)} 元，资金已回到活期账户`,
    data: { amountCents: amount, remainingCents: total - amount, productId: productId ?? "all" },
  };
}

/** 续费提醒：列出 30 天内将要扣费的订阅，只读。 */
export function subscriptionReminder(state: BankState, withinDays = 30): ToolResult {
  const now = bankNow().getTime();
  const horizon = now + withinDays * 86400000;
  const upcoming = state.subscriptions
    .filter((item) => item.autoRenew)
    .map((item) => ({ ...item, at: Date.parse(item.nextChargeAt) }))
    .filter((item) => Number.isFinite(item.at) && item.at >= now && item.at <= horizon)
    .sort((a, b) => a.at - b.at);
  const total = upcoming.reduce((sum, item) => sum + item.amountCents, 0);
  const detail = upcoming
    .map((item) => `${item.name} ${yuan(item.amountCents)} 元于 ${item.nextChargeAt.slice(0, 10)} 扣费`)
    .join("；");
  return {
    ok: true,
    tool: "subscription_reminder",
    message: upcoming.length === 0
      ? `未来 ${withinDays} 天没有待扣费订阅`
      : `未来 ${withinDays} 天有 ${upcoming.length} 笔订阅待扣费，合计 ${yuan(total)} 元。${detail}`,
    data: {
      withinDays,
      totalCents: total,
      items: upcoming.map((item) => ({ id: item.id, name: item.name, amountCents: item.amountCents, nextChargeAt: item.nextChargeAt })),
    },
  };
}

/** 礼遇商家目录：演示数据，价格固定。 */
const GIFT_CATALOG: Readonly<Record<string, { label: string; priceCents: Cents }>> = {
  cake: { label: "生日蛋糕（6 寸）", priceCents: 16800 },
  flower: { label: "鲜花花束（混合）", priceCents: 12800 },
  both: { label: "蛋糕加鲜花组合", priceCents: 26800 },
};

/** 生日礼遇下单：优先扣锁定资金，不足部分从可用余额补。可撤销。 */
export function bookGift(state: BankState, gift: string, purpose: string | undefined): ToolResult {
  const item = GIFT_CATALOG[gift];
  if (item === undefined) {
    return fail("birthday_book", `不支持的礼遇类型：${gift}，可选 cake、flower、both`);
  }
  const lock = state.lockedFunds.find((fund) => fund.status === "locked");
  const locked = lock === undefined ? 0 : lock.amountCents;
  const fromBalance = Math.max(0, item.priceCents - locked);
  if (fromBalance > state.account.available) {
    return fail("birthday_book", `可用余额不足，还需 ${yuan(fromBalance - state.account.available)} 元`);
  }
  const usedLocked = Math.min(locked, item.priceCents);
  if (lock !== undefined && usedLocked > 0) {
    lock.amountCents -= usedLocked;
    lock.status = lock.amountCents === 0 ? "spent" : "locked";
  }
  state.account.available -= fromBalance;
  state.account.balance -= fromBalance;
  const deliverAt = new Date(bankNow().getTime() + 2 * 86400000).toISOString().slice(0, 10);
  return {
    ok: true,
    tool: "birthday_book",
    message: `已预订${item.label}，${yuan(item.priceCents)} 元，其中锁定资金抵扣 ${yuan(usedLocked)} 元，送达日期 ${deliverAt}`,
    data: {
      gift,
      label: item.label,
      priceCents: item.priceCents,
      usedLockedCents: usedLocked,
      fromBalanceCents: fromBalance,
      deliverAt,
      purpose: purpose ?? "生日礼遇",
      cancelable: true,
    },
  };
}

export interface ExecuteInput {
  tool: string;
  slots: IntentSlots;
  state: BankState;
}

/** 工具分派：只做执行，不判定权限。权限由策略引擎在上游决定。 */
export function executeTool(input: ExecuteInput): ToolResult {
  const { tool, slots, state } = input;
  switch (tool) {
    case "query_balance":
      return queryBalance(state);
    case "analyze_bills":
      return analyzeBills(state, slots.period ?? slots.at);
    case "transfer":
      return transfer(state, slots.payee ?? "", slots.amountCents ?? 0);
    case "create_aa":
      return createAa(state, slots.payee ?? "", slots.amountCents ?? 0, slots.shares ?? 2);
    case "schedule_transfer":
      return scheduleTransfer(state, slots.payee ?? "", slots.amountCents ?? 0, slots.at);
    case "list_subscriptions":
      return listSubscriptions(state);
    case "cancel_subscription":
      return cancelSubscription(state, slots.subscriptionName);
    case "list_cards":
      return listCards(state);
    case "lock_card":
      return lockCard(state, slots.cardId ?? "card-002");
    case "report_loss":
      return reportLoss(state, slots.cardId ?? "card-001");
    case "apply_card":
      return applyCard(state, slots.purpose);
    case "adjust_limit":
      return adjustLimit(state, slots.cardId ?? "card-002", slots.amountCents ?? 0);
    case "wealth_list":
      return listWealth(state, slots.productId);
    case "wealth_risk":
      return riskProfile(state);
    case "wealth_purchase":
      return purchaseWealth(state, slots.productId ?? "", slots.amountCents ?? 0);
    case "change_password":
      return fail("change_password", "密码变更需要强验证，当前通道不执行");
    case "freeze_account":
      return fail("freeze_account", "账户冻结需要柜面或人脸强验证，当前通道不执行");
    case "birthday_lock":
      return lockBirthdayFunds(state, slots.amountCents ?? 100000, slots.purpose);
    case "wealth_redeem":
      return redeemWealth(state, slots.productId, slots.amountCents);
    case "subscription_reminder":
      return subscriptionReminder(state);
    case "birthday_book":
      return bookGift(state, slots.gift ?? "both", slots.purpose);
    default:
      return fail(tool, `工具不在白名单：${tool}`);
  }
}
