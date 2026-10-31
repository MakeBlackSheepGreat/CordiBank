<script setup lang="ts">
import { computed, ref } from 'vue'
import { DECISION_LABELS, LEVEL_LABELS, RULE_LABELS, useBank } from '../../stores/bank'

const bank = useBank()
const fxAmount = ref(100)
const fxCurrency = ref('USD')
const FX_CURRENCIES = ['USD', 'EUR', 'JPY', 'HKD', 'GBP', 'SGD', 'AUD']

const last = computed(() => bank.lastAgent?.reply ?? null)
const decision = computed(() => last.value?.decision ?? null)
const auditRows = computed(() => (bank.audit?.records ?? []).slice(-12).reverse())
const chain = computed(() => bank.audit?.chain ?? null)

function ruleLabel(rule: string): string {
  return RULE_LABELS[rule] ?? '判定规则'
}

function decisionLabel(code: string): string {
  return DECISION_LABELS[code] ?? '处理中'
}

function toolLabel(tool: string): string {
  if (tool === '' || tool === 'unknown') return '未执行'
  return bank.toolLabels[tool] ?? tool
}

function percent(value: number | undefined): string {
  if (value === undefined) return '—'
  return `${(value * 100).toFixed(0)}%`
}

async function onConvert(): Promise<void> {
  const amount = Number(fxAmount.value)
  if (!Number.isFinite(amount) || amount <= 0) return
  await bank.convertFx(amount, fxCurrency.value)
}
</script>

