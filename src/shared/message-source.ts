import { createUserMessage } from '@deepseek-ai/dsh-llm';

// 新宿主的 v4 持久化禁止通用 plugin 包装；生产者必须拥有自己的 kind。
declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'im-qqbot': { kind: 'im-qqbot' };
    'qqbot-persona-handoff': { kind: 'qqbot-persona-handoff'; form: 'recall' };
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
