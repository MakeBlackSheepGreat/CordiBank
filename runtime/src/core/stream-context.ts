import { AsyncLocalStorage } from "node:async_hooks";
import type { StreamDelta } from "../llm/types.ts";

/**
 * 流式上下文。
 *
 * 模型增量要跨 registry.call 的层层转发才能到达 HTTP 响应，逐参数透传会污染 RPC 契约。
 * 这里用 AsyncLocalStorage 把回调挂在请求上下文上，能力插件按需取用，
 * 并发请求之间互不干扰。
 */
const storage = new AsyncLocalStorage<((delta: StreamDelta) => void) | undefined>();

/** 在流式上下文里执行：期间 emitDelta 推给该请求的接收方。 */
export function withStreamSink<T>(sink: (delta: StreamDelta) => void, run: () => Promise<T>): Promise<T> {
  return storage.run(sink, run);
}

/** 推送增量；非流式上下文下静默忽略，调用方无需分情况处理。 */
export function emitDelta(delta: StreamDelta): void {
  storage.getStore()?.(delta);
}

/** 当前是否处于流式上下文；用于决定是否改走流式请求。 */
export function hasStreamSink(): boolean {
  return storage.getStore() !== undefined;
}
