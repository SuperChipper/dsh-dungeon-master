/**
 * 战斗场地图：墙、门、门外、障碍、难行地形，以及按意图移动（to / keep_adjacent / away_from / 冲刺 / 拖人 / 撤离）。
 * 场景来自 c5a6a808 冶炼洞窟那一仗：门是半路补的、「退到门外」没处放、「贴着熊二往门口挪」被换算丢了条件。
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { AdventureLibrary, adventureFromDungeon } from './adventure.ts';
import { CampaignStore, createCampaign, findCharacter, startInitiative, upsertCharacter } from './campaign.ts';
import { SUNKEN_BELL } from './dungeons/sunken-bell.ts';
import { DndService } from './dnd-service.ts';
import { registerDndTools } from './dnd-tools.ts';
import { attackRangeNote, battleGridLines, battleLines, cellOf, moveOnGrid, moveResultText, setBattleMap, setPositions, turnPositionNote } from './battlefield.ts';
import { parseBattleMap } from './terrain.ts';

const BELL = adventureFromDungeon(SUNKEN_BELL);
const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };

/**
 * 10×6 的屋子，西边一道门通走廊：
 *   x=0..2 是墙，(2,2) 开门，(0..1,2) 是门外；屋内 x=3..8、y=1..4；
 *   石柱占 (5,1)-(5,3)，碎石 (6,4)-(7,4)。
 */
const ROOM_MAP = {
  width: 10,
  height: 6,
  areas: [
    { kind: 'wall', x: 0, y: 0, w: 10, h: 1 },
    { kind: 'wall', x: 0, y: 5, w: 10, h: 1 },
    { kind: 'wall', x: 0, y: 0, w: 3, h: 6 },
    { kind: 'wall', x: 9, y: 0, w: 1, h: 6 },
    { kind: 'outside', x: 0, y: 2, w: 2, h: 1, name: '门外(通B)', to: 'b-room' },
    { kind: 'door', x: 2, y: 2, name: '门(通B)', to: 'b-room' },
    { kind: 'object', x: 5, y: 1, h: 3, name: '石柱' },
    { kind: 'difficult', x: 6, y: 4, w: 2, name: '碎石' },
  ],
};

function arena() {
  const c = createCampaign('group:abc', BELL);
  upsertCharacter(c, { name: '刻德温', maxHp: 25, ac: 20 });
  upsertCharacter(c, { name: 'Kriv', maxHp: 20, ac: 16 });
  upsertCharacter(c, { name: '狼', kind: 'monster', maxHp: 18, room: c.currentRoom });
  startInitiative(c, () => 10);
  setBattleMap(c, c.currentRoom, ROOM_MAP);
  return c;
}

const cell = (c: ReturnType<typeof arena>, name: string) => {
  const at = cellOf(c, findCharacter(c, name)!)!;
  return { x: at.x, y: at.y };
};

describe('场地图校验', () => {
  it('越界、障碍没名字、门指向自己都直接报错', () => {
    expect(() => parseBattleMap({ width: 5, height: 5, areas: [{ kind: 'wall', x: 4, y: 0, w: 3 }] })).toThrow(/右边界/);
    expect(() => parseBattleMap({ width: 5, height: 5, areas: [{ kind: 'object', x: 1, y: 1 }] })).toThrow(/name/);
    expect(() => parseBattleMap({ width: 50, height: 5 })).toThrow(/width/);
    const c = arena();
    expect(() => setBattleMap(c, c.currentRoom, { width: 3, height: 3, areas: [{ kind: 'door', x: 0, y: 1, to: c.currentRoom }] })).toThrow(/房间自己/);
  });

  it('重画场地后，站在墙里的人会被点名', () => {
    const c = arena();
    setPositions(c, [{ name: 'Kriv', x: 4, y: 2 }]);
    const { misplaced } = setBattleMap(c, c.currentRoom, { width: 10, height: 6, areas: [{ kind: 'wall', x: 4, y: 0, h: 6 }] });
    expect(misplaced).toEqual(['Kriv(4,2)']);
  });
});

