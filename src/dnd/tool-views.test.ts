import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { AdventureLibrary } from './adventure.ts';
import { CampaignStore, requireCharacter, upsertCharacter } from './campaign.ts';
import { DndService } from './dnd-service.ts';
import { registerDndTools } from './dnd-tools.ts';
import { DndToolScope, PAUSED_DND_TOOLS } from './tool-scope.ts';
import { type DndToolDefinition, type DndToolView } from './tool-views.ts';
import { pendingReactionReply } from '../gateway/middleware-setup.ts';

function table() {
  const root = mkdtempSync(join(tmpdir(), 'dnd-tool-views-'));
  const service = new DndService({ store: new CampaignStore(root), library: new AdventureLibrary(), mapDir: root, roller: () => 10 });
  const key = 'group:G';
  service.start(key, 'sunken-bell', false);
  service.store.update(key, (c) => { upsertCharacter(c, { name: '甲', playerId: 'P', maxHp: 20 }); });
  const logger = { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() };
  const full = new Map<string, DndToolDefinition>(), own = new Map<string, DndToolDefinition>();
  const masks: Array<readonly string[]> = [];
  const tools = {
    get: (name: string) => full.get(name),
    register: vi.fn((d: DndToolDefinition) => { if (own.has(d.name)) throw new Error('duplicate'); own.set(d.name, d); return () => own.delete(d.name); }),
    restrict: vi.fn(({ deny }: { deny: readonly string[] }) => { masks.push(deny); return () => masks.splice(masks.indexOf(deny), 1); }),
  };
  const record = { sessionKey: key, agent: { ctx: { get: () => tools } }, recentSenders: [{ id: 'P', at: Date.now() }] };
  registerDndTools({ get: () => ({ register: (d: DndToolDefinition) => full.set(d.name, d) }) } as never,
    { service, manager: { findByAgent: () => record } as never, logger, sendImage: vi.fn() });
  let view: DndToolView = 'narrative';
  const scope = new DndToolScope(service, [...full.keys()], logger, () => view);
  const visible = () => new Map([...full].filter(([n]) => masks.every((deny) => !deny.includes(n))).concat([...own]));
  const call = (name: string, args: object) => visible().get(name)!.execute(args, { agent: record.agent } as never);
  return { service, key, scope, record, tools, full, own, visible, call, set: (next: DndToolView) => { view = next; } };
}

