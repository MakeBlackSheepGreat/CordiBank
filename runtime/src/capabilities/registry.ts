import type { KernelContext } from "../kernel.ts";
import { redactError, redactValue } from "../core/redact.ts";
import type { CapabilityPlugin, DockPane, RailEvent, RailHook, RailSpec, ServiceDefinition } from "./types.ts";

/** 能力注册表：登记能力定义、按需挂载/卸载、按 "service.method" 路由调用。
 *
 * 内部用 Map（已注册，保序）+ Set（已挂载，保序）维护状态。
 */
export class CapabilityRegistry {
  private readonly registered = new Map<string, CapabilityPlugin>();
  private readonly mounted = new Set<string>();
  /** 显式卸载过的能力：不再被按需自动挂载。 */
  private readonly released = new Set<string>();

  /** 登记能力定义；重名抛 Error */
  register(plugin: CapabilityPlugin): void {
    if (this.registered.has(plugin.name)) {
      throw new Error(`[registry] capability "${plugin.name}" 已注册`);
    }
    this.registered.set(plugin.name, plugin);
  }

  /** 挂载能力：执行 mount 钩子后登记为已挂载；已挂载或未注册抛 Error */
  async mount(name: string, ctx?: KernelContext): Promise<void> {
    const plugin = this.registered.get(name);
    if (!plugin) {
      throw new Error(`[registry] capability "${name}" 未注册`);
    }
    if (this.mounted.has(name)) {
      throw new Error(`[registry] capability "${name}" 已挂载`);
    }
    await plugin.mount?.(ctx);
    this.mounted.add(name);
  }

  /** 卸载能力：先落卸载标记与 released，再执行 unmount 钩子（回滚）；未挂载抛 Error。
   * 钩子抛错时状态保持「未挂载且已释放」，避免半卸载的能力被后续调用当成可用。
   */
  async unmount(name: string): Promise<void> {
    if (!this.mounted.has(name)) {
      throw new Error(`[registry] capability "${name}" 未挂载`);
    }
    this.mounted.delete(name);
    this.released.add(name);
    await this.registered.get(name)?.unmount?.();
  }

  /**
   * 确保声明该服务的能力已挂载：幂等；显式卸载过的不自动重挂。
   * 入参兼容完整方法名（"agent.teams.snapshot"）与服务名（"agent.teams"）。
   * 通用 "service.method" 转发在调用前用它补齐按需挂载。
   */
  async ensureServiceMounted(serviceMethod: string, ctx?: KernelContext): Promise<void> {
    for (const [name, plugin] of this.registered) {
      if (this.mounted.has(name)) continue;
      const service = plugin.def.service;
      if (service === "" || (serviceMethod !== service && !serviceMethod.startsWith(`${service}.`))) continue;
      if (this.released.has(name)) return;
      await this.mount(name, ctx);
      return;
    }
  }

  /** 已挂载能力名列表（保持挂载顺序） */
  list(): string[] {
    return [...this.mounted];
  }

  /** 指定能力当前是否已挂载 */
  isMounted(name: string): boolean {
    return this.mounted.has(name);
  }

  /** 调用已挂载能力的服务方法，形如 "kb.engine.match"：
   * 按最后一个 "." 拆分为 service 与 method，在已挂载插件中查找对应服务并调用 provider[method]。
   * 服务未找到或方法不存在抛 Error。
   * 若插件注册了 onCall Rails，会在 provider 调用前按优先级触发（可观测/干预）。
   */
  async call(serviceMethod: string, params: unknown[], subject = "global"): Promise<unknown> {
    const dot = serviceMethod.lastIndexOf(".");
    if (dot <= 0 || dot === serviceMethod.length - 1) {
      throw new Error(`[registry] 非法方法 "${serviceMethod}"，应为 "service.method"`);
    }
    const service = serviceMethod.slice(0, dot);
    const method = serviceMethod.slice(dot + 1);

    for (const name of this.mounted) {
      const plugin = this.registered.get(name);
      if (plugin && plugin.def.service === service) {
        const fn = plugin.provider[method];
        if (typeof fn !== "function") {
          throw new Error(`[registry] 服务 "${service}" 无方法 "${method}"`);
        }
        await this.emitRails("onCall", { subject, serviceMethod, params: redactValue(params) as unknown[] });
        try {
          return await fn(...params);
        } catch (err) {
          throw redactError(err);
        }
      }
    }
    throw new Error(`[registry] 已挂载能力中未找到服务 "${service}"`);
  }

