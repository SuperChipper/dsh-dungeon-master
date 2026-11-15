/**
 * 待结算的骰子：把「掷骰」和「落账」分开，中间留出反应的时间。
 *
 * 以前 dnd_check 一口气掷命中、掷伤害、扣血，玩家开口时血已经扣了，尖刻言语、护盾术只能事后补偿。
 * 现在有人能反应时，攻击只掷骰、挂在 InitiativeState.pending 上，改完数值再由 dnd_apply settle 落账。
 * 豁免和检定（时间变幻这类「看到成败再决定」的重掷）由 DM 用 hold / hold_for 手动挂起：
 * 「任何 d20」的触发条件（30 尺、看得见、反应名额）硬编码只会天天误弹，交给 DM 判断。
 * 只靠守则提醒模型停手不管用，所以推进回合、再次攻击、提前落账都由工具拒绝。
 */
import { randomUUID } from 'node:crypto';
import {
  type Campaign,
  type Character,
  type PendingAttack,
  type PendingCheck,
  type PendingD20,
  type PendingRoll,
  type ReactionWindow,
  type ReactorOption,
  describePending,
  findCharacter,
  inInitiative,
  isOut,
  reactionBlocked,
  reactionWindow,
  requireCharacter,
  reactionsOf,
  roomOf,
} from './campaign.ts';
import { canReact, cellOf, distanceFeet } from './battlefield.ts';

export { reactionsOf };

function hasResource(ch: Character, key: string | undefined): boolean {
  if (key === undefined) return true;
  const resource = ch.resources?.[key];
  // 卡上没记这项资源就不拦：只是没登记，不等于用完了
  return resource === undefined || resource.current > 0;
}

export interface AttackOutcome {
  hit: boolean;
  crit: boolean;
  natural: number;
}

/**
 * 此刻能对这次攻击做点什么的 PC。只看绑了玩家的 PC：NPC 和怪物的反应由 DM 决定，
 * 不该为它们停下来等群里的人。天然 1 改不了，重击挡不掉（尖刻言语还能减伤害）。
 */
export function eligibleReactors(c: Campaign, attacker: Character, target: Character, outcome: AttackOutcome): ReactorOption[] {
  if (outcome.natural === 1) return [];
  const room = roomOf(c, target);
  const enemyAttack = (attacker.kind === 'monster') !== (target.kind === 'monster');
  const attackerCell = cellOf(c, attacker);
  return c.characters.flatMap((ch) => {
    if (ch.kind !== 'pc' || !canReact(ch) || roomOf(c, ch) !== room) return [];
    if (c.initiative !== undefined && !inInitiative(c, ch.name)) return [];
    // 用过反应或受惊：反手一击、挡攻击这类都不行（天赋类「自己攻击时」的不占反应，不受影响）
    const free = reactionBlocked(c, ch.name) === undefined;
    return reactionsOf(ch).flatMap((r) => {
      if (r.enter === true) return [];
      if (!hasResource(ch, r.resource)) return [];
      if (r.range !== undefined) {
        // 没摆位就不按距离筛：宁可多问一句，也别把够得着的人漏掉
        const mine = cellOf(c, ch);
        if (mine !== undefined && attackerCell !== undefined && distanceFeet(mine, attackerCell) > r.range) return [];
      }
      const when = r.when ?? 'foe_attacks';
      const fits = when === 'attacking'
        ? ch.name === attacker.name && !outcome.hit
        : r.counter === true
          // 哨兵这类「反手一击」：看的是有人对别人出手，不看有没有打中
          ? free && enemyAttack && attacker.kind === 'monster' && ch.name !== attacker.name && ch.name !== target.name
          : when === 'attacked'
            ? free && ch.name === target.name && outcome.hit && !outcome.crit
            : free && enemyAttack && attacker.kind === 'monster' && outcome.hit;
      return fits ? [{ character: ch.name, reaction: r.name }] : [];
    });
  });
}

/**
 * DM 用 hold_for 点名要问的人。在掷骰之前校验：校验失败时什么都还没掷，
 * 不会出现「掷完发现参数不对、重来一次换个点数」。
 */
