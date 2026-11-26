import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, vi } from 'vitest';
import { AdventureLibrary } from './adventure.ts';
import { CampaignStore, addSummary, applyDamage, startInitiative, upsertCharacter } from './campaign.ts';
import { DndService, DndSnapshotGate } from './dnd-service.ts';
import { DndCombatAgents } from './combat-agent.ts';
import { agentUserTurnTag, dndStateText, isRuntimeContextEvent, promptEpoch } from '../session/session-manager.ts';
import type { DshAgent, SessionRecord } from '../session/index.ts';

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };

function setup() {
  const root = mkdtempSync(join(tmpdir(), 'dnd-snapshot-'));
  const service = new DndService({ store: new CampaignStore(join(root, 'campaigns')), library: new AdventureLibrary(), mapDir: root });
  const key = 'qqbot:app:group:G1';
  service.start(key, 'sunken-bell', false);
  service.store.update(key, (c) => {
    upsertCharacter(c, { name: '卡厄斯', maxHp: 12 });
    upsertCharacter(c, { name: '巨鼠1', kind: 'monster', maxHp: 7, room: c.currentRoom });
  });
  return { service, key };
}

describe('团况快照', () => {
  it('扣血、推进回合只改快照，system prompt 一个字不变（否则后面的历史全部失去缓存）', () => {
    const { service, key } = setup();
    const sections = service.promptSections(key);
    const snapshot = service.stateSnapshot(key);

    service.store.update(key, (c) => {
      startInitiative(c, () => 10);
      applyDamage(c, '巨鼠1', 3);
    });

    expect(service.promptSections(key)).toEqual(sections);
    const after = service.stateSnapshot(key);
    expect(after).not.toBe(snapshot);
    expect(after).toContain('战斗第 1 轮');
  });

  it('局面没变时快照文字不变：宿主据此不追加新消息', () => {
    const { service, key } = setup();
    expect(service.stateSnapshot(key)).toBe(service.stateSnapshot(key));
  });

  it('快照放会变的团况，上次进度和守则留在 system prompt', () => {
    const { service, key } = setup();
    service.store.update(key, (c) => addSummary(c, '队伍在门口'));
    const system = service.promptSections(key).map((s) => s.text).join('\n');
    const snapshot = service.stateSnapshot(key);
    expect(system).toContain('上次进度：队伍在门口');
    expect(system).toContain('Current runtime context');
    expect(system).not.toContain('【团况 · DM 视角】\n');
    expect(snapshot).toContain('【团况 · DM 视角】');
    expect(snapshot).not.toContain('上次进度');
  });

  it('结团后快照为空：宿主会发一条作废旧快照的消息', () => {
    const { service, key } = setup();
    service.stop(key);
    expect(service.stateSnapshot(key)).toBe('');
  });
});

