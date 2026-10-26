import type { BankState, GuardVerdict, UntrustedContent } from "./types.ts";

const ZERO_WIDTH = /[\u200b-\u200f\u202a-\u202e\ufeff]/g;

/** 归一化：全角转半角、去零宽字符、压缩空白。同形字绕过在第一层被拆掉。 */
export function normalize(text: string): string {
  const halfWidth = text.replace(/[\uff01-\uff5e]/g, (char) => String.fromCharCode(char.charCodeAt(0) - 0xfee0));
  return halfWidth
    .replace(ZERO_WIDTH, "")
    .replace(/\u3000/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

interface Rule {
  kind: GuardVerdict["kind"];
  pattern: RegExp;
  label: string;
}

/** 直接注入的四类特征：指令覆盖、角色扮演、编码混淆、提示词套取。 */
const RULES: ReadonlyArray<Rule> = [
  { kind: "override", pattern: /(忽略|无视|忘记|跳过|不要理会).{0,6}(之前|以上|上述|前面|上面|所有|全部).{0,4}(指令|规则|限制|要求|提示)/, label: "指令覆盖" },
  { kind: "override", pattern: /(ignore|disregard|forget).{0,20}(previous|above|prior|all).{0,15}(instruction|rule|prompt)/i, label: "指令覆盖" },
  { kind: "override", pattern: /(从现在开始|接下来|之后).{0,8}(你|系统).{0,6}(必须|只能|要)/, label: "指令覆盖" },
  { kind: "roleplay", pattern: /(假装|扮演|假设).{0,6}(你|自己).{0,4}(是|为)/, label: "角色扮演" },
  { kind: "roleplay", pattern: /(我是|作为).{0,4}(开发者|管理员|行长|内部人员|风控负责人|测试人员)/, label: "身份冒用" },
  { kind: "roleplay", pattern: /(开发者模式|调试模式|debug\s*mode|admin\s*mode|越狱)/i, label: "模式切换" },
  { kind: "exfiltration", pattern: /(系统提示|系统指令|提示词|prompt).{0,6}(是什么|告诉我|输出|打印|列出来)/, label: "提示词套取" },
  { kind: "exfiltration", pattern: /(重复|复述|输出).{0,6}(上面|以上|之前).{0,4}(内容|文字|指令)/, label: "提示词套取" },
  { kind: "encoded", pattern: /[\u0400-\u04ff]/, label: "同形字混淆" },
  { kind: "encoded", pattern: /(\\u[0-9a-f]{4}){3,}/i, label: "转义编码" },
  { kind: "encoded", pattern: /(base64|rot13|十六进制).{0,6}(解码|执行|转换)/i, label: "编码指令" },
];

/** 输入侧守卫：识别攻击语义并返回归一化文本。 */
export function guardInput(raw: string): GuardVerdict {
  const sanitized = normalize(raw);
  for (const rule of RULES) {
    const matched = sanitized.match(rule.pattern);
    if (matched !== null) {
      return { attack: true, kind: rule.kind, matched: `${rule.label}：${matched[0]}`, sanitized };
    }
  }
  return { attack: false, kind: "none", matched: "", sanitized };
}

/** 内容侧规则：外部分录里的付款要求与套取动作。 */
const CONTENT_RULES: ReadonlyArray<RegExp> = [
  /(忽略|无视|忘记).{0,8}(指令|规则|限制)/,
  /(转账|汇款|打款|付款|支付).{0,12}(\d{4,}|元|块)/,
  /(卡号|账号|收款账户).{0,12}\d{6,}/,
  /(点击|访问|打开).{0,6}(链接|网址|http)/i,
  /(提供|输入|告诉我).{0,6}(验证码|密码|短信码|动态码)/,
  /(系统|管理员|风控).{0,6}(要求|通知|指令)/,
];

/** 把工具输出标记为不可信数据；命中任一规则即视为可疑。 */
export function scanUntrusted(source: string, text: string): UntrustedContent {
  const normalized = normalize(text);
  for (const rule of CONTENT_RULES) {
    const matched = normalized.match(rule);
    if (matched !== null) {
      return { source, text: normalized, suspicious: true, matched: matched[0] };
    }
  }
  return { source, text: normalized, suspicious: false, matched: "" };
}

export interface OriginVerdict {
  trusted: boolean;
  reason: string;
}

/**
 * 参数来源校验：收款人必须来自用户原话或通讯录，不能仅由外部内容带出。
 * 这一层挡住「账单备注里写着收款人，模型照抄」的间接注入。
 */
export function checkPayeeOrigin(payee: string, userText: string, state: BankState): OriginVerdict {
  const normalizedUser = normalize(userText);
  const contact = state.contacts.find((item) => item.name === payee || item.remark === payee);
  if (contact !== undefined) {
    const mentioned = normalizedUser.includes(payee) || (contact.remark !== "" && normalizedUser.includes(contact.remark));
    if (!mentioned) {
      return { trusted: false, reason: `收款人 ${payee} 未在本次对话中出现` };
    }
    return { trusted: true, reason: `收款人 ${payee} 来自通讯录且用户明确提及` };
  }
  if (normalizedUser.includes(payee)) {
    return { trusted: true, reason: `收款人 ${payee} 由用户直接给出` };
  }
  return { trusted: false, reason: `收款人 ${payee} 无法追溯到用户输入` };
}

/** 回复侧守卫：拒绝把内部字段名暴露给用户。 */
const INTERNAL_TOKENS: ReadonlyArray<RegExp> = [/\[object Object\]/g, /undefined/g, /NaN/g, /\bnull\b/g];

/** 清理回复文本中的内部字符串，回答只保留人类可读内容。 */
export function guardOutput(text: string): string {
  let output = text;
  for (const pattern of INTERNAL_TOKENS) {
    output = output.replace(pattern, "");
  }
  return output.replace(/\s{2,}/g, " ").trim();
}
