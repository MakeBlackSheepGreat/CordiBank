/** RPC 响应信封：ok 为 false 时 error 携带可读原因。 */
export interface RpcReply {
  ok: boolean;
  result?: unknown;
  error?: string;
  code?: string;
}