export function manualReactors(c: Campaign, value: unknown): ReactorOption[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error('hold_for 要是数组，如 [{by:"奇塔露", name:"时间变幻"}]');
  return value.map((raw) => {
    const o = (raw ?? {}) as Record<string, unknown>;
    const by = typeof o.by === 'string' ? o.by.trim() : '';
    const name = typeof o.name === 'string' && o.name.trim().length > 0 ? o.name.trim() : '反应';
    const ch = findCharacter(c, by);
    if (ch === undefined) throw new Error(`hold_for: 找不到角色「${by}」`);
    if (ch.kind !== 'pc' || ch.playerId === undefined) {
      throw new Error(`hold_for 只用来等玩家：${ch.name} 不是绑了玩家的 PC。NPC/怪物的反应由你决定，传 hold=true 后直接 dnd_apply reaction`);
    }
    if (c.initiative !== undefined && !inInitiative(c, ch.name)) {
      throw new Error(`${ch.name} 不在当前战斗的参战名单（先攻表）里，不能加入反应；如确已中途参战请先调用 dnd_initiative join`);
    }
    if (!canReact(ch)) throw new Error(`${ch.name} 现在做不了反应`);
    const blocked = reactionBlocked(c, ch.name);
    if (blocked !== undefined) throw new Error(blocked);
    return { character: ch.name, reaction: name, manual: true };
  });
}

/** 合并名单：同一个人的同一个反应只问一次 */
export function mergeReactors(...lists: ReactorOption[][]): ReactorOption[] {
  const out: ReactorOption[] = [];
  for (const r of lists.flat()) {
    if (!out.some((o) => o.character === r.character && o.reaction === r.reaction)) out.push(r);
  }
  return out;
}

/** 改完数值后现在算不算命中；天然 20 必中、天然 1 必失 */
export function pendingHit(p: PendingAttack): boolean {
  if (p.crit) return true;
  return p.natural !== 1 && p.total + p.attackMod >= p.ac + p.acMod;
}

/** 豁免/检定的这一骰现在过没过；没给 DC 时不知道 */
export function rollPassed(p: PendingCheck, r: PendingD20): boolean | undefined {
  return p.dc === undefined ? undefined : r.total + r.mod >= p.dc;
}

export function requirePending(c: Campaign): PendingRoll {
  const p = c.initiative?.pending;
  if (p === undefined) throw new Error('现在没有待结算的骰子');
  return p;
}

/** 还要等谁：点了要用但效果还没结算的也算在等 */
export function waitingOn(p: ReactionWindow): string[] {
  const done = new Set([...p.declined, ...p.used.map((u) => u.by)]);
  return [...new Set(p.reactors.map((r) => r.character))].filter((name) => !done.has(name));
}

function optionsText(p: ReactionWindow): string {
  return p.reactors.length > 0 ? p.reactors.map((r) => `${r.character}·${r.reaction}`).join('、') : '（DM 手动挂起）';
}

function rollLine(p: PendingCheck, r: PendingD20): string {
  const passed = rollPassed(p, r);
  const total = `${r.total + r.mod}${r.mod !== 0 ? `（原 ${r.total}）` : ''}`;
  return `${r.name} ${p.label} ${total}${p.dc !== undefined ? ` → ${passed === true ? '成功' : '失败'}` : ''}`;
}

