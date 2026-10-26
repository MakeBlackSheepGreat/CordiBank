import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import { rpc } from '../lib/rpc'
import type {
  AuditView,
  BankChatReply,
  BankMessage,
  BankStateView,
  ModelStatus,
  RedTeamReport,
  ScenarioBundle,
  ToolSpec,
} from '../lib/bank-types'

const SESSION_KEY = 'cordibank.session'

/** 决策码的中文表述：界面只展示业务语言，不出现内部枚举。 */
export const DECISION_LABELS: Record<string, string> = {
  auto_execute: '自动执行',
  pending_confirm: '等待确认',
  confirmed: '已确认执行',
  cancelled_by_user: '用户取消',
  blocked_policy: '策略拦截',
  blocked_injection: '注入拦截',
  blocked_indirect_reference: '外部内容拦截',
  blocked_untrusted_origin: '来源不可信',
  blocked_param_tamper: '参数篡改拦截',
  blocked_token_invalid: '令牌失效',
  blocked_recheck: '复核拦截',
  need_slots: '需要补充信息',
  unmatched: '未识别意图',
  executed_with_error: '执行失败',
  rejected_empty: '空输入',
  no_pending: '无待确认',
}

/** 规则码的中文表述，用于判定依据列表。 */
export const RULE_LABELS: Record<string, string> = {
  'base-level': '基础等级',
  'single-limit': '单笔限额',
  'daily-limit': '日累计限额',
  'new-payee': '首次收款人',
  'daily-count': '当日笔数',
  irreversible: '不可撤销',
  'tool-whitelist': '工具白名单',
  injection: '注入特征',
  'indirect-reference': '外部内容引用',
  'payee-origin': '收款人来源',
  'confirm-token': '确认令牌',
  'param-digest': '参数摘要',
  'slot-missing': '槽位缺失',
  'intent-miss': '未识别意图',
  'no-pending': '无待确认',
  'user-cancel': '用户取消',
  'amount-negative': '金额异常',
  'empty-input': '空输入',
}

export const LEVEL_LABELS: Record<string, string> = { green: '绿', yellow: '黄', red: '红' }

let seq = 0
function nextId(): string {
  seq += 1
  return `m${seq}`
}

