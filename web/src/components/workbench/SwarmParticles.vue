<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue'

/**
 * 蜂群粒子背景：三色「工蜂」在画布上漂移并按距离连线，密度与透明度都压低，只做氛围。
 * 颜色随主题切换：监听 html[data-cs-theme] 变化后重读角色色变量。
 */
const canvasRef = ref<HTMLCanvasElement | null>(null)
let raf = 0
let observer: MutationObserver | null = null

interface Particle {
  x: number
  y: number
  vx: number
  vy: number
  r: number
  color: string
}

onMounted(() => {
  const canvas = canvasRef.value
  const ctx = canvas?.getContext('2d')
  if (canvas === null || ctx == null) return

  let particles: Particle[] = []
  let width = 0
  let height = 0

  const readColors = (): string[] => {
    const style = getComputedStyle(document.documentElement)
    const pick = (name: string, fallback: string): string => {
      const value = style.getPropertyValue(name).trim()
      return value === '' ? fallback : value
    }
    return [
      pick('--role-explorer', '#4c7fe8'),
      pick('--role-worker', '#eea23f'),
      pick('--role-validator', '#3fa37b'),
    ]
  }

  const rebuild = (): void => {
    const dpr = window.devicePixelRatio || 1
    width = canvas.clientWidth
    height = canvas.clientHeight
    canvas.width = Math.max(1, Math.floor(width * dpr))
    canvas.height = Math.max(1, Math.floor(height * dpr))
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    const colors = readColors()
    const count = Math.min(52, Math.max(24, Math.floor(width / 38)))
    particles = Array.from({ length: count }, (_, i) => ({
      x: Math.random() * width,
      y: Math.random() * height,
      vx: (Math.random() - 0.5) * 0.22,
      vy: (Math.random() - 0.5) * 0.22,
      r: 1.1 + Math.random() * 1.6,
      color: colors[i % colors.length],
    }))
  }

  const step = (): void => {
    ctx.clearRect(0, 0, width, height)
    for (const p of particles) {
      p.x += p.vx
      p.y += p.vy
      if (p.x < -8) p.x = width + 8
      else if (p.x > width + 8) p.x = -8
      if (p.y < -8) p.y = height + 8
      else if (p.y > height + 8) p.y = -8
      ctx.globalAlpha = 0.32
      ctx.fillStyle = p.color
      ctx.beginPath()
      ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2)
      ctx.fill()
    }
    ctx.globalAlpha = 0.07
    ctx.strokeStyle = readColors()[0]
    ctx.lineWidth = 1
    for (let i = 0; i < particles.length; i += 1) {
      for (let j = i + 1; j < particles.length; j += 1) {
        const a = particles[i]
        const b = particles[j]
        const dx = a.x - b.x
        const dy = a.y - b.y
        if (dx * dx + dy * dy > 12100) continue
        ctx.beginPath()
        ctx.moveTo(a.x, a.y)
        ctx.lineTo(b.x, b.y)
        ctx.stroke()
      }
    }
    ctx.globalAlpha = 1
    raf = requestAnimationFrame(step)
  }

  const onResize = (): void => {
    rebuild()
  }

  rebuild()
  step()
  window.addEventListener('resize', onResize)
  observer = new MutationObserver(rebuild)
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-cs-theme'] })

  onBeforeUnmount(() => {
    cancelAnimationFrame(raf)
    window.removeEventListener('resize', onResize)
    observer?.disconnect()
  })
})
</script>

<template>
  <canvas ref="canvasRef" class="swarm-canvas" aria-hidden="true"></canvas>
</template>

<style scoped>
.swarm-canvas {
  position: fixed;
  inset: 0;
  z-index: 1;
  width: 100%;
  height: 100%;
  pointer-events: none;
}
</style>
