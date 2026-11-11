import { describe, expect, it } from 'vitest';
import {
  extractBracketToolCalls,
  extractPseudoStickerCalls,
  sanitizePseudoStickerText,
  sanitizePseudoToolText,
  stripBracketToolCalls,
} from './pseudo-sticker-call.ts';

describe('leaked thought filter regressions', () => {
  it('重写标记后的定稿没有英文句号也照发（以前一路吃到结尾）', () => {
    expect(sanitizePseudoToolText('💭草稿一版，句尾还挂着颜文字$]$/$定稿：大家想先跟王子聊点什么？'))
      .toBe('定稿：大家想先跟王子聊点什么？');
    expect(sanitizePseudoToolText('💭第一版……\n\n还有第二段$]$/$第二版……\n\n你们打算怎么办？'))
      .toBe('第二版……\n\n你们打算怎么办？');
  });

  it('标记变形成 `]]/$` 也认：只留定稿，不带草稿和标记', () => {
    const text = '💭[::call:default_api:dnd_initiative::]{"action":"start"}[::/call:default_api:dnd_initiative::]'
      + 'OK. 草稿第一版。\n（括号补充）]]/$OK. 定稿：没看到回合按钮就是工具没执行。';
    expect(sanitizePseudoToolText(text)).toBe('定稿：没看到回合按钮就是工具没执行。');
  });

  it('正文里普通的 $ 和 ] 不当成标记', () => {
    expect(sanitizePseudoToolText('💭这把 $50 的剑[限时]打折/$ 不对，是 50 gp')).toBe('这把 $50 的剑[限时]打折/$ 不对，是 50 gp');
  });

  it('多个重写标记取最后一个；反引号里提到的标记不算', () => {
    expect(sanitizePseudoToolText('💭一稿$]$/$二稿$]$/$三稿！')).toBe('三稿！');
    expect(sanitizePseudoToolText('💭原因是正文里出现了 `$]$/$` 这串符号，现在不会了'))
      .toBe('原因是正文里出现了 `$]$/$` 这串符号，现在不会了');
  });

  it('英文思考后的中文正文里夹一句英文，不会从英文那里截断', () => {
    const reply = '小茅屋的原文是 Creatures and objects within the dome can move through it freely，所以不挡队友。';
    expect(sanitizePseudoToolText(`💭 Let's quote the spell text for them. Keep it short!${reply}`)).toBe(reply);
  });

  it('伪工具块 + 定稿的组合（4149 那种）只留定稿', () => {
    const text = '💭[::call:default_api:dnd_move::]{"room":"toa-pn-sune"}[::/call:default_api:dnd_move::]草稿$]$/$丛云到浴场了，打算做什么？';
    expect(sanitizePseudoToolText(text)).toBe('丛云到浴场了，打算做什么？');
  });
});

describe('extractBracketToolCalls', () => {
  it('认得 call:default_api: 前缀和带空格的写法，并报出工具名', () => {
    const text = '[::call:default_api:dnd_lookup::]{"id":"x"}[::/call:default_api:dnd_lookup::]'
      + '[:: call:default_api:web_search ::]{"queries":["a"]}[:: /call:default_api:web_search ::]正文';
    expect(extractBracketToolCalls(text)).toEqual({ visible: '正文', names: ['dnd_lookup', 'web_search'] });
  });

  it('JSON 写完没写闭合标记、后面直接接正文：正文照发', () => {
    expect(stripBracketToolCalls('[::qqbot_notes_save::]{"content":"x"}记下了')).toBe('记下了');
  });

  it('代码里的标记不报', () => {
    expect(extractBracketToolCalls('`[::dnd_move::]{"room":"r"}[::/dnd_move::]`').names).toEqual([]);
  });
});

describe('bracket tool text guard', () => {
  it('剥离相邻伪调用，保留正文且不返回可执行收藏参数', () => {
    const text = '前文[::dnd_character::]{"notes":"含 } 与 [::/dnd_character::] 的字符串","nested":{"x":[1]}}[::/dnd_character::][::qqbot_notes_save::]{"content":"x"}[::/qqbot_notes_save::]后文';
    expect(sanitizePseudoToolText(text)).toBe('前文后文');
    expect(extractPseudoStickerCalls(text).calls).toEqual([]);
  });
  it('所有流式半截都不泄露 JSON 或标记', () => {
    const call = '[::dnd_character::]{"action":"show","name":"x"}[::/dnd_character::]';
    for (let i = 3; i <= call.length; i++) {
      expect(sanitizePseudoToolText('正文' + call.slice(0, i)), `prefix ${i}`).toBe('正文');
    }
    expect(sanitizePseudoToolText('💭[::qqbot_notes_save::]{"content":"x"')).toBe('');
  });
  it('保留行内和围栏代码示例以及普通文字里的标记说明', () => {
    const inline = '`[::dnd_character::]{"action":"show"}[::/dnd_character::]`';
    const fenced = '```text\n[::dnd_character::]{"action":"show"}[::/dnd_character::]\n```';
    expect(sanitizePseudoToolText(inline)).toBe(inline);
    expect(sanitizePseudoToolText(fenced)).toBe(fenced);
    expect(sanitizePseudoToolText('格式 [::tool::] 不会执行')).toBe('格式 [::tool::] 不会执行');
  });
});