describe('主 DM 的探索工具视图', () => {
  it('隐藏完整战场工具，攻击/回合专用参数不进入主 DM schema，保留探索反应窗口并区分未知参数报错', async () => {
    const t = table();
    t.scope.hideAll(t.record.agent);
    t.scope.sync(t.record);
    const visible = t.visible();
    expect(visible.has('dnd_position')).toBe(false);
    expect(visible.has('dnd_character')).toBe(true);
    expect(visible.has('dnd_move')).toBe(true);
    expect(visible.get('dnd_check')!.parameters.properties).not.toHaveProperty('on_hit');
    expect(visible.get('dnd_check')!.parameters.properties).not.toHaveProperty('attacks');
    expect(visible.get('dnd_check')!.parameters.properties).toHaveProperty('hold_for');
    expect(visible.get('dnd_apply')!.parameters.properties).toHaveProperty('reaction');
    expect(visible.get('dnd_apply')!.parameters.properties).toHaveProperty('settle');
    expect(visible.get('dnd_apply')!.parameters.properties).not.toHaveProperty('wake_by');
    expect(visible.get('dnd_initiative')!.parameters.properties.action).toEqual({ type: 'string', enum: ['start'] });
    expect(t.full.get('dnd_check')!.parameters.properties).toHaveProperty('on_hit');
    expect(t.full.get('dnd_check')!.parameters.properties).toHaveProperty('attacks');
    expect(t.full.get('dnd_apply')!.parameters.properties).toHaveProperty('wake_by');
    await expect(t.call('dnd_check', { character: '甲', type: 'attack', target: '甲' })).rejects.toThrow('主 DM');
    await expect(t.call('dnd_initiative', { action: 'next' })).rejects.toThrow('主 DM');
    await expect(t.call('dnd_apply', { target: '甲', wake_by: '甲' })).rejects.toThrow('主 DM');
    // 传不存在的参数名时明确报 schema 参数错误，而不是误报“主 DM 不能绕过战斗代理”
    await expect(t.call('dnd_apply', { target: '甲', heal: 2, reason: '药水' })).rejects.toThrow(/不认识的参数 reason/);
  });

  it('探索检定、群体陷阱豁免、战斗外反应窗口（hold_for）和治疗仍使用原处理器落到同一团档', async () => {
    const t = table();
    t.scope.sync(t.record);
    await t.call('dnd_check', { character: '甲', type: 'skill', skill: '察觉', dc: 10, declared_by: 'P' });
    await t.call('dnd_check', { character: '陷阱', type: 'save', ability: '敏捷', dc: 15, damage: '6', targets: [{ name: '甲' }] });
    expect(requireCharacter(t.service.store.load(t.key)!, '甲').hp).toBe(14);
    await t.call('dnd_apply', { target: '甲', heal: 2 });
    expect(requireCharacter(t.service.store.load(t.key)!, '甲').hp).toBe(16);

    // 探索期用 hold_for 挂起陷阱豁免：伤害先不扣，decline + settle 后落账
    const held = await t.call('dnd_check', {
      character: '陷阱',
      type: 'save',
      ability: '敏捷',
      dc: 15,
      damage: '4',
      targets: [{ name: '甲' }],
      hold_for: [{ by: '甲', name: '时间变幻' }],
    }) as { text: string };
    expect(held.text).toContain('还没落账');
    expect(t.service.store.load(t.key)!.pending).toBeDefined();
    expect(requireCharacter(t.service.store.load(t.key)!, '甲').hp).toBe(16);

    // 战斗外探索反应窗口同样能识别玩家群消息中的反应答复并授权
    const reply = pendingReactionReply(
      { kind: 'group', groupOpenid: 'G', senderId: 'P', messageId: 'M-exp-1', content: '不用时间变幻' } as never,
      { sessionKey: (s: string, id: string) => `${s}:${id}`, dndService: t.service },
      true,
    );
    expect(reply?.note).toContain('不用');

    const settled = await t.call('dnd_apply', { target: '甲', settle: true }) as { text: string };
    expect(settled.text).toContain('继续探索叙述');
    expect(t.service.store.load(t.key)!.pending).toBeUndefined();
    expect(requireCharacter(t.service.store.load(t.key)!, '甲').hp).toBe(12);
  });

  it('角色分工变化时撤掉旧覆盖，等待期间全藏，停团和关闭委派都能恢复正确工具', () => {
    const t = table();
    t.scope.sync(t.record);
    t.scope.sync(t.record);
    expect(t.tools.register).toHaveBeenCalledTimes(3);
    t.set('waiting'); t.scope.sync(t.record);
    expect(t.own.size).toBe(0);
    expect(t.visible().size).toBe(0);
    t.set('narrative'); t.scope.sync(t.record);
    expect(t.own.size).toBe(3);
    t.service.stop(t.key); t.scope.sync(t.record);
    expect([...t.visible().keys()].sort()).toEqual([...PAUSED_DND_TOOLS].sort());
    expect(t.own.size).toBe(0);
    t.service.start(t.key, 'sunken-bell', false);
    t.set('full'); t.scope.sync(t.record);
    expect(t.visible().get('dnd_check')).toBe(t.full.get('dnd_check'));
    expect(t.visible().has('dnd_position')).toBe(true);
  });

  it('安装覆盖失败时完整回退，不遗留半套 schema 或先全藏的限制；卸载也会清理覆盖', () => {
    const t = table();
    t.scope.hideAll(t.record.agent);
    const register = t.tools.register.getMockImplementation()!;
    t.tools.register.mockImplementation((d) => { if (d.name === 'dnd_apply') throw new Error('unsupported'); return register(d); });
    t.scope.sync(t.record);
    expect(t.own.size).toBe(0);
    expect(t.visible().size).toBe(t.full.size);
    const other = table();
    other.scope.sync(other.record);
    other.scope.disposeAll();
    expect(other.own.size).toBe(0);
    expect(other.visible().size).toBe(other.full.size);
  });

  it('探索版守则保留存档与查卡要求，把完整战斗步骤交给子级；完整守则仍可回退', () => {
    const t = table();
    const narrative = t.service.promptSections(t.key, undefined, true).find((s) => s.name === 'qqbot:dnd-dm')!.text;
    expect(narrative).toContain('【战斗委派】');
    expect(narrative).toContain('dnd_character show');
    expect(narrative).not.toContain('next 传他的 declared_by');
    const full = t.service.promptSections(t.key).find((s) => s.name === 'qqbot:dnd-dm')!.text;
    expect(full).toContain('next 传他的 declared_by');
    expect(t.service.combatInstructions()).toContain('next 传他的 declared_by');
  });
});
