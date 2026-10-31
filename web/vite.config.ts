import vue from '@vitejs/plugin-vue'
import tailwindcss from '@tailwindcss/vite'
import { defineConfig } from 'vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [vue(), tailwindcss()],
  // 相对基路径：桌面应用从 http://127.0.0.1:<port>/ 加载，绝对路径会指到根而丢失资源。
  base: './',
  build: {
    // 把体积大且改动少的依赖拆成独立 chunk：主包更小、更容易命中缓存。
    rolldownOptions: {
      output: {
        codeSplitting: {
          groups: [
            { name: 'vue-vendor', test: /node_modules[\\/](vue|@vue|pinia)[\\/]/, priority: 30 },
            { name: 'flow-vendor', test: /node_modules[\\/]@vue-flow[\\/]/, priority: 20 },
            { name: 'vendor', test: /node_modules[\\/]/, priority: 10, minSize: 20000 },
          ],
        },
      },
    },
  },
  server: {
    // 开发期：/rpc 代理到 runtime（单进程托管时前端为同源，无需此配置）
    proxy: {
      '/rpc': {
        target: process.env.RUNTIME_URL ?? 'http://127.0.0.1:8123',
        changeOrigin: true,
      },
    },
  },
})
