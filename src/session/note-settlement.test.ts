import { describe, expect, it, vi } from 'vitest';
import * as groupMemory from '../features/group-memory.ts';
import { getEngagementTracker } from '../features/reply-desire.ts';
import { SessionManager } from './session-manager.ts';
import type { SessionRecord } from './types.ts';

function makeManagerStub(enqueue: ReturnType<typeof vi.fn>, recordJudgement = vi.fn(() => [] as string[])) {
  const pendingNoteInjections = new Map();
  const recordInjection = vi.fn();
  const stub = {
    config: {
      appId: 'app-note-settle',
      provider: 'opencode-go',
      model: 'deepseek-v4.1-flash',
      notes: {
        autoInject: true,
        injectTopK: 2,
        injectMaxChars: 600,
        injectMinCoverage: 0.4,
        judge: { enabled: true, sampleRate: 1, minSamples: 8, muteBelow: 0, timeoutMs: 15000 },
      },
      replyDesire: {
        judge: { provider: 'opencode-go', model: 'deepseek-v4.1-flash', reasoningEffort: 'low', contextMessages: 6 },
      },
    },
    notesStore: {
      searchHybrid: vi.fn(async () => [{
        file: '海报存档.md',
        heading: '九张海报的稳定存档路径',
        text: '深渊巨口第三版保存在 posters/abyss-v3.png',
        score: 0.9,
        coverage: 0.8,
        matched: 3,
      }]),
    },
    noteMuted: () => false,
    pendingNoteInjections,
    noteMetrics: { recordInjection, recordJudgement },
    noteJudge: { enqueue },
    sessionKey: (scope: string, peerId: string) => `qqbot:app-note-settle:${scope}:${peerId}`,
    getEffectiveModel: () => undefined,
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  };
  return { stub, recordInjection, recordJudgement };
}

describe('SessionManager 笔记注入与完成回复后结算打分', () => {
  it('群聊复用群记忆 + bot 发言上下文，并在回复完成后连同实际回复与工具名送入 NoteJudge', async () => {
    const spy = vi.spyOn(groupMemory, 'readRecentGroupMessages').mockReturnValue([
      { messageId: 'm1', senderId: 'u1', senderName: '阿明', content: '深渊巨口海报改好没', timestamp: 1000 },
      { messageId: 'm2', senderId: 'u2', senderName: '小红', content: '发出来看看', timestamp: 2000 },
    ]);
    getEngagementTracker().noteBotSaid('g-settle', '第三版刚存好', 1500);

    const enqueue = vi.fn(async () => [1]);
    const { stub, recordInjection, recordJudgement } = makeManagerStub(enqueue);
    try {
      const hint = await SessionManager.prototype.notesHint.call(stub, '发出来看看', 'group', 'g-settle', 'm2');
      expect(hint).toContain('海报存档.md');

      const record = {
        sessionKey: 'qqbot:app-note-settle:group:g-settle',
        scope: 'group',
        peerId: 'g-settle',
        agent: {},
      } as unknown as SessionRecord;
      SessionManager.prototype.settleNoteInjection.call(stub, record, true, {
        reply: '[配文] 第三版深渊巨口海报给你们端上来了',
        toolsUsed: ['qqbot_send_file'],
      });
      await Promise.resolve();

      expect(recordInjection).toHaveBeenCalledTimes(1);
      expect(enqueue).toHaveBeenCalledWith(expect.objectContaining({
        provider: 'opencode-go',
        model: 'deepseek-v4.1-flash',
        reasoningEffort: 'low',
        query: '发出来看看',
        contextLines: [
          { sender: '阿明', text: '深渊巨口海报改好没', timestamp: 1000 },
          { text: '第三版刚存好', timestamp: 1500 },
        ],
        reply: '[配文] 第三版深渊巨口海报给你们端上来了',
        toolsUsed: ['qqbot_send_file'],
      }));
      expect(recordJudgement).toHaveBeenCalledWith(expect.any(Array), [1], { minSamples: 8, muteBelow: 0 });
    } finally {
      spy.mockRestore();
    }
  });

  it('私聊没有群记忆时，从会话历史抽取本轮之前的对话作为打分背景', async () => {
    const enqueue = vi.fn(async () => [0.5]);
    const { stub } = makeManagerStub(enqueue);
    await SessionManager.prototype.notesHint.call(stub, '第三张路径发我', 'c2c', 'u-owner');

    const record = {
      sessionKey: 'qqbot:app-note-settle:c2c:u-owner',
      scope: 'c2c',
      peerId: 'u-owner',
      agent: {
        session: {
          events: [
            { type: 'user/message', content: [{ type: 'text', text: '九张海报都归档了吗' }], source: { kind: 'user' } },
            { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '都写进海报存档笔记了' }] } } },
            { type: 'user/message', content: [{ type: 'text', text: '[共享笔记 · 可能相关]\n- 海报存档.md\n（来自笔记库，仅供参考；不带 [本会话] 的是所有群共享的笔记，不是这个群发生过的事。和当前话题无关就忽略；要看更多用 qqbot_notes_search。）\n第三张路径发我' }], source: { kind: 'user' } },
            { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'posters/abyss-v3.png' }] } } },
          ],
        },
      },
    } as unknown as SessionRecord;

    SessionManager.prototype.settleNoteInjection.call(stub, record, true, { reply: 'posters/abyss-v3.png' });
    await Promise.resolve();

    expect(enqueue).toHaveBeenCalledWith(expect.objectContaining({
      query: '第三张路径发我',
      contextLines: [
        { sender: '对方', text: '九张海报都归档了吗', timestamp: 0 },
        { text: '都写进海报存档笔记了', timestamp: 0 },
      ],
      reply: 'posters/abyss-v3.png',
    }));
  });
});
