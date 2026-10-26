import { createApp } from 'vue'
import { createPinia } from 'pinia'
import '@fontsource-variable/noto-sans-sc/wght.css'
import '@fontsource-variable/jetbrains-mono/wght.css'
import './style.css'
import App from './App.vue'

createApp(App).use(createPinia()).mount('#app')
