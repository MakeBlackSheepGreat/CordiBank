import { loadConfig, resolveLlm, type RuntimeConfig } from "../config.ts";
import type { CapabilityPlugin } from "../capabilities/types.ts";
import { BankStore } from "../bank/data.ts";
import { ModelBrain } from "../bank/model-brain.ts";
import { BankAgent } from "../bank/orchestrator.ts";
import { parseIntent } from "../bank/intent.ts";
import { POLICY_DIMENSIONS, TOOL_SPECS } from "../bank/policy.ts";
import { SCENARIOS, SECURITY_DEMOS } from "../bank/scenarios.ts";
import { runRedTeam } from "../bank/redteam.ts";
import { TOOL_CONTRACTS } from "../bank/tool-schema.ts";
import { LlmClient } from "../llm/client.ts";
import type { IntentSlots } from "../bank/types.ts";

function asString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`bank 能力需要非空字符串参数：${name}`);
  }
  return value;
}

/** 银行智能体能力：把编排层暴露为 bank.agent.* 服务。 */
export function createBankAgentPlugin(cfg: RuntimeConfig = loadConfig()): CapabilityPlugin {
  let agent: BankAgent | null = null;
  let brain: ModelBrain | null = null;

  /** 懒加载：首次调用才创建存储、密钥与模型客户端，避免无谓的文件副作用。 */
  const engine = (): BankAgent => {
    if (agent === null) {
      const store = new BankStore(cfg.storeDir);
      brain = new ModelBrain(new LlmClient(cfg.llm), () => store.load());
      agent = new BankAgent({ storeDir: cfg.storeDir, brain, intentMode: cfg.llmIntentMode, toolScope: cfg.llmToolScope });
    }
    return agent;
  };

  /** 模型大脑：未配置模型时返回空，调用方据此走规则。 */
  const mind = (): ModelBrain | null => {
    engine();
    return brain;
  };

  return {
    name: "bank-agent",
    def: {
      service: "bank.agent",
      methods: ["chat", "confirm", "cancel", "context", "audit", "scenarios", "intents", "redteam", "reset", "state", "model", "ask"],
      description: "银行 AI 智能体：意图理解（规则加模型）、三色判定、确认令牌、审计链与红队评测",
    },
    panel: {
      title: "银行智能体",
      description: "执行链路、风险判定与审计留痕",
      kind: "summary",
      source: "bank.agent.state",
    },
    provider: {
      async chat(...params: unknown[]): Promise<unknown> {
        const sessionId = asString(params[0], "sessionId");
        const text = asString(params[1], "text");
        return await engine().chat(sessionId, text);
      },
      /**
       * 对话式问答：模型可多轮调用只读工具取真实数据。
       * 识别到写操作意图时转交编排层，由策略引擎与确认令牌处理。
       */
      async ask(...params: unknown[]): Promise<unknown> {
        const sessionId = asString(params[0], "sessionId");
        const text = asString(params[1], "text");
        const model = mind();
        if (model === null || !model.available) {
          return { mode: "unavailable", reason: "模型未配置，请使用 bank.agent.chat" };
        }
        const loop = await model.converse(text);
        if (loop.stopReason === "write-intent") {
          const reply = await engine().chat(sessionId, text);
          return { mode: "write", loop, chat: reply };
        }
        return { mode: "readonly", loop };
      },
      async confirm(...params: unknown[]): Promise<unknown> {
        const sessionId = asString(params[0], "sessionId");
        const token = asString(params[1], "token");
        const override = params[2] as IntentSlots | undefined;
        return await engine().confirm(sessionId, token, override);
      },
      async cancel(...params: unknown[]): Promise<unknown> {
        return await engine().cancel(asString(params[0], "sessionId"));
      },
      context(...params: unknown[]): unknown {
        return engine().context(asString(params[0], "sessionId"));
      },
      audit(...params: unknown[]): unknown {
        const sessionId = typeof params[0] === "string" ? params[0] : undefined;
        const limit = typeof params[1] === "number" ? params[1] : 50;
        return engine().auditLog(sessionId, limit);
      },
      scenarios(): unknown {
        return {
          scenarios: SCENARIOS,
          security: SECURITY_DEMOS,
          tools: TOOL_SPECS,
          contracts: TOOL_CONTRACTS,
          dimensions: POLICY_DIMENSIONS,
        };
      },
      intents(...params: unknown[]): unknown {
        const text = asString(params[0], "text");
        return parseIntent(text, engine().snapshot());
      },
      async redteam(...params: unknown[]): Promise<unknown> {
        const prefix = typeof params[0] === "string" ? params[0] : "redteam";
        return await runRedTeam(engine(), { sessionPrefix: prefix });
      },
      reset(): unknown {
        return engine().reset();
      },
      state(): unknown {
        const state = engine().snapshot();
        return {
          account: state.account,
          cards: state.cards,
          subscriptions: state.subscriptions,
          products: state.products,
          policy: state.policy,
          heldCents: state.holdings.reduce((sum, item) => sum + item.amountCents, 0),
          lockedCents: state.lockedFunds.reduce((sum, item) => sum + item.amountCents, 0),
          billCount: state.bills.length,
        };
      },
      model(): unknown {
        return { ...engine().modelStatus(), llm: resolveLlmSummary(cfg) };
      },
    },
  };
}

/** 模型配置摘要：只暴露供应商标识与模型名，不暴露密钥。 */
function resolveLlmSummary(cfg: RuntimeConfig): { baseUrl: string; model: string; configured: boolean } {
  const settings = cfg.llm ?? resolveLlm();
  return { baseUrl: settings.baseUrl, model: settings.model, configured: settings.apiKey !== "" };
}
