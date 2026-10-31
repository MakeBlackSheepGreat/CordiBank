import type { RuntimeConfig } from "../config.ts";
import type { CapabilityPlugin } from "../capabilities/types.ts";
import { findProvider, LEGACY_SILICONFLOW, PROVIDER_CATALOG } from "../llm/providers.ts";
import type { ProviderEntry } from "../llm/providers.ts";

/** 供应商视图：目录条目 + 当前环境下的配置状态。 */
export interface ProviderView {
  id: string;
  name: string;
  baseUrl: string;
  api: string;
  /** 密钥环境变量名，与 DSH 内置定义一致。 */
  envVar: string;
  defaultModel?: string;
  /** 该提供商的密钥环境变量当前是否已配置。 */
  keyConfigured: boolean;
  /** 是否为当前激活的提供商。 */
  active: boolean;
}

/** 激活状态视图：当前生效的供应商与请求参数。 */
export interface RegistryStatus {
  provider: string;
  model: string;
  baseUrl: string;
  api: string;
  keyConfigured: boolean;
}

function toView(entry: ProviderEntry, activeId: string): ProviderView {
  const keyConfigured = (process.env[entry.envVar] ?? "") !== "";
  return {
    id: entry.id,
    name: entry.name,
    baseUrl: entry.baseUrl,
    api: entry.api,
    envVar: entry.envVar,
    ...(entry.defaultModel === undefined ? {} : { defaultModel: entry.defaultModel }),
    keyConfigured,
    active: entry.id === activeId,
  };
}

/** 模型供应商注册表插件：暴露 DSH 对齐的提供商目录与当前激活状态。 */
export function createLlmRegistryPlugin(cfg: RuntimeConfig): CapabilityPlugin {
  const status = (): RegistryStatus => ({
    provider: cfg.llmProvider,
    model: cfg.llm.model,
    baseUrl: cfg.llm.baseUrl,
    api: cfg.llm.api ?? "openai-completions",
    keyConfigured: cfg.llm.apiKey !== "",
  });

  return {
    name: "llm-registry",
    def: {
      service: "llm.registry",
      methods: ["providers", "status"],
      description: "模型供应商注册表：目录对齐 DeepSeek Harness 内置清单，报告激活供应商与密钥状态。",
    },
    provider: {
      providers() {
        const activeId = cfg.llmProvider;
        const views = PROVIDER_CATALOG.map((entry) => toView(entry, activeId));
        if (PROVIDER_CATALOG.some((entry) => entry.id === activeId) === false && activeId !== "") {
          views.push(toView(LEGACY_SILICONFLOW, activeId));
        }
        return views;
      },
      status,
    },
  };
}