export const useBank = defineStore('bank', () => {
  const sessionId = ref('')
  const online = ref(false)
  const busy = ref(false)
  const error = ref('')
  const messages = ref<BankMessage[]>([])
  const state = ref<BankStateView | null>(null)
  const audit = ref<AuditView | null>(null)
  const scenarios = ref<ScenarioBundle | null>(null)
  const redteam = ref<RedTeamReport | null>(null)
  const pendingToken = ref('')
  const pendingPreview = ref('')
  const mcpServers = ref<Array<{ id: string; name: string; transport: string; status: string; toolCount: number }>>([])
  const mcpTools = ref<Array<{ serverId: string; name: string; description: string }>>([])
  const fxResult = ref('')
  const fxBusy = ref(false)
  const modelStatus = ref<ModelStatus | null>(null)
  const toolSummary = ref<{ total: number; builtin: number; mcp: number } | null>(null)

  const toolLabels = computed<Record<string, string>>(() => {
    const map: Record<string, string> = {}
    for (const spec of (scenarios.value?.tools ?? []) as ToolSpec[]) map[spec.tool] = spec.label
    return map
  })

  const lastAgent = computed<BankMessage | null>(() => {
    for (let i = messages.value.length - 1; i >= 0; i -= 1) {
      const item = messages.value[i]
      if (item.role === 'agent' && item.reply !== undefined) return item
    }
    return null
  })

  const balanceText = computed(() => {
    if (state.value === null) return '—'
    return (state.value.account.balance / 100).toFixed(2)
  })

  const availableText = computed(() => {
    if (state.value === null) return '—'
    return (state.value.account.available / 100).toFixed(2)
  })

  const cardTail = computed(() => {
    if (state.value === null) return '----'
    return state.value.account.cardNo.slice(-4)
  })

  async function call<T>(method: string, params: unknown): Promise<T | null> {
    const res = (await rpc.call(method, params)) as { ok: boolean; result?: unknown; error?: string }
    if (!res.ok) {
      online.value = false
      error.value = res.error ?? '运行时不可达'
      return null
    }
    online.value = true
    error.value = ''
    return res.result as T
  }

  function pushAgent(reply: BankChatReply): void {
    messages.value.push({ id: nextId(), role: 'agent', text: reply.reply, ts: new Date().toISOString(), reply })
    if (reply.confirmation !== undefined) {
      pendingToken.value = reply.confirmation.token
      pendingPreview.value = reply.confirmation.preview
    } else {
      pendingToken.value = ''
      pendingPreview.value = ''
    }
  }

  async function loadMcp(): Promise<void> {
    const list = await call<{ servers: Array<{ id: string; name: string; transport: string; status: string; toolCount: number }> }>(
      'mcp.client.list',
      [],
    )
    if (list !== null) mcpServers.value = list.servers
    const tools = await call<{ tools: Array<{ serverId: string; name: string; description: string }> }>('mcp.client.tools', [])
    if (tools !== null) mcpTools.value = tools.tools
    const status = await call<ModelStatus>('bank.agent.model', [])
    if (status !== null) modelStatus.value = status
    const inventory = await call<{ total: number; items: Array<{ name: string; source: string }> }>('bank.agent.tools', [])
    if (inventory !== null) {
      toolSummary.value = {
        total: inventory.total,
        builtin: inventory.items.filter((item) => item.source === 'builtin').length,
        mcp: inventory.items.filter((item) => item.source === 'mcp').length,
      }
    }
  }

  /** 汇率换算：调用银行汇率 MCP，结果只展示服务返回的数字。 */
  async function convertFx(amount: number, currency: string): Promise<void> {
    if (fxBusy.value) return
    fxBusy.value = true
    const reply = await call<{ result: Array<{ text: string }> }>('mcp.client.call', [
      'bank-fx',
      'convert',
      { amount, base: currency, quote: 'CNY' },
    ])
    fxBusy.value = false
    if (reply === null) {
      fxResult.value = ''
      return
    }
    const text = reply.result[0]?.text ?? '{}'
    const data = JSON.parse(text) as { amount: number; base: string; quote: string; rate: number; converted: number }
    fxResult.value = `${data.amount} ${data.base} ≈ ${data.converted} ${data.quote}（1 ${data.base} = ${data.rate} ${data.quote}）`
    await loadMcp()
  }

  async function init(): Promise<void> {
    const stored = localStorage.getItem(SESSION_KEY)
    sessionId.value = stored !== null && stored !== '' ? stored : `web-${Date.now().toString(36)}`
    localStorage.setItem(SESSION_KEY, sessionId.value)
    online.value = await rpc.ping()
    const [bundle, snapshot, log] = await Promise.all([
      call<ScenarioBundle>('bank.agent.scenarios', []),
      call<BankStateView>('bank.agent.state', []),
      call<AuditView>('bank.agent.audit', [sessionId.value, 50]),
    ])
    if (bundle !== null) scenarios.value = bundle
    if (snapshot !== null) state.value = snapshot
    if (log !== null) audit.value = log
    await loadMcp()
  }

  async function refresh(): Promise<void> {
    const [snapshot, log] = await Promise.all([
      call<BankStateView>('bank.agent.state', []),
      call<AuditView>('bank.agent.audit', [sessionId.value, 50]),
    ])
    if (snapshot !== null) state.value = snapshot
    if (log !== null) audit.value = log
  }

  async function send(text: string): Promise<void> {
    const trimmed = text.trim()
    if (trimmed === '' || busy.value) return
    messages.value.push({ id: nextId(), role: 'user', text: trimmed, ts: new Date().toISOString() })
    busy.value = true
    const reply = await call<BankChatReply>('bank.agent.chat', [sessionId.value, trimmed])
    busy.value = false
    if (reply !== null) pushAgent(reply)
    await refresh()
  }

  async function confirm(): Promise<void> {
    if (busy.value || pendingToken.value === '') return
    busy.value = true
    const reply = await call<BankChatReply>('bank.agent.confirm', [sessionId.value, pendingToken.value])
    busy.value = false
    if (reply !== null) pushAgent(reply)
    await refresh()
  }

  async function cancel(): Promise<void> {
    if (busy.value) return
    busy.value = true
    const reply = await call<BankChatReply>('bank.agent.cancel', [sessionId.value])
    busy.value = false
    if (reply !== null) pushAgent(reply)
    await refresh()
  }

  async function runRedTeam(): Promise<void> {
    if (busy.value) return
    busy.value = true
    redteam.value = await call<RedTeamReport>('bank.agent.redteam', [`${sessionId.value}-rt`])
    busy.value = false
    await refresh()
  }

  async function reset(): Promise<void> {
    if (busy.value) return
    busy.value = true
    await call<{ ok: boolean }>('bank.agent.reset', [])
    messages.value = []
    pendingToken.value = ''
    pendingPreview.value = ''
    redteam.value = null
    busy.value = false
    await refresh()
  }

  return {
    sessionId,
    online,
    busy,
    error,
    messages,
    state,
    audit,
    scenarios,
    redteam,
    pendingToken,
    pendingPreview,
    mcpServers,
    mcpTools,
    fxResult,
    fxBusy,
    modelStatus,
    toolSummary,
    toolLabels,
    lastAgent,
    balanceText,
    availableText,
    cardTail,
    convertFx,
    loadMcp,
    init,
    refresh,
    send,
    confirm,
    cancel,
    runRedTeam,
    reset,
  }
})
