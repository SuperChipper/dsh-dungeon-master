/** 角色卡与资源：dnd_character、dnd_resource、dnd_rest。 */
import type { Adventure } from '../adventure.ts';
import {
type Campaign,type CharacterInput,type CharacterKind,assertNoPending,changeInventory,findCharacter,inInitiative,fightRooms,leaveInitiative,removeCharacter,requireCharacter,rest,
restoreResource,
roomOf,
setResource,upsertCharacter,
useResource
} from '../campaign.ts';
import {
npcAlive
} from '../story.ts';
import { ABILITIES,type Ability } from '../rules.ts';
import { resolveSrdQuery,zhTable } from '../srd-lookup.ts';
import { type CardSpell,mergeSpells,resolveSpells } from '../spell-links.ts';
import { hookHint } from '../hooks.ts';
import { assertCombatExit } from '../battlefield.ts';
import {
parseReactions,str,
int,
strList,moduleNpcNamed,
reviveHint,sheet,
characterBrief,
parseSkills,
parseSpellInputs,
parseWeapons,
parseAbilities,srdList,requireSrd,srdMonsterInput,
numberedNames,type ToolKit
} from './shared.ts';

/** 暂停时可备好 PC 卡，但不能借写卡改战场或访问敌方数据。 */
function assertPausedSheet(c: Campaign, args: Record<string, unknown>): void {
  if (c.active) return;
  const action = String(args.action);
  if (!['create', 'update', 'show', 'list'].includes(action)) throw new Error('停团时只支持 PC 建卡、改卡和查卡；不能移除角色');
  if (args.kind !== undefined && args.kind !== 'pc') throw new Error('停团时只能操作 PC 角色卡');
  if (args.srd !== undefined || (int(args.count) ?? 1) > 1) throw new Error('停团时不能用 SRD 或 count 建怪；PC 一人一张卡');
  if (args.room !== undefined) throw new Error('停团写卡不能改变位置；移动请开团后用 dnd_move');
  if (action === 'list') return;
  const several = strList(args.names);
  for (const name of several !== undefined && several.length > 0 ? several : [str(args.name) ?? '']) {
    const ch = action === 'create' ? findCharacter(c, name) : requireCharacter(c, name);
    if (ch !== undefined && ch.kind !== 'pc') throw new Error(`停团时只能操作 PC 角色卡：「${ch.name}」不是 PC`);
  }
}

