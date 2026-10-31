import { describe, expect, it } from "vitest";

import { OutputReviewer } from "../src/bank/reviewer.ts";
import type { LlmSettings } from "../src/llm/types.ts";

/** 指向必拒连端口的设置：reviewer 调用失败必须 fail-open 放行。 */
function unreachableSettings(): LlmSettings {
  return {
    baseUrl: "http://127.0.0.1:9/v1",
    apiKey: "test-key",
    model: "test-model",
    timeoutMs: 500,
    temperature: 0,
    maxTokens: 200,
    effort: "off",
  };
}

describe("output-reviewer 评估模型守卫", () => {
  it("未配密钥时不创建审查器，调用方据此跳过", () => {
    expect(OutputReviewer.fromSettings({ ...unreachableSettings(), apiKey: "" })).toBeUndefined();
    expect(OutputReviewer.fromSettings(unreachableSettings())).toBeInstanceOf(OutputReviewer);
  });

  it("空文本直接通过，不发起模型调用", async () => {
    const reviewer = OutputReviewer.fromSettings(unreachableSettings())!;
    expect(await reviewer.review("")).toEqual({ ok: true, reason: "" });
    expect(await reviewer.review("   ")).toEqual({ ok: true, reason: "" });
  });

  it("评估调用失败时 fail-open 放行并记录原因", async () => {
    const reviewer = OutputReviewer.fromSettings(unreachableSettings())!;
    const verdict = await reviewer.review("一段正常输出");
    expect(verdict.ok).toBe(true);
    expect(verdict.reason).toContain("调用失败");
  });
});
