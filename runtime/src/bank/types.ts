/** 银行域类型：金额统一用整数分，避免浮点误差。 */

export type Cents = number;

/** 六个赛题场景的稳定标识。 */
export type SceneId = "transfer" | "bills" | "wealth" | "card" | "subscription" | "cross";

/** 三色风险等级：绿=自动执行，黄=人工确认，红=拦截。 */
export type RiskLevel = "green" | "yellow" | "red";

export interface Account {
  id: string;
  holder: string;
  cardNo: string;
  balance: Cents;
  available: Cents;
  currency: "CNY";
  openedAt: string;
}

export type CardStatus = "active" | "locked" | "lost";

export interface Card {
  id: string;
  accountId: string;
  number: string;
  kind: "debit" | "credit";
  limitCents: Cents;
  usedCents: Cents;
  dailyLimitCents: Cents;
  status: CardStatus;
}

export interface Contact {
  id: string;
  name: string;
  phone: string;
  remark: string;
  bank: string;
  firstSeenAt: string;
  /** 常用收款人：出现在通讯录且历史转账成功过。 */
  trusted: boolean;
}

export interface Bill {
  id: string;
  accountId: string;
  ts: string;
  amountCents: Cents;
  category: string;
  merchant: string;
  channel: "card" | "transfer" | "subscription" | "wealth";
  /** 账单备注由外部商户写入，属于不可信内容。 */
  note: string;
}

export interface Subscription {
  id: string;
  name: string;
  amountCents: Cents;
  cycle: "monthly" | "yearly";
  nextChargeAt: string;
  autoRenew: boolean;
  cancelable: boolean;
}

export interface WealthProduct {
  id: string;
  name: string;
  /** 1 至 5 级，数字越大风险越高。 */
  riskLevel: 1 | 2 | 3 | 4 | 5;
  annualRateBp: number;
  minAmountCents: Cents;
  termDays: number;
  feeBp: number;
  issuer: string;
}

export interface Holding {
  id: string;
  productId: string;
  amountCents: Cents;
  purchasedAt: string;
}

export interface TransferRecord {
  id: string;
  payee: string;
  amountCents: Cents;
  ts: string;
  status: "done" | "scheduled" | "reversed";
}

export interface ScheduledTransfer {
  id: string;
  payee: string;
  amountCents: Cents;
  at: string;
  repeat: "once" | "monthly";
}

export interface AaCollection {
  id: string;
  title: string;
  totalCents: Cents;
  shares: number;
  participants: string[];
  collectedCents: Cents;
  createdAt: string;
}

export interface LockedFund {
  id: string;
  purpose: string;
  amountCents: Cents;
  lockUntil: string;
  status: "locked" | "released" | "spent";
}

export interface BankPolicy {
  transferLimitCents: Cents;
  dailyLimitCents: Cents;
  dailyCountLimit: number;
  /** 首次收款人是否需要升级确认。 */
  newPayeeUpgrade: boolean;
  confirmTtlSeconds: number;
}

export interface BankState {
  version: number;
  account: Account;
  cards: Card[];
  contacts: Contact[];
  bills: Bill[];
  subscriptions: Subscription[];
  products: WealthProduct[];
  holdings: Holding[];
  transfers: TransferRecord[];
  scheduled: ScheduledTransfer[];
  aaCollections: AaCollection[];
  lockedFunds: LockedFund[];
  policy: BankPolicy;
  updatedAt: string;
}

export interface IntentSlots {
  payee?: string;
  amountCents?: Cents;
  cardId?: string;
  productId?: string;
  subscriptionName?: string;
  period?: string;
  purpose?: string;
  note?: string;
  at?: string;
  shares?: number;
  riskLevel?: number;
  /** 礼遇类型：cake、flower 或 both。 */
  gift?: string;
}

/** 意图解析结果：槽位缺失时由编排层追问。 */
export interface Intent {
  scene: SceneId | "unknown";
  tool: string;
  slots: IntentSlots;
  missing: string[];
  confidence: number;
  reason: string;
}

export type PolicyDelta = "none" | "upgrade" | "block";

export interface PolicyHit {
  rule: string;
  detail: string;
  delta: PolicyDelta;
}

export interface PolicyDecision {
  level: RiskLevel;
  /** 判定形状，供前端展示判定依据。 */
  shape: string;
  hits: PolicyHit[];
  summary: string;
  requiresConfirm: boolean;
  blocked: boolean;
  /** 被拦截时给出的可执行路径。 */
  guidance?: string;
}

export interface ToolResult {
  ok: boolean;
  tool: string;
  data?: unknown;
  message: string;
  error?: string;
}

export interface AuditRecord {
  seq: number;
  ts: string;
  sessionId: string;
  actor: string;
  userText: string;
  tool: string;
  params: Record<string, unknown>;
  decision: string;
  policyLevel: RiskLevel | "unknown";
  policyRules: string[];
  tokenDigest?: string;
  /** 意图来源：规则、模型或未产生意图。 */
  intentSource?: "rule" | "model" | "none";
  /** 模型调用元信息，不含凭据。 */
  model?: { name: string; tokens: number; latencyMs: number };
  result: string;
  prevHash: string;
  hash: string;
}

export interface ConfirmationTicket {
  token: string;
  digest: string;
  expiresAt: string;
  preview: string;
}

export interface BankTurn {
  role: "user" | "agent";
  text: string;
  ts: string;
}

export interface PendingAction {
  token: string;
  digest: string;
  tool: string;
  slots: IntentSlots;
  expiresAt: string;
  preview: string;
}

export interface BankSession {
  id: string;
  turns: BankTurn[];
  pending?: PendingAction;
  counters: Record<string, number>;
  lastScene?: SceneId;
  createdAt: string;
}

export interface ChatReply {
  sessionId: string;
  turn: number;
  reply: string;
  scene: SceneId | "unknown";
  decision: PolicyDecision;
  confirmation?: ConfirmationTicket;
  execution?: ToolResult;
  audit: { seq: number; hash: string };
  suggestions: string[];
  /** 被截断或缺失时给出的人工追问项。 */
  missing: string[];
  /** 意图来源：规则或模型，便于界面标注。 */
  intentSource?: "rule" | "model";
}

export interface GuardVerdict {
  attack: boolean;
  kind: "none" | "override" | "roleplay" | "encoded" | "exfiltration";
  matched: string;
  sanitized: string;
}

/** 不可信内容的来源标记：工具输出与外部分录一律视为数据。 */
export interface UntrustedContent {
  source: string;
  text: string;
  suspicious: boolean;
  matched: string;
}
