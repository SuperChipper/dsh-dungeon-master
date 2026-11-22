import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fakeHome = { dir: '' };
vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  return { ...actual, homedir: () => fakeHome.dir };
});

const { clearGroupMemoryCache, readAllGroupMessages } = await import('../features/group-memory.ts');
const { SelfSentIndex } = await import('../transport/self-sent.ts');
const { createGatewaySenders } = await import('./senders.ts');

describe('gateway/senders', () => {
  beforeEach(() => {
    clearGroupMemoryCache();
    fakeHome.dir = mkdtempSync(join(tmpdir(), 'gw-senders-'));
  });

  afterEach(() => {
    clearGroupMemoryCache();
  });

  function makeSetup() {
    const bot = {
      sendMarkdown: vi.fn(async () => ({ id: 'md-1', ext_info: { ref_idx: 'ref-md-1' } })),
      send: vi.fn(async () => ({ id: 'ev-1' })),
      openStream: vi.fn(async () => ({}) as never),
      sendImage: vi.fn(async () => ({ upload: { file_uuid: 'u-img' }, message: { id: 'img-1', ext_info: { ref_idx: 'ref-img-1' } } })),
      sendVideo: vi.fn(async () => ({ upload: { file_uuid: 'u-vid' }, message: { id: 'vid-1' } })),
      sendVoice: vi.fn(async () => ({ upload: { file_uuid: 'u-voc' }, message: { id: 'voc-1', ext_info: { ref_idx: 'ref-voc-1' } } })),
      sendFile: vi.fn(async () => ({ upload: { file_uuid: 'u-fil' }, message: { id: 'fil-1' } })),
    };
    const selfSent = new SelfSentIndex();
    const recordSpy = vi.spyOn(selfSent, 'record');
    const senders = createGatewaySenders({
      bot: bot as never,
      config: { appId: 'app-test', replyDesire: { names: ['小鱼'] } as never },
      manager: {
        personaStore: {
          current: () => ({ name: '大肥鱼', names: ['肥鱼'] }),
        },
      },
      selfSent,
    });
    return { bot, selfSent, recordSpy, senders };
  }

  it('sendMarkdown 为群消息写入机器人归档（含当前人设名），跳过私聊', async () => {
    const { senders } = makeSetup();

    await senders.sender.sendMarkdown({ scope: 'group', targetId: 'G1', msgId: 'in-1' }, '群里回复');
    await senders.sender.sendMarkdown({ scope: 'c2c', targetId: 'U1', msgId: 'in-2' }, '私聊回复');

    const archived = readAllGroupMessages('app-test', 'G1');
    expect(archived).toHaveLength(1);
    expect(archived[0]).toMatchObject({
      messageId: 'md-1',
      senderName: '大肥鱼',
      role: 'assistant',
      content: '群里回复',
    });
    expect(readAllGroupMessages('app-test', 'U1')).toEqual([]);
    senders.dispose();
  });

  it('mediaSender 记录 selfSent ref_idx 并归档群媒体；rawSendVoice + onSent 不重复归档', async () => {
    const { senders, recordSpy } = makeSetup();

    await senders.mediaSender.sendImage({ scope: 'group', targetId: 'G2' }, { localPath: 'a.png' }, { content: '看图' });
    expect(recordSpy).toHaveBeenCalledWith('ref-img-1', '[图片] 看图');

    // speak-tool 复用 rawSendVoice + onSent: rememberMedia(target, '语音', spoken)(result)
    const voiceRes = await senders.rawSendVoice({ scope: 'group', targetId: 'G2' }, { localPath: 'v.silk' });
    senders.rememberMedia({ scope: 'group', targetId: 'G2' }, '语音', '早安')(voiceRes);
    expect(recordSpy).toHaveBeenCalledWith('ref-voc-1', '[语音] 早安');

    const archived = readAllGroupMessages('app-test', 'G2');
    expect(archived.map((e) => [e.messageId, e.content])).toEqual([
      ['img-1', '[图片] 看图'],
      ['voc-1', '[语音] 早安'],
    ]);
    senders.dispose();
  });
});
