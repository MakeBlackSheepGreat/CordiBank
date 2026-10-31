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

/** 蜂群角色：与运行时 bank/swarm.ts 的 SwarmRole 一一对应。 */
export type SwarmRole = 'intent' | 'risk' | 'compliance' | 'experience' | 'arbiter' | 'executor' | 'auditor'

/** 一次协同的一步，字段与运行时返回一致，界面据此展示分工。 */
export interface SwarmStep {
  role: SwarmRole
  label: string
  input: string
  output: string
  level: RiskLevel | 'none'
  elapsedMs: number
  ok: boolean
}

/** 协同轨迹：只有走蜂群入口时存在。 */
export interface SwarmTrace {
  steps: SwarmStep[]
  /** 并行分支数，当前为三个评估器。 */
  parallel: number
  totalMs: number
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
  /** 蜂群协同轨迹：界面据此展示七角色分工。 */
  trace?: SwarmTrace
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
  /** 可直接发送的示例问法，由服务端从演示剧本取第一条用户台词。 */
  demo?: string
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
  /** 该条回复来自规则编排、蜂群协同还是模型问答。 */
  source?: 'deal' | 'swarm' | 'ask'
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

/** 设置视图：字段与 runtime plugins/settings.ts 的 SettingsView 一致，密钥只以脱敏形式出现。 */
export interface LlmSettingsView {
  provider: string
  providerName: string
  model: string
  baseUrl: string
  api: string
  keyConfigured: boolean
  keyMasked: string
  effort: EffortLevel
  intentMode: 'rule' | 'hybrid' | 'model'
  toolScope: 'all' | 'scene'
}

/** 供应商选项：设置面板的下拉数据。 */
export interface ProviderOptionView {
  id: string
  name: string
  defaultModel?: string
  keyConfigured: boolean
  active: boolean
}

/** 渠道字段：值一律脱敏，空串表示未配置。 */
export interface ChannelFieldView {
  key: string
  label: string
  valueMasked: string
}

/** IM 渠道设置项。 */
export interface ChannelSettingsView {
  id: string
  name: string
  description: string
  configured: boolean
  fields: ChannelFieldView[]
}

/** 设置总视图。 */
export interface SettingsView {
  llm: LlmSettingsView
  providers: ProviderOptionView[]
  channels: ChannelSettingsView[]
  settingsFile: string
}

/** 模型探活结果。 */
export interface ProbeResult {
  ok: boolean
  latencyMs: number
  model: string
  endpoint: string
  message: string
}

/** 微信扫码：ilink 取码结果，imageUrl 由前端渲染成二维码。 */
export interface IlinkQr {
  qrcode: string
  imageUrl: string
}

/** 微信扫码状态：wait 未扫 / scaned 已扫 / need_verifycode 需数字校验 / confirmed 已确认。 */
export type IlinkQrStatus = 'wait' | 'scaned' | 'need_verifycode' | 'expired' | 'confirmed' | 'binded'

/** 一次微信扫码轮询的回包。 */
export interface IlinkQrStatusView {
  status: IlinkQrStatus
  botToken: string
  accountId: string
  baseUrl: string
  userId: string
  message: string
}

/** 微信渠道在向导里的运行视图。 */
export interface WechatWizardView {
  connected: boolean
  accountId: string
  running: boolean
  messageCount: number
  lastMessageAt: string
  error: string
}

/** QQ 官方机器人在向导里的运行视图。 */
export interface QqWizardView {
  configured: boolean
  appId: string
  connected: boolean
  messageCount: number
  lastMessageAt: string
  lastError: string
  message: string
  portalUrl: string
}

/** 渠道接入向导总视图。 */
export interface WizardState {
  wechat: WechatWizardView
  qq: QqWizardView
  dataDir: string
}

