import { ref } from 'vue'

/** 跨栏轻量通道：左栏把场景示例填进会话输入框。 */
export const draftPrefill = ref('')

/** 跨组件轻量通道：功能指南弹层开关。 */
export const helpOpen = ref(false)

/** 跨组件轻量通道：设置面板开关。 */
export const settingsOpen = ref(false)

/** 跨组件轻量通道：渠道接入向导开关。 */
export const wizardOpen = ref(false)
