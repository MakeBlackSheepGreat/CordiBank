/**
 * RPC 客户端：对接运行时控制面。
 * 协议为同源 POST /rpc，请求 { method, params }，响应 { ok, result | error }。
 * 生产环境由 runtime 单进程托管前端，开发环境由 vite 代理 /rpc。
 */
import type { RpcReply } from './types'

export const DEFAULT_RPC_URL = '/rpc'

/** 单次调用默认超时（毫秒）。 */
export const DEFAULT_CALL_TIMEOUT_MS = 30_000

/** 健康探测超时（毫秒）：离线判定要快。 */
export const PING_TIMEOUT_MS = 5_000

export class RpcClient {
  url: string
  online = false

  constructor(url: string = DEFAULT_RPC_URL) {
    this.url = url
  }

  async call(
    method: string,
    params: unknown = {},
    opts: { timeoutMs?: number } = {},
  ): Promise<RpcReply> {
    const timeoutMs = opts.timeoutMs ?? DEFAULT_CALL_TIMEOUT_MS
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const res = await fetch(this.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ method, params }),
        signal: controller.signal,
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data = (await res.json()) as RpcReply
      this.online = true
      return data
    } catch (err) {
      this.online = false
      return {
        ok: false,
        error: controller.signal.aborted ? `请求超时（${timeoutMs}ms）：${method}` : String(err),
      }
    } finally {
      clearTimeout(timer)
    }
  }

  async ping(): Promise<boolean> {
    const reply = await this.call('runtime.status', {}, { timeoutMs: PING_TIMEOUT_MS })
    return reply.ok
  }
}

export const rpc = new RpcClient()
