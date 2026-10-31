import { AuditChain, maskSensitive } from "./audit.ts";
import { builtinToolDescriptors } from "./builtin-tools.ts";
import { ConfirmIssuer, digestOf } from "./confirm.ts";
import { BankStore, yuan } from "./data.ts";
import { checkPayeeOrigin, guardInput, guardOutput, scanUntrusted } from "./guard.ts";
import type { InjectionClassifier } from "./classifier.ts";
import { extractAmount, extractPayee, parseIntent } from "./intent.ts";
import type { ModelBrain } from "./model-brain.ts";
import { evaluate, specOf } from "./policy.ts";
import { executeTool } from "./tools.ts";
import { parseMcpToolName, ToolRegistry } from "../harness/registry.ts";
import type { ExternalInvoker } from "../harness/types.ts";
import { arbitrate, makeTrace, runAssessors, type SwarmStep } from "./swarm.ts";
import type {
  BankSession,
  BankState,
  ChatReply,
  Intent,
  IntentSlots,
  PolicyDecision,
  RiskLevel,
  SceneId,
  ToolResult,
} from "./types.ts";

const UNKNOWN_REPLY = "我没有听懂这个请求。可以试：查余额、分析这个月账单、转给小王 500 元、取消视频会员、锁卡、有哪些理财产品、帮我准备生日。";

/** 规则置信度低于该值时，交给模型再解析一次。 */
const MODEL_ESCALATE_BELOW = 0.7;

/** 会话内的意图草稿：用于多轮补全缺失槽位。 */
interface Draft {
  tool: string;
  scene: SceneId | "unknown";
  slots: IntentSlots;
  missing: string[];
}

export interface BankAgentOptions {
  storeDir: string;
  /** 模型大脑。缺省时系统只用规则解析，行为完全确定。 */
  brain?: ModelBrain;
  /** 意图模式：hybrid 规则优先，model 全部走模型，rule 只用规则。 */
  intentMode?: "rule" | "hybrid" | "model";
  /** 工具声明范围：scene 时按规则粗判的场景收窄声明，all 时全量声明。 */
  toolScope?: "all" | "scene";
  /** 工具注册表：外部工具由插件在握手后追加，缺省时只装内置工具。 */
  registry?: ToolRegistry;
  /** 外部工具调用器：把 mcp__ 前缀的工具转给对应服务。 */
  invoker?: ExternalInvoker;
  /** 输入侧语义分类器：正则守卫未命中时按注入语义裁决，未配置则跳过。 */
  classifier?: InjectionClassifier;
}

/** 银行智能体编排：守卫、解析、判定、确认、执行、审计六段式。 */
export class BankAgent {
  private readonly store: BankStore;
  private readonly chain: AuditChain;
  private readonly issuer: ConfirmIssuer;
  private readonly brain: ModelBrain | undefined;
  private readonly classifier: InjectionClassifier | undefined;
  private readonly intentMode: "rule" | "hybrid" | "model";
  private readonly toolScope: "all" | "scene";
  private readonly invoker: ExternalInvoker | undefined;
  readonly tools: ToolRegistry;
  private readonly sessions = new Map<string, BankSession>();
  private readonly drafts = new Map<string, Draft>();

  constructor(options: BankAgentOptions) {
    this.store = new BankStore(options.storeDir);
    this.chain = new AuditChain(options.storeDir);
    this.issuer = new ConfirmIssuer(options.storeDir);
    this.brain = options.brain;
    this.intentMode = options.intentMode ?? "hybrid";
    this.toolScope = options.toolScope ?? "all";
    this.invoker = options.invoker;
    this.tools = options.registry ?? new ToolRegistry();
    if (options.registry === undefined) this.tools.registerMany(builtinToolDescriptors());
    this.classifier = options.classifier;
  }

  /** 工具清单快照：含内置与已接入的外部工具。 */
  toolInventory(): Array<{ name: string; source: string; scene: string; level: string; write: boolean; summary: string }> {
    return this.tools.list().map((descriptor) => ({
      name: descriptor.name,
      source: descriptor.source,
      scene: descriptor.scene,
      level: descriptor.risk.level,
      write: descriptor.risk.write,
      summary: descriptor.summary,
    }));
  }

  /** 统一执行入口：内置走本地工具，外部走注入的调用器。 */
  private async run(tool: string, slots: IntentSlots, state: BankState): Promise<ToolResult> {
    const external = parseMcpToolName(tool);
    if (external !== null) {
      if (this.invoker === undefined) {
        return { ok: false, tool, message: "", error: "外部工具不可用：未注入调用器" };
      }
      const result = await this.invoker(external.serverId, external.remoteName, slots as Record<string, unknown>);
      return { ok: result.ok, tool, message: result.message, ...(result.data === undefined ? {} : { data: result.data }) };
    }
    return executeTool({ tool, slots, state });
  }

  /** 模型层状态：供界面与答辩展示，不暴露凭据。 */
  modelStatus(): Record<string, unknown> {
    const mode = this.intentMode;
    if (this.brain === undefined) {
      return { available: false, reason: "未注入模型", mode, model: "", endpoint: "" };
    }
    return {
      available: this.brain.available,
      mode,
      model: this.brain.model,
      endpoint: this.brain.endpoint,
      reason: this.brain.available ? "已配置" : "缺少密钥或地址",
    };
  }

