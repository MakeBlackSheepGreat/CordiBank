<script setup lang="ts">
import { onMounted } from 'vue'
import { useBank } from './stores/bank'
import SwarmParticles from './components/workbench/SwarmParticles.vue'
import TopBar from './components/workbench/TopBar.vue'
import LeftPanel from './components/workbench/LeftPanel.vue'
import Conversation from './components/workbench/Conversation.vue'
import RightRail from './components/workbench/RightRail.vue'

const bank = useBank()

onMounted(() => {
  void bank.init()
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
  </div>
</template>