<template>
  <div class="right-rail">
    <aside class="right-rail__scroll">
      <section class="rail-card">
        <div class="rail-card__head">
          <h2>风险判定</h2>
          <span v-if="decision" class="state-badge" :class="decision.level === 'red' ? 'state-danger' : decision.level === 'yellow' ? 'state-warn' : 'state-ok'">
            {{ LEVEL_LABELS[decision.level] }}色
          </span>
        </div>
        <div v-if="decision === null" class="muted">发送一条消息后显示判定依据。</div>
        <template v-else>
          <div class="decision-summary">{{ decision.summary }}</div>
          <ul class="hits">
            <li v-for="(hit, index) in decision.hits" :key="`${hit.rule}-${index}`" class="hit">
              <span class="hit__rule">{{ ruleLabel(hit.rule) }}</span>
              <span class="hit__detail">{{ hit.detail }}</span>
              <span v-if="hit.delta === 'block'" class="hit__flag hit__flag--block">拦截</span>
              <span v-else-if="hit.delta === 'upgrade'" class="hit__flag hit__flag--up">升级</span>
            </li>
          </ul>
          <div v-if="decision.guidance" class="guidance">{{ decision.guidance }}</div>

          <div v-if="bank.pendingToken !== ''" class="confirm">
            <div class="confirm__preview">{{ bank.pendingPreview }}</div>
            <div class="confirm__actions">
              <button class="btn btn--primary" type="button" :disabled="bank.busy" @click="bank.confirm()">确认执行</button>
              <button class="btn" type="button" :disabled="bank.busy" @click="bank.cancel()">取消</button>
            </div>
            <div class="confirm__note">确认令牌绑定本次参数，参数变动会导致执行失败。</div>
          </div>
        </template>
      </section>

      <section class="rail-card">
        <div class="rail-card__head">
          <h2>执行链路</h2>
          <span class="rail-card__hint">三色即蜂群分工</span>
        </div>
        <ol class="chain-steps">
          <li class="chain-step">
            <span class="role-badge role-explorer">探索者</span>
            <span class="chain-step__name">意图识别</span>
            <span class="chain-step__value">{{ last === null ? '待输入' : last.scene }}</span>
          </li>
          <li class="chain-step">
            <span class="role-badge role-validator">验证者</span>
            <span class="chain-step__name">权限判定</span>
            <span class="chain-step__value">{{ decision === null ? '待判定' : `${LEVEL_LABELS[decision.level]}色` }}</span>
          </li>
          <li class="chain-step">
            <span class="role-badge role-validator">验证者</span>
            <span class="chain-step__name">人工确认</span>
            <span class="chain-step__value">{{
              bank.pendingToken !== ''
                ? '等待确认'
                : decision?.shape === 'confirmed'
                  ? '已确认'
                  : decision?.shape === 'cancelled'
                    ? '已取消'
                    : decision?.requiresConfirm
                      ? '已发出'
                      : '不需要'
            }}</span>
          </li>
          <li class="chain-step">
            <span class="role-badge role-worker">执行者</span>
            <span class="chain-step__name">工具执行</span>
            <span class="chain-step__value">{{ last?.execution === undefined ? '未执行' : toolLabel(last.execution.tool) }}</span>
          </li>
          <li class="chain-step">
            <span class="role-badge role-validator">验证者</span>
            <span class="chain-step__name">审计留痕</span>
            <span class="chain-step__value">{{ last === undefined || last === null ? '待记录' : `第 ${last.audit.seq} 条` }}</span>
          </li>
        </ol>
      </section>

      <section class="rail-card">
        <div class="rail-card__head">
          <h2>审计留痕</h2>
          <span class="state-badge" :class="chain?.ok ? 'state-ok' : 'state-danger'">
            {{ chain === null ? '未校验' : chain.ok ? '链完整' : '链异常' }}
          </span>
        </div>
        <div v-if="auditRows.length === 0" class="muted">本次会话还没有审计记录。</div>
        <ul v-else class="audit">
          <li v-for="record in auditRows" :key="record.seq" class="audit__row">
            <span class="audit__seq">{{ record.seq }}</span>
            <span class="audit__main">
              <span class="audit__decision">{{ decisionLabel(record.decision) }}</span>
              <span class="audit__tool">{{ toolLabel(record.tool) }}</span>
            </span>
            <span class="audit__dot" :class="`audit__dot--${record.policyLevel}`" />
          </li>
        </ul>
        <div class="audit__foot">
          本会话 {{ auditRows.length }} 条 · 全链 {{ chain?.total ?? 0 }} 条（含历史会话）· 卡号与手机号已脱敏
        </div>
      </section>

      <section class="rail-card">
        <div class="rail-card__head">
          <h2>工具与外部服务</h2>
          <span class="state-badge state-neutral">
            {{ bank.toolSummary ? `${bank.toolSummary.total} 个工具` : `${bank.mcpTools.length} 个工具` }}
          </span>
        </div>
        <div v-if="bank.toolSummary" class="kv">
          <div class="kv__row">
            <span>内置工具</span>
            <span class="kv__value">{{ bank.toolSummary.builtin }} 个</span>
          </div>
          <div class="kv__row">
            <span>外部工具</span>
            <span class="kv__value">{{ bank.toolSummary.mcp }} 个</span>
          </div>
        </div>
        <ul class="mcp">
          <li v-for="server in bank.mcpServers" :key="server.id" class="mcp__row">
            <div class="mcp__meta">
              <span class="mcp__name">{{ server.name }}</span>
              <span v-if="server.category !== ''" class="mcp__cat">{{ server.category }}</span>
            </div>
            <div class="mcp__ops">
              <span class="state-badge" :class="server.status === 'ready' ? 'state-ok' : server.status === 'error' ? 'state-danger' : 'state-neutral'">
                {{ server.status === 'ready' ? '已连接' : server.status === 'error' ? '异常' : '未连接' }}
              </span>
              <button
                class="btn btn--small"
                type="button"
                :disabled="bank.mcpBusy !== ''"
                @click="server.connected ? bank.disconnectMcp(server.id) : bank.connectMcp(server.id)"
              >
                {{ server.connected ? '断开' : '连接' }}
              </button>
            </div>
          </li>
        </ul>
        <div class="fx">
          <input v-model.number="fxAmount" class="fx__input" type="number" min="1" aria-label="换算金额" />
          <select v-model="fxCurrency" class="fx__select" aria-label="币种">
            <option v-for="code in FX_CURRENCIES" :key="code" :value="code">{{ code }}</option>
          </select>
          <button class="btn btn--small" type="button" :disabled="bank.fxBusy" @click="onConvert">换算</button>
        </div>
        <div v-if="bank.fxResult !== ''" class="fx__result">{{ bank.fxResult }}</div>
        <div class="muted">汇率与反诈查询由独立 MCP 服务提供，工具清单来自服务端真实返回。</div>
      </section>

      <section class="rail-card">
        <div class="rail-card__head">
          <h2>安全评测</h2>
          <button class="btn btn--small" type="button" :disabled="bank.busy" @click="bank.runRedTeam()">跑红队集</button>
        </div>
        <div v-if="bank.redteam === null" class="muted">
          40 条用例：直接注入 12 条、间接注入 8 条、越权 8 条、正常 12 条。
        </div>
        <template v-else>
          <div class="score">
            <div class="score__item">
              <div class="score__value">{{ percent(bank.redteam.blockRate) }}</div>
              <div class="score__label">攻击拦截率</div>
            </div>
            <div class="score__item">
              <div class="score__value">{{ percent(bank.redteam.falsePositiveRate) }}</div>
              <div class="score__label">误拦截率</div>
            </div>
          </div>
          <ul class="kinds">
            <li v-for="(stat, kind) in bank.redteam.byKind" :key="kind" class="kind">
              <span>{{ kind === 'direct' ? '直接注入' : kind === 'indirect' ? '间接注入' : kind === 'privilege' ? '越权操作' : '正常请求' }}</span>
              <span class="kind__value">{{ stat.blocked }}/{{ stat.total }}</span>
            </li>
          </ul>
        </template>
      </section>

      <section class="rail-card">
    <h2>渠道接入</h2>
    <p class="muted">QQ 走 OneBot v11 HTTP 上报，微信走通用 webhook 桥，均由同一套银行智能体处理。</p>
    <div v-if="bank.channels === null" class="muted">渠道状态加载中…</div>
    <template v-else>
      <ul class="chan">
        <li v-for="chan in bank.channels.channels" :key="chan.id" class="chan__row">
          <div class="chan__meta">
            <span class="chan__name">{{ chan.name }}</span>
            <span class="state-badge" :class="chan.state === 'active' ? 'state-ok' : chan.state === 'ready' ? 'state-warn' : 'state-neutral'">{{ chan.state === 'active' ? '使用中' : chan.state === 'ready' ? '已配置' : '待配置' }}</span>
          </div>
          <span class="chan__desc">{{ chan.description }}</span>
          <span class="chan__count">{{ chan.messageCount }} 条消息</span>
        </li>
      </ul>
      <div v-if="bank.channels.events.length > 0" class="chan-events">
        <div v-for="(ev, i) in bank.channels.events.slice(0, 5)" :key="i" class="chan-event">
          <span class="chan-event__dir" :class="ev.direction === 'in' ? 'is-in' : 'is-out'">{{ ev.direction === 'in' ? '收' : '发' }}</span>
          <span class="chan-event__ch">{{ ev.channel }}</span>
          <span class="chan-event__text">{{ ev.text }}</span>
        </div>
      </div>
    </template>
  </section>
  <button class="reset" type="button" :disabled="bank.busy" @click="bank.reset()">重置演示数据</button>
    </aside>
  </div>
