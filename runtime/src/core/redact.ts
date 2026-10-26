/** 密钥脱敏：把服务端凭据、令牌与签名从日志与错误信息里抹掉。 */

const SECRET_PATTERNS: ReadonlyArray<[RegExp, string]> = [
  [/\bsk-[A-Za-z0-9_-]{8,}/g, "sk-***"],
  [/\b(Bearer)\s+[A-Za-z0-9._-]{8,}/gi, "$1 ***"],
  [/\b(api[_-]?key|token|secret|password)\s*[=:]\s*[A-Za-z0-9._-]{6,}/gi, "$1=***"],
  [/\bgh[pousr]_[A-Za-z0-9]{20,}/g, "gh*_***"],
];

/** 文本脱敏：按常见凭据形状替换。 */
export function redactText(text: string): string {
  let output = text;
  for (const [pattern, replacement] of SECRET_PATTERNS) {
    output = output.replace(pattern, replacement);
  }
  return output;
}

const SECRET_KEYS = /(api[_-]?key|token|secret|password|authorization|credential|cookie)/i;

/** 值脱敏：递归处理对象与数组，敏感键的值直接替换。 */
export function redactValue(value: unknown, depth = 0): unknown {
  if (depth > 6) return "[deep]";
  if (typeof value === "string") return redactText(value);
  if (Array.isArray(value)) return value.map((item) => redactValue(item, depth + 1));
  if (value !== null && typeof value === "object") {
    const output: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      output[key] = SECRET_KEYS.test(key) ? "***" : redactValue(item, depth + 1);
    }
    return output;
  }
  return value;
}

/** 错误脱敏：保留错误类型与脱敏后的信息，重新抛给调用方。 */
export function redactError(error: unknown): Error {
  if (error instanceof Error) {
    const masked = new Error(redactText(error.message));
    masked.name = error.name;
    masked.stack = error.stack === undefined ? undefined : redactText(error.stack);
    return masked;
  }
  return new Error(redactText(String(error)));
}
