<script setup lang="ts">
import { helpOpen } from '../../lib/ui-bus'

const GUIDE_KEY = 'cordibank.guide.seen'

interface GuideSection {
  title: string
  tag: string
  points: string[]
}

const sections: GuideSection[] = [
  {
    title: '这是什么',
    tag: '开始',
    points: [
      'CordiSwarm 是面向金融的蜂群智能体系统：一句自然语言，完成查余额、转账、看账单、买理财、管卡片、理订阅、订生日礼遇等银行业务。',
      '蜂群三角色分工——探索者（意图识别）、执行者（工具调用）、验证者（权限判定与审计留痕），每一步都可追溯到执行链路。',
      '所有回复都来自真实 RPC 与真实服务返回；界面不注入任何示例数据。',
    ],
  },
  {
    title: '三步上手',
    tag: '快速开始',
    points: [
      '① 在下方输入框直接说话，例如「查询当前余额」「分析一下本月账单」「给王晓明转 200 元」。',
      '② 左上角切换「办理 / 问答」：办理走完整交易链路（含风控与确认），问答只读不改账。',
      '③ 点 QUICK 快捷指令或左侧「蜂群场景」卡，一键填入典型问法。',
    ],
  },
  {
    title: '六大业务场景',
    tag: '能力',
    points: [
      '转账汇款：小额走确认流程，超限额/新收款人触发风控拦截并给出人工路径。',
      '账单分析：月度账单统计、分类占比、异常交易与可疑备注检测。',
      '理财服务：产品查询、风险测评、申购赎回（按风险等级校验适当性）。',
      '卡片管理：名下卡片、挂失、锁卡解锁、申请新卡。',
      '订阅管理：自动扣费清单、退订、扣费提醒。',
      '生日跨场景联动：锁定预算、预订礼遇、兑换执行一次说清。',
    ],
  },
  {
    title: '安全机制',
    tag: '防线',
    points: [
      '权限分级：低风险自动执行、中风险需确认、高风险（改密/冻结等）强制人工路径，策略在代码层不依赖提示词。',
      '确认令牌：需要确认的操作会先给出预览，确认令牌与参数摘要绑定——参数被篡改即失效。',
      '注入防御：规则守卫 + 语义分类器双层识别指令覆盖、角色扮演、提示词套取与编码混淆。',
      '输出审查：评估模型对回复做安全复查，命中即整段截断并替换为危险提醒。',
      '审计哈希链：每一笔决策与执行都追加留痕，链条防篡改，可在右栏「审计留痕」查看。',
    ],
  },
  {
    title: '左栏与右栏',
    tag: '界面',
    points: [
      '左栏：蜂群场景（典型问法）、技能中心（业务流程配方，可搜索查看详情）、模型与工具（模型状态、内置/外部工具、MCP 服务器）。',
      '右栏·风险判定：当前操作的命中规则与处理建议，需要确认时输入或粘贴确认令牌。',
      '右栏·执行链路：意图识别 → 权限判定 → 人工确认 → 工具执行 → 审计留痕的每一步角色与结果。',
      '右栏·工具与外部服务：内置工具与 MCP 外部服务（汇率/反欺诈/产品/礼遇），可连接、断开、健康检查。',
      '右栏·安全评测：红队自评的攻击拦截率与误拦率；渠道接入：各 IM 渠道连接状态与最近收发留痕。',
    ],
  },
  {
    title: '更多入口',
    tag: '扩展',
    points: [
      'IM 渠道：微信（OpenClaw 网关）、QQ（OneBot v11）、钉钉、飞书官方回调与通用 webhook 桥，配置方法见仓库 docs/06 与 docs/07。',
      '定时任务：可通过 scheduler 创建每日/间隔任务，自动执行业务提示并留痕。',
      '右上角 ☀/☾ 切换亮暗主题，偏好会记住；顶栏徽章实时显示运行时连接与模型状态。',
      '一键演示与安全评测：node scripts/demo.mjs 与 node scripts/evaluate.mjs（见仓库 README）。',
    ],
  },
]

function close(): void {
  helpOpen.value = false
  try {
    localStorage.setItem(GUIDE_KEY, '1')
  } catch {
    /* 隐私模式下忽略 */
  }
}

</script>

<template>
  <div v-if="helpOpen" class="guide-overlay" @click.self="close">
    <section class="guide panel-solid" role="dialog" aria-label="功能指南">
      <header class="guide__head">
        <div>
          <h2 class="guide__title">欢迎使用 CordiSwarm</h2>
          <p class="guide__sub">面向金融的蜂群智能体系统 · 新手指南</p>
        </div>
        <button class="guide__close" type="button" @click="close">开始使用</button>
      </header>
      <div class="guide__body">
        <section v-for="s in sections" :key="s.title" class="guide__section">
          <h3 class="guide__h3">
            <span class="guide__tag">{{ s.tag }}</span>{{ s.title }}
          </h3>
          <ul class="guide__list">
            <li v-for="p in s.points" :key="p">{{ p }}</li>
          </ul>
        </section>
      </div>
      <footer class="guide__foot">本指南可随时从右上角「指南」按钮再次打开。</footer>
    </section>
  </div>
</template>

<style scoped>
.guide-overlay {
  position: fixed;
  inset: 0;
  z-index: 60;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
  background: rgba(15, 18, 26, 0.55);
  backdrop-filter: blur(6px);
}

.guide {
  display: flex;
  flex-direction: column;
  width: min(860px, 100%);
  max-height: min(82vh, 780px);
  border-radius: 22px;
  overflow: hidden;
}

.guide__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding: 22px 26px 14px;
  border-bottom: 1px solid var(--color-stroke-2);
}

.guide__title {
  margin: 0;
  font-size: 20px;
  font-weight: var(--font-weight-bold);
}

.guide__sub {
  margin: 4px 0 0;
  font-size: var(--font-size-caption);
  color: var(--color-ink-3);
}

.guide__close {
  flex-shrink: 0;
  padding: 9px 18px;
  border: none;
  border-radius: 12px;
  background: var(--color-accent);
  color: #fff;
  font-size: var(--font-size-caption);
  font-weight: var(--font-weight-bold);
  cursor: pointer;
}

.guide__close:hover { filter: brightness(1.08); }

.guide__body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 8px 26px 18px;
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 4px 26px;
}

.guide__section { padding: 12px 0; }

.guide__h3 {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 0 0 8px;
  font-size: 14px;
  font-weight: var(--font-weight-bold);
}

.guide__tag {
  padding: 2px 8px;
  border-radius: 999px;
  background: var(--color-accent-soft);
  color: var(--color-accent-ink);
  font-size: var(--font-size-micro);
  font-weight: var(--font-weight-bold);
}

.guide__list {
  margin: 0;
  padding: 0;
  list-style: none;
  display: grid;
  gap: 6px;
}

.guide__list li {
  position: relative;
  padding-left: 14px;
  font-size: var(--font-size-caption);
  line-height: 1.65;
  color: var(--color-ink-2);
}

.guide__list li::before {
  content: '';
  position: absolute;
  left: 0;
  top: 8px;
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--color-accent);
  opacity: 0.7;
}

.guide__foot {
  padding: 10px 26px 16px;
  border-top: 1px solid var(--color-stroke-2);
  font-size: var(--font-size-micro);
  color: var(--color-ink-4);
}

@media (max-width: 860px) {
  .guide__body { grid-template-columns: 1fr; }
}
</style>