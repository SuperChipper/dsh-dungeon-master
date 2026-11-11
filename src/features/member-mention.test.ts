import { afterEach, describe, expect, it } from 'vitest';
import {
  isSelfMention,
  mentionTag,
  rememberSelfMentions,
  renderInboundMentions,
  renderOutboundMentions,
  resetSelfMentions,
} from './member-mention.ts';

const BOT = '7A3B71762CFE765933AD79E8F2E04B92';
const ALICE = 'CB5816E1EF0000000000000000000001';
const aliases: Record<string, string> = { [ALICE]: 'U3' };
const aliasOf = (id: string): string => aliases[id] ?? 'U9';
const byAlias: Record<string, string> = { U3: ALICE };
const resolve = (alias: string): string | undefined => byAlias[alias];

afterEach(() => resetSelfMentions());

describe('renderInboundMentions', () => {
  it('成员 openid 换成 #U 编号，bot 自己换成「你」', () => {
    rememberSelfMentions([{ member_openid: BOT, is_you: true }, { member_openid: ALICE, is_you: false }]);
    const out = renderInboundMentions(`<@${BOT}> <@${ALICE}> 你俩谁去`, aliasOf, (id) => isSelfMention(id));
    expect(out).toBe('@你 @#U3 你俩谁去');
  });

  it('bot 自己发出去被引用回来的 @ 标签也认得', () => {
    expect(renderInboundMentions(`${mentionTag(ALICE)} 轮到你了`, aliasOf, () => false)).toBe('@#U3 轮到你了');
  });

  it('没见过的成员当场分配编号；@全体单独标出', () => {
    expect(renderInboundMentions('<@NEWBIE00000000000000000000000001> <@all>', aliasOf, () => false))
      .toBe('@#U9 @全体成员');
  });

  it('appId 形式的 <@!数字> 也算 @bot', () => {
    expect(renderInboundMentions('<@!1905957109> 在吗', aliasOf, (id) => isSelfMention(id, '1905957109'))).toBe('@你 在吗');
  });

  it('只认 is_you 的那个', () => {
    rememberSelfMentions([{ member_openid: ALICE }]);
    expect(isSelfMention(ALICE)).toBe(false);
  });
});

describe('renderOutboundMentions', () => {
  it('@#U3 / @U3 / @#u3 都换成 QQ 的 @ 标签', () => {
    for (const written of ['@#U3', '@U3', '@#u3', '@# U3']) {
      expect(renderOutboundMentions(`${written} 该你了`, resolve)).toBe(`${mentionTag(ALICE)} 该你了`);
    }
  });

  it('查不到的编号原样留着', () => {
    expect(renderOutboundMentions('@#U7 在吗', resolve)).toBe('@#U7 在吗');
  });

  it('不碰邮箱、编号没写完的、没有 @ 的', () => {
    expect(renderOutboundMentions('a@U3.com', resolve)).toBe('a@U3.com');
    expect(renderOutboundMentions('@U31', resolve)).toBe('@U31');
    expect(renderOutboundMentions('#U3 先手最高', resolve)).toBe('#U3 先手最高');
  });

  it('句中、中文标点后面也能 @', () => {
    expect(renderOutboundMentions('好了，@#U3看这里', resolve)).toBe(`好了，${mentionTag(ALICE)}看这里`);
  });

  it('入站渲染后的文本再出站能还原成同一个人', () => {
    const inbound = renderInboundMentions(`<@${ALICE}>`, aliasOf, () => false);
    expect(renderOutboundMentions(inbound, resolve)).toBe(mentionTag(ALICE));
  });
});