  private session(sessionId: string): BankSession {
    const existing = this.sessions.get(sessionId);
    if (existing !== undefined) return existing;
    const created: BankSession = {
      id: sessionId,
      turns: [],
      counters: {},
      createdAt: new Date().toISOString(),
    };
    this.sessions.set(sessionId, created);
    return created;
  }

  private audit(input: {
    sessionId: string;
    userText: string;
    tool: string;
    params: Record<string, unknown>;
    decision: string;
    level: RiskLevel | "unknown";
    rules: string[];
    tokenDigest?: string;
    intentSource?: "rule" | "model" | "none";
    model?: { name: string; tokens: number; latencyMs: number };
    result: string;
  }): { seq: number; hash: string } {
    const state = this.store.load();
    const record = this.chain.append({
      sessionId: input.sessionId,
      actor: state.account.holder,
      userText: input.userText,
      tool: input.tool,
      params: input.params,
      decision: input.decision,
      policyLevel: input.level,
      policyRules: input.rules,
      ...(input.tokenDigest === undefined ? {} : { tokenDigest: input.tokenDigest }),
      ...(input.intentSource === undefined ? {} : { intentSource: input.intentSource }),
      ...(input.model === undefined ? {} : { model: input.model }),
      result: input.result,
    });
    return { seq: record.seq, hash: record.hash };
  }

  /** 内容侧巡检：账单备注与商户名属于外部写入，命中可疑指令即标记。 */
  inspectUntrusted(state: BankState): Array<{ source: string; matched: string }> {
    const hits: Array<{ source: string; matched: string }> = [];
    for (const bill of state.bills.slice(0, 40)) {
      const note = scanUntrusted(`账单 ${bill.id} 备注`, bill.note);
      if (note.suspicious) hits.push({ source: note.source, matched: note.matched });
      const merchant = scanUntrusted(`账单 ${bill.id} 商户名`, bill.merchant);
      if (merchant.suspicious) hits.push({ source: merchant.source, matched: merchant.matched });
    }
    return hits;
  }

  private preview(tool: string, slots: IntentSlots): string {
    const spec = specOf(tool);
    const label = spec?.label ?? tool;
    const amount = typeof slots.amountCents === "number" ? `${yuan(slots.amountCents)} 元` : "";
    const target = slots.payee ?? slots.subscriptionName ?? slots.cardId ?? slots.productId ?? "";
    if (tool === "transfer") return `向 ${target} 转账 ${amount}`;
    if (tool === "cancel_subscription") return `取消订阅 ${target}`;
    if (tool === "lock_card") return `锁定卡片 ${target}`;
    if (tool === "birthday_lock") return `锁定 ${amount} 用于${slots.purpose ?? "生日礼遇"}`;
    if (tool === "create_aa") return `发起 AA 收款，每人 ${amount}，共 ${slots.shares ?? 2} 人`;
    if (tool === "schedule_transfer") return `预约向 ${target} 转账 ${amount}`;
    return `${label} ${target} ${amount}`.trim();
  }

  private suggestionsFor(scene: SceneId | "unknown"): string[] {
    switch (scene) {
      case "transfer":
        return ["查看今日转账限额", "把小王加入常用收款人"];
      case "bills":
        return ["看下上个月账单", "有没有异常交易"];
      case "subscription":
        return ["列出所有订阅", "取消云盘自动续费"];
      case "card":
        return ["查卡片额度", "锁定信用卡"];
      case "wealth":
        return ["做一次风险测评", "对比稳健型产品"];
      case "cross":
        return ["查看生日资金锁定状态", "释放锁定资金"];
      default:
        return ["查余额", "分析这个月账单", "有哪些理财产品"];
    }
  }

  private reply(input: {
    session: BankSession;
    text: string;
    scene: SceneId | "unknown";
    decision: PolicyDecision;
    audit: { seq: number; hash: string };
    execution?: ToolResult;
    confirmation?: ChatReply["confirmation"];
    missing?: string[];
    suggestions?: string[];
    intentSource?: "rule" | "model";
  }): ChatReply {
    const { session, text } = input;
    const finalText = guardOutput(maskSensitive(text));
    session.turns.push({ role: "agent", text: finalText, ts: new Date().toISOString() });
    return {
      sessionId: session.id,
      turn: session.turns.length,
      reply: finalText,
      scene: input.scene,
      decision: input.decision,
      ...(input.confirmation === undefined ? {} : { confirmation: input.confirmation }),
      ...(input.execution === undefined ? {} : { execution: input.execution }),
      ...(input.intentSource === undefined ? {} : { intentSource: input.intentSource }),
      audit: input.audit,
      suggestions: input.suggestions ?? this.suggestionsFor(input.scene),
      missing: input.missing ?? [],
    };
  }

  private idleDecision(reason: string): PolicyDecision {
    return {
      level: "green",
      shape: "idle",
      hits: [{ rule: "no-pending", detail: reason, delta: "none" }],
      summary: reason,
      requiresConfirm: false,
      blocked: false,
    };
  }

  private blockedDecision(reason: string, rule = "injection"): PolicyDecision {
    return {
      level: "red",
      shape: "blocked",
      hits: [{ rule, detail: reason, delta: "block" }],
      summary: `已拦截：${reason}`,
      requiresConfirm: false,
      blocked: true,
      guidance: "这句话包含试图改变系统行为的指令，银行场景下不会执行。",
    };
  }

