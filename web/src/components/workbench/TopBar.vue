<script setup lang="ts">
import { ref } from 'vue'
import { useBank } from '../../stores/bank'

const bank = useBank()

const THEME_KEY = 'cordibank.theme'
const theme = ref<'light' | 'dark'>(
  document.documentElement.getAttribute('data-cs-theme') === 'dark' ? 'dark' : 'light',
)

function toggleTheme(): void {
  theme.value = theme.value === 'dark' ? 'light' : 'dark'
  document.documentElement.setAttribute('data-cs-theme', theme.value)
  localStorage.setItem(THEME_KEY, theme.value)
}

function modeLabel(mode: string): string {
  if (mode === 'model') return '模型优先'
  if (mode === 'rule') return '仅规则'
  return '规则优先'
}
</script>

<template>
  <header class="wb-top topbar">
    <div class="topbar__brand">
      <span class="topbar__hive" aria-hidden="true">
        <i></i><i></i><i></i>
      </span>
      <span class="topbar__name">CordiSwarm</span>
      <span class="topbar__theme-chip">面向金融的蜂群智能体系统</span>
    </div>

    <div class="topbar__account panel-solid">
      <div class="topbar__balance">
        <span class="topbar__balance-label">可用余额</span>
        <strong class="topbar__balance-value">{{ bank.availableText }}</strong>
        <span class="topbar__balance-unit">元</span>
      </div>
      <div class="topbar__meta">总余额 {{ bank.balanceText }} 元 · 尾号 {{ bank.cardTail }} · {{ bank.state?.account.holder ?? '—' }}</div>
    </div>

    <div class="topbar__status">
      <span class="state-badge" :class="bank.online ? 'state-ok' : 'state-danger'">
        {{ bank.online ? '运行时已连接' : '运行时未连接' }}
      </span>
      <span v-if="bank.modelStatus?.available" class="state-badge state-accent">
        {{ bank.modelStatus.model }} · {{ modeLabel(bank.modelStatus.mode) }}
      </span>
      <span v-else class="state-badge state-neutral">规则模式</span>
      <button
        class="topbar__theme"
        type="button"
        :title="theme === 'dark' ? '切换到亮色' : '切换到暗色'"
        @click="toggleTheme"
      >
        {{ theme === 'dark' ? '☾' : '☀' }}
      </button>
    </div>
  </header>
</template>

<style scoped>
.topbar {
  display: flex;
  align-items: center;
  gap: 14px;
  min-height: 0;
}

.topbar__brand {
  display: flex;
  align-items: center;
  gap: 9px;
  min-width: 0;
}

.topbar__hive {
  display: inline-flex;
  gap: 3px;
  align-items: flex-end;
  padding: 7px 9px;
  border-radius: 10px;
  background: var(--color-accent-soft);
}

.topbar__hive i {
  width: 5px;
  border-radius: 3px 3px 2px 2px;
  background: var(--color-accent);
}

.topbar__hive i:nth-child(1) { height: 9px; }
.topbar__hive i:nth-child(2) { height: 15px; opacity: 0.75; }
.topbar__hive i:nth-child(3) { height: 12px; opacity: 0.5; }

.topbar__name {
  font-size: 16px;
  font-weight: var(--font-weight-bold);
  letter-spacing: 0.02em;
}

.topbar__theme-chip {
  font-size: var(--font-size-micro);
  color: var(--color-accent-ink);
  padding: 2px 9px;
  border: 1px solid var(--color-accent-line);
  border-radius: 999px;
  white-space: nowrap;
}

.topbar__account {
  margin-left: auto;
  padding: 6px 16px;
  text-align: right;
}

.topbar__balance {
  display: flex;
  align-items: baseline;
  justify-content: flex-end;
  gap: 6px;
}

.topbar__balance-label {
  font-size: var(--font-size-caption);
  color: var(--color-ink-3);
}

.topbar__balance-value {
  font-size: 19px;
  font-variant-numeric: tabular-nums;
}

.topbar__balance-unit {
  font-size: var(--font-size-caption);
  color: var(--color-ink-3);
}

.topbar__meta {
  font-size: var(--font-size-micro);
  color: var(--color-ink-4);
}

.topbar__status {
  display: flex;
  align-items: center;
  gap: 8px;
}

.topbar__theme {
  width: 30px;
  height: 30px;
  border-radius: 9px;
  border: 1px solid var(--color-stroke-2);
  background: var(--color-surface-1);
  color: var(--color-ink-2);
  font-size: 14px;
  cursor: pointer;
}

.topbar__theme:hover {
  border-color: var(--color-accent-line);
  color: var(--color-accent-ink);
}

@media (max-width: 1280px) {
  .topbar__theme-chip { display: none; }
}
</style>
