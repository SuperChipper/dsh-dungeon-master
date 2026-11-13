/** 剧情：dnd_story、dnd_lookup、dnd_chronicle、dnd_hook。 */
import { findNpc } from '../adventure.ts';
import {
type CharacterInput,pushLog,requireCharacter
} from '../campaign.ts';
import {
CHRONICLE_KINDS,
type ChronicleKind,
addEntry,
closeEntry,
formatEntry
} from '../chronicle.ts';
import { HOOK_TIERS,type HookResponse,addHook,closeHook,hookHint,hookLine,planHook,updateHook,useHook } from '../hooks.ts';
import {
str,
int,
strList,readChronicle,storyAction,
lookup,npcSceneText,fetchSrd,srdMonsterInput,characterBrief,sheet,type ToolKit
} from './shared.ts';

export function registerStoryTools(kit: ToolKit): void {
  const { service, recordOf, mutate, whoOf, register } = kit;

  register(
    'dnd_story',
    'Change story state written into the adventure, by id (ids come from 【团况】 and dnd_lookup). '
    + 'begin (no id): the opening is done and the party enters the first scene; returns what to narrate. '
    + 'trigger: an event listed as "可能发生" now happens (applies its flags, leads, reinforcements). '
    + 'fact: an NPC or captive reveals a piece of information (checks with a DC: dnd_check first, then passed=true); '
    + 'say only what the tool returns. lead: players learn a lead. flag: set/clear a declared flag. '
    + 'quest: offered/active/completed/rewarded/failed (rewarded pays gp/items to `to`). '
    + 'npc: attitude/room/met, or join=true (joins the party) / fight=true (fights the party), which creates the '
    + 'character sheet. chapter: move to another chapter.',
    {
      action: { type: 'string', enum: ['begin', 'trigger', 'fact', 'lead', 'flag', 'quest', 'npc', 'chapter'] },
      id: { type: 'string', description: 'Trigger / fact / lead / flag / quest / npc / chapter id.' },
      on: { type: 'boolean', description: 'For flag: true sets (default), false clears.' },
      passed: { type: 'boolean', description: 'For fact with a DC: the required check succeeded.' },
      status: { type: 'string', enum: ['offered', 'active', 'completed', 'rewarded', 'failed'], description: 'For quest.' },
      to: { type: 'string', description: 'For quest status=rewarded: character who receives the gp and items.' },
      attitude: { type: 'string', enum: ['friendly', 'indifferent', 'hostile'], description: 'For npc.' },
      room: { type: 'string', description: 'For npc: where the NPC is now (room id).' },
      met: { type: 'boolean', description: 'For npc.' },
      alive: { type: 'boolean', description: 'For npc that never entered play: dies (or survives) off-screen.' },
      join: { type: 'boolean', description: 'For npc: joins the party (creates a companion sheet).' },
      fight: { type: 'boolean', description: 'For npc: fights the party (creates a monster sheet in their room).' },
      hp: {
        type: 'integer',
        description: 'For npc with join/fight: current HP when the sheet is created or updated (e.g. a wounded captive '
          + 'at 0 or 1). Default: full.',
      },
    },
    ['action'],
    async (args, exec) => {
      const action = String(args.action);
      const id = String(args.id ?? '').trim();
      // NPC 上场要 SRD 数据时先取回来（网络请求不能放进同步的 mutate 里）
      let srdBase: Omit<CharacterInput, 'name'> | undefined;
      if (action === 'npc' && (args.join === true || args.fight === true)) {
        const { adventure } = service.require(recordOf(exec).sessionKey);
        const stat = findNpc(adventure, id)?.stat;
        if (stat !== undefined && !('hp' in stat)) srdBase = srdMonsterInput(await fetchSrd('monsters', stat.srd));
      }
      return mutate(exec, (c, adventure) => {
        const lines = storyAction(c, adventure, action, id, args, srdBase);
        for (const line of lines) pushLog(c, line);
        // NPC 第一次照面、入队、翻脸：DM 正要给他台词，这时候提来历最用得上
        const npc = action === 'npc' && (args.met === true || args.join === true || args.fight === true) ? findNpc(adventure, id) : undefined;
        const hint = npc === undefined ? undefined : hookHint(c, npcSceneText(npc));
        if (hint !== undefined) lines.push(hint);
        return lines.join('\n');
      });
    },
  );

  register(
    'dnd_lookup',
    'Read adventure content (DM eyes only, never read it aloud wholesale): npc (who they are, what they know and '
    + 'whether it was said, quests they offer), quest, site (rules, rooms, what groups there know), room (notes, '
    + 'events, NPCs), leads (all leads and which the players know). Omit id to list everything of that kind. '
    + 'brief=true (npc/room) returns one line: who is there with HP/conditions, attitude, unfired event and '
    + 'unsaid fact ids. Use it for quick checks; read the full card before revealing facts or ruling on DM notes. '
    + 'character: a PC or companion sheet (items, gold, resources, spells), also while paused: a player asking what '
    + 'their own character carries is not a spoiler. Omit id to list the party. '
    + 'Read-only access also works while paused for explicitly requested DM preparation; never use it to spoil future scenes in chat.',
    {
      kind: { type: 'string', enum: ['npc', 'quest', 'site', 'room', 'leads', 'character'] },
      id: { type: 'string', description: 'Id or name; omit to list.' },
      brief: { type: 'boolean', description: 'npc/room only: one-line summary instead of the full card (default false).' },
    },
    ['kind'],
    (args, exec) => {
      const key = recordOf(exec).sessionKey;
      const found = service.active(key) ?? service.saved(key);
      if (found === undefined) throw new Error('这个群没有团档（或模组文件丢失）');
      const { campaign, adventure } = found;
      if (args.kind === 'character') {
        // 只给队伍这边的卡：怪物数值停团也不该顺手查出来
        const party = campaign.characters.filter((ch) => ch.kind !== 'monster');
        const id = str(args.id);
        if (id === undefined) return party.length === 0 ? '还没有角色卡。' : party.map((ch) => characterBrief(campaign, ch)).join('\n');
        const target = requireCharacter(campaign, id);
        if (target.kind === 'monster') throw new Error(`${target.name} 是怪物：开团时用 dnd_character show 查，停团不查怪物数值`);
        return args.brief === true ? characterBrief(campaign, target) : sheet(target, whoOf(exec), campaign);
      }
      return lookup(campaign, adventure, String(args.kind), str(args.id), args.brief === true);
    },
  );

  register(
    'dnd_chronicle',
    'The campaign\'s long-term plot ledger (DM eyes only). Visited rooms, defeated foes, quest changes, leads, facts and '
    + 'PC items are recorded automatically. add: record what the tools cannot see: improvised people and events, captives, '
    + 'promises and debts, loose threads, backstory, standing table rulings. search: look up the past by keywords before '
    + 'answering questions about it or denying something happened. list: unresolved entries and recent ones. close: an '
    + 'unresolved entry is settled.',
    {
      action: { type: 'string', enum: ['add', 'search', 'list', 'close'] },
      text: { type: 'string', description: 'For add: one fact in a sentence, with names.' },
      kind: { type: 'string', enum: [...CHRONICLE_KINDS], description: 'For add (default event). promise/captive/thread start unresolved.' },
      query: { type: 'string', description: 'For search: keywords separated by spaces; any match counts, e.g. "矮人 地图".' },
      id: { type: 'integer', description: 'For close: the entry number.' },
      outcome: { type: 'string', description: 'For close: how it ended.' },
    },
    ['action'],
    (args, exec) => {
      const action = String(args.action);
      if (action === 'search' || action === 'list') {
        // 停团时也能查：收团后有人问「黑蜘蛛死了没」，查不了账本，DM 凭印象连着改了五次口
        const key = recordOf(exec).sessionKey;
        const found = service.active(key) ?? service.saved(key);
        if (found === undefined) throw new Error('这个群没有团档');
        return readChronicle(found.campaign, action, str(args.query));
      }
      return mutate(exec, (c) => {
      if (action === 'add') {
        const entry = addEntry(c, { text: String(args.text ?? ''), kind: args.kind as ChronicleKind | undefined });
        return `已记：${formatEntry(entry)}`;
      }
      if (action === 'close') {
        const id = int(args.id);
        if (id === undefined) throw new Error('dnd_chronicle close 要给 id');
        return `已了结：${formatEntry(closeEntry(c, id, str(args.outcome)))}`;
      }
      throw new Error(`dnd_chronicle 不认识的 action: ${action}`);
      });
    },
  );

  register(
    'dnd_hook',
    'Backstory hooks on PC sheets: unresolved things from a character\'s past that the PLAYER told you (someone they '
    + 'look for, a debt, a place they fled). Never invent one for them. add: the player\'s words plus trigger words '
    + '(names, places, groups, objects, 2+ characters); from then on room entries, NPC meetings and found items that '
    + 'mention a trigger word carry a 【DM · 背景钩子】 note. Whether to use it is your call. Tiers: 1 a detail in the '
    + 'scene, 2 an NPC line (both at will); 3 a message arrives, 4 a dilemma (plan first, play it a scene or a session '
    + 'later); 5 the person shows up (plan, ask the player, then player_ok=true). use: after you played a tier, with '
    + 'response bit/ignored once the player reacted. If a player ignored it, wait before pushing again. list: all hooks, '
    + 'least recently touched first. close: the matter is settled.',
    {
      action: { type: 'string', enum: ['add', 'update', 'list', 'plan', 'use', 'close'] },
      character: { type: 'string', description: 'PC name (not needed for list).' },
      id: { type: 'integer', description: 'Hook number on that PC (update/plan/use/close).' },
      text: { type: 'string', description: 'add/update: the unresolved matter, in the player\'s words. plan: how and when you will play it.' },
      keys: { type: 'array', items: { type: 'string' }, description: 'add/update: trigger words, e.g. ["拉西亚","红袍法师"].' },
      tier: { type: 'integer', description: 'plan/use: 1-5 (see the tool description).' },
      response: { type: 'string', enum: ['bit', 'ignored'], description: 'use: whether the player picked it up.' },
      player_ok: { type: 'boolean', description: 'use tier 5: the player agreed to this person appearing.' },
    },
    ['action'],
    (args, exec) => {
      const action = String(args.action);
      if (action === 'list') {
        const key = recordOf(exec).sessionKey;
        const found = service.active(key) ?? service.saved(key);
        if (found === undefined) throw new Error('这个群没有团档');
        const pcs = found.campaign.characters.filter((ch) => ch.kind === 'pc');
        const lines = pcs.flatMap((ch) => (ch.hooks ?? []).map((h) => ({ ch, h })))
          .sort((a, b) => Number(a.h.closed === true) - Number(b.h.closed === true) || (a.h.usedAt ?? 0) - (b.h.usedAt ?? 0))
          .map(({ ch, h }) => `- ${hookLine(ch, h)}`);
        const none = pcs.filter((ch) => (ch.hooks ?? []).every((h) => h.closed === true)).map((ch) => ch.name);
        return [
          lines.length > 0 ? `背景钩子（最久没碰的在前）：\n${lines.join('\n')}` : '还没有背景钩子。',
          none.length > 0 ? `还没留过（或都了结了）：${none.join('、')}。有机会问问玩家角色有什么放不下的事。` : '',
          `档位：${HOOK_TIERS.slice(1).map((t, i) => `${i + 1} ${t}`).join('；')}`,
        ].filter(Boolean).join('\n');
      }
      return mutate(exec, (c) => {
        const ch = requireCharacter(c, String(args.character ?? ''));
        const id = int(args.id);
        const needId = (): number => {
          if (id === undefined) throw new Error(`dnd_hook ${action} 要给 id`);
          return id;
        };
        if (action === 'add') {
          const hook = addHook(ch, String(args.text ?? ''), strList(args.keys) ?? []);
          addEntry(c, { kind: 'backstory', text: `${ch.name} 的背景钩子 #${hook.id}：${hook.text}` });
          return `已挂上：${hookLine(ch, hook)}`;
        }
        if (action === 'update') {
          const keys = strList(args.keys);
          return `已改：${hookLine(ch, updateHook(ch, needId(), { ...(str(args.text) !== undefined ? { text: str(args.text)! } : {}), ...(keys !== undefined ? { keys } : {}) }))}`;
        }
        if (action === 'plan') {
          const tier = int(args.tier) ?? 0;
          const hook = planHook(ch, needId(), tier, String(args.text ?? ''));
          return `已记下打算：${hookLine(ch, hook)}${tier === 5 ? `\n演之前先问 ${ch.player ?? ch.name} 同不同意，点头了再 use player_ok=true。` : ''}`;
        }
        if (action === 'use') {
          const tier = int(args.tier) ?? 0;
          const response = str(args.response) as HookResponse | undefined;
          const hook = useHook(ch, needId(), tier, { ...(response !== undefined ? { response } : {}), playerOk: args.player_ok === true });
          addEntry(c, { kind: 'backstory', repeatable: true, text: `${ch.name} 的钩子 #${hook.id}（${hook.text.slice(0, 30)}）演到第 ${tier} 档：${HOOK_TIERS[tier]}${response === 'bit' ? '，玩家接了' : (response === 'ignored' ? '，玩家没接' : '')}` });
          const next = response === 'ignored' ? '玩家没接，过一阵再碰，别连着推。' : '';
          return `已记：${hookLine(ch, hook)}${next ? `\n${next}` : ''}`;
        }
        if (action === 'close') {
          const hook = closeHook(ch, needId());
          addEntry(c, { kind: 'backstory', text: `${ch.name} 的钩子 #${hook.id} 了结：${hook.text}` });
          return `已了结：${hookLine(ch, hook)}`;
        }
        throw new Error(`dnd_hook 不认识的 action: ${action}`);
      });
    },
  );
}