/** 这笔现在的局面，给模型看：只给成败，DC/AC 的数字不给（会被照抄进群里） */
export function pendingState(p: ReactionWindow): string {
  if (p.kind === 'move') return `${p.target} 暂停在借机触发处，剩余移动还没执行`;
  if (p.kind === 'roll') {
    const damage = p.damage === undefined
      ? ''
      : `；伤害 ${Math.max(0, p.damage.total + p.damageMod)}${p.damageMod !== 0 ? `（原 ${p.damage.total}）` : ''}（成功${p.damage.onSave === 'none' ? '无伤' : '减半'}），还没扣血`;
    const onFail = p.onFail !== undefined && p.onFail.length > 0 ? `；失败的人落账时得「${p.onFail.join('、')}」` : '';
    return `${p.attacker !== p.target || p.rolls.length > 1 ? `${p.attacker} 的效果：` : ''}${p.rolls.map((r) => rollLine(p, r)).join('；')}${damage}${onFail}`;
  }
  const hit = pendingHit(p);
  const attack = `攻击 ${p.total + p.attackMod}${p.attackMod !== 0 ? `（原 ${p.total}）` : ''}`;
  const damage = !hit
    ? '未命中，落账时不扣血'
    : p.rawDamage === undefined
      ? '命中，落账时掷伤害'
      : `命中，伤害 ${Math.max(0, p.rawDamage + p.damageMod)}${p.damageMod !== 0 ? `（原 ${p.rawDamage}）` : ''}，还没扣血`;
  return `${p.attacker}→${p.target}：${attack}，${damage}${p.onHit !== undefined ? `；预先授权${p.onHit.criticalOnly ? '重击才' : '最终命中才'}用「${p.onHit.name}」（${p.onHit.spend}），未消耗` : ''}`;
}

/** 团况里的一行：压缩之后这笔账靠它才不会丢 */
export function pendingSummaryLine(p: ReactionWindow): string {
  const waiting = waitingOn(p);
  const used = p.used.map((u) => `${u.by}·${u.name}`).join('、');
  return `【待结算 #R${p.seq}】${pendingState(p)}。`
    + `${used.length > 0 ? `已用：${used}。` : ''}`
    + `${p.declined.length > 0 ? `本人已拒绝/已跳过：${p.declined.join('、')}。` : ''}`
    + p.claimed.map((r) => `本人已授权 ${r.character}·${r.reaction}（authorization="${r.authorization ?? '旧确认无凭证，请本人重新确认'}"，仅限本次窗口）。`).join('')
    + `${waiting.length > 0 ? `还在等：${waiting.join('、')}。` : ''}`
    + `落账用 dnd_apply target=${p.target} settle=true；落账前不能推进回合。`;
}

/**
 * dnd_check 自己带的那句话：模型读到结果的同时就知道不能往下走。
 * 成败要告诉玩家：重掷类反应按规则就是看到成败才决定，这里只能泄露一次，DC/AC 的数字仍然不报。
 */
export function holdNotice(p: PendingRoll): string {
  const unsettled = p.kind === 'attack'
    ? '血没扣'
    : p.damage !== undefined || (p.onFail?.length ?? 0) > 0 ? '伤害和状态都还没落' : '后果先别演';
  const fix = p.kind === 'attack'
    ? 'reaction 改数值（attack_mod/ac_mod/damage_mod，或 reroll="d20" 重掷）'
    : `reaction 改数值（attack_mod 加减这一骰，或 reroll="d20" 重掷；target 填被改的那个掷骰人）`;
  return `【待结算 #R${p.seq}】这笔还没落账，别往下推进：${unsettled}。这条回复报骰子和成败（规则要求先知道成败再决定，DC/AC 数字照样不报），`
    + `问一句有没有人要用反应（可用：${optionsText(p)}），然后到此停下，不要写成后果已经发生。`
    + `玩家回应后用 dnd_apply target=${p.target}：要用就传 ${fix}，并原样附上服务器消息的 authorization（玩家编号不等于同意）；不用已由服务器登记，都答复了传 settle=true。`
    + '落账前 next、再次攻击、豁免效果、移动都会被拒绝。';
}

/**
 * 还有人没答复时不能落账。以前 30 秒没回就算不用，可群里打字慢、想规则的人常被这样吃掉反应，现在不限时。
 * 玩家离开了（一直不回）由 DM 传 decline 替他跳过。
 */
export function assertWindowClosed(p: ReactionWindow): void {
  const waiting = waitingOn(p);
  if (waiting.length === 0) return;
  throw new Error(`反应窗口还开着：还在等 ${waiting.join('、')}。这条回复先停下问他们，不限时；说不用的、或者人一直不在的，传 decline 跳过（替不在的人跳过要在回复里说一句）。`);
}

