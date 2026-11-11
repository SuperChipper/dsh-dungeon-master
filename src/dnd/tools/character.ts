/** 角色卡与资源：dnd_character、dnd_resource、dnd_rest。 */
import {
type CharacterInput,type CharacterKind,changeInventory,findCharacter,inInitiative,fightRooms,leaveInitiative,removeCharacter,requireCharacter,rest,
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

export function registerCharacterTools(kit: ToolKit): void {
  const { deps, service, recordOf, mutate, memberId, whoOf, register } = kit;

  register(
    'dnd_character',
    'Create, update, show, list or remove character sheets (PCs, NPCs, extra monsters). Ability scores default to 10. '
    + 'Bind a PC to the player\'s group nickname with `player` and `player_id` so they can only act for their own character. '
    + 'New PC: ask name and class, then create with weapons, hit_die and the reactions that change attacks (standard array '
    + '15/14/13/12/10/8 if they want help), and set spell slots / class resources with dnd_resource set. '
    + 'Improvised monsters: pass `srd` (e.g. "goblin") to take real stats from the SRD and `count` for several '
    + '(named 地精1, 地精2…); they are placed in the party\'s current room unless `room` is given.',
    {
      action: { type: 'string', enum: ['create', 'update', 'show', 'list', 'remove'] },
      name: { type: 'string' },
      srd: { type: 'string', description: 'For create: SRD monster index; fills AC/HP/abilities/attack from dnd5eapi.' },
      count: { type: 'integer', description: 'For create: how many copies (numbered names).' },
      room: {
        type: 'string',
        description: 'Room id the character is in (monsters; PCs that split off). Moving a monster in combat to a room '
          + 'outside the fight (fleeing, running for help) also takes it out of the initiative order.',
      },
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
      ac: { type: 'integer' },
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
      notes: { type: 'string' },
      brief: { type: 'boolean', description: 'For show: one line (HP, AC, conditions, resources, room) instead of the full sheet.' },
    },
    ['action'],
    async (args, exec) => {
      const action = String(args.action);
      if (action === 'list' || action === 'show') {
        const { campaign } = service.require(recordOf(exec).sessionKey);
        if (action === 'list') {
          return campaign.characters.length === 0
            ? '还没有角色。'
            : campaign.characters.map((ch) => `${ch.name}${ch.player ? `〈${ch.player}〉` : ''} ${ch.kind} HP ${ch.hp}/${ch.maxHp}${roomOf(campaign, ch) ? ` @${roomOf(campaign, ch)}` : ''}`).join('\n');
        }
        const target = requireCharacter(campaign, String(args.name ?? ''));
        return args.brief === true ? characterBrief(campaign, target) : sheet(target, whoOf(exec));
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
      return mutate(exec, (c, adventure) => {
        const name = str(args.name);
        if (name === undefined) throw new Error('dnd_character: name 不能为空');
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
          ac: int(args.ac), attackBonus: int(args.attack_bonus), damage: str(args.damage), notes: str(args.notes),
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
          return `已建卡 ${made.length} 个：${names.join('、')}\n${sheet(made[0]!, whoOf(exec))}`;
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
        lines.push(sheet(requireCharacter(c, character.name), whoOf(exec)));
        if (spellNotes.length > 0) lines.push(`【DM】${spellNotes.join('；')}`);
        if (itemHint !== undefined) lines.push(itemHint);
        return lines.join('\n');
      });
    },
  );

  register(
    'dnd_resource',
    'Track limited-use resources: spell slots (e.g. "1环法术位"), lay on hands pool ("圣疗池"), bardic inspiration '
    + '("诗人激励"), class features ("战争祭司"), potions. set: create or change max; use: spend (fails if not enough); '
    + 'restore: give back (omit amount to refill). Set the max the first time a resource comes up. Spend only when the owning player says they use it.',
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
      const action = String(args.action);
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
    }),
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
