<script setup lang="ts">
/**
 * 左栏：发起任务与查阅型信息分三个页签，同一时刻只展示一屏。
 *
 * 场景 / 技能 / 防线三者的使用频率差很大，平铺会挤占垂直空间；
 * 页签与右栏同构（rail-tabs 样式族），保证两栏切换手感一致。
 */
import { computed, ref } from 'vue'
import { useBank } from '../../stores/bank'
import { draftPrefill } from '../../lib/ui-bus'

const bank = useBank()

type LeftTab = 'scene' | 'skill' | 'guard'
const tab = ref<LeftTab>('scene')

const TABS: Array<{ id: LeftTab; label: string }> = [
  { id: 'scene', label: '场景' },
  { id: 'skill', label: '技能' },
  { id: 'guard', label: '防线' },
]

const sceneCount = computed(() => (bank.scenarios?.scenarios ?? []).length)
const guardCount = computed(() => (bank.scenarios?.security ?? []).length)

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
      <div class="left-tabs" role="tablist" aria-label="左栏视图">
        <button
          v-for="item in TABS"
          :key="item.id"
          class="left-tab"
          :class="{ 'is-on': tab === item.id }"
          type="button"
          role="tab"
          :aria-selected="tab === item.id"
          @click="tab = item.id"
        >
          {{ item.label }}
        </button>
      </div>

      <section v-if="tab === 'scene'" class="left-panel__group">
        <p class="left-panel__hint">点一条场景，把示例诉求填进输入框。</p>
        <div class="scene-list">
          <button
            v-for="item in bank.scenarios?.scenarios ?? []"
            :key="item.id"
            class="scene-card"
            type="button"
            @click="prefill(item.demo ?? item.title)"
          >
            <span class="scene-card__title">{{ item.title }}</span>
            <span class="scene-card__demo">试试：{{ item.demo ?? item.title }}</span>
          </button>
        </div>
        <p v-if="sceneCount === 0" class="left-panel__hint">场景加载中…</p>
      </section>

      <section v-else-if="tab === 'skill'" class="left-panel__group">
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
          <li v-for="item in bank.skills" :key="item.id">
            <button class="skill-item" type="button" @click="bank.openSkill(item.id)">
              <span class="skill-item__name">{{ item.name }}</span>
              <span v-if="item.category !== ''" class="skill-item__category">{{ item.category }}</span>
            </button>
          </li>
        </ul>
        <div v-if="bank.skillDetail !== null" class="skill-detail">
          <div class="skill-detail__head">
            <span class="skill-detail__name">{{ bank.skillDetail.name }}</span>
            <button class="skill-detail__close" type="button" @click="bank.closeSkill()">关闭</button>
          </div>
          <pre class="skill-detail__body">{{ bank.skillDetail.content }}</pre>
        </div>
      </section>

      <section v-else class="left-panel__group">
        <p class="left-panel__hint">输入侧与工具侧的硬约束，判定由策略引擎执行。</p>
        <ul class="guard-list">
          <li v-for="item in bank.scenarios?.security ?? []" :key="item.id" class="guard-item">
            <span class="guard-item__title">{{ item.title }}</span>
            <span class="guard-item__expect">{{ item.expectation }}</span>
          </li>
        </ul>
        <p v-if="guardCount === 0" class="left-panel__hint">防线加载中…</p>
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
  padding: 12px;
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.left-tabs {
  display: flex;
  gap: 4px;
  padding: 3px;
  border-radius: 10px;
  background: var(--color-surface-2);
}

.left-tab {
  flex: 1;
  padding: 5px 0;
  border: none;
  border-radius: 8px;
  background: transparent;
  color: var(--color-ink-4);
  font-size: var(--font-size-caption);
  cursor: pointer;
}

.left-tab.is-on {
  background: var(--color-surface-1-solid);
  color: var(--color-ink-1);
  font-weight: var(--font-weight-medium);
  box-shadow: 0 1px 3px var(--color-shadow);
}

.left-panel__group {
  display: flex;
  flex-direction: column;
  gap: 7px;
}

.left-panel__hint {
  margin: 0;
  font-size: var(--font-size-micro);
  line-height: 1.5;
  color: var(--color-ink-5);
}

.scene-list {
  display: flex;
  flex-direction: column;
  gap: 7px;
}

.scene-card {
  display: flex;
  flex-direction: column;
  gap: 2px;
  text-align: left;
  padding: 8px 11px;
  border-radius: 11px;
  border: 1px solid var(--color-stroke-1);
  background: var(--color-surface-1);
  cursor: pointer;
  transition: border-color 0.15s var(--ease-out);
}

.scene-card:hover {
  border-color: var(--color-accent-line);
}

.scene-card__title {
  font-size: var(--font-size-ui);
  font-weight: var(--font-weight-semibold);
  color: var(--color-ink-1);
}

.scene-card__demo {
  font-size: var(--font-size-micro);
  line-height: 1.5;
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
  padding: 6px 10px;
  border-radius: 9px;
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

.skill-search {
  display: flex;
  gap: 6px;
}

.skill-search__input {
  flex: 1;
  min-width: 0;
  padding: 5px 9px;
  border-radius: 9px;
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
  padding: 5px 11px;
  border-radius: 9px;
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
  gap: 4px;
}

.skill-item {
  width: 100%;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  text-align: left;
  padding: 6px 9px;
  border-radius: 9px;
  border: 1px solid var(--color-stroke-1);
  background: var(--color-surface-1);
  cursor: pointer;
}

.skill-item:hover {
  border-color: var(--color-accent-line);
}

.skill-item__name {
  font-size: var(--font-size-caption);
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

.skill-detail {
  padding: 8px 10px;
  border-radius: 11px;
  border: 1px solid var(--color-accent-line);
  background: var(--color-surface-1);
  display: flex;
  flex-direction: column;
  gap: 5px;
}

.skill-detail__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.skill-detail__name {
  font-size: var(--font-size-caption);
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

.skill-detail__body {
  margin: 0;
  max-height: 200px;
  overflow-y: auto;
  font-size: var(--font-size-micro);
  line-height: 1.6;
  color: var(--color-ink-3);
  white-space: pre-wrap;
  word-break: break-word;
}
</style>
