import { createGuardedSink, dangerNotice, guardFinal, type GuardHit } from "../core/output-guard.ts";
import { emitDelta, hasStreamSink } from "../core/stream-context.ts";
import type { LlmClient } from "../llm/client.ts";
import { runAgentLoop, type LoopOutcome } from "../llm/loop.ts";
import { AGENT_SYSTEM_PROMPT, buildIntentToolset, buildIntentUserMessage, INTENT_SYSTEM_PROMPT } from "../llm/prompts.ts";
import type { ChatMessage, Effort, StreamDelta } from "../llm/types.ts";
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
  /** 关键词防控表：流式增量与终文都按它截断。 */
  private readonly guardKeywords: string[];
  /** 额外只读工具执行器：优先于内置与 MCP 分支。 */
  private readonly extras: Record<string, (args: Record<string, unknown>) => Promise<{ ok: boolean; summary: string }>>;

  constructor(
    client: LlmClient,
    loadState: () => BankState,
    registry?: ToolRegistry,
    invoker?: ExternalInvoker,
    loadSkills?: () => Skill[],
    guardKeywords?: string[],
    extras?: Record<string, (args: Record<string, unknown>) => Promise<{ ok: boolean; summary: string }>>,
  ) {
    this.client = client;
    this.loadState = loadState;
    this.invoker = invoker;
    this.loadSkills = loadSkills ?? (() => []);
    this.guardKeywords = guardKeywords ?? [];
    this.extras = extras ?? {};
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

  /** 当前思考强度。 */
  get effort(): Effort {
    return this.client.effort;
  }

  /** 调整思考强度；后续请求立即生效。 */
  setEffort(effort: Effort): void {
    this.client.setEffort(effort);
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
    // 意图解析关掉思考：抽槽是确定性任务，reasoning token 属于纯浪费。
    const reply = await this.client.chat(messages, buildIntentToolset(this.registry.list(), hint), {
      toolChoice: "required",
      effort: "off",
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
  async converse(
    text: string,
    options: {
      maxSteps?: number;
      tokenBudget?: number;
      effort?: Effort;
      onDelta?: (delta: StreamDelta) => void;
      /** 覆盖默认代理提示词；蜂群成员各带自己的角色提示词。 */
      systemPrompt?: string;
    } = {},
  ): Promise<LoopOutcome & { guardHit?: GuardHit }> {
    const state = this.loadState();
    const skills = this.loadSkills();
    const messages: ChatMessage[] = [
      { role: "system", content: options.systemPrompt ?? buildAgentPrompt(renderSkillCatalog(skills)) },
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
    // 处于流式请求上下文时自动走流式，调用方不必显式传回调。
    const sink = options.onDelta ?? (hasStreamSink() ? emitDelta : undefined);
    // 关键词防控：流式增量只放行安全前缀，命中即停；终文再做整段校验。
    const guarded = this.guardKeywords.length === 0 || sink === undefined
      ? undefined
      : createGuardedSink(sink, this.guardKeywords);
    const outcome = await runAgentLoop({
      client: this.client,
      messages,
      tools: buildLoopTools(tools),
      execute: createLoopExecutor(
        this.loadState,
        this.invoker,
        skills.length === 0
          ? { ...this.extras }
          : { ...this.extras, skill_load: createSkillLoader(skills) },
      ),
      ...(options.maxSteps === undefined ? {} : { maxSteps: options.maxSteps }),
      ...(options.tokenBudget === undefined ? {} : { tokenBudget: options.tokenBudget }),
      ...(options.effort === undefined ? {} : { effort: options.effort }),
      ...((sink === undefined || this.guardKeywords.length === 0)
        ? {}
        : { onDelta: guarded!.push }),
    });
    const final = guardFinal(outcome.text, this.guardKeywords);
    if (final.hit !== undefined && sink !== undefined) {
      // 流式已被截断时补一条危险提醒，让界面知道为何戛然而止。
      sink({ content: `\n\n${dangerNotice(final.hit)}`, reasoning: "" });
    }
    return { ...outcome, text: final.text, ...(final.hit === undefined ? {} : { guardHit: final.hit }) };
  }
}