export function registerCharacterTools(kit: ToolKit): void {
  const { deps, service, recordOf, mutate, memberId, whoOf, register } = kit;

  register(
    'dnd_character',
    'Use whenever a player asks to see/check their character sheet, inventory, spells or resources, or to create/edit/level up a character. '
    + 'For existing sheets, read current data with show before answering or editing (reuse a show result already obtained this turn); never reconstruct a sheet from chat memory. '
    + 'Full sheet: action=show name="角色名"; quick HP/resources: also brief=true; unknown name: action=list first. '
    + 'Tool results are DM-only, NOT automatically sent to the group: send the requested PC sheet/content in your reply after reading it. '
    + 'Edits must be persisted with update (new sheets: create); only confirm saved after success. The update result already contains the saved sheet, so no extra show is needed. '
    + 'Create, update, show, list or remove character sheets (PCs, NPCs, extra monsters). Ability scores default to 10. '
    + 'Bind a PC to the player\'s group nickname with `player` and `player_id` so they can only act for their own character. '
    + 'New PC: ask name and class, then create with weapons, hit_die and the reactions that change attacks (standard array '
    + '15/14/13/12/10/8 if they want help), and set spell slots / class resources with dnd_resource set. '
    + 'While paused, create/update/show/list work for PCs only (no remove, SRD, multiple copies or room changes); '
    + 'no need to start the adventure. Use the player tag as player_id (e.g. U7); never edit campaign JSON. '
    + 'For updates, omit unchanged fields. notes and arrays such as weapons/traits/reactions/skills/saves/spells REPLACE existing values: '
    + 'read and preserve unrelated entries; prefer add_spells/remove_spells and add_items/remove_items for incremental changes. '
    + 'Use structured fields for supported mechanics (e.g. init_bonus, traits, reactions); notes alone do not enable automatic bonuses. '
    + 'Set spell slots/class-resource limits with dnd_resource set, not just notes. '
    + 'Improvised monsters: pass `srd` (e.g. "goblin") to take real stats from the SRD and `count` for several '
    + '(named 地精1, 地精2…); they are placed in the party\'s current room unless `room` is given. '
    + 'The same change for several characters (handing everyone an amulet, moving the party by hand, Aid on three people): '
    + 'ONE update with `names`, never one call each.',
    {
      action: { type: 'string', enum: ['create', 'update', 'show', 'list', 'remove'], description: 'show: read a current sheet before displaying/editing; update: persist changes to an existing sheet; create: a new sheet; list: find names; remove: delete.' },
      name: { type: 'string', description: 'Exact character name for create/update/show/remove. If unknown, use list first; names is for batch update or brief show.' },
      names: {
        type: 'array',
        items: { type: 'string' },
        description: 'For update/show: several characters at once instead of `name`. update applies the same fields to each '
          + '(room, add_items, remove_items, gp_change, max_hp_change, ac, speed…) and returns one line per character.',
      },
      srd: { type: 'string', description: 'For create: SRD monster index; fills AC/HP/abilities/attack from dnd5eapi.' },
      count: { type: 'integer', description: 'For create: how many copies (numbered names).' },
      room: {
        type: 'string',
        description: 'Room id the character is in (monsters; PCs that split off). Moving a monster in combat to a room '
          + 'outside the fight also takes it out of initiative. Voluntary fleeing must first use dnd_position move to the mapped exit and resolve opportunity attacks.',
      },
      forced_move: { type: 'boolean', description: 'With room: actual teleport/forced movement or correction only, bypassing the voluntary exit-route check. Never for voluntary fleeing. Explain the cause in the reply.' },
      speed: { type: 'integer', description: 'Walking speed in feet (default 30). dnd_position warns when a turn\'s movement exceeds it.' },
      reactions: {
        type: 'array',
        description: 'Reactions that can change an attack; attacks pause for the player when one applies (replaces the list). '
          + 'when: foe_attacks (a foe hits an ally or self: 尖刻言语), attacked (self is hit: 护盾术), attacking (own attack misses: 导引打击). '
          + 'resource: what it spends; once that runs out the player is not asked.',
        items: {
          type: 'object',
          properties: {
            name: { type: 'string' },
            when: { type: 'string', enum: ['foe_attacks', 'attacked', 'attacking'] },
            resource: { type: 'string' },
            range: { type: 'integer', description: 'Trigger range in feet (e.g. 哨兵 5, 长柄大师 10).' },
            counter: { type: 'boolean', description: 'Reaction grants a separate counterattack (e.g. 哨兵); record it with dnd_apply reaction, then dnd_check attack reaction=true after settling.' },
            enter: { type: 'boolean', description: 'Triggers when an enemy enters reach (长柄大师); movement pauses at this boundary.' },
          },
          required: ['name'],
          additionalProperties: false,
        },
      },
      hit_die: { type: 'string', description: 'PCs: hit die, e.g. d10 (fighter/paladin/ranger), d8 (cleric/rogue/bard).' },
      traits: {
        type: 'array',
        items: { type: 'string' },
        description: 'Auto-handled traits (replaces the list): "不死坚韧"; fighting styles "巨武器战斗" (rerolls 1-2 on '
          + 'two-handed weapon dice) and "箭术" (+2 to hit with ranged weapons). With these set, never add them by hand.',
      },
      expertise: { type: 'array', items: { type: 'string' }, description: 'Skills with expertise (double proficiency), e.g. ["巧手","隐匿"].' },
      spells: {
        type: 'array',
        description: 'Spells the character knows or has prepared, replacing the list. Fill it whenever a caster\'s sheet is '
          + 'written or levels up: players open it from the 「我的法术」 turn button, each with a wiki link. The English '
          + 'wiki link is checked when written; give `en` when the Chinese name is not an SRD spell (脆弱诅咒 → Hex).',
        items: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'Chinese name as the table says it.' },
            level: { type: 'integer', description: '0 for cantrips.' },
            en: { type: 'string', description: 'English name, when the Chinese one is not in the SRD table.' },
          },
          required: ['name', 'level'],
          additionalProperties: false,
        },
      },
      add_spells: { type: 'array', description: 'Spells learned (same shape as spells); replaces one of the same name.', items: { type: 'object' } },
      remove_spells: { type: 'array', items: { type: 'string' }, description: 'Spells forgotten or swapped out, by name.' },
      add_items: { type: 'array', items: { type: 'string' }, description: 'Items picked up. For non-module/homebrew magic items, cap rarity by party level (L1-4 Common/Uncommon, L5-6 Uncommon max +1, L7-10 Rare) and check existing party gear first; never stack +2/+3 with extra spell effects at low-mid levels.' },
      remove_items: { type: 'array', items: { type: 'string' }, description: 'Items used up or handed over.' },
      gp_change: { type: 'integer', description: 'Gold gained (+) or spent (-).' },
      kind: {
        type: 'string',
        enum: ['pc', 'npc', 'monster'],
        description: 'npc = on the party\'s side. Anyone fighting the party, named villains included, is monster: npc cards count as allies, so their AC and HP show and reactions against them are not offered.',
      },
      player: { type: 'string', description: 'Player nickname in the group (PCs).' },
      player_id: { type: 'string', description: 'Player member id from their tag "[昵称 #U3]" (pass "U3") (PCs). Binds the PC so only this player can act for it.' },
      class_name: { type: 'string', description: 'e.g. 战士 / 法师 / 游荡者' },
      level: { type: 'integer' },
      str: { type: 'integer' }, dex: { type: 'integer' }, con: { type: 'integer' },
      int: { type: 'integer' }, wis: { type: 'integer' }, cha: { type: 'integer' },
      skills: { type: 'array', items: { type: 'string' }, description: 'Proficient skills, e.g. ["察觉","隐匿"].' },
      saves: { type: 'array', items: { type: 'string' }, description: 'Proficient saves, e.g. ["力量","体质"].' },
      max_hp: { type: 'integer' },
      max_hp_change: {
        type: 'integer',
        description: 'Raise or lower max HP by this much (Aid +5, ending it -5). A raise also adds the same to current HP; '
          + 'current HP never exceeds the new max. Use this with `names`, since each character\'s max differs.',
      },
      ac: { type: 'integer' },
      init_bonus: {
        type: 'integer',
        description: 'Fixed TOTAL initiative modifier, replacing Dexterity-only calculation (e.g. dex + Temporal Awareness/Jack of All Trades/Alert). Persist after checking the sheet; do not add it again via initiative bonus. Temporary dice such as Gift of Alacrity go in dnd_initiative start bonus, never here. Changing this does not rewrite already-rolled initiative.',
      },
      attack_bonus: { type: 'integer', description: 'Monsters/NPCs; PCs use ability + proficiency.' },
      damage: { type: 'string', description: 'Monsters/NPCs: default attack damage, e.g. "1d8+3".' },
      weapons: {
        type: 'array',
        description: 'PC weapons (replaces the list). damage is the weapon die only: 巨斧 1d12, 长剑 1d8, 刺剑 1d8 (dex), 短弓 1d6 (dex).',
        items: {
          type: 'object',
          properties: {
            name: { type: 'string' },
            damage: { type: 'string' },
            ability: { type: 'string', enum: ['str', 'dex'] },
            notes: { type: 'string', description: 'damage type, properties, range' },
            magic: { type: 'integer', description: '+N magic weapon: added to hit AND damage automatically.' },
            proficient: { type: 'boolean', description: 'false when the wielder lacks proficiency (no proficiency bonus to hit).' },
            ranged: { type: 'boolean', description: 'Ranged weapon (Archery applies). Default: name contains 弓/弩.' },
            two_handed: { type: 'boolean', description: 'Wielded two-handed (Great Weapon Fighting applies). Default: notes contain 双手.' },
          },
          required: ['name', 'damage'],
          additionalProperties: false,
        },
      },
      notes: { type: 'string', description: 'Replaces ALL notes. Read current notes and preserve unrelated abilities, passives, active effects and agreements when editing. Notes alone do not apply mechanical bonuses; use supported structured fields too.' },
      brief: { type: 'boolean', description: 'For show: one line (HP, AC, conditions, resources, room) instead of the full sheet.' },
    },
    ['action'],
    async (args, exec) => {
      const action = String(args.action);
      const key = recordOf(exec).sessionKey;
      const { campaign } = service.active(key) ?? service.saved(key) ?? service.require(key);
      assertPausedSheet(campaign, args);
      if (action === 'list' || action === 'show') {
        if (action === 'list') {
          const visible = campaign.active ? campaign.characters : campaign.characters.filter((ch) => ch.kind === 'pc');
          return visible.length === 0
            ? '还没有角色。'
            : visible.map((ch) => `${ch.name}${ch.player ? `〈${ch.player}〉` : ''} ${ch.kind} HP ${ch.hp}/${ch.maxHp}${roomOf(campaign, ch) ? ` @${roomOf(campaign, ch)}` : ''}`).join('\n');
        }
        const several = strList(args.names);
        if (several !== undefined && several.length > 0) {
          // 一次看几个人只给一行摘要：整张卡连着贴几张，比分开调还费上下文
          return several.map((n) => characterBrief(campaign, requireCharacter(campaign, n))).join('\n');
        }
        const target = requireCharacter(campaign, String(args.name ?? ''));
        return args.brief === true ? characterBrief(campaign, target) : sheet(target, whoOf(exec), campaign);
      }
      // SRD 数据先取回来（网络请求不能放进同步的 mutate 里）
      const srdIndex = action === 'create' ? str(args.srd) : undefined;
      const srdBase = srdIndex === undefined ? undefined : srdMonsterInput(await requireSrd('monsters', srdIndex));
      // 法术链接要联网验，放在改存档之前：验不过整张卡都不动
      const spellArgs = args.spells === undefined ? undefined : parseSpellInputs(args.spells, 'spells');
      const addSpellArgs = args.add_spells === undefined ? undefined : parseSpellInputs(args.add_spells, 'add_spells');
      const spellNotes: string[] = [];
      let newSpells: CardSpell[] | undefined;
      let addSpells: CardSpell[] = [];
      if (spellArgs !== undefined || addSpellArgs !== undefined) {
        const list = await srdList('spells');
        const slugOf = (name: string): string | undefined => {
          const r = resolveSrdQuery(name, list, zhTable('spells'));
          return r.kind === 'exact' ? r.index : undefined;
        };
        if (spellArgs !== undefined) {
          const r = await resolveSpells(spellArgs, slugOf, deps.checkUrl);
          newSpells = r.spells;
          spellNotes.push(...r.notes);
        }
        if (addSpellArgs !== undefined) {
          const r = await resolveSpells(addSpellArgs, slugOf, deps.checkUrl);
          addSpells = r.spells;
          spellNotes.push(...r.notes);
        }
      }
      const removeSpells = strList(args.remove_spells) ?? [];
      /** 改一张卡，返回给模型看的文字。抛错时整次调用不落盘，批量改到一半失败也不会只改了前几个 */
      const applyOne = (c: Campaign, adventure: Adventure, name: string | undefined): string => {
        if (name === undefined) throw new Error('dnd_character: name 不能为空');
        if (args.room !== undefined || action === 'remove') assertNoPending(c, '换房间或移除角色');
        if (action === 'update' && str(args.room) !== undefined && args.forced_move !== true) assertCombatExit(c, requireCharacter(c, name), String(args.room));
        if (action === 'remove') return `已移除 ${removeCharacter(c, name).name}`;
        if (action === 'create' && str(args.kind) !== 'pc') {
          // 11-05 黑蜘蛛被现场建成「黑蜘蛛·内兹纳尔」，死讯没挂到模组的内兹纳上，神庙的剧本还让他再出场一次
          const npc = moduleNpcNamed(c, adventure, name);
          if (npc !== undefined && !npcAlive(c, npc.id)) throw new Error(`「${name}」是模组里的具名 NPC ${npc.name}(${npc.id})。${reviveHint(npc)}`);
          if (npc !== undefined) {
            throw new Error(`「${name}」是模组里的具名 NPC ${npc.name}(${npc.id})：上场用 dnd_story npc ${npc.id} fight=true（同行用 join=true），数据照模组。确实是另一个生物就换个不含「${npc.name}」和他别名的名字。`);
          }
        }
        if (action === 'update' && findCharacter(c, name) === undefined) throw new Error(`找不到角色「${name}」，要新建用 create`);
        const abilities: Partial<Record<Ability, number>> = { ...srdBase?.abilities };
        for (const a of ABILITIES) {
          const v = int(args[a]);
          if (v !== undefined) abilities[a] = v;
        }
        const input: CharacterInput = { ...srdBase, name: action === 'update' ? requireCharacter(c, name).name : name, abilities };
        const kind = str(args.kind) ?? (srdBase !== undefined ? 'monster' : undefined);
        if (kind !== undefined) input.kind = kind as CharacterKind;
        const optional = {
          player: str(args.player), playerId: memberId(exec, args.player_id, 'player_id'), className: str(args.class_name), level: int(args.level), maxHp: int(args.max_hp),
          ac: int(args.ac), initBonus: int(args.init_bonus), attackBonus: int(args.attack_bonus), damage: str(args.damage), notes: str(args.notes),
          skills: parseSkills(strList(args.skills)), expertise: parseSkills(strList(args.expertise)), saves: parseAbilities(strList(args.saves)),
          weapons: parseWeapons(args.weapons), room: str(args.room), hitDie: str(args.hit_die), traits: strList(args.traits), speed: int(args.speed), reactions: parseReactions(args.reactions),
        };
        for (const [k, v] of Object.entries(optional)) {
          if (v !== undefined) (input as unknown as Record<string, unknown>)[k] = v;
        }
        // 新建的怪物/NPC 默认放在队伍主位置，才会进这个房间的先攻
        if (action === 'create' && input.room === undefined && input.kind !== undefined && input.kind !== 'pc') input.room = c.currentRoom;

        const count = action === 'create' ? Math.min(Math.max(int(args.count) ?? 1, 1), 20) : 1;
        if (count > 1) {
          const names = numberedNames(c, name, count);
          const made = names.map((n) => upsertCharacter(c, { ...input, name: n }).character);
          return `已建卡 ${made.length} 个：${names.join('、')}\n${sheet(made[0]!, whoOf(exec), c)}`;
        }
        if (action === 'create' && findCharacter(c, name)?.name === name) throw new Error(`已经有「${name}」了，改数据用 update，再加一只换个名字或传 count`);
        const roomsBefore = fightRooms(c);
        const { character, created } = upsertCharacter(c, input);
        const lines = [`${created ? '已建卡' : '已更新'}：`];
        // 战斗中换到交战房间以外（逃跑、去报信）：移出先攻表，不然它会一直占着回合
        const newRoom = str(args.room);
        if (!created && newRoom !== undefined && inInitiative(c, character.name) && !roomsBefore.has(newRoom)) {
          const wasCurrent = c.initiative!.order[c.initiative!.turn]?.name === character.name;
          leaveInitiative(c, character.name);
          lines.unshift(`${character.name} 离开了交战区域，已移出先攻表${wasCurrent ? '；它的回合到此结束，接着调用 dnd_initiative next' : ''}。`);
        }
        const add = strList(args.add_items) ?? [];
        const remove = strList(args.remove_items) ?? [];
        const gp = int(args.gp_change) ?? 0;
        if (add.length > 0 || remove.length > 0 || gp !== 0) changeInventory(c, character.name, add, remove, gp);
        const itemHint = add.length > 0 ? hookHint(c, add.join('\n')) : undefined;
        if (newSpells !== undefined || addSpells.length > 0 || removeSpells.length > 0) {
          const ch = requireCharacter(c, character.name);
          ch.spells = mergeSpells(newSpells ?? ch.spells ?? [], addSpells, removeSpells);
        }
        const maxHpChange = int(args.max_hp_change) ?? 0;
        if (maxHpChange !== 0) {
          const ch = requireCharacter(c, character.name);
          ch.maxHp = Math.max(1, ch.maxHp + maxHpChange);
          // 倒地的人不靠加上限站起来：那是治疗的事
          if (maxHpChange > 0 && ch.hp > 0) ch.hp += maxHpChange;
          ch.hp = Math.min(ch.hp, ch.maxHp);
        }
        lines.push(sheet(requireCharacter(c, character.name), whoOf(exec), c));
        if (spellNotes.length > 0) lines.push(`【DM】${spellNotes.join('；')}`);
        if (itemHint !== undefined) lines.push(itemHint);
        return lines.join('\n');
      };
      return mutate(exec, (c, adventure) => {
        // 法术链接校验会等待网络；这期间可能收团，落盘前按最新状态再检查。
        assertPausedSheet(c, args);
        const several = strList(args.names);
        if (several === undefined || several.length === 0) return applyOne(c, adventure, str(args.name));
        if (action !== 'update') throw new Error('names 只用于 update 和 show。一次建多只怪用 count，移除一个个来');
        // 这些字段是某一个人自己的，批量套给所有人一定是填错了
        const personal = ['name', 'player', 'player_id', 'weapons', 'spells', 'add_spells', 'remove_spells', 'reactions', 'max_hp', 'class_name']
          .filter((key) => args[key] !== undefined);
        if (personal.length > 0) throw new Error(`带 names 批量改时不能给 ${personal.join('、')}：这些是单个人的，分开改（上限统一加减用 max_hp_change）`);
        for (const who of several) applyOne(c, adventure, who);
        return `已更新 ${several.length} 个：\n${several.map((who) => characterBrief(c, requireCharacter(c, who))).join('\n')}`;
      }, { allowPaused: true });
    },
  );

  register(
    'dnd_resource',
    'Track limited-use resources: spell slots (e.g. "1环法术位"), lay on hands pool ("圣疗池"), bardic inspiration '
    + '("诗人激励"), class features ("战争祭司"), potions. set: create or change max; use: spend (fails if not enough); '
    + 'restore: give back (omit amount to refill). Set the max the first time a resource comes up. Spend only when the owning player says they use it. '
    + 'Reactions are a built-in 0/1 combat resource, shown on dnd_character show and restored at the actor\'s next turn; do not create a second resource or spend it separately. Reaction tools account for it automatically. '
    + 'While paused, only set on a PC is allowed, to configure a sheet without starting play; use/restore require an active adventure.',
    {
      action: { type: 'string', enum: ['set', 'use', 'restore'] },
      character: { type: 'string' },
      resource: { type: 'string' },
      amount: { type: 'integer', description: 'use/restore: how much (default 1 / refill). For lay on hands, the HP spent.' },
      max: { type: 'integer', description: 'For set.' },
      current: { type: 'integer', description: 'For set: current value (default: full for a new resource).' },
      reset: { type: 'string', enum: ['short', 'long', 'none'], description: 'For set: which rest refills it.' },
    },
    ['action', 'character', 'resource'],
    (args, exec) => mutate(exec, (c) => {
      const name = String(args.character ?? '');
      const key = String(args.resource ?? '');
      if (/^(反应|reaction)$/i.test(key.trim())) throw new Error('反应由战斗工具按 0/1 自动记账，在自己下回合开始恢复；不要用 dnd_resource 重复创建、消耗或恢复。用 dnd_character show 查看');
      const action = String(args.action);
      if (!c.active && (action !== 'set' || requireCharacter(c, name).kind !== 'pc')) {
        throw new Error('停团时只能用 dnd_resource set 配置 PC 资源；消耗和恢复请开团后操作');
      }
      if (action === 'set') {
        const max = int(args.max);
        if (max === undefined) throw new Error('dnd_resource set 需要 max');
        const reset = args.reset === 'short' || args.reset === 'none' ? args.reset : 'long';
        const r = setResource(c, name, key, max, reset, int(args.current));
        return `${requireCharacter(c, name).name}「${key.trim()}」${r.current}/${r.max}`;
      }
      const result = action === 'use'
        ? useResource(c, name, key, int(args.amount) ?? 1)
        : restoreResource(c, name, key, int(args.amount));
      return `${requireCharacter(c, name).name}「${result.key}」${result.before}→${result.resource.current}/${result.resource.max}`;
    }, { allowPaused: true }),
  );

  register(
    'dnd_rest',
    'Short or long rest for the party (or the listed characters). short: refills short-rest resources; spend hit dice '
    + 'with `hit_dice` ({"卡厄斯": 1}), the tool rolls and heals. long: full HP, all resources, half the hit dice back. '
    + 'Not during combat.',
    {
      kind: { type: 'string', enum: ['short', 'long'] },
      characters: { type: 'array', items: { type: 'string' }, description: 'Omit for everyone in the party.' },
      hit_dice: { type: 'object', additionalProperties: { type: 'integer' }, description: 'short rest: character → dice to spend.' },
    },
    ['kind'],
    (args, exec) => mutate(exec, (c) => {
      const spend: Record<string, number> = {};
      if (args.hit_dice !== null && typeof args.hit_dice === 'object') {
        for (const [k, v] of Object.entries(args.hit_dice as Record<string, unknown>)) {
          const n = int(v);
          if (n !== undefined && n > 0) spend[k] = n;
        }
      }
      const kind = args.kind === 'long' ? 'long' : 'short';
      const results = rest(c, kind, strList(args.characters), spend, service.roller);
      return `${kind === 'long' ? '长休' : '短休'}完成：\n${results.map((r) => `${r.name}：${r.lines.join('，') || '无变化'}`).join('\n')}`;
    }),
  );
}
