<script setup lang="ts">
/**
 * 渠道接入向导：微信与 QQ 的接入都在应用内完成，不打开任何外部窗口。
 *
 * 微信走腾讯 ilink 官方接口：后端取回 qrcode_img_content，前端渲染成二维码，
 * 扫码状态由后端长轮询驱动，这里串行排程，绝不并发重复请求。
 * QQ 走官方机器人开放平台：填 AppID 与 AppSecret，后端换 access_token 后保持
 * WebSocket 长连接收发，凭证校验失败不落盘。
 */
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import qrcode from 'qrcode-generator'
import { useBank } from '../../stores/bank'
import { wizardOpen } from '../../lib/ui-bus'

const bank = useBank()

/** 微信扫码状态的中文表述。 */
const WECHAT_STATUS_TEXT: Record<string, string> = {
  wait: '等待扫码',
  scaned: '已扫码，请在手机上确认',
  need_verifycode: '需要输入手机微信上的数字码',
  expired: '二维码已过期，正在刷新',
  confirmed: '已确认，正在接入',
  binded: '该微信号已绑定过本应用',
}

const verifyCode = ref('')
const qrSvg = ref('')
/** QQ 官方机器人的凭证输入，已保存时用后端返回的 appId 回填。 */
const qqAppId = ref('')
const qqAppSecret = ref('')
let wechatTimer: number | null = null
let refreshTimer: number | null = null
let wechatRefreshed = 0

const view = computed(() => bank.wizard)
const wechat = computed(() => view.value?.wechat ?? null)
const qq = computed(() => view.value?.qq ?? null)
const busy = computed(() => bank.wizardBusy !== '')
const busyText = computed(() => {
  const map: Record<string, string> = {
    wechatQr: '正在取微信二维码…',
    wechatPoll: '等待微信扫码…',
    wechatLogout: '正在退出微信…',
    qqSave: '正在校验 QQ 机器人凭证…',
    qqConnect: '正在建立 QQ 长连接…',
    qqDisconnect: '正在断开 QQ 长连接…',
  }
  return map[bank.wizardBusy] ?? ''
})

/** 把一段文本渲染成内联 SVG 二维码，失败时返回空串由界面显示占位。 */
function renderQr(text: string, cellSize: number): string {
  if (text === '') return ''
  try {
    const qr = qrcode(0, 'M')
    qr.addData(text)
    qr.make()
    return qr.createSvgTag({ cellSize, margin: 2, scalable: true })
  } catch {
    return ''
  }
}

function clearWechatTimer(): void {
  if (wechatTimer !== null) {
    window.clearTimeout(wechatTimer)
    wechatTimer = null
  }
}

function clearRefreshTimer(): void {
  if (refreshTimer !== null) {
    window.clearTimeout(refreshTimer)
    refreshTimer = null
  }
}

/** 面板打开期间每 5 秒重读一次真实状态：消息计数与长连接状态都由后端给出。 */
function scheduleRefresh(): void {
  clearRefreshTimer()
  refreshTimer = window.setTimeout(() => {
    refreshTimer = null
    void bank.loadWizard()
  }, 5000)
}

/** 串行轮询微信扫码状态：一次返回后再排下一次，避免并发打满长轮询。 */
function scheduleWechatPoll(code = ''): void {
  clearWechatTimer()
  wechatTimer = window.setTimeout(() => {
    wechatTimer = null
    void pollWechat(code)
  }, 400)
}

async function pollWechat(code: string): Promise<void> {
  const status = await bank.wizardWechatPoll(code)
  if (status === null) return
  if (status.status === 'expired') {
    if (wechatRefreshed >= 3) return
    wechatRefreshed += 1
    await bank.wizardWechatQr()
    qrSvg.value = renderQr(bank.wechatQr?.imageUrl ?? '', 6)
    if (bank.wechatQr !== null) scheduleWechatPoll('')
    return
  }
  if (status.status === 'confirmed' || status.status === 'binded') {
    wechatRefreshed = 0
    verifyCode.value = ''
    qrSvg.value = ''
    return
  }
  scheduleWechatPoll('')
}

