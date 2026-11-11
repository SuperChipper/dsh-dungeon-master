/**
 * 背景钩子：玩家给的角色来历里没了结的事（找的人、欠的债、逃开的地方），挂在 PC 卡上，
 * 等剧情里正好沾边时由 DM 拿来用。
 *
 * 为什么不放进守则让 DM 自己记：上一团刻德温的拉西亚背景写在聊天笔记里，跑团时笔记只注入共享的，
 * 整团一次都没被碰到。所以这里由工具在「场景里正好出现触发词」那一步提醒，DM 那一刻正在决定怎么描述。
 * 提醒只是提醒，接不接、接几档由 DM 定；工具只管两件事：第 5 档（那个人亲自出现）要先问过玩家，
 * 3-4 档要先写下打算（跨场次才演得出来，不写压缩后就忘了）。
 */
import type { Campaign, Character } from './campaign.ts';

/** 1-2 档 DM 随手用；3-4 档先 plan；5 档要玩家点头 */
export const HOOK_TIERS = [
  '',
  '细节：场景里一样东西、一句传闻和他的过去有关',
  'NPC 一句话：有人认出他，或提到那个人、那个地方',
  '消息到了：一封信、一张告示、熟人托人带话',
  '两难：剧情给他一个和过去冲突的选择',
  '那个人出现：背景里的人亲自登场',
] as const;

export const MAX_TIER = 5;
/** 第几档起要先写打算 */
const PLAN_FROM = 3;
/** 一次工具结果里最多提几条，场景里词多时不刷屏 */
const MAX_HINTS = 2;
const MAX_TEXT = 200;

export type HookResponse = 'bit' | 'ignored';

export interface BackstoryHook {
  /** 卡内编号，从 1 开始 */
  id: number;
  /** 玩家给的来历，尽量是他的原话 */
  text: string;
  /** 场景里出现这些词就提醒 DM（人名、地名、组织、物件） */
  keys: string[];
  /** 已经推到第几档；0 = 还没碰过 */
  tier: number;
  /** 打算推的下一档（3-4 档先写好再演） */
  plan?: { tier: number; text: string };
  /** 上次用到的时间，排「谁最久没被碰」 */
  usedAt?: number;
  /** 玩家上次接没接 */
  response?: HookResponse;
  /** 了结了：那件事有了结果，不再提醒 */
  closed?: boolean;
}

function hooksOf(ch: Character): BackstoryHook[] {
  ch.hooks ??= [];
  return ch.hooks;
}

function requireHook(ch: Character, id: number): BackstoryHook {
  const hook = ch.hooks?.find((h) => h.id === id);
  if (hook === undefined) {
    const ids = (ch.hooks ?? []).map((h) => `#${h.id}`).join('、') || '（还没有）';
    throw new Error(`${ch.name} 没有钩子 #${id}。现有：${ids}`);
  }
  return hook;
}

function cleanKeys(keys: readonly string[]): string[] {
  const out = [...new Set(keys.map((k) => k.trim()).filter(Boolean))];
  // 单字词（「狼」「门」）几乎每个房间都有，提醒会变成噪音
  const short = out.filter((k) => [...k].length < 2);
  if (short.length > 0) throw new Error(`触发词至少两个字：${short.join('、')}`);
  return out;
}

export function addHook(ch: Character, text: string, keys: readonly string[]): BackstoryHook {
  if (ch.kind !== 'pc') throw new Error(`背景钩子只挂在 PC 卡上，${ch.name} 不是 PC`);
  const body = text.trim().slice(0, MAX_TEXT);
  if (body.length === 0) throw new Error('钩子内容不能为空：写玩家说的那件没了结的事');
  const words = cleanKeys(keys);
  if (words.length === 0) throw new Error('至少给一个触发词（人名、地名、组织、物件），场景里出现它才会提醒');
  const list = hooksOf(ch);
  const hook: BackstoryHook = { id: (list.at(-1)?.id ?? 0) + 1, text: body, keys: words, tier: 0 };
  list.push(hook);
  return hook;
}

export function updateHook(ch: Character, id: number, patch: { text?: string; keys?: readonly string[] }): BackstoryHook {
  const hook = requireHook(ch, id);
  if (patch.text !== undefined) {
    const body = patch.text.trim().slice(0, MAX_TEXT);
    if (body.length === 0) throw new Error('钩子内容不能为空');
    hook.text = body;
  }
  if (patch.keys !== undefined) {
    const words = cleanKeys(patch.keys);
    if (words.length === 0) throw new Error('至少留一个触发词');
    hook.keys = words;
  }
  return hook;
}

export function planHook(ch: Character, id: number, tier: number, text: string): BackstoryHook {
  const hook = requireHook(ch, id);
  if (hook.closed === true) throw new Error(`#${id} 已经了结了`);
  if (tier < PLAN_FROM || tier > MAX_TIER) throw new Error(`plan 是给 ${PLAN_FROM}-${MAX_TIER} 档的；1-2 档直接演完再 use`);
  const body = text.trim().slice(0, MAX_TEXT);
  if (body.length === 0) throw new Error('写一句打算怎么演（什么时候、通过谁、给他什么选择）');
  hook.plan = { tier, text: body };
  return hook;
}

/**
 * 演过了就记一笔。3-4 档没有先 plan 不让记：这两档要提前铺（信要有人送、两难要有前因），
 * 临场直接演出来的多半是编的。5 档要 player_ok：背景里的人亲自出现会改掉玩家对自己角色的设定。
 */
