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

/** 流式调用超时（毫秒）：模型多轮取数可能较久。 */
export const DEFAULT_STREAM_TIMEOUT_MS = 120_000

/** 流式增量：正文与推理两路分开。 */
export interface StreamDelta {
  content: string
  reasoning: string
}

/** 流式回调集合。 */
export interface StreamHandlers {
  /** 每收到一片增量调用一次。 */
  onDelta?: (delta: StreamDelta) => void
}

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

  /**
   * 流式调用：读取服务端推送的 SSE 事件。
   *
   * 增量通过 onDelta 实时交给调用方，返回值为结束事件里的完整结果。
   * 服务端未推送增量时（规则类回复由服务端分片补充）同样走这条路径，
   * 调用方只维护一套渲染逻辑。
   */
  async stream(
    method: string,
    params: unknown = {},
    handlers: StreamHandlers = {},
    opts: { timeoutMs?: number } = {},
  ): Promise<RpcReply> {
    const timeoutMs = opts.timeoutMs ?? DEFAULT_STREAM_TIMEOUT_MS
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const res = await fetch(`${this.url}/stream`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ method, params }),
        signal: controller.signal,
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      if (res.body === null) throw new Error('流式响应没有正文')

      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      let outcome: RpcReply | null = null

      for (;;) {
        const chunk = await reader.read()
        if (chunk.done) break
        buffer += decoder.decode(chunk.value, { stream: true })

        let boundary = buffer.indexOf('\n\n')
        while (boundary >= 0) {
          const frame = buffer.slice(0, boundary)
          buffer = buffer.slice(boundary + 2)
          const event = parseFrame(frame)
          if (event.name === 'delta') {
            handlers.onDelta?.(event.payload as StreamDelta)
          } else if (event.name === 'done') {
            const payload = event.payload as { ok: boolean; result?: unknown; error?: string }
            outcome = { ok: true, result: payload.result } as RpcReply
          } else if (event.name === 'failed') {
            const payload = event.payload as { ok: boolean; error?: string }
            outcome = { ok: false, error: payload.error ?? '流式调用失败' }
          }
          boundary = buffer.indexOf('\n\n')
        }
      }

      this.online = true
      return outcome ?? { ok: false, error: '流式响应未给出结束事件' }
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
}

/** 解析单个 SSE 帧：取事件名与 data 负载。 */
function parseFrame(frame: string): { name: string; payload: unknown } {
  let name = 'message'
  let data = ''
  for (const line of frame.split('\n')) {
    if (line.startsWith('event:')) {
      name = line.slice(6).trim()
    } else if (line.startsWith('data:')) {
      data += line.slice(5).trim()
    }
  }
  if (data === '') return { name, payload: null }
  return { name, payload: JSON.parse(data) as unknown }
}

export const rpc = new RpcClient()
