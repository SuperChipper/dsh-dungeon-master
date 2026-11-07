/**
 * 待结算的骰子：把「掷骰」和「落账」分开，中间留出反应的时间。
 *
 * 以前 dnd_check 一口气掷命中、掷伤害、扣血，玩家开口时血已经扣了，尖刻言语、护盾术只能事后补偿。
 * 现在有人能反应时，攻击只掷骰、挂在 InitiativeState.pending 上，改完数值再由 dnd_apply settle 落账。
 * 豁免和检定（时间变幻这类「看到成败再决定」的重掷）由 DM 用 hold / hold_for 手动挂起：
 * 「任何 d20」的触发条件（30 尺、看得见、反应名额）硬编码只会天天误弹，交给 DM 判断。
 * 只靠守则提醒模型停手不管用，所以推进回合、再次攻击、提前落账都由工具拒绝。
 */
import {
  type Campaign,
  type Character,
  type PendingAttack,
  type PendingCheck,
  type PendingD20,
  type PendingRoll,
  type ReactorOption,
  describePending,
  findCharacter,
  isOut,
  reactionsOf,
  roomOf,
} from './campaign.ts';
import { canReact, cellOf, distanceFeet } from './battlefield.ts';

export { reactionsOf };

/** 窗口开多久；到时没回的算不用。太短玩家来不及打字，太长一只怪能卡住整桌 */
export const REACTION_WINDOW_MS = 30_000;

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
  const reacted = c.initiative?.reacted ?? [];
  const room = roomOf(c, target);
  const enemyAttack = (attacker.kind === 'monster') !== (target.kind === 'monster');
  const attackerCell = cellOf(c, attacker);
  return c.characters.flatMap((ch) => {
    if (ch.kind !== 'pc' || !canReact(ch) || roomOf(c, ch) !== room) return [];
    const free = !reacted.includes(ch.name);
    return reactionsOf(ch).flatMap((r) => {
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
  const reacted = c.initiative?.reacted ?? [];
  return value.map((raw) => {
    const o = (raw ?? {}) as Record<string, unknown>;
    const by = typeof o.by === 'string' ? o.by.trim() : '';
    const name = typeof o.name === 'string' && o.name.trim().length > 0 ? o.name.trim() : '反应';
    const ch = findCharacter(c, by);
    if (ch === undefined) throw new Error(`hold_for: 找不到角色「${by}」`);
    if (ch.kind !== 'pc' || ch.playerId === undefined) {
      throw new Error(`hold_for 只用来等玩家：${ch.name} 不是绑了玩家的 PC。NPC/怪物的反应由你决定，传 hold=true 后直接 dnd_apply reaction`);
    }
    if (!canReact(ch)) throw new Error(`${ch.name} 现在做不了反应`);
    if (reacted.includes(ch.name)) throw new Error(`${ch.name} 这一轮的反应已经用过了，要到他下个回合开始才恢复`);
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
export function waitingOn(p: PendingRoll): string[] {
  const done = new Set([...p.declined, ...p.used.map((u) => u.by)]);
  return [...new Set(p.reactors.map((r) => r.character))].filter((name) => !done.has(name));
}

function optionsText(p: PendingRoll): string {
  return p.reactors.length > 0 ? p.reactors.map((r) => `${r.character}·${r.reaction}`).join('、') : '（DM 手动挂起）';
}

function rollLine(p: PendingCheck, r: PendingD20): string {
  const passed = rollPassed(p, r);
  const total = `${r.total + r.mod}${r.mod !== 0 ? `（原 ${r.total}）` : ''}`;
  return `${r.name} ${p.label} ${total}${p.dc !== undefined ? ` → ${passed === true ? '成功' : '失败'}` : ''}`;
}

/** 这笔现在的局面，给模型看：只给成败，DC/AC 的数字不给（会被照抄进群里） */
export function pendingState(p: PendingRoll): string {
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
  return `${p.attacker}→${p.target}：${attack}，${damage}`;
}

/** 团况里的一行：压缩之后这笔账靠它才不会丢 */
export function pendingSummaryLine(p: PendingRoll): string {
  const waiting = waitingOn(p);
  const used = p.used.map((u) => `${u.by}·${u.name}`).join('、');
  return `【待结算 #R${p.seq}】${pendingState(p)}。`
    + `${used.length > 0 ? `已用：${used}。` : ''}`
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
    + `玩家回应后用 dnd_apply target=${p.target}：要用就传 ${fix}，不用就传 decline，都答复了传 settle=true。`
    + '落账前 next、再次攻击、豁免效果、移动都会被拒绝。';
}

/** 提前落账时报错；窗口时间到了就不再等没回话的人 */
export function assertWindowClosed(p: PendingRoll, now: number = Date.now()): void {
  const waiting = waitingOn(p);
  const left = p.at + REACTION_WINDOW_MS - now;
  if (waiting.length === 0 || left <= 0) return;
  throw new Error(`反应窗口还开着：还在等 ${waiting.join('、')}（剩约 ${Math.ceil(left / 1000)} 秒）。这条回复先停下问他们；说不用的传 decline，时间到了系统会提醒你。`);
}

/** 记下 PC 点了「不用」或说了不用；不是这笔的可反应者就报错，免得记错人 */
export function declineReaction(p: PendingRoll, name: string): void {
  if (!p.reactors.some((r) => r.character === name)) {
    throw new Error(`${name} 不在这笔的可反应名单里（${optionsText(p)}）`);
  }
  if (!p.declined.includes(name)) p.declined.push(name);
}

/** 这个玩家的角色 */
function charactersOf(c: Campaign, senderId: string): Character[] {
  return c.characters.filter((ch) => ch.playerId === senderId && !isOut(ch));
}

const DECLINE_REPLY = /^(不用|不用了|不反应|不了|没有|没|算了|跳过|过|pass|no)[。.!！~～]*$/i;
const GENERIC_REACTION = /反应|尖刻言语|护盾术|导引打击|招架|反制法术|幸运点|重掷|重骰|时间变幻/;

export interface ReactionReply {
  kind: 'use' | 'decline';
  /** 发这条消息的玩家在这笔名单里的角色；名单外的玩家为空 */
  characters: string[];
}

/**
 * 待结算期间，这条玩家消息是不是在回应反应询问。斜杠命令和闲聊返回 undefined。
 * 「不用」这种短答只认名单里的人，否则群里随口一句「算了」都会被当成回应。
 */
export function classifyReactionReply(c: Campaign, senderId: string, text: string): ReactionReply | undefined {
  const p = c.initiative?.pending;
  if (p === undefined) return undefined;
  const clean = text.replace(/<@!?[^>]*>/g, '').trim();
  if (clean.length === 0 || clean.startsWith('/')) return undefined;
  const mine = charactersOf(c, senderId);
  if (mine.length === 0) return undefined;
  const listed = [...new Set(p.reactors.map((r) => r.character))].filter((name) => mine.some((ch) => ch.name === name));
  if (listed.length > 0 && DECLINE_REPLY.test(clean)) return { kind: 'decline', characters: listed };
  // DM 点名问的反应（时间变幻）不在角色卡的 reactions 里，名字从名单上认
  const named = mine.some((ch) => reactionsOf(ch).some((r) => clean.includes(r.name)))
    || p.reactors.some((r) => listed.includes(r.character) && clean.includes(r.reaction));
  return named || GENERIC_REACTION.test(clean) ? { kind: 'use', characters: listed } : undefined;
}

/** 接在玩家消息后面的系统标记：没带 (@you) 也算数，也不是新的回合行动 */
export function reactionReplyNote(c: Campaign, reply: ReactionReply): string {
  const p = requirePending(c);
  const who = reply.characters.join('、');
  const what = describePending(p);
  if (reply.kind === 'decline') {
    return `[系统 · 待结算] 这条是在回答「${what}」那笔的反应询问，不是回合行动：用 dnd_apply target=${p.target} decline=["${who}"] 记下；都答复了再 settle=true。`;
  }
  return `[系统 · 待结算] 这条按对「${what}」那笔的反应处理（没带 @ 也算），不是新的回合行动，也不要 next：`
    + `用 dnd_apply target=${p.target} reaction={by, name, attack_mod/ac_mod/damage_mod 或 reroll:"d20", spend} 改数值，declared_by 填他的编号。`;
}

/** 这个反应会不会占掉角色本轮的反应：导引打击这类是自己攻击时用的，不算 */
export function consumesReaction(p: PendingRoll, by: string): boolean {
  return p.kind !== 'attack' || by !== p.attacker;
}

export function findReactor(c: Campaign, p: PendingRoll, name: string): Character {
  const ch = findCharacter(c, name);
  if (ch === undefined) throw new Error(`找不到角色「${name}」`);
  if (consumesReaction(p, ch.name) && (c.initiative?.reacted ?? []).includes(ch.name)) {
    throw new Error(`${ch.name} 这一轮的反应已经用过了，要到他下个回合开始才恢复`);
  }
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
