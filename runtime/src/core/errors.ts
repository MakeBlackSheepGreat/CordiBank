/** 运行时错误码：RPC 层把它写进响应的 code 字段。 */
export type RuntimeErrorCode =
  | "INVALID_INPUT"
  | "VERSION_CONFLICT"
  | "APPROVAL_REQUIRED"
  | "RESOURCE_UNAVAILABLE"
  | "NOT_FOUND"
  | "ACCESS_DENIED";

/** 带错误码的运行时错误。 */
export class RuntimeError extends Error {
  readonly code: RuntimeErrorCode;

  constructor(code: RuntimeErrorCode, message: string) {
    super(message);
    this.name = "RuntimeError";
    this.code = code;
  }
}