</template>

<style scoped>
.right-rail {
  height: 100%;
  min-height: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.right-rail__scroll {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 12px;
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.rail-card {
  border: 1px solid var(--color-stroke-1);
  background: var(--color-surface-1);
  border-radius: 14px;
  padding: 11px 13px;
}

.rail-card__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  margin-bottom: 9px;
}

.rail-card__head h2 {
  margin: 0;
  font-size: var(--font-size-caption);
  font-weight: var(--font-weight-semibold);
  letter-spacing: 0.05em;
  color: var(--color-ink-2);
}

.rail-card__hint {
  font-size: var(--font-size-micro);
  color: var(--color-ink-5);
}

.muted {
  font-size: var(--font-size-micro);
  color: var(--color-ink-4);
  line-height: 1.6;
}

.decision-summary {
  font-size: var(--font-size-caption);
  line-height: 1.6;
  margin-bottom: 8px;
}

.hits {
  list-style: none;
  padding: 0;
  margin: 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.hit {
  display: grid;
  grid-template-columns: 70px minmax(0, 1fr) auto;
  gap: 6px;
  align-items: baseline;
  font-size: 11px;
  padding: 6px 8px;
  border-radius: 9px;
  background: var(--color-surface-2);
}

.hit__rule {
  color: var(--color-ink-3);
}

.hit__detail {
  color: var(--color-ink-2);
  line-height: 1.5;
}

.hit__flag {
  font-size: var(--font-size-micro);
  padding: 1px 6px;
  border-radius: 999px;
}

.hit__flag--block {
  background: var(--color-danger-soft);
  color: var(--color-danger-ink);
}

.hit__flag--up {
  background: var(--color-accent-soft);
  color: var(--color-accent-ink);
}

.guidance {
  margin-top: 8px;
  font-size: 11px;
  line-height: 1.6;
  color: var(--color-accent-ink);
  background: var(--color-accent-soft);
  border-radius: 9px;
  padding: 8px 10px;
}

.confirm {
  margin-top: 10px;
  border-top: 1px dashed var(--color-stroke-2);
  padding-top: 10px;
}

.confirm__preview {
  font-size: var(--font-size-caption);
  font-weight: var(--font-weight-semibold);
  margin-bottom: 8px;
}

.confirm__actions {
  display: flex;
  gap: 8px;
}

.btn {
  font-size: var(--font-size-caption);
  padding: 6px 14px;
  border-radius: 9px;
  border: 1px solid var(--color-stroke-2);
  background: var(--color-surface-1-solid);
  color: var(--color-ink-1);
  cursor: pointer;
}

.btn--primary {
  background: var(--color-ok);
  border-color: var(--color-ok);
  color: #fff;
}

.btn--small {
  padding: 3px 10px;
  font-size: 11px;
}

.btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.confirm__note {
  margin-top: 8px;
  font-size: var(--font-size-micro);
  color: var(--color-ink-4);
}

.chain-steps {
  list-style: none;
  padding: 0;
  margin: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.chain-step {
  display: grid;
  grid-template-columns: auto 1fr auto;
  gap: 8px;
  align-items: center;
  font-size: 11px;
  padding: 5px 0;
  border-bottom: 1px solid var(--color-stroke-1);
}

.chain-step:last-child {
  border-bottom: none;
}

.chain-step .role-badge {
  padding: 1px 7px;
  font-size: var(--font-size-micro);
}

.chain-step__name {
  color: var(--color-ink-4);
}

.chain-step__value {
  color: var(--color-ink-1);
  font-weight: var(--font-weight-medium);
  font-variant-numeric: tabular-nums;
}

.audit {
  list-style: none;
  padding: 0;
  margin: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
  max-height: 220px;
  overflow-y: auto;
}

.audit__row {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 11px;
  padding: 4px 6px;
  border-radius: 7px;
}

.audit__row:nth-child(odd) {
  background: var(--color-surface-2);
}

.audit__seq {
  width: 22px;
  color: var(--color-ink-5);
  font-variant-numeric: tabular-nums;
}

.audit__main {
  display: flex;
  gap: 8px;
  flex: 1;
  min-width: 0;
}

.audit__decision {
  color: var(--color-ink-2);
}

.audit__tool {
  color: var(--color-ink-4);
}

.audit__dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--color-ink-5);
}

.audit__dot--green { background: var(--color-ok); }
.audit__dot--yellow { background: var(--color-warn); }
.audit__dot--red { background: var(--color-danger); }

.audit__foot {
  margin-top: 8px;
  font-size: var(--font-size-micro);
  color: var(--color-ink-5);
}

.kv {
  list-style: none;
  padding: 0;
  margin: 0 0 10px;
  display: flex;
  flex-direction: column;
  gap: 4px;
  font-size: 11px;
}

.kv__row {
  display: flex;
  justify-content: space-between;
  color: var(--color-ink-2);
}

.kv__value {
  color: var(--color-ink-5);
}

.fx {
  display: flex;
  gap: 6px;
  align-items: center;
  margin-bottom: 8px;
}

.fx__input {
  width: 76px;
  height: 27px;
  padding: 0 8px;
  border-radius: 7px;
  border: 1px solid var(--color-stroke-2);
  background: var(--color-surface-2);
  font-size: 11px;
  color: var(--color-ink-1);
}

.fx__select {
  height: 27px;
  border-radius: 7px;
  border: 1px solid var(--color-stroke-2);
  background: var(--color-surface-2);
  font-size: 11px;
  color: var(--color-ink-1);
}

.fx__result {
  font-size: 11px;
  color: var(--color-accent-ink);
  background: var(--color-accent-soft);
  border-radius: 7px;
  padding: 6px 8px;
  margin-bottom: 8px;
  font-variant-numeric: tabular-nums;
}

.score {
  display: flex;
  gap: 10px;
  margin-bottom: 10px;
}

.score__item {
  flex: 1;
  background: var(--color-surface-2);
  border-radius: 10px;
  padding: 8px 10px;
}

.score__value {
  font-size: 18px;
  font-weight: var(--font-weight-semibold);
  font-variant-numeric: tabular-nums;
}

.score__label {
  font-size: var(--font-size-micro);
  color: var(--color-ink-4);
}

.kinds {
  list-style: none;
  padding: 0;
  margin: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
  font-size: 11px;
}

.kind {
  display: flex;
  justify-content: space-between;
  color: var(--color-ink-3);
}

.kind__value {
  color: var(--color-ink-1);
  font-variant-numeric: tabular-nums;
}

.reset {
  font-size: 11px;
  padding: 8px;
  border-radius: 9px;
  border: 1px dashed var(--color-stroke-2);
  background: transparent;
  color: var(--color-ink-4);
  cursor: pointer;
}

.reset:hover {
  color: var(--color-danger-ink);
  border-color: var(--color-danger);
}
.mcp {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin: 0;
  padding: 0;
  list-style: none;
}

.mcp__row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 6px 8px;
  border-radius: 10px;
  background: var(--cs-surface-inset, rgba(127, 127, 127, 0.08));
}

