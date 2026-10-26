/** 路径包含校验：解析后的目标必须落在基目录内，阻断相对段（..）与绝对路径逃逸。 */

import path from "node:path";

/**
 * 在基目录内解析路径片段，越出基目录时抛错。
 * @param base - 基目录（允许相对路径，按 cwd 归一）。
 * @param segments - 相对基目录的路径片段；含绝对路径或 .. 逃逸时拒绝。
 * @returns 归一后的绝对路径。
 */
export function resolveWithin(base: string, ...segments: string[]): string {
  const resolvedBase = path.resolve(base);
  const resolved = path.resolve(resolvedBase, ...segments);
  const rel = path.relative(resolvedBase, resolved);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error(`路径越出基目录：${resolved} 不在 ${resolvedBase} 内`);
  }
  return resolved;
}