  /** 多轮补全：把上一轮缺失的槽位用本次输入补齐。 */
  private mergeDraft(draft: Draft, text: string, state: BankState): Draft {
    const slots: IntentSlots = { ...draft.slots };
    if (draft.missing.includes("amountCents")) {
      const amount = extractAmount(text);
      if (amount !== null) slots.amountCents = amount;
    }
    if (draft.missing.includes("payee")) {
      const payee = extractPayee(text, state);
      if (payee !== undefined) slots.payee = payee;
    }
    if (draft.missing.includes("subscriptionName")) {
      const name = state.subscriptions.find((item) => text.includes(item.name) || (item.name.includes("视频") && text.includes("视频")));
      if (name !== undefined) slots.subscriptionName = name.name;
    }
    const missing = draft.missing.filter((key) => {
      if (key === "amountCents") return slots.amountCents === undefined;
      if (key === "payee") return slots.payee === undefined;
      if (key === "subscriptionName") return slots.subscriptionName === undefined;
      if (key === "productId") return slots.productId === undefined;
      return true;
    });
    return { ...draft, slots, missing };
  }

  private askFor(missing: string[]): string {
    const labels: Record<string, string> = {
      payee: "收款人是谁",
      amountCents: "金额是多少",
      subscriptionName: "要取消哪一项订阅",
      productId: "想买哪一款产品",
    };
    return `还需要确认：${missing.map((key) => labels[key] ?? key).join("、")}。`;
  }

