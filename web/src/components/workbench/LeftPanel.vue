<script setup lang="ts">
import { ref } from 'vue'
import { useBank } from '../../stores/bank'
import { draftPrefill } from '../../lib/ui-bus'

const bank = useBank()

/** 点场景卡片把示例诉求填进输入框，数据全部来自服务端 scenarios 返回。 */
function prefill(text: string): void {
  draftPrefill.value = text
}

/** 技能中心：搜索词为空时回全量列表，搜索走 skill.registry.search。 */
const skillQuery = ref('')

function searchSkills(): void {
  void bank.loadSkills(skillQuery.value)
}
</script>

<template>
  <div class="left-panel">
    <aside class="left-panel__scroll">
      <section class="left-panel__group">
        <h2 class="left-panel__title">蜂群场景</h2>
        <p class="left-panel__hint">点一条场景，把诉求填进输入框。</p>
        <div class="scene-list">
          <button
            v-for="item in bank.scenarios?.scenarios ?? []"
            :key="item.id"
            class="scene-card"
            type="button"
            @click="prefill(item.pain)"
          >
            <span class="scene-card__title">{{ item.title }}</span>
            <span class="scene-card__pain">{{ item.pain }}</span>
          </button>
        </div>
      </section>

      <section class="left-panel__group">
        <h2 class="left-panel__title">安全防线</h2>
        <ul class="guard-list">
          <li v-for="item in bank.scenarios?.security ?? []" :key="item.id" class="guard-item">
            <span class="guard-item__title">{{ item.title }}</span>
            <span class="guard-item__expect">{{ item.expectation }}</span>
          </li>
        </ul>
      </section>

      <section class="left-panel__group">
        <h2 class="left-panel__title">技能中心</h2>
        <div class="skill-search">
          <input
            v-model="skillQuery"
            class="skill-search__input"
            type="search"
            placeholder="搜技能：转账 / 对账 / 汇率…"
            @keydown.enter.prevent="searchSkills"
          />
          <button class="skill-search__btn" type="button" @click="searchSkills">搜索</button>
        </div>
        <p v-if="bank.skillsLoading" class="left-panel__hint">技能加载中…</p>
        <p v-else-if="bank.skills.length === 0" class="left-panel__hint">没有匹配的技能。</p>
        <ul v-else class="skill-list">
          <li v-for="item in bank.skills" :key="item.id" class="skill-item">
            <button class="skill-item__open" type="button" @click="bank.openSkill(item.id)">
              <span class="skill-item__head">
                <span class="skill-item__name">{{ item.name }}</span>
                <span v-if="item.category !== ''" class="skill-item__category">{{ item.category }}</span>
              </span>
              <span class="skill-item__desc">{{ item.description }}</span>
            </button>
          </li>
        </ul>
        <div v-if="bank.skillDetail !== null" class="skill-detail">
          <div class="skill-detail__head">
            <span class="skill-detail__name">{{ bank.skillDetail.name }}</span>
            <button class="skill-detail__close" type="button" @click="bank.closeSkill()">关闭</button>
          </div>
          <span v-if="bank.skillDetail.category !== ''" class="skill-item__category">{{ bank.skillDetail.category }}</span>
          <pre class="skill-detail__body">{{ bank.skillDetail.content }}</pre>
        </div>
      </section>

      <section class="left-panel__group">
        <h2 class="left-panel__title">模型与工具</h2>
        <div class="model-card">
          <div class="model-card__row">
            <span>模型</span>
            <span class="model-card__value">{{ bank.modelStatus?.available ? bank.modelStatus.model : '规则模式' }}</span>
          </div>
          <div class="model-card__row">
            <span>工具总数</span>
            <span class="model-card__value">{{ bank.toolSummary?.total ?? bank.mcpTools.length }}</span>
          </div>
          <div class="model-card__row">
            <span>外部服务</span>
            <span class="model-card__value">{{ bank.mcpServers.length }}</span>
          </div>
        </div>
      </section>
    </aside>
  </div>
</template>

