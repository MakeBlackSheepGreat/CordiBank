import type { LlmClient } from "../llm/client.ts";
import { runAgentLoop, type LoopOutcome } from "../llm/loop.ts";
import { AGENT_SYSTEM_PROMPT, buildIntentToolset, buildIntentUserMessage, INTENT_SYSTEM_PROMPT } from "../llm/prompts.ts";
import type { ChatMessage } from "../llm/types.ts";
import { ToolRegistry } from "../harness/registry.ts";
import type { ExternalInvoker } from "../harness/types.ts";
import type { Skill } from "../plugins/skill.ts";
import { builtinToolDescriptors } from "./builtin-tools.ts";
import { buildLoopTools, createLoopExecutor } from "./loop-tools.ts";
import { ModelIntentError, toIntentFromCall } from "./model-intent.ts";
import { buildAgentPrompt, createSkillLoader, renderSkillCatalog, skillLoadDescriptor } from "./skill-tools.ts";
import { yuan } from "./data.ts";
import type { BankState, Intent } from "./types.ts";

/** 模型调用元信息：写入审计，便于复盘模型是否被使用与耗时。 */
export interface ModelMeta {
  model: string;
  tokens: number;
  latencyMs: number;
  confidence: number;
  droppedSlots: string[];
}

export interface BrainResult {
  intent: Intent;
  meta: ModelMeta;
}

/**
 * 模型大脑：把自然语言转成受约束的意图，或按需调用只读工具取数。
 * 它拿不到执行权限，也拿不到审计写入权限。
 */
export class ModelBrain {
  private readonly client: LlmClient;
  private readonly loadState: () => BankState;
  private readonly registry: ToolRegistry;
  private readonly invoker: ExternalInvoker | undefined;
  private readonly loadSkills: () => Skill[];

  constructor(
    client: LlmClient,
    loadState: () => BankState,
    registry?: ToolRegistry,
    invoker?: ExternalInvoker,
    loadSkills?: () => Skill[],
  ) {
    this.client = client;
    this.loadState = loadState;
    this.invoker = invoker;
    this.loadSkills = loadSkills ?? (() => []);
    if (registry === undefined) {
      const fallback = new ToolRegistry();
      fallback.registerMany(builtinToolDescriptors());
      this.registry = fallback;
    } else {
      this.registry = registry;
    }
  }

  get available(): boolean {
    return this.client.configured;
  }

  get model(): string {
    return this.client.model;
  }

  get endpoint(): string {
    return this.client.endpoint;
  }

  /** 工具清单规模：内置与外部合计。 */
  get toolCount(): number {
    return this.registry.size;
  }

  /** 解析用户输入；hint 为规则粗判的场景，用于缩小工具声明范围。 */
  async interpret(text: string, hint?: string): Promise<BrainResult> {
    const state = this.loadState();
    const messages: ChatMessage[] = [
      { role: "system", content: INTENT_SYSTEM_PROMPT },
      {
        role: "user",
        content: buildIntentUserMessage({
          text,
          holder: state.account.holder,
          contacts: state.contacts.map((item) => item.name).slice(0, 8),
          subscriptions: state.subscriptions.map((item) => item.name),
          balanceYuan: yuan(state.account.balance),
        }),
      },
    ];
    // 意图解析关掉思考模式：抽槽是确定性任务，reasoning token 属于纯浪费。
    const reply = await this.client.chat(messages, buildIntentToolset(this.registry.list(), hint), {
      toolChoice: "required",
      thinking: false,
    });
    const call = reply.toolCalls[0];
    if (call === undefined) {
      throw new ModelIntentError("模型没有给出工具调用");
    }
    const parsed = toIntentFromCall(call.name, call.arguments);
    return {
      intent: parsed.intent,
      meta: {
        model: reply.model,
        tokens: reply.usage.promptTokens + reply.usage.completionTokens,
        latencyMs: reply.latencyMs,
        confidence: parsed.intent.confidence,
        droppedSlots: parsed.droppedSlots,
      },
    };
  }

  /**
   * 对话式求解：允许模型多轮调用只读工具查真实数据。
   * 写操作不执行，中断后把意图交回编排层。
   */
  async converse(text: string, options: { maxSteps?: number; tokenBudget?: number } = {}): Promise<LoopOutcome> {
    const state = this.loadState();
    const skills = this.loadSkills();
    const messages: ChatMessage[] = [
      { role: "system", content: buildAgentPrompt(renderSkillCatalog(skills)) },
      {
        role: "user",
        content: buildIntentUserMessage({
          text,
          holder: state.account.holder,
          contacts: state.contacts.map((item) => item.name).slice(0, 8),
          subscriptions: state.subscriptions.map((item) => item.name),
          balanceYuan: yuan(state.account.balance),
        }),
      },
    ];
    const tools = [
      ...this.registry.readonlyTools(),
      ...(skills.length === 0 ? [] : [skillLoadDescriptor()]),
    ];
    return await runAgentLoop({
      client: this.client,
      messages,
      tools: buildLoopTools(tools),
      execute: createLoopExecutor(
        this.loadState,
        this.invoker,
        skills.length === 0 ? {} : { skill_load: createSkillLoader(skills) },
      ),
      ...options,
    });
  }
}
