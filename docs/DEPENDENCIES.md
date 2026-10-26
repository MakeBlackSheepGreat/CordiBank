# 依赖与许可证清单

本项目未引入银行域之外的第三方业务依赖。以下为运行时与前端使用的全部直接依赖。

## 运行时直接依赖

| 依赖 | 版本 | 许可证 | 用途 |
|---|---|---|---|
| @cordisjs/core | 4.0.0-beta.5 | MIT | 插件内核与生命周期 |
| yaml | 2.9.1 | ISC | 配置读取 |

## 前端直接依赖

| 依赖 | 版本 | 许可证 | 用途 |
|---|---|---|---|
| vue | 3.5.41 | MIT | 视图框架 |
| pinia | 4.0.3 | MIT | 状态编排 |
| @fontsource-variable/noto-sans-sc | 5.3.0 | OFL-1.1 | 中文字体 |
| @fontsource-variable/jetbrains-mono | 5.3.0 | OFL-1.1 | 数字等宽字体 |

## 构建与测试依赖

| 依赖 | 版本 | 许可证 | 用途 |
|---|---|---|---|
| typescript | 5.9.3 | Apache-2.0 | 类型检查 |
| vite | 8.2.2 | MIT | 前端构建 |
| @vitejs/plugin-vue | 6.0.8 | MIT | Vue 单文件组件 |
| vue-tsc | 3.3.11 | MIT | 前端类型检查 |
| tailwindcss | 4.3.3 | MIT | 样式工具 |
| vitest | 2.1.9 | MIT | 单元测试 |
| eslint | 9.39.5 | MIT | 静态检查 |
| playwright | 1.63.0 | Apache-2.0 | 界面截图验收 |

## MCP 服务

`mcp/` 下三个服务为零依赖 Node 程序，只使用 `node:readline` 与 `node:crypto`，不引入任何第三方包。

## 数据声明

账户、联系人、账单、订阅、卡片与理财产品均为脚本生成的合成数据，由固定种子 `20261025` 确定。

汇率、征信与反欺诈返回为演示数据，不接真实行情与真实名单。

系统不接入真实支付通道。
