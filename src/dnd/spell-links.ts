/**
 * 角色卡上的法术与能力清单及 wiki 链接，给回合按钮「法术/能力」用。
 *
 * 两个站：
 * - 灰机 wiki（中文）前面有 Cloudflare 验证，机器人请求一律 403，验不了，只能给搜索链接，标题对上会直接跳到词条。
 * - dnd5e.wikidot（英文）能直接请求、地址固定（spell:fireball），不存在的词条回 404。
 *   写卡时法术请求一次，404 就让 DM 补英文原名，免得玩家点开是空页；职业特性/物品能力（kind=feature/item）走灰机检索与卡面摘要，不强制验 spell URL。
 */
import type { ReactionDef, Resource } from './campaign.ts';

export type CardEntryKind = 'spell' | 'feature' | 'item';
export type AbilityActionKind = 'action' | 'bonus' | 'reaction' | 'free' | 'passive';

export interface CardSpell {
  name: string;
  /** 0 = 戏法（或非环位能力） */
  level: number;
  /** 条目类型：缺省为 'spell'（完全兼容旧存档），可为 'feature'（职业动作/特性）或 'item'（充能物品能力） */
  kind?: CardEntryKind;
  /** 动作消耗类型 */
  action?: AbilityActionKind;
  /** 关联的资源池键名（面板实时展示余量 current/max） */
  resource?: string;
  /** 每次消耗的资源点数（默认 1） */
  cost?: number;
  /** 简短效果摘要（供玩家点按钮时速查） */
  summary?: string;
  /** dnd5e.wikidot 的词条地址；验过 404 才不存；网络不通时也存，verified=false */
  wiki?: string;
  verified?: boolean;
}

export interface SpellInput {
  name: string;
  level?: number;
  kind?: CardEntryKind;
  action?: AbilityActionKind;
  resource?: string;
  cost?: number;
  summary?: string;
  /** 英文原名，SRD 中文名表对不上时要给（Hex、Tasha's Hideous Laughter） */
  en?: string;
}

export type UrlStatus = 'ok' | 'missing' | 'unknown';
export type UrlCheck = (url: string) => Promise<UrlStatus>;

const CHECK_TIMEOUT_MS = 8000;

export function huijiSearchUrl(query: string): string {
  return `https://dnd.huijiwiki.com/index.php?search=${encodeURIComponent(query.trim())}`;
}