/** 记下 PC 点了「不用」或说了不用；不是这笔的可反应者就报错，免得记错人 */
export function declineReaction(p: ReactionWindow, name: string): void {
  if (!p.reactors.some((r) => r.character === name)) {
    throw new Error(`${name} 不在这笔的可反应名单里（${optionsText(p)}）`);
  }
  if (p.used.some((r) => r.by === name)) throw new Error(`${name} 的反应已经结算，不能改成不用`);
  if (p.claimed.some((r) => r.character === name)) throw new Error(`${name} 本人已经选择反应，DM 不能替他改成不用；请等本人改选`);
  if (!p.declined.includes(name)) p.declined.push(name);
}

/** 只从真实玩家入站/按钮调用，不能让模型用 declared_by 自签授权。 */
export function chooseReaction(c: Campaign, p: ReactionWindow, senderId: string, name: string, reaction?: string): ReactorOption | undefined {
  const ch = requireCharacter(c, name);
  if (ch.kind !== 'pc' || ch.playerId !== senderId) throw new Error('只能由角色的玩家本人选择反应');
  const option = p.reactors.find((r) => r.character === ch.name && (reaction === undefined || r.reaction === reaction));
  if (option === undefined) throw new Error(`${ch.name} 不在这笔的对应反应名单里`);
  if (p.used.some((r) => r.by === ch.name)) throw new Error(`${ch.name} 的反应已经结算`);
  p.claimed = p.claimed.filter((r) => r.character !== ch.name);
  p.declined = p.declined.filter((n) => n !== ch.name);
  if (reaction === undefined) {
    p.declined.push(ch.name);
    return undefined;
  }
  const grant = { ...option, authorization: randomUUID() };
  p.claimed.push(grant);
  return grant;
}

/** 在资源、随机数和反应名额发生变化之前检查，过期/撤回的排队调用不能扣账。 */
export function assertReactionAuthorized(p: ReactionWindow, ch: Character, name: string, authorization: unknown): void {
  if (p.declined.includes(ch.name)) throw new Error(`${ch.name} 本人已选择不用，不能结算反应或扣资源；需要本人重新确认`);
  if (ch.kind !== 'pc' || ch.playerId === undefined) return;
  if (typeof authorization !== 'string' || !p.claimed.some((r) => r.character === ch.name && r.reaction === name && r.authorization === authorization)) {
    throw new Error(`${ch.name} 的「${name}」没有本次窗口的有效授权。请等本人点按钮或明确说使用；照系统消息传 authorization，declared_by 不能代替同意。遗漏的技能用 dnd_apply ask_reactions=[{by,name}] 询问，不要重掷原骰。`);
  }
}

/** 这个玩家的角色 */
function charactersOf(c: Campaign, senderId: string): Character[] {
  return c.characters.filter((ch) => ch.playerId === senderId && !isOut(ch));
}

function stripCharacterPrefix(text: string, characterName: string): string {
  const short = characterName.trim().split(/\s+/)[0] ?? characterName;
  for (const prefix of [characterName, short]) {
    if (prefix.length > 0 && text.startsWith(prefix)) {
      return text.slice(prefix.length).replace(/^[\s:：,，·]+/, '').trim();
    }
  }
  return text;
}

const DECLINE_REPLY = /^(不用|不用了|不反应|这次不用|跳过反应|pass|no)[。.!！~～]*$/i;
const GENERIC_REACTION = /反应|借机|尖刻言语|护盾术|导引打击|招架|反制法术|幸运点|重掷|重骰|时间变幻/;

export interface ReactionReply {
  kind: 'use' | 'decline' | 'question';
  /** 发这条消息的玩家在这笔名单里的角色；名单外的玩家为空 */
  characters: string[];
  windowId?: number;
  choices?: ReactorOption[];
  grants?: ReactorOption[];
  issue?: string;
}

/**
 * 待结算期间，这条玩家消息是不是在回应反应询问。斜杠命令和闲聊返回 undefined。
 * 「不用」这种短答只认名单里的人，否则群里随口一句「算了」都会被当成回应。
 */
