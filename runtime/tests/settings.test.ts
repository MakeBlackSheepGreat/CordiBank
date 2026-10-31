import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadConfig, type RuntimeConfig } from "../src/config.ts";
import {
  SETTINGS_FILE,
  applyUserSettings,
  maskSecret,
  readUserSettings,
  settingsPath,
  writeUserSettings,
} from "../src/core/settings-store.ts";
import { createSettingsPlugin } from "../src/plugins/settings.ts";
import { createBankAgentPlugin } from "../src/plugins/bank-agent.ts";
import type { CapabilityPlugin } from "../src/capabilities/types.ts";

/** 独立 store 目录：绝不写 runtime/store（AGENTS.md 数据隔离）。 */
let dir = "";

beforeEach(() => {
  const base = path.join(process.cwd(), ".test-tmp");
  mkdirSync(base, { recursive: true });
  dir = mkdtempSync(path.join(base, "settings-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** 测试用配置：模型与渠道字段全部显式给值，避免受本机环境变量影响。 */
function makeCfg(): RuntimeConfig {
  return loadConfig({
    storeDir: dir,
    skillsDir: path.join(dir, "skills"),
    patchFile: path.join(dir, "none.yml"),
    pluginDirs: [],
    llm: {
      baseUrl: "",
      apiKey: "",
      model: "",
      timeoutMs: 1000,
      temperature: 0,
      maxTokens: 64,
      effort: "low",
      api: "openai-completions",
    },
    llmProvider: "",
    llmIntentMode: "hybrid",
    channelQqBotAppId: "",
    channelQqBotAppSecret: "",
    channelQqBotApiBase: "https://api.bot.qq.com",
    channelDingtalkSecret: "",
    channelFeishuAppId: "",
    channelFeishuAppSecret: "",
    channelFeishuToken: "",
  });
}

/** 依赖表：把 bank-agent 放进 deps，settings.set 才能调用 reload。 */
function makeDeps(cfg: RuntimeConfig): { get(id: string): CapabilityPlugin | undefined } {
  const bank = createBankAgentPlugin(cfg);
  const table = new Map<string, CapabilityPlugin>([["bank-agent", bank]]);
  return { get: (id) => table.get(id) };
}

describe("settings-store 读写", () => {
  it("文件缺失返回空设置，坏 JSON 也返回空设置且不抛", () => {
    expect(readUserSettings(dir)).toEqual({});
    writeFileSync(settingsPath(dir), "{ not json");
    expect(readUserSettings(dir)).toEqual({});
  });

  it("writeUserSettings 深合并：两次写入的字段都保留", () => {
    writeUserSettings(dir, { llm: { model: "deepseek-chat" } });
    const merged = writeUserSettings(dir, { channels: { qqBotAppSecret: "qq-token-1" } });
    expect(merged.llm?.model).toBe("deepseek-chat");
    expect(merged.channels?.qqBotAppSecret).toBe("qq-token-1");
    const onDisk = JSON.parse(readFileSync(settingsPath(dir), "utf8")) as Record<string, unknown>;
    expect(onDisk.llm).toEqual({ model: "deepseek-chat" });
    expect(onDisk.channels).toEqual({ qqBotAppSecret: "qq-token-1" });
  });

  it("settingsPath 指向 storeDir 下的 settings.json", () => {
    expect(settingsPath(dir)).toBe(path.join(dir, SETTINGS_FILE));
    expect(existsSync(settingsPath(dir))).toBe(false);
  });

  it("maskSecret 三档：空串、短串全星号、长串保留首尾四位", () => {
    expect(maskSecret("")).toBe("");
    expect(maskSecret("short")).toBe("*****");
    expect(maskSecret("12345678")).toBe("********");
    expect(maskSecret("sk-1234567890abcdef")).toBe("sk-1***********cdef");
  });
});

describe("applyUserSettings 覆盖规则", () => {
  it("切换供应商时换成目录条目的 baseUrl 与缺省模型", () => {
    const cfg = makeCfg();
    cfg.llm.baseUrl = "https://old.example.com/v1";
    cfg.llm.model = "old-model";
    applyUserSettings(cfg, { llm: { provider: "deepseek" } });
    expect(cfg.llmProvider).toBe("deepseek");
    expect(cfg.llm.baseUrl).toBe("https://api.deepseek.com/v1");
    expect(cfg.llm.model).toBe("deepseek-chat");
    expect(cfg.llm.api).toBe("openai-completions");
  });

  it("显式 apiKey/baseUrl/model 覆盖目录基线", () => {
    const cfg = makeCfg();
    applyUserSettings(cfg, {
      llm: { provider: "deepseek", apiKey: "sk-user", baseUrl: "https://proxy.example.com/v1", model: "deepseek-reasoner" },
    });
    expect(cfg.llm.apiKey).toBe("sk-user");
    expect(cfg.llm.baseUrl).toBe("https://proxy.example.com/v1");
    expect(cfg.llm.model).toBe("deepseek-reasoner");
  });

  it("空串不覆盖：保留环境变量基线", () => {
    const cfg = makeCfg();
    cfg.llm.apiKey = "env-key";
    cfg.channelQqBotAppSecret = "env-token";
    applyUserSettings(cfg, { llm: { apiKey: "", provider: "" }, channels: { qqBotAppSecret: "", dingtalkSecret: "" } });
    expect(cfg.llm.apiKey).toBe("env-key");
    expect(cfg.llmProvider).toBe("");
    expect(cfg.channelQqBotAppSecret).toBe("env-token");
  });

  it("渠道字段就地覆盖 cfg，effort 与 intentMode 同步", () => {
    const cfg = makeCfg();
    applyUserSettings(cfg, {
      llm: { effort: "high", intentMode: "rule" },
      channels: { qqBotAppId: "102000000", dingtalkSecret: "dd-secret", feishuAppId: "cli_1", wechatToken: "wx-token-1", wechatAccount: "bot-acc-1" },
    });
    expect(cfg.llm.effort).toBe("high");
    expect(cfg.llmIntentMode).toBe("rule");
    expect(cfg.channelQqBotAppId).toBe("102000000");
    expect(cfg.channelDingtalkSecret).toBe("dd-secret");
    expect(cfg.channelFeishuAppId).toBe("cli_1");
    expect(cfg.channelWechatBotToken).toBe("wx-token-1");
    expect(cfg.channelWechatAccountId).toBe("bot-acc-1");
  });
});

describe("settings 能力插件", () => {
  it("get 视图结构完整，密钥只回脱敏值", async () => {
    const cfg = makeCfg();
    const plugin = createSettingsPlugin(cfg, makeDeps(cfg));
    await plugin.provider.set({ llm: { provider: "deepseek", apiKey: "sk-1234567890abcdef", model: "deepseek-chat" } });
    const view = plugin.provider.get() as {
      llm: { provider: string; providerName: string; keyConfigured: boolean; keyMasked: string; model: string };
      providers: Array<{ id: string; active: boolean }>;
      channels: Array<{ id: string; configured: boolean; fields: Array<{ key: string; valueMasked: string }> }>;
      settingsFile: string;
    };
    expect(view.llm.provider).toBe("deepseek");
    expect(view.llm.providerName).toBe("DeepSeek");
    expect(view.llm.keyConfigured).toBe(true);
    expect(view.llm.keyMasked).toBe("sk-1***********cdef");
    expect(view.llm.keyMasked).not.toBe("sk-1234567890abcdef");
    expect(JSON.stringify(view).includes("sk-1234567890abcdef")).toBe(false);
    expect(view.providers.some((item) => item.id === "deepseek" && item.active)).toBe(true);
    expect(view.settingsFile).toBe(settingsPath(dir));
    expect(view.channels.map((item) => item.id)).toEqual(["qq", "dingtalk", "feishu", "wechat", "webhook"]);
    // 通用 webhook 桥不设凭据，恒为已配置
    expect(view.channels.find((item) => item.id === "webhook")?.configured).toBe(true);
  });

  it("set 非法供应商抛错且不落盘", async () => {
    const cfg = makeCfg();
    const plugin = createSettingsPlugin(cfg, makeDeps(cfg));
    await expect(plugin.provider.set({ llm: { provider: "not-a-provider" } })).rejects.toThrow("未知的模型供应商");
    expect(existsSync(settingsPath(dir))).toBe(false);
    await expect(plugin.provider.set({ llm: { intentMode: "smart" } })).rejects.toThrow("意图模式");
    await expect(plugin.provider.set({ llm: { effort: "max" } })).rejects.toThrow("思考强度");
    await expect(plugin.provider.set("nope")).rejects.toThrow("JSON 对象");
    await expect(plugin.provider.set({ channels: { qqApis: "typo" } })).rejects.toThrow("未知的渠道字段");
    expect(existsSync(settingsPath(dir))).toBe(false);
  });

  it("set 合法 payload 落盘并让 get 反映新值", async () => {
    const cfg = makeCfg();
    const plugin = createSettingsPlugin(cfg, makeDeps(cfg));
    const view = (await plugin.provider.set({
      llm: { provider: "deepseek", apiKey: "sk-abcdefgh1234", effort: "off", intentMode: "rule" },
      channels: { qqBotAppId: "102000001", qqBotAppSecret: "qq-secret-token" },
    })) as { llm: { provider: string; effort: string; intentMode: string; keyMasked: string }; channels: Array<{ id: string; configured: boolean; fields: Array<{ key: string; valueMasked: string }> }> };
    expect(view.llm.provider).toBe("deepseek");
    expect(view.llm.effort).toBe("off");
    expect(view.llm.intentMode).toBe("rule");
    expect(view.llm.keyMasked).toBe("sk-a*******1234");
    const qq = view.channels.find((item) => item.id === "qq");
    expect(qq?.configured).toBe(true);
    // "qq-secret-token" 长 15：保留前 4 后 4，中间 7 个星号
    expect(qq?.fields.find((field) => field.key === "qqBotAppSecret")?.valueMasked).toBe("qq-s*******oken");
    // 落盘内容保留明文供运行时重启读取，但只存在于 store 目录内
    const onDisk = JSON.parse(readFileSync(settingsPath(dir), "utf8")) as { llm?: { provider?: string }; channels?: { qqBotAppId?: string } };
    expect(onDisk.llm?.provider).toBe("deepseek");
    expect(onDisk.channels?.qqBotAppId).toBe("102000001");
    // cfg 已就地生效：channels 插件读同一份 cfg
    expect(cfg.channelQqBotAppId).toBe("102000001");
    expect(cfg.llm.apiKey).toBe("sk-abcdefgh1234");
  });

  it("probe 未配置 key 时直接返回 ok:false 且不抛", async () => {
    const cfg = makeCfg();
    const plugin = createSettingsPlugin(cfg, makeDeps(cfg));
    const result = (await plugin.provider.probe()) as { ok: boolean; message: string; latencyMs: number };
    expect(result.ok).toBe(false);
    expect(result.message).toBe("未配置 API key");
    expect(result.latencyMs).toBe(0);
  });
});

describe("bank-agent reload", () => {
  it("reload 存在且返回 ok:true", () => {
    const cfg = makeCfg();
    const bank = createBankAgentPlugin(cfg);
    expect(bank.def.methods).toContain("reload");
    const result = bank.provider.reload() as { ok: boolean };
    expect(result).toEqual({ ok: true });
  });

  it("settings.set 会触发 bank-agent 的 reload", async () => {
    const cfg = makeCfg();
    const bank = createBankAgentPlugin(cfg);
    let reloaded = 0;
    const spy: CapabilityPlugin = {
      ...bank,
      provider: {
        ...bank.provider,
        reload: () => {
          reloaded += 1;
          return { ok: true };
        },
      },
    };
    const plugin = createSettingsPlugin(cfg, { get: (id) => (id === "bank-agent" ? spy : undefined) });
    await plugin.provider.set({ llm: { intentMode: "rule" } });
    expect(reloaded).toBe(1);
  });
});
