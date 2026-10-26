import { loadConfig, type RuntimeConfig } from "../config.ts";
import type { CapabilityPlugin } from "../capabilities/types.ts";
import { BankAgent } from "../bank/orchestrator.ts";
import { parseIntent } from "../bank/intent.ts";
import { POLICY_DIMENSIONS, TOOL_SPECS } from "../bank/policy.ts";
import { SCENARIOS, SECURITY_DEMOS } from "../bank/scenarios.ts";
import { runRedTeam } from "../bank/redteam.ts";
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

  /** 懒加载：首次调用才创建存储与密钥，避免无谓的文件副作用。 */
  const engine = (): BankAgent => {
    if (agent === null) agent = new BankAgent({ storeDir: cfg.storeDir });
    return agent;
  };

  return {
    name: "bank-agent",
    def: {
      service: "bank.agent",
      methods: ["chat", "confirm", "cancel", "context", "audit", "scenarios", "intents", "redteam", "reset", "state"],
      description: "银行 AI 智能体：意图理解、三色判定、确认令牌、审计链与红队评测",
    },
    panel: {
      title: "银行智能体",
      description: "执行链路、风险判定与审计留痕",
      kind: "summary",
      source: "bank.agent.state",
    },
    provider: {
      chat(...params: unknown[]): unknown {
        const sessionId = asString(params[0], "sessionId");
        const text = asString(params[1], "text");
        return engine().chat(sessionId, text);
      },
      confirm(...params: unknown[]): unknown {
        const sessionId = asString(params[0], "sessionId");
        const token = asString(params[1], "token");
        const override = params[2] as IntentSlots | undefined;
        return engine().confirm(sessionId, token, override);
      },
      cancel(...params: unknown[]): unknown {
        return engine().cancel(asString(params[0], "sessionId"));
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
        return { scenarios: SCENARIOS, security: SECURITY_DEMOS, tools: TOOL_SPECS, dimensions: POLICY_DIMENSIONS };
      },
      intents(...params: unknown[]): unknown {
        const text = asString(params[0], "text");
        return parseIntent(text, engine().snapshot());
      },
      redteam(...params: unknown[]): unknown {
        const prefix = typeof params[0] === "string" ? params[0] : "redteam";
        return runRedTeam(engine(), { sessionPrefix: prefix });
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
    },
  };
}
