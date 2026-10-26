import type { LlmClient } from "../llm/client.ts";
import { runAgentLoop, type LoopOutcome } from "../llm/loop.ts";
import { AGENT_SYSTEM_PROMPT, buildIntentTools, buildIntentUserMessage, INTENT_SYSTEM_PROMPT } from "../llm/prompts.ts";
import type { ChatMessage } from "../llm/types.ts";
import { ModelIntentError, toIntentFromCall } from "./model-intent.ts";
import { yuan } from "./data.ts";
import { buildLoopTools, createReadOnlyExecutor } from "./loop-tools.ts";
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
 * 模型大脑：只负责把自然语言转成受约束的意图。
 * 它拿不到执行权限，也拿不到审计写入权限，输出必须通过契约校验。
 */
export class ModelBrain {
  private readonly client: LlmClient;
  private readonly loadState: () => BankState;

  constructor(client: LlmClient, loadState: () => BankState) {
    this.client = client;
    this.loadState = loadState;
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
    const reply = await this.client.chat(messages, buildIntentTools(hint), { toolChoice: "required", thinking: false });
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
    const messages: ChatMessage[] = [
      { role: "system", content: AGENT_SYSTEM_PROMPT },
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
    return await runAgentLoop({
      client: this.client,
      messages,
      tools: buildLoopTools(),
      execute: createReadOnlyExecutor(this.loadState),
      ...options,
    });
  }
}
