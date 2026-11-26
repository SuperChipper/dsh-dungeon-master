import { existsSync, readFileSync } from 'node:fs';
import { writeJsonAtomic } from '../shared/atomic-fs.ts';

interface LatchEntry {
  epoch: string;
  text: string;
}

/**
 * 把会变的 system prompt 文字「锁」在一段对话内。
 *
 * system prompt 排在整段历史前面，改一个字后面就全部失去缓存（实测一次 10 万 token 重算）。
 * 表情目录、上次进度这类内容不必实时：锁住旧文字，变化另走对话末尾的快照，等压缩、换会话这些
 * 前缀本来就要重算的时机（epoch 变了）再换成最新的。
 * 传入 `filePath` 时将锁状态原子落盘，插件重载或宿主重启后继续复用同一 epoch 的旧前缀，避免重载击穿缓存。
 */
export class PromptLatch {
  private readonly held = new Map<string, LatchEntry>();
  private readonly filePath: string | undefined;

  public constructor(filePath?: string) {
    this.filePath = filePath;
    if (filePath !== undefined) this.load(filePath);
  }

  private load(filePath: string): void {
    if (!existsSync(filePath)) return;
    try {
      const parsed = JSON.parse(readFileSync(filePath, 'utf8')) as unknown;
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return;
      for (const [key, raw] of Object.entries(parsed as Record<string, unknown>)) {
        if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) continue;
        const entry = raw as Partial<LatchEntry>;
        if (typeof entry.epoch === 'string' && typeof entry.text === 'string') {
          this.held.set(key, { epoch: entry.epoch, text: entry.text });
        }
      }
    } catch {
      // 持久化文件损坏或不可读时降级为内存态，不阻塞 system prompt 组装
    }
  }

  private save(): void {
    if (this.filePath === undefined) return;
    try {
      writeJsonAtomic(this.filePath, Object.fromEntries(this.held));
    } catch {
      // 写入失败不阻断对话，内存中的锁继续生效
    }
  }

  /** 同一 epoch 内返回第一次看到的文字；epoch 变了换成 current */
  public hold(key: string, epoch: string, current: string): string {
    const entry = this.held.get(key);
    if (entry !== undefined && entry.epoch === epoch) return entry.text;
    this.held.set(key, { epoch, text: current });
    this.save();
    return current;
  }

  /** 当前锁住的文字；还没锁过返回 undefined */
  public peek(key: string): string | undefined {
    return this.held.get(key)?.text;
  }

  public forget(key: string): void {
    if (this.held.delete(key)) this.save();
  }
}