export function classifyReactionReply(c: Campaign, senderId: string, text: string): ReactionReply | undefined {
  const p = reactionWindow(c);
  if (p === undefined) return undefined;
  const clean = text.replace(/<@!?[^>]*>/g, '').trim();
  if (clean.length === 0 || clean.startsWith('/')) return undefined;
  const mine = charactersOf(c, senderId);
  if (mine.length === 0) return undefined;
  const listed = [...new Set(p.reactors.map((r) => r.character))].filter((name) => mine.some((ch) => ch.name === name));
  if (listed.length > 0 && DECLINE_REPLY.test(clean)) return { kind: 'decline', characters: listed, windowId: p.seq };
  // DM 点名问的反应（时间变幻）不在角色卡的 reactions 里，名字从名单上认
  const named = mine.some((ch) => reactionsOf(ch).some((r) => clean.includes(r.name)))
    || p.reactors.some((r) => listed.includes(r.character) && clean.includes(r.reaction));
  const movementUse = p.kind === 'move' && listed.length > 0 && /^(打|攻击|借机攻击)[。.!！]*$/.test(clean);
  if (!named && !GENERIC_REACTION.test(clean) && !movementUse) return undefined;
  const hasQuestionMark = clean.includes('?') || clean.includes('？');
  const myOptions = p.reactors.filter((r) => listed.includes(r.character));
  if (!hasQuestionMark && myOptions.length === 1) {
    const only = myOptions[0]!;
    const at = clean.indexOf(only.reaction);
    if (at >= 0) {
      const before = stripCharacterPrefix(clean.slice(0, at).trim(), only.character);
      const after = clean.slice(at + only.reaction.length).trim();
      if (/^(我)?(这次|这下)?(不用|不开|不放|不交|不施放)$/.test(before) && /^(了|吧)?[。.!！~～]*$/.test(after)) {
        return { kind: 'decline', characters: [only.character], windowId: p.seq };
      }
    }
  }
  const choices = myOptions.filter((r) => clean.includes(r.reaction) || movementUse);
  // 技能名出现在规则提问/纠正里不是宣告；只接收完整、明确的短宣告。
  const explicit = hasQuestionMark ? [] : choices.filter((r) => {
    if (movementUse) return true;
    const nameAt = clean.indexOf(r.reaction);
    const before = stripCharacterPrefix(clean.slice(0, nameAt).trim(), r.character);
    const after = clean.slice(nameAt + r.reaction.length).trim();
    return /^(我)?(这次|这下)?(要|想|决定)?(用|使用|开|交|放|施放|发动)?$/.test(before)
      && /^(吧|了|呗|挡一下|挡|减他|减命中|减伤害|减一下|重掷|重骰)?[。.!！~～]*$/.test(after);
  });
  return explicit.length === 1
    ? { kind: 'use', characters: [explicit[0]!.character], windowId: p.seq, choices: explicit }
    : { kind: 'question', characters: listed, windowId: p.seq };
}

export function recordReactionReply(c: Campaign, senderId: string, reply: ReactionReply, messageId: string): ReactionReply {
  const p = reactionWindow(c);
  if (p === undefined || p.seq !== reply.windowId) return { ...reply, grants: [] };
  const sourceId = `message:${senderId}:${messageId}`;
  if (p.reactionReplyIds?.includes(sourceId)) return { ...reply, kind: 'question', grants: [] };
  (p.reactionReplyIds ??= []).push(sourceId);
  // 讨论也去重：补询问后，旧消息重投不能突然变成对新选项的授权。
  if (reply.kind === 'question') return { ...reply, grants: [] };
  const grants: ReactorOption[] = [];
  const accepted: string[] = [];
  for (const name of reply.characters) {
    if (p.used.some((r) => r.by === name)) continue;
    const choice = reply.choices?.find((r) => r.character === name);
    if (reply.kind === 'use' && choice === undefined) continue;
    const grant = chooseReaction(c, p, senderId, name, reply.kind === 'use' ? choice!.reaction : undefined);
    accepted.push(name);
    if (grant !== undefined) grants.push(grant);
  }
  if (accepted.length === 0) return { ...reply, kind: 'question', grants, issue: '这次反应已经结算，不能事后改成不用；若确需回退，请核对后用 dnd_undo。' };
  return { ...reply, characters: accepted, grants };
}

