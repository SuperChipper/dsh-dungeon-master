/** 探索：dnd_move（房间移动）、dnd_map（发地图）。 */
import { join } from 'node:path';
import { roomGraph } from '../adventure.ts';
import {
assertNoPending,moveParty,partyPositions
} from '../campaign.ts';
import { findRoom } from '../dungeon.ts';
import { mapCaption,renderPartyMap } from '../map-view.ts';
import {
npcAlive,npcCharacter,npcRoom,
npcsIn,
pendingTriggers,shopLine
} from '../story.ts';
import { hookHint } from '../hooks.ts';
import {
str,strList,spawnLine,npcSceneText,partySizeHint,
combatJoinHint,type ToolKit
} from './shared.ts';

export function registerExploreTools(kit: ToolKit): void {
  const { deps, service, recordOf, mutate, sendersOf, register } = kit;

  register(
    'dnd_move',
    'Move characters to an adjacent room (moving inside the same room is dnd_position). Omit `who` only when the WHOLE party goes; when one or a few go ahead '
    + '(scouting, sneaking, fetching something) pass `who` so the others stay put. Returns the player-facing '
    + 'description (narrate from this) and DM-only notes (use for rulings, never read aloud). First visit reveals '
    + 'the room and spawns its monsters. In combat, characters in the initiative order move only on their own turn (with `who`); '
    + 'those not in the fight yet (catching up) can move any time, then join with dnd_initiative join. '
    + 'On a revisit (no 「（首次）」) the description is the first-entry script: describe the room as it is now from the '
    + 'state and foe list; do not replay cleared fights or fired events. '
    + 'Pass discover_hidden=true only after a successful check found a secret passage. Exits that need a check '
    + '(climbing, swimming) are rolled by the tool for each mover; those who fail stay behind. In a town you can go '
    + 'to any location the players know. From a dungeon\'s entry, or anywhere in a town, you can travel to another '
    + 'known site by its name or id.',
    {
      room: { type: 'string', description: 'Room id or name, or another site\'s id/name (from that site\'s entry).' },
      who: { type: 'array', items: { type: 'string' }, description: 'Characters who move; omit for the whole party.' },
      discover_hidden: { type: 'boolean' },
      dm_override: {
        type: 'boolean',
        description: 'Move a PC whose player has not spoken this turn: explicit delegation ("Kriv 先过去探路") or '
          + 'forced movement (pushed, dragged, grappled). Say who delegated it / what forced it in the reply. Not for '
          + 'quietly repositioning someone else\'s character.',
      },
    },
    ['room'],
    (args, exec) => mutate(exec, (c, adventure) => {
      assertNoPending(c, '换房间');
      const who = strList(args.who);
      if (who !== undefined && args.dm_override !== true) {
        const senders = sendersOf(exec);
        const silent = who
          .map((n) => c.characters.find((ch) => ch.name === n))
          .filter((ch) => ch !== undefined && ch.kind === 'pc' && ch.playerId !== undefined && !senders.includes(ch.playerId))
          .map((ch) => `${ch!.name} 是〈${ch!.player ?? ch!.playerId}〉的角色`);
        if (silent.length > 0) {
          throw new Error(
            `${silent.join('；')}，他本人这轮还没发话。拆开队伍要带走别人的卡，传 dm_override=true，`
            + '并在回复里写清是委托还是被推/被拖；全队一起走就不要给 who。',
          );
        }
      }
      const result = moveParty(c, adventure, String(args.room ?? ''), args.discover_hidden === true, who, service.roller);
      const lines: string[] = [];
      if (result.checks.length > 0) {
        lines.push(`出口检定：${result.checks.map((r) => `${r.name} ${r.detail}`).join('；')}`);
        if (result.failText !== undefined) lines.push(`【DM】没过的人留在原地，后果：${result.failText}（伤害用 dnd_apply）`);
      }
      if (result.movers.length === 0) {
        lines.push('没有人过去。');
      } else {
        const someStayed = result.checks.some((r) => !r.passed);
        lines.push(`${strList(args.who)?.length || someStayed ? result.movers.join('、') : '队伍'}进入「${result.room.name}」${result.firstVisit ? '（首次）' : ''}`);
        if (result.travelledFrom !== undefined) {
          lines.push(`【DM】这是离开「${result.travelledFrom.name}」、在地面上赶路到「${result.site.name}」，不是暗道或捷径；按下面的抵达描述叙述。`);
        }
        if (result.firstSiteVisit && result.site.arrival) lines.push(`【抵达「${result.site.name}」，可以念】${result.site.arrival}`);
        if (result.firstSiteVisit && result.site.features) lines.push(`【DM】「${result.site.name}」通用规则：${result.site.features}`);
        lines.push(`【玩家视角，可以描述】${result.view.playerView}`, `【DM 机密，勿念】${result.view.dmNotes}`);
        // 剧本写着他在这儿，可他已经在别处死了（黑蜘蛛在洞外被打死，神庙的剧本还让他开打）
        const goneHere = adventure.npcs.filter((n) => npcRoom(c, n) === result.room.id && !npcAlive(c, n.id) && npcCharacter(c, n.id) === undefined);
        if (goneHere.length > 0) {
          lines.push(`【DM】本桌已死：${goneHere.map((n) => `${n.name}(${n.id})`).join('、')}。上面剧本里他在场的部分作废，房间按他不在写；他身上的东西已经搜过就不再出现。和账本里的裁定对不上时先问桌上，裁定他活着就 dnd_story npc <id> alive=true。`);
        }
        // 房间文本是首次进门的剧本，不跟踪打完的仗；就在这里提醒，这是重放开场伏击的那一步
        if (!result.firstVisit) lines.push('【DM】这里来过：上面是首次进门的剧本，不跟踪清空的怪、已触发的事件、搜过的东西。现况按团况和敌人名单说，别重放打过的仗。');
        if (result.room.shop !== undefined) lines.push(`【店铺】${shopLine(result.room.shop)}`);
      }
      if (result.spawned.length > 0) {
        lines.push(`【DM 机密】本房间敌人：${result.spawned.map(spawnLine).join('；')}`);
        const scale = partySizeHint(c, adventure);
        if (scale !== undefined) lines.push(scale);
      }
      if (result.movers.length > 0) {
        const npcs = npcsIn(c, adventure, result.room.id);
        if (npcs.length > 0) lines.push(`【DM】这里的 NPC（dnd_lookup npc 看详情）：${npcs.map((n) => `${n.name}(${n.id})：${n.look}`).join('；')}`);
        const pending = pendingTriggers(c, adventure, result.room.id);
        if (pending.length > 0) lines.push(`【DM】这里可能发生（吻合时 dnd_story trigger）：${pending.map((t) => `${t.id}：${t.when}`).join('；')}`);
        // 只在首次进门时提：走回头路每次都提，DM 会学会无视它
        if (result.firstVisit) {
          const scene = [result.site.name, result.room.name, result.view.playerView, result.view.dmNotes, ...npcs.map(npcSceneText), ...pending.map((t) => t.when)];
          const hint = hookHint(c, scene.join('\n'), result.movers);
          if (hint !== undefined) lines.push(hint);
        }
      }
      lines.push(`可见出口：${result.exits.map((e) => `${e.label} → ${e.known ? e.name : '未探索'}(${e.to})${e.locked === true ? '[暂时过不去]' : ''}`).join('；') || '无'}`);
      const positions = partyPositions(c);
      if (positions.size > 1) {
        lines.push(`队伍现在分开了：${[...positions].map(([room, members]) => `${findRoom(roomGraph(adventure), room)?.name ?? room}：${members.map((ch) => ch.name).join('、')}`).join('｜')}。没来的人看不到这里，别替他们行动。`);
      }
      if (result.story.length > 0) lines.push(`【剧情】${result.story.join('；')}`);
      const joinHint = combatJoinHint(c, result.room.id, result.movers, result.spawned.map((m) => m.name));
      if (joinHint !== undefined) lines.push(joinHint);
      return lines.join('\n');
    }),
  );

  register(
    'dnd_map',
    'Send a map to the group as an image. During a fight (initiative running, positions set) it sends the battle map of '
    + 'the fight\'s room: the room\'s terrain (on the module book\'s art when the room has it) with everyone\'s position, '
    + 'grid coordinates matching dnd_position, hidden monsters left out. Send it once positions are set at the start of a '
    + 'fight and whenever players ask where things are, not every turn. Outside a fight it sends the exploration map: the '
    + 'book\'s player map with unvisited rooms blacked out, or a schematic when the site has none.',
    {
      caption: { type: 'string', description: 'Optional short text sent with the map.' },
      view: { type: 'string', enum: ['auto', 'battle', 'explore'], description: 'auto (default): battle map during a fight, else the exploration map.' },
      schematic: { type: 'boolean', description: 'Exploration map only: force the box-and-line schematic even when a book map exists.' },
    },
    [],
    async (args, exec) => {
      const record = recordOf(exec);
      const { campaign, adventure } = service.require(record.sessionKey);
      const out = join(service.mapDir, `${record.sessionKey.replace(/[^a-zA-Z0-9_-]+/g, '_')}-${Date.now()}.png`);
      const view = (['battle', 'explore'] as const).find((v) => v === args.view) ?? 'auto';
      const map = await renderPartyMap(campaign, adventure, out, view, { schematic: args.schematic === true })
        .catch((err: unknown) => { throw new Error(`dnd_map: ${err instanceof Error ? err.message : String(err)}，先 dnd_position terrain 画一张`); });
      if (map === undefined) throw new Error('dnd_map: 地图渲染需要 sharp，当前环境没装上');
      // 地点、轮次、轮到谁画在图的标题条上；图例、能去哪附在图下面（DM 自己的话放最前）
      const caption = [str(args.caption), mapCaption(campaign, adventure, map.kind)].filter((s) => s !== undefined && s.length > 0).join('\n');
      await deps.sendImage(record, map.path, caption);
      return map.kind === 'battle'
        ? '战斗图已发，图下附了图例（坐标和 dnd_position 一致）。图上和图例里有的别再复述。'
        : '地图已发，图下附了能去的地方。图上和说明里有的别再复述。';
    },
  );
}
