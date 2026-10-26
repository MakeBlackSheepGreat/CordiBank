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

export interface BankMessage {
  id: string
  role: 'user' | 'agent'
  text: string
  ts: string
  reply?: BankChatReply
}