  async chat(sessionId: string, raw: string): Promise<ChatReply> {
    const state = this.store.load();
    const session = this.session(sessionId);
    const text = raw.trim();
    if (text === "") {
      const decision = this.blockedDecision("输入为空");
      const audit = this.audit({ sessionId, userText: text, tool: "unknown", params: {}, decision: "rejected_empty", level: "red", rules: ["empty-input"], result: "拒绝空输入" });
      return this.reply({ session, text: "请输入具体需求。", scene: "unknown", decision, audit });
    }

    session.turns.push({ role: "user", text, ts: new Date().toISOString() });
    // 来源判定用整段会话文本：多轮补全时收款人来自前几轮，同样算用户亲口给出。
    const originText = session.turns
      .filter((turn) => turn.role === "user")
      .map((turn) => turn.text)
      .join(" ");

    // 第一段：输入守卫。命中注入特征直接拦截，不进入意图解析。
    let verdict = guardInput(text);
    if (!verdict.attack && this.classifier !== undefined) {
      // 正则未命中再过语义分类：同义改写的注入由检查单裁决，不走关键词。
      const semantic = await this.classifier.inspect(text);
      if (semantic.injection) {
        verdict = { attack: true, kind: semantic.kind, matched: `语义识别：${semantic.reason}`, sanitized: verdict.sanitized };
      }
    }
    if (verdict.attack) {
      const decision = this.blockedDecision(verdict.matched);
      const audit = this.audit({
        sessionId,
        userText: text,
        tool: "unknown",
        params: {},
        decision: "blocked_injection",
        level: "red",
        rules: [`injection-${verdict.kind}`],
        result: `拦截输入侧注入：${verdict.matched}`,
      });
      session.counters.injection = (session.counters.injection ?? 0) + 1;
      return this.reply({
        session,
        text: `这句话包含「${verdict.matched}」，属于试图改写系统规则的指令，我不会执行。如果你确实有业务需求，请直接说明要办的业务。`,
        scene: "unknown",
        decision,
        audit,
        suggestions: ["查余额", "分析这个月账单", "转给小王 500 元"],
      });
    }

    // 第二段：确认与取消走独立分支。
    if (session.pending !== undefined) {
      if (/^(确认|确定|是|好|可以|执行|同意|y|yes)$/i.test(text)) {
        return this.confirmInternal(session, text, state);
      }
      if (/^(取消|不|否|算了|不要|n|no)$/i.test(text)) {
        const pending = session.pending;
        session.pending = undefined;
        const decision: PolicyDecision = {
          level: "yellow",
          shape: "cancelled",
          hits: [{ rule: "user-cancel", detail: "用户取消", delta: "none" }],
          summary: "用户取消，未执行任何操作",
          requiresConfirm: false,
          blocked: false,
        };
        const audit = this.audit({
          sessionId,
          userText: text,
          tool: pending.tool,
          params: pending.slots as Record<string, unknown>,
          decision: "cancelled_by_user",
          level: "yellow",
          rules: ["user-cancel"],
          tokenDigest: pending.digest,
          result: "用户取消，余额未变动",
        });
        return this.reply({ session, text: "已取消，没有执行任何操作，余额未变动。", scene: "transfer", decision, audit });
      }
    }

    // 第三段：拒绝依据外部内容发起付款。账单备注、小票、短信都属于外部写入。
    const indirectReference =
      /(按|依据|根据|按照|照).{0,8}(账单|备注|小票|截图|短信|邮件|通知|商户|客服).{0,8}(转|付|汇|打款)/.test(verdict.sanitized) ||
      /(账单|备注|小票|短信|邮件|通知|商户|客服).{0,10}(写着|说要|要求|让我|叫我).{0,10}(转|付|汇|打款)/.test(verdict.sanitized);
    if (indirectReference) {
      const decision = this.blockedDecision("委托依据外部内容发起付款", "indirect-reference");
      const audit = this.audit({
        sessionId,
        userText: text,
        tool: "unknown",
        params: {},
        decision: "blocked_indirect_reference",
        level: "red",
        rules: ["indirect-reference"],
        result: "拒绝依据账单或备注内容发起付款",
      });
      return this.reply({
        session,
        text: "付款对象的来源必须是你的直接指令。账单备注、短信和小票属于外部内容，可能被伪造，我不会据此发起转账。请直接告诉我要转给谁、转多少。",
        scene: "unknown",
        decision,
        audit,
      });
    }

    // 第四段：意图解析，必要时用草稿补全。
    if (session.pending !== undefined) session.pending = undefined;
    const draft = this.drafts.get(sessionId);
    let intent: Intent = parseIntent(verdict.sanitized, state);
    let intentSource: "rule" | "model" = "rule";
    let modelMeta: { name: string; tokens: number; latencyMs: number } | undefined;
    let degradeNote = "";
    if (intent.scene === "unknown" && draft !== undefined) {
      const merged = this.mergeDraft(draft, verdict.sanitized, state);
      if (merged.missing.length < draft.missing.length) {
        intent = {
          scene: merged.scene,
          tool: merged.tool,
          slots: merged.slots,
          missing: merged.missing,
          confidence: 0.85,
          reason: "由上一轮草稿补齐槽位",
        };
      }
    }

    // 规则不确定时交给模型补判。模型输出仍需通过契约校验与后续全部安全链。
    const modelAllowed = this.brain !== undefined && this.brain.available && this.intentMode !== "rule";
    const modelNeeded =
      this.intentMode === "model" || intent.scene === "unknown" || intent.confidence < MODEL_ESCALATE_BELOW;
    if (modelAllowed && modelNeeded) {
      try {
        const hint = this.toolScope === "scene" ? intent.scene : undefined;
        const result = await this.brain.interpret(verdict.sanitized, hint);
        if (result.intent.scene !== "unknown") {
          intent = result.intent;
          intentSource = "model";
          modelMeta = { name: result.meta.model, tokens: result.meta.tokens, latencyMs: result.meta.latencyMs };
        } else {
          degradeNote = "模型未能给出可执行意图";
        }
      } catch (error) {
        degradeNote = `模型调用失败：${error instanceof Error ? error.message : String(error)}`;
      }
    }

    if (intent.scene === "unknown") {
      const decision: PolicyDecision = {
        level: "green",
        shape: "unmatched",
        hits: [{ rule: "intent-miss", detail: "未命中场景", delta: "none" }],
        summary: "未识别到可执行的业务意图",
        requiresConfirm: false,
        blocked: false,
      };
      const audit = this.audit({ sessionId, userText: text, tool: "unknown", params: {}, decision: "unmatched", level: "unknown", rules: ["intent-miss"], result: degradeNote === "" ? "未识别意图" : `未识别意图（${degradeNote}）` });
      return this.reply({ session, text: UNKNOWN_REPLY, scene: "unknown", decision, audit });
    }

    session.lastScene = intent.scene;

    // 第五段：槽位不完整时追问，并把草稿留给下一轮补全。
    if (intent.missing.length > 0) {
      this.drafts.set(sessionId, { tool: intent.tool, scene: intent.scene, slots: intent.slots, missing: intent.missing });
      const decision: PolicyDecision = {
        level: "green",
        shape: "need-slots",
        hits: [{ rule: "slot-missing", detail: intent.missing.join(","), delta: "none" }],
        summary: "槽位不完整，已追问",
        requiresConfirm: false,
        blocked: false,
      };
      const audit = this.audit({
        sessionId,
        userText: text,
        tool: intent.tool,
        params: intent.slots as Record<string, unknown>,
        decision: "need_slots",
        level: "unknown",
        rules: ["slot-missing"],
        intentSource,
        ...(modelMeta === undefined ? {} : { model: modelMeta }),
        result: `缺失槽位：${intent.missing.join(",")}${degradeNote === "" ? "" : `（${degradeNote}）`}`,
      });
      return this.reply({ session, text: this.askFor(intent.missing), scene: intent.scene, decision, audit, missing: intent.missing, intentSource });
    }

    this.drafts.delete(sessionId);

    // 第六段：参数来源校验，挡住来自外部内容的收款人。
    if (intent.tool === "transfer" || intent.tool === "schedule_transfer" || intent.tool === "create_aa") {
      const payee = intent.slots.payee ?? "";
      const origin = checkPayeeOrigin(payee, originText, state);
      if (!origin.trusted) {
        const decision = this.blockedDecision(origin.reason, "payee-origin");
        const audit = this.audit({
          sessionId,
          userText: text,
          tool: intent.tool,
          params: intent.slots as Record<string, unknown>,
          decision: "blocked_untrusted_origin",
          level: "red",
          rules: ["payee-origin"],
          intentSource,
          ...(modelMeta === undefined ? {} : { model: modelMeta }),
          result: `拦截不可信来源：${origin.reason}`,
        });
        return this.reply({
          session,
          text: `${origin.reason}。我不会根据账单或备注里的信息发起转账，请直接告诉我要转给谁。`,
          scene: intent.scene,
          decision,
          audit,
          intentSource,
        });
      }
    }

    // 第七段：策略判定。
    const decision = evaluate({ tool: intent.tool, params: intent.slots as Record<string, unknown>, state });
    const rules = decision.hits.map((hit) => hit.rule);

    if (decision.blocked) {
      const audit = this.audit({
        sessionId,
        userText: text,
        tool: intent.tool,
        params: intent.slots as Record<string, unknown>,
        decision: "blocked_policy",
        level: "red",
        rules,
        intentSource,
        ...(modelMeta === undefined ? {} : { model: modelMeta }),
        result: decision.summary,
      });
      return this.reply({
        session,
        text: `这个操作我不能直接执行。${decision.hits.filter((hit) => hit.delta === "block").map((hit) => hit.detail).join("；")}。${decision.guidance ?? ""}`,
        scene: intent.scene,
        decision,
        audit,
        intentSource,
      });
    }

    if (decision.requiresConfirm) {
      const preview = this.preview(intent.tool, intent.slots);
      const ticket = this.issuer.issue({
        sessionId,
        tool: intent.tool,
        slots: intent.slots,
        ttlSeconds: state.policy.confirmTtlSeconds,
        preview,
      });
      session.pending = {
        token: ticket.token,
        digest: ticket.digest,
        tool: intent.tool,
        slots: intent.slots,
        expiresAt: ticket.expiresAt,
        preview,
      };
      const audit = this.audit({
        sessionId,
        userText: text,
        tool: intent.tool,
        params: intent.slots as Record<string, unknown>,
        decision: "pending_confirm",
        level: "yellow",
        rules,
        intentSource,
        ...(modelMeta === undefined ? {} : { model: modelMeta }),
        tokenDigest: ticket.digest,
        result: `等待用户确认：${preview}`,
      });
      return this.reply({
        session,
        text: `准备执行：${preview}。这项操作需要你确认，回复「确认」后立即执行，${state.policy.confirmTtlSeconds} 秒内有效。`,
        scene: intent.scene,
        decision,
        confirmation: ticket,
        audit,
        intentSource,
      });
    }

    // 第八段：绿色操作直接执行。
    const execution = await this.run(intent.tool, intent.slots, state);
    const untrusted = intent.tool === "analyze_bills" ? this.inspectUntrusted(state) : [];
    const note =
      untrusted.length > 0
        ? `另外，检测到 ${untrusted.length} 条账单备注包含可疑指令，已按数据处理并忽略。`
        : "";
    const audit = this.audit({
      sessionId,
      userText: text,
      tool: intent.tool,
      params: intent.slots as Record<string, unknown>,
      decision: execution.ok ? "auto_execute" : "executed_with_error",
      level: "green",
      rules,
      intentSource,
      ...(modelMeta === undefined ? {} : { model: modelMeta }),
      result: execution.ok ? execution.message : (execution.error ?? "执行失败"),
    });
    if (execution.ok) this.store.save(state);
    return this.reply({
      session,
      text: `${this.renderExecution(execution)}${note}`,
      scene: intent.scene,
      decision,
      execution,
      audit,
      intentSource,
    });
  }

