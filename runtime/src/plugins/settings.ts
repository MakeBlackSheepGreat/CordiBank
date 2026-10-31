/**
 * 设置能力：模型密钥与 IM 渠道的运行时配置。
 *
 * 保存即生效——写入 storeDir/settings.json 后立刻就地覆盖 cfg，
 * 并让 bank-agent 丢弃已缓存的模型客户端，下次调用按新配置重建。
 */
import type { RuntimeConfig } from "../config.ts";
import type { CapabilityPlugin } from "../capabilities/types.ts";
import { LlmClient } from "../llm/client.ts";
import { PROVIDER_CATALOG } from "../llm/providers.ts";
import {
  applyUserSettings,
  catalogEntry,
  maskSecret,
  readUserSettings,
  settingsPath,
  writeUserSettings,
  type UserChannelSettings,
  type UserLlmSettings,
  type UserSettings,
} from "../core/settings-store.ts";
import type { Effort } from "../llm/types.ts";

type PluginDeps = { get(id: string): CapabilityPlugin | undefined };

/** 模型视图：密钥只以脱敏形式出现，绝不回传明文。 */
export interface LlmSettingsView {
  provider: string;
  providerName: string;
  model: string;
  baseUrl: string;
  api: string;
  keyConfigured: boolean;
  keyMasked: string;
  effort: Effort;
  intentMode: "rule" | "hybrid" | "model";
  toolScope: "all" | "scene";
}

export interface ProviderOptionView {
  id: string;
  name: string;
  defaultModel?: string;
  keyConfigured: boolean;
  active: boolean;
}

export interface ChannelFieldView {
  key: string;
  label: string;
  valueMasked: string;
}

export interface ChannelSettingsView {
  id: string;
  name: string;
  description: string;
  configured: boolean;
  fields: ChannelFieldView[];
}

export interface SettingsView {
  llm: LlmSettingsView;
  providers: ProviderOptionView[];
  channels: ChannelSettingsView[];
  /** 设置文件绝对路径，界面用于提示落盘位置。 */
  settingsFile: string;
}

/** 渠道字段声明：key 对应 UserChannelSettings 字段名，label 供界面直接显示。 */
interface ChannelSpec {
  id: string;
  name: string;
  description: string;
  fields: Array<{ key: keyof UserChannelSettings; label: string }>;
}

/**
 * 渠道固定五项：id 与 channels.ts 的渠道标识对齐。
 * 通用 webhook 桥不设凭据（任何桥接程序都可 POST），因此字段为空且恒为已配置。
 */
const CHANNEL_SPECS: ChannelSpec[] = [
  {
    id: "qq",
    name: "QQ 官方机器人",
    description: "开放平台 AppID + AppSecret，长连接收群 @ 与单聊消息；也可在「渠道接入向导」内一键接入",
    fields: [
      { key: "qqBotAppId", label: "App ID" },
      { key: "qqBotAppSecret", label: "App Secret" },
    ],
  },
  {
    id: "dingtalk",
    name: "钉钉",
    description: "企业内部机器人官方回调，sign 加签验签",
    fields: [{ key: "dingtalkSecret", label: "加签密钥" }],
  },
  {
    id: "feishu",
    name: "飞书",
    description: "事件订阅官方回调，challenge 握手 + tenant_access_token 送回",
    fields: [
      { key: "feishuAppId", label: "App ID" },
      { key: "feishuAppSecret", label: "App Secret" },
      { key: "feishuToken", label: "Verification Token" },
    ],
  },
  {
    id: "wechat",
    name: "微信",
    description: "ilink 官方接口长轮询收发，扫码接入由「渠道接入向导」完成",
    fields: [
      { key: "wechatToken", label: "机器人令牌" },
      { key: "wechatAccount", label: "机器人账号" },
    ],
  },
  {
    id: "webhook",
    name: "通用 webhook 桥",
    description: "POST /channel/webhook/incoming，由桥接程序送回，不设凭据",
    fields: [],
  },
];

const INTENT_MODES = ["rule", "hybrid", "model"] as const;
const EFFORT_LEVELS: Effort[] = ["off", "low", "high"];

/** 渠道字段当前值：按 cfg 上的对应字段读取（用户设置已就地覆盖）。 */
function channelValue(cfg: RuntimeConfig, key: keyof UserChannelSettings): string {
  switch (key) {
    case "qqBotAppId":
      return cfg.channelQqBotAppId;
    case "qqBotAppSecret":
      return cfg.channelQqBotAppSecret;
    case "dingtalkSecret":
      return cfg.channelDingtalkSecret;
    case "feishuAppId":
      return cfg.channelFeishuAppId;
    case "feishuAppSecret":
      return cfg.channelFeishuAppSecret;
    case "feishuToken":
      return cfg.channelFeishuToken;
    case "wechatToken":
      return cfg.channelWechatBotToken;
    case "wechatAccount":
      return cfg.channelWechatAccountId;
  }
}

