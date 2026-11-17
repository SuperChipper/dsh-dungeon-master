import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { DshAgent, SessionRecord } from '../session/types.ts';
import { AdventureLibrary } from './adventure.ts';
import { buildBattleSvg, roomTokens } from './battle-image.ts';
import { battleGridLines, hiddenFromPlayers, mapOf } from './battlefield.ts';
import { CampaignStore, reactionsOf, requireCharacter, setResource, upsertCharacter } from './campaign.ts';
import { DndService } from './dnd-service.ts';
import { registerDndTools } from './dnd-tools.ts';
import { evalFormula, evalIntFormula, validateFormula } from './formula.ts';
import { mapCaption } from './map-view.ts';
import type { DndToolDefinition } from './tool-views.ts';
import { activeVisualAurasInRoom, zonesInRoom } from './zones.ts';

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
type Tool = DndToolDefinition & { execute(args: unknown, exec: { agent?: unknown; concludeTurn?: () => void }): Promise<{ text: string }> };

function createUpgradeHarness() {
  const rolls: number[] = [];
  const root = mkdtempSync(join(tmpdir(), 'dnd-upgrade-v07-'));
  const service = new DndService({
    store: new CampaignStore(join(root, 'campaigns')),
    library: new AdventureLibrary(),
    mapDir: root,
    roller: () => rolls.shift() ?? 10,
  });
  const key = 'qqbot:app-v07:group:TEST';
  service.start(key, 'sunken-bell', false);
  const startRoom = service.active(key)!.campaign.currentRoom;

  const agent = {
    status: 'idle',
    session: { header: { cwd: root }, events: [] },
    whenIdle: () => Promise.resolve(),
    followup: vi.fn(),
    cancel: vi.fn(),
    ctx: { get: () => undefined },
  } as unknown as DshAgent;

  const record: SessionRecord = {
    sessionKey: key,
    sessionId: 'main-v07',
    agent,
    handle: { agent, dispose: vi.fn().mockResolvedValue(undefined) } as never,
    replyTarget: { type: 'group', id: 'TEST', msgId: 'M1' } as never,
    createdAt: Date.now(),
    lastActivity: Date.now(),
    recentSenders: [
      { id: 'U1', at: Date.now() },
      { id: 'U2', at: Date.now() },
      { id: 'U3', at: Date.now() },
    ],
  } as unknown as SessionRecord;

  const tools = new Map<string, Tool>();
  const manager = {
    findByAgent: (a: DshAgent) => (a === agent ? record : undefined),
  };
  registerDndTools(
    { get: () => ({ register: (tool: Tool) => tools.set(tool.name, tool) }) } as never,
    { service, manager: manager as never, logger, sendImage: vi.fn() },
  );

  const call = (name: string, args: Record<string, unknown>) => tools.get(name)!.execute(args, { agent });
  return { service, key, startRoom, rolls, call, tools };
}

