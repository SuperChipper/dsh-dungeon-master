/**
 * 统一存储路径解析（惰性计算 `homedir()` 与 `DSH_HOME`，严禁在模块顶层缓存路径，
 * 以便单测通过 mock `homedir` 或 stub `DSH_HOME` 隔离磁盘路径）。
 *
 * 目录布局保持 100% 向后兼容：
 * - DSH 数据目录（支持 `$DSH_HOME`，默认 `~/.dsh`）：
 *   qqbot-memory / qqbot-logs / qqbot-notes / qqbot-media-review / bili-read / settings.yaml / .env
 * - QQ Bot 历史运行态目录（固定 `~/.dsh-qqbot`）：
 *   personas / persona-state.json / persona-handoffs / tool-access.json / model-prefs.json / media
 */
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

/** 把前导 `~` / `~/` / `~\` 展开为家目录 */
export function expandHomePath(input: string, homeDir?: string): string {
  const home = homeDir ?? homedir();
  if (input === '~') return home;
  if (input.startsWith('~/') || input.startsWith('~\\')) return join(home, input.slice(2));
  return input;
}

/** 解析当前 DSH 家目录（未传显式 homeDir 时优先读 `$DSH_HOME`，否则 `~/.dsh`） */
export function dshHomeDir(homeDir?: string): string {
  const fromEnv = homeDir === undefined ? process.env.DSH_HOME?.trim() : undefined;
  if (fromEnv !== undefined && fromEnv.length > 0) {
    return resolve(expandHomePath(fromEnv, homeDir));
  }
  return resolve(homeDir ?? homedir(), '.dsh');
}

/** 沿用 `~/.dsh-qqbot` 历史目录，保证既有用户人设/偏好/工具白名单不迁移丢路径 */
export function qqbotLegacyHomeDir(homeDir?: string): string {
  return resolve(homeDir ?? homedir(), '.dsh-qqbot');
}

/** 存储键名/文件段安全字符清洗 */
export function sanitizeStorageKey(value: string): string {
  return String(value).replace(/[^a-zA-Z0-9_-]/g, '_');
}

export function qqbotMemoryDir(homeDir?: string): string {
  return join(dshHomeDir(homeDir), 'qqbot-memory');
}

export function groupMemoryPath(appId: string, groupId: string, homeDir?: string): string {
  return join(qqbotMemoryDir(homeDir), `${sanitizeStorageKey(appId)}-${sanitizeStorageKey(groupId)}.jsonl`);
}

export function groupMemoryCursorPath(appId: string, groupId: string, homeDir?: string): string {
  return join(qqbotMemoryDir(homeDir), `${sanitizeStorageKey(appId)}-${sanitizeStorageKey(groupId)}.cursor.json`);
}

export function senderAliasesPath(appId: string, groupId: string, dir?: string): string {
  return resolve(dir ?? qqbotMemoryDir(), `${sanitizeStorageKey(appId)}-${sanitizeStorageKey(groupId)}.aliases.json`);
}

export function qqbotLogsDir(homeDir?: string): string {
  return join(dshHomeDir(homeDir), 'qqbot-logs');
}

export function qqbotNotesMetricsPath(homeDir?: string): string {
  return join(dshHomeDir(homeDir), 'qqbot-notes', 'metrics.json');
}

export function qqbotMediaReviewDir(homeDir?: string): string {
  return join(dshHomeDir(homeDir), 'qqbot-media-review');
}

export function biliCredentialPath(homeDir?: string): string {
  return join(dshHomeDir(homeDir), 'bili-read', 'credential.json');
}

export function dshSettingsPath(homeDir?: string): string {
  return join(dshHomeDir(homeDir), 'settings.yaml');
}

export function dshEnvPath(homeDir?: string): string {
  return join(dshHomeDir(homeDir), '.env');
}

export function defaultEnvFiles(homeDir?: string): string[] {
  return [
    resolve(PACKAGE_ROOT, '.env.local'),
    resolve(PACKAGE_ROOT, '.env'),
    dshEnvPath(homeDir),
  ];
}

export function qqbotLegacyMediaDir(homeDir?: string): string {
  return join(qqbotLegacyHomeDir(homeDir), 'media');
}

export function qqbotPersonasDir(homeDir?: string): string {
  return join(qqbotLegacyHomeDir(homeDir), 'personas');
}

export function qqbotPersonaStatePath(homeDir?: string): string {
  return join(qqbotLegacyHomeDir(homeDir), 'persona-state.json');
}

export function qqbotPersonaHandoffsDir(homeDir?: string): string {
  return join(qqbotLegacyHomeDir(homeDir), 'persona-handoffs');
}

export function qqbotToolAccessPath(homeDir?: string): string {
  return join(qqbotLegacyHomeDir(homeDir), 'tool-access.json');
}

export function qqbotModelPrefsPath(homeDir?: string): string {
  return join(qqbotLegacyHomeDir(homeDir), 'model-prefs.json');
}