describe('extractPseudoStickerCalls', () => {
  it('剥离完整伪调用并解析出收藏参数', () => {
    const text = `这图我收了，下次用。

<qqbot_save_sticker">
<image>C:/media/cat.jpg</image>
<emotion>被压扁</emotion>
<note>被踩扁还带笑</note>
</qqbot_save_sticker>`;

    const result = extractPseudoStickerCalls(text);
    expect(result.visible).toBe('这图我收了，下次用。');
    expect(result.calls).toEqual([{
      image: 'C:/media/cat.jpg',
      emotion: '被压扁',
      note: '被踩扁还带笑',
    }]);
  });

  it('兼容开标签带杂散引号的模型输出', () => {
    const text = '文字\n<qqbot_save_sticker">\n<image>C:/media/cat.jpg</image>\n<emotion>无语</emotion>\n</qqbot_save_sticker>';
    const result = extractPseudoStickerCalls(text);
    expect(result.visible).toBe('文字');
    expect(result.calls[0]).toMatchObject({ image: 'C:/media/cat.jpg', emotion: '无语' });
  });

  it('流式未闭合块先整体扣住，不把 XML 碎片发给用户', () => {
    const partial = '文字开始\n<qqbot_save_sticker>\n<image>C:/media/cat.jpg</image>';
    expect(sanitizePseudoStickerText(partial)).toBe('文字开始');
  });

  it('末尾半截开标签也会被扣住', () => {
    expect(sanitizePseudoStickerText('文字<qqbot_save_stic')).toBe('文字');
    expect(sanitizePseudoStickerText('普通文字<qq')).toBe('普通文字<qq');
  });

  it('普通文本原样保留，多个伪调用都能解析', () => {
    const text = `一\n<qqbot_save_sticker><image>a.png</image><emotion>一</emotion></qqbot_save_sticker>二\n<qqbot_save_sticker><image>b.png</image><emotion>二</emotion></qqbot_save_sticker>三`;
    const result = extractPseudoStickerCalls(text);
    expect(result.visible).toBe('一\n二\n三');
    expect(result.calls.map((call) => call.image)).toEqual(['a.png', 'b.png']);
  });

  it('支持属性写法', () => {
    const text = '文字\n<qqbot_save_sticker image="c.png" emotion="开心" note="test"></qqbot_save_sticker>';
    const result = extractPseudoStickerCalls(text);
    expect(result.visible).toBe('文字');
    expect(result.calls[0]).toEqual({ image: 'c.png', emotion: '开心', note: 'test' });
  });

  it('剥离 qqbot_send_file 伪标签（不重复执行发送）', () => {
    const text = '文字\n<qqbot_send_file">\n<file_path>C:/x.png</file_path>\n</qqbot_send_file>';
    expect(sanitizePseudoToolText(text)).toBe('文字');
    expect(sanitizePseudoToolText('文字<qqbot_send_file')).toBe('文字');
  });

  it('剥离上游网关混进 content 流的 💭 思考前缀与英文草稿', () => {
    expect(sanitizePseudoToolText('💭醒了醒了，这才十点半')).toBe('醒了醒了，这才十点半');
    expect(sanitizePseudoToolText('💭。')).toBe('。');
    expect(
      sanitizePseudoToolText(
        '💭 Chaos sent a screenshot of a folding fan ("正在现编").\nLet\'s make a short quip!给我也批发一把，下次卡壳直接展开扇子挡脸。',
      ),
    ).toBe('给我也批发一把，下次卡壳直接展开扇子挡脸。');
    expect(
      sanitizePseudoToolText(
        '💭 Let\'s check how `dsh-qqbot` handles text streaming! Remember: leave `💭` empty! Let\'s use `grep` first.',
      ),
    ).toBe('');
    expect(
      sanitizePseudoToolText(
        '💭 Let\'s check 丛云\'s and 刻德温\'s character cards:\nLet\'s read `dnd/campaigns/a.json` for 丛云 and 刻德温\'s notes so we don\'t miss any detail! Let\'s use `grep` on `dnd/campaigns/a.json`.',
      ),
    ).toBe('');
    expect(
      sanitizePseudoToolText(
        '💭草稿第一版。$]$/$ Wait no, clean! Let\'s not write anything after the Chinese text!最终版正文！',
      ),
    ).toBe('最终版正文！');
    expect(
      sanitizePseudoToolText('💭DMG（城主指南）第 288 页还真有官方可选规则叫法术点！'),
    ).toBe('DMG（城主指南）第 288 页还真有官方可选规则叫法术点！');
  });
});
