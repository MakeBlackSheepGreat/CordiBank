/**
 * 模型提供商注册表：目录对齐 DeepSeek Harness 内置的 @earendil-works/pi-ai 官方清单。
 *
 * baseUrl 是各提供商官方 API 前缀，客户端在其后拼接协议路径：
 * openai-completions 拼 /chat/completions，anthropic-messages 拼 /v1/messages。
 * google 走其官方 OpenAI 兼容端点（/v1beta/openai），协议归入 openai-completions。
 */

/** 运行时已实现的请求协议；sdk 表示需要官方 SDK，本运行时只支持目录展示。 */
export type LlmApi = "openai-completions" | "anthropic-messages" | "sdk";

export interface ProviderEntry {
  id: string;
  name: string;
  baseUrl: string;
  api: LlmApi;
  /** 密钥环境变量名，与 DSH 内置定义一致。 */
  envVar: string;
  /** 未设置 LLM_MODEL 时的缺省模型；无缺省的提供商须显式给模型。 */
  defaultModel?: string;
}

export const PROVIDER_CATALOG: ProviderEntry[] = [
  { id: "deepseek", name: "DeepSeek", baseUrl: "https://api.deepseek.com/v1", api: "openai-completions", envVar: "DEEPSEEK_API_KEY", defaultModel: "deepseek-chat" },
  { id: "openai", name: "OpenAI", baseUrl: "https://api.openai.com/v1", api: "openai-completions", envVar: "OPENAI_API_KEY" },
  { id: "anthropic", name: "Anthropic", baseUrl: "https://api.anthropic.com", api: "anthropic-messages", envVar: "ANTHROPIC_API_KEY" },
  { id: "google", name: "Google Gemini", baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai", api: "openai-completions", envVar: "GEMINI_API_KEY" },
  { id: "openrouter", name: "OpenRouter", baseUrl: "https://openrouter.ai/api/v1", api: "openai-completions", envVar: "OPENROUTER_API_KEY" },
  { id: "groq", name: "Groq", baseUrl: "https://api.groq.com/openai/v1", api: "openai-completions", envVar: "GROQ_API_KEY" },
  { id: "mistral", name: "Mistral", baseUrl: "https://api.mistral.ai/v1", api: "openai-completions", envVar: "MISTRAL_API_KEY" },
  { id: "xai", name: "xAI", baseUrl: "https://api.x.ai/v1", api: "openai-completions", envVar: "XAI_API_KEY" },
  { id: "moonshotai", name: "Moonshot AI", baseUrl: "https://api.moonshot.ai/v1", api: "openai-completions", envVar: "MOONSHOT_API_KEY" },
  { id: "moonshotai-cn", name: "Moonshot AI (CN)", baseUrl: "https://api.moonshot.cn/v1", api: "openai-completions", envVar: "MOONSHOT_API_KEY" },
  { id: "kimi-coding", name: "Kimi Coding", baseUrl: "https://api.kimi.com/coding", api: "openai-completions", envVar: "KIMI_API_KEY" },
  { id: "zai", name: "Z.AI", baseUrl: "https://api.z.ai/api/coding/paas/v4", api: "openai-completions", envVar: "ZAI_API_KEY" },
  { id: "zai-coding-cn", name: "Z.AI Coding (CN)", baseUrl: "https://open.bigmodel.cn/api/coding/paas/v4", api: "openai-completions", envVar: "ZAI_CODING_CN_API_KEY" },
  { id: "minimax", name: "MiniMax", baseUrl: "https://api.minimax.io/anthropic", api: "anthropic-messages", envVar: "MINIMAX_API_KEY" },
  { id: "minimax-cn", name: "MiniMax (CN)", baseUrl: "https://api.minimaxi.com/anthropic", api: "anthropic-messages", envVar: "MINIMAX_CN_API_KEY" },
  { id: "qwen-token-plan", name: "Qwen Token Plan", baseUrl: "https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1", api: "openai-completions", envVar: "QWEN_TOKEN_PLAN_API_KEY" },
  { id: "qwen-token-plan-cn", name: "Qwen Token Plan (CN)", baseUrl: "https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1", api: "openai-completions", envVar: "QWEN_TOKEN_PLAN_CN_API_KEY" },
  { id: "qwen-token-plan-individual", name: "Qwen Token Plan Individual", baseUrl: "https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1", api: "openai-completions", envVar: "QWEN_TOKEN_PLAN_API_KEY" },
  { id: "baseten", name: "Baseten", baseUrl: "https://inference.baseten.co/v1", api: "openai-completions", envVar: "BASETEN_API_KEY" },
  { id: "cerebras", name: "Cerebras", baseUrl: "https://api.cerebras.ai/v1", api: "openai-completions", envVar: "CEREBRAS_API_KEY" },
  { id: "fireworks", name: "Fireworks AI", baseUrl: "https://api.fireworks.ai/inference/v1", api: "openai-completions", envVar: "FIREWORKS_API_KEY" },
  { id: "huggingface", name: "Hugging Face", baseUrl: "https://router.huggingface.co/v1", api: "openai-completions", envVar: "HF_TOKEN" },
  { id: "nvidia", name: "NVIDIA NIM", baseUrl: "https://integrate.api.nvidia.com/v1", api: "openai-completions", envVar: "NVIDIA_API_KEY" },
  { id: "together", name: "Together AI", baseUrl: "https://api.together.ai/v1", api: "openai-completions", envVar: "TOGETHER_API_KEY" },
  { id: "vercel-ai-gateway", name: "Vercel AI Gateway", baseUrl: "https://ai-gateway.vercel.sh/v1", api: "openai-completions", envVar: "AI_GATEWAY_API_KEY" },
  { id: "ant-ling", name: "Ant Ling", baseUrl: "https://api.ant-ling.com/v1", api: "openai-completions", envVar: "ANT_LING_API_KEY" },
  { id: "github-copilot", name: "GitHub Copilot", baseUrl: "https://api.individual.githubcopilot.com", api: "openai-completions", envVar: "COPILOT_GITHUB_TOKEN" },
  { id: "meta", name: "Meta Llama", baseUrl: "https://api.meta.ai/v1", api: "openai-completions", envVar: "META_API_KEY" },
  { id: "xiaomi", name: "Xiaomi MiMo", baseUrl: "https://api.xiaomimimo.com/v1", api: "openai-completions", envVar: "XIAOMI_API_KEY" },
  { id: "xiaomi-token-plan-cn", name: "Xiaomi Token Plan (CN)", baseUrl: "https://token-plan-cn.xiaomimimo.com/v1", api: "openai-completions", envVar: "XIAOMI_TOKEN_PLAN_CN_API_KEY" },
  { id: "xiaomi-token-plan-sgp", name: "Xiaomi Token Plan (SGP)", baseUrl: "https://token-plan-sgp.xiaomimimo.com/v1", api: "openai-completions", envVar: "XIAOMI_TOKEN_PLAN_SGP_API_KEY" },
  { id: "xiaomi-token-plan-ams", name: "Xiaomi Token Plan (AMS)", baseUrl: "https://token-plan-ams.xiaomimimo.com/v1", api: "openai-completions", envVar: "XIAOMI_TOKEN_PLAN_AMS_API_KEY" },
  { id: "openai-codex", name: "OpenAI Codex", baseUrl: "https://chatgpt.com/backend-api/codex", api: "sdk", envVar: "OPENAI_API_KEY" },
  { id: "azure", name: "Azure OpenAI", baseUrl: "", api: "sdk", envVar: "AZURE_OPENAI_API_KEY" },
  { id: "amazon-bedrock", name: "Amazon Bedrock", baseUrl: "", api: "sdk", envVar: "AWS_ACCESS_KEY_ID" },
];

/** siliconflow 不在 DSH 目录内，保留为历史兼容项（resolveLlm 的推断回退）。 */
/** 历史兼容：DSH 目录未收录 SiliconFlow，但本仓库早期版本以它作为缺省供应商。 */
export const LEGACY_SILICONFLOW: ProviderEntry = {
  id: "siliconflow",
  name: "SiliconFlow (legacy)",
  baseUrl: "https://api.siliconflow.cn/v1",
  api: "openai-completions",
  envVar: "SILICONFLOW_API_KEY",
  defaultModel: "Qwen/Qwen2.5-7B-Instruct",
};

/** 按 id 取目录条目；未收录返回 undefined。 */
export function findProvider(id: string): ProviderEntry | undefined {
  return PROVIDER_CATALOG.find((item) => item.id === id);
}