export function useHook(
  ch: Character,
  id: number,
  tier: number,
  options: { response?: HookResponse; playerOk?: boolean; now?: number } = {},
): BackstoryHook {
  const hook = requireHook(ch, id);
  if (hook.closed === true) throw new Error(`#${id} 已经了结了`);
  if (!Number.isInteger(tier) || tier < 1 || tier > MAX_TIER) throw new Error(`tier 是 1-${MAX_TIER}`);
  // 已经演过的档位再记一次（补记玩家接没接）不用再走 plan / 问玩家
  const fresh = tier > hook.tier;
  if (fresh && tier >= PLAN_FROM && hook.plan?.tier !== tier) {
    throw new Error(`第 ${tier} 档（${HOOK_TIERS[tier]}）要先 dnd_hook plan 写下打算，下一场或过几个场景再演；这一下先用 1-2 档。`);
  }
  if (fresh && tier === MAX_TIER && options.playerOk !== true) {
    throw new Error(`第 5 档（${HOOK_TIERS[5]}）先问 ${ch.player ?? ch.name} 同不同意这个人登场，他点头了再传 player_ok=true。`);
  }
  hook.tier = Math.max(hook.tier, tier);
  hook.usedAt = options.now ?? Date.now();
  if (options.response !== undefined) hook.response = options.response;
  if (hook.plan?.tier === tier) delete hook.plan;
  return hook;
}

export function closeHook(ch: Character, id: number): BackstoryHook {
  const hook = requireHook(ch, id);
  hook.closed = true;
  delete hook.plan;
  return hook;
}

export function hookLine(ch: Character, h: BackstoryHook): string {
  const state = [
    h.closed === true ? '已了结' : (h.tier === 0 ? '还没碰过' : `到过第 ${h.tier} 档`),
    h.response === 'bit' ? '玩家接了' : (h.response === 'ignored' ? '玩家上次没接' : ''),
    h.plan !== undefined ? `打算第 ${h.plan.tier} 档：${h.plan.text}` : '',
  ].filter(Boolean).join('，');
  return `${ch.name} #${h.id}「${h.text}」［${h.keys.join('/')}］${state}`;
}

function liveHooks(c: Campaign): Array<{ ch: Character; hook: BackstoryHook }> {
  return c.characters
    .filter((ch) => ch.kind === 'pc' && !ch.conditions.includes('死亡'))
    .flatMap((ch) => (ch.hooks ?? []).filter((h) => h.closed !== true).map((hook) => ({ ch, hook })));
}

/**
 * 场景文字里出现了谁的触发词。text 是这一步工具结果里的场景内容（房间描述、NPC、拿到的东西）。
 * 只认 PC 在场的：分头行动时没跟来的人，他的过去不该在这间屋里冒出来。
 */
export function matchHooks(c: Campaign, text: string, present?: readonly string[]): Array<{ ch: Character; hook: BackstoryHook; key: string }> {
  const lower = text.toLowerCase();
  const found: Array<{ ch: Character; hook: BackstoryHook; key: string }> = [];
  for (const { ch, hook } of liveHooks(c)) {
    if (present !== undefined && !present.includes(ch.name)) continue;
    const key = hook.keys.find((k) => lower.includes(k.toLowerCase()));
    if (key !== undefined) found.push({ ch, hook, key });
  }
  // 最久没碰的排前面
  return found.sort((a, b) => (a.hook.usedAt ?? 0) - (b.hook.usedAt ?? 0));
}

/** 工具结果里的一行提醒；没沾边就 undefined */
export function hookHint(c: Campaign, text: string, present?: readonly string[]): string | undefined {
  const found = matchHooks(c, text, present).slice(0, MAX_HINTS);
  if (found.length === 0) return undefined;
  const items = found.map(({ ch, hook, key }) => `${hookLine(ch, hook)}（这里出现了「${key}」）`);
  return `【DM · 背景钩子】这一步和角色来历沾边：${items.join('；')}。用不用你定：`
    + '1-2 档（细节、NPC 一句话）可以顺手放进描述，演完 dnd_hook use；3-4 档先 plan；第 5 档先问玩家。不合适就当没看见。';
}

/**
 * 开团时进背景的几行：每条钩子一行，最久没被碰的 PC 排第一。
 * 只是「这一场有合适的场景可以想着他」，不是硬性指标：硬要求会让 DM 为了交差硬塞。
 */
export function hookPromptLines(c: Campaign): string[] {
  const live = liveHooks(c);
  if (live.length === 0) return [];
  const lastTouch = new Map<string, number>();
  for (const { ch, hook } of live) lastTouch.set(ch.name, Math.max(lastTouch.get(ch.name) ?? 0, hook.usedAt ?? 0));
  const sorted = [...live].sort((a, b) => (lastTouch.get(a.ch.name)! - lastTouch.get(b.ch.name)!) || (a.hook.usedAt ?? 0) - (b.hook.usedAt ?? 0));
  const stale = sorted[0]!.ch.name;
  return [
    `背景钩子（dnd_hook）：\n${sorted.map(({ ch, hook }) => `- ${hookLine(ch, hook)}`).join('\n')}`,
    `最久没被碰到的是 ${stale}；这一场有合适的场景可以想着他，没有就算了。`,
  ];
}

/** 还没留过钩子的 PC：开场时提醒问一句 */
export function pcsWithoutHooks(c: Campaign): string[] {
  return c.characters
    .filter((ch) => ch.kind === 'pc' && !ch.conditions.includes('死亡') && (ch.hooks ?? []).every((h) => h.closed === true))
    .map((ch) => ch.name);
}