async function onWechatQr(): Promise<void> {
  clearWechatTimer()
  wechatRefreshed = 0
  verifyCode.value = ''
  await bank.wizardWechatQr()
  qrSvg.value = renderQr(bank.wechatQr?.imageUrl ?? '', 6)
  if (bank.wechatQr !== null) scheduleWechatPoll('')
}

async function onWechatVerify(): Promise<void> {
  const code = verifyCode.value.trim()
  if (code === '') return
  clearWechatTimer()
  await pollWechat(code)
}

async function onWechatLogout(): Promise<void> {
  clearWechatTimer()
  qrSvg.value = ''
  verifyCode.value = ''
  await bank.wizardWechatLogout()
}

/** QQ：保存并校验凭证。成功时清空输入框（密钥不再留在前端内存里）。 */
async function onQqSave(): Promise<void> {
  const appId = qqAppId.value.trim()
  const appSecret = qqAppSecret.value.trim()
  if (appId === '' || appSecret === '') return
  await bank.wizardQqSave(appId, appSecret)
  if (bank.wizardError !== '') return
  qqAppSecret.value = ''
}

async function onQqConnect(): Promise<void> {
  await bank.wizardQqConnect()
}

async function onQqDisconnect(): Promise<void> {
  await bank.wizardQqDisconnect()
}

function openPortal(): void {
  const url = qq.value?.portalUrl ?? ''
  if (url !== '') window.open(url, '_blank', 'noopener')
}

function close(): void {
  clearWechatTimer()
  clearRefreshTimer()
  wizardOpen.value = false
}

/** 面板每次打开都重新拉一遍真实状态，并自动接续未完成的微信扫码流程。 */
watch(wizardOpen, (open) => {
  if (!open) {
    clearWechatTimer()
    clearRefreshTimer()
    return
  }
  void bank.loadWizard().then(() => {
    qqAppId.value = qq.value?.appId ?? ''
    qqAppSecret.value = ''
    scheduleRefresh()
  })
})

