import { describe, expect, it } from 'vitest';
import {
  cleanRoleVoicesMap,
  DEEPSEEK_SPEAK_WIRE_DEFAULTS,
  ELEVENLABS_SPEAK_WIRE_DEFAULTS,
  formatExtraRoleVoices,
  getRoleVoiceValue,
  mergeExtraRoleVoices,
  normalizeChangedConfig,
  setBuiltinRoleVoice,
  shallowEqual,
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
          roleVoices: { ' feiyu ': ' v1 ', empty: '  ' },
        },
        deepseek: {
          ...DEEPSEEK_SPEAK_WIRE_DEFAULTS,
          enabled: true,
          roleVoices: { hakimi: ' tide ', blank: '' },
        },
      },
    };

    const changed = normalizeChangedConfig(edited, initial);
    expect(changed.streaming).toBeUndefined();
    expect(changed.adminOpenids).toEqual(['U1', 'U2']);
    expect(changed.access).toEqual({ c2cMode: 'open', c2cAllow: [], groupMode: 'allowlist', groupAllow: ['G1', 'G2'] });
    expect(changed.personas).toEqual({ root: 'custom-personas' });
    expect(changed.speak).toMatchObject({
      voice: 'zh-CN-XiaoyiNeural',
      rate: '+5%',
      command: '',
      gsvUrl: 'http://127.0.0.1:8765',
      elevenlabs: {
        defaultVoiceId: 'v-default',
        roleVoices: { feiyu: 'v1' },
      },
      deepseek: {
        roleVoices: { hakimi: 'tide' },
      },
    });
  });

  it('roleVoices 读写、格式化与额外人设合并保持内置/自定义隔离', () => {
    let map: Record<string, string> = { Feiyu: 'v-feiyu', 'soft-whale': 'v-whale' };
    expect(getRoleVoiceValue(map, 'feiyu')).toBe('v-feiyu');
    expect(getRoleVoiceValue(map, 'dragon')).toBe('');

    map = setBuiltinRoleVoice(map, 'dragon', ' v-dragon ');
    expect(map).toEqual({ Feiyu: 'v-feiyu', 'soft-whale': 'v-whale', dragon: 'v-dragon' });

    map = setBuiltinRoleVoice(map, 'feiyu', '   ');
    expect(map).toEqual({ 'soft-whale': 'v-whale', dragon: 'v-dragon' });

    expect(formatExtraRoleVoices(map)).toBe('soft-whale=v-whale');
    expect(mergeExtraRoleVoices(map, 'feiyu=ignored\nnew-role = v-new\nbadline')).toEqual({
      dragon: 'v-dragon',
      'new-role': 'v-new',
    });
    expect(cleanRoleVoicesMap({ ' a ': ' 1 ', b: ' ' })).toEqual({ a: '1' });
  });
});