describe('摆位认地形', () => {
  it('不能摆进墙和障碍里', () => {
    const c = arena();
    expect(() => setPositions(c, [{ name: 'Kriv', x: 0, y: 0 }])).toThrow(/墙.*站不上去/);
    expect(() => setPositions(c, [{ name: 'Kriv', x: 5, y: 2 }])).toThrow(/石柱/);
  });

  it('near=门：从门那格往外一个个占空格，不用数格子', () => {
    const c = arena();
    setPositions(c, [{ name: '刻德温', near: '门(通B)' }, { name: 'Kriv', near: '门' }]);
    expect(cell(c, '刻德温')).toEqual({ x: 2, y: 2 });
    const kriv = cell(c, 'Kriv');
    expect(Math.max(Math.abs(kriv.x - 2), Math.abs(kriv.y - 2))).toBe(1);
    expect(() => setPositions(c, [{ name: '狼', near: '祭坛' }])).toThrow(/找不到「祭坛」.*石柱/);
  });
});

describe('按场地走', () => {
  it('绕着石柱走，尺数按实际路线算，终点在墙里报错', () => {
    const c = arena();
    setPositions(c, [{ name: 'Kriv', x: 4, y: 2 }]);
    const r = moveOnGrid(c, 'Kriv', { x: 6, y: 2 });
    expect(r.feet).toBe(20);
    expect(r.detour).toBe(true);
    expect(moveResultText(r)).toContain('绕开挡路的');
    expect(() => moveOnGrid(c, 'Kriv', { x: 9, y: 2 })).toThrow(/站不上去/);
  });

  it('难行地形每格算 10 尺，能绕开就绕开', () => {
    const c = arena();
    setPositions(c, [{ name: 'Kriv', x: 5, y: 4 }]);
    expect(moveOnGrid(c, 'Kriv', { x: 6, y: 4 }).feet).toBe(10);
    setPositions(c, [{ name: 'Kriv', x: 5, y: 4 }]);
    // 从上面一排斜下去只踩一格碎石
    expect(moveOnGrid(c, 'Kriv', { x: 7, y: 4 }).feet).toBe(15);
  });

  it('退到门外：to=门外，人还在站位上，落脚处说得出来', () => {
    const c = arena();
    setPositions(c, [{ name: 'Kriv', x: 4, y: 2 }]);
    const r = moveOnGrid(c, 'Kriv', { to: '门外' });
    expect(cell(c, 'Kriv')).toEqual({ x: 1, y: 2 });
    expect(r.feet).toBe(15);
    expect(moveResultText(r)).toContain('现在：站在门外(通B)');
    expect(turnPositionNote(c, 'Kriv')).toContain('（门外(通B)）');
  });

  it('「贴着狼往门口挪」：工具挑贴着狼、离门最近的格子，不会走开', () => {
    const c = arena();
    setPositions(c, [{ name: '狼', x: 4, y: 3 }, { name: 'Kriv', x: 5, y: 4 }]);
    const r = moveOnGrid(c, 'Kriv', { to: '门(通B)', keepAdjacent: '狼' });
    expect(cell(c, 'Kriv')).toEqual({ x: 3, y: 3 });
    expect(r.adjacent).toEqual(['狼']);
    expect(r.provokes).toEqual([]);
    expect(r.short).toMatch(/要贴着 狼/);
  });

  it('给了坐标又要求贴着，走开了就报错，不悄悄放过', () => {
    const c = arena();
    setPositions(c, [{ name: '狼', x: 4, y: 3 }, { name: 'Kriv', x: 5, y: 4 }]);
    expect(() => moveOnGrid(c, 'Kriv', { x: 7, y: 3, keepAdjacent: '狼' })).toThrow(/不贴着 狼/);
    expect(cell(c, 'Kriv')).toEqual({ x: 5, y: 4 });
  });

  it('to=某人：走到他身边；够不着就走到移动力用完并说明', () => {
    const c = arena();
    setPositions(c, [{ name: '狼', x: 8, y: 1 }, { name: 'Kriv', x: 1, y: 2 }]);
    const r = moveOnGrid(c, 'Kriv', { to: '狼', feet: 10 });
    expect(r.feet).toBe(10);
    expect(r.short).toMatch(/限 10 尺/);
    moveOnGrid(c, 'Kriv', { to: '狼' });
    expect(Math.max(Math.abs(cell(c, 'Kriv').x - 8), Math.abs(cell(c, 'Kriv').y - 1))).toBe(1);
  });

  it('away_from：在移动力内离得越远越好', () => {
    const c = arena();
    setPositions(c, [{ name: '狼', x: 3, y: 1 }, { name: 'Kriv', x: 4, y: 2 }]);
    moveOnGrid(c, 'Kriv', { awayFrom: '狼', feet: 15 });
    expect(cell(c, 'Kriv').y).toBe(4);
  });

  it('不能穿过敌人那一格，能穿过队友', () => {
    const c = arena();
    // 走廊一格宽：狼堵在门上就出不去
    setPositions(c, [{ name: '狼', x: 2, y: 2 }, { name: 'Kriv', x: 3, y: 2 }]);
    expect(() => moveOnGrid(c, 'Kriv', { x: 0, y: 2 })).toThrow(/堵死/);
    setPositions(c, [{ name: '狼', x: 8, y: 4 }, { name: '刻德温', x: 2, y: 2 }]);
    expect(moveOnGrid(c, 'Kriv', { x: 0, y: 2 }).feet).toBe(15);
  });
});

