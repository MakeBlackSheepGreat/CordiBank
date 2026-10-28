import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { loadConfig, resolveLlm, type RuntimeConfig } from "../config.ts";
import type { CapabilityPlugin } from "../capabilities/types.ts";
import { BankStore } from "../bank/data.ts";
import { builtinToolDescriptors } from "../bank/builtin-tools.ts";
import { ModelBrain } from "../bank/model-brain.ts";
import { BankAgent } from "../bank/orchestrator.ts";
import { parseIntent } from "../bank/intent.ts";
import { listToolSpecs, POLICY_DIMENSIONS } from "../bank/policy.ts";
import { SCENARIOS, SECURITY_DEMOS } from "../bank/scenarios.ts";
import { runRedTeam } from "../bank/redteam.ts";
import { TOOL_CONTRACTS } from "../bank/tool-schema.ts";
import { ToolRegistry } from "../harness/registry.ts";
import type { ExternalInvoker } from "../harness/types.ts";
import { LlmClient } from "../llm/client.ts";
import { flattenMcpResult, mcpToolDescriptors, type McpRiskDecl } from "./mcp-tools.ts";
import { readSkillDirectory } from "./skill.ts";
import type { McpTool } from "./mcp.ts";
import type { IntentSlots } from "../bank/types.ts";

function asString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`bank 能力需要非空字符串参数：${name}`);
  }
  return value;
}

/** 从运行时清单读服务风险声明：外部工具默认只读，写操作需显式标注。 */
function readServerDecls(cfg: RuntimeConfig): Map<string, McpRiskDecl> {
  const decls = new Map<string, McpRiskDecl>();
  const candidates = [path.join(cfg.storeDir, "mcp.json"), cfg.mcpPresetFile];
  const file = candidates.find((item) => existsSync(item));
  if (file === undefined) return decls;
  const parsed = JSON.parse(readFileSync(file, "utf8")) as { servers?: unknown };
  if (!Array.isArray(parsed.servers)) return decls;
  for (const item of parsed.servers) {
    if (item === null || typeof item !== "object") continue;
    const record = item as Record<string, unknown>;
    const id = typeof record.id === "string" ? record.id : "";
    if (id === "") continue;
    const tools: Record<string, "read" | "write"> = {};
    if (record.tools !== null && typeof record.tools === "object" && !Array.isArray(record.tools)) {
      for (const [toolName, value] of Object.entries(record.tools as Record<string, unknown>)) {
        if (value === "read" || value === "write") tools[toolName] = value;
      }
    }
    decls.set(id, {
      ...(record.risk === "read" || record.risk === "write" ? { risk: record.risk } : {}),
      ...(typeof record.scene === "string" ? { scene: record.scene } : {}),
      ...(record.irreversible === true ? { irreversible: true } : {}),
      ...(Object.keys(tools).length === 0 ? {} : { tools }),
    });
  }
  return decls;
}

