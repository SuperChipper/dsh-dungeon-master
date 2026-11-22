import { afterEach, describe, expect, it, vi } from 'vitest';
import { join, resolve } from 'node:path';
import {
  biliCredentialPath,
  defaultEnvFiles,
  dshEnvPath,
  dshHomeDir,
  dshSettingsPath,
  expandHomePath,
  groupMemoryCursorPath,
  groupMemoryPath,
  qqbotLegacyHomeDir,
  qqbotLegacyMediaDir,
  qqbotLogsDir,
  qqbotMediaReviewDir,
  qqbotMemoryDir,
  qqbotModelPrefsPath,
  qqbotNotesMetricsPath,
  qqbotPersonaHandoffsDir,
  qqbotPersonasDir,
  qqbotPersonaStatePath,
  qqbotToolAccessPath,
  sanitizeStorageKey,
  senderAliasesPath,
} from './paths.ts';

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('shared/paths', () => {
  it('expandHomePath 正确展开 ~ 前缀并保留普通路径', () => {
    expect(expandHomePath('~', '/fake/home')).toBe('/fake/home');
    expect(expandHomePath('~/sub/dir', '/fake/home')).toBe(join('/fake/home', 'sub/dir'));
    expect(expandHomePath('/abs/path', '/fake/home')).toBe('/abs/path');
  });

  it('dshHomeDir 优先读取 DSH_HOME（支持 ~ 展开），显式传入 homeDir 时以其为准', () => {
    vi.stubEnv('DSH_HOME', '/custom/dsh-home');
    expect(dshHomeDir()).toBe(resolve('/custom/dsh-home'));
    expect(dshHomeDir('/explicit/home')).toBe(resolve('/explicit/home', '.dsh'));
    expect(qqbotMemoryDir('/explicit/home')).toBe(join(resolve('/explicit/home', '.dsh'), 'qqbot-memory'));
    expect(qqbotLogsDir('/explicit/home')).toBe(join(resolve('/explicit/home', '.dsh'), 'qqbot-logs'));
    expect(qqbotNotesMetricsPath('/explicit/home')).toBe(join(resolve('/explicit/home', '.dsh'), 'qqbot-notes', 'metrics.json'));
    expect(qqbotMediaReviewDir('/explicit/home')).toBe(join(resolve('/explicit/home', '.dsh'), 'qqbot-media-review'));
    expect(biliCredentialPath('/explicit/home')).toBe(join(resolve('/explicit/home', '.dsh'), 'bili-read', 'credential.json'));
    expect(dshSettingsPath('/explicit/home')).toBe(join(resolve('/explicit/home', '.dsh'), 'settings.yaml'));
    expect(dshEnvPath('/explicit/home')).toBe(join(resolve('/explicit/home', '.dsh'), '.env'));
  });

  it('sanitizeStorageKey 与各存储文件路径保持兼容格式', () => {
    expect(sanitizeStorageKey('app/1:2?')).toBe('app_1_2_');
    expect(groupMemoryPath('app:1', 'group/2', '/home/u')).toBe(
      join(resolve('/home/u', '.dsh'), 'qqbot-memory', 'app_1-group_2.jsonl'),
    );
    expect(groupMemoryCursorPath('app:1', 'group/2', '/home/u')).toBe(
      join(resolve('/home/u', '.dsh'), 'qqbot-memory', 'app_1-group_2.cursor.json'),
    );
    expect(senderAliasesPath('app:1', 'group/2', '/custom/mem')).toBe(
      resolve('/custom/mem', 'app_1-group_2.aliases.json'),
    );
  });

  it('沿用 ~/.dsh-qqbot 历史目录与 .env 探测列表', () => {
    expect(qqbotLegacyHomeDir('/home/u')).toBe(resolve('/home/u', '.dsh-qqbot'));
    expect(qqbotLegacyMediaDir('/home/u')).toBe(join(resolve('/home/u', '.dsh-qqbot'), 'media'));
    expect(qqbotPersonasDir('/home/u')).toBe(join(resolve('/home/u', '.dsh-qqbot'), 'personas'));
    expect(qqbotPersonaStatePath('/home/u')).toBe(join(resolve('/home/u', '.dsh-qqbot'), 'persona-state.json'));
    expect(qqbotPersonaHandoffsDir('/home/u')).toBe(join(resolve('/home/u', '.dsh-qqbot'), 'persona-handoffs'));
    expect(qqbotToolAccessPath('/home/u')).toBe(join(resolve('/home/u', '.dsh-qqbot'), 'tool-access.json'));
    expect(qqbotModelPrefsPath('/home/u')).toBe(join(resolve('/home/u', '.dsh-qqbot'), 'model-prefs.json'));
    expect(defaultEnvFiles('/home/u').at(-1)).toBe(join(resolve('/home/u', '.dsh'), '.env'));
  });
});
