import { describe, expect, it, vi } from 'vitest';
import type { ChatScope } from '../types.ts';
import { SessionManager } from './session-manager.ts';

type Prompt = { sections: Array<{ name: string; text: string }> };
type Assemble = (assembly: unknown, context: { agent: unknown }, next: () => Promise<Prompt>) => Promise<Prompt>;

describe('人设提示词注入', () => {
  it.each(['group', 'c2c'] as const)('%s 每轮读取当前人设，切回默认或文件删除时使用对应默认提示词', async (scope) => {
    const agent = { session: { id: 's1' } };
    const current = vi.fn((_peer: string, _scope: ChatScope): { prompt: string } | undefined => ({ prompt: '女仆正文' }));
    let assemble!: Assemble;
    const manager = {
      ctx: { on: (_event: string, callback: Assemble) => { assemble = callback; } },
      config: { groupPrompt: '群聊默认', directPrompt: '私聊默认' },
      personaStore: { current },
      findByAgent: (value: unknown) => value === agent ? { scope, peerId: 'peer', agent } : undefined,
    };
    (SessionManager.prototype as unknown as { registerScopePromptInjection(): void }).registerScopePromptInjection.call(manager);
    const next = async (): Promise<Prompt> => ({ sections: [{ name: 'host', text: '宿主提示词' }] });
    const first = await assemble(undefined, { agent }, next);
    expect(current).toHaveBeenLastCalledWith('peer', scope);
    expect(first.sections).toContainEqual({ name: 'qqbot:scope-prompt', order: 90, text: '女仆正文' });
    expect(first.sections).toContainEqual({ name: 'host', text: '宿主提示词' });
    if (scope === 'c2c') expect(first.sections.some((s) => s.name === 'qqbot:group-focus')).toBe(false);

    current.mockReturnValue({ prompt: '修改后的正文' });
    expect((await assemble(undefined, { agent }, next)).sections)
      .toContainEqual({ name: 'qqbot:scope-prompt', order: 90, text: '修改后的正文' });
    current.mockReturnValue(undefined);
    expect((await assemble(undefined, { agent }, next)).sections)
      .toContainEqual({ name: 'qqbot:scope-prompt', order: 90, text: scope === 'group' ? '群聊默认' : '私聊默认' });
  });
});
