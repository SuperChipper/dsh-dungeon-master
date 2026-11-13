/** 战斗：dnd_initiative（先攻）、dnd_position（站位与场地图）。 */
import { roomGraph } from '../adventure.ts';
import {
assertCanAct,assertDeclaredByOwner,assertNoPending,
assertCanEndTurn,endInitiative,gotoTurn,fightRooms,
joinInitiative,nextTurn,skipSurprised,requireCharacter,
requireInitiative,startInitiative,spendReaction
} from '../campaign.ts';
import { findRoom,resolveRoom } from '../dungeon.ts';
import {
type AreaRequest,
type MoveRequest,
areaReport,battleGridLines,
battleLines,
distancesFrom,
hiddenFromPlayers,
removePosition,
setBattleMap,
setPositions,unplaced
} from '../battlefield.ts';
import { beginMovement } from '../movement.ts';
import { terrainLine } from '../terrain.ts';
import {
parsePlacements,
str,
int,
strList,
initiativeBonusArg,fightRoom,
battlemapHint,
positionNote,
orderLine,combatTurnPrompt,type ToolKit
} from './shared.ts';

export function registerCombatTools(kit: ToolKit): void {
  const { deps, service, recordOf, mutate, sendersOf, memberId, register } = kit;

  register(
    'dnd_initiative',
    'Combat rounds. start: roll initiative for everyone alive in the current room (or the given participants) and '
    + 'sort. Pass `surprised` with everyone caught off guard (the ambushed side, sleeping guards): the tool skips their '
    + 'round-1 turn by itself and they cannot react until it has passed, so never ask those players to click end turn. '
    + 'Before rolling, check every participant\'s sheet and table agreements. Fixed total initiative is saved with '
    + 'dnd_character init_bonus (otherwise Dexterity only); notes do not automatically apply class passives. '
    + 'Collect remaining active effects (灵敏之赐 +1d8, an unsaved fixed bonus) in `bonus` as {name: dice expression}. '
    + 'Never repeat a bonus already included in init_bonus or add it by hand afterwards. '
    + 'next: end the current creature\'s turn (on a PC turn only that player can end it: pass declared_by). '
    + 'join: add late arrivals (teammates who caught up, newly spawned monsters) to the running fight: rolls '
    + 'initiative only for `participants` and slots them in, keeping the round and everyone else\'s order; never '
    + 'end+start just to add someone. '
    + 'goto: fix the pointer when it disagrees with the story (name, optional round). end: leave combat and clear '
    + 'defeated monsters. status: show the order.',
    {
      action: { type: 'string', enum: ['start', 'join', 'next', 'goto', 'end', 'status'] },
      participants: { type: 'array', items: { type: 'string' }, description: 'Optional for start; required for join.' },
      room: { type: 'string', description: 'For start: room id where the fight happens (default: the party\'s main room).' },
      bonus: {
        type: 'object',
        additionalProperties: { type: 'string' },
        description: 'For start: initiative bonuses already in effect, {name: dice expression}, e.g. {"奇塔露":"1d8"} for 灵敏之赐 or {"卡厄斯":"5"}. Rolled into the total by the tool.',
      },
      surprised: { type: 'array', items: { type: 'string' }, description: 'For start: participants who are surprised; the tool skips their first turn.' },
      name: { type: 'string', description: 'For goto.' },
      round: { type: 'integer', description: 'For goto.' },
      declared_by: { type: 'string', description: 'For next on a PC turn: member id (the #U number in "[昵称 #U3]", pass "U3") of that PC\'s player, who said they are done.' },
      dm_override: { type: 'boolean', description: 'For next: skip an absent player\'s turn. Say so in the reply.' },
    },
    ['action'],
    (args, exec) => mutate(exec, (c, adventure) => {
      const action = String(args.action);
      // 指针落到 PC 时，本轮回复发完后给他发「结束回合」按钮
      const turnChanged = (): void => {
        if (deps.onTurnChange !== undefined) deps.onTurnChange(recordOf(exec));
      };
      if (action === 'start') {
        if (c.initiative !== undefined) throw new Error('已经在战斗中了，用 next 推进或 end 结束');
        const roomArg = str(args.room);
        const room = roomArg === undefined ? undefined : resolveRoom(roomGraph(adventure), roomArg)?.id;
        if (roomArg !== undefined && room === undefined) throw new Error(`没有这个房间: ${roomArg}`);
        const surprised = strList(args.surprised) ?? [];
        const rolls = startInitiative(c, service.roller, strList(args.participants), room, initiativeBonusArg(args.bonus), surprised);
        const { skipped } = skipSurprised(c);
        const state = requireInitiative(c);
        const surpriseNote = surprised.length === 0 ? ''
          : `\n【突袭】受惊的人第 1 轮整回合由工具跳过，跳过之前也不能反应：${surprised.join('、')}。不用叫他们点结束回合。`
            + (skipped.length > 0 ? `已跳过：${skipped.join('、')}。` : '');
        const away = positionNote(c, adventure, rolls.map((r) => r.name), new Set([room ?? c.currentRoom]));
        const field = battlemapHint(c, adventure, room ?? c.currentRoom);
        const delegated = deps.onCombatStart?.(recordOf(exec), field) === true;
        if (!delegated) turnChanged();
        const unused = Object.keys(initiativeBonusArg(args.bonus)).filter((n) => !rolls.some((r) => r.name === n));
        const warn = unused.length > 0 ? `\n【DM】bonus 里这几个名字不在参战者里，没算进去：${unused.join('、')}` : '';
        return `先攻：\n${rolls.map((r, i) => `${i + 1}. ${r.name} ${r.detail}`).join('\n')}\n${delegated ? '【战斗委派】回复只叙述开场并停下。回复结束后战斗代理自动接手场地图、摆位和当前回合；不要再用主 DM 结算攻击或 next。' : field}${surpriseNote}\n第 ${state.round} 轮，${delegated ? `当前 ${state.order[state.turn]!.name}` : combatTurnPrompt(c, state.order[state.turn]!.name, { recentSenders: sendersOf(exec) })}${away}${warn}`;
      }
      if (action === 'join') {
        const rooms = fightRooms(c);
        const rolls = joinInitiative(c, strList(args.participants) ?? [], service.roller);
        const state = requireInitiative(c);
        const current = state.order[state.turn]?.name;
        const away = positionNote(c, adventure, rolls.map((r) => r.name), rooms);
        return `加入战斗：${rolls.map((r) => `${r.name} ${r.detail}`).join('；')}\n第 ${state.round} 轮：${orderLine(c)}\n`
          + (current === undefined
            ? '调用 dnd_initiative next 轮到下一位。'
            : `仍是 ${current} 的回合；排在 ${current} 前面的新成员本轮已错过，下一轮才行动。`)
          + away
          + (unplaced(c).length > 0 ? `\n【站位】还没摆位：${unplaced(c).join('、')}，用 dnd_position set。` : '');
      }
      if (action === 'next') {
        assertCanEndTurn(c, { declaredBy: memberId(exec, args.declared_by, 'declared_by'), recentSenders: sendersOf(exec), dmOverride: args.dm_override === true });
        const { round, current, newRound, skipped } = nextTurn(c);
        turnChanged();
        const skippedNote = skipped.length > 0 ? `受惊跳过：${skipped.join('、')}（这一回合什么都做不了，回复里一句带过）。\n` : '';
        // 新一轮把顺序带上，DM 照着列给玩家，不用守则里再交代
        return `${skippedNote}${newRound ? `进入第 ${round} 轮（回复里把这一轮的顺序列一遍）：${orderLine(c)}\n` : ''}${combatTurnPrompt(c, current.name, { recentSenders: sendersOf(exec) })}`;
      }
      if (action === 'goto') {
        const entry = gotoTurn(c, String(args.name ?? ''), int(args.round));
        turnChanged();
        return `已调整：第 ${requireInitiative(c).round} 轮，${combatTurnPrompt(c, entry.name, { recentSenders: sendersOf(exec), force: true })}`;
      }
      if (action === 'end') {
        assertNoPending(c, '结束战斗');
        const { rounds, defeated } = endInitiative(c);
        // 专用子级在工具落账后直接交回主 DM，省掉一次收尾模型请求。
        if (kit.manager.combatAgents?.isChild(recordOf(exec).agent)) exec.concludeTurn?.();
        return `战斗结束，共 ${rounds} 轮。${defeated.length > 0 ? `击败：${defeated.join('、')}` : ''}`;
      }
      const graph = roomGraph(adventure);
      return [`第 ${requireInitiative(c).round} 轮：${orderLine(c)}`, ...battleLines(c, (id) => findRoom(graph, id)?.name ?? id)].join('\n');
    }),
  );

  register(
    'dnd_position',
    'Battlefield positions inside a room during combat; one cell is 5 ft, x grows east, y grows south, diagonals cost 5 ft. '
    + 'The stored grid is the only source for distance, adjacency and opportunity attacks; never rule on those from memory. '
    + 'terrain: draw the room\'s battle map once (walls, doors, the corridor outside each door, obstacles, difficult '
    + 'ground); it is kept for the room and reused next time. Moves then route around walls and enemies, and the '
    + 'players\' map shows the scene. '
    + 'set: place combatants at the start of a fight, when someone joins or enters the room, for forced movement (shove, '
    + 'teleport: no movement cost, no opportunity attack); `near` places someone next to a door, landmark or creature '
    + 'without counting cells. mark=true places a landmark or an uncarded creature (captive). '
    + 'move: one creature moves on its own turn. Prefer intent over coordinates: `to` a creature (ends adjacent), a '
    + 'door, the corridor outside, an obstacle; `away_from` a creature; `feet` caps the distance; `keep_adjacent` '
    + 'when the player says to stay next to someone; dash / drag / disengage as declared. Use x/y only when the '
    + 'player named a cell. Movement pauses at an opportunity-attack trigger BEFORE the remaining route is applied; '
    + 'ask the listed players, resolve dnd_check attack reaction=true (spends their reaction), then dnd_apply target=mover settle=true. '
    + 'Never bypass this with set; set is only for initial placement, correction or actual forced movement. '
    + 'area: before an area spell or breath (fireball, hypnotic pattern, lightning bolt), list who the '
    + 'shape covers so the placement is checked on the grid instead of guessed; tell the players honestly if an ally is in it. '
    + 'show: everyone\'s positions; with `from`, distances from that creature. remove: drop a mark '
    + 'or placement (never remove someone who just stepped outside: move them `to` the corridor outside).',
    {
      action: { type: 'string', enum: ['terrain', 'set', 'move', 'area', 'show', 'remove'] },
      shape: {
        type: 'string',
        enum: ['sphere', 'cube', 'line'],
        description: 'For area: sphere = radius around a point (fireball 20); cube = x/y is the north-west corner (hypnotic pattern 30); '
          + 'line = from the caster toward x/y or `at` (lightning bolt 100, breath 30). Cones are not computed.',
      },
      size: { type: 'integer', description: 'For area: radius / side / length in feet.' },
      at: { type: 'string', description: 'For area: centre (sphere) or direction (line) on this creature or mark instead of x/y.' },
      caster: { type: 'string', description: 'For area: who casts it; sorts the covered into foes and allies, and is the start of a line.' },
      room: { type: 'string', description: 'For terrain: room id (default: the room of the fight / the party).' },
      width: { type: 'integer', description: 'For terrain: map width in cells, including walls and corridor cells (max 40).' },
      height: { type: 'integer', description: 'For terrain: map height in cells (max 40).' },
      areas: {
        type: 'array',
        description: 'For terrain: rectangles; later ones override earlier ones (draw a wall, then cut a door into it). '
          + 'Cells not covered are open floor. Replaces the whole map of that room.',
        items: {
          type: 'object',
          properties: {
            kind: {
              type: 'string',
              enum: ['wall', 'object', 'difficult', 'door', 'outside'],
              description: 'wall/object block movement; difficult costs double (rubble, a dry channel); door is a walkable '
                + 'opening; outside is the corridor or room beyond a door (people there still count for distance).',
            },
            x: { type: 'integer' },
            y: { type: 'integer' },
            w: { type: 'integer', description: 'Width in cells (default 1).' },
            h: { type: 'integer', description: 'Height in cells (default 1).' },
            name: { type: 'string', description: 'Required for object (熔炉, 石柱); useful for door/outside ("门(通11)", "门外(通11)").' },
            to: { type: 'string', description: 'For door/outside: the room id it leads to.' },
          },
          required: ['kind', 'x', 'y'],
          additionalProperties: false,
        },
      },
      placements: {
        type: 'array',
        description: 'For set.',
        items: {
          type: 'object',
          properties: {
            name: { type: 'string' },
            x: { type: 'integer' },
            y: { type: 'integer' },
            near: { type: 'string', description: 'Instead of x/y: nearest free cell to this door / landmark / creature, in list order.' },
            mark: { type: 'boolean', description: 'Not a character sheet: landmark or uncarded captive (needs x/y).' },
          },
          required: ['name'],
          additionalProperties: false,
        },
      },
      name: { type: 'string', description: 'For move / remove: who.' },
      x: { type: 'integer', description: 'For move: destination cell, only when the player named one.' },
      y: { type: 'integer', description: 'For move: destination cell.' },
      to: { type: 'string', description: 'For move: a creature (ends adjacent), a door, the corridor outside, an obstacle or a landmark, by name.' },
      adjacent_to: { type: 'string', description: 'For move: same as `to` with a creature.' },
      away_from: { type: 'string', description: 'For move: get as far from this creature as the movement allows (or `feet`).' },
      feet: { type: 'integer', description: 'For move with to/away_from: walk at most this many feet ("往门口挪 10 尺").' },
      keep_adjacent: { type: 'string', description: 'For move: the mover must still be next to this creature afterwards.' },
      dash: { type: 'boolean', description: 'For move: the mover took the Dash action; movement doubles for this turn.' },
      drag: { type: 'string', description: 'For move: drag this adjacent creature along (costs double, ends right behind).' },
      disengage: { type: 'boolean', description: 'For move: the mover took Disengage; no opportunity attacks.' },
      from: { type: 'string', description: 'For show: list distances from this creature.' },
      declared_by: { type: 'string', description: 'For move of a PC: member id of the player who declared it (the #U number, pass "U3").' },
      reaction: { type: 'boolean', description: 'For move: movement off-turn (a reaction, a feature); not counted against this turn\'s speed.' },
      use_reaction: { type: 'boolean', description: 'For move: this feature actually spends the mover\'s reaction (e.g. a readied move). Records 0/1 until their next turn. Off-turn movement alone need not cost a reaction.' },
      dm_override: { type: 'boolean', description: 'For move: a player explicitly delegated this PC\'s move. Say so in the reply.' },
    },
    ['action'],
    (args, exec) => mutate(exec, (c, adventure) => {
      const action = String(args.action);
      const graph = roomGraph(adventure);
      const roomName = (id: string): string => findRoom(graph, id)?.name ?? id;
      if (action === 'terrain') {
        const roomArg = str(args.room);
        const room = roomArg === undefined ? fightRoom(c) : resolveRoom(graph, roomArg)?.id;
        if (room === undefined) throw new Error(`没有这个房间: ${roomArg}`);
        const { map, misplaced } = setBattleMap(c, room, { width: args.width, height: args.height, areas: args.areas });
        const unknown = map.areas.filter((a) => a.to !== undefined && findRoom(graph, a.to) === undefined).map((a) => a.to);
        const lines = [`已存 ${roomName(room)} 的场地图（再进这间沿用）。${terrainLine(map)}`];
        if (unknown.length > 0) lines.push(`【DM】to 里的房间 id 不认识：${unknown.join('、')}，用 dnd_lookup 查准再画一次。`);
        if (misplaced.length > 0) lines.push(`【DM】这些人现在站在墙里或障碍上：${misplaced.join('、')}，用 set 挪出来。`);
        const grid = c.initiative === undefined ? undefined : battleGridLines(c, roomName);
        if (grid !== undefined) lines.push('', ...grid);
        return lines.join('\n');
      }
      if (action === 'area') {
        const shape = str(args.shape);
        if (shape !== 'sphere' && shape !== 'cube' && shape !== 'line') throw new Error('area 要给 shape：sphere / cube / line');
        const size = int(args.size);
        if (size === undefined) throw new Error('area 要给 size（尺）');
        const request: AreaRequest = { shape, size };
        const at = str(args.at);
        const caster = str(args.caster);
        const x = int(args.x);
        const y = int(args.y);
        if (at !== undefined) request.at = at;
        if (caster !== undefined) request.caster = caster;
        if (x !== undefined) request.x = x;
        if (y !== undefined) request.y = y;
        return areaReport(c, request);
      }
      if (action === 'set') {
        assertNoPending(c, '重新摆位');
        const notes = setPositions(c, parsePlacements(args.placements));
        return [...battleLines(c, roomName), ...notes].join('\n');
      }
      if (action === 'move') {
        const ch = requireCharacter(c, String(args.name ?? ''));
        assertNoPending(c, '移动');
        if (args.dm_override === true && str(args.declared_by) === undefined) {
          throw new Error('dnd_position: dm_override 还要给 declared_by（委托的玩家编号，如 U4），并在回复里写明是谁委托的');
        }
        assertCanAct(c, ch, {
          declaredBy: memberId(exec, args.declared_by, 'declared_by'),
          reaction: args.reaction === true,
          dmOverride: args.dm_override === true,
          recentSenders: sendersOf(exec),
        });
        if (args.reaction === true) requireInitiative(c).rebrief = true;
        if (args.use_reaction === true) {
          assertDeclaredByOwner(ch, { declaredBy: memberId(exec, args.declared_by, 'declared_by'), recentSenders: sendersOf(exec) }, '反应移动');
          spendReaction(c, ch.name);
        }
        const request: MoveRequest = { reaction: args.reaction === true };
        const text = (key: keyof MoveRequest, value: unknown): void => {
          const v = str(value);
          if (v !== undefined) (request as Record<string, unknown>)[key] = v;
        };
        text('adjacentTo', args.adjacent_to);
        text('to', args.to);
        text('awayFrom', args.away_from);
        text('keepAdjacent', args.keep_adjacent);
        text('drag', args.drag);
        const x = int(args.x);
        const y = int(args.y);
        const feet = int(args.feet);
        if (x !== undefined) request.x = x;
        if (y !== undefined) request.y = y;
        if (feet !== undefined) request.feet = feet;
        if (args.dash === true) request.dash = true;
        if (args.disengage === true) request.disengage = true;
        const result = beginMovement(c, ch.name, request);
        if (c.initiative?.movement !== undefined) deps.onPendingAttack?.(recordOf(exec));
        return result;
      }
      if (action === 'remove') {
        assertNoPending(c, '删除站位');
        return removePosition(c, String(args.name ?? ''));
      }
      if (action !== 'show') throw new Error(`dnd_position: 未知 action ${action}`);
      requireInitiative(c);
      const lines = battleLines(c, roomName);
      const from = str(args.from);
      if (from !== undefined) lines.push(distancesFrom(c, from));
      if (lines.length === 0) return '还没有人摆位，用 dnd_position set。';
      // 玩家要看图时原样贴这段：手画的坐标轴会错位、漏行，藏起来的怪也容易顺手画进去
      const grid = battleGridLines(c, roomName, (ch) => !hiddenFromPlayers(ch));
      if (grid !== undefined) lines.push('', '玩家视角示意图（要在回复里画就原样贴下面这段，含 ``` 那两行；藏起来的怪已去掉）：', ...grid);
      return lines.join('\n');
    }),
  );
}