/** 接在玩家消息后面的系统标记：没带 (@you) 也算数，也不是新的回合行动 */
export function reactionReplyNote(c: Campaign, reply: ReactionReply): string {
  const p = reactionWindow(c)!;
  const who = reply.characters.join('、');
  const what = describePending(p);
  if (reply.issue !== undefined) return `[系统 · 反应讨论] ${reply.issue}`;
  if (reply.kind === 'question' || (reply.kind === 'use' && (reply.grants?.length ?? 0) === 0)) {
    return `[系统 · 反应讨论] 这条涉及「${what}」，但没有新的使用授权。回答规则/澄清选择，不能凭这条扣资源或跳过反应。`;
  }
  if (reply.kind === 'decline') {
    return `[系统 · 待结算] ${who} 本人明确选择不用；已由服务器记下并撤销旧授权。这是「${what}」的答复，不是回合行动；都答复了再 dnd_apply target=${p.target} settle=true。`;
  }
  if (p.kind === 'move') {
    const grant = reply.grants![0]!;
    return `[系统 · 借机] 本人已授权「${grant.reaction}」：用 dnd_check character=${grant.character} type=attack target=${p.target} reaction=true authorization="${grant.authorization}" 结算；所有人答复并结算完后 dnd_apply target=${p.target} settle=true 继续移动。`;
  }
  return `[系统 · 待结算] 这条按对「${what}」那笔的反应处理（没带 @ 也算），不是新的回合行动，也不要 next：`
    + reply.grants!.map((g) => `用 dnd_apply target=${p.target} reaction={by:"${g.character}", name:"${g.reaction}", authorization:"${g.authorization}", attack_mod/ac_mod/damage_mod 或 reroll:"d20", spend} 改数值。`).join(' ');
}

/** 这个反应会不会占掉角色本轮的反应：导引打击这类是自己攻击时用的，不算 */
export function consumesReaction(c: Campaign, p: PendingRoll, by: string, name: string): boolean {
  return !(p.kind === 'attack' && by === p.attacker && reactionsOf(requireCharacter(c, by)).some((r) => r.name === name && r.when === 'attacking'));
}

export function findReactor(c: Campaign, p: PendingRoll, name: string, reactionName: string): Character {
  const ch = findCharacter(c, name);
  if (ch === undefined) throw new Error(`找不到角色「${name}」`);
  if (c.initiative !== undefined && !inInitiative(c, ch.name)) throw new Error(`${ch.name} 不在当前战斗的参战名单里，不能结算反应`);
  if (p.declined.includes(ch.name)) throw new Error(`${ch.name} 本人已选择不用，不能结算反应或扣资源`);
  if (p.used.some((r) => r.by === ch.name && r.name === reactionName)) throw new Error(`${ch.name} 已经对这笔用过「${reactionName}」`);
  const blocked = consumesReaction(c, p, ch.name, reactionName) ? reactionBlocked(c, ch.name) : undefined;
  if (blocked !== undefined) throw new Error(blocked);
  if (!canReact(ch)) throw new Error(`${ch.name} 现在做不了反应`);
  return ch;
}

/**
 * 攻击重掷后成败变了：按新结果重算谁能反应。已经答复过的和 DM 点名的留着，
 * 不再适用的（没中了，尖刻言语就没得用）去掉。返回新加进来的人，有新人要重开窗口。
 */
export function refreshReactors(c: Campaign, p: PendingAttack): ReactorOption[] {
  const attacker = findCharacter(c, p.attacker);
  const target = findCharacter(c, p.target);
  if (attacker === undefined || target === undefined) return [];
  const answered = new Set([...p.declined, ...p.used.map((u) => u.by), ...p.claimed.map((o) => o.character)]);
  const keep = p.reactors.filter((r) => r.manual === true || answered.has(r.character));
  const fresh = eligibleReactors(c, attacker, target, { hit: pendingHit(p), crit: p.crit, natural: p.natural })
    .filter((r) => !answered.has(r.character) && !keep.some((k) => k.character === r.character && k.reaction === r.reaction));
  const before = new Set(p.reactors.map((r) => `${r.character}·${r.reaction}`));
  p.reactors = [...keep, ...fresh];
  return fresh.filter((r) => !before.has(`${r.character}·${r.reaction}`));
}