describe('system prompt 背景按 epoch 锁住', () => {
  const background = (service: DndService, key: string, epoch?: string) =>
    service.promptSections(key, epoch).find((s) => s.name === 'qqbot:dnd-background')?.text ?? '';

  it('存档不改 system prompt（模型刚写过，在对话里），压缩后 epoch 变了才换新', () => {
    const { service, key } = setup();
    service.store.update(key, (c) => addSummary(c, '第一版进度'));
    const first = service.promptSections(key, 's:0');
    service.store.update(key, (c) => addSummary(c, '第二版进度'));
    expect(service.promptSections(key, 's:0')).toEqual(first);
    expect(service.stateSnapshot(key)).not.toContain('第二版进度');
    expect(background(service, key, 's:1')).toContain('第二版进度');
  });

  it('开团时还没有存档：第一次存档也不让 system prompt 变', () => {
    const { service, key } = setup();
    const first = service.promptSections(key, 's:0');
    service.store.update(key, (c) => addSummary(c, '第一版进度'));
    expect(service.promptSections(key, 's:0')).toEqual(first);
  });

  it('换场景后 system prompt 不变，新规则写进快照', () => {
    const root = mkdtempSync(join(tmpdir(), 'dnd-snapshot-'));
    const service = new DndService({ store: new CampaignStore(join(root, 'campaigns')), library: new AdventureLibrary(), mapDir: root });
    const key = 'qqbot:app:group:G2';
    service.start(key, 'sunken-bell', false);
    const adventure = service.require(key).adventure;
    adventure.sites[0]!.features = '旧场景规则';
    const first = service.promptSections(key, 's:0');
    adventure.sites[0]!.features = '新场景规则';
    expect(service.promptSections(key, 's:0')).toEqual(first);
    expect(service.stateSnapshot(key)).toContain('新场景规则');
    expect(service.stateSnapshot(key)).not.toContain('旧场景规则');
    expect(background(service, key, 's:1')).toContain('新场景规则');
    expect(service.stateSnapshot(key)).not.toContain('新场景规则');
  });

  it('重新开团不沿用上一次锁住的进度', () => {
    const { service, key } = setup();
    service.store.update(key, (c) => addSummary(c, '旧进度'));
    service.promptSections(key, 's:0');
    service.stop(key);
    service.start(key, 'sunken-bell', false);
    service.store.update(key, (c) => addSummary(c, '新进度'));
    expect(background(service, key, 's:0')).toContain('新进度');
  });
});

describe('promptEpoch', () => {
  const recordOf = (session: object) => ({ agent: { session } }) as unknown as SessionRecord;

  it('由会话和 contentGeneration 决定；宿主没暴露时按 0', () => {
    expect(promptEpoch(recordOf({ id: 's', surface: { contentGeneration: 3 } }))).toBe('s:3');
    expect(promptEpoch(recordOf({ id: 's' }))).toBe('s:0');
  });

  it('真实宿主事件流中 system/message replace 递增 contentGeneration 不改 epoch，仅 compaction 变更', () => {
    const events: Array<Record<string, unknown>> = [
      { seq: 1, type: 'turn/start', data: { turn: 1 } },
      { seq: 2, type: 'step/start', data: { turn: 1, step: 1 } },
      { seq: 3, type: 'system/message', surfaceOp: 'append' },
    ];
    const surface = { contentGeneration: 1 };
    const rec = recordOf({ id: 's', events, surface });
    expect(promptEpoch(rec)).toBe('s:c0');

    // Step 1 写入 system/message replace 后宿主的 contentGeneration 递增，epoch 仍须保持不变（避免 Step 2 击穿缓存）
    events.push({ seq: 4, type: 'system/message', surfaceOp: { op: 'replace', startSeq: 3, endSeq: 3 } });
    surface.contentGeneration += 1;
    expect(promptEpoch(rec)).toBe('s:c0');

    // 真正压缩后 epoch 递增
    events.push({ seq: 5, type: 'compaction/summary' }, { seq: 6, type: 'compaction/end' });
    surface.contentGeneration += 1;
    expect(promptEpoch(rec)).toBe('s:c1');

    // 压缩后首步再次重写 system/message，Step 2 仍保持 s:c1
    events.push({ seq: 7, type: 'system/message', surfaceOp: { op: 'replace', startSeq: 4, endSeq: 4 } });
    surface.contentGeneration += 1;
    expect(promptEpoch(rec)).toBe('s:c1');
  });

  it('agentUserTurnTag 优先锚定 turn/start，同轮 Step 1（user/message 前）与 Step 2 标识一致', () => {
    const events: Array<Record<string, unknown>> = [
      { seq: 679, type: 'turn/start', data: { turn: 45 } },
      { seq: 681, type: 'step/start', data: { turn: 45, step: 1 } },
    ];
    const rec = recordOf({ id: 's', events, surface: { contentGeneration: 1 } });
    const step1BeforeUser = agentUserTurnTag(rec);
    events.push(
      { seq: 682, type: 'system/message', surfaceOp: { op: 'replace', startSeq: 31, endSeq: 31 } },
      { seq: 683, type: 'user/message', data: { source: { kind: 'user' } } },
      { seq: 684, type: 'user/message', data: { source: { kind: 'runtime-context' } } },
      { seq: 694, type: 'step/start', data: { turn: 45, step: 2 } },
    );
    const step2 = agentUserTurnTag(rec);
    expect(step2).toBe(step1BeforeUser);

    events.push({ seq: 702, type: 'turn/start', data: { turn: 46 } });
    expect(agentUserTurnTag(rec)).not.toBe(step2);
  });

  it('DndService 传入 latchFile 后跨重载复用同一 epoch 的背景锁', () => {
    const root = mkdtempSync(join(tmpdir(), 'dnd-latch-persist-'));
    const latchFile = join(root, 'prompt-latch.json');
    const store = new CampaignStore(join(root, 'campaigns'));
    const library = new AdventureLibrary();
    const key = 'group:persist';

    const s1 = new DndService({ store, library, mapDir: root, latchFile });
    s1.start(key, 'sunken-bell', false);
    s1.store.update(key, (c) => addSummary(c, '初始进度'));
    const before = s1.promptSections(key, 'sess:c1').find((s) => s.name === 'qqbot:dnd-background')!.text;
    expect(before).toContain('初始进度');

    // 写入新进度后模拟插件重启（重建 DndService）
    s1.store.update(key, (c) => addSummary(c, '重启前写入的新进度'));
    const s2 = new DndService({ store, library, mapDir: root, latchFile });
    const afterReload = s2.promptSections(key, 'sess:c1').find((s) => s.name === 'qqbot:dnd-background')!.text;
    expect(afterReload).toBe(before);

    // 压缩后 epoch 变为 sess:c2 时才刷新到新进度
    const afterCompact = s2.promptSections(key, 'sess:c2').find((s) => s.name === 'qqbot:dnd-background')!.text;
    expect(afterCompact).toContain('重启前写入的新进度');
  });
});

