import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { builtinToolDescriptors } from "../src/bank/builtin-tools.ts";
import { BankStore } from "../src/bank/data.ts";
import { ModelBrain } from "../src/bank/model-brain.ts";
import { resolveLlm } from "../src/config.ts";
import { ToolRegistry } from "../src/harness/registry.ts";
import { LlmClient } from "../src/llm/client.ts";
import { buildIntentToolset, buildIntentUserMessage, INTENT_SYSTEM_PROMPT } from "../src/llm/prompts.ts";
import type { ChatMessage } from "../src/llm/types.ts";

// 用量基准：对比开/关思考、全量与按场景声明、单轮解析与多轮循环的 token 开销。

const settings = { ...resolveLlm(), model: process.env.LLM_MODEL ?? "deepseek-flash", timeoutMs: 90000 };
const client = new LlmClient(settings);
const dir = mkdtempSync(path.join(tmpdir(), "cordibank-bench-"));
const store = new BankStore(dir);
const state = store.load();

const registry = new ToolRegistry();
registry.registerMany(builtinToolDescriptors());
const descriptors = registry.list();

const messages: ChatMessage[] = [
  { role: "system", content: INTENT_SYSTEM_PROMPT },
  {
    role: "user",
    content: buildIntentUserMessage({
      text: "转给王晓明 500 元",
      holder: state.account.holder,
      contacts: state.contacts.map((item) => item.name).slice(0, 8),
      subscriptions: state.subscriptions.map((item) => item.name),
      balanceYuan: (state.account.balance / 100).toFixed(2),
    }),
  },
];

const rows: string[][] = [];
function row(label: string, prompt: number, completion: number, reasoning: number, hit: number, ms: number): void {
  rows.push([label, String(prompt), String(completion), String(reasoning), String(hit), `${ms}ms`]);
}

console.log(`模型：${settings.model}    system 提示词：${INTENT_SYSTEM_PROMPT.length} 字符   工具：${descriptors.length} 个`);

const cold = await client.chat(messages, buildIntentToolset(descriptors), { toolChoice: "required", thinking: false });
row("意图解析·全量工具·首次", cold.usage.promptTokens, cold.usage.completionTokens, cold.usage.reasoningTokens, cold.usage.cacheHitTokens, cold.latencyMs);

const warm = await client.chat(messages, buildIntentToolset(descriptors), { toolChoice: "required", thinking: false });
row("意图解析·全量工具·第二次", warm.usage.promptTokens, warm.usage.completionTokens, warm.usage.reasoningTokens, warm.usage.cacheHitTokens, warm.latencyMs);

const scoped = await client.chat(messages, buildIntentToolset(descriptors, "transfer"), {
  toolChoice: "required",
  thinking: false,
});
row("意图解析·分场景声明", scoped.usage.promptTokens, scoped.usage.completionTokens, scoped.usage.reasoningTokens, scoped.usage.cacheHitTokens, scoped.latencyMs);

const thinking = await client.chat(messages, buildIntentToolset(descriptors), { toolChoice: "auto", thinking: true });
row("意图解析·开思考", thinking.usage.promptTokens, thinking.usage.completionTokens, thinking.usage.reasoningTokens, thinking.usage.cacheHitTokens, thinking.latencyMs);

const brain = new ModelBrain(client, () => store.load(), registry);
const loop = await brain.converse("我这个月的订阅一共多少钱？");
row("循环·只读问答", loop.usage.promptTokens, loop.usage.completionTokens, loop.usage.reasoningTokens, loop.usage.cacheHitTokens, 0);
console.log(`循环细节：${loop.usage.calls} 次请求，${loop.steps.flatMap((step) => step.calls).map((call) => call.name).join(" → ") || "无工具调用"}`);

const header = ["场景", "prompt", "completion", "reasoning", "cacheHit", "耗时"];
const widths = header.map((title, index) => Math.max(title.length, ...rows.map((line) => line[index].length)));
const render = (line: string[]): string => line.map((cell, index) => cell.padEnd(widths[index])).join("  ");
console.log("");
console.log(render(header));
for (const line of rows) console.log(render(line));

rmSync(dir, { recursive: true, force: true });