describe('冲刺、拖人、撤离', () => {
  it('移动力用完要冲刺；冲刺后这回合可用翻倍，不再报超速', () => {
    const c = arena();
    setPositions(c, [{ name: 'Kriv', x: 8, y: 4 }]);
    moveOnGrid(c, 'Kriv', { x: 8, y: 1 });
    moveOnGrid(c, 'Kriv', { x: 6, y: 1 });
    moveOnGrid(c, 'Kriv', { x: 6, y: 3 });
    expect(() => moveOnGrid(c, 'Kriv', { to: '门外' })).toThrow(/用完了.*dash=true/);
    const r = moveOnGrid(c, 'Kriv', { to: '门外', dash: true });
    expect(r.speed).toBe(60);
    expect(moveResultText(r)).toContain('（冲刺）');
    expect(moveResultText(r)).not.toContain('超过速度');
  });

  it('拖人：每格算双倍，被拖的人落在身后那格，不触发他自己的借机', () => {
    const c = arena();
    setPositions(c, [{ name: 'Kriv', x: 4, y: 2 }, { name: '刻德温', x: 4, y: 3 }]);
    const r = moveOnGrid(c, 'Kriv', { to: '门外', drag: '刻德温' });
    expect(r.feet).toBe(30);
    expect(cell(c, 'Kriv')).toEqual({ x: 1, y: 2 });
    expect(cell(c, '刻德温')).toEqual({ x: 2, y: 2 });
    expect(moveResultText(r)).toContain('拖着 刻德温');
    expect(() => moveOnGrid(c, 'Kriv', { x: 0, y: 2, drag: '狼' })).toThrow(/拖不了/);
  });

  it('撤离：离开触及也不报借机', () => {
    const c = arena();
    setPositions(c, [{ name: '狼', x: 4, y: 2 }, { name: 'Kriv', x: 4, y: 3 }]);
    expect(moveOnGrid(c, 'Kriv', { x: 7, y: 3 }).provokes).toEqual(['狼']);
    setPositions(c, [{ name: 'Kriv', x: 4, y: 3 }]);
    const r = moveOnGrid(c, 'Kriv', { x: 7, y: 3, disengage: true, reaction: true });
    expect(r.provokes).toEqual([]);
    expect(moveResultText(r)).toContain('撤离');
  });

  it('同样尺数时挑不吃借机的路线：直线擦过狼身边，工具绕外圈走', () => {
    const c = arena();
    setBattleMap(c, c.currentRoom, { width: 10, height: 10 });
    setPositions(c, [{ name: '狼', x: 5, y: 5 }, { name: 'Kriv', x: 4, y: 3 }]);
    const r = moveOnGrid(c, 'Kriv', { x: 4, y: 7 });
    expect(r.feet).toBe(20);
    expect(r.provokes).toEqual([]);
  });
});