<style scoped>
.left-panel {
  height: 100%;
  min-height: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.left-panel__scroll {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 14px 12px;
  display: flex;
  flex-direction: column;
  gap: 18px;
}

.left-panel__title {
  margin: 0 0 4px;
  font-size: var(--font-size-caption);
  font-weight: var(--font-weight-semibold);
  letter-spacing: 0.06em;
  color: var(--color-ink-3);
}

.left-panel__hint {
  margin: 0 0 8px;
  font-size: var(--font-size-micro);
  color: var(--color-ink-5);
}

.scene-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.scene-card {
  display: flex;
  flex-direction: column;
  gap: 3px;
  text-align: left;
  padding: 9px 11px;
  border-radius: 12px;
  border: 1px solid var(--color-stroke-1);
  background: var(--color-surface-1);
  cursor: pointer;
  transition: border-color 0.15s var(--ease-out), transform 0.15s var(--ease-out);
}

.scene-card:hover {
  border-color: var(--color-accent-line);
  transform: translateY(-1px);
}

.scene-card__title {
  font-size: var(--font-size-ui);
  font-weight: var(--font-weight-semibold);
  color: var(--color-ink-1);
}

.scene-card__pain {
  font-size: var(--font-size-micro);
  line-height: 1.55;
  color: var(--color-ink-4);
}

.guard-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.guard-item {
  padding: 7px 10px;
  border-radius: 10px;
  background: var(--color-surface-2);
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.guard-item__title {
  font-size: var(--font-size-caption);
  font-weight: var(--font-weight-medium);
  color: var(--color-ink-2);
}

.guard-item__expect {
  font-size: var(--font-size-micro);
  color: var(--color-ink-4);
  line-height: 1.5;
}

.model-card {
  display: flex;
  flex-direction: column;
  gap: 5px;
  padding: 9px 11px;
  border: 1px dashed var(--color-stroke-2);
  border-radius: 12px;
}

.model-card__row {
  display: flex;
  justify-content: space-between;
  font-size: var(--font-size-caption);
  color: var(--color-ink-4);
}

.model-card__value {
  color: var(--color-ink-1);
  font-weight: var(--font-weight-medium);
}

.skill-search {
  display: flex;
  gap: 6px;
  margin-bottom: 8px;
}

.skill-search__input {
  flex: 1;
  min-width: 0;
  padding: 6px 9px;
  border-radius: 10px;
  border: 1px solid var(--color-stroke-1);
  background: var(--color-surface-1);
  color: var(--color-ink-1);
  font-size: var(--font-size-caption);
}

.skill-search__input:focus {
  outline: none;
  border-color: var(--color-accent-line);
}

.skill-search__btn {
  padding: 6px 11px;
  border-radius: 10px;
  border: 1px solid var(--color-stroke-1);
  background: var(--color-surface-2);
  color: var(--color-ink-2);
  font-size: var(--font-size-caption);
  cursor: pointer;
}

.skill-search__btn:hover {
  border-color: var(--color-accent-line);
}

.skill-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.skill-item__open {
  width: 100%;
  display: flex;
  flex-direction: column;
  gap: 3px;
  text-align: left;
  padding: 8px 10px;
  border-radius: 10px;
  border: 1px solid var(--color-stroke-1);
  background: var(--color-surface-1);
  cursor: pointer;
}

.skill-item__open:hover {
  border-color: var(--color-accent-line);
}

.skill-item__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.skill-item__name {
  font-size: var(--font-size-caption);
  font-weight: var(--font-weight-semibold);
  color: var(--color-ink-1);
}

.skill-item__category {
  flex: none;
  font-size: var(--font-size-micro);
  padding: 1px 7px;
  border-radius: 999px;
  background: var(--color-surface-2);
  color: var(--color-ink-3);
}

.skill-item__desc {
  font-size: var(--font-size-micro);
  color: var(--color-ink-4);
  line-height: 1.5;
}

.skill-detail {
  margin-top: 8px;
  padding: 9px 11px;
  border-radius: 12px;
  border: 1px solid var(--color-accent-line);
  background: var(--color-surface-1);
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.skill-detail__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.skill-detail__name {
  font-size: var(--font-size-ui);
  font-weight: var(--font-weight-semibold);
  color: var(--color-ink-1);
}

.skill-detail__close {
  border: none;
  background: none;
  color: var(--color-ink-4);
  font-size: var(--font-size-micro);
  cursor: pointer;
}

.skill-detail__close:hover {
  color: var(--color-ink-1);
}

.skill-detail__body {
  margin: 0;
  max-height: 220px;
  overflow-y: auto;
  font-size: var(--font-size-micro);
  line-height: 1.6;
  color: var(--color-ink-3);
  white-space: pre-wrap;
  word-break: break-word;
}
</style>
