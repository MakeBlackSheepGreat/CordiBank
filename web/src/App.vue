<script setup lang="ts">
import { onMounted } from 'vue'
import { useBank } from './stores/bank'
import { helpOpen } from './lib/ui-bus'
import SwarmParticles from './components/workbench/SwarmParticles.vue'
import TopBar from './components/workbench/TopBar.vue'
import LeftPanel from './components/workbench/LeftPanel.vue'
import Conversation from './components/workbench/Conversation.vue'
import RightRail from './components/workbench/RightRail.vue'
import HelpGuide from './components/workbench/HelpGuide.vue'

const bank = useBank()

onMounted(() => {
  void bank.init()
  // 首次启动默认弹出功能指南，读过之后只从右上角按钮进入。
  try {
    if (localStorage.getItem('cordibank.guide.seen') === null) helpOpen.value = true
  } catch {
    /* 隐私模式下不弹 */
  }
})
</script>

<template>
  <div class="workbench">
    <SwarmParticles />
    <TopBar class="wb-top" />
    <div class="workbench-row">
      <LeftPanel class="wb-left" />
      <Conversation class="wb-center" />
      <RightRail class="wb-right" />
    </div>
    <HelpGuide />
  </div>
</template>