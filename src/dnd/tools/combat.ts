/** 战斗：dnd_initiative（先攻）、dnd_position（站位与场地图）。 */
import { roomGraph } from '../adventure.ts';
import {
type PendingSpell,
assertCanAct,assertDeclaredByOwner,assertNoPending,
assertCanEndTurn,effectiveControllerId,endInitiative,findCharacter,gotoTurn,fightRooms,
joinInitiative,isDmDelegated,nextTurn,skipSurprised,requireCharacter,
requireInitiative,startInitiative,spendReaction,useResource
} from '../campaign.ts';
import { combatParticipantCard } from '../combat-context.ts';
import { assertTurnActionAllowed, ensureTurnState, hasCondition, recordTurnSpellCast } from '../conditions.ts';
import { settleOngoingSaves } from '../save-effect.ts';
import { findRoom,resolveRoom } from '../dungeon.ts';
import {
type AreaRequest,
type MoveRequest,
areaReport,battleGridLines,
battleLines,
cellOf,
clearBattleMap,
distancesFrom,
hiddenFromPlayers,
mapOf,
removeBattleZone,
removePosition,
setBattleMap,
setPositions,unplaced,upsertBattleZone
} from '../battlefield.ts';
import { beginMovement } from '../movement.ts';
import { eligibleSpellReactors, holdNotice, hostileSpellcasterHints } from '../pending-attack.ts';
import { terrainLine } from '../terrain.ts';
import { type BattleZoneInput, formatZoneSummary, inferSpellSaveDc, type ZoneTrigger } from '../zones.ts';
import {
SECRET_NOTE,
parseFormationInput,
parsePlacements,
str,
int,
strList,
initiativeBonusArg,fightRoom,
battlemapHint,
positionNote,
orderLine,combatTurnPrompt,combatLedgerSuffix,type Exec,type ToolKit
} from './shared.ts';

