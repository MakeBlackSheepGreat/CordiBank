/** Cordis 兼容内核适配层：以官方 cordis（@cordisjs/core）为宿主，魔改增强。
 *
 * - 宿主：`new Context()`（cordis v4）——提供全量 Cordis 能力面
 *   （on/once/emit/parallel/serial/bail/waterfall、effect 可逆副作用、
 *   plugin/inject 依赖注入、scope 隔离、registry、reflect、logger）。
 * - 兼容桥接：保留本项目既有 `KernelContext` 契约（on/emit/effect/dispose），
 *   底层委托真实 cordis，保证业务代码与既有测试零改动。
 * - 魔改增强：
 *   a) `ctx.cordis` 暴露真实 cordis Context，供 Cordis 生态插件直接使用；
 *   b) `ctx.plugin/inject` 透传，可直接以 Cordis 原生形态加载第三方插件；
 *   c) `effect()` 的单个 disposer 抛错做隔离（不阻断后续回收）；
 *   d) `Kernel` 保留 load/unload/loaded 门面（同步语义），供框架内部编排。
 */

import { Context } from "@cordisjs/core";

/** 可逆副作用回收函数 */
export type Disposer = () => void;

/** 事件处理器 */
type Handler = (...args: unknown[]) => void;

/**
 * 内核上下文：兼容既有契约（on/emit/effect/dispose），并透传 Cordis 全量能力。
 *
 * `ctx` 是 bridge 对象：事件与副作用委托真实 cordis Context；`ctx.cordis`
 * 提供完整 Cordis Context 引用，供 Cordis 插件生态使用。
 */
export interface KernelContext {
  /** 注册事件监听，返回注销函数（调用后该 handler 不再收到该事件） */
  on(event: string, handler: Handler): Disposer;
  /** 注册一次性事件监听（触发一次后自动注销） */
  once(event: string, handler: Handler): Disposer;
  /** 触发事件，按注册顺序同步广播给全部监听者 */
  emit(event: string, ...args: unknown[]): void;
  /** 注册可逆副作用 disposer；dispose() 时按 LIFO 逆序执行（单个抛错隔离） */
  effect(disposer: Disposer): void;
  /** 回收全部副作用并清空监听（幂等：再次调用不再执行） */
  dispose(): void;

  /** 真实 Cordis Context（宿主）——增强：Cordis 插件可直接使用 */
  readonly cordis: Context;
  /** 以 Cordis 原生形态加载插件（Function/Constructor/Object.apply），返回 Fiber/scope */
  plugin: Context["plugin"];
  /** 依赖注入：等声明服务就绪后执行回调 */
  inject: Context["inject"];
  /** 当前 fiber：v4 的插件生命周期与副作用归属 */
  readonly fiber: Context["fiber"];
  /** 插件注册表 */
  readonly registry: Context["registry"];
  /** 反射/元数据服务 */
  readonly reflect: Context["reflect"];
}

/** 插件协议：具名 + apply(ctx) 挂载逻辑（兼容 Cordis Plugin.Object 形态） */
export interface Plugin {
  name: string;
  apply(ctx: KernelContext): void;
}

/** 构造桥接 KernelContext（内部闭包，仅供 Kernel 使用）。
 *
 * 魔改增强：事件广播委托真实 cordis（cordis 生态监听可同步收到）；
 * 副作用回收使用自研**同步** LIFO 栈（cordis 原生 effect 为异步回收，
 * 对协调层的确定性资源回收不友好），dispose() 同步回收后委托
 * root.fiber.dispose() 清 cordis 层副作用。
 */
function createKernelContext(root: Context): KernelContext {
  const effects: Disposer[] = [];
  const offs: Disposer[] = [];

  const bridge: KernelContext = {
    on(event, handler) {
      const off = root.events.on(event, handler as (...args: any[]) => any);
      const offFn: Disposer = () => {
        if (typeof off === "function") off();
      };
      offs.push(offFn);
      return () => {
        offFn();
        const idx = offs.indexOf(offFn);
        if (idx >= 0) offs.splice(idx, 1);
      };
    },

    once(event, handler) {
      const off = root.events.once(event, handler as (...args: any[]) => any);
      const offFn: Disposer = () => {
        if (typeof off === "function") off();
      };
      offs.push(offFn);
      return () => {
        offFn();
        const idx = offs.indexOf(offFn);
        if (idx >= 0) offs.splice(idx, 1);
      };
    },

    emit(event, ...args) {
      root.events.emit(event, ...args);
    },

    effect(disposer) {
      effects.push(disposer);
    },

    dispose() {
      // 同步 LIFO 回收副作用；单点抛错隔离
      while (effects.length > 0) {
        const disposer = effects.pop();
        if (!disposer) continue;
        try {
          disposer();
        } catch (err) {
          console.error("[kernel] effect disposer failed:", err);
        }
      }
      // 同步注销全部事件监听
      while (offs.length > 0) {
        const off = offs.pop();
        if (!off) continue;
        try {
          off();
        } catch (err) {
          console.error("[kernel] listener dispose failed:", err);
        }
      }
      // 委托 cordis 回收其自身副作用（v4 副作用归属 fiber，回收为异步且幂等）
      void Promise.resolve(root.fiber?.dispose?.()).catch((err: unknown) => {
        console.error("[kernel] cordis dispose failed:", err);
      });
    },

    get cordis() {
      return root;
    },
    plugin: ((plugin: unknown, ...args: unknown[]) =>
      (root.plugin as (p: unknown, ...rest: unknown[]) => unknown)(plugin, ...args)) as unknown as Context["plugin"],
    inject: ((deps: unknown, callback: (ctx: Context) => void) =>
      (root.inject as (d: unknown, cb: (ctx: Context) => void) => unknown)(deps, callback)) as unknown as Context["inject"],
    get fiber() {
      return root.fiber;
    },
    get registry() {
      return root.registry;
    },
    get reflect() {
      return root.reflect;
    },
  };
  return bridge;
}

/** 兼容 + 增强内核：以真实 cordis Context 为宿主，提供既有编排门面。 */
export class Kernel {
  /** 真实 Cordis 宿主上下文 */
  readonly root: Context;
  /** 桥接内核上下文（事件/副作用委托 cordis，并透传 cordis 全量能力） */
  readonly ctx: KernelContext;
  private readonly loadedPlugins: string[] = [];

  constructor(ctx?: KernelContext) {
    this.root = ctx && "cordis" in ctx ? (ctx.cordis as Context) : new Context();
    this.ctx = ctx ?? createKernelContext(this.root);
  }

  /** 记录已加载插件并同步调用 apply(ctx) 完成挂载（与既有语义一致） */
  load(plugin: Plugin): void {
    if (this.loadedPlugins.includes(plugin.name)) return;
    this.loadedPlugins.push(plugin.name);
    plugin.apply(this.ctx);
  }

  /** 从已加载列表移除；副作用回收由 ctx.dispose 语义配合，unload 本身仅记录移除 */
  unload(name: string): boolean {
    const idx = this.loadedPlugins.indexOf(name);
    if (idx === -1) return false;
    this.loadedPlugins.splice(idx, 1);
    return true;
  }

  /** 已加载插件名列表（保序） */
  loaded(): string[] {
    return [...this.loadedPlugins];
  }
}

export default Kernel;