describe('贴身挪位', () => {
  it('绕着狼从一边挪到另一边：全程在触及里，明说不吃借机', () => {
    const c = arena();
    setPositions(c, [{ name: '狼', x: 4, y: 3 }, { name: 'Kriv', x: 3, y: 2 }]);
    const r = moveOnGrid(c, 'Kriv', { x: 3, y: 4 });
    expect(r.provokes).toEqual([]);
    expect(r.stayedIn).toEqual(['狼']);
    expect(moveResultText(r)).toContain('贴着 狼 挪位，全程没离开触及，不触发借机');
  });

  it('被墙逼得绕出触及再回来，算离开过：照样报借机', () => {
    const c = arena();
    // 狼正上方、正下方是墙，从西边到东边只能从 y=1 或 y=5 绕，出了 5 尺
    setBattleMap(c, c.currentRoom, { width: 10, height: 10, areas: [{ kind: 'wall', x: 4, y: 2 }, { kind: 'wall', x: 4, y: 4 }] });
    setPositions(c, [{ name: '狼', x: 4, y: 3 }, { name: 'Kriv', x: 3, y: 3 }]);
    const r = moveOnGrid(c, 'Kriv', { x: 5, y: 3 });
    expect(r.feet).toBe(20);
    expect(r.provokes).toEqual(['狼']);
    expect(r.stayedIn).toEqual([]);
  });
});

describe('画出来', () => {
  it('墙、门、门外、难行地形、障碍物都画上，图例只列图里有的', () => {
    const c = arena();
    setPositions(c, [{ name: 'Kriv', x: 4, y: 2 }, { name: '狼', x: 7, y: 3 }]);
    const grid = battleGridLines(c, (id) => id)!;
    const text = grid.join('\n');
    expect(grid).toContain('  0  #  #  #  #  #  #  #  #  #  #');
    expect(grid).toContain('  2  :  :  +  .  K  a  .  .  .  #');
    expect(grid).toContain('  4  #  #  #  .  .  .  ~  ~  .  #');
    expect(text).toContain('K=Kriv　1=狼　a=石柱');
    expect(text).toContain('#=墙　:=门外(通B)　+=门(通B)　~=碎石');
    expect(text).not.toContain('=刻德温');
  });

  it('20 格宽的场地照样整张画：一格 2 个字符，列号拆成十位、个位两行', () => {
    const c = arena();
    setBattleMap(c, c.currentRoom, { width: 20, height: 4, areas: [{ kind: 'wall', x: 0, y: 0, w: 20 }, { kind: 'door', x: 12, y: 0, name: '门·通16' }] });
    setPositions(c, [{ name: 'Kriv', x: 2, y: 2 }, { name: '狼', x: 18, y: 3 }, { name: '门', x: 12, y: 0, mark: true }]);
    const grid = battleGridLines(c, (id) => id)!;
    expect(grid.slice(0, 4)).toEqual([
      '```',
      '                        1 1 1 1 1 1 1 1 1 1',
      '    0 1 2 3 4 5 6 7 8 9 0 1 2 3 4 5 6 7 8 9',
      '  0 # # # # # # # # # # # # + # # # # # # #',
    ]);
    // DM 又用 mark 标了一遍门：只画地形，不再叠一个字母
    const text = grid.join('\n');
    expect(text).not.toContain('=门　');
    expect(text).toContain('+=门·通16');
  });

  it('怪物名字末尾的数字就是图上的数字', () => {
    const c = arena();
    upsertCharacter(c, { name: '矮人丧尸7', kind: 'monster', maxHp: 22, room: c.currentRoom });
    setPositions(c, [{ name: 'Kriv', x: 4, y: 2 }, { name: '矮人丧尸7', x: 7, y: 3 }, { name: '狼', x: 8, y: 1 }]);
    const text = battleGridLines(c, (id) => id)!.join('\n');
    expect(text).toContain('7=矮人丧尸7');
    expect(text).toContain('1=狼');
  });

  it('团况给 DM 一行场地摘要（墙不列）', () => {
    const c = arena();
    setPositions(c, [{ name: 'Kriv', x: 4, y: 2 }]);
    const line = battleLines(c, (id) => id).find((l) => l.includes('场地'))!;
    expect(line).toContain('场地 10×6：门外(通B)(0-1,2-2)、门(通B)(2,2)、石柱(5-5,1-3)[挡路]、碎石(6-7,4-4)[难行]');
  });

  it('隔着障碍只提醒可能有掩护，不说看不见；隔着墙才说', () => {
    const c = arena();
    setPositions(c, [{ name: 'Kriv', x: 4, y: 2 }, { name: '狼', x: 6, y: 2 }]);
    const note = attackRangeNote(c, findCharacter(c, 'Kriv')!, findCharacter(c, '狼')!, {})!;
    expect(note).toContain('中间有石柱');
    expect(note).not.toContain('看不见');
  });
});

