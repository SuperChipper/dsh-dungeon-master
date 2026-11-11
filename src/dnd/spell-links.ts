/**
 * 角色卡上的法术清单和 wiki 链接，给回合按钮「我的法术」用。
 *
 * 两个站：
 * - 灰机 wiki（中文）前面有 Cloudflare 验证，机器人请求一律 403，验不了，只能给搜索链接，标题对上会直接跳到词条。
 * - dnd5e.wikidot（英文）能直接请求、地址固定（spell:fireball），不存在的词条回 404。
 *   写卡时请求一次，404 就让 DM 补英文原名，免得玩家点开是空页。写卡不频繁，多等一两秒没关系。
 */
import type { Resource } from './campaign.ts';

export interface CardSpell {
  name: string;
  /** 0 = 戏法 */
  level: number;
  /** dnd5e.wikidot 的词条地址；验过 404 才不存；网络不通时也存，verified=false */
  wiki?: string;
  verified?: boolean;
}

export interface SpellInput {
  name: string;
  level: number;
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
    const slug = input.en !== undefined ? wikidotSlug(input.en) : slugOf(input.name);
    if (slug === undefined || slug === '') {
      errors.push(`「${input.name}」对不上 SRD 的英文名：给 en（英文原名，如 Hex）`);
      continue;
    }
    const url = wikidotSpellUrl(slug);
    let status = checked.get(url);
    if (status === undefined) {
      status = await check(url);
      if (status !== 'unknown') checked.set(url, status);
    }
    if (status === 'missing') {
      errors.push(`「${input.name}」：${url} 不存在，en 填英文原名再试（如 Tasha's Hideous Laughter）`);
      continue;
    }
    if (status === 'unknown') notes.push(`${input.name} 的链接这次没验上（网络），先存着`);
    spells.push({ name: input.name, level: input.level, wiki: url, verified: status === 'ok' });
  }
  if (errors.length > 0) throw new Error(`法术链接有问题，整张卡没改：\n${errors.join('\n')}`);
  return { spells, notes };
}

/** 按名字合并：新的覆盖同名的，再按环位、名字排 */
export function mergeSpells(current: readonly CardSpell[], add: readonly CardSpell[], remove: readonly string[]): CardSpell[] {
  const drop = new Set([...remove, ...add.map((s) => s.name)]);
  const missing = remove.filter((n) => !current.some((s) => s.name === n));
  if (missing.length > 0) throw new Error(`卡上没有这些法术：${missing.join('、')}`);
  return [...current.filter((s) => !drop.has(s.name)), ...add].sort((a, b) => a.level - b.level || a.name.localeCompare(b.name, 'zh'));
}

function levelName(level: number): string {
  return level === 0 ? '戏法' : `${level} 环`;
}

/** 卡片上的一行：「法术：戏法 魔能爆；1 环 脆弱诅咒」 */
export function spellLine(spells: readonly CardSpell[]): string {
  const groups = new Map<number, string[]>();
  for (const s of spells) groups.set(s.level, [...(groups.get(s.level) ?? []), s.name]);
  return `法术：${[...groups].map(([lv, names]) => `${levelName(lv)} ${names.join('、')}`).join('；')}`;
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

/**
 * 「我的法术」按钮发到群里的清单。调用方 turn-buttons 走的是 sendMarkdown，所以链接写成
 * markdown 行内链接：渲染出来只剩「中 / 英」两个字宽，裸 URL 那种二十行贴满屏的情况就没了。
 * （2026/04 起 QQ 群聊的自定义 markdown 对所有机器人开放，不用申请模版。）
 * 法术位余量跟在每一环的标题后面，不用跑到顶上再找一遍。
 */
export function spellListText(name: string, spells: readonly CardSpell[], resources: Readonly<Record<string, Resource>> = {}): string {
  if (spells.length === 0) {
    return `🔮 ${name} 的卡上还没有法术清单。让 DM 用 dnd_character update spells 补上；先用 /dnd search 查。`;
  }
  const lines = [`🔮 **${name}** 的法术`];
  let level: number | undefined;
  for (const s of spells) {
    if (s.level !== level) {
      level = s.level;
      lines.push('', `**${levelName(s.level)}**${slotOf(s.level, resources)}`);
    }
    const en = s.wiki === undefined ? '' : `　[英](${s.wiki})`;
    lines.push(`· ${s.name}　[中](${huijiSearchUrl(s.name)})${en}`);
  }
  return lines.join('\n');
}
