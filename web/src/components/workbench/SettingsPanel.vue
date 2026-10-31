<script setup lang="ts">
/**
 * 设置面板：模型 API key 与 IM 渠道的运行时配置。
 *
 * 数据全部走 settings.get / settings.set / settings.probe 真实 RPC。
 * 服务端只回传脱敏值，因此输入框留空表示「不修改」，只有用户真正输入的字段才会提交。
 */
import { computed, ref, watch } from 'vue'
import { useBank } from '../../stores/bank'
import { settingsOpen, wizardOpen } from '../../lib/ui-bus'
import type { EffortLevel } from '../../lib/bank-types'

const bank = useBank()

const INTENT_MODES: Array<{ value: 'rule' | 'hybrid' | 'model'; label: string; hint: string }> = [
  { value: 'rule', label: '仅规则', hint: '完全不走模型，最快也最保守' },
  { value: 'hybrid', label: '规则优先', hint: '规则能识别就用规则，识别不到再问模型' },
  { value: 'model', label: '模型优先', hint: '意图全部交给模型解析，需要可用的 API key' },
]

const EFFORT_LABELS: Record<EffortLevel, string> = { off: '关闭', low: '标准', high: '深入' }

/** 表单：只保存用户本次真正输入的值，未填写的字段提交时省略。 */
const provider = ref('')
const apiKey = ref('')
const baseUrl = ref('')
const model = ref('')
const intentMode = ref<'rule' | 'hybrid' | 'model'>('hybrid')
const effort = ref<EffortLevel>('low')
const channelValues = ref<Record<string, string>>({})
const savedTip = ref('')

const view = computed(() => bank.settings)

/** 面板每次打开都把表单重置成服务端当前值，避免残留上次输入。 */
watch(settingsOpen, (open) => {
  if (!open) return
  savedTip.value = ''
  apiKey.value = ''
  baseUrl.value = ''
  model.value = ''
  channelValues.value = {}
  void bank.loadSettings().then(() => {
    const current = bank.settings
    if (current === null) return
    provider.value = current.llm.provider
    intentMode.value = current.llm.intentMode
    effort.value = current.llm.effort
  })
})

/** 选供应商时若该供应商有默认模型，提示里带出来，不自动覆盖用户已填的模型。 */
const providerHint = computed(() => {
  const hit = view.value?.providers.find((item) => item.id === provider.value)
  if (hit === undefined) return ''
  if (hit.defaultModel === undefined) return hit.keyConfigured ? '该供应商已配置环境变量密钥' : '该供应商未配置环境变量密钥'
  return hit.keyConfigured ? `默认模型 ${hit.defaultModel} · 已配置环境变量密钥` : `默认模型 ${hit.defaultModel} · 未配置环境变量密钥`
})

function close(): void {
  settingsOpen.value = false
}

/** 打开渠道接入向导：扫码在应用内完成，回来后刷新渠道状态。 */
function openWizard(): void {
  wizardOpen.value = true
}

function setChannelValue(key: string, value: string): void {
  channelValues.value = { ...channelValues.value, [key]: value }
}

async function onSave(): Promise<void> {
  savedTip.value = ''
  const llm: Record<string, string> = {}
  if (provider.value !== (view.value?.llm.provider ?? '')) llm.provider = provider.value
  if (apiKey.value.trim() !== '') llm.apiKey = apiKey.value.trim()
  if (baseUrl.value.trim() !== '') llm.baseUrl = baseUrl.value.trim()
  if (model.value.trim() !== '') llm.model = model.value.trim()
  if (intentMode.value !== (view.value?.llm.intentMode ?? 'hybrid')) llm.intentMode = intentMode.value
  if (effort.value !== (view.value?.llm.effort ?? 'low')) llm.effort = effort.value

  const channels: Record<string, string> = {}
  for (const [key, value] of Object.entries(channelValues.value)) {
    if (value.trim() !== '') channels[key] = value.trim()
  }

  const payload: Record<string, unknown> = {}
  if (Object.keys(llm).length > 0) payload.llm = llm
  if (Object.keys(channels).length > 0) payload.channels = channels
  if (Object.keys(payload).length === 0) {
    savedTip.value = '没有需要保存的改动。'
    return
  }

  const ok = await bank.saveSettings(payload)
  if (!ok) return
  apiKey.value = ''
  baseUrl.value = ''
  model.value = ''
  channelValues.value = {}
  const current = bank.settings
  if (current !== null) {
    provider.value = current.llm.provider
    intentMode.value = current.llm.intentMode
    effort.value = current.llm.effort
  }
  savedTip.value = '已保存并热生效。'
}

async function onProbe(): Promise<void> {
  savedTip.value = ''
  await bank.probeModel()
}
</script>

