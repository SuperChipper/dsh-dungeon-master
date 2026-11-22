/**
 * 统一的原子文件写入底座
 *
 * 约定：所有结构化状态/配置/账本写入统一走「同目录唯一临时文件 + renameSync」，
 * 避免崩溃或半写导致 JSON/YAML 损坏；Windows 遇目标临时被占用（EPERM/EACCES/EXDEV）时
 * 可按选项降级覆盖，并在 finally 中清理临时文件。
 */
import { randomUUID } from 'node:crypto';
import { mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export interface WriteAtomicOptions {
  /** 文件权限位（POSIX，例如凭据/审计文件传 0o600） */
  mode?: number;
  /** 文本编码（默认 utf8） */
  encoding?: BufferEncoding;
  /** 以 wx 独占创建临时文件；rename 失败时不降级覆盖，直接抛出 */
  exclusive?: boolean;
}

export interface WriteJsonAtomicOptions extends WriteAtomicOptions {
  /** JSON.stringify 缩进空格数；省略时输出紧凑单行 JSON */
  indent?: number;
  /** 是否在末尾追加换行符 */
  trailingNewline?: boolean;
}

const RENAME_FALLBACK_CODES = new Set(['EPERM', 'EACCES', 'EXDEV']);

/** 原子写入文本文件 */
export function writeTextAtomic(filePath: string, content: string, options: WriteAtomicOptions = {}): void {
  const encoding = options.encoding ?? 'utf8';
  const mode = options.mode;
  const exclusive = options.exclusive === true;
  mkdirSync(dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(tmpPath, content, {
      encoding,
      ...(mode !== undefined ? { mode } : {}),
      ...(exclusive ? { flag: 'wx' } : {}),
    });
    try {
      renameSync(tmpPath, filePath);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException | undefined)?.code;
      if (!exclusive && code !== undefined && RENAME_FALLBACK_CODES.has(code)) {
        writeFileSync(filePath, content, {
          encoding,
          ...(mode !== undefined ? { mode } : {}),
        });
        return;
      }
      throw err;
    }
  } finally {
    try {
      rmSync(tmpPath, { force: true });
    } catch {
      /* 清理临时文件失败不覆盖主流程状态 */
    }
  }
}

/** 原子写入 JSON 文件 */
export function writeJsonAtomic(filePath: string, value: unknown, options: WriteJsonAtomicOptions = {}): void {
  const { indent, trailingNewline, ...writeOpts } = options;
  const serialized = JSON.stringify(value, null, indent);
  const text = trailingNewline === true ? `${serialized}\n` : serialized;
  writeTextAtomic(filePath, text, writeOpts);
}
