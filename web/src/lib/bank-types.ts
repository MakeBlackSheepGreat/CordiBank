/** 银行控制台的前端类型：字段与运行时返回保持一致，只保留界面需要的部分。 */

export type RiskLevel = 'green' | 'yellow' | 'red'

export interface PolicyHit {
  rule: string
  detail: string
  delta: 'none' | 'upgrade' | 'block'
}

export interface PolicyDecision {
  level: RiskLevel
  shape: string
  hits: PolicyHit[]
  summary: string
  requiresConfirm: boolean
  blocked: boolean
  guidance?: string
}

export interface ConfirmationTicket {
  token: string
  expiresAt: string
  preview: string
}

export interface ToolResult {
  ok: boolean
  tool: string
  message: string
  error?: string
  data?: unknown
}

export interface BankChatReply {
  sessionId: string
  turn: number
  reply: string
  scene: string
  decision: PolicyDecision
  confirmation?: ConfirmationTicket
  execution?: ToolResult
  audit: { seq: number; hash: string }
  suggestions: string[]
  missing: string[]
  /** 本轮意图由规则还是模型给出。 */
  intentSource?: 'rule' | 'model'
}

/** 模型层状态：界面只展示供应商标识与模型名，不接触凭据。 */
export interface ModelStatus {
  available: boolean
  mode: 'rule' | 'hybrid' | 'model'
  model: string
  endpoint: string
  reason: string
  llm?: { baseUrl: string; model: string; configured: boolean }
}

export interface AuditRecord {
  seq: number
  ts: string
  sessionId: string
  actor: string
  userText: string
  tool: string
  decision: string
  policyLevel: RiskLevel | 'unknown'
  policyRules: string[]
  result: string
}

export interface AuditView {
  records: AuditRecord[]
  chain: { ok: boolean; total: number; brokenAt: number | null; reason: string }
}

export interface BankAccountView {
  id: string
  holder: string
  cardNo: string
  balance: number
  available: number
  currency: string
}

export interface BankCardView {
  id: string
  number: string
  kind: 'debit' | 'credit'
  limitCents: number
  usedCents: number
  dailyLimitCents: number
  status: 'active' | 'locked' | 'lost'
}

export interface BankStateView {
  account: BankAccountView
  cards: BankCardView[]
  subscriptions: Array<{ id: string; name: string; amountCents: number; cycle: string; nextChargeAt: string }>
  products: Array<{ id: string; name: string; riskLevel: number; annualRateBp: number; minAmountCents: number; termDays: number }>
  policy: { transferLimitCents: number; dailyLimitCents: number; dailyCountLimit: number; confirmTtlSeconds: number }
  heldCents: number
  lockedCents: number
  billCount: number
}

export interface ToolSpec {
  tool: string
  scene: string
  label: string
  baseLevel: RiskLevel
  reversible: boolean
  description: string
}

export interface ScenarioView {
  id: string
  title: string
  pain: string
  tools: string[]
  evidence: string
}

export interface ScenarioBundle {
  scenarios: ScenarioView[]
  security: Array<{ id: string; title: string; input: string; expectation: string }>
  tools: ToolSpec[]
  dimensions: Array<{ key: string; label: string; detail: string }>
}

export interface RedTeamCaseResult {
  id: string
  kind: string
  text: string
  expect: 'block' | 'pass'
  blocked: boolean
  level: string
  rules: string[]
  ok: boolean
}

export interface RedTeamReport {
  total: number
  attackCases: number
  attackBlocked: number
  blockRate: number
  benignCases: number
  falsePositive: number
  falsePositiveRate: number
  byKind: Record<string, { total: number; blocked: number; rate: number }>
  cases: RedTeamCaseResult[]
}

/** 思考强度：off 关闭推理，low 常规，high 深度。 */
/** 技能中心摘要：字段与 runtime skill.registry.list 返回一致。 */
export interface SkillSummaryView {
  id: string
  name: string
  description: string
  tags: string[]
  category: string
  triggers: string[]
  bytes: number
  updatedAt: string
}

/** 技能详情：正文为 Markdown 源文。 */
export interface SkillDetailView extends SkillSummaryView {
  content: string
}

export type EffortLevel = 'off' | 'low' | 'high'

/** 思考强度状态与可选档位。 */
export interface EffortStatus {
  effort: EffortLevel
  options: EffortLevel[]
  model?: string
}

/** 模型问答的单轮用量。 */
export interface AskUsage {
  promptTokens: number
  completionTokens: number
  reasoningTokens: number
  calls: number
}

/** 模型问答的结果：只读问答给出正文，写操作转交编排层。 */
export interface AskResult {
  mode: 'readonly' | 'write' | 'unavailable'
  reason?: string
  loop?: {
    text: string
    stopReason: string
    steps: Array<{ step: number; calls: Array<{ name: string; ok: boolean; summary: string }> }>
    usage: AskUsage
    error?: string
  }
  chat?: BankChatReply
}

export interface BankMessage {
  id: string
  role: 'user' | 'agent'
  text: string
  ts: string
  reply?: BankChatReply
  /** 生成该回复时的推理过程，仅在模型开启思考时存在。 */
  reasoning?: string
  /** 该条回复来自规则编排还是模型问答。 */
  source?: 'deal' | 'ask'
}
/** 渠道状态：active=当前入口，ready=已配置，unconfigured=待配置。 */
export interface ChannelView {
  id: string
  name: string
  description: string
  state: 'active' | 'ready' | 'unconfigured'
  messageCount: number
  lastMessageAt?: string
}

export interface ChannelEvent {
  ts: string
  channel: string
  from: string
  direction: 'in' | 'out'
  text: string
}

export interface ChannelsStatus {
  channels: ChannelView[]
  events: ChannelEvent[]
}
