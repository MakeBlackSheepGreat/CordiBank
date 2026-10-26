import type { BankState, Cents, Intent, IntentSlots, SceneId } from "./types.ts";

const CN_DIGITS: Record<string, number> = { 零: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
const CN_UNITS: Record<string, number> = { 十: 10, 百: 100, 千: 1000, 万: 10000 };

/** 中文数字转阿拉伯数字，支持「三千五」「一百二十」「十五」这类口语写法。 */
export function cnToNumber(text: string): number | null {
  let total = 0;
  let section = 0;
  let number = 0;
  let lastUnit = 0;
  let zeroSeen = false;
  let touched = false;
  for (const char of text) {
    if (char in CN_DIGITS) {
      number = CN_DIGITS[char];
      if (number === 0) zeroSeen = true;
      touched = true;
      continue;
    }
    if (char in CN_UNITS) {
      const unit = CN_UNITS[char];
      lastUnit = unit;
      if (unit === 10000) {
        section = (section + number) * 10000;
        total += section;
        section = 0;
      } else {
        section += (number === 0 ? 1 : number) * unit;
      }
      number = 0;
      touched = true;
      continue;
    }
    return null;
  }
  if (!touched) return null;
  // 「三千五」这类口语省略了下一级单位，结尾单数字要按十分之一单位补位。
  if (number !== 0 && lastUnit >= 10 && !zeroSeen) {
    return total + section + number * (lastUnit / 10);
  }
  return total + section + number;
}

/** 抹掉手机号与长数字，避免它们被当成金额。 */
function stripIdentifiers(text: string): string {
  return text.replace(/1[3-9]\d{9}/g, " ").replace(/\d{12,}/g, " ");
}

/** 金额提取：优先阿拉伯数字，其次中文数字，单位支持万与千。 */
export function extractAmount(text: string): Cents | null {
  const cleaned = stripIdentifiers(text);
  const arabic = cleaned.match(/(\d+(?:\.\d+)?)\s*(万|千)?/);
  if (arabic !== null) {
    const value = Number(arabic[1]);
    const unit = arabic[2];
    const scaled = unit === "万" ? value * 10000 : unit === "千" ? value * 1000 : value;
    return Math.round(scaled * 100);
  }
  const chinese = cleaned.match(/([零一二三四五六七八九十百千万两]{2,})\s*(万|千)?/);
  if (chinese !== null) {
    const value = cnToNumber(chinese[1]);
    if (value === null) return null;
    const unit = chinese[2];
    const scaled = unit === "万" ? value * 10000 : unit === "千" ? value * 1000 : value;
    return Math.round(scaled * 100);
  }
  return null;
}

/** 收款人提取顺序：手机号、通讯录最长名、语法位上的名字。 */
export function extractPayee(text: string, state: BankState): string | undefined {
  const phone = text.match(/1[3-9]\d{9}/);
  if (phone !== null) {
    const contact = state.contacts.find((item) => item.phone === phone[0]);
    return contact === undefined ? phone[0] : contact.name;
  }
  const names = state.contacts
    .flatMap((item) => [item.name, item.remark])
    .filter((name) => name !== "")
    .sort((a, b) => b.length - a.length);
  for (const name of names) {
    if (text.includes(name)) return name;
  }
  const guessed = text.match(/(?:转(?:账)?(?:给)?|给|向|帮)\s*([\u4e00-\u9fa5]{2,4})(?=\s*(?:转|[\d一二三四五六七八九十百千万两]))/);
  if (guessed !== null) return guessed[1];
  return undefined;
}

/** 订阅关键词：把口语里的品类映射到具体订阅名。 */
const SUBSCRIPTION_KEYWORDS: ReadonlyArray<[string, string]> = [
  ["视频", "云幕视频会员"],
  ["影视", "云幕视频会员"],
  ["音乐", "声浪音乐会员"],
  ["云盘", "方圆云盘"],
  ["存储", "方圆云盘"],
  ["健身", "悦动健身月卡"],
  ["早报", "财经早报"],
  ["新闻", "财经早报"],
  ["工具", "工具箱 Pro"],
];

function matchSubscription(text: string, state: BankState): string | undefined {
  for (const [keyword, name] of SUBSCRIPTION_KEYWORDS) {
    if (text.includes(keyword) && state.subscriptions.some((item) => item.name === name)) return name;
  }
  const direct = state.subscriptions.find((item) => text.includes(item.name));
  return direct?.name;
}

/** 理财产品关键词：按风险偏好与产品名匹配。 */
function matchProduct(text: string, state: BankState): string | undefined {
  const direct = state.products.find((item) => text.includes(item.name));
  if (direct !== undefined) return direct.id;
  if (/货币|活期|保本|稳健/.test(text)) return "p-001";
  if (/低风险|保守/.test(text)) return "p-002";
  if (/平衡|中风险/.test(text)) return "p-003";
  if (/进取|中高/.test(text)) return "p-004";
  if (/科技|高风险|激进/.test(text)) return "p-005";
  return undefined;
}

function periodOf(text: string): string | undefined {
  if (/上个?月/.test(text)) return "last-month";
  if (/本月|这个月|当月/.test(text)) return "month";
  if (/今年|年度|全年/.test(text)) return "year";
  if (/上周|本周|这周/.test(text)) return "week";
  return undefined;
}

function dateOf(text: string): string | undefined {
  if (/今天|今日/.test(text)) return "today";
  if (/明天|明日/.test(text)) return "tomorrow";
  if (/后天/.test(text)) return "day-after-tomorrow";
  if (/下个?月/.test(text)) return "next-month";
  if (/生日/.test(text)) return "birthday";
  return undefined;
}

interface Built {
  slots: IntentSlots;
  missing: string[];
  /** 同一场景下可能落到不同工具，例如订阅场景的查询与取消。 */
  tool?: string;
}

interface Rule {
  scene: SceneId;
  tool: string;
  pattern: RegExp;
  build: (text: string, state: BankState) => Built;
}

/** 人数解析：兼容「三个人」与「3 个人」。 */
function parseCount(token: string): number {
  const cn = cnToNumber(token);
  if (cn !== null) return cn;
  const num = Number(token);
  return Number.isFinite(num) && num >= 2 ? num : 2;
}

/** 规则按「具体优先」排列：先匹配订阅、卡片、理财，再匹配转账这类宽口径动词。 */
const RULES: ReadonlyArray<Rule> = [
  {
    scene: "card",
    tool: "change_password",
    pattern: /(改密|修改密码|换密码|支付密码|登录密码)/,
    build: () => ({ slots: {}, missing: [] }),
  },
  {
    scene: "card",
    tool: "freeze_account",
    pattern: /(冻结|封停|停用).{0,4}(账户|账号|银行卡)/,
    build: () => ({ slots: {}, missing: [] }),
  },
  {
    scene: "subscription",
    tool: "list_subscriptions",
    pattern: /(订阅|代扣|续费|自动扣费|会员|退订)/,
    build: (text, state) => {
      if (/(取消|退订|关掉|停掉|关闭)/.test(text)) {
        const name = matchSubscription(text, state);
        return name === undefined
          ? { slots: {}, missing: ["subscriptionName"], tool: "cancel_subscription" }
          : { slots: { subscriptionName: name }, missing: [], tool: "cancel_subscription" };
      }
      if (/提醒|即将|快到期|要扣费|什么时候扣|哪天扣|要续费|续费日/.test(text)) {
        return { slots: {}, missing: [], tool: "subscription_reminder" };
      }
      return { slots: {}, missing: [], tool: "list_subscriptions" };
    },
  },
  {
    scene: "card",
    tool: "list_cards",
    pattern: /(卡片|信用卡|借记卡|卡状态|额度|限额|挂失|锁卡|丢卡|申请卡|办卡)/,
    build: (text, state) => {
      if (/挂失|丢了|丢卡|遗失/.test(text)) return { slots: { cardId: "card-001" }, missing: [], tool: "report_loss" };
      if (/锁卡|锁定|冻结/.test(text)) return { slots: { cardId: "card-002" }, missing: [], tool: "lock_card" };
      if (/解锁|恢复使用/.test(text)) return { slots: { cardId: "card-002", note: "unlock" }, missing: [], tool: "lock_card" };
      const limit = /(额度|限额|提到|调到|提高到)/.test(text) ? extractAmount(text) : null;
      if (limit !== null) return { slots: { cardId: "card-002", amountCents: limit }, missing: [], tool: "adjust_limit" };
      if (/申请|办理|新卡|办卡/.test(text)) return { slots: { purpose: "新卡申请" }, missing: [], tool: "apply_card" };
      return { slots: {}, missing: [], tool: "list_cards" };
    },
  },
  {
    scene: "wealth",
    tool: "wealth_list",
    pattern: /(理财|基金|年化|收益|申购|赎回|风险测评|风险等级)/,
    build: (text, state) => {
      if (/风险测评|风险等级|承受能力/.test(text)) return { slots: {}, missing: [], tool: "wealth_risk" };
      const amount = extractAmount(text);
      if (/赎回|取出|卖出|卖掉/.test(text)) {
        const redeemed = matchProduct(text, state);
        return {
          slots: { ...(redeemed === undefined ? {} : { productId: redeemed }), ...(amount === null ? {} : { amountCents: amount }) },
          missing: [],
          tool: "wealth_redeem",
        };
      }
      if (/申购|买入|购买|投|买/.test(text)) {
        const productId = matchProduct(text, state);
        const missing: string[] = [];
        if (productId === undefined) missing.push("productId");
        if (amount === null) missing.push("amountCents");
        return {
          slots: { ...(productId === undefined ? {} : { productId }), ...(amount === null ? {} : { amountCents: amount }) },
          missing,
          tool: "wealth_purchase",
        };
      }
      const productId = matchProduct(text, state);
      return { slots: productId === undefined ? {} : { productId }, missing: [], tool: "wealth_list" };
    },
  },
  {
    scene: "bills",
    tool: "analyze_bills",
    pattern: /(账单|消费|花了|支出|开销|异常交易|流水)/,
    build: (text) => {
      const period = periodOf(text);
      return { slots: period === undefined ? {} : { period }, missing: [] };
    },
  },
  {
    scene: "bills",
    tool: "query_balance",
    pattern: /(余额|还有多少钱|账户余额|可用额度)/,
    build: () => ({ slots: {}, missing: [] }),
  },
  {
    scene: "cross",
    tool: "birthday_lock",
    pattern: /(生日|纪念日)/,
    build: (text) => {
      const wantBook = /(订|下单|买|准备|安排).{0,6}(花|蛋糕|礼|礼物)|蛋糕|鲜花/.test(text);
      if (wantBook) {
        const gift = /花.*蛋糕|蛋糕.*花|都要|组合/.test(text)
          ? "both"
          : /蛋糕/.test(text)
            ? "cake"
            : "flower";
        return { slots: { gift, purpose: "生日礼遇" }, missing: [], tool: "birthday_book" };
      }
      const amount = extractAmount(text);
      return {
        slots: { purpose: "生日礼遇", ...(amount === null ? { amountCents: 100000 } : { amountCents: amount }) },
        missing: [],
      };
    },
  },
  {
    scene: "transfer",
    tool: "create_aa",
    pattern: /(AA|aa|拆分|平摊|均摊)/,
    build: (text, state) => {
      const amount = extractAmount(text);
      const sharesMatch = text.match(/([一二三四五六七八九十两\d]+)\s*个?人/);
      const payee = extractPayee(text, state);
      const missing: string[] = [];
      if (amount === null) missing.push("amountCents");
      if (payee === undefined) missing.push("payee");
      return {
        slots: {
          ...(amount === null ? {} : { amountCents: amount }),
          ...(payee === undefined ? {} : { payee }),
          shares: sharesMatch === null ? 2 : parseCount(sharesMatch[1]),
        },
        missing,
      };
    },
  },
  {
    scene: "transfer",
    tool: "schedule_transfer",
    pattern: /(定时|预约|自动转|每月|下个?月|明天|后天).{0,12}(转|汇)/,
    build: (text, state) => {
      const payee = extractPayee(text, state);
      const amount = extractAmount(text);
      const missing: string[] = [];
      if (payee === undefined) missing.push("payee");
      if (amount === null) missing.push("amountCents");
      const at = dateOf(text);
      return {
        slots: {
          ...(payee === undefined ? {} : { payee }),
          ...(amount === null ? {} : { amountCents: amount }),
          ...(at === undefined ? {} : { at }),
        },
        missing,
      };
    },
  },
  {
    scene: "transfer",
    tool: "transfer",
    pattern: /(转|汇|打款|付款)/,
    build: (text, state) => {
      const payee = extractPayee(text, state);
      const amount = extractAmount(text);
      const missing: string[] = [];
      if (payee === undefined) missing.push("payee");
      if (amount === null) missing.push("amountCents");
      return {
        slots: {
          ...(payee === undefined ? {} : { payee }),
          ...(amount === null ? {} : { amountCents: amount }),
        },
        missing,
      };
    },
  },
];

/** 解析一句话：命中第一条规则即为场景，槽位缺失交给编排层追问。 */
export function parseIntent(raw: string, state: BankState): Intent {
  const text = raw.trim();
  for (const rule of RULES) {
    if (!rule.pattern.test(text)) continue;
    const built = rule.build(text, state);
    const { slots, missing } = built;
    const filled = Object.values(slots).filter((value) => value !== undefined).length;
    const confidence = missing.length === 0 ? 0.95 : Math.max(0.55, 0.95 - missing.length * 0.15);
    return {
      scene: rule.scene,
      tool: built.tool ?? rule.tool,
      slots,
      missing,
      confidence,
      reason: `命中「${rule.pattern.source}」规则，填充 ${filled} 个槽位`,
    };
  }
  return { scene: "unknown", tool: "unknown", slots: {}, missing: [], confidence: 0, reason: "未命中任何场景规则" };
}