export function registerCombatTools(kit: ToolKit): void {
  const { deps, service, recordOf, mutate, rollId, sendersOf, memberId, register } = kit;

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
        description: 'For start or join: initiative bonuses already in effect, {name: dice expression}, e.g. {"奇塔露":"1d8"} for 灵敏之赐 or {"卡厄斯":"5"}. Rolled into the total by the tool.',
      },
      surprised: { type: 'array', items: { type: 'string' }, description: 'For start: participants who are surprised; the tool skips their first turn.' },
      rehearsal: {
        type: 'boolean',
        description: 'For start: dream/illusion/sparring rehearsal fight. Snapshots party HP/resources/conditions, room battlemap and module state before combat, suppresses permanent chronicle/story triggers during the fight, and automatically restores everything and removes temporary_monsters on action=end.',
      },
      rehearsal_hp: {
        type: 'object',
        additionalProperties: { type: 'integer' },
        description: 'For start or join when rehearsal=true: temporary starting HP inside the rehearsal/dream, e.g. {"丛云": 49}, restored to pre-rehearsal values when combat ends.',
      },
      temporary_monsters: {
        type: 'array',
        items: { type: 'string' },
        description: 'For start or join when rehearsal=true: improvised dream/sparring monster names to auto-remove when the rehearsal ends.',
      },
      keep_changes: {
        type: 'boolean',
        description: 'For end on a rehearsal fight: keep HP/resource/map changes instead of restoring the pre-rehearsal snapshot (default false).',
      },
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
        const rehearsalHp: Record<string, number> = {};
        if (args.rehearsal_hp !== null && typeof args.rehearsal_hp === 'object' && !Array.isArray(args.rehearsal_hp)) {
          for (const [k, v] of Object.entries(args.rehearsal_hp as Record<string, unknown>)) {
            const hp = int(v);
            if (k.trim() && hp !== undefined && hp > 0) rehearsalHp[k.trim()] = hp;
          }
        }
        const tempMonsters = strList(args.temporary_monsters);
        const rolls = startInitiative(c, service.roller, strList(args.participants), room, initiativeBonusArg(args.bonus), surprised, {
          rehearsal: args.rehearsal === true,
          ...(Object.keys(rehearsalHp).length > 0 ? { rehearsalHp } : {}),
          ...(tempMonsters !== undefined ? { temporaryMonsters: tempMonsters } : {}),
        });
        const { skipped } = skipSurprised(c);
        const state = requireInitiative(c);
        const effects = skipped.flatMap((actor) => [
          ...settleOngoingSaves(c, actor, 'target_turn_start', service.roller, service.globalEffects(), 1),
          ...settleOngoingSaves(c, actor, 'target_turn_end', service.roller, service.globalEffects(), 1),
        ]);
        effects.push(...settleOngoingSaves(c, state.order[state.turn]?.name, 'target_turn_start', service.roller, service.globalEffects()));
        const effectsNote = effects.length === 0 ? '' : `\n【开战状态结算】\n${effects.join('\n')}`;
        const rehearsalNote = state.rehearsal ? '\n【演练模式】已保存演练前快照；演练期间的地形、伤害与消耗在 dnd_initiative end 时自动恢复，不污染真实地图与账本。' : '';
        const surpriseNote = surprised.length === 0 ? ''
          : `\n【突袭】受惊的人第 1 轮整回合由工具跳过，跳过之前也不能反应：${surprised.join('、')}。不用叫他们点结束回合。`
            + (skipped.length > 0 ? `已跳过：${skipped.join('、')}。` : '');
        const away = positionNote(c, adventure, rolls.map((r) => r.name), new Set([room ?? c.currentRoom]));
        const field = battlemapHint(c, adventure, room ?? c.currentRoom);
        const delegated = deps.onCombatStart?.(recordOf(exec), field) === true;
        if (!delegated) turnChanged();
        const unused = Object.keys(initiativeBonusArg(args.bonus)).filter((n) => !rolls.some((r) => r.name === n));
        const warn = unused.length > 0 ? `\n【DM】bonus 里这几个名字不在参战者里，没算进去：${unused.join('、')}` : '';
        return `先攻：\n${rolls.map((r, i) => `${i + 1}. ${r.name} ${r.detail}`).join('\n')}\n${delegated ? '【战斗委派】回复只叙述开场并停下。回复结束后战斗代理自动接手场地图、摆位和当前回合；不要再用主 DM 结算攻击或 next。' : field}${rehearsalNote}${surpriseNote}${effectsNote}\n第 ${state.round} 轮，${delegated ? `当前 ${state.order[state.turn]!.name}` : combatTurnPrompt(c, state.order[state.turn]!.name, { recentSenders: sendersOf(exec), globalEffects: service.globalEffects() })}${away}${warn}`;
      }
      if (action === 'join') {
        assertNoPending(c, '加入战斗');
        const rooms = fightRooms(c);
        const bonusMap = initiativeBonusArg(args.bonus);
        const rehearsalHp: Record<string, number> = {};
        if (args.rehearsal_hp !== null && typeof args.rehearsal_hp === 'object' && !Array.isArray(args.rehearsal_hp)) {
          for (const [k, v] of Object.entries(args.rehearsal_hp as Record<string, unknown>)) {
            const hp = int(v);
            if (k.trim() && hp !== undefined && hp > 0) rehearsalHp[k.trim()] = hp;
          }
        }
        const tempMonsters = strList(args.temporary_monsters);
        const rolls = joinInitiative(c, strList(args.participants) ?? [], service.roller, bonusMap, {
          ...(Object.keys(rehearsalHp).length > 0 ? { rehearsalHp } : {}),
          ...(tempMonsters !== undefined ? { temporaryMonsters: tempMonsters } : {}),
        });
        const state = requireInitiative(c);
        const current = state.order[state.turn]?.name;
        const away = positionNote(c, adventure, rolls.map((r) => r.name), rooms);
        const unused = Object.keys(bonusMap).filter((n) => !rolls.some((r) => r.name === n));
        const warn = unused.length > 0 ? `\n【DM】bonus 里这几个名字不在本次加入名单里，没算进去：${unused.join('、')}` : '';
        const joinedSet = new Set(rolls.map((r) => r.name));
        const thisRoundNames = state.order.slice(state.turn + 1).filter((e) => joinedSet.has(e.name)).map((e) => e.name);
        const nextRoundNames = state.order.slice(0, state.turn).filter((e) => joinedSet.has(e.name)).map((e) => e.name);
        const turnTiming = current === undefined
          ? '调用 dnd_initiative next 轮到下一位。'
          : [
            `仍是 ${current} 的回合。`,
            ...(thisRoundNames.length > 0 ? [`排在 ${current} 后面的 ${thisRoundNames.join('、')} 本轮稍后就能行动；`] : []),
            ...(nextRoundNames.length > 0 ? [`排在 ${current} 前面的 ${nextRoundNames.join('、')} 本轮已错过顺位，下一轮才轮到主动回合（但从现在起已可正常触发反应与借机）。`] : []),
          ].join('');
        const joinedAllies = rolls
          .map((r) => findCharacter(c, r.name))
          .filter((ch): ch is NonNullable<typeof ch> => ch !== undefined && ch.kind !== 'monster');
        const hydratedCards = joinedAllies.length > 0
          ? `\n【新入战我方能力卡（开战快照曾精简，以此完整卡为准）】\n${JSON.stringify(joinedAllies.map((ch) => combatParticipantCard(c, ch)))}`
          : '';
        return `加入战斗：${rolls.map((r) => `${r.name} ${r.detail}`).join('；')}\n第 ${state.round} 轮：${orderLine(c)}\n`
          + turnTiming
          + away
          + (unplaced(c).length > 0 ? `\n【站位】还没摆位：${unplaced(c).join('、')}，用 dnd_position set。` : '')
          + warn
          + hydratedCards;
      }
      if (action === 'next') {
        assertCanEndTurn(c, { declaredBy: memberId(exec, args.declared_by, 'declared_by'), recentSenders: sendersOf(exec), dmOverride: args.dm_override === true });
        const { round, current, newRound, skipped, expired, hazardNotes } = nextTurn(c, service.roller, service.globalEffects());
        turnChanged();
        const skippedNote = skipped.length > 0 ? `受惊跳过：${skipped.join('、')}（这一回合什么都做不了，回复里一句带过）。\n` : '';
        const expiredNote = expired.length > 0 ? `【状态/区域到期】${expired.join('；')}\n` : '';
        const hazardBlock = hazardNotes.length > 0 ? `【回合切换自动结算（回复里照实播报掷骰过程）】\n${hazardNotes.map((h) => `- ${h}`).join('\n')}\n` : '';
        // 新一轮把顺序带上，DM 照着列给玩家，不用守则里再交代
        return `${skippedNote}${expiredNote}${hazardBlock}${newRound ? `进入第 ${round} 轮（回复里把这一轮的顺序列一遍）：${orderLine(c)}\n` : ''}${combatTurnPrompt(c, current.name, { recentSenders: sendersOf(exec), globalEffects: service.globalEffects() })}`;
      }
      if (action === 'goto') {
        const entry = gotoTurn(c, String(args.name ?? ''), int(args.round));
        turnChanged();
        return `已调整：第 ${requireInitiative(c).round} 轮，${combatTurnPrompt(c, entry.name, { recentSenders: sendersOf(exec), force: true, globalEffects: service.globalEffects() })}`;
      }
      if (action === 'end') {
        assertNoPending(c, '结束战斗');
        const isChild = kit.manager.combatAgents?.isChild(recordOf(exec).agent) === true;
        const { rounds, defeated, restored } = endInitiative(c, { keepChanges: args.keep_changes === true });
        const parts = [`战斗结束，共 ${rounds} 轮。`];
        if (defeated.length > 0) parts.push(`击败：${defeated.join('、')}。`);
        if (c.lastCombat && c.lastCombat.survivingMonsters.length > 0) {
          parts.push(`仍存活敌方：${c.lastCombat.survivingMonsters.map((m) => m.name).join('、')}。`);
        }
        if (restored) {
          parts.push('【演练还原】已自动恢复演练前的角色状态、资源与房间场地图，并清理演练临时怪物。');
        }
        if (isChild) {
          parts.push('\n【收尾播报】请在本条回复中将刚才最后一轮的检定明细、最后一击与战斗收场过程完整播报给群内玩家（播报完战斗收尾即停，勿推进战后搜刮或新探索；你的回复发出后系统会自动交回主 DM 接续剧情）。');
        }
        return parts.join('');
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
    + 'set: place combatants at the start of a fight, when someone joins or enters the room, or for forced movement (shove, '
    + 'teleport: no movement cost, no opportunity attack). For fast opening setup, pass `formation` ({ entry?, front:[...], mid:[...], back:[...], auto_rest?, enemies? }) '
    + 'together with enemy `placements` (x/y or `near`) — the engine automatically arranges front/mid/back ranks facing the enemies around walls & doors without manual coordinate math! '
    + 'Set formation.spacing to compact / normal / spread for a 5 / 10 / 15 ft preferred gap; enemies.spacing is independent. For a single correction use set with name and x/y or near. '
    + '`near` places someone next to a door, landmark or creature without counting cells; `rank` ("front"/"mid"/"back") on a placement item also auto-ranks it; mark=true places a landmark or an uncarded creature (captive). '
    + 'move / swap: one creature moves on its own turn (or swaps cells with a consenting ally via swap="队友名" or action="swap"). Prefer intent over coordinates: `to` a creature (ends adjacent), a '
    + 'door, the corridor outside, an obstacle; `away_from` a creature; `swap` an ally (approaches an adjacent free cell if >5 ft away, then swaps cells once the ally\'s player consents — pass `ally_declared_by` if the ally\'s player already agreed in chat, otherwise the tool pauses and opens a 0-reaction consent button window); `feet` caps the distance; `keep_adjacent` '
    + 'when the player says to stay next to someone; dash / drag / disengage as declared. Moves automatically detour around damaging/restraining zones & hostile auras (火墙术, 荆棘丛生, 蛛网术, 毒雾, 灵体卫士) when reachable within available speed, and emit a split-move (拆分移动) reminder whenever passing through a domain/zone; pass `enter_hazards=true` only when the creature intentionally charges straight through a hazard. NEVER eyeball coordinates to claim someone cannot reach or bypass a zone — always call `move` (`to="目标"`) and let the pathfinder check! Use x/y only when the '
    + 'player named a cell. Movement pauses at an opportunity-attack trigger BEFORE the remaining route is applied; '
    + 'ask the listed players, resolve dnd_check attack reaction=true (spends their reaction), then dnd_apply target=mover settle=true. '
    + 'Never bypass this with set; set is only for initial placement, correction or actual forced movement. '
    + 'area: before an area spell or breath (fireball, hypnotic pattern, lightning bolt), list who the '
    + 'shape covers so the placement is checked on the grid instead of guessed; tell the players honestly if an ally is in it. '
    + 'show: everyone\'s positions; with `from`, distances from that creature. Use dnd_map for an image; text_grid=true requests a character grid only when needed. remove: drop a mark '
    + 'or placement (never remove someone who just stepped outside: move them `to` the corridor outside). '
    + 'zone / remove_zone: place or clear persistent battlefield zones (黑暗术, 毒雾, 云雾术, 蛛网术, 荆棘丛生, 月华之光, 火墙术 or custom ground hazards); pass `spend` (e.g. "4环法术位") to spend the spell slot atomically; rendered on /dnd status map, integrated with move/nextTurn saves & obscurement, and auto-cleared on round expiry, concentration break or combat end. '
    + 'clear_terrain: clear an improvised/temporary arena map for the room, restoring the module\'s authored map if one exists.',
    {
      action: { type: 'string', enum: ['terrain', 'clear_terrain', 'set', 'move', 'swap', 'area', 'zone', 'remove_zone', 'show', 'remove'] },
      shape: {
        type: 'string',
        enum: ['sphere', 'cube', 'line', 'rect'],
        description: 'For area (sphere/cube/line) or zone (sphere/rect): sphere = radius around x/y or `at`; cube/rect = north-west corner x/y.',
      },
      size: { type: 'integer', description: 'For area: radius / side / length in feet.' },
      at: { type: 'string', description: 'For area or zone: centre on this creature or mark instead of x/y.' },
      caster: { type: 'string', description: 'For area or zone: who casts/creates it; binds concentration and spell save DC automatically.' },
      room: { type: 'string', description: 'For terrain / zone: room id (default: the room of the fight / the party).' },
      width: { type: 'integer', description: 'For terrain: map width in cells, including walls and corridor cells (max 40).' },
      height: { type: 'integer', description: 'For terrain: map height in cells (max 40).' },
      ceiling: { type: 'integer', description: 'For terrain: optional room ceiling height in feet (multiple of 5, e.g. 20 or 40); caps flying altitude z.' },
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
        description: 'For set: explicit placements (e.g. enemies by x/y or `near`, landmarks with mark=true, or individual rank="front"/"mid"/"back"). Can be combined with `formation` in one call.',
        items: {
          type: 'object',
          properties: {
            name: { type: 'string' },
            x: { type: 'integer' },
            y: { type: 'integer' },
            z: { type: 'integer', description: 'Altitude in feet (multiple of 5, default 0 ground).' },
            near: { type: 'string', description: 'Instead of x/y: use a nearby free cell. With rank, use this door, landmark or creature as the entry anchor for this group.' },
            rank: { type: 'string', enum: ['front', 'mid', 'back', '前排', '中排', '后排'], description: 'Instead of x/y: auto-place in front / mid / back rank relative to opposing forces.' },
            mark: { type: 'boolean', description: 'Not a character sheet: landmark or uncarded captive (needs x/y).' },
          },
          required: ['name'],
          additionalProperties: false,
        },
      },
      formation: {
        type: 'object',
        description: 'For set: automatic rank-priority formation! Pass party `front` / `mid` / `back` character lists (plus optional `entry` door/landmark or x/y, `auto_rest:true`, and optional `enemies` rank lists) alongside enemy `placements`. Automatically arranges frontline closest to enemies and backline safely behind without manual coordinate counting.',
        properties: {
          entry: { type: 'string', description: 'Optional party entry door / landmark name (auto-inferred from room entrance if omitted).' },
          x: { type: 'integer', description: 'Optional party anchor x cell.' },
          y: { type: 'integer', description: 'Optional party anchor y cell.' },
          spacing: { type: 'string', enum: ['compact', 'normal', 'spread'], description: 'Preferred allied spacing: compact 5 ft, normal 10 ft (default), spread 15 ft. Tight rooms may force a smaller gap.' },
          front: { type: 'array', items: { type: 'string' }, description: 'Frontline party members (e.g. fighters, paladins, barbarians).' },
          mid: { type: 'array', items: { type: 'string' }, description: 'Midline party members (e.g. bards, clerics, rogues, monks).' },
          back: { type: 'array', items: { type: 'string' }, description: 'Backline party members (e.g. wizards, sorcerers, warlocks, archers).' },
          auto_rest: { type: 'boolean', description: 'If true, any unplaced participating allies in the room omitted from front/mid/back are auto-assigned a default rank by class/weapons.' },
          enemies: {
            type: 'object',
            description: 'Optional enemy formation by rank (alternatively pass enemy coordinates or `near` in `placements`).',
            properties: {
              entry: { type: 'string', description: 'Optional enemy anchor landmark / door name.' },
              x: { type: 'integer' },
              y: { type: 'integer' },
              spacing: { type: 'string', enum: ['compact', 'normal', 'spread'], description: 'Preferred enemy spacing: compact 5 ft, normal 10 ft (default), spread 15 ft.' },
              front: { type: 'array', items: { type: 'string' } },
              mid: { type: 'array', items: { type: 'string' } },
              back: { type: 'array', items: { type: 'string' } },
            },
            additionalProperties: false,
          },
        },
        additionalProperties: false,
      },
      name: { type: 'string', description: 'For move / remove: creature or mark name. For zone / remove_zone: zone name (e.g. "黑暗术", "毒雾", "蛛网术", "荆棘丛生", "月华之光").' },
      x: { type: 'integer', description: 'For set / move / area / zone: grid x cell.' },
      y: { type: 'integer', description: 'For set / move / area / zone: grid y cell.' },
      near: { type: 'string', description: 'For single-creature set with name: use a nearby free cell by this door, landmark or creature instead of x/y.' },
      z: { type: 'integer', description: 'For move: target flying altitude in feet (multiple of 5, e.g. 15 or 30; 0 to land).' },
      radius: { type: 'integer', description: 'For zone (sphere): radius in feet (multiple of 5, e.g. 15 for 黑暗术, 20 for 毒雾/云雾术).' },
      w: { type: 'integer', description: 'For zone (rect): width in 5-ft cells.' },
      h: { type: 'integer', description: 'For zone (rect): height in 5-ft cells.' },
      zone_height: { type: 'integer', description: 'For zone: vertical height in feet (creatures flying higher than this are unaffected).' },
      obscured: { type: 'string', enum: ['light', 'heavy', 'darkness'], description: 'For zone: obscurement level (darkness/heavy blocks sight-based opportunity attacks).' },
      difficult: { type: 'boolean', description: 'For zone: true if entering cells costs double movement.' },
      damage: { type: 'string', description: 'For zone: hazard damage dice expression, e.g. "2d4" or "5d8".' },
      damage_type: { type: 'string', description: 'For zone: hazard damage type, e.g. "毒素", "火焰", "光耀", "穿刺".' },
      save_ability: { type: 'string', description: 'For zone: saving throw ability, e.g. "体质", "敏捷", "感知".' },
      save_dc: { type: 'integer', description: 'For zone: saving throw DC (auto-inferred from `caster` if omitted).' },
      on_save: { type: 'string', enum: ['half', 'none'], description: 'For zone: damage taken on successful save (default half).' },
      on_fail_conditions: { type: 'array', items: { type: 'string' }, description: 'For zone: conditions applied on failed save (e.g. ["束缚"]).' },
      triggers: { type: 'array', items: { type: 'string', enum: ['enter', 'turn_start', 'turn_end'] }, description: 'For zone: hazard trigger timings (default ["enter", "turn_start"]).' },
      per_step: { type: 'boolean', description: 'For zone: true to deal damage for every 5 ft moved inside the zone (e.g. 荆棘丛生).' },
      rounds: { type: 'integer', description: 'For zone: duration in rounds (auto-ticks and clears on expiry or combat end).' },
      concentration: { type: 'boolean', description: 'For zone: bind to `caster`\'s concentration.' },
      spend: { type: 'string', description: 'For zone: optional resource key to spend atomically when casting this zone spell (e.g. "4环法术位").' },
      is_spell: { type: 'boolean', description: 'For zone: set false for non-spell environmental zones so Counterspell does not trigger.' },
      spell_level: { type: 'integer', description: 'For zone: optional spell level (1-9) used for Counterspell checks.' },
      target_side: { type: 'string', enum: ['all', 'enemies', 'allies'], description: 'For zone: which side is affected (default "all").' },
      to: { type: 'string', description: 'For move: a creature (ends adjacent), a door, the corridor outside, an obstacle or a landmark, by name. For action="swap": alias for `swap`.' },
      adjacent_to: { type: 'string', description: 'For move: same as `to` with a creature.' },
      away_from: { type: 'string', description: 'For move: get as far from this creature as the movement allows (or `feet`).' },
      swap: { type: 'string', description: 'For move / swap: friendly creature name to swap positions with (approaches if >5 ft away, checks movement cost & opportunity attacks, and requires teammate consent without spending their reaction).' },
      feet: { type: 'integer', description: 'For move with to/away_from: walk at most this many feet ("往门口挪 10 尺").' },
      keep_adjacent: { type: 'string', description: 'For move: the mover must still be next to this creature afterwards.' },
      dash: { type: 'boolean', description: 'For move: the mover took the Dash action; movement doubles for this turn.' },
      drag: { type: 'string', description: 'For move: drag this adjacent creature along (costs double, ends right behind).' },
      disengage: { type: 'boolean', description: 'For move: the mover took Disengage; no opportunity attacks.' },
      crawl: { type: 'boolean', description: 'For move while 倒地 (prone): crawl along the ground (costs double movement, keeps 倒地) instead of automatically spending half speed to stand up first.' },
      enter_hazards: { type: 'boolean', description: 'For move: allow taking a direct path straight through damaging/restraining zones or hostile auras instead of automatically detouring around them within available movement.' },
      ignore_state_mods: { type: 'boolean', description: 'For move: bypass automatic condition restrictions (speed=0, prone auto-stand, fear source block) when a special feature/immunity overrides standard 5e rules.' },
      from: { type: 'string', description: 'For show: list distances from this creature.' },
      text_grid: { type: 'boolean', description: 'For show: include a player-visible character grid when an image cannot be sent or players request a text map.' },
      declared_by: { type: 'string', description: 'For move / swap of a PC: member id of the player who declared it (the #U number, pass "U3").' },
      ally_declared_by: { type: 'string', description: 'For move with `swap` (or action="swap") when swapping with another player\'s PC: member id (#U) of that teammate\'s player IF they already explicitly agreed to swap in recent chat. Omit to pause and open an interactive swap-consent button window.' },
      ally_dm_override: { type: 'boolean', description: 'For swap: true ONLY when the swapped teammate\'s player explicitly delegated control of their PC (must also pass `ally_declared_by` of the delegating player).' },
      reaction: { type: 'boolean', description: 'For move: movement off-turn (a reaction, a feature); not counted against this turn\'s speed.' },
      use_reaction: { type: 'boolean', description: 'For move: this feature actually spends the mover\'s reaction (e.g. a readied move). Records 0/1 until their next turn. Off-turn movement alone need not cost a reaction.' },
      dm_override: { type: 'boolean', description: 'For move: a player explicitly delegated this PC\'s move. Say so in the reply.' },
    },
    ['action'],
    async (args, exec) => {
      const action = String(args.action);
      const text = position(action, args, exec);
      if (action !== 'set' && action !== 'terrain' || deps.onBattlePlacement === undefined) return text;
      try {
        return await deps.onBattlePlacement(recordOf(exec)) ? `${text}\n开战图片已发给玩家。` : text;
      } catch (err) {
        deps.logger.warn(`im-qqbot: 开战图发送失败: ${String(err)}`);
        return text;
      }
    },
  );

  function position(action: string, args: Record<string, unknown>, exec: Exec): string {
    return mutate(exec, (c, adventure) => {
      const graph = roomGraph(adventure);
      const roomName = (id: string): string => findRoom(graph, id)?.name ?? id;
      if (action === 'terrain') {
        const roomArg = str(args.room);
        const room = roomArg === undefined ? fightRoom(c) : resolveRoom(graph, roomArg)?.id;
        if (room === undefined) throw new Error(`没有这个房间: ${roomArg}`);
        const { map, misplaced } = setBattleMap(c, room, { width: args.width, height: args.height, ceiling: args.ceiling, areas: args.areas });
        const unknown = map.areas.filter((a) => a.to !== undefined && findRoom(graph, a.to) === undefined).map((a) => a.to);
        const lines = [`已存 ${roomName(room)} 的场地图（再进这间沿用）。${terrainLine(map)}`];
        if (unknown.length > 0) lines.push(`【DM】to 里的房间 id 不认识：${unknown.join('、')}，用 dnd_lookup 查准再画一次。`);
        if (misplaced.length > 0) lines.push(`【DM】这些人现在站在墙里或障碍上：${misplaced.join('、')}，用 set 挪出来。`);
        return lines.join('\n');
      }
      if (action === 'clear_terrain') {
        const roomArg = str(args.room);
        const room = roomArg === undefined ? fightRoom(c) : resolveRoom(graph, roomArg)?.id;
        if (room === undefined) throw new Error(`没有这个房间: ${roomArg}`);
        const authored = findRoom(graph, room)?.battlemap;
        const hadMap = mapOf(c, room) !== undefined;
        const restored = clearBattleMap(c, room, authored);
        if (!hadMap && restored === undefined) return `${roomName(room)} 当前没有保存的自定义场地图。`;
        return restored !== undefined
          ? `已清除 ${roomName(room)} 的临时场地图，并恢复模组预设场地图。`
          : `已清除 ${roomName(room)} 的自定义场地图。`;
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
      if (action === 'zone') {
        assertNoPending(c, '放置持续区域');
        const zoneName = str(args.name);
        if (zoneName === undefined) throw new Error('dnd_position zone 要给 name（如 "黑暗术"、"毒雾"、"蛛网术"）');
        const casterName = str(args.caster);
        const casterCh = casterName !== undefined ? requireCharacter(c, casterName) : undefined;
        let zx = int(args.x);
        let zy = int(args.y);
        let zRoom = str(args.room) === undefined ? undefined : resolveRoom(graph, str(args.room)!)?.id;
        const at = str(args.at);
        if (at !== undefined && (zx === undefined || zy === undefined)) {
          const who = findCharacter(c, at);
          const point = who !== undefined ? cellOf(c, who) : c.initiative?.marks?.[at];
          if (point === undefined) throw new Error(`找不到定位对象「${at}」的坐标，请传 x 和 y`);
          zx = point.x;
          zy = point.y;
          zRoom ??= point.room;
        }
        if (zx === undefined || zy === undefined) {
          throw new Error('dnd_position zone 需要给 x/y 坐标，或传 at="角色/标记名"');
        }
        const spendKey = str(args.spend);
        if (spendKey !== undefined && casterCh === undefined) {
          throw new Error('dnd_position zone 传 spend 扣减法术位时必须同时指定 caster="施法者角色名"');
        }
        if (casterCh !== undefined) {
          const turn = ensureTurnState(c);
          assertTurnActionAllowed(turn, casterCh, 'action');
          if (turn?.actor === casterCh.name && hasCondition(casterCh, '迟缓术')) turn.actionUsed ??= zoneName;
        }
        const spent = spendKey !== undefined && casterCh !== undefined ? useResource(c, casterCh.name, spendKey) : undefined;
        let spellWarn: string | undefined;
        let inferredSlotLevel: number | undefined;
        if (spent !== undefined && casterCh !== undefined) {
          const slotMatch = /([1-9])\s*环/.exec(spent.key);
          if (slotMatch !== null) inferredSlotLevel = Number(slotMatch[1]);
          if (c.initiative?.order[c.initiative.turn]?.name === casterCh.name) {
            const ts = ensureTurnState(c);
            if (ts !== undefined) {
              ts.actionUsed ??= zoneName;
              if (inferredSlotLevel !== undefined) {
                spellWarn = recordTurnSpellCast(ts, casterCh.name, zoneName, inferredSlotLevel, 'action');
              }
            }
          }
        }
        const spellLevel = int(args.spell_level) ?? inferredSlotLevel;
        const shapeRaw = str(args.shape);
        const shape = shapeRaw === 'rect' || shapeRaw === 'cube' ? 'rect' as const : (shapeRaw === 'sphere' ? 'sphere' as const : undefined);
        const cubeCells = shapeRaw === 'cube' && int(args.size) !== undefined ? Math.max(1, Math.round(int(args.size)! / 5)) : undefined;
        const explicitDc = int(args.save_dc);
        const inferredDc = explicitDc ?? (casterCh !== undefined ? inferSpellSaveDc(casterCh) : undefined);
        const rawTriggers = strList(args.triggers)?.filter((t): t is ZoneTrigger => t === 'enter' || t === 'turn_start' || t === 'turn_end');
        const zoneInput: BattleZoneInput = {
          name: zoneName,
          ...(zRoom !== undefined ? { room: zRoom } : {}),
          ...(shape !== undefined ? { shape } : {}),
          x: zx,
          y: zy,
          ...(int(args.radius) !== undefined ? { radius: int(args.radius)! } : (shapeRaw === 'sphere' && int(args.size) !== undefined ? { radius: int(args.size)! } : {})),
          ...(int(args.w) !== undefined ? { w: int(args.w)! } : (cubeCells !== undefined ? { w: cubeCells } : {})),
          ...(int(args.h) !== undefined ? { h: int(args.h)! } : (cubeCells !== undefined ? { h: cubeCells } : {})),
          ...(int(args.zone_height) !== undefined ? { height: int(args.zone_height)! } : {}),
          ...(casterCh !== undefined ? { source: casterCh.name } : {}),
          ...(typeof args.concentration === 'boolean' ? { concentration: args.concentration } : {}),
          ...(int(args.rounds) !== undefined ? { rounds: int(args.rounds)! } : {}),
          ...(args.obscured === 'light' || args.obscured === 'heavy' || args.obscured === 'darkness' ? { obscured: args.obscured } : {}),
          ...(typeof args.difficult === 'boolean' ? { difficult: args.difficult } : {}),
          ...(str(args.damage) !== undefined ? { damage: str(args.damage)! } : {}),
          ...(str(args.damage_type) !== undefined ? { damageType: str(args.damage_type)! } : {}),
          ...(str(args.save_ability) !== undefined ? { saveAbility: str(args.save_ability)! } : {}),
          ...(inferredDc !== undefined ? { saveDc: inferredDc } : {}),
          ...(args.on_save === 'half' || args.on_save === 'none' ? { onSave: args.on_save } : {}),
          ...(strList(args.on_fail_conditions) !== undefined ? { onFailConditions: strList(args.on_fail_conditions)! } : {}),
          ...(rawTriggers !== undefined && rawTriggers.length > 0 ? { triggers: rawTriggers } : {}),
          ...(typeof args.per_step === 'boolean' ? { perStep: args.per_step } : {}),
          ...(args.target_side === 'all' || args.target_side === 'enemies' || args.target_side === 'allies' ? { targetSide: args.target_side } : {}),
        };
        if (c.initiative !== undefined && casterCh?.kind === 'monster' && args.is_spell !== false) {
          const spellReactors = eligibleSpellReactors(c, casterCh, { spellName: zoneName });
          if (spellReactors.length > 0) {
            const id = rollId(c, exec);
            const p: PendingSpell = {
              kind: 'spell',
              seq: id,
              at: Date.now(),
              attacker: casterCh.name,
              target: casterCh.name,
              reactors: spellReactors,
              declined: [],
              claimed: [],
              used: [],
              spellName: zoneName,
              ...(spellLevel !== undefined ? { spellLevel } : {}),
              effect: {
                kind: 'zone',
                zoneInput,
                ...(spellWarn !== undefined ? { spellWarn } : {}),
              },
            };
            requireInitiative(c).pending = p;
            deps.onPendingAttack?.(recordOf(exec));
            return [
              ...(spent !== undefined ? [`${casterCh.name}「${spent.key}」${spent.before}→${spent.resource.current}/${spent.resource.max}`] : []),
              `${casterCh.name} 正在施放持续区域法术「${zoneName}」（还没落地） #R${id}`,
              holdNotice(p),
              SECRET_NOTE,
            ].join('\n');
          }
        }
        const { zone, broken, affected } = upsertBattleZone(c, zoneInput);
        const out = [
          ...(spent !== undefined && casterCh !== undefined ? [`${casterCh.name}「${spent.key}」${spent.before}→${spent.resource.current}/${spent.resource.max}`] : []),
          `已放置持续区域：${formatZoneSummary(zone)}`,
        ];
        if (affected.length > 0) out.push(`当前处于区域内的单位：${affected.join('、')}`);
        if (broken.length > 0) out.push(...broken);
        if (spellWarn !== undefined) out.push(spellWarn);
        if (c.initiative !== undefined && casterCh !== undefined && casterCh.kind !== 'monster' && args.is_spell !== false) {
          out.push(...hostileSpellcasterHints(c, casterCh, { kind: 'spell', spellName: zoneName }));
        }
        return `${out.join('\n')}${combatLedgerSuffix(c)}`;
      }
      if (action === 'remove_zone') {
        assertNoPending(c, '移除持续区域');
        const zRoom = str(args.room) === undefined ? undefined : resolveRoom(graph, str(args.room)!)?.id;
        const removed = removeBattleZone(c, String(args.name ?? ''), zRoom);
        return `已移除持续区域：${removed.map((z) => `${z.name}(${z.id})`).join('、')}${combatLedgerSuffix(c)}`;
      }
      if (action === 'set') {
        assertNoPending(c, '重新摆位');
        const formation = parseFormationInput(args.formation);
        const name = str(args.name);
        const hasSingle = name !== undefined || args.x !== undefined || args.y !== undefined || args.near !== undefined || args.z !== undefined;
        if (hasSingle && (name === undefined || args.placements !== undefined)) {
          throw new Error('单人摆位用 name + x/y 或 near，与 placements 二选一');
        }
        const single = name === undefined ? undefined : {
          name, x: args.x, y: args.y, near: args.near,
          z: args.z ?? cellOf(c, requireCharacter(c, name))?.z,
        };
        const notes = setPositions(c, parsePlacements(single === undefined ? args.placements : [single], formation !== undefined), formation);
        return [...battleLines(c, roomName), ...notes].join('\n');
      }
      if (action === 'move' || action === 'swap') {
        const ch = requireCharacter(c, String(args.name ?? ''));
        assertNoPending(c, action === 'swap' ? '交换站位' : '移动');
        if (args.dm_override === true && str(args.declared_by) === undefined) {
          throw new Error('dnd_position: dm_override 还要给 declared_by（委托的玩家编号，如 U4），并在回复里写明是谁委托的');
        }
        assertCanAct(c, ch, {
          declaredBy: memberId(exec, args.declared_by, 'declared_by'),
          reaction: args.reaction === true,
          dmOverride: args.dm_override === true,
          recentSenders: sendersOf(exec),
          ignoreStateMods: args.ignore_state_mods === true,
        });
        if (args.reaction === true) requireInitiative(c).rebrief = true;
        if (args.use_reaction === true) {
          assertDeclaredByOwner(ch, { declaredBy: memberId(exec, args.declared_by, 'declared_by'), recentSenders: sendersOf(exec) }, '反应移动');
          spendReaction(c, ch.name);
        }
        const swapTargetRaw = str(args.swap) ?? (action === 'swap' ? (str(args.to) ?? str(args.adjacent_to)) : undefined);
        if (action === 'swap' && swapTargetRaw === undefined) {
          throw new Error('dnd_position action="swap" 需要传 swap="队友角色名"（或 to="队友角色名"）');
        }
        const request: MoveRequest = { reaction: args.reaction === true };
        const text = (key: keyof MoveRequest, value: unknown): void => {
          const v = str(value);
          if (v !== undefined) (request as Record<string, unknown>)[key] = v;
        };
        if (swapTargetRaw !== undefined) {
          const ally = requireCharacter(c, swapTargetRaw);
          request.swap = ally.name;
          if (ally.kind !== 'pc' || ally.playerId === undefined || isDmDelegated(ally) || effectiveControllerId(ally) === effectiveControllerId(ch)) {
            request.swapApproved = true;
          } else if (str(args.ally_declared_by) !== undefined) {
            assertDeclaredByOwner(
              ally,
              {
                declaredBy: memberId(exec, args.ally_declared_by, 'ally_declared_by'),
                recentSenders: sendersOf(exec),
                dmOverride: args.ally_dm_override === true,
              },
              '同意交换站位',
            );
            request.swapApproved = true;
          } else if (args.ally_dm_override === true) {
            throw new Error('dnd_position: ally_dm_override 需要同时提供 ally_declared_by（授权委托的玩家编号，如 U4），并在回复里写明是谁委托的');
          }
        } else {
          text('adjacentTo', args.adjacent_to);
          text('to', args.to);
          text('awayFrom', args.away_from);
        }
        text('keepAdjacent', args.keep_adjacent);
        text('drag', args.drag);
        const x = int(args.x);
        const y = int(args.y);
        const z = int(args.z);
        const feet = int(args.feet);
        if (x !== undefined) request.x = x;
        if (y !== undefined) request.y = y;
        if (z !== undefined) request.z = z;
        if (feet !== undefined) request.feet = feet;
        if (args.dash === true) request.dash = true;
        if (args.disengage === true) request.disengage = true;
        if (args.crawl === true) request.crawl = true;
        if (args.enter_hazards === true) request.enterHazards = true;
        if (args.ignore_state_mods === true) request.ignoreStateMods = true;
        const result = beginMovement(c, ch.name, request, { roller: service.roller, globalEffects: service.globalEffects() });
        if (c.initiative?.movement !== undefined) deps.onPendingAttack?.(recordOf(exec));
        return `${result}${combatLedgerSuffix(c)}`;
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
      const grid = args.text_grid === true ? battleGridLines(c, roomName, (ch) => !hiddenFromPlayers(ch)) : undefined;
      if (grid !== undefined) lines.push('', '玩家视角示意图（原样发送，含代码块围栏）：', ...grid);
      return lines.join('\n');
    });
  }
}
