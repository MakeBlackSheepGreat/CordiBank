import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";

let tempSequence = 0;

/** 读取 JSON 文件；文件不存在或损坏时返回调用方提供的默认值。 */
export function readJsonFile<T>(file: string, fallback: T): T {
  try {
    return JSON.parse(readFileSync(file, "utf8")) as T;
  } catch {
    return fallback;
  }
}

/** 原子写入 JSON 文件；目录创建和 Windows 替换回退统一在此处理。 */
export function writeJsonAtomic(file: string, value: unknown): void {
  writeTextAtomic(file, JSON.stringify(value, null, 2));
}

/** 原子写入文本文件；报告 Markdown 与 JSON 共用同一替换语义。 */
export function writeTextAtomic(file: string, text: string): void {
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${++tempSequence}.tmp`;
  writeFileSync(tmp, text, "utf8");
  try {
    renameSync(tmp, file);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (!(code && ["EBADF", "EEXIST", "ENOTEMPTY", "EPERM"].includes(code))) {
      throw err;
    }
    try {
      copyFileSync(tmp, file);
    } finally {
      if (existsSync(tmp)) unlinkSync(tmp);
    }
  }
}
