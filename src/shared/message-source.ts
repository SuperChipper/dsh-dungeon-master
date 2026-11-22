import { boundContextSummary, createUserMessage } from '@deepseek-ai/dsh-llm';

// 新宿主的 v4 持久化禁止通用 plugin 包装；生产者必须拥有自己的 kind。
declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'im-qqbot': { kind: 'im-qqbot' };
    'qqbot-persona-handoff': { kind: 'qqbot-persona-handoff'; form: 'recall' };
    'qqbot-notes-recall': { kind: 'qqbot-notes-recall'; form: 'notice'; summary: string };
  }
}

export const QQBOT_MESSAGE_SOURCE = { kind: 'im-qqbot' } as const;

export function createPersonaHandoffMessage(text: string) {
  return createUserMessage({
    content: [{ type: 'text', text }],
    source: { kind: 'qqbot-persona-handoff', form: 'recall' },
  });
}

export function isPersonaHandoffSource(source: unknown): boolean {
  const value = source as { kind?: string; plugin?: string } | undefined;
  return value?.kind === 'qqbot-persona-handoff'
    || (value?.kind === 'plugin' && value.plugin === 'qqbot-persona-handoff');
}

/** 从渲染后的共享笔记提示文本提炼单行摘要，供 notice 源与折叠展示使用 */
export function summarizeNotesHint(text: string): string {
  const files: string[] = [];
  const seen = new Set<string>();
  let count = 0;
  for (const match of text.matchAll(/^- (?:\[本会话\]\s*)?([^\s›][^›\n]*?)\s*›/gm)) {
    count += 1;
    const file = match[1]?.trim();
    if (file && !seen.has(file)) {
      seen.add(file);
      files.push(file);
    }
  }
  const summary = count > 0
    ? `共享笔记（${count} 条）：${files.join('、')}`
    : '共享笔记自动召回';
  return boundContextSummary(summary);
}

/** 创建独立于 user 消息正文之外的共享笔记召回上下文消息 */
export function createNotesRecallMessage(text: string, summary?: string) {
  return createUserMessage({
    content: [{ type: 'text', text }],
    source: {
      kind: 'qqbot-notes-recall',
      form: 'notice',
      summary: boundContextSummary(summary ?? summarizeNotesHint(text)),
    },
  });
}

export function isNotesRecallSource(source: unknown): boolean {
  const value = source as { kind?: string } | undefined;
  return value?.kind === 'qqbot-notes-recall';
}
