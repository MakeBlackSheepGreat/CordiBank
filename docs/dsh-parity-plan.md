# CordiBank × DSH 能力对齐实施规划

目标：把 DSH 桌面端可复刻的通用 Agent 能力（提供商注册表、技能中心、MCP 中心、Web 工具、沙箱执行、定时任务）以内置插件形式高效并入 CordiBank，并按赛题要求强化银行 Agent 特有能力。全部实现走 `CapabilityPlugin` 注册，不直接改 RPC 路由；每阶段过四项门禁（tsc / vitest / build / 真实链路）。

## P1 模型提供商注册表（多提供商 LLM 网关）

对齐 DSH：`dsh-llm` + `@earendil-works/pi-ai` 的官方内置提供商目录（36 家）。

- 新增 `runtime/src/llm/providers.ts`：`PROVIDER_CATALOG` 按 pi-ai 官方清单内置（id/name/baseUrl/api/envVar），支持 `openai-completions` 与 `anthropic-messages` 两种协议；提供 `resolveLlmSettings(provider, overrides)`——baseUrl 取目录值、apiKey 按提供商 envVar 从环境解析。
- `LlmClient` 增加协议分支：默认 openai-completions（现有实现）；anthropic-messages 走 `/v1/messages`（SSE 事件名映射到 StreamDelta）。
- `config.ts`：`CORDIBANK_LLM_PROVIDER`（默认 deepseek）+ `CORDIBANK_LLM_BASE_URL/MODEL/API_KEY` 覆盖链；reviewer/swarm-team/bank-agent 共用同一解析。
- RPC：`llm.providers`（目录列表 + 当前激活项 + key 是否已配置，不回显 key）。
- 测试：目录完整性（36 家、baseUrl 合法）、resolve 链、anthropic 协议请求形态。

## P2 技能中心升级

对齐 DSH：`dsh-skill` + `dsh-skill-filesystem`（技能目录化、SKILL.md 元数据、审计）。

- `skill.registry` 服务扩展：`list`（含分类/描述/触发词）、`read`（正文）、`search`（名称+正文关键词）；skill 插件已有增删查基础，补元数据规范（frontmatter name/description/triggers）。
- 前端「技能中心」面板：列出已装技能、查看详情、按关键词检索；数据全部来自真实 RPC。

## P3 MCP 连接器中心

对齐 DSH：`dsh-mcp-client` + `dsh-plugin-market`（多连接、启停、健康检查、凭据不落盘）。

- mcp 插件扩展：多连接注册（stdio/http）、`connect/disconnect/status/health` 方法、凭据只从环境变量读取（不写入存储）、目录元数据（id/name/category）。
- 前端「MCP 中心」面板：连接列表、状态徽章、启停操作。

## P4 Web 搜索 / 抓取工具

对齐 DSH：`dsh-tool-web` + `dsh-web-search-deepseek` + `dsh-web-fetch-http`。

- 新增 `runtime/src/plugins/web-tools.ts`：注册 `web.search` / `web.fetch` 两个只读工具进 ToolRegistry；搜索走可配置端点（默认 DeepSeek web search API），抓取为带超时/大小上限的纯文本抽取。
- 权限：只读（risk.write=false），审计留痕；`CORDIBANK_WEB_SEARCH` 控制开关。

## P5 OPS 沙箱执行层

对齐 DSH：`dsh-ptc-runtime` + `dsh-bash-sandbox` + `dsh-spill`（受控执行 + 结果暂存）。

- 新增 `runtime/src/plugins/ops.ts`：`ops.run` 工具——子进程执行白名单命令（node/python/数据分析脚本），工作目录锁在 `CORDIBANK_OPS_DIR`（默认临时目录，与 store 隔离）、超时、输出截断落盘（spill 文件 + 摘要返回）；每次执行写审计。
- 银行场景用途：账单数据分析、报表生成等只读计算。

## P6 定时任务与后台作业

对齐 DSH：`dsh-schedule` + `dsh-jobs`。

- 新增 `runtime/src/plugins/scheduler.ts`：持久化定时任务（store 下 JSON 存储、追加式审计），支持 interval/daily 两种节奏；到点执行绑定会话的银行 Agent 提示（如每日报表摘要）。
- 新增 `runtime/src/plugins/jobs.ts`：长任务 job id + 状态/输出拉取（`jobs.list/jobs.output/jobs.cancel`）。

## P7 赛题银行特有强化

- 确认令牌绑定参数摘要：confirm 令牌加入操作参数哈希，参数变动即失效（防篡改重放）。
- 自动评测脚本：`scripts/evaluate.mjs` 一键跑 G1-G10 核心指标（注入拦截率、误拦率、越权拦截、脱敏、审计完整、P95 延迟），输出评测报告。
- 一键演示：`scripts/demo.mjs` 拉起 runtime + web，按剧本自动执行演示会话。

## 顺序与验收

P1 → P2 → P3 → P4 → P5 → P6 → P7，逐条实现；每条完成即跑门禁四项 + 真实链路验证后进入下一条。
