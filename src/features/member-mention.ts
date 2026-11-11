/**
 * 群成员 @：入站把 QQ 的 `<@openid>` 换成模型认得的 `@#U3`，出站把模型写的 `@#U3` 换回 QQ 的 @ 标签。
 *
 * 入站原样转发时，模型每条消息开头都看到一串 32 位 openid（大多是 bot 自己），
 * 既认不出是谁，也没法照着写回去 @ 人。两头都用 #U 编号（见 sender-alias），
 * 和发送者标签同一套认人方式；openid 只在代码里出现。
 */

/** QQ 群 / 单聊消息里 @ 用户的内嵌格式（频道用的 `<@id>` 在群里发不出 @） */
export function mentionTag(openid: string): string {
  return `<qqbot-at-user id="${openid}" />`;
}

/** 入站里的 @ 标记：平台推来的 `<@id>` / `<@!id>`，以及 bot 自己发出去、被引用回来的 `<qqbot-at-user id="…" />` */
const INBOUND_MENTION = /<@!?([A-Za-z0-9_-]+)>|<qqbot-at-user\s+id="([^"]+)"\s*\/>|<qqbot-at-everyone\s*\/>/g;

/** 模型写的 @#U3 / @U3；前面是字母数字时不算（邮箱之类），后面紧跟数字说明编号没写完 */
const OUTBOUND_MENTION = /(?<![A-Za-z0-9_])@#?\s?U(\d{1,4})(?!\d)/gi;

const EVERYONE = new Set(['all', 'everyone']);

/** bot 在各群里的成员 openid：只能从 mentions[].is_you 学到，进程内记着 */
const selfIds = new Set<string>();

interface MentionLike {
  member_openid?: string;
  user_openid?: string;
  id?: string;
  is_you?: boolean;
}

/** 从消息的 mentions 列表记下 bot 自己的 openid（历史消息里 @bot 的标记要认成「你」） */
export function rememberSelfMentions(mentions: unknown): void {
  if (!Array.isArray(mentions)) return;
  for (const m of mentions as Array<MentionLike | undefined>) {
    if (m?.is_you !== true) continue;
    const id = m.member_openid ?? m.user_openid ?? m.id;
    if (id) selfIds.add(id);
  }
}

export function isSelfMention(id: string, appId?: string): boolean {
  return selfIds.has(id) || (appId !== undefined && id === appId);
}

/** 测试用 */
export function resetSelfMentions(): void {
  selfIds.clear();
}

/**
 * 入站：`<@openid>` → `@#U3`，@bot 自己 → `@你`，@全体 → `@全体成员`。
 * aliasOf 给出这个群里的编号（没见过的成员当场分配，之后模型才能 @ 回去）。
 */
export function renderInboundMentions(
  text: string,
  aliasOf: (openid: string) => string,
  isSelf: (openid: string) => boolean,
): string {
  return text.replace(INBOUND_MENTION, (_m, short: string | undefined, tagged: string | undefined) => {
    const id = short ?? tagged;
    if (id === undefined || EVERYONE.has(id)) return '@全体成员';
    if (isSelf(id)) return '@你';
    return `@#${aliasOf(id)}`;
  });
}

/**
 * 出站：`@#U3` → QQ 的 @ 标签。查不到的编号原样留着，不能猜成别人。
 */
export function renderOutboundMentions(text: string, resolve: (alias: string) => string | undefined): string {
  return text.replace(OUTBOUND_MENTION, (whole, n: string) => {
    const openid = resolve(`U${Number(n)}`);
    return openid === undefined ? whole : mentionTag(openid);
  });
}