/** 银行智能体能力：暴露 bank.agent.* 服务，并把外部工具并入模型工具集。 */
export function createBankAgentPlugin(cfg: RuntimeConfig = loadConfig(), mcp?: CapabilityPlugin): CapabilityPlugin {
  let agent: BankAgent | null = null;
  let brain: ModelBrain | null = null;
  let registry: ToolRegistry | null = null;
  let syncPromise: Promise<void> | null = null;

  /** 外部工具调用器：把 mcp__ 前缀的工具转给对应服务器。 */
  const invoker: ExternalInvoker = async (serverId, remoteName, args) => {
    if (mcp === undefined) return { ok: false, message: "外部服务未接入" };
    try {
      const reply = (await mcp.provider.call(serverId, remoteName, args)) as { result: unknown[] };
      const text = flattenMcpResult(reply.result);
      return { ok: true, message: text === "" ? "外部服务已返回空结果" : text, data: reply.result };
    } catch (error) {
      return { ok: false, message: `外部服务调用失败：${error instanceof Error ? error.message : String(error)}` };
    }
  };

  /** 懒加载：首次调用才创建存储、密钥与模型客户端，避免无谓的文件副作用。 */
  const engine = (): BankAgent => {
    if (agent === null) {
      const store = new BankStore(cfg.storeDir);
      registry = new ToolRegistry();
      registry.registerMany(builtinToolDescriptors());
      brain = new ModelBrain(
        new LlmClient(cfg.llm),
        () => store.load(),
        registry,
        invoker,
        () => readSkillDirectory(cfg.skillsDir),
      );
      agent = new BankAgent({
        storeDir: cfg.storeDir,
        brain,
        registry,
        invoker,
        intentMode: cfg.llmIntentMode,
        toolScope: cfg.llmToolScope,
      });
    }
    return agent;
  };

  /** 拉取外部工具并入注册表：失败只影响外部能力，内置工具照常可用。 */
  async function syncMcpTools(): Promise<void> {
    engine();
    if (mcp === undefined || registry === null) return;
    const decls = readServerDecls(cfg);
    const target = registry;
    let servers: Array<{ id: string }> = [];
    try {
      const listed = (await mcp.provider.list()) as { servers: Array<{ id: string }> };
      servers = listed.servers;
    } catch {
      return;
    }
    for (const server of servers) {
      try {
        const reply = (await mcp.provider.tools(server.id)) as { tools: McpTool[] };
        target.registerMany(mcpToolDescriptors(server.id, reply.tools, decls.get(server.id) ?? {}));
      } catch {
        // 单个服务器失败不影响其他服务与内置工具。
      }
    }
  }

  const ensureSync = (): Promise<void> => {
    if (syncPromise === null) syncPromise = syncMcpTools();
    return syncPromise;
  };

  return {
    name: "bank-agent",
    def: {
      service: "bank.agent",
      methods: ["chat", "swarm", "confirm", "cancel", "context", "audit", "scenarios", "intents", "redteam", "reset", "state", "model", "ask", "tools"],
      description: "银行 AI 智能体：意图理解（规则加模型）、三色判定、确认令牌、审计链与外部工具接入",
    },
    panel: {
      title: "银行智能体",
      description: "执行链路、风险判定与审计留痕",
      kind: "summary",
      source: "bank.agent.state",
    },
    provider: {
      async chat(...params: unknown[]): Promise<unknown> {
        await ensureSync();
        const sessionId = asString(params[0], "sessionId");
        const text = asString(params[1], "text");
        return await engine().chat(sessionId, text);
      },
      /** 蜂群协同：意图官、三评估官并行、仲裁官、执行官、审计官，轨迹随回复返回。 */
      async swarm(...params: unknown[]): Promise<unknown> {
        await ensureSync();
        const sessionId = asString(params[0], "sessionId");
        const text = asString(params[1], "text");
        return await engine().swarmChat(sessionId, text);
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
          tools: listToolSpecs(),
          contracts: TOOL_CONTRACTS,
          dimensions: POLICY_DIMENSIONS,
        };
      },
      intents(...params: unknown[]): unknown {
        const text = asString(params[0], "text");
        return parseIntent(text, engine().snapshot());
      },
      async redteam(...params: unknown[]): Promise<unknown> {
        await ensureSync();
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
        const runner = engine();
        return {
          ...runner.modelStatus(),
          llm: resolveLlmSummary(cfg),
          tools: brain === null ? 0 : brain.toolCount,
        };
      },
      /** 工具清单：内置与外部合计，供界面展示 harness 的接入状态。 */
      async tools(): Promise<unknown> {
        await ensureSync();
        const runner = engine();
        return { total: runner.tools.size, items: runner.toolInventory() };
      },
      /**
       * 对话式问答：模型可多轮调用只读工具取真实数据。
       * 识别到写操作意图时转交编排层，由策略引擎与确认令牌处理。
       */
      async ask(...params: unknown[]): Promise<unknown> {
        await ensureSync();
        const sessionId = asString(params[0], "sessionId");
        const text = asString(params[1], "text");
        const model = brain;
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
    },
  };
}

/** 模型配置摘要：只暴露供应商标识与模型名，不暴露密钥。 */
function resolveLlmSummary(cfg: RuntimeConfig): { baseUrl: string; model: string; configured: boolean } {
  const settings = cfg.llm ?? resolveLlm();
  return { baseUrl: settings.baseUrl, model: settings.model, configured: settings.apiKey !== "" };
}