onBeforeUnmount(() => {
  clearWechatTimer()
  clearRefreshTimer()
})
</script>
<template>
  <div v-if="wizardOpen" class="wizard-overlay" @click.self="close">
    <section class="wizard panel-solid" role="dialog" aria-label="渠道接入向导">
      <header class="wizard__head">
        <div>
          <h2 class="wizard__title">渠道接入向导</h2>
          <p class="wizard__sub">微信扫码与 QQ 官方机器人都在应用内接入，不需要打开外部程序或命令行窗口</p>
        </div>
        <button class="wizard__close" type="button" aria-label="关闭" @click="close">✕</button>
      </header>

      <div class="wizard__body">
        <p v-if="view === null" class="wizard__muted">向导状态加载中…</p>
        <template v-else>
          <section class="wiz-card">
            <div class="wiz-card__head">
              <span class="wiz-card__name">微信</span>
              <span class="state-badge" :class="wechat?.connected ? 'state-ok' : 'state-neutral'">
                {{ wechat?.connected ? '已接入' : '待接入' }}
              </span>
            </div>
            <p class="wiz-card__desc">
              走腾讯 ilink 官方接口：后端取登录二维码，手机微信扫码确认后自动落盘机器人令牌并开始收发。
            </p>

            <div v-if="!wechat?.connected" class="wiz-actions">
              <button class="btn" type="button" :disabled="busy" @click="onWechatQr">
                {{ busy && bank.wizardBusy === 'wechatQr' ? '正在取码…' : '生成登录二维码' }}
              </button>
              <span v-if="bank.wechatStatus !== null" class="wiz-status">
                {{ WECHAT_STATUS_TEXT[bank.wechatStatus.status] ?? bank.wechatStatus.status }}
                <template v-if="bank.wechatStatus.message !== ''"> · {{ bank.wechatStatus.message }}</template>
              </span>
            </div>

            <div v-if="qrSvg !== '' && !wechat?.connected" class="wiz-qr">
              <div class="wiz-qr__code" v-html="qrSvg" />
              <p class="wiz-qr__hint">用手机微信扫一扫，扫完在手机上点确认</p>
            </div>

            <div v-if="bank.wechatStatus?.status === 'need_verifycode'" class="wiz-verify">
              <label class="field__label" for="wiz-verify">手机微信上显示的数字码</label>
              <div class="wiz-verify__row">
                <input
                  id="wiz-verify"
                  v-model="verifyCode"
                  class="field__control"
                  type="text"
                  inputmode="numeric"
                  autocomplete="off"
                  placeholder="输入 4-6 位数字"
                />
                <button class="btn btn--primary" type="button" :disabled="busy" @click="onWechatVerify">提交</button>
              </div>
            </div>

            <div v-if="wechat?.connected" class="wiz-actions">
              <span class="wiz-status">
                机器人账号 {{ wechat.accountId }} · {{ wechat.running ? '收发中' : '已停止' }} ·
                已收 {{ wechat.messageCount }} 条
                <template v-if="wechat.lastMessageAt !== ''"> · 最近 {{ wechat.lastMessageAt }}</template>
              </span>
              <button class="btn" type="button" :disabled="busy" @click="onWechatLogout">退出接入</button>
            </div>
            <p v-if="wechat?.error !== ''" class="wiz-error">{{ wechat?.error }}</p>
          </section>

          <section class="wiz-card">
            <div class="wiz-card__head">
              <span class="wiz-card__name">QQ 官方机器人</span>
              <span class="state-badge" :class="qq?.connected ? 'state-ok' : qq?.configured ? 'state-warn' : 'state-neutral'">
                {{ qq?.connected ? '已连接' : qq?.configured ? '已配置' : '待接入' }}
              </span>
            </div>
            <p class="wiz-card__desc">
              走 QQ 开放平台官方机器人：填 AppID 与 AppSecret，后端换 access_token 后保持 WebSocket 长连接，
              群 @ 与单聊消息直接进银行 Agent，回复走官方发消息接口。
            </p>

            <div class="wiz-form">
              <label class="field__label" for="wiz-qq-appid">AppID</label>
              <input
                id="wiz-qq-appid"
                v-model="qqAppId"
                class="field__control"
                type="text"
                autocomplete="off"
                placeholder="开放平台机器人 AppID"
              />
              <label class="field__label" for="wiz-qq-secret">AppSecret</label>
              <input
                id="wiz-qq-secret"
                v-model="qqAppSecret"
                class="field__control"
                type="password"
                autocomplete="off"
                :placeholder="qq?.configured ? '已保存，留空则不修改' : '开放平台机器人 AppSecret'"
              />
            </div>

            <div class="wiz-actions">
              <button class="btn btn--primary" type="button" :disabled="busy || qqAppId.trim() === '' || qqAppSecret.trim() === ''" @click="onQqSave">
                保存并校验
              </button>
              <button
                class="btn"
                type="button"
                :disabled="busy || qq?.configured !== true || qq?.connected === true"
                @click="onQqConnect"
              >
                连接 QQ
              </button>
              <button class="btn" type="button" :disabled="busy || qq?.connected !== true" @click="onQqDisconnect">
                断开
              </button>
              <button class="btn" type="button" :disabled="busy" @click="openPortal">打开开放平台</button>
            </div>

            <div class="wiz-actions">
              <span v-if="qq?.configured === true" class="wiz-status">机器人 {{ qq?.appId }}</span>
              <span v-if="qq?.connected === true" class="wiz-status">
                {{ qq?.connected ? '长连接在线' : '离线' }} · 已收 {{ qq?.messageCount }} 条
                <template v-if="(qq?.lastMessageAt ?? '') !== ''"> · 最近 {{ qq?.lastMessageAt }}</template>
              </span>
            </div>
            <p v-if="(qq?.lastError ?? '') !== ''" class="wiz-error">{{ qq?.lastError }}</p>
            <p v-if="(qq?.message ?? '') !== ''" class="wiz-status">{{ qq?.message }}</p>
          </section>

          <p class="wizard__muted">数据目录：{{ view.dataDir }}</p>
        </template>
      </div>

      <footer class="wizard__foot">
        <span v-if="bank.wizardError !== ''" class="wizard__error">{{ bank.wizardError }}</span>
        <span v-else-if="busyText !== ''" class="wizard__tip">{{ busyText }}</span>
        <span v-else class="wizard__tip">微信二维码由后端实时取回；QQ 凭证由后端向开放平台换 token 后校验。</span>
        <div class="wizard__actions">
          <button class="btn" type="button" @click="close">关闭</button>
        </div>
      </footer>
    </section>
  </div>