<template>
  <div v-if="settingsOpen" class="settings-overlay" @click.self="close">
    <section class="settings panel-solid" role="dialog" aria-label="设置">
      <header class="settings__head">
        <div>
          <h2 class="settings__title">设置</h2>
          <p class="settings__sub">模型密钥与 IM 渠道，保存即生效，无需重启</p>
        </div>
        <button class="settings__close" type="button" aria-label="关闭" @click="close">✕</button>
      </header>

      <div class="settings__body">
        <p v-if="view === null" class="settings__muted">设置加载中…</p>
        <template v-else>
          <section class="settings__group">
            <h3 class="settings__h3">模型</h3>
            <div class="field">
              <label class="field__label" for="set-provider">供应商</label>
              <select id="set-provider" v-model="provider" class="field__control">
                <option v-for="item in view.providers" :key="item.id" :value="item.id">{{ item.name }}</option>
              </select>
              <span class="field__hint">{{ providerHint }}</span>
            </div>
            <div class="field">
              <label class="field__label" for="set-key">API key</label>
              <input
                id="set-key"
                v-model="apiKey"
                class="field__control"
                type="password"
                autocomplete="off"
                :placeholder="view.llm.keyConfigured ? `已配置：${view.llm.keyMasked}（留空不修改）` : '未配置，粘贴新的 key'"
              />
              <span class="field__hint">密钥只以脱敏形式回显，落盘在服务端设置文件里。</span>
            </div>
            <div class="field-row">
              <div class="field">
                <label class="field__label" for="set-base">接口地址</label>
                <input
                  id="set-base"
                  v-model="baseUrl"
                  class="field__control"
                  type="text"
                  autocomplete="off"
                  :placeholder="view.llm.baseUrl"
                />
              </div>
              <div class="field">
                <label class="field__label" for="set-model">模型名</label>
                <input
                  id="set-model"
                  v-model="model"
                  class="field__control"
                  type="text"
                  autocomplete="off"
                  :placeholder="view.llm.model"
                />
              </div>
            </div>
            <div class="field-row">
              <div class="field">
                <label class="field__label" for="set-intent">意图模式</label>
                <select id="set-intent" v-model="intentMode" class="field__control">
                  <option v-for="item in INTENT_MODES" :key="item.value" :value="item.value">{{ item.label }}</option>
                </select>
                <span class="field__hint">{{ INTENT_MODES.find((item) => item.value === intentMode)?.hint }}</span>
              </div>
              <div class="field">
                <label class="field__label" for="set-effort">思考强度</label>
                <select id="set-effort" v-model="effort" class="field__control">
                  <option v-for="level in (['off', 'low', 'high'] as EffortLevel[])" :key="level" :value="level">
                    {{ EFFORT_LABELS[level] }}
                  </option>
                </select>
              </div>
            </div>
            <div class="probe">
              <button class="btn" type="button" :disabled="bank.settingsBusy" @click="onProbe">
                {{ bank.settingsBusy ? '探活中…' : '探活模型' }}
              </button>
              <span
                v-if="bank.probeResult !== null"
                class="state-badge"
                :class="bank.probeResult.ok ? 'state-ok' : 'state-danger'"
              >
                {{ bank.probeResult.ok ? `可用 · ${bank.probeResult.latencyMs}ms` : '不可用' }}
              </span>
              <span v-if="bank.probeResult !== null" class="probe__text">
                {{ bank.probeResult.message }}
                <template v-if="bank.probeResult.ok"> · {{ bank.probeResult.model }}</template>
              </span>
            </div>
          </section>

          <section class="settings__group">
            <div class="settings__group-head">
              <h3 class="settings__h3">IM 渠道</h3>
              <button class="btn" type="button" @click="openWizard">渠道接入向导</button>
            </div>
            <p class="settings__muted">
              微信扫码接入、QQ 官方机器人凭据接入都可以在应用内完成；也可以在这里手工填写凭据，填好并保存后热生效。字段留空表示不修改。
            </p>
            <div v-for="chan in view.channels" :key="chan.id" class="chan-card">
              <div class="chan-card__head">
                <span class="chan-card__name">{{ chan.name }}</span>
                <span class="state-badge" :class="chan.configured ? 'state-ok' : 'state-neutral'">
                  {{ chan.configured ? '已配置' : '待配置' }}
                </span>
              </div>
              <p class="chan-card__desc">{{ chan.description }}</p>
              <div v-for="field in chan.fields" :key="field.key" class="field">
                <label class="field__label" :for="`chan-${chan.id}-${field.key}`">{{ field.label }}</label>
                <input
                  :id="`chan-${chan.id}-${field.key}`"
                  class="field__control"
                  type="password"
                  autocomplete="off"
                  :value="channelValues[field.key] ?? ''"
                  :placeholder="field.valueMasked === '' ? '未配置' : `已配置：${field.valueMasked}（留空不修改）`"
                  @input="setChannelValue(field.key, ($event.target as HTMLInputElement).value)"
                />
              </div>
            </div>
          </section>
        </template>
      </div>

      <footer class="settings__foot">
        <span v-if="bank.settingsError !== ''" class="settings__error">{{ bank.settingsError }}</span>
        <span v-else-if="savedTip !== ''" class="settings__tip">{{ savedTip }}</span>
        <span v-else-if="view !== null" class="settings__path">落盘位置：{{ view.settingsFile }}</span>
        <div class="settings__actions">
          <button class="btn" type="button" @click="close">关闭</button>
          <button class="btn btn--primary" type="button" :disabled="bank.settingsBusy" @click="onSave">
            {{ bank.settingsBusy ? '保存中…' : '保存' }}
          </button>
        </div>
      </footer>
    </section>
  </div>