describe('dndStateText', () => {
  const agent = {} as DshAgent;
  const record = { sessionKey: 'k' } as SessionRecord;

  it('按 agent 找到会话取快照', () => {
    const dnd = { stateSnapshot: vi.fn(() => '团况') };
    expect(dndStateText(agent, () => record, dnd, logger as never)).toBe('团况');
    expect(dnd.stateSnapshot).toHaveBeenCalledWith('k');
  });

  it('没有 agent、不是 QQ 会话（如子 agent）、没启用跑团都返回空串', () => {
    const dnd = { stateSnapshot: vi.fn(() => '团况') };
    expect(dndStateText(undefined, () => record, dnd, logger as never)).toBe('');
    expect(dndStateText(agent, () => undefined, dnd, logger as never)).toBe('');
    expect(dndStateText(agent, () => record, undefined, logger as never)).toBe('');
    expect(dnd.stateSnapshot).not.toHaveBeenCalled();
  });

  it('读团档出错不影响这次请求', () => {
    const dnd = { stateSnapshot: () => { throw new Error('坏档'); } };
    expect(dndStateText(agent, () => record, dnd, logger as never)).toBe('');
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('坏档'));
  });
});

describe('isRuntimeContextEvent', () => {
  it('认得宿主事件形态（source 在 data 上）和 message 形态', () => {
    expect(isRuntimeContextEvent({ type: 'user/message', data: { source: { kind: 'runtime-context' } } })).toBe(true);
    expect(isRuntimeContextEvent({ type: 'user/message', message: { source: { kind: 'runtime-context' } } })).toBe(true);
  });

  it('玩家消息不算', () => {
    expect(isRuntimeContextEvent({ type: 'user/message', data: { source: { kind: 'user' } } })).toBe(false);
    expect(isRuntimeContextEvent({ type: 'user/message', message: { content: [] } })).toBe(false);
  });
});

