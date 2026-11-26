import { describe, it, expect, vi } from 'vitest';
import type { MiddlewareContext } from '@tencent-connect/qqbot-nodejs';
import { REPLY_JUDGE_DEFAULTS, type ImQQBotConfig } from '../config.ts';
import type { SessionManager } from '../session/index.ts';
import type { Logger } from '../types.ts';
import * as groupMemory from '../features/group-memory.ts';
import { getEngagementTracker } from '../features/reply-desire.ts';
import { JudgeQueue, type JudgeRequest } from '../features/reply-judge.ts';
import { collectJudgeLines, collectWindowImageCandidates, replyDecider, type JudgeDeps } from './reply-decider.ts';

const config = {
  debug: false,
  dnd: { interjections: true },
  replyDesire: { enabled: true, threshold: 0.6, names: ['小d'], engagedMs: 60_000, engagedMaxTurns: 8 },
} as unknown as ImQQBotConfig;
const manager = {} as SessionManager;
const dndGroups = new Set(['dnd1']);
const dndManager = {
  sessionKey: (_scope: string, id: string) => id,
  dndService: { active: (key: string) => (dndGroups.has(key) ? {} : undefined) },
} as unknown as SessionManager;
const logger = { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as Logger;
const STICKER = `<faceType=6,faceId="0",ext="${Buffer.from('{"text":""}').toString('base64')}">`;

function makeCtx(
  groupId: string,
  senderId: string,
  content: string,
  wasMentioned = false,
  attachments?: unknown[],
  extra?: { messageId?: string; senderName?: string },
) {
  const stop = vi.fn();
  const ctx = {
    message: { kind: 'group', groupOpenid: groupId, senderId, content, attachments, ...extra },
    state: { mention: { wasMentioned, implicit: false, shouldAnswer: wasMentioned, reason: wasMentioned ? 'passthrough' : 'no_mention' } },
    stop,
  } as unknown as MiddlewareContext;
  return { ctx, stop };
}

async function run(ctx: MiddlewareContext, mgr: SessionManager = manager): Promise<boolean> {
  let passed = false;
  await replyDecider(config, mgr, logger)(ctx, async () => { passed = true; });
  return passed;
}

describe('replyDecider', () => {
  it('低分消息被拦下，点名昵称当作隐式 @ 放行', async () => {
    const low = makeCtx('g1', 'u1', '今天天气不错');
    expect(await run(low.ctx)).toBe(false);
    expect(low.stop).toHaveBeenCalledWith('reply-desire:low');

    const named = makeCtx('g1', 'u1', '小d 你怎么看');
    expect(await run(named.ctx)).toBe(true);
    expect(named.ctx.state.mention).toMatchObject({ implicit: true, shouldAnswer: true, wasMentioned: false });
  });

  it('被 @ 后开对话窗口，同一个人接着说不用再 @', async () => {
    expect(await run(makeCtx('g2', 'u1', '在吗', true).ctx)).toBe(true);
    expect(await run(makeCtx('g2', 'u1', '我觉得也是').ctx)).toBe(true);
    expect(await run(makeCtx('g2', 'u2', '我觉得也是').ctx)).toBe(false);
  });

  it('开团期间 @ 不开窗口，玩家间的闲聊不插嘴', async () => {
    expect(await run(makeCtx('dnd1', 'u1', '我攻击哥布林', true).ctx, dndManager)).toBe(true);
    expect(await run(makeCtx('dnd1', 'u1', '我们先商量一下').ctx, dndManager)).toBe(false);
    expect(await run(makeCtx('dnd1', 'u1', '小d 这怪多少血').ctx, dndManager)).toBe(true);
  });

  describe('模型打分', () => {
    const judgeConfig = { ...REPLY_JUDGE_DEFAULTS, enabled: true, debounceMs: 20, maxWaitMs: 1000 };
    const judgeCfg = {
      ...config,
      appId: 'reply-decider-test',
      model: 'm',
      provider: 'p',
      replyDesire: { ...config.replyDesire, judge: judgeConfig },
    } as unknown as ImQQBotConfig;
    const judgeManager = { getEffectiveModel: () => undefined } as unknown as SessionManager;

    function deps(
      desire: number | undefined,
      extra?: Partial<Omit<JudgeDeps, 'judge' | 'queue'>> & { supportsImageInput?: () => Promise<boolean> },
    ) {
      const score = vi.fn(async (_req: JudgeRequest) => desire);
      const supportsImageInput = extra?.supportsImageInput ? vi.fn(extra.supportsImageInput) : undefined;
      return {
        score,
        supportsImageInput,
        deps: {
          judge: { score, ...(supportsImageInput ? { supportsImageInput } : {}) },
          queue: new JudgeQueue(() => judgeConfig),
          ...(extra?.downloadImages ? { downloadImages: extra.downloadImages } : {}),
          ...(extra?.prepareImage ? { prepareImage: extra.prepareImage } : {}),
        } as JudgeDeps,
      };
    }
    async function runJudge(
      ctx: MiddlewareContext,
      d: JudgeDeps,
      mgr: SessionManager = judgeManager,
      cfg: ImQQBotConfig = judgeCfg,
    ): Promise<boolean> {
      let passed = false;
      await replyDecider(cfg, mgr, logger, d)(ctx, async () => { passed = true; });
      return passed;
    }

    it('连着两条普通文字只给最后一条打分，分够就当隐式 @ 放行', async () => {
      const { score, deps: d } = deps(0.9);
      const first = makeCtx('j1', 'u1', '有人知道这个报错吗');
      const second = makeCtx('j1', 'u2', 'TypeError: x is undefined');
      const [a, b] = await Promise.all([runJudge(first.ctx, d), runJudge(second.ctx, d)]);
      expect(a).toBe(false);
      expect(first.stop).toHaveBeenCalledWith('reply-desire:superseded');
      expect(b).toBe(true);
      expect(score).toHaveBeenCalledTimes(1);
      expect(second.ctx.state.replyDesire).toMatchObject({ score: 0.9, reasons: ['judge'] });
    });

    it('分不够、打分失败都不接', async () => {
      expect(await runJudge(makeCtx('j2', 'u1', '今天好热').ctx, deps(0.3).deps)).toBe(false);
      expect(await runJudge(makeCtx('j3', 'u1', '今天好热').ctx, deps(undefined).deps)).toBe(false);
    });

    it('语气词与关掉插嘴的跑团不调模型；允许插嘴的跑团传 dnd 旁观线索给裁判', async () => {
      const { score, deps: d } = deps(0.2);
      expect(await runJudge(makeCtx('j4', 'u1', '哈哈哈').ctx, d)).toBe(false);
      expect(score).not.toHaveBeenCalled();

      const dndJudgeManager = { ...dndManager, getEffectiveModel: () => undefined } as unknown as SessionManager;
      const dndDisabledCfg = { ...judgeCfg, dnd: { interjections: false } } as unknown as ImQQBotConfig;
      expect(await runJudge(makeCtx('dnd1', 'u1', '我们先商量一下').ctx, d, dndJudgeManager, dndDisabledCfg)).toBe(false);
      expect(score).not.toHaveBeenCalled();

      expect(await runJudge(makeCtx('dnd1', 'u1', '我们先商量一下').ctx, d, dndJudgeManager)).toBe(false);
      expect(score).toHaveBeenCalledTimes(1);
      expect(score.mock.calls[0]![0].hints).toMatchObject({ dnd: true });
    });

    it('提到 bot 昵称也进灰区裁判并携带 named 线索，可拦下第三人称提及', async () => {
      const low = deps(0.2);
      expect(await runJudge(makeCtx('j-name', 'u1', '刚才小d 那句话笑死我了').ctx, low.deps)).toBe(false);
      expect(low.score).toHaveBeenCalledTimes(1);
      expect(low.score.mock.calls[0]![0].hints).toMatchObject({ named: true });

      const high = deps(0.9);
      const ask = makeCtx('j-name', 'u1', '小d 帮我算一下');
      expect(await runJudge(ask.ctx, high.deps)).toBe(true);
      expect(ask.ctx.state.replyDesire).toMatchObject({ score: 0.9, reasons: ['name', 'judge'] });
    });

    it('对话窗口内的文字也要过打分并携带窗口线索，不靠窗口直接放行', async () => {
      const { score, deps: d } = deps(0.1);
      expect(await runJudge(makeCtx('b2', 'u1', '在吗', true).ctx, d)).toBe(true);
      expect(await runJudge(makeCtx('b2', 'u1', '我觉得也是').ctx, d)).toBe(false);
      expect(score).toHaveBeenCalledTimes(1);
      expect(score.mock.calls[0]![0].hints).toMatchObject({ engaged: true, engagedPeer: true });
    });

    it('连续接同一个人到上限后不再调模型，换人或直接叫昵称不受阻断', async () => {
      const { score, deps: d } = deps(0.9);
      expect(await runJudge(makeCtx('b3', 'u1', '第一句').ctx, d)).toBe(true);
      expect(await runJudge(makeCtx('b3', 'u1', '第二句').ctx, d)).toBe(true);
      expect(await runJudge(makeCtx('b3', 'u1', '第三句').ctx, d)).toBe(false);
      expect(score).toHaveBeenCalledTimes(2);
      // 明确喊昵称不被连说上限静默吞掉
      expect(await runJudge(makeCtx('b3', 'u1', '小d 帮我查一下').ctx, d)).toBe(true);
      expect(score).toHaveBeenCalledTimes(3);
      expect(await runJudge(makeCtx('b3', 'u2', '换个人').ctx, d)).toBe(true);
      expect(await runJudge(makeCtx('b3', 'u1', '又是我').ctx, d)).toBe(true);
    });

    it('表情包接龙快捷直通不调模型，窗口内非冷却表情包经裁判放行后保留 sticker 模式并进入冷却', async () => {
      const { score, deps: d } = deps(0.9);
      const collectionKind = vi.fn((md5: string) => (md5 === 'PACK1' ? 'pack' : undefined));
      const mgr = { ...judgeManager, stickerStore: { collectionKind } } as unknown as SessionManager;
      // 先用 @ 打开窗口
      expect(await runJudge(makeCtx('j-stk', 'u1', '在吗', true).ctx, d, mgr)).toBe(true);
      const packCtx = makeCtx('j-stk', 'u2', STICKER, false, [{ content_type: 'image/png', filename: 'pack1.png', url: 'https://img/p1' }]);
      expect(await runJudge(packCtx.ctx, d, mgr)).toBe(true);
      expect(score).toHaveBeenCalledTimes(1);
      expect(score.mock.calls[0]![0].hints).toMatchObject({ engaged: true, engagedPeer: false, sticker: true, stickerCollection: 'pack' });
      expect(packCtx.ctx.state.replyDesire).toMatchObject({ mode: 'sticker', stickerId: 'PACK1', score: 0.9 });

      // 冷却期内不再调模型
      const blocked = makeCtx('j-stk', 'u3', STICKER, false, [{ content_type: 'image/png', filename: 'other.png', url: 'https://img/o1' }]);
      expect(await runJudge(blocked.ctx, d, mgr)).toBe(false);
      expect(score).toHaveBeenCalledTimes(1);

      // 连续 3 条不同人复读同一张：快捷跟发，不调模型
      const chainMgr = { ...judgeManager } as unknown as SessionManager;
      const pic = [{ content_type: 'image/png', filename: 'chain.png' }];
      getEngagementTracker().record('j-chain', { senderId: 'u1', stickerId: 'CHAIN' });
      getEngagementTracker().record('j-chain', { senderId: 'u2', stickerId: 'CHAIN' });
      const third = makeCtx('j-chain', 'u3', STICKER, false, pic);
      expect(await runJudge(third.ctx, d, chainMgr)).toBe(true);
      expect(third.ctx.state.replyDesire).toMatchObject({ mode: 'sticker-chain', stickerId: 'CHAIN' });
      expect(score).toHaveBeenCalledTimes(1);
    });

    it('对话窗口内纯图与先图后文最多附带 2 张图片给多模态裁判，纯文本裁判跳过下载', async () => {
      const now = Date.now();
      const imageBlock = { type: 'image' as const, attachment: { id: 'img-1', mediaType: 'image/png' as const, size: 64 } };
      const createImageBlock = vi.fn(async () => imageBlock);
      const downloadImages = vi.fn(async (items: Array<{ localPath?: string; url: string }>) => {
        for (const item of items) item.localPath = `/tmp/${item.url.split('/').pop()}.png`;
      });
      const prepareImage = vi.fn(async (path: string) => ({ path }));
      const multimodalMgr = { ...judgeManager, createImageBlock } as unknown as SessionManager;
      const mediaCfg = { ...judgeCfg, media: { enabled: true }, vision: { maxBytes: 10_000_000 } } as unknown as ImQQBotConfig;

      // 窗口外纯图直接跳过，不下载也不调模型
      const outWin = deps(0.9, { supportsImageInput: async () => true, downloadImages, prepareImage });
      const photoAtt = [{ content_type: 'image/png', filename: 'err.png', url: 'https://img/err' }];
      expect(await runJudge(makeCtx('j-img-out', 'u1', '', false, photoAtt).ctx, outWin.deps, multimodalMgr, mediaCfg)).toBe(false);
      expect(downloadImages).not.toHaveBeenCalled();
      expect(outWin.score).not.toHaveBeenCalled();

      // 窗口内（含不同群友）：最多附最新 2 张，且忽略 bot 上次发言前的旧图
      const spy = vi.spyOn(groupMemory, 'readRecentGroupMessages').mockReturnValue([
        { messageId: 'm0', senderId: 'u1', senderName: '阿明', content: '旧图', timestamp: now - 20_000, images: [{ url: 'https://img/old' }] },
        { messageId: 'b0', senderId: '__self__', senderName: '小d', role: 'assistant', content: '收到', timestamp: now - 10_000 },
        { messageId: 'm1', senderId: 'u2', senderName: '小红', content: '', timestamp: now - 3_000, images: [{ url: 'https://img/a' }, { url: 'https://img/b' }] },
        { messageId: 'm2', senderId: 'u2', senderName: '小红', content: '看下这个报错', timestamp: now - 1_000, images: [{ url: 'https://img/c' }] },
      ]);

      try {
        const candidates = collectWindowImageCandidates({
          config: mediaCfg,
          groupId: 'j-img-in',
          messageId: 'm2',
          senderId: 'u2',
          now,
          engagedMs: 60_000,
        });
        expect(candidates.map((c) => c.url)).toEqual(['https://img/b', 'https://img/c']);

        const mm = deps(0.88, { supportsImageInput: async () => true, downloadImages, prepareImage });
        expect(await runJudge(makeCtx('j-img-in', 'u1', '在吗', true).ctx, mm.deps, multimodalMgr, mediaCfg)).toBe(true);
        const follow = makeCtx('j-img-in', 'u2', '看下这个报错', false, [{ content_type: 'image/png', url: 'https://img/c' }], { messageId: 'm2', senderName: '小红' });
        expect(await runJudge(follow.ctx, mm.deps, multimodalMgr, mediaCfg)).toBe(true);
        expect(downloadImages).toHaveBeenCalledTimes(1);
        expect(createImageBlock).toHaveBeenCalledWith('/tmp/b.png', expect.objectContaining({ ignoreNativeFlag: true }));
        expect(createImageBlock).toHaveBeenCalledWith('/tmp/c.png', expect.objectContaining({ ignoreNativeFlag: true }));
        const req = mm.score.mock.calls[0]![0];
        expect(req.images).toHaveLength(2);
        expect(req.lines.at(-1)?.text).toBe('看下这个报错 [图片]');
        expect(follow.ctx.state.replyDesire).toMatchObject({ score: 0.88 });
        expect((follow.ctx.state.replyDesire as { reasons: string[] }).reasons).toEqual(expect.arrayContaining(['engaged', 'judge', 'images']));

        // 纯文本打分模型：不下载图片，直接纯文本打分
        downloadImages.mockClear();
        const textOnly = deps(0.8, { supportsImageInput: async () => false, downloadImages, prepareImage });
        expect(await runJudge(makeCtx('j-img-txt', 'u1', '在吗', true).ctx, textOnly.deps, multimodalMgr, mediaCfg)).toBe(true);
        const pureImg = makeCtx('j-img-txt', 'u2', '', false, [{ content_type: 'image/png', url: 'https://img/c' }], { messageId: 'm2', senderName: '小红' });
        expect(await runJudge(pureImg.ctx, textOnly.deps, multimodalMgr, mediaCfg)).toBe(true);
        expect(downloadImages).not.toHaveBeenCalled();
        expect(textOnly.score.mock.calls[0]![0].images).toBeUndefined();
      } finally {
        spy.mockRestore();
      }
    });

    it('等打分时有人 @ bot：候选作废', async () => {
      const { score, deps: d } = deps(1);
      const pending = runJudge(makeCtx('j5', 'u1', '今天好热').ctx, d);
      expect(await runJudge(makeCtx('j5', 'u2', '在吗', true).ctx, d)).toBe(true);
      expect(await pending).toBe(false);
      expect(score).not.toHaveBeenCalled();
    });
  });

  it('群友发 bot 自带的表情包：没刚说过话也接，按收藏比对文件名（内容 MD5）', async () => {
    const collectionKind = vi.fn((md5: string) => (md5 === 'AD030B48' ? 'pack' : undefined));
    const withStickers = { stickerStore: { collectionKind } } as unknown as SessionManager;
    const pack = makeCtx('g4', 'u7', STICKER, false, [{ content_type: 'image/png', filename: 'ad030b48.png' }]);
    expect(await run(pack.ctx, withStickers)).toBe(true);
    expect(pack.ctx.state.replyDesire).toMatchObject({ mode: 'sticker', reasons: ['sticker-mine'] });
    expect(collectionKind).toHaveBeenCalledWith('AD030B48');
    const other = makeCtx('g4', 'u8', STICKER, false, [{ content_type: 'image/png', filename: 'FFFF.png' }]);
    expect(await run(other.ctx, withStickers)).toBe(false);
  });

  it('刚和 bot 聊过的人在 bot 说完话后甩表情包：接一张，之后 5 分钟别人再甩也不接', async () => {
    expect(await run(makeCtx('g3', 'u9', '在吗', true).ctx)).toBe(true);
    getEngagementTracker().touch('g3', Date.now(), 60_000);
    const pic = [{ content_type: 'image/png', filename: 'ABC.png' }];
    const first = makeCtx('g3', 'u9', STICKER, false, pic);
    expect(await run(first.ctx)).toBe(true);
    expect(first.ctx.state.replyDesire).toMatchObject({ mode: 'sticker', reasons: ['sticker-react', 'engaged-peer'] });
    const other = makeCtx('g3', 'u10', STICKER, false, [{ content_type: 'image/png', filename: 'DEF.png' }]);
    expect(await run(other.ctx)).toBe(false);
  });

  it('bot 刚说完话，没和它聊过的人甩表情包：不接', async () => {
    getEngagementTracker().touch('g6', Date.now(), 60_000);
    expect(await run(makeCtx('g6', 'u1', STICKER, false, [{ content_type: 'image/png', filename: 'ABC.png' }]).ctx)).toBe(false);
  });

  it('collectJudgeLines 支持只取当前消息之前的群聊 + bot 对话（供笔记打分复用）', () => {
    const gid = 'g-note-ctx';
    const cfg = {
      appId: 'app-ctx',
      replyDesire: { judge: { ...REPLY_JUDGE_DEFAULTS, contextMessages: 6 } },
    } as unknown as ImQQBotConfig;
    const spy = vi.spyOn(groupMemory, 'readRecentGroupMessages').mockReturnValue([
      { messageId: 'm1', senderId: 'u1', senderName: '阿明', content: '昨天那张海报改完了吗', timestamp: 1000 },
      { messageId: 'm2', senderId: 'u2', senderName: '小红', content: '发出来看看', timestamp: 2000 },
    ]);
    getEngagementTracker().noteBotSaid(gid, '改完第三版了', 1500);

    try {
      const beforeOnly = collectJudgeLines(cfg, gid, 'm2', { includeCurrent: false });
      expect(beforeOnly).toEqual([
        { sender: '阿明', text: '昨天那张海报改完了吗', timestamp: 1000 },
        { text: '改完第三版了', timestamp: 1500 },
      ]);

      const withCurrent = collectJudgeLines(cfg, gid, 'm2');
      expect(withCurrent).toHaveLength(3);
      expect(withCurrent[2]).toMatchObject({ sender: '小红', text: '发出来看看', timestamp: 2000 });
    } finally {
      spy.mockRestore();
    }
  });

  it('collectJudgeLines 直接消费归档里的 bot 发言（省略 sender），且不与 noteBotSaid 重复', () => {
    const gid = 'g-archived-bot';
    const cfg = {
      appId: 'app-ctx',
      replyDesire: { judge: { ...REPLY_JUDGE_DEFAULTS, contextMessages: 6 } },
    } as unknown as ImQQBotConfig;
    const spy = vi.spyOn(groupMemory, 'readRecentGroupMessages').mockReturnValue([
      { messageId: 'm1', senderId: 'u1', senderName: '阿明', content: '昨天那张海报改完了吗', timestamp: 1000 },
      { messageId: 'b1', senderId: '__self__', senderName: '大肥鱼', role: 'assistant', content: '改完第三版了', timestamp: 1500 },
      { messageId: 'm2', senderId: 'u2', senderName: '小红', content: '发出来看看', timestamp: 2000 },
    ]);
    getEngagementTracker().noteBotSaid(gid, '改完第三版了', 1500);

    try {
      expect(collectJudgeLines(cfg, gid, 'm2', { includeCurrent: false })).toEqual([
        { sender: '阿明', text: '昨天那张海报改完了吗', timestamp: 1000 },
        { text: '改完第三版了', timestamp: 1500 },
      ]);
      expect(collectJudgeLines(cfg, gid, 'm2')).toEqual([
        { sender: '阿明', text: '昨天那张海报改完了吗', timestamp: 1000 },
        { text: '改完第三版了', timestamp: 1500 },
        { sender: '小红', text: '发出来看看', timestamp: 2000 },
      ]);
    } finally {
      spy.mockRestore();
    }
  });
});