</template>

<style scoped>
.settings-overlay {
  position: fixed;
  inset: 0;
  z-index: 70;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
  background: rgba(15, 18, 26, 0.55);
  backdrop-filter: blur(6px);
}

.settings {
  display: flex;
  flex-direction: column;
  width: min(680px, 100%);
  max-height: min(84vh, 820px);
  border-radius: 20px;
  overflow: hidden;
}

.settings__head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
  padding: 18px 22px 12px;
  border-bottom: 1px solid var(--color-stroke-2);
}

.settings__title {
  margin: 0;
  font-size: 18px;
  font-weight: var(--font-weight-bold);
}

.settings__sub {
  margin: 3px 0 0;
  font-size: var(--font-size-caption);
  color: var(--color-ink-3);
}

.settings__close {
  flex: none;
  width: 28px;
  height: 28px;
  border-radius: 9px;
  border: 1px solid var(--color-stroke-2);
  background: transparent;
  color: var(--color-ink-3);
  cursor: pointer;
}

.settings__close:hover {
  color: var(--color-ink-1);
  border-color: var(--color-accent-line);
}

.settings__body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 6px 22px 14px;
  display: flex;
  flex-direction: column;
  gap: 18px;
}

.settings__group {
  padding-top: 12px;
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.settings__group-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
}

.settings__h3 {
  margin: 0;
  font-size: var(--font-size-caption);
  font-weight: var(--font-weight-semibold);
  letter-spacing: 0.06em;
  color: var(--color-ink-3);
}

.settings__muted {
  margin: 0;
  font-size: var(--font-size-micro);
  line-height: 1.6;
  color: var(--color-ink-4);
}

.field {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
}

.field-row {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 10px;
}

.field__label {
  font-size: var(--font-size-micro);
  color: var(--color-ink-3);
}

.field__control {
  height: 34px;
  padding: 0 10px;
  border-radius: var(--radius-control);
  border: 1px solid var(--color-stroke-2);
  background: var(--color-surface-2);
  color: var(--color-ink-1);
  font-size: var(--font-size-caption);
  min-width: 0;
}

.field__control:focus {
  outline: none;
  border-color: var(--color-accent);
}

.field__hint {
  font-size: var(--font-size-micro);
  color: var(--color-ink-5);
  line-height: 1.5;
}

.probe {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.probe__text {
  font-size: var(--font-size-micro);
  color: var(--color-ink-4);
  line-height: 1.5;
}

.chan-card {
  border: 1px solid var(--color-stroke-1);
  border-radius: 12px;
  padding: 10px 12px;
  background: var(--color-surface-1);
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.chan-card__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.chan-card__name {
  font-size: var(--font-size-ui);
  font-weight: var(--font-weight-semibold);
}

.chan-card__desc {
  margin: 0;
  font-size: var(--font-size-micro);
  line-height: 1.55;
  color: var(--color-ink-4);
}

.settings__foot {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 12px 22px 16px;
  border-top: 1px solid var(--color-stroke-2);
}

.settings__path,
.settings__tip,
.settings__error {
  font-size: var(--font-size-micro);
  line-height: 1.5;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.settings__path { color: var(--color-ink-5); }
.settings__tip { color: var(--color-ok); }
.settings__error { color: var(--color-danger-ink); }

.settings__actions {
  display: flex;
  gap: 8px;
  flex: none;
}

.btn {
  font-size: var(--font-size-caption);
  padding: 7px 16px;
  border-radius: 9px;
  border: 1px solid var(--color-stroke-2);
  background: var(--color-surface-1);
  color: var(--color-ink-1);
  cursor: pointer;
}

.btn:hover {
  border-color: var(--color-accent-line);
}

.btn--primary {
  background: var(--color-accent);
  border-color: var(--color-accent);
  color: var(--color-on-accent);
  font-weight: var(--font-weight-medium);
}

.btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

@media (max-width: 720px) {
  .field-row { grid-template-columns: minmax(0, 1fr); }
  .settings__foot { flex-direction: column; align-items: stretch; }
  .settings__actions { justify-content: flex-end; }
}
</style>
