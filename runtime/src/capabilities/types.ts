import type { KernelContext } from "../kernel.ts";

/** 服务定义：能力对外暴露的服务名（如 "kb.engine"）与方法集合 */
export interface ServiceDefinition {
  service: string;
  methods: string[];
  description?: string;
  /** 侧栏 dock 面板声明（可选）：由注册表统一暴露给前端 */
  dock?: DockPane[];
}

/** 服务提供者：方法名 → 实现（同步返回值或 Promise 均可） */
export interface Provider {
  [method: string]: (...params: unknown[]) => unknown | Promise<unknown>;
}

/**
 * Rail 生命周期钩子（有序能力组合的生命周期事件）：
 * - onInvoke：能力被触发（如角色启动）
 * - onCall：能力方法被调用（包裹 provider，可观测/干预）
 * - onTask：任务/阶段边界的生命周期事件
 */
export type RailHook = "onInvoke" | "onCall" | "onTask";

/** Rail 事件负载 */
export interface RailEvent {
  hook: RailHook;
  /** 受作用主体（如角色名 / 服务名 / 任务阶段） */
  subject: string;
  serviceMethod?: string;
  params?: unknown[];
  data?: unknown;
}

/** Rail 规格：钩子 + 优先级 + 可见性门控 */
export interface RailSpec {
  hooks?: Partial<Record<RailHook, (event: RailEvent) => unknown | Promise<unknown>>>;
  /** 越小越先执行；缺省 0 */
  priority?: number;
  /** 可见性门控：返回 false 则跳过该 subject */
  visibility?: (subject: string) => boolean;
}

/** 侧栏 dock 面板：插件贡献的工作区面板，前端按 kind 决定渲染方式。 */
export interface DockPane {
  /** 面板标识，如 "tasks" / "context" / "jobs" / "lessons" / "canvas" */
  id: string;
  /** 面板标题（侧栏显示） */
  title: string;
  /** 一句话说明 */
  description?: string;
  /** 面板类型：team 团队 / context 上下文 / list 列表 / metrics 指标 / graph 图谱 / agent-teams 团队看板 */
  kind: "team" | "context" | "list" | "metrics" | "graph" | "agent-teams" | "workflow-run" | "plan-full";
  /** 读取面板数据的 RPC 方法名，支持 "$session" 占位 */
  source: string | null;
  /** 参数模板：值 "$session" 由前端替换为当前会话 id */
  params?: Record<string, unknown>;
  /** 排序权重：越小越靠前，缺省 0 */
  order?: number;
  /** 是否默认展开 */
  defaultOpen?: boolean;
}

/** 插件面板：插件声明的侧栏面板描述，前端按 kind 决定渲染方式。 */
export interface CapabilityPanel {
  /** 面板标题（侧栏显示） */
  title: string;
  /** 一句话说明 */
  description?: string;
  /** 面板类型：graph 提供可视化入口，summary 只展示摘要，agent-teams 为团队看板专属面板 */
  kind?: "graph" | "summary" | "agent-teams" | "workflow-run" | "plan-full";
  /** 读取面板摘要的服务方法，形如 "swarm.canvas.snapshot" */
  source?: string;
}

/** 能力插件：注册时的定义 + 提供者实现 + 挂载/卸载钩子 + 可选 Rails */
export interface CapabilityPlugin {
  name: string;
  def: ServiceDefinition;
  /** 侧栏面板声明（可选）：由注册表统一暴露给前端 */
  panel?: CapabilityPanel;
  provider: Provider;
  /** 挂载钩子（可选），可在此注册内核副作用（ctx.effect / ctx.on）；ctx 可选以兼容 registry 的无参调用 */
  mount?(ctx?: KernelContext): void;
  /** 卸载钩子（可选），用于回收挂载时产生的资源 */
  unmount?(): void;
  /** 有序能力组合 Rails（可选）：在生命周期钩子处按优先级执行 */
  rails?: RailSpec[];
}
