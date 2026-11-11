/**
 * 敏感路径（fileAccess.sensitivePaths）判断。对哪些会话生效见 tool-guard.ts 的 sensitivePathsApply。
 */
import { resolve } from 'node:path';
import type { ImQQBotConfig } from '../config.ts';
import { isWithin, isWithinReal } from './tool-guard.ts';

/** 判断绝对路径是否命中敏感路径（拦截名单） */
export function isSensitivePath(path: string, config: ImQQBotConfig): boolean {
  const abs = resolve(path);
  // 字面路径和真实位置任一命中就算：链接进敏感目录、或从敏感目录里链接出去的，都拦
  return (config.fileAccess?.sensitivePaths ?? []).some((root) => isWithin(abs, resolve(root)) || isWithinReal(abs, root));
}