  private renderExecution(result: ToolResult): string {
    if (!result.ok) return `没有执行成功：${result.error ?? result.message}`;
    const data = result.data as Record<string, unknown> | undefined;
    if (result.tool === "analyze_bills" && data !== undefined) {
      const report = data as {
        totalCents: number;
        count: number;
        categories: Array<{ category: string; totalCents: number; share: number }>;
        anomalies: Array<{ merchant: string; amountCents: number; reason: string }>;
        subscriptionCharge: number;
      };
      const top = report.categories
        .slice(0, 4)
        .map((item) => `${item.category} ${yuan(item.totalCents)} 元（${(item.share * 100).toFixed(0)}%）`)
        .join("，");
      const anomalies = report.anomalies.slice(0, 3).map((item) => `${item.merchant} ${yuan(item.amountCents)} 元，${item.reason}`).join("；");
      return [
        `本期账单共 ${report.count} 笔，合计 ${yuan(report.totalCents)} 元。`,
        `分类占比：${top}。`,
        `订阅扣费合计 ${yuan(report.subscriptionCharge)} 元。`,
        anomalies === "" ? "未发现异常交易。" : `发现异常：${anomalies}。`,
      ].join("");
    }
    if (result.tool === "list_subscriptions" && data !== undefined) {
      const items = data.items as Array<{ name: string; amountCents: number; nextChargeAt: string }>;
      const detail = items.map((item) => `${item.name} ${yuan(item.amountCents)} 元，下次扣费 ${item.nextChargeAt}`).join("；");
      return `${result.message}。${detail}。`;
    }
    if (result.tool === "list_cards" && data !== undefined) {
      const cards = data.cards as Array<{ tail: string; kind: string; status: string; limitCents: number; availableCents: number }>;
      const detail = cards
        .map((card) => `尾号 ${card.tail}（${card.kind === "credit" ? "信用" : "借记"}，${card.status === "active" ? "正常" : card.status === "locked" ? "已锁定" : "已挂失"}）额度 ${yuan(card.limitCents)} 元，可用 ${yuan(card.availableCents)} 元`)
        .join("；");
      return `${result.message}。${detail}。`;
    }
    if (result.tool === "wealth_list" && data !== undefined) {
      const products = data.products as Array<{ name: string; riskLevel: number; annualRate: string; minAmountCents: number; termDays: number }>;
      const detail = products
        .map((item) => `${item.name}（${item.riskLevel} 级风险，年化 ${item.annualRate}，${item.termDays === 0 ? "随时可取" : `${item.termDays} 天`}，起购 ${yuan(item.minAmountCents)} 元）`)
        .join("；");
      return `${result.message}：${detail}。`;
    }
    return result.message;
  }