</template>

<style scoped>
.wizard-overlay {
  position: fixed;
  inset: 0;
  z-index: 75;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
  background: rgba(15, 18, 26, 0.55);
  backdrop-filter: blur(6px);
}

.wizard {
  display: flex;
  flex-direction: column;
  width: min(720px, 100%);
  max-height: min(86vh, 840px);
  border-radius: 20px;
  overflow: hidden;
}

.wizard__head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
  padding: 18px 22px 12px;
  border-bottom: 1px solid var(--color-stroke-2);
}

.wizard__title {
  margin: 0;
  font-size: 18px;
  font-weight: var(--font-weight-bold);
}

.wizard__sub {
  margin: 3px 0 0;
  font-size: var(--font-size-caption);
  color: var(--color-ink-3);
}

.wizard__close {
  flex: none;
  width: 28px;
  height: 28px;
  border-radius: 9px;
  border: 1px solid var(--color-stroke-2);
  background: transparent;
  color: var(--color-ink-3);
  cursor: pointer;
}

.wizard__close:hover {
  color: var(--color-ink-1);
  border-color: var(--color-accent-line);
}

.wizard__body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 14px 22px 16px;
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.wizard__muted {
  margin: 0;
  font-size: var(--font-size-micro);
  line-height: 1.6;
  color: var(--color-ink-4);
  word-break: break-all;
}

.wiz-card {
  border: 1px solid var(--color-stroke-1);
  border-radius: 12px;
  padding: 12px 14px;
  background: var(--color-surface-1);
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.wiz-card__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.wiz-card__name {
  font-size: var(--font-size-ui);
  font-weight: var(--font-weight-semibold);
}

.wiz-card__desc {
  margin: 0;
  font-size: var(--font-size-micro);
  line-height: 1.6;
  color: var(--color-ink-4);
}

.wiz-actions {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.wiz-status {
  font-size: var(--font-size-micro);
  line-height: 1.5;
  color: var(--color-ink-4);
}

.wiz-error {
  margin: 0;
  font-size: var(--font-size-micro);
  color: var(--color-danger-ink);
}

.wiz-qr {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  padding: 10px 0 4px;
}

.wiz-qr__code {
  width: 176px;
  height: 176px;
  padding: 8px;
  border-radius: 10px;
  background: #fff;
}

.wiz-qr__code :deep(svg) {
  display: block;
  width: 100%;
  height: 100%;
}

.wiz-qr__hint {
  margin: 0;
  font-size: var(--font-size-micro);
  color: var(--color-ink-4);
}

.wiz-verify {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.wiz-verify__row {
  display: flex;
  gap: 8px;
}

.wiz-verify__row .field__control {
  flex: 1;
  min-width: 0;
}

.wiz-form {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.wizard__foot {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 12px 22px 16px;
  border-top: 1px solid var(--color-stroke-2);
}

.wizard__tip,
.wizard__error {
  font-size: var(--font-size-micro);
  line-height: 1.5;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.wizard__tip { color: var(--color-ink-5); }
.wizard__error { color: var(--color-danger-ink); }

.wizard__actions {
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
}

.field__control:focus {
  outline: none;
  border-color: var(--color-accent);
}

@media (max-width: 720px) {
  .wizard__foot { flex-direction: column; align-items: stretch; }
  .wizard__actions { justify-content: flex-end; }
}
</style>