describe('工具：开战提示与 terrain', () => {
  function setup() {
    const root = mkdtempSync(join(tmpdir(), 'dnd-terrain-'));
    const service = new DndService({ store: new CampaignStore(join(root, 'campaigns')), library: new AdventureLibrary(), mapDir: root, roller: () => 10 });
    const key = 'group:G1';
    service.start(key, 'sunken-bell', false);
    service.store.update(key, (c) => {
      upsertCharacter(c, { name: 'Kriv', player: 'tty', playerId: 'P2', maxHp: 20, ac: 16 });
      upsertCharacter(c, { name: '狼', kind: 'monster', maxHp: 30, ac: 13, room: c.currentRoom });
    });
    const record = { sessionKey: key, scope: 'group', peerId: 'G1', replyTarget: { scope: 'group', targetId: 'G1' }, recentSenders: [{ id: 'P2', at: Date.now() }] };
    const manager = { sessionKey: (_s: string, gid: string) => `group:${gid}`, getSessionRecord: () => record, findByAgent: () => record, dndService: service };
    const tools = new Map<string, { name: string; execute(args: unknown, exec: { agent?: unknown }): Promise<{ text: string }> }>();
    const ctx = { get: () => ({ register: (d: { name: string; execute(args: unknown, exec: { agent?: unknown }): Promise<{ text: string }> }) => tools.set(d.name, d) }) };
    registerDndTools(ctx as never, { service, manager: manager as never, logger: logger as never, sendImage: vi.fn() });
    const call = async (name: string, args: Record<string, unknown>) => (await tools.get(name)!.execute(args, { agent: {} })).text;
    return { service, key, call };
  }

  it('没有场地图时开战先要画图；画完存进战役档，按从哪进来提示贴门摆位', async () => {
    const { service, key, call } = setup();
    const room = service.store.load(key)!.currentRoom;
    expect(await call('dnd_initiative', { action: 'start' })).toContain('这间还没有场地图：先 dnd_position terrain');
    const drawn = await call('dnd_position', { action: 'terrain', ...ROOM_MAP });
    expect(drawn).toContain('已存');
    expect(drawn).toContain('to 里的房间 id 不认识：b-room');
    expect(service.store.load(key)!.battlemaps?.[room]?.width).toBe(10);

    service.store.update(key, (c) => {
      delete c.initiative;
      c.enteredFrom = { [room]: 'b-room' };
    });
    expect(await call('dnd_initiative', { action: 'start' })).toContain('队伍是从「门(通B)」进来的：PC 用 set placements near="门(通B)"');
  });

  it('move 的意图参数走到工具里；move 给错参数组合会报错', async () => {
    const { service, key, call } = setup();
    await call('dnd_initiative', { action: 'start' });
    await call('dnd_position', { action: 'terrain', ...ROOM_MAP });
    await call('dnd_position', { action: 'set', placements: [{ name: 'Kriv', x: 4, y: 2 }, { name: '狼', x: 8, y: 4 }] });
    service.store.update(key, (c) => { c.initiative!.turn = c.initiative!.order.findIndex((e) => e.name === 'Kriv'); });
    expect(await call('dnd_position', { action: 'move', name: 'Kriv', to: '门外', declared_by: 'P2' })).toContain('站在门外(通B)');
    await expect(call('dnd_position', { action: 'move', name: 'Kriv', x: 3, y: 2, to: '狼', declared_by: 'P2' })).rejects.toThrow(/二选一/);
    const shown = await call('dnd_position', { action: 'show' });
    expect(shown).toContain('#=墙');
  });
});