  private async confirmInternal(session: BankSession, text: string, state: BankState): Promise<ChatReply> {
    const pending = session.pending;
    if (pending === undefined) {
      const decision = this.idleDecision("没有待确认的操作");
      const audit = this.audit({ sessionId: session.id, userText: text, tool: "unknown", params: {}, decision: "no_pending", level: "unknown", rules: ["no-pending"], result: "无待确认操作" });
      return this.reply({ session, text: "当前没有待确认的操作。", scene: "unknown", decision, audit });
    }

    const check = this.issuer.verify({ token: pending.token, sessionId: session.id, tool: pending.tool, slots: pending.slots });
    if (!check.ok) {
      session.pending = undefined;
      const decision = this.blockedDecision(check.reason);
      const audit = this.audit({
        sessionId: session.id,
        userText: text,
        tool: pending.tool,
        params: pending.slots as Record<string, unknown>,
        decision: "blocked_token_invalid",
        level: "red",
        rules: ["confirm-token"],
        tokenDigest: pending.digest,
        result: `确认令牌校验失败：${check.reason}`,
      });
      return this.reply({
        session,
        text: `确认失败：${check.reason}。操作没有执行，请重新发起。`,
        scene: "transfer",
        decision,
        audit,
      });
    }

    const recheck = evaluate({ tool: pending.tool, params: pending.slots as Record<string, unknown>, state });
    if (recheck.blocked) {
      session.pending = undefined;
      const audit = this.audit({
        sessionId: session.id,
        userText: text,
        tool: pending.tool,
        params: pending.slots as Record<string, unknown>,
        decision: "blocked_recheck",
        level: "red",
        rules: recheck.hits.map((hit) => hit.rule),
        tokenDigest: pending.digest,
        result: recheck.summary,
      });
      return this.reply({
        session,
        text: `确认时复核未通过：${recheck.hits.filter((hit) => hit.delta === "block").map((hit) => hit.detail).join("；")}。操作没有执行。`,
        scene: "transfer",
        decision: recheck,
        audit,
      });
    }

    session.pending = undefined;
    const execution = await this.run(pending.tool, pending.slots, state);
    const audit = this.audit({
      sessionId: session.id,
      userText: text,
      tool: pending.tool,
      params: pending.slots as Record<string, unknown>,
      decision: execution.ok ? "confirmed" : "executed_with_error",
      level: "yellow",
      rules: recheck.hits.map((hit) => hit.rule),
      tokenDigest: pending.digest,
      result: execution.ok ? execution.message : (execution.error ?? "执行失败"),
    });
    if (execution.ok) this.store.save(state);
    const settled: PolicyDecision = {
      ...recheck,
      shape: "confirmed",
      summary: execution.ok ? `已确认并执行：${pending.preview}` : `已确认但执行失败：${execution.error ?? "未知原因"}`,
      requiresConfirm: false,
      blocked: false,
    };
    return this.reply({
      session,
      text: this.renderExecution(execution),
      scene: "transfer",
      decision: settled,
      execution,
      audit,
    });
  }

