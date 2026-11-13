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
  it('隐藏完整战场工具，攻击/反应/回合参数不进入主 DM schema，原始全局定义保留', async () => {
    const t = table();
    t.scope.hideAll(t.record.agent);
    t.scope.sync(t.record);
    const visible = t.visible();
    expect(visible.has('dnd_position')).toBe(false);
    expect(visible.has('dnd_character')).toBe(true);
    expect(visible.has('dnd_move')).toBe(true);
    expect(visible.get('dnd_check')!.parameters.properties).not.toHaveProperty('on_hit');
    expect(visible.get('dnd_check')!.parameters.properties).not.toHaveProperty('hold_for');
    expect(visible.get('dnd_apply')!.parameters.properties).not.toHaveProperty('reaction');
    expect(visible.get('dnd_initiative')!.parameters.properties.action).toEqual({ type: 'string', enum: ['start'] });
    expect(t.full.get('dnd_check')!.parameters.properties).toHaveProperty('on_hit');
    expect(t.full.get('dnd_apply')!.parameters.properties).toHaveProperty('reaction');
    await expect(t.call('dnd_check', { character: '甲', type: 'attack', target: '甲' })).rejects.toThrow('主 DM');
    await expect(t.call('dnd_initiative', { action: 'next' })).rejects.toThrow('主 DM');
    await expect(t.call('dnd_apply', { target: '甲', settle: true })).rejects.toThrow('主 DM');
  });

  it('探索检定、群体陷阱豁免和治疗仍使用原处理器落到同一团档', async () => {
    const t = table();
    t.scope.sync(t.record);
    await t.call('dnd_check', { character: '甲', type: 'skill', skill: '察觉', dc: 10, declared_by: 'P' });
    await t.call('dnd_check', { character: '陷阱', type: 'save', ability: '敏捷', dc: 15, damage: '6', targets: [{ name: '甲' }] });
    expect(requireCharacter(t.service.store.load(t.key)!, '甲').hp).toBe(14);
    await t.call('dnd_apply', { target: '甲', heal: 2 });
    expect(requireCharacter(t.service.store.load(t.key)!, '甲').hp).toBe(16);
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
