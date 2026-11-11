import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { dndCommand } from '../commands/dnd.ts';
import { AdventureLibrary } from './adventure.ts';
import { addSummary, campaignState, CampaignStore, playerStatus, pushLog, startInitiative, upsertCharacter } from './campaign.ts';
import { DndService } from './dnd-service.ts';
import { registerDndTools } from './dnd-tools.ts';
import { applyProgressPatch, parseProgress } from './progress-patch.ts';

type Tool = { name: string; execute(args: unknown, exec: { agent?: unknown }): Promise<{ text: string }> };
function setup() {
  const root = mkdtempSync(join(tmpdir(), 'dnd-recovery-'));
  const service = new DndService({ store: new CampaignStore(join(root, 'campaigns')), library: new AdventureLibrary(), mapDir: root });
  const key = 'group:G1';
  service.start(key, 'sunken-bell', false);
  service.store.update(key, (c) => {
    upsertCharacter(c, { name: '甲', maxHp: 20 });
    upsertCharacter(c, { name: '狼', kind: 'monster', maxHp: 11, room: c.currentRoom });
  });
  const tools = new Map<string, Tool>();
  const record = { sessionKey: key };
  const manager = { dndService: service, findByAgent: () => record, sessionKey: () => key };
  const sendImage = vi.fn();
  registerDndTools({ get: () => ({ register: (t: Tool) => tools.set(t.name, t) }) } as never, {
    service, manager: manager as never, sendImage,
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  });
  const command = dndCommand({ manager, config: {} } as never);
  const run = (raw: string) => command.handler({
    message: { kind: 'group', groupOpenid: 'G1', senderId: 'U1', messageId: 'M1' }, command: { raw },
  } as never);
  const call = async (name: string, args: object = {}) => (await tools.get(name)!.execute(args, { agent: {} })).text;
  return { service, key, call, run, sendImage };
}

describe('摘要保存与旧进度迁移', () => {
  it('1500 字旧兜底加新段时拒绝覆盖，不再返回成功并丢掉所有新内容', async () => {
    const { service, key, call } = setup();
    service.store.update(key, (c) => addSummary(c, '旧'.repeat(1500)));
    const before = service.store.load(key)!;
    await expect(call('dnd_progress', { set: { 位置: '河边营地', 待办: '盾卫留在石坡，回程再带回' } })).rejects.toThrow(/未保存.*旧进度保留/);
    expect(service.store.load(key)).toEqual(before);
    const patched = applyProgressPatch(before.summaries.at(-1)!.text, { set: { 位置: '河边营地' } });
    expect(parseProgress(patched.text)[0]!.name).toBe('旧进度');
    await call('dnd_progress', { set: { 旧进度: '', 位置: '河边营地', 待办: '盾卫留在石坡，回程再带回' } });
    const saved = service.store.load(key)!.summaries.at(-1)!;
    expect(saved.text).toContain('盾卫留在石坡');
    expect(saved.text).not.toContain('旧');
    expect(saved.room).toBe(before.currentRoom);
  });

  it('整份重写可用，空白和超长结团摘要不改变团档、签到或开团状态', async () => {
    const { service, key, call } = setup();
    await call('dnd_progress', { summary: '【位置】河边营地' });
    const before = service.store.load(key)!;
    service.checkIns.set(key, {} as never);
    await expect(call('dnd_end', { summary: '新'.repeat(1501) })).rejects.toThrow('未保存');
    await expect(call('dnd_end', { summary: ' ' })).rejects.toThrow('不能为空');
    expect(service.store.load(key)).toEqual(before);
    expect(service.checkIns.has(key)).toBe(true);
  });
});