export function wikidotSlug(en: string): string {
  return en.toLowerCase().replace(/['’]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

export function wikidotSpellUrl(slug: string): string {
  return `https://dnd5e.wikidot.com/spell:${slug}`;
}

export const checkUrl: UrlCheck = async (url) => {
  try {
    const res = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(CHECK_TIMEOUT_MS), headers: { 'user-agent': 'Mozilla/5.0' } });
    if (res.status === 404) return 'missing';
    return res.ok ? 'ok' : 'unknown';
  } catch {
    return 'unknown';
  }
};

/** 同一个地址进程内只验一次 */
const checked = new Map<string, UrlStatus>();

/**
 * 把 DM 给的法术解析成卡上的条目。slugOf 是中文名/英文名 → SRD index 的精确匹配（对不上返回 undefined）；
 * 模糊匹配不用，因为匹错到另一个真实存在的法术时 404 也拦不住。
 * 所有问题一次报完，DM 不用一条条试。
 */
export async function resolveSpells(
  inputs: readonly SpellInput[],
  slugOf: (name: string) => string | undefined,
  check: UrlCheck = checkUrl,
): Promise<{ spells: CardSpell[]; notes: string[] }> {
  const errors: string[] = [];
  const notes: string[] = [];
  const spells: CardSpell[] = [];
  for (const input of inputs) {
    const extraMeta = {
      ...(input.action !== undefined ? { action: input.action } : {}),
      ...(input.resource !== undefined ? { resource: input.resource } : {}),
      ...(input.cost !== undefined ? { cost: input.cost } : {}),
      ...(input.summary !== undefined ? { summary: input.summary } : {}),
    };
    if (input.kind === 'feature' || input.kind === 'item') {
      spells.push({
        name: input.name,
        level: input.level ?? 0,
        kind: input.kind,
        ...extraMeta,
      });
      continue;
    }
    const slug = input.en !== undefined ? wikidotSlug(input.en) : slugOf(input.name);
    if (slug === undefined || slug === '') {
      errors.push(`「${input.name}」对不上 SRD 的英文名：给 en（英文原名，如 Hex）；若这是职业特性/物品能力请传 kind="feature" 或 "item"`);
      continue;
    }
    const url = wikidotSpellUrl(slug);
    let status = checked.get(url);
    if (status === undefined) {
      status = await check(url);
      if (status !== 'unknown') checked.set(url, status);
    }
    if (status === 'missing') {
      errors.push(`「${input.name}」：${url} 不存在，en 填英文原名再试（如 Tasha's Hideous Laughter）；若非标准法术请传 kind="feature" 或 "item"`);
      continue;
    }
    if (status === 'unknown') notes.push(`${input.name} 的链接这次没验上（网络），先存着`);
    spells.push({ name: input.name, level: input.level ?? 0, ...extraMeta, wiki: url, verified: status === 'ok' });
  }
  if (errors.length > 0) throw new Error(`法术链接有问题，整张卡没改：\n${errors.join('\n')}`);
  return { spells, notes };
}

/** 按名字合并：新的覆盖同名的，法术在前、能力在后，再按环位和名字排 */
export function mergeSpells(current: readonly CardSpell[], add: readonly CardSpell[], remove: readonly string[]): CardSpell[] {
  const drop = new Set([...remove, ...add.map((s) => s.name)]);
  const missing = remove.filter((n) => !current.some((s) => s.name === n));
  if (missing.length > 0) throw new Error(`卡上没有这些法术或能力：${missing.join('、')}`);
  const kindOrder = (s: CardSpell): number => ((s.kind ?? 'spell') === 'spell' ? 0 : 1);
  return [...current.filter((s) => !drop.has(s.name)), ...add]
    .sort((a, b) => kindOrder(a) - kindOrder(b) || a.level - b.level || a.name.localeCompare(b.name, 'zh'));
}

function levelName(level: number): string {
  return level === 0 ? '戏法' : `${level} 环`;
}

/** 卡片上的一行：「法术：戏法 魔能爆；1 环 脆弱诅咒」及可选「能力：战斗英姿、动作如潮」 */
export function spellLine(spells: readonly CardSpell[]): string {
  const parts: string[] = [];
  const onlySpells = spells.filter((s) => (s.kind ?? 'spell') === 'spell');
  const abilities = spells.filter((s) => s.kind === 'feature' || s.kind === 'item');
  if (onlySpells.length > 0) {
    const groups = new Map<number, string[]>();
    for (const s of onlySpells) groups.set(s.level, [...(groups.get(s.level) ?? []), s.name]);
    parts.push(`法术：${[...groups].map(([lv, names]) => `${levelName(lv)} ${names.join('、')}`).join('；')}`);
  }
  if (abilities.length > 0) {
    parts.push(`能力：${abilities.map((a) => a.name).join('、')}`);
  }
  return parts.join('\n');
}

/**
 * 某一环的法术位余量，贴在环阶标题后面：`　2/4`、`　契约 1/2`。
 * 邪术师的位叫「契约法术位（3环）」，环数在括号里，所以按 `${level}环` 找而不是按键名相等。
 */
function slotOf(level: number, resources: Readonly<Record<string, Resource>>): string {
  const found = Object.entries(resources)
    .filter(([k, r]) => r.max > 0 && k.includes('法术位') && k.includes(`${level}环`))
    .map(([k, r]) => {
      const label = k.replace(`${level}环`, '').replace('法术位', '').replace(/（\d+环）/, '').replace(/[（）()]/g, '').trim();
      return `${label === '' ? '' : `${label} `}${r.current}/${r.max}`;
    });
  return found.length > 0 ? `　${found.join('、')}` : '';
}

const ACTION_LABELS: Record<AbilityActionKind, string> = {
  action: '动作',
  bonus: '附赠',
  reaction: '反应',
  free: '自由',
  passive: '常驻',
};

const RESET_LABELS: Record<Resource['reset'], string> = {
  short: '短休回',
  long: '长休回',
  none: '耗尽不回',
};

function resourceBadge(
  resourceName: string | undefined,
  cost: number | undefined,
  resources: Readonly<Record<string, Resource>>,
): string {
  if (resourceName === undefined) return '';
  const found = resources[resourceName];
  const costNote = cost !== undefined && cost > 1 ? `，每次耗${cost}` : '';
  if (found === undefined) return `（耗${resourceName}${costNote}）`;
  return `（${resourceName === '' ? '' : `${resourceName} `}${found.current}/${found.max}${costNote}）`;
}

export interface SpellListOptions {
  /** 为旧角色卡自动兜底渲染未显式录入 spells 的非环位 resources 与 reactions */
  includeFallback?: boolean;
  reactions?: readonly ReactionDef[];
}

/**
 * 「法术/能力」按钮发到群里的清单。调用方 turn-buttons 走的是 sendMarkdown，所以链接写成
 * markdown 行内链接：渲染出来只剩「中 / 英」两个字宽，裸 URL 那种二十行贴满屏的情况就没了。
 * 法术位余量跟在每一环的标题后面；职业动作、反应与充能物品列在「职业与物品能力」分组下并实时显示剩余次数。
 */
export function spellListText(
  name: string,
  spells: readonly CardSpell[],
  resources: Readonly<Record<string, Resource>> = {},
  options: SpellListOptions = {},
): string {
  const onlySpells = spells.filter((s) => (s.kind ?? 'spell') === 'spell');
  const explicitAbilities = spells.filter((s) => s.kind === 'feature' || s.kind === 'item');

  const abilityLines: string[] = [];
  const coveredNames = new Set<string>(spells.map((s) => s.name));
  const coveredResources = new Set<string>(
    spells.map((s) => s.resource).filter((r): r is string => r !== undefined && r.length > 0),
  );

  for (const a of explicitAbilities) {
    const act = a.action !== undefined ? ` [${ACTION_LABELS[a.action]}]` : '';
    const res = resourceBadge(a.resource ?? (resources[a.name] !== undefined ? a.name : undefined), a.cost, resources);
    if (resources[a.name] !== undefined) coveredResources.add(a.name);
    const sum = a.summary !== undefined && a.summary.length > 0 ? ` — ${a.summary}` : '';
    const en = a.wiki === undefined ? '' : `　[英](${a.wiki})`;
    abilityLines.push(`· ${a.name}${act}${res}${sum}　[中](${huijiSearchUrl(a.name)})${en}`);
  }

  if (options.includeFallback === true) {
    for (const r of options.reactions ?? []) {
      if (coveredNames.has(r.name)) continue;
      coveredNames.add(r.name);
      if (r.resource === r.name) coveredResources.add(r.name);
      const res = resourceBadge(r.resource ?? (resources[r.name] !== undefined ? r.name : undefined), r.cost, resources);
      if (resources[r.name] !== undefined) coveredResources.add(r.name);
      abilityLines.push(`· ${r.name} [反应]${res}　[中](${huijiSearchUrl(r.name)})`);
    }
    for (const [k, res] of Object.entries(resources)) {
      if (res.max <= 0 || k.includes('法术位') || coveredNames.has(k) || coveredResources.has(k)) continue;
      coveredNames.add(k);
      abilityLines.push(`· ${k}（${res.current}/${res.max}，${RESET_LABELS[res.reset]}）　[中](${huijiSearchUrl(k)})`);
    }
  }

  if (onlySpells.length === 0 && abilityLines.length === 0) {
    return `🔮 ${name} 的卡上还没有法术或能力清单。让 DM 用 dnd_character update spells 补上；先用 /dnd search 查。`;
  }

  const lines = [`🔮 **${name}** 的法术${abilityLines.length > 0 ? '与能力' : ''}`];
  let level: number | undefined;
  for (const s of onlySpells) {
    if (s.level !== level) {
      level = s.level;
      lines.push('', `**${levelName(s.level)}**${slotOf(s.level, resources)}`);
    }
    const act = s.action !== undefined ? ` [${ACTION_LABELS[s.action]}]` : '';
    const res = s.resource !== undefined ? resourceBadge(s.resource, s.cost, resources) : '';
    const sum = s.summary !== undefined && s.summary.length > 0 ? ` — ${s.summary}` : '';
    const en = s.wiki === undefined ? '' : `　[英](${s.wiki})`;
    lines.push(`· ${s.name}${act}${res}${sum}　[中](${huijiSearchUrl(s.name)})${en}`);
  }
  if (abilityLines.length > 0) {
    lines.push('', '**职业与物品能力**', ...abilityLines);
  }
  return lines.join('\n');
}
