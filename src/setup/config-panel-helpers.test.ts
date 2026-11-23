import { describe, expect, it } from 'vitest';
import {
  cleanRoleVoicesMap,
  DEEPSEEK_SPEAK_WIRE_DEFAULTS,
  ELEVENLABS_SPEAK_WIRE_DEFAULTS,
  formatRoleVoices,
  normalizeChangedConfig,
  parseRoleVoices,
  shallowEqual,
  summarizeDndAdvanced,
  summarizeExtrasDrawer,
  summarizeMediaDrawer,
  type ConfigWire,
} from '../client/config-panel/types.ts';

describe('config-panel helpers', () => {
  it('shallowEqual 与 normalizeChangedConfig 只提取并清洗变更键', () => {
    const initial: ConfigWire = {
      streaming: true,
      adminOpenids: ['U1'],
      access: { c2cMode: 'open', c2cAllow: [], groupMode: 'allowlist', groupAllow: ['G1'] },
      personas: { root: 'personas' },
    };
    expect(shallowEqual(initial, { ...initial })).toBe(true);
    expect(normalizeChangedConfig(initial, initial)).toEqual({});

    const edited: ConfigWire = {
      ...initial,
      adminOpenids: [' U1 ', '', 'U2 '],
      access: { c2cMode: 'open', c2cAllow: [], groupMode: 'allowlist', groupAllow: [' G1 ', ' ', 'G2'] },
      personas: { root: '  custom-personas  ' },
      sing: { enabled: true, baseUrl: ' http://127.0.0.1:8766/ ' },
      speak: {
        enabled: true,
        voice: ' zh-CN-XiaoyiNeural ',
        rate: ' +5% ',
        maxChars: 1500,
        command: ' ',
        gsvUrl: ' http://127.0.0.1:8765 ',
        gsvSpeed: 1,
        elevenlabs: {
          ...ELEVENLABS_SPEAK_WIRE_DEFAULTS,
          enabled: true,
          defaultVoiceId: ' v-default ',
          roleVoices: { ' narrator ': ' v1 ', empty: '  ' },
        },
        deepseek: {
          ...DEEPSEEK_SPEAK_WIRE_DEFAULTS,
          enabled: true,
          roleVoices: { dm: ' tide ', blank: '' },
        },
      },
    };

    const changed = normalizeChangedConfig(edited, initial);
    expect(changed.streaming).toBeUndefined();
    expect(changed.adminOpenids).toEqual(['U1', 'U2']);
    expect(changed.access).toEqual({ c2cMode: 'open', c2cAllow: [], groupMode: 'allowlist', groupAllow: ['G1', 'G2'] });
    expect(changed.personas).toEqual({ root: 'custom-personas' });
    expect(changed.sing).toEqual({ enabled: true, baseUrl: 'http://127.0.0.1:8766/' });
    expect(changed.speak).toMatchObject({
      voice: 'zh-CN-XiaoyiNeural',
      rate: '+5%',
      command: '',
      gsvUrl: 'http://127.0.0.1:8765',
      elevenlabs: {
        defaultVoiceId: 'v-default',
        roleVoices: { narrator: 'v1' },
      },
      deepseek: {
        roleVoices: { dm: 'tide' },
      },
    });
  });

  it('roleVoices 格式化、解析与空白清洗保持任意 personaId 通用映射', () => {
    const map: Record<string, string> = { ' narrator ': ' v-narrator ', dm: 'v-dm', empty: '   ' };
    expect(formatRoleVoices(map)).toBe('narrator=v-narrator\ndm=v-dm');
    expect(parseRoleVoices('narrator = v1\ndm=tide\nbadline\nemptyValue=\n=emptyKey')).toEqual({
      narrator: 'v1',
      dm: 'tide',
    });
    expect(cleanRoleVoicesMap({ ' a ': ' 1 ', b: ' ' })).toEqual({ a: '1' });
  });

  it('折叠抽屉摘要按当前启用状态准确汇总', () => {
    expect(summarizeDndAdvanced({})).toBe('数据目录 · 快照间隔 · 战斗代理');
    expect(summarizeDndAdvanced({ dnd: { enabled: true, root: '', turnButtons: true, interjections: true, combatAgent: { enabled: true, provider: 'p', model: 'm', reasoningEffort: '', contextChars: 8000 } } })).toBe('战斗代理已开启');

    expect(summarizeMediaDrawer({})).toBe('默认仅基础下载');
    expect(summarizeMediaDrawer({
      vision: { enabled: false, native: true, provider: '', model: '', defaultPrompt: '', maxBytes: 1, maxTokens: 1, timeoutMs: 1 },
      speak: { enabled: true, voice: '', rate: '', maxChars: 100, command: '', gsvUrl: '', gsvSpeed: 1 },
    })).toBe('视觉 · 语音合成');

    expect(summarizeExtrasDrawer({})).toBe('笔记 · 故障切换 · B站/搜图/点歌');
    expect(summarizeExtrasDrawer({
      notes: { enabled: true, root: '', autoInject: true, injectTopK: 2, injectMaxChars: 600, injectMinCoverage: 0.4 },
      bili: { enabled: true },
      sing: { enabled: true, baseUrl: '' },
    })).toBe('笔记已开 · 2 项扩展已开启');
  });
});
