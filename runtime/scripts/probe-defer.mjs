// 实测 DeepSeek 兼容端点对 defer_loading 与 tool-addition 的支持情况。
const KEY = process.env.DEEPSEEK_API_KEY ?? "";
const url = "https://api.deepseek.com/chat/completions";

const baseTool = (name, description) => ({
  type: "function",
  function: {
    name,
    description,
    parameters: { type: "object", properties: {}, required: [], additionalProperties: false },
  },
});

async function call(label, body) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${KEY}` },
    body: JSON.stringify({ model: "deepseek-flash", max_tokens: 200, ...body }),
  });
  const text = await response.text();
  let summary = text.slice(0, 200);
  try {
    const data = JSON.parse(text);
    if (data.error) summary = `ERROR: ${data.error.message}`;
    else {
      const message = data.choices?.[0]?.message ?? {};
      summary = `calls=${JSON.stringify((message.tool_calls ?? []).map((c) => [c.function.name, c.function.arguments]))} content=${JSON.stringify((message.content ?? "").slice(0, 40))} prompt=${data.usage?.prompt_tokens}`;
    }
  } catch {
    /* 保留原文 */
  }
  console.log(`${label}\n  ${response.status} ${summary}`);
}

// 1. 带 defer_loading 字段的声明是否能被接受
await call("1 声明带 defer_loading", {
  messages: [{ role: "user", content: "查一下余额" }],
  tools: [
    baseTool("query_balance", "查询余额"),
    { ...baseTool("transfer", "转账"), defer_loading: true },
  ],
  tool_choice: "required",
  thinking: { type: "disabled" },
});

// 2. developer 消息 + tool-addition 块能否激活
await call("2 developer tool-addition 激活", {
  messages: [
    { role: "developer", content: [{ type: "tool-addition", toolName: "transfer" }] },
    { role: "user", content: "转 100 给小王" },
  ],
  tools: [
    baseTool("query_balance", "查询余额"),
    { ...baseTool("transfer", "转账"), defer_loading: true },
  ],
  tool_choice: "required",
  thinking: { type: "disabled" },
});

// 3. 只有 deferred 工具时是否可被调用
await call("3 全部 deferred", {
  messages: [{ role: "user", content: "查一下余额" }],
  tools: [{ ...baseTool("query_balance", "查询余额"), defer_loading: true }],
  tool_choice: "required",
  thinking: { type: "disabled" },
});