.mcp__meta {
  display: flex;
  align-items: baseline;
  gap: 6px;
  min-width: 0;
}

.mcp__name {
  font-weight: 600;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.mcp__cat {
  font-size: 11px;
  padding: 1px 6px;
  border-radius: 999px;
  background: var(--cs-role-worker, #d99a2b);
  color: #fff;
  flex-shrink: 0;
}

.mcp__ops {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-shrink: 0;
}


.chan {
  display: grid;
  gap: 6px;
  margin: 10px 0 0;
  padding: 0;
  list-style: none;
}

.chan__row {
  display: grid;
  gap: 2px;
  padding: 8px 10px;
  border-radius: 10px;
  background: var(--cs-surface-inset, rgba(127, 127, 127, 0.08));
}

.chan__meta {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.chan__name {
  font-weight: 600;
  font-size: 13px;
}

.chan__desc {
  font-size: 12px;
  opacity: 0.72;
}

.chan__count {
  font-size: 11px;
  opacity: 0.6;
}

.chan-events {
  display: grid;
  gap: 4px;
  margin-top: 10px;
}

.chan-event {
  display: flex;
  align-items: baseline;
  gap: 6px;
  font-size: 12px;
}

.chan-event__dir {
  flex: none;
  font-size: 10px;
  padding: 1px 5px;
  border-radius: 6px;
}

.chan-event__dir.is-in {
  background: rgba(64, 150, 238, 0.18);
  color: var(--cs-role-explorer, #4096ee);
}

.chan-event__dir.is-out {
  background: rgba(82, 196, 26, 0.16);
  color: var(--cs-role-validator, #52c41a);
}

.chan-event__ch {
  flex: none;
  opacity: 0.6;
}

.chan-event__text {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>
