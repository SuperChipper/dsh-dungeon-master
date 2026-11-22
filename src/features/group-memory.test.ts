import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, vi, beforeEach } from 'vitest';

// 群记忆写在 ~/.dsh 下：把 homedir 指到临时目录，测试不碰真实数据
const fakeHome = { dir: '' };
vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  return { ...actual, homedir: () => fakeHome.dir };
});

const {
  appendGroupMessage,
  appendBotGroupMessage,
  clearGroupMemoryCache,
  extractSentMessageId,
  isBotMemoryEntry,
  readAllGroupMessages,
  readGroupMessagesAfter,
  readRecentGroupMessages,
  readHistoryCursor,
  writeHistoryCursor,
  resolveBotSenderName,
} = await import('./group-memory.ts');

function seed(n: number): void {
  for (let i = 1; i <= n; i++) {
    appendGroupMessage('app', 'g1', { messageId: `m${i}`, senderId: 'u', content: `msg ${i}`, timestamp: i });
  }
}

describe('group memory history cursor', () => {
  beforeEach(() => {
    clearGroupMemoryCache();
    fakeHome.dir = mkdtempSync(join(tmpdir(), 'gm-home-'));
  });

  it('readRecentGroupMessages 保持原行为：最近 N 条、排除当前', () => {
    seed(6);
    expect(readRecentGroupMessages('app', 'g1', 3, 'm6').map((e) => e.messageId)).toEqual(['m3', 'm4', 'm5']);
  });

  it('只返回游标之后的新消息', () => {
    seed(6);
    expect(readGroupMessagesAfter('app', 'g1', 10, 'm3', 'm6').map((e) => e.messageId)).toEqual(['m4', 'm5']);
  });

  it('游标之后没有新消息时返回空', () => {
    seed(3);
    expect(readGroupMessagesAfter('app', 'g1', 10, 'm2', 'm3')).toEqual([]);
  });

  it('新消息超过 limit 时只取最近 limit 条', () => {
    seed(8);
    expect(readGroupMessagesAfter('app', 'g1', 2, 'm1', 'm8').map((e) => e.messageId)).toEqual(['m6', 'm7']);
  });

  it('游标找不到（被清理过）时退回最近 N 条', () => {
    seed(5);
    expect(readGroupMessagesAfter('app', 'g1', 2, 'gone', 'm5').map((e) => e.messageId)).toEqual(['m3', 'm4']);
  });

  it('游标读写往返；没有/损坏时返回 undefined', () => {
    expect(readHistoryCursor('app', 'g1')).toBeUndefined();
    writeHistoryCursor('app', 'g1', { sessionId: 's1', messageId: 'm9' });
    expect(readHistoryCursor('app', 'g1')).toEqual({ sessionId: 's1', messageId: 'm9' });
    expect(readHistoryCursor('app', 'other')).toBeUndefined();
  });

  it('appendBotGroupMessage 写入 bot 归档记录，提取消息 ID 且跳过空白正文', () => {
    expect(appendBotGroupMessage('app', 'g1', { content: '   \n  ' })).toBeUndefined();
    expect(readAllGroupMessages('app', 'g1')).toEqual([]);

    const e1 = appendBotGroupMessage('app', 'g1', {
      content: '第一句',
      senderName: '大肥鱼',
      result: { id: 'qq-msg-1', ext_info: { ref_idx: 'ref-1' } },
      timestamp: 100,
    });
    const e2 = appendBotGroupMessage('app', 'g1', {
      content: '[图片] 配图',
      senderName: '大肥鱼',
      result: { message: { id: 'qq-media-2', ext_info: { ref_idx: 'ref-2' } } },
      timestamp: 200,
    });
    const e3 = appendBotGroupMessage('app', 'g1', {
      content: '只有 ref_idx',
      result: { ext_info: { ref_idx: 'ref-only-3' } },
      timestamp: 300,
    });
    const e4 = appendBotGroupMessage('app', 'g1', {
      content: '兜底 id',
      timestamp: 400,
    });

    expect(e1).toEqual({
      messageId: 'qq-msg-1',
      senderId: '__self__',
      senderName: '大肥鱼',
      role: 'assistant',
      content: '第一句',
      timestamp: 100,
    });
    expect(e2?.messageId).toBe('qq-media-2');
    expect(e3?.messageId).toBe('ref-only-3');
    expect(e4?.messageId).toMatch(/^bot-400-\d+$/);
    expect(extractSentMessageId({ message: { ext_info: { ref_idx: 'm-ref' } } }, 500)).toBe('m-ref');
    expect(readAllGroupMessages('app', 'g1')).toHaveLength(4);
  });

  it('isBotMemoryEntry 识别 __self__ 与 role=assistant，普通群友为 false', () => {
    expect(isBotMemoryEntry({ senderId: '__self__' })).toBe(true);
    expect(isBotMemoryEntry({ senderId: 'other', role: 'assistant' })).toBe(true);
    expect(isBotMemoryEntry({ senderId: 'u1' })).toBe(false);
  });

  it('resolveBotSenderName 按 非默认人设名 > 配置别名 > 默认人设别名 > bot 取值并忽略「默认」', () => {
    expect(resolveBotSenderName('g1', ['大肥鱼；小肥鱼'], {
      current: () => ({ name: '哈基米', names: ['猫猫'] }),
      defaultPersona: () => ({ name: '默认', names: ['默认别名'] }),
    })).toBe('哈基米');

    expect(resolveBotSenderName('g1', ['  ', '大肥鱼；小肥鱼'], {
      current: () => ({ name: '默认', names: [] }),
      defaultPersona: () => ({ name: '默认', names: ['默认别名'] }),
    })).toBe('大肥鱼');

    expect(resolveBotSenderName('g1', [], {
      current: () => undefined,
      defaultPersona: () => ({ name: '默认', names: ['  ', '肥鱼'] }),
    })).toBe('肥鱼');

    expect(resolveBotSenderName('g1', [], {
      current: () => undefined,
      defaultPersona: () => ({ name: '默认', names: [] }),
    })).toBe('bot');
  });

  it('readGroupMessagesAfter 支持 includeSelf=false 过滤 bot 消息且不挤占 limit 配额', () => {
    appendGroupMessage('app', 'g1', { messageId: 'u1', senderId: 'u-a', content: '人1', timestamp: 1 });
    appendBotGroupMessage('app', 'g1', { messageId: 'b1', content: '机1', senderName: '大肥鱼', timestamp: 2 });
    appendGroupMessage('app', 'g1', { messageId: 'u2', senderId: 'u-b', content: '人2', timestamp: 3 });
    appendBotGroupMessage('app', 'g1', { messageId: 'b2', content: '机2', senderName: '大肥鱼', timestamp: 4 });
    appendGroupMessage('app', 'g1', { messageId: 'u3', senderId: 'u-a', content: '人3', timestamp: 5 });
    appendGroupMessage('app', 'g1', { messageId: 'u4', senderId: 'u-b', content: '当前', timestamp: 6 });

    expect(readGroupMessagesAfter('app', 'g1', 3, undefined, 'u4').map((e) => e.messageId))
      .toEqual(['u2', 'b2', 'u3']);
    expect(readGroupMessagesAfter('app', 'g1', 3, undefined, 'u4', { includeSelf: false }).map((e) => e.messageId))
      .toEqual(['u1', 'u2', 'u3']);
    expect(readGroupMessagesAfter('app', 'g1', 3, 'u1', 'u4', { includeSelf: false }).map((e) => e.messageId))
      .toEqual(['u2', 'u3']);
  });

  it('内存缓存与追加写一致、返回副本防篡改，且外部修改或删除时自动失效', () => {
    seed(2);
    const first = readAllGroupMessages('app', 'g1');
    expect(first.map((e) => e.messageId)).toEqual(['m1', 'm2']);

    // 返回值应是独立副本，调用方改动不影响缓存
    first.pop();
    expect(readAllGroupMessages('app', 'g1').map((e) => e.messageId)).toEqual(['m1', 'm2']);

    // 热缓存期间 appendGroupMessage 同步更新缓存
    appendGroupMessage('app', 'g1', { messageId: 'm3', senderId: 'u', content: 'msg 3', timestamp: 3 });
    expect(readAllGroupMessages('app', 'g1').map((e) => e.messageId)).toEqual(['m1', 'm2', 'm3']);

    // 外部覆盖文件内容时（大小改变），下次读取失效并重新解析
    const memFile = join(fakeHome.dir, '.dsh', 'qqbot-memory', 'app-g1.jsonl');
    writeFileSync(memFile, `${JSON.stringify({ messageId: 'ext-1', senderId: 'u', content: 'external replacement line', timestamp: 10 })}\n`, 'utf8');
    expect(readAllGroupMessages('app', 'g1').map((e) => e.messageId)).toEqual(['ext-1']);

    // 游标原子写入不残留临时文件
    writeHistoryCursor('app', 'g1', { sessionId: 's1', messageId: 'ext-1' });
    const files = readdirSync(join(fakeHome.dir, '.dsh', 'qqbot-memory'));
    expect(files.filter((f) => f.includes('.tmp'))).toEqual([]);

    // 删除底层文件后读取返回空
    rmSync(memFile);
    expect(readAllGroupMessages('app', 'g1')).toEqual([]);
  });
});
