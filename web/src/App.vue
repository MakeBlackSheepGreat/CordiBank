<script setup lang="ts">
import { onMounted } from 'vue'
import BankConsole from './components/bank/BankConsole.vue'
import { useBank } from './stores/bank'

const bank = useBank()

onMounted(() => {
  void bank.init()
})
</script>

<template>
  <BankConsole />
</template>