/** 非空字符串判定。 */
function filled(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

/** 校验并归一 set 的入参：非法一律抛错，调用方据此保证不写文件。 */
function readPayload(payload: unknown): UserSettings {
  const record = asRecord(payload);
  if (record === undefined) throw new Error("设置入参必须是 JSON 对象");

  const settings: UserSettings = {};

  if (record.llm !== undefined) {
    const llmRaw = asRecord(record.llm);
    if (llmRaw === undefined) throw new Error("llm 必须是 JSON 对象");
    const llm: UserLlmSettings = {};
    for (const key of ["provider", "apiKey", "baseUrl", "model"] as const) {
      const value = llmRaw[key];
      if (value === undefined) continue;
      if (typeof value !== "string") throw new Error(`llm.${key} 必须是字符串`);
      llm[key] = value;
    }
    if (filled(llm.provider) && catalogEntry(llm.provider.trim()) === undefined) {
      throw new Error("未知的模型供应商：" + llm.provider.trim());
    }
    if (llmRaw.intentMode !== undefined) {
      const value = llmRaw.intentMode;
      if (typeof value !== "string" || (INTENT_MODES as readonly string[]).includes(value) === false) {
        throw new Error("意图模式只接受 rule、hybrid、model，收到：" + String(value));
      }
      llm.intentMode = value as "rule" | "hybrid" | "model";
    }
    if (llmRaw.effort !== undefined) {
      const value = llmRaw.effort;
      if (typeof value !== "string" || (EFFORT_LEVELS as string[]).includes(value) === false) {
        throw new Error("思考强度只接受 off、low、high，收到：" + String(value));
      }
      llm.effort = value as Effort;
    }
    if (Object.keys(llm).length > 0) settings.llm = llm;
  }

  if (record.channels !== undefined) {
    const channelsRaw = asRecord(record.channels);
    if (channelsRaw === undefined) throw new Error("channels 必须是 JSON 对象");
    const channels: UserChannelSettings = {};
    for (const spec of CHANNEL_SPECS) {
      for (const field of spec.fields) {
        const value = channelsRaw[field.key];
        if (value === undefined) continue;
        if (typeof value !== "string") throw new Error(`channels.${field.key} 必须是字符串`);
        channels[field.key] = value;
      }
    }
    // 未知渠道字段一律拒绝：写进文件也不会被任何插件消费，静默忽略等于骗人。
    const known = new Set(CHANNEL_SPECS.flatMap((spec) => spec.fields.map((field) => field.key as string)));
    for (const key of Object.keys(channelsRaw)) {
      if (!known.has(key)) throw new Error("未知的渠道字段：" + key);
    }
    if (Object.keys(channels).length > 0) settings.channels = channels;
  }

  return settings;
}

/** 设置能力插件：读视图、写设置、探活模型。 */
export function createSettingsPlugin(cfg: RuntimeConfig, deps: PluginDeps): CapabilityPlugin {
  const view = (): SettingsView => {
    const entry = cfg.llmProvider === "" ? undefined : catalogEntry(cfg.llmProvider);
    return {
      llm: {
        provider: cfg.llmProvider,
        providerName: entry?.name ?? "",
        model: cfg.llm.model,
        baseUrl: cfg.llm.baseUrl,
        api: cfg.llm.api ?? "openai-completions",
        keyConfigured: cfg.llm.apiKey !== "",
        keyMasked: maskSecret(cfg.llm.apiKey),
        effort: cfg.llm.effort,
        intentMode: cfg.llmIntentMode,
        toolScope: cfg.llmToolScope,
      },
      providers: PROVIDER_CATALOG.map((item) => ({
        id: item.id,
        name: item.name,
        ...(item.defaultModel === undefined ? {} : { defaultModel: item.defaultModel }),
        // 激活供应商看实际生效的 cfg 密钥，其余按各自环境变量判断
        keyConfigured: item.id === cfg.llmProvider ? cfg.llm.apiKey !== "" : (process.env[item.envVar] ?? "") !== "",
        active: item.id === cfg.llmProvider,
      })),
      channels: CHANNEL_SPECS.map((spec) => {
        const fields = spec.fields.map((field) => ({
          key: field.key as string,
          label: field.label,
          valueMasked: maskSecret(channelValue(cfg, field.key)),
        }));
        return {
          id: spec.id,
          name: spec.name,
          description: spec.description,
          configured: fields.length === 0 ? true : fields.every((field) => field.valueMasked !== ""),
          fields,
        };
      }),
      settingsFile: settingsPath(cfg.storeDir),
    };
  };

  return {
    name: "settings",
    def: {
      service: "settings",
      methods: ["get", "set", "probe"],
      description: "模型密钥与 IM 渠道的运行时配置：保存即落盘并热生效，密钥只回传脱敏值。",
    },
    provider: {
      get: (): SettingsView => view(),
      /** 保存设置：校验 → 落盘 → 就地覆盖 cfg → 让 bank-agent 重建模型客户端。 */
      set: async (payload: unknown): Promise<SettingsView> => {
        const settings = readPayload(payload);
        const merged = writeUserSettings(cfg.storeDir, settings);
        applyUserSettings(cfg, merged);
        const bank = deps.get("bank-agent");
        if (bank !== undefined && typeof bank.provider.reload === "function") {
          await bank.provider.reload();
        }
        return view();
      },
      /** 探活：用当前配置真实发一次最小请求，失败按 ok:false 返回而不抛。 */
      probe: async (): Promise<{ ok: boolean; latencyMs: number; model: string; endpoint: string; message: string }> => {
        const client = new LlmClient(cfg.llm);
        if (cfg.llm.apiKey === "") {
          return { ok: false, latencyMs: 0, model: client.model, endpoint: client.endpoint, message: "未配置 API key" };
        }
        const started = Date.now();
        try {
          const reply = await client.chat([{ role: "user", content: "回复两个字：可用" }]);
          return {
            ok: true,
            latencyMs: Date.now() - started,
            model: reply.model === "" ? client.model : reply.model,
            endpoint: client.endpoint,
            message: reply.content.trim(),
          };
        } catch (error) {
          return {
            ok: false,
            latencyMs: Date.now() - started,
            model: client.model,
            endpoint: client.endpoint,
            message: error instanceof Error ? error.message : String(error),
          };
        }
      },
    },
  };
}
