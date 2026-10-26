import { describe, expect, it } from "vitest";
import { extractJson, ModelIntentError, toIntent } from "../src/bank/model-intent.ts";

describe("模型输出契约", () => {
  it("合法 JSON 转成意图", () => {
    const parsed = toIntent('{"tool":"transfer","slots":{"payee":"小王","amountCents":50000},"confidence":0.92,"reason":"用户要转账"}');
    expect(parsed.intent.scene).toBe("transfer");
    expect(parsed.intent.tool).toBe("transfer");
    expect(parsed.intent.slots).toEqual({ payee: "小王", amountCents: 50000 });
    expect(parsed.intent.missing).toEqual([]);
    expect(parsed.intent.confidence).toBeCloseTo(0.92);
  });

  it("代码块包裹与前后缀文字都能提取", () => {
    const raw = '好的，结果如下：\n```json\n{"tool":"query_balance","slots":{},"confidence":0.9}\n```\n以上。';
    expect(extractJson(raw)).toEqual({ tool: "query_balance", slots: {}, confidence: 0.9 });
  });

  it("未登记的工具直接拒绝", () => {
    expect(() => toIntent('{"tool":"drop_table","slots":{},"confidence":0.99}')).toThrow(ModelIntentError);
  });

  it("越界金额被丢弃并进入追问", () => {
    const parsed = toIntent('{"tool":"transfer","slots":{"payee":"小王","amountCents":999999999},"confidence":0.95}');
    expect(parsed.droppedSlots).toContain("amountCents");
    expect(parsed.intent.missing).toContain("amountCents");
  });

  it("未声明的槽位被丢弃", () => {
    const parsed = toIntent('{"tool":"query_balance","slots":{"admin":true,"limit":100},"confidence":0.9}');
    expect(parsed.droppedSlots).toEqual(["admin", "limit"]);
    expect(parsed.intent.slots).toEqual({});
  });

  it("枚举越界被丢弃", () => {
    const parsed = toIntent('{"tool":"analyze_bills","slots":{"period":"forever"},"confidence":0.9}');
    expect(parsed.droppedSlots).toContain("period");
    expect(parsed.intent.slots).toEqual({});
  });

  it("低置信度返回未识别", () => {
    const parsed = toIntent('{"tool":"transfer","slots":{"payee":"小王","amountCents":50000},"confidence":0.2}');
    expect(parsed.intent.scene).toBe("unknown");
    expect(parsed.intent.reason).toContain("置信度不足");
  });

  it("非法 JSON 抛错", () => {
    expect(() => toIntent("我想转账五百元")).toThrow(ModelIntentError);
  });

  it("缺必填槽位时记为缺失", () => {
    const parsed = toIntent('{"tool":"transfer","slots":{"payee":"小王"},"confidence":0.9}');
    expect(parsed.intent.missing).toEqual(["amountCents"]);
  });
});