describe('统一结团与续团', () => {
  it.each(['command', 'tool'])('%s 保留旧摘要和摘要后变化，重启后直接恢复整场战斗', async (entry) => {
    const { service, key, call, run } = setup();
    service.store.update(key, (c) => {
      startInitiative(c, () => 10);
      c.initiative!.round = 3;
      c.initiative!.turn = 1;
      c.initiative!.positions = { 甲: { room: c.currentRoom, x: 1, y: 2 }, 狼: { room: c.currentRoom, x: 1, y: 3 } };
      c.initiative!.reacted = ['甲'];
      c.initiative!.moved = { 狼: 10 };
      c.initiative!.dashed = ['狼'];
      c.initiative!.surprised = ['甲'];
      c.initiative!.pending = {
        kind: 'attack', seq: 7, at: 100, attacker: '狼', target: '甲', reactors: [{ character: '甲', reaction: '护盾术' }],
        declined: [], claimed: [], used: [], natural: 15, total: 19, rollDetail: 'd20=15+4=19', ac: 20, crit: false,
        attackMod: 0, acMod: 0, damageMod: 0,
      };
      addSummary(c, '【位置】河边营地\n【已定行动】不带盾卫\n【同行与留守】盾卫留在石坡\n【下次接续】先处理狼的攻击', 100);
    });
    service.store.update(key, (c) => {
      c.chronicle!.push({ id: 1, at: 101, kind: 'event', text: '俘虏已经获释' });
      pushLog(c, '甲决定释放俘虏');
    });
    const before = service.store.load(key)!;
    const result = entry === 'command' ? await run('end') : await call('dnd_end');
    expect(result).toContain('已暂停');
    const paused = service.store.load(key)!;
    expect(paused.active).toBe(false);
    expect(paused.initiative).toEqual(before.initiative);
    expect(paused.summaries).toEqual(before.summaries);
    expect(paused.handoff!.changes.join('\n')).toContain('俘虏已经获释');
    expect(service.stateSnapshot(key)).toBe('');

    const restarted = new DndService({ store: service.store, library: service.library, mapDir: service.mapDir });
    restarted.start(key, undefined, false);
    expect(restarted.require(key).campaign.initiative).toEqual(before.initiative);
    const background = restarted.promptSections(key, 'new-session').map((s) => s.text).join('\n');
    expect(background).toContain('不带盾卫');
    expect(background).toContain('俘虏已经获释');
    expect(background).toContain('不要重掷先攻');
    const snapshot = restarted.stateSnapshot(key);
    expect(snapshot).toContain('具体叙事位置（最近存档）：河边营地');
    expect(snapshot).toContain('已用反应：甲');
    expect(snapshot).toContain('本回合已移动：狼 10尺');
    expect(snapshot).toContain('待结算');
    restarted.store.update(key, (c) => { c.currentRoom = 'nave'; });
    expect(restarted.stateSnapshot(key)).not.toContain('具体叙事位置（最近存档）：河边营地');
  });

  it('玩家先 end，DM 可补写完整交接，重复暂停不会重开；命令同样校验摘要', async () => {
    const { service, key, call, run } = setup();
    const before = service.store.load(key)!;
    expect(await run(`end ${'新'.repeat(1501)}`)).toContain('未保存');
    expect(service.store.load(key)).toEqual(before);
    await run('end');
    await call('dnd_end', { summary: '【位置】河边营地\n【下次接续】等玩家选路' });
    expect(service.store.load(key)!.active).toBe(false);
    expect(service.store.load(key)!.summaries.at(-1)!.text).toContain('等玩家选路');
    const paused = service.store.load(key)!;
    await call('dnd_end');
    expect(service.store.load(key)).toEqual(paused);
    await expect(call('dnd_rest', { kind: 'long' })).rejects.toThrow('没有进行中的团');
  });

  it('早先摘要后只有资源或日志变化也会提示核对，无变化不伪造进展', async () => {
    const { service, key, call } = setup();
    await call('dnd_progress', { summary: '【位置】门口' });
    service.stop(key);
    expect(service.store.load(key)!.handoff!.needsReview).toBe(false);
    service.start(key, undefined, false);
    service.store.update(key, (c) => { c.characters[0]!.hp = 5; pushLog(c, '甲受伤'); });
    service.stop(key);
    expect(service.store.load(key)!.handoff!.needsReview).toBe(true);
    expect(service.store.load(key)!.handoff!.changes.join('\n')).toContain('甲受伤');
    expect(service.store.load(key)!.summaries.at(-1)!.text).toBe('【位置】门口');
  });
});

describe('DM 私有备团', () => {
  it('停团可读资料与模组、保存计划；不改剧情、不泄入玩家团况；续团后状态改变会提醒重核', async () => {
    const { service, key, call, run, sendImage } = setup();
    const endReply = await run('end');
    const before = service.store.load(key)!;
    expect(await call('dnd_prepare', { action: 'show' })).toContain('备团资料 · DM 私有');
    expect(await call('dnd_lookup', { kind: 'room' })).toBeTruthy();
    await call('dnd_prepare', { action: 'save', plan: '秘密候选：下场可能遇见渡鸦，先查模组，尚未发生。' });
    const saved = service.store.load(key)!;
    expect(campaignState(saved)).toBe(campaignState(before));
    expect(saved.active).toBe(false);
    expect(saved.summaries).toEqual(before.summaries);
    expect(saved.chronicle).toEqual(before.chronicle);
    expect(endReply).not.toContain('渡鸦');
    const shown = String(await call('dnd_prepare', { action: 'show' }));
    expect(shown).toContain('秘密候选');
    expect(shown).toContain('计划对应当前团况');
    service.start(key, undefined, false);
    const { campaign, adventure } = service.require(key);
    expect(playerStatus(campaign, adventure)).not.toContain('渡鸦');
    expect(service.promptSections(key).map((s) => s.text).join('\n')).toContain('备团计划 · DM 私有 · 尚未发生');
    const held = service.promptSections(key, 'same-epoch');
    expect(sendImage).not.toHaveBeenCalled();
    service.store.update(key, (c) => { c.characters[0]!.hp = 2; });
    expect(service.promptSections(key, 'same-epoch')).toEqual(held);
    expect(service.stateSnapshot(key)).toContain('备团计划对应的团况已变化');
    expect(await call('dnd_prepare', { action: 'show' })).toContain('计划需要重新核对');
    const current = service.store.load(key)!;
    await expect(call('dnd_prepare', { action: 'save', plan: '新'.repeat(2001) })).rejects.toThrow('未保存');
    expect(service.store.load(key)).toEqual(current);
    const other = 'group:G2';
    service.start(other, 'sunken-bell', false);
    expect(service.preparationContext(other)).not.toContain('秘密候选');
    await call('dnd_prepare', { action: 'clear' });
    expect(service.store.load(key)!.preparation).toBeUndefined();
  });
});