  /** 外部确认入口：允许传入被替换的参数，用于验证令牌绑定是否生效。 */
  /**
   * 蜂群协同入口：意图官解析，三个评估官并行，仲裁官合并，执行与审计各归其位。
   * 与 chat 的差别只在评估层：chat 用单次策略判定，swarmChat 用多角色并行评估后合并。
   */
  async swarmChat(sessionId: string, raw: string): Promise<ChatReply> {
    const started = Date.now();
    const session = this.session(sessionId);
    const state = this.store.load();
    const steps: SwarmStep[] = [];
    const record = (step: SwarmStep): void => {
      steps.push(step);
    };

    // 第一步：输入守卫，命中即拦，不进入后续角色。
    let guard = guardInput(raw);
    if (!guard.attack && this.classifier !== undefined) {
      const semantic = await this.classifier.inspect(raw);
      if (semantic.injection) {
        guard = { attack: true, kind: semantic.kind, matched: `语义识别：${semantic.reason}`, sanitized: guard.sanitized };
      }
    }
    if (guard.attack) {
      record({ role: "intent", label: "输入守卫", input: raw.slice(0, 40), output: guard.matched, level: "red", elapsedMs: 0, ok: true });
      const decision = this.blockedDecision(`${guard.kind}：${guard.matched}`);
      const audit = this.audit({
        sessionId,
        userText: raw,
        tool: "none",
        params: {},
        decision: "blocked_injection",
        level: "red",
        rules: ["injection"],
        result: "已拦截",
      });
      const trace = makeTrace(steps, started);
      return {
        ...this.reply({
          session,
          text: "这句话里包含改变规则的内容，我不会执行。请直接说要办什么业务。",
          scene: "unknown",
          decision,
          audit,
        }),
        trace,
      };
    }

    // 第二步：意图官。规则优先，规则不确定时交给模型，输出仍要过契约。
    const intentStarted = Date.now();
    const draft = this.drafts.get(sessionId);
    let intent = parseIntent(raw, state);
    let intentSource: "rule" | "model" = "rule";
    if (intent.scene === "unknown" && draft !== undefined && typeof intent.slots.amountCents === "number") {
      intent = {
        ...draft,
        slots: { ...draft.slots, amountCents: intent.slots.amountCents },
        missing: [],
        confidence: 0.8,
        reason: "沿用上一轮草稿，仅补金额",
      };
    }
    if ((intent.scene === "unknown" || intent.confidence < 0.7) && this.brain !== undefined && this.brain.available) {
      try {
        const parsed = await this.brain.interpret(raw, intent.scene === "unknown" ? undefined : intent.scene);
        intent = parsed.intent;
        intentSource = "model";
      } catch {
        // 模型不可用时保持规则结论，不阻塞对话。
      }
    }
    record({
      role: "intent",
      label: "意图官",
      input: raw.slice(0, 40),
      output: `${intent.tool}（${intentSource === "rule" ? "规则" : "模型"}）`,
      level: "none",
      elapsedMs: Date.now() - intentStarted,
      ok: intent.scene !== "unknown",
    });

    if (intent.scene === "unknown") {
      const audit = this.audit({
        sessionId,
        userText: raw,
        tool: "unknown",
        params: {},
        decision: "unmatched",
        level: "unknown",
        rules: ["intent-miss"],
        result: "未识别",
      });
      return {
        ...this.reply({
          session,
          text: "我没有听懂。可以试：查余额、分析账单、转给小王 500 元、取消云幕视频会员、锁卡、赎回理财。",
          scene: "unknown",
          decision: this.idleDecision("未识别意图"),
          audit,
          intentSource,
        }),
        trace: makeTrace(steps, started),
      };
    }

    if (intent.missing.length > 0) {
      this.drafts.set(sessionId, { tool: intent.tool, slots: intent.slots, missing: intent.missing, scene: intent.scene } as Draft);
      const audit = this.audit({
        sessionId,
        userText: raw,
        tool: intent.tool,
        params: intent.slots as Record<string, unknown>,
        decision: "need_slots",
        level: "unknown",
        rules: ["slot-missing"],
        result: `缺失 ${intent.missing.join(",")}`,
      });
      return {
        ...this.reply({
          session,
          text: this.askFor(intent.missing),
          scene: intent.scene,
          decision: this.idleDecision(`等待补充：${intent.missing.join("、")}`),
          audit,
          missing: intent.missing,
          intentSource,
        }),
        trace: makeTrace(steps, started),
      };
    }

    // 第三步：三个评估官并行，任一失败不拖累其余。
    const assess = await runAssessors({
      state,
      policy: state.policy,
      tool: intent.tool,
      slots: intent.slots,
      text: raw,
    });
    for (const step of assess.steps) record(step);
    const final = arbitrate(assess.results);
    record({
      role: "arbiter",
      label: "仲裁官",
      input: `${assess.results.length} 份评估`,
      output: `${final.level}｜${final.hits.map((hit) => hit.rule).join("、") || "无命中"}`,
      level: final.level,
      elapsedMs: 0,
      ok: true,
    });

    const decision: PolicyDecision = {
      level: final.level,
      shape: final.blocked ? "blocked" : final.requiresConfirm ? "confirm" : "auto",
      hits: final.hits,
      summary: final.summary,
      requiresConfirm: final.requiresConfirm,
      blocked: final.blocked,
    };

    // 第四步：执行官。拦截、待确认、直接执行三条路。
    if (decision.blocked) {
      const audit = this.audit({
        sessionId,
        userText: raw,
        tool: intent.tool,
        params: intent.slots as Record<string, unknown>,
        decision: "blocked_policy",
        level: "red",
        rules: decision.hits.map((hit) => hit.rule),
        result: decision.summary,
      });
      record({ role: "executor", label: "执行官", input: intent.tool, output: "拦截，未执行", level: "red", elapsedMs: 0, ok: true });
      record({ role: "auditor", label: "审计官", input: `seq ${audit.seq}`, output: "已留痕", level: "none", elapsedMs: 0, ok: true });
      return {
        ...this.reply({
          session,
          text: `这个操作我不能直接执行。${decision.hits.map((hit) => hit.detail).join("；")}。可以在手机上完成人脸验证后办理。`,
          scene: intent.scene,
          decision,
          audit,
          intentSource,
        }),
        trace: makeTrace(steps, started),
      };
    }

    if (decision.requiresConfirm) {
      const preview = this.preview(intent.tool, intent.slots);
      const ticket = this.issuer.issue({
        sessionId,
        tool: intent.tool,
        slots: intent.slots,
        ttlSeconds: state.policy.confirmTtlSeconds,
        preview,
      });
      session.pending = {
        token: ticket.token,
        digest: ticket.digest,
        tool: intent.tool,
        slots: intent.slots,
        expiresAt: ticket.expiresAt,
        preview,
      };
      const audit = this.audit({
        sessionId,
        userText: raw,
        tool: intent.tool,
        params: intent.slots as Record<string, unknown>,
        decision: "pending_confirm",
        level: "yellow",
        rules: decision.hits.map((hit) => hit.rule),
        tokenDigest: ticket.digest,
        result: `等待确认：${preview}`,
      });
      record({ role: "executor", label: "执行官", input: intent.tool, output: "签发确认令牌，等待用户", level: "yellow", elapsedMs: 0, ok: true });
      record({ role: "auditor", label: "审计官", input: `seq ${audit.seq}`, output: "已留痕", level: "none", elapsedMs: 0, ok: true });
      return {
        ...this.reply({
          session,
          text: `准备执行：${preview}。需要你确认，${state.policy.confirmTtlSeconds} 秒内有效。`,
          scene: intent.scene,
          decision,
          audit,
          confirmation: ticket,
          intentSource,
        }),
        trace: makeTrace(steps, started),
      };
    }

    const execution = await this.run(intent.tool, intent.slots, this.store.load());
    const audit = this.audit({
      sessionId,
      userText: raw,
      tool: intent.tool,
      params: intent.slots as Record<string, unknown>,
      decision: execution.ok ? "swarm_execute" : "swarm_execute_failed",
      level: "green",
      rules: decision.hits.map((hit) => hit.rule),
      result: execution.ok ? execution.message : (execution.error ?? "执行失败"),
    });
    record({ role: "executor", label: "执行官", input: intent.tool, output: execution.message.slice(0, 60), level: "green", elapsedMs: 0, ok: execution.ok });
    record({ role: "auditor", label: "审计官", input: `seq ${audit.seq}`, output: "已留痕", level: "none", elapsedMs: 0, ok: true });

    return {
      ...this.reply({
        session,
        text: execution.ok ? execution.message : (execution.error ?? "执行失败"),
        scene: intent.scene,
        decision,
        audit,
        execution,
        intentSource,
      }),
      trace: makeTrace(steps, started),
    };
  }