describe('v0.7 战斗升级全链路回归测试', () => {
  it('模块2：自动命中附伤（脆弱诅咒/狂暴/武器多段附伤/重击翻倍/防重复）、专注控制闭环、防护毒素与防错护栏', async () => {
    const h = createUpgradeHarness();
    h.service.store.update(h.key, (c) => {
      upsertCharacter(c, {
        name: '丛云',
        kind: 'pc',
        playerId: 'U1',
        className: '野蛮人 3 / 邪术师 3',
        level: 6,
        maxHp: 50,
        ac: 16,
        abilities: { str: 18, dex: 14, con: 14, int: 10, wis: 12, cha: 16 },
        weapons: [{
          name: '烈焰巨剑',
          damage: '2d6',
          ability: 'str',
          twoHanded: true,
          riders: [{ damage: '1d6', damageType: '火焰' }],
        }],
        notes: '原哨兵专长与游侠兼职已移除；无护盾术；保留吸收元素。',
      });
      setResource(c, '丛云', '1环法术位', 2, 'short');
      setResource(c, '丛云', '2环法术位', 2, 'short');
      setResource(c, '丛云', '狂暴', 3, 'long');

      upsertCharacter(c, {
        name: '食人魔',
        kind: 'monster',
        room: h.startRoom,
        maxHp: 120,
        ac: 11,
        abilities: { str: 19, dex: 8, con: 16, int: 5, wis: 7, cha: 7 },
      });
    });

    // 1. 反应推断排除否定句
    const cyInit = requireCharacter(h.service.store.load(h.key)!, '丛云');
    const inferredNames = reactionsOf(cyInit).map((r) => r.name);
    expect(inferredNames).not.toContain('哨兵');
    expect(inferredNames).not.toContain('护盾术');
    expect(inferredNames).toContain('吸收元素');

    // 开战：丛云先手
    h.rolls.push(18, 5);
    await h.call('dnd_initiative', { action: 'start' });
    await h.call('dnd_position', {
      action: 'set',
      placements: [{ name: '丛云', x: 2, y: 2 }, { name: '食人魔', x: 3, y: 2 }],
    });

    // 2. 施放附赠法术「脆弱诅咒」锁定食人魔，随后同回合用主动作施放环阶法术触发施法动作经济警告
    const hexRes = await h.call('dnd_resource', {
      action: 'use',
      character: '丛云',
      resource: '1环法术位',
      target: '食人魔',
      apply_state: '脆弱诅咒',
    });
    expect(hexRes.text).toContain('挂载状态「脆弱诅咒」（需专注');

    h.rolls.push(4); // 食人魔感知豁免 d20=4 -2 = 2 < DC 14 失败
    const holdRes = await h.call('dnd_check', {
      character: '丛云',
      type: 'save',
      ability: 'wis',
      dc: 14,
      targets: [{ name: '食人魔' }],
      on_fail_conditions: ['麻痹'],
      spend: '2环法术位',
      concentration: true,
      rounds: 10,
      declared_by: 'U1',
    });
    expect(holdRes.text).toContain('【施法动作经济警告】');
    // 新专注控制法术打断前一个脆弱诅咒，并将食人魔的「麻痹」绑定到丛云专注
    expect(holdRes.text).toContain('专注中断');
    const ogreAfterHold = requireCharacter(h.service.store.load(h.key)!, '食人魔');
    expect(ogreAfterHold.conditions).toContain('麻痹');
    expect(ogreAfterHold.activeStates?.find((s) => s.name === '麻痹')?.source).toBe('丛云');

    // 主动解除专注 → 食人魔身上的「麻痹」自动解除！
    const dropRes = await h.call('dnd_apply', { target: '丛云', drop_concentration: true });
    expect(dropRes.text).toContain('专注中断');
    expect(requireCharacter(h.service.store.load(h.key)!, '食人魔').conditions).not.toContain('麻痹');

    // 3. 下一轮测试脆弱诅咒 + 武器附伤 + 重击自动翻倍 + 防重复传入去重
    await h.call('dnd_initiative', { action: 'next', declared_by: 'U1' });
    await h.call('dnd_initiative', { action: 'next' });
    await h.call('dnd_resource', {
      action: 'use',
      character: '丛云',
      resource: '1环法术位',
      target: '食人魔',
      apply_state: '脆弱诅咒',
    });
    // d20=20 重击！主武器 4d6+4 -> [5,5,5,5]+4=24；烈焰巨剑附伤 2d6 -> [4,4]=8 火焰；脆弱诅咒 2d6 -> [3,3]=6 黯蚀 => 共 38 伤害
    h.rolls.push(20, 5, 5, 5, 5, 4, 4, 3, 3);
    const atkRes = await h.call('dnd_check', {
      character: '丛云',
      type: 'attack',
      target: '食人魔',
      weapon: '烈焰巨剑',
      damage_type: '挥砍',
      declared_by: 'U1',
    });
    expect(atkRes.text).toContain('重击！');
    expect(atkRes.text).toContain('附伤「烈焰巨剑」');
    expect(atkRes.text).toContain('附伤「脆弱诅咒」');
    expect(requireCharacter(h.service.store.load(h.key)!, '食人魔').hp).toBe(120 - 38);

    // 若模型仍自觉传入了 damage="1d6"，自动防重算跳过脆弱诅咒 1d6
    h.rolls.push(15, 4, 4, 3, 5); // d20=15 命中；2d6+4+1d6=[4,4]+4+[3]=15；武器附伤 1d6=[5]；脆弱诅咒被去重跳过！
    const dedupeRes = await h.call('dnd_check', {
      character: '丛云',
      type: 'attack',
      target: '食人魔',
      weapon: '烈焰巨剑',
      damage: '1d6',
      damage_type: '挥砍',
      declared_by: 'U1',
    });
    expect(dedupeRes.text).toContain('【防重算】');
    expect(requireCharacter(h.service.store.load(h.key)!, '食人魔').hp).toBe(120 - 38 - 20);

    // 4. 防护毒素：毒素抗性 + 对抗毒素优势，且非专注
    await h.call('dnd_apply', { target: '丛云', add_conditions: ['防护毒素'] });
    expect(requireCharacter(h.service.store.load(h.key)!, '丛云').activeStates?.find((s) => s.name === '防护毒素')?.concentration).toBeUndefined();
    h.rolls.push(3, 17); // 优势取 17
    const poisonSave = await h.call('dnd_check', {
      character: '食人魔',
      type: 'save',
      ability: 'con',
      dc: 14,
      damage: '16',
      damage_type: '毒素',
      targets: [{ name: '丛云' }],
      reaction: true,
    });
    expect(poisonSave.text).toContain('优势');
    // 16 点毒素：豁免成功减半为 8，再经防护毒素抗性减半为 4！
    expect(requireCharacter(h.service.store.load(h.key)!, '丛云').hp).toBe(46);

    // 5. dnd_apply 禁止同一目标同时传 damage 与 heal
    await expect(h.call('dnd_apply', { target: '丛云', damage: 5, heal: 5 })).rejects.toThrow('不能对同一目标');
  });

  it('模块3：圣武士守护灵光与牧师灵体卫士（升环、敌方减速、回合开始自动结算与每轮1次移动扫掠上限）', async () => {
    const h = createUpgradeHarness();
    h.service.store.update(h.key, (c) => {
      upsertCharacter(c, {
        name: 'Kriv',
        kind: 'pc',
        playerId: 'U1',
        className: '圣武士',
        level: 6,
        maxHp: 52,
        ac: 19,
        abilities: { str: 16, dex: 10, con: 14, int: 10, wis: 12, cha: 18 }, // cha_mod = +4
        traits: ['守护灵光'],
      });
      upsertCharacter(c, {
        name: '刻德温',
        kind: 'pc',
        playerId: 'U2',
        className: '牧师',
        level: 7,
        maxHp: 48,
        ac: 18,
        abilities: { str: 14, dex: 10, con: 14, int: 10, wis: 18, cha: 12 }, // spell save DC = 8+3+4 = 15
      });
      setResource(c, '刻德温', '4环法术位', 1, 'long');
      upsertCharacter(c, {
        name: '豺狼人1',
        kind: 'monster',
        room: h.startRoom,
        maxHp: 40,
        ac: 13,
        speed: 30,
        abilities: { str: 14, dex: 12, con: 12, int: 6, wis: 10, cha: 8 },
      });
    });

    h.rolls.push(15, 18, 5); // 角色顺序 [Kriv, 刻德温, 豺狼人1] -> 刻德温(18) > Kriv(15) > 豺狼人1(5)
    await h.call('dnd_initiative', { action: 'start' });
    await h.call('dnd_position', {
      action: 'terrain',
      width: 12,
      height: 12,
      areas: [],
    });
    await h.call('dnd_position', {
      action: 'set',
      placements: [
        { name: '刻德温', x: 5, y: 5 },
        { name: 'Kriv', x: 6, y: 5 }, // 距刻德温 5 尺（在 10 尺守护灵光内）
        { name: '豺狼人1', x: 9, y: 5 }, // 距刻德温 20 尺（先在灵体卫士 15 尺外）
      ],
    });

    // 1. 刻德温在 Kriv 10 尺内做敏捷豁免：自动享受守护灵光 +4
    h.rolls.push(10); // d20=10 + dex(0) + 守护灵光(+4) = 14 >= DC 14 成功！
    const saveInAura = await h.call('dnd_check', {
      character: '刻德温',
      type: 'save',
      ability: 'dex',
      dc: 14,
    });
    expect(saveInAura.text).toContain('守护灵光(Kriv)+4');
    expect(saveInAura.text).toContain('→ 成功');

    // 2. 刻德温用 4 环法术位开启「灵体卫士」（自动记录 4 环 4d8 与 DC 15）
    const sgRes = await h.call('dnd_resource', {
      action: 'use',
      character: '刻德温',
      resource: '4环法术位',
      apply_state: '灵体卫士',
    });
    expect(sgRes.text).toContain('4环施放·DC15');

    // 刻德温向东走 1 格到 (6,5) 旁边的 (7,5)，15 尺光环扫中 (9,5) 的豺狼人1！
    // 4d8 = [4,4,4,4]=16，豺狼人感知豁免 d20=8 +0 = 8 < 15 失败，受 16 光耀！
    h.rolls.push(4, 4, 4, 4, 8);
    const sweepMove = await h.call('dnd_position', {
      action: 'move',
      name: '刻德温',
      x: 7,
      y: 5,
      declared_by: 'U2',
    });
    expect(sweepMove.text).toContain('光环·灵体卫士');
    expect(requireCharacter(h.service.store.load(h.key)!, '豺狼人1').hp).toBe(24);

    // 同一回合刻德温再动一步 (7,5)->(7,6)，豺狼人1 本回合已被触发过，不会二段结算！
    const sweepAgain = await h.call('dnd_position', {
      action: 'move',
      name: '刻德温',
      x: 7,
      y: 6,
      declared_by: 'U2',
    });
    expect(sweepAgain.text).not.toContain('光环·灵体卫士');
    expect(requireCharacter(h.service.store.load(h.key)!, '豺狼人1').hp).toBe(24);

    // 推进到 Kriv，再推进到 豺狼人1：豺狼人1 在 15 尺灵体卫士内开始回合，自动触发回合开始豁免！
    await h.call('dnd_initiative', { action: 'next', declared_by: 'U2' });
    // 豺狼人1 回合开始：4d8=[3,3,3,3]=12，感知豁免 d20=17 >= 15 成功减半受 6 点！
    h.rolls.push(3, 3, 3, 3, 17);
    const gnollTurn = await h.call('dnd_initiative', { action: 'next', declared_by: 'U1' });
    expect(gnollTurn.text).toContain('回合切换自动结算');
    expect(gnollTurn.text).toContain('灵体卫士');
    expect(requireCharacter(h.service.store.load(h.key)!, '豺狼人1').hp).toBe(18);

    // 豺狼人1 在灵体卫士内移动 1 格（(9,5)->(8,5)）受减速光环影响耗费 10 尺移动力（双倍）
    const slowMove = await h.call('dnd_position', {
      action: 'move',
      name: '豺狼人1',
      x: 8,
      y: 5,
    });
    expect(slowMove.text).toContain('走 10 尺');
  });

  it('模块4：2.5D 飞行单位（高空同格悬停、越障、层高限制、垂直升空借机、高空坠机 vs 悬浮免疫）', async () => {
    const h = createUpgradeHarness();
    h.service.store.update(h.key, (c) => {
      upsertCharacter(c, {
        name: '战士',
        kind: 'pc',
        playerId: 'U1',
        level: 5,
        maxHp: 45,
        ac: 18,
        weapons: [{ name: '战戟', damage: '1d10', notes: '双手，触及' }], // 10 尺触及
      });
      upsertCharacter(c, {
        name: '青年绿龙',
        kind: 'monster',
        room: h.startRoom,
        maxHp: 136,
        ac: 18,
        speed: 40,
        flySpeed: 80,
      });
      upsertCharacter(c, {
        name: '眼魔',
        kind: 'monster',
        room: h.startRoom,
        maxHp: 90,
        ac: 18,
        speed: 0,
        flySpeed: 20,
        hover: true,
      });
    });

    h.rolls.push(6, 18, 12); // 角色顺序 [战士, 青年绿龙, 眼魔] -> 青年绿龙(18) > 眼魔(12) > 战士(6)
    await h.call('dnd_initiative', { action: 'start' });
    await h.call('dnd_position', {
      action: 'terrain',
      width: 10,
      height: 10,
      ceiling: 40,
      areas: [{ kind: 'object', x: 3, y: 2, w: 1, h: 3, name: '深渊裂谷' }],
    });
    await h.call('dnd_position', {
      action: 'set',
      placements: [
        { name: '战士', x: 2, y: 2 },
        { name: '青年绿龙', x: 2, y: 3 }, // 贴身地面 (z=0)
        { name: '眼魔', x: 6, y: 6, z: 20 },
      ],
    });

    // 1. 层高限制：超过 ceiling=40 报错
    await expect(h.call('dnd_position', { action: 'move', name: '青年绿龙', z: 45 })).rejects.toThrow('层高上限为 40 尺');

    // 2. 青年绿龙从地面垂直升空到 z=30：离开战士 10 尺战戟触及（在 z=10->15 时触发借机暂停！）
    const climbRes = await h.call('dnd_position', { action: 'move', name: '青年绿龙', x: 2, y: 3, z: 30 });
    expect(climbRes.text).toContain('【移动待结算】');
    expect(climbRes.text).toContain('战士·借机攻击');
    // 战士放弃借机后继续升空至 (2,3,↑30尺)，并可飞到战士头顶正上方 (2,2,↑30尺) 跨过裂谷而不撞人
    await h.call('dnd_apply', { target: '青年绿龙', decline: ['战士'], settle: true });
    const flyOver = await h.call('dnd_position', { action: 'move', name: '青年绿龙', x: 4, y: 2, z: 30 });
    expect(flyOver.text).toContain('↑30尺');

    // 3. 青年绿龙在高空 30 尺被击倒（倒地）→ 无悬浮，立即触发 3d6 钝击坠落伤害并落回 z=0！
    h.rolls.push(4, 5, 6); // 3d6 = 15 钝击
    await h.call('dnd_apply', { target: '青年绿龙', add_conditions: ['倒地'] });
    const dragonAfterCrash = requireCharacter(h.service.store.load(h.key)!, '青年绿龙');
    expect(dragonAfterCrash.hp).toBe(136 - 15);
    expect(h.service.store.load(h.key)!.initiative!.positions!['青年绿龙']!.z).toBeUndefined();

    // 4. 眼魔具备 hover: true，在高空 20 尺陷入倒地/麻痹不会坠机！
    await h.call('dnd_apply', { target: '眼魔', add_conditions: ['倒地', '束缚'] });
    expect(requireCharacter(h.service.store.load(h.key)!, '眼魔').hp).toBe(90);
    expect(h.service.store.load(h.key)!.initiative!.positions!['眼魔']!.z).toBe(20);
  });

  it('新需求A：战场持续区域（黑暗术遮蔽借机、毒雾/荆棘丛生联动 move 与回合轮数生命周期、SVG 与图例绘制、收场清场）', async () => {
    const h = createUpgradeHarness();
    h.service.store.update(h.key, (c) => {
      upsertCharacter(c, {
        name: '术士',
        kind: 'pc',
        playerId: 'U1',
        className: '术士',
        level: 5,
        maxHp: 38,
        ac: 15,
        abilities: { str: 8, dex: 14, con: 14, int: 12, wis: 10, cha: 18 }, // DC = 8+3+4 = 15
      });
      upsertCharacter(c, {
        name: '地精1',
        kind: 'monster',
        room: h.startRoom,
        maxHp: 30,
        ac: 13,
      });
    });

    h.rolls.push(18, 8); // 术士 > 地精1
    await h.call('dnd_initiative', { action: 'start' });
    await h.call('dnd_position', { action: 'terrain', width: 12, height: 12, areas: [] });
    await h.call('dnd_position', {
      action: 'set',
      placements: [{ name: '术士', x: 2, y: 2 }, { name: '地精1', x: 2, y: 3 }],
    });

    // 1. 放置「黑暗术」（专注）覆盖 (2,2) -> 术士在黑暗术内走开贴身的地精1，因视线重度遮蔽不触发地精借机！
    const darkZone = await h.call('dnd_position', {
      action: 'zone',
      name: '黑暗术',
      at: '术士',
      caster: '术士',
      rounds: 2,
    });
    expect(darkZone.text).toContain('黑暗术');
    const moveInDark = await h.call('dnd_position', {
      action: 'move',
      name: '术士',
      x: 2,
      y: 0,
      declared_by: 'U1',
    });
    expect(moveInDark.text).toContain('遮蔽视线');
    expect(moveInDark.text).not.toContain('【移动待结算】');

    // 2. 放置非专注「毒雾」（2 轮持续，2d6 毒素，DC 13 体质豁免减半）在 (5,5) 半径 10 尺
    await h.call('dnd_position', {
      action: 'zone',
      name: '毒雾',
      x: 5,
      y: 5,
      radius: 10,
      damage: '2d6',
      damage_type: '毒素',
      save_ability: 'con',
      save_dc: 13,
      rounds: 2,
      concentration: false,
    });

    // 验证 /dnd status 的 SVG、ASCII 示意图与图例均绘制出持续区域
    const loaded = h.service.active(h.key)!;
    const map = mapOf(loaded.campaign, h.startRoom)!;
    const svg = buildBattleSvg(
      map,
      roomTokens(loaded.campaign, h.startRoom, (ch) => !hiddenFromPlayers(ch)),
      '测试战场',
      false,
      [],
      zonesInRoom(loaded.campaign, h.startRoom),
      activeVisualAurasInRoom(loaded.campaign, h.startRoom),
    );
    expect(svg).toContain('黑暗术');
    expect(svg).toContain('毒雾');
    const caption = mapCaption(loaded.campaign, loaded.adventure, 'battle');
    expect(caption).toContain('🌀 区域：');
    expect(caption).toContain('黑暗术');
    expect(caption).toContain('毒雾');
    const asciiGrid = battleGridLines(loaded.campaign, (id) => id)?.join('\n') ?? '';
    expect(asciiGrid).toContain('*=黑暗术');

    // 3. 术士主动解除专注 → 黑暗术立即从地图消散，非专注毒雾保留
    await h.call('dnd_apply', { target: '术士', drop_concentration: true });
    expect(zonesInRoom(h.service.store.load(h.key)!, h.startRoom).map((z) => z.name)).toEqual(['毒雾']);

    // 4. 推进到地精1 回合，地精1 走入毒雾 (4,5) -> 立即触发进圈豁免扣血！
    await h.call('dnd_initiative', { action: 'next', declared_by: 'U1' });
    h.rolls.push(4, 4, 5); // 2d6=[4,4]=8，体质豁免 d20=5 < 13 失败，受 8 点毒素！
    const enterPoison = await h.call('dnd_position', { action: 'move', name: '地精1', x: 4, y: 5 });
    expect(enterPoison.text).toContain('区域·毒雾（踏入区域）');
    expect(requireCharacter(h.service.store.load(h.key)!, '地精1').hp).toBe(22);

    // 5. 推进轮次检验毒雾倒计时到期自动移除（初始 2 轮，每次回到无源区域轮头递减）
    await h.call('dnd_initiative', { action: 'next' }); // 进入第 2 轮 术士 -> 毒雾剩 1 轮
    expect(zonesInRoom(h.service.store.load(h.key)!, h.startRoom)[0]?.roundsLeft).toBe(1);
    h.rolls.push(3, 3, 15); // 地精1 第 2 轮在毒雾内回合开始：2d6=6，d20=15 成功减半受 3 点
    await h.call('dnd_initiative', { action: 'next', declared_by: 'U1' });
    expect(requireCharacter(h.service.store.load(h.key)!, '地精1').hp).toBe(19);
    const expireTurn = await h.call('dnd_initiative', { action: 'next' }); // 进入第 3 轮 -> 毒雾 2 轮到期消散！
    expect(expireTurn.text).toContain('战场区域「毒雾」持续时间结束');
    expect(zonesInRoom(h.service.store.load(h.key)!, h.startRoom)).toHaveLength(0);

    // 6. 再放一片荆棘丛生（每走 5 尺受 2d4 穿刺），测试 perStep 结算与 end 彻底清场
    await h.call('dnd_position', { action: 'zone', name: '荆棘丛生', x: 4, y: 5, caster: '术士' });
    await h.call('dnd_initiative', { action: 'next', declared_by: 'U1' });
    h.rolls.push(2, 3, 2, 3); // 区域内走 2 格 = 4d4 = 10 穿刺
    const spikeMove = await h.call('dnd_position', { action: 'move', name: '地精1', x: 4, y: 7, dash: true });
    expect(spikeMove.text).toContain('荆棘丛生');
    expect(requireCharacter(h.service.store.load(h.key)!, '地精1').hp).toBe(9);

    await h.call('dnd_initiative', { action: 'end' });
    expect(h.service.store.load(h.key)!.initiative).toBeUndefined();
  });

  it('模块5：dnd_rule 热注册扩展规则（风暴遗誓/段云）+ 安全公式求值 + 生命领域（生命门徒/神佑医者/保全生命）', async () => {
    const h = createUpgradeHarness();
    // 1. 公式解析器验证
    expect(() => validateFormula('process.exit(1)')).toThrow();
    expect(evalFormula('max(1, cha_mod) + floor(level / 2)', {
      level: 7, prof: 3, slot_level: 2,
      str_mod: 0, dex_mod: 2, con_mod: 2, int_mod: 0, wis_mod: 4, cha_mod: 3,
      str: 10, dex: 14, con: 14, int: 10, wis: 18, cha: 16, hp: 30, max_hp: 40,
    })).toBe(6);
    expect(evalIntFormula('2 + slot_level', {
      level: 6, prof: 3, slot_level: 3,
      str_mod: 0, dex_mod: 0, con_mod: 0, int_mod: 0, wis_mod: 4, cha_mod: 0,
      str: 10, dex: 10, con: 10, int: 10, wis: 18, cha: 10, hp: 20, max_hp: 40,
    })).toBe(5);

    // 2. 用 dnd_rule 热注册「风暴遗誓·二阶」（每回合首次命中 +1d8 闪电 + 闪电抗性）与「段云·雷鸣」（优势命中 +1d6 雷鸣）
    await h.call('dnd_rule', {
      action: 'define',
      scope: 'campaign',
      name: '风暴遗誓·二阶',
      defense_mod: { resistant: ['闪电'] },
      hit_rider: { damage_dice: '1d8', damage_type: '闪电', weapon_only: true, once_per_turn: true },
    });
    await h.call('dnd_rule', {
      action: 'define',
      scope: 'campaign',
      name: '段云·雷鸣',
      hit_rider: { damage_dice: '1d6', damage_type: '雷鸣', weapon_only: true, melee_only: true, advantage_only: true },
    });

    h.service.store.update(h.key, (c) => {
      upsertCharacter(c, {
        name: '剑客',
        kind: 'pc',
        playerId: 'U1',
        level: 6,
        maxHp: 44,
        hp: 10,
        ac: 17,
        abilities: { str: 10, dex: 18, con: 14, int: 10, wis: 12, cha: 14 },
        traits: ['风暴遗誓·二阶', '段云·雷鸣'],
        weapons: [{ name: '重锻太刀「段云」', damage: '1d8', ability: 'dex' }],
      });
      upsertCharacter(c, {
        name: '生命牧师',
        kind: 'pc',
        playerId: 'U2',
        className: '牧师（生命领域）',
        level: 6,
        maxHp: 46,
        hp: 30,
        ac: 18,
        abilities: { str: 14, dex: 10, con: 14, int: 10, wis: 18, cha: 12 },
        traits: ['生命门徒', '神佑医者'],
      });
      setResource(c, '生命牧师', '引导神力', 2, 'short');
      setResource(c, '生命牧师', '2环法术位', 2, 'long');
      upsertCharacter(c, {
        name: '木桩',
        kind: 'monster',
        room: h.startRoom,
        maxHp: 100,
        ac: 12,
      });
    });

    h.rolls.push(18, 14, 5); // 剑客 > 生命牧师 > 木桩
    await h.call('dnd_initiative', { action: 'start' });
    await h.call('dnd_position', {
      action: 'set',
      placements: [{ name: '剑客', x: 2, y: 2 }, { name: '生命牧师', x: 1, y: 2 }, { name: '木桩', x: 3, y: 2 }],
    });

    // 第一刀（优势）：同时触发风暴遗誓 1d8 闪电 + 段云 1d6 雷鸣！
    // d20=[12,16]->16；太刀 1d8+4=[5]+4=9；风暴遗誓 1d8=[6]；段云 1d6=[4] => 共 19 伤害
    h.rolls.push(12, 16, 5, 6, 4);
    const slash1 = await h.call('dnd_check', {
      character: '剑客',
      type: 'attack',
      target: '木桩',
      weapon: '重锻太刀「段云」',
      advantage: 'advantage',
      damage_type: '挥砍',
      declared_by: 'U1',
    });
    expect(slash1.text).toContain('附伤「风暴遗誓·二阶」');
    expect(slash1.text).toContain('附伤「段云·雷鸣」');
    expect(requireCharacter(h.service.store.load(h.key)!, '木桩').hp).toBe(81);

    // 同回合第二刀（无优势）：风暴遗誓 once_per_turn 已用过，段云无优势不触发 -> 纯太刀伤害 [5]+4=9！
    h.rolls.push(15, 5);
    const slash2 = await h.call('dnd_check', {
      character: '剑客',
      type: 'attack',
      target: '木桩',
      weapon: '重锻太刀「段云」',
      damage_type: '挥砍',
      declared_by: 'U1',
    });
    expect(slash2.text).not.toContain('风暴遗誓·二阶');
    expect(slash2.text).not.toContain('段云·雷鸣');
    expect(requireCharacter(h.service.store.load(h.key)!, '木桩').hp).toBe(72);

    // 闪电抗性生效：10 点闪电减半受 5 点（HP 10 -> 5）
    await h.call('dnd_apply', { target: '剑客', damage: 10, damage_type: '闪电' });
    expect(requireCharacter(h.service.store.load(h.key)!, '剑客').hp).toBe(5);

    // 3. 生命牧师回合：先用「保全生命」（5 * 6 = 30 池，受术者最多回至半血 22）
    await h.call('dnd_initiative', { action: 'next', declared_by: 'U1' });
    const plRes = await h.call('dnd_resource', {
      action: 'use',
      character: '生命牧师',
      resource: '引导神力',
      apply_state: '保全生命',
    });
    expect(plRes.text).toContain('30 点 HP');

    await h.call('dnd_apply', {
      caster: '生命牧师',
      preserve_life: true,
      targets: [{ name: '剑客', heal: 25 }],
    });
    // 剑客 maxHp=44，半血上限为 22（从 5 恢复到 22）
    expect(requireCharacter(h.service.store.load(h.key)!, '剑客').hp).toBe(22);

    // 再测试 2 环治疗法术：基础治疗 10 + 生命门徒(2+2=4) = 14（剑客 22->36），同时神佑医者使生命牧师自疗 4（30->34）！
    const lifeHeal = await h.call('dnd_apply', {
      target: '剑客',
      heal: 10,
      caster: '生命牧师',
      slot_level: 2,
    });
    expect(lifeHeal.text).toContain('生命门徒+4');
    expect(lifeHeal.text).toContain('【神佑医者】');
    expect(requireCharacter(h.service.store.load(h.key)!, '剑客').hp).toBe(36);
    expect(requireCharacter(h.service.store.load(h.key)!, '生命牧师').hp).toBe(34);
  });
});
