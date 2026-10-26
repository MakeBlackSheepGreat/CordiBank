import type { LlmClient } from "../llm/client.ts";
import { buildIntentUserMessage, INTENT_SYSTEM_PROMPT } from "../llm/prompts.ts";
import type { ChatMessage } from "../llm/types.ts";
import { yuan } from "./data.ts";
import { toIntent } from "./model-intent.ts";
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

  /** 解析用户输入；模型未配置或返回不合约时抛错，由编排层降级。 */
  async interpret(text: string): Promise<BrainResult> {
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
    const reply = await this.client.chat(messages);
    const parsed = toIntent(reply.content);
    return {
      intent: parsed.intent,
      meta: {
        model: reply.model,
        tokens: reply.tokens,
        latencyMs: reply.latencyMs,
        confidence: parsed.intent.confidence,
        droppedSlots: parsed.droppedSlots,
      },
    };
  }
}