  async confirm(sessionId: string, token: string, override?: IntentSlots): Promise<ChatReply> {
    const state = this.store.load();
    const session = this.session(sessionId);
    if (session.pending === undefined) {
      const decision = this.idleDecision("没有待确认的操作");
      const audit = this.audit({ sessionId, userText: "确认", tool: "unknown", params: {}, decision: "no_pending", level: "unknown", rules: ["no-pending"], result: "无待确认操作" });
      return this.reply({ session, text: "当前没有待确认的操作。", scene: "unknown", decision, audit });
    }
    if (token !== session.pending.token) {
      const decision = this.blockedDecision("令牌与待确认操作不匹配");
      const audit = this.audit({ sessionId, userText: "确认", tool: session.pending.tool, params: {}, decision: "blocked_token_invalid", level: "red", rules: ["confirm-token"], result: "令牌不匹配" });
      return this.reply({ session, text: "确认失败：令牌不匹配，操作没有执行。", scene: "transfer", decision, audit });
    }
    if (override !== undefined) {
      const current = digestOf(session.pending.tool, session.pending.slots);
      const supplied = digestOf(session.pending.tool, override);
      if (current !== supplied) {
        const audit = this.audit({
          sessionId,
          userText: "确认",
          tool: session.pending.tool,
          params: override as Record<string, unknown>,
          decision: "blocked_param_tamper",
          level: "red",
          rules: ["confirm-token", "param-digest"],
          tokenDigest: session.pending.digest,
          result: "参数与确认时不一致，拒绝执行",
        });
        return this.reply({
          session,
          text: "确认失败：提交的参数与确认时不一致，操作没有执行。",
          scene: "transfer",
          decision: this.blockedDecision("参数与确认时不一致", "param-digest"),
          audit,
        });
      }
    }
    session.turns.push({ role: "user", text: "确认", ts: new Date().toISOString() });
    return this.confirmInternal(session, "确认", state);
  }

  async cancel(sessionId: string): Promise<ChatReply> {
    const state = this.store.load();
    const session = this.session(sessionId);
    const pending = session.pending;
    session.pending = undefined;
    if (pending === undefined) {
      const decision = this.idleDecision("没有待确认的操作");
      const audit = this.audit({ sessionId, userText: "取消", tool: "unknown", params: {}, decision: "no_pending", level: "unknown", rules: ["no-pending"], result: "无待确认操作" });
      return this.reply({ session, text: "当前没有待确认的操作。", scene: "unknown", decision, audit });
    }
    const decision: PolicyDecision = {
      level: "yellow",
      shape: "cancelled",
      hits: [{ rule: "user-cancel", detail: "用户取消", delta: "none" }],
      summary: "用户取消，未执行",
      requiresConfirm: false,
      blocked: false,
    };
    const audit = this.audit({
      sessionId,
      userText: "取消",
      tool: pending.tool,
      params: pending.slots as Record<string, unknown>,
      decision: "cancelled_by_user",
      level: "yellow",
      rules: ["user-cancel"],
      tokenDigest: pending.digest,
      result: "用户取消，余额未变动",
    });
    this.store.save(state);
    return this.reply({ session, text: "已取消，没有执行任何操作，余额未变动。", scene: "transfer", decision, audit });
  }

  /** 会话快照：给前端渲染执行链路。 */
  context(sessionId: string): Record<string, unknown> {
    const session = this.session(sessionId);
    const state = this.store.load();
    return {
      sessionId,
      turns: session.turns,
      pending: session.pending ?? null,
      counters: session.counters,
      lastScene: session.lastScene ?? null,
      account: {
        holder: state.account.holder,
        balanceCents: state.account.balance,
        availableCents: state.account.available,
        cardTail: state.account.cardNo.slice(-4),
      },
      policy: state.policy,
    };
  }

  auditLog(sessionId?: string, limit = 50): Record<string, unknown> {
    // 先取全链再按会话过滤，避免 limit 窗口把较早会话的留痕丢掉；limit 只限制过滤后的条数
    const all = this.chain.read(Number.MAX_SAFE_INTEGER);
    const matched = sessionId === undefined ? all : all.filter((item) => item.sessionId === sessionId);
    const records = matched.slice(-limit);
    return { records, chain: this.chain.verify() };
  }

  reset(): Record<string, unknown> {
    const state = this.store.reset();
    this.sessions.clear();
    this.drafts.clear();
    return { ok: true, balanceCents: state.account.balance, bills: state.bills.length };
  }

  snapshot(): BankState {
    return this.store.load();
  }
}