  /** 全部已注册能力（含未挂载），保持注册顺序 */
  describe(): Array<{ name: string; def: ServiceDefinition }> {
    return [...this.registered.values()].map((p) => ({ name: p.name, def: p.def }));
  }

  /** 插件面板清单：名称、标题、说明、类型、服务、摘要方法、已挂载状态。 */
  panels(): Array<{
    name: string;
    title: string;
    description: string;
    kind: "graph" | "summary" | "agent-teams" | "workflow-run" | "plan-full";
    service: string;
    source: string | null;
    methods: string[];
    mounted: boolean;
  }> {
    return [...this.registered.values()].map((plugin) => ({
      name: plugin.name,
      title: plugin.panel?.title ?? plugin.def.service,
      description: plugin.panel?.description ?? plugin.def.description ?? "",
      kind: plugin.panel?.kind ?? "summary",
      service: plugin.def.service,
      source: plugin.panel?.source ?? null,
      methods: [...plugin.def.methods],
      mounted: this.mounted.has(plugin.name),
    }));
  }

  /** 侧栏 dock 面板清单：只列声明 dock 的插件，按 order 升序（缺省 0）排列并附插件名。 */
  dockPanes(): Array<DockPane & { plugin: string }> {
    return [...this.registered.values()]
      .flatMap((plugin) => (plugin.def.dock ?? []).map((pane) => ({ ...pane, plugin: plugin.name })))
      .sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  }

  /** 内部：收集指定 hook+subject 下可执行的 rails，按优先级(升序)+挂载顺序排序 */
  private collectRails(
    hook: RailHook,
    subject: string,
  ): Array<{ pluginName: string; rail: RailSpec; order: number }> {
    const out: Array<{ pluginName: string; rail: RailSpec; order: number }> = [];
    let order = 0;
    for (const name of this.mounted) {
      const plugin = this.registered.get(name);
      if (!plugin?.rails) continue;
      for (const rail of plugin.rails) {
        const fn = rail.hooks?.[hook];
        if (!fn) continue;
        if (rail.visibility && !rail.visibility(subject)) continue;
        out.push({ pluginName: name, rail, order: order++ });
      }
    }
    out.sort((a, b) => (a.rail.priority ?? 0) - (b.rail.priority ?? 0) || a.order - b.order);
    return out;
  }

  /** 执行某个生命周期钩子上的全部 Rails（按优先级顺序），返回执行顺序与结果 */
  async emitRails(
    hook: RailHook,
    event: Omit<RailEvent, "hook">,
  ): Promise<{ order: string[]; results: unknown[] }> {
    const rails = this.collectRails(hook, event.subject);
    const order: string[] = [];
    const results: unknown[] = [];
    for (const r of rails) {
      const fn = r.rail.hooks?.[hook];
      if (!fn) continue;
      order.push(`${r.pluginName}@${r.rail.priority ?? 0}`);
      results.push(await fn({ ...event, hook }));
    }
    return { order, results };
  }

  /** 查询某个钩子在指定 subject 下的执行顺序（仅观查，不执行） */
  railOrder(hook: RailHook, subject: string): string[] {
    return this.collectRails(hook, subject).map(
      (r) => `${r.pluginName}@${r.rail.priority ?? 0}`,
    );
  }
}