describe('DndSnapshotGate：同轮锁死 + 跨轮首步穿透 + 压缩/撤销同轮例外', () => {
  it('同一轮对话连续多次动作/换房/开结战均锁定不重发；压缩与撤销同轮例外；跨到下一轮第一步立即穿透同步最终态', () => {
    const { service, key } = setup();
    service.store.update(key, (c) => { startInitiative(c, () => 10); });

    const events: Array<Record<string, unknown>> = [];
    const surface = { contentGeneration: 0 };
    const agent = { session: { id: 'sess-1', events, surface } } as unknown as DshAgent;
    const record = { sessionKey: key, agent } as unknown as SessionRecord;
    const gate = new DndSnapshotGate();
    const evalState = () => dndStateText(agent, () => record, service, logger as never, undefined, { gate, intervalTurns: 4 });

    const pushUserTurn = (seq: number) => {
      events.push({ seq, type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: `第${seq}句` }] } });
    };

    const toolMutate = (fn: (c: Parameters<typeof service.store.update>[1] extends (c: infer C) => unknown ? C : never) => void) => {
      service.store.update(key, fn);
      service.recordAgentToolSync(key);
    };

    // 第 1 轮用户发言（Step 0）：首次注入完整团况
    pushUserTurn(1);
    const snap0 = evalState();
    expect(snap0).toContain('战斗第 1 轮');

    // 第 1 轮内连续 4 次工具调用（如 move + 3 连击扣血），哪怕中间宿主写过 runtime-context 事件，返回值恒定 === snap0（0 次重发）
    events.push({ seq: 2, type: 'user/message', data: { source: { kind: 'runtime-context' } } });
    for (let hit = 1; hit <= 4; hit++) {
      toolMutate((c) => applyDamage(c, '巨鼠1', 1));
      expect(evalState()).toBe(snap0);
    }

    // 第 2、3、4 轮用户对话（距上次同步 1、2、3 轮 < 4）：Agent 自身工具产生的扣血继续节流，不重刷整份团况
    for (let u = 2; u <= 4; u++) {
      pushUserTurn(u * 10);
      toolMutate((c) => applyDamage(c, '卡厄斯', 1));
      expect(evalState()).toBe(snap0);
    }

    // 第 5 轮用户对话（距上次同步满 4 轮）：自动同步最新团况！
    pushUserTurn(50);
    const snap5 = evalState();
    expect(snap5).not.toBe(snap0);
    expect(snap5).toContain('卡厄斯 9/12');

    // 关键边界 1：下一轮刚过 1 轮，但执行了 dnd_undo（forceNextSnapshot）→ 同轮立即穿透节流！
    pushUserTurn(60);
    toolMutate((c) => applyDamage(c, '卡厄斯', 2));
    service.forceNextSnapshot(key);
    const snapUndo = evalState();
    expect(snapUndo).not.toBe(snap5);
    expect(snapUndo).toContain('卡厄斯 7/12');

    // 关键边界 2：同轮中途连续切换房间 / 结战 / 暂离变化 → 同轮严格锁死，返回值保持 === snapUndo（0 次重发）
    toolMutate((c) => { c.currentRoom = 'nave'; });
    expect(evalState()).toBe(snapUndo);
    toolMutate((c) => {
      c.initiative = undefined;
      c.characters[0]!.absent = true;
    });
    expect(evalState()).toBe(snapUndo);

    // 跨到下一轮用户对话开头（仅隔 1 轮 < 4）：由于 lastStructKey 仍停留在本轮初，首步立刻穿透节流并同步最终稳定团况！
    pushUserTurn(70);
    const snapRoom = evalState();
    expect(snapRoom).not.toBe(snapUndo);
    expect(snapRoom).toContain('暂离');
    expect(snapRoom).not.toContain('战斗第');

    // 关键边界 3：常规节流期内触发上下文压缩（contentGeneration 递增）→ 立即刷新！
    pushUserTurn(75);
    toolMutate((c) => applyDamage(c, '卡厄斯', 1));
    expect(evalState()).toBe(snapRoom); // 压缩前仅隔 1 轮仍在节流期内
    surface.contentGeneration += 1;
    const snapCompacted = evalState();
    expect(snapCompacted).not.toBe(snapRoom);
    expect(snapCompacted).toContain('7→6/12');

    // 关键边界 4：工具外改档（未走 dnd_* mutate，如斜杠命令/后台修改）→ 下一轮用户消息立即穿透节流！
    pushUserTurn(80);
    service.store.update(key, (c) => applyDamage(c, '卡厄斯', 1));
    const snapExternal = evalState();
    expect(snapExternal).not.toBe(snapCompacted);
    expect(snapExternal).toContain('6→5/12');

    // 关键边界 5：停团后立即返回空串作废旧快照
    service.stop(key);
    expect(evalState()).toBe('');
  });

  it('DndSnapshotGate 严格执行同轮锁死（仅 epoch 压缩 / forceSeq 撤销例外）与跨轮首步穿透', () => {
    const gate = new DndSnapshotGate();
    const agentKey = {};

    // 第 u1 轮初始注入
    expect(gate.resolve({
      agentKey,
      fresh: 'S1-roomA',
      turnTag: 'u1',
      epoch: 'e0',
      structKey: 'roomA|explore',
      forceSeq: 0,
      intervalTurns: 4,
    })).toBe('S1-roomA');

    // 同轮 u1 连续切换房间与开战（structKey 连续变化）→ 一律锁死返回 S1-roomA
    expect(gate.resolve({
      agentKey,
      fresh: 'S2-roomB',
      turnTag: 'u1',
      epoch: 'e0',
      structKey: 'roomB|explore',
      forceSeq: 0,
      intervalTurns: 4,
    })).toBe('S1-roomA');

    expect(gate.resolve({
      agentKey,
      fresh: 'S3-roomC-combat',
      turnTag: 'u1',
      epoch: 'e0',
      structKey: 'roomC|combat',
      forceSeq: 0,
      intervalTurns: 4,
    })).toBe('S1-roomA');

    // 跨到下一轮 u2 开头（仅隔 1 轮 < 4）：命中上轮遗留的 structKey 差异，首步直接穿透输出最终稳定态 S3-roomC-combat
    expect(gate.resolve({
      agentKey,
      fresh: 'S3-roomC-combat',
      turnTag: 'u2',
      epoch: 'e0',
      structKey: 'roomC|combat',
      forceSeq: 0,
      intervalTurns: 4,
    })).toBe('S3-roomC-combat');

    // 下一轮 u3（距上次 1 轮 < 4）：无结构边界变化，常规节流返回 S3-roomC-combat
    expect(gate.resolve({
      agentKey,
      fresh: 'S4-hp-down',
      turnTag: 'u3',
      epoch: 'e0',
      structKey: 'roomC|combat',
      forceSeq: 0,
      intervalTurns: 4,
    })).toBe('S3-roomC-combat');

    // 同轮 u3 发生上下文压缩（epoch: e0 -> e1）→ 例外立即穿透
    expect(gate.resolve({
      agentKey,
      fresh: 'S5-compacted',
      turnTag: 'u3',
      epoch: 'e1',
      structKey: 'roomC|combat',
      forceSeq: 0,
      intervalTurns: 4,
    })).toBe('S5-compacted');

    // 仍处同轮 u3：压缩后再次换房 → 重新被同轮锁死在 S5-compacted
    expect(gate.resolve({
      agentKey,
      fresh: 'S6-roomD',
      turnTag: 'u3',
      epoch: 'e1',
      structKey: 'roomD|combat',
      forceSeq: 0,
      intervalTurns: 4,
    })).toBe('S5-compacted');

    // 仍处同轮 u3：触发 dnd_undo（forceSeq: 0 -> 1）→ 例外立即穿透并同步当前 structKey
    expect(gate.resolve({
      agentKey,
      fresh: 'S7-undone',
      turnTag: 'u3',
      epoch: 'e1',
      structKey: 'roomD|combat',
      forceSeq: 1,
      intervalTurns: 4,
    })).toBe('S7-undone');

    // 后续 u4~u6 在 roomD|combat 下按 4 轮节流锁定 S7-undone，满 4 轮（u7）自动刷新为 S8-settled
    for (const turnTag of ['u4', 'u5', 'u6']) {
      expect(gate.resolve({
        agentKey,
        fresh: 'S8-settled',
        turnTag,
        epoch: 'e1',
        structKey: 'roomD|combat',
        forceSeq: 1,
        intervalTurns: 4,
      })).toBe('S7-undone');
    }
    expect(gate.resolve({
      agentKey,
      fresh: 'S8-settled',
      turnTag: 'u7',
      epoch: 'e1',
      structKey: 'roomD|combat',
      forceSeq: 1,
      intervalTurns: 4,
    })).toBe('S8-settled');
  });

  it('专用战斗子代理 decorateTurnText 同样按轮数节流，首轮注入、间隔轮次跳过、满轮或外部改档/撤销立即同步', async () => {
    const { service, key } = setup();
    service.store.update(key, (c) => { startInitiative(c, () => 10); });

    const mainAgent = {
      id: 'main',
      status: 'idle',
      session: { id: 'main', header: { cwd: process.cwd() }, events: [] },
      followup: vi.fn(),
      cancel: vi.fn(),
      whenIdle: async () => {},
    } as unknown as DshAgent;
    const main = {
      sessionKey: key,
      sessionId: 'main',
      agent: mainAgent,
      handle: { agent: mainAgent, dispose: async () => {} },
      scope: 'group',
      peerId: 'G1',
      senderId: 'U1',
      lastActivity: Date.now(),
      replyTarget: { scope: 'group', targetId: 'G1', msgId: 'M1' },
    } as unknown as SessionRecord;

    const agents = {
      create: vi.fn(async (opts: { sessionId?: string; setup?: (s: unknown) => void }) => {
        await opts.setup?.({
          get: (n: string) => (n === 'tools' ? { restrict: () => {}, guard: () => {} } : { section: () => {}, suppressRuntimeContext: () => {} }),
        });
        const a = { ...mainAgent, id: opts.sessionId ?? 'child', session: { id: 'child', events: [] } } as unknown as DshAgent;
        return { agent: a, dispose: async () => {} };
      }),
    };
    const router = new DndCombatAgents(
      agents as never,
      service,
      () => ({ enabled: true, provider: 'p', model: 'm', reasoningEffort: '', contextChars: 4000 }),
      () => {},
      logger as never,
      undefined,
      undefined,
      () => 3, // 每 3 轮同步一次
    );
    const child = await router.select(main);

    // 第 1 轮：注入完整精简快照
    const t1 = router.decorateTurnText(child, '我砍第一刀');
    expect(t1).toContain(DndService.TURN_SNAPSHOT_HEADER);

    // 第 2、3 轮（距上次 1、2 轮 < 3）：子代理自身调用 dnd_* 工具产生的扣血不重复前置整份快照
    service.store.update(key, (c) => applyDamage(c, '巨鼠1', 2));
    service.recordAgentToolSync(key);
    expect(router.decorateTurnText(child, '我砍第二刀')).toBe('我砍第二刀');
    service.store.update(key, (c) => applyDamage(c, '巨鼠1', 1));
    service.recordAgentToolSync(key);
    expect(router.decorateTurnText(child, '结束回合')).toBe('结束回合');

    // 第 4 轮（满 3 轮间隔）：重新同步最新快照
    const t4 = router.decorateTurnText(child, '下一轮行动');
    expect(t4).toContain(DndService.TURN_SNAPSHOT_HEADER);

    // 紧接着下一轮若触发 dnd_undo（forceNextSnapshot）或外部改档，不等满 3 轮立即同步
    service.store.update(key, (c) => applyDamage(c, '卡厄斯', 3));
    service.forceNextSnapshot(key);
    const tForced = router.decorateTurnText(child, '重来');
    expect(tForced).toContain(DndService.TURN_SNAPSHOT_HEADER);
    expect(tForced).toContain('9/12');
    await router.dispose();
  });
});
