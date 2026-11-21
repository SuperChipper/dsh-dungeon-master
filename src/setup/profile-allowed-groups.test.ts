import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import yaml from 'js-yaml';
import { updateProfileAllowedGroups } from './persist.ts';

describe('owner-approved per-group profile edits', () => {
  let dir: string, path: string;
  const log = { info: vi.fn(), warn: vi.fn() };
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'qqbot-grants-')); path = join(dir, 'cordis.patch.yml'); vi.clearAllMocks(); });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));
  const contents = () => yaml.load(readFileSync(path, 'utf8'));

  it('edits just one list, preserves mixed rows, unrelated permissions, credential fields, and defaults', () => {
    const opaque = { insert: [{ id: 'other-plugin', config: { enabled: false } }] };
    const imageGen = { apiKeyEnv: 'CUSTOM_KEY_REFERENCE', apiKey: 'test-fixture', model: 'custom-model', allowedGroups: ['A'] };
    const rest = { appId: 'fixture', browser: { allowedGroups: ['B'] }, toolAccess: { allowedGroups: ['C'] } };
    writeFileSync(path, yaml.dump([opaque, { id: 'im-qqbot', config: { ...rest, imageGen } }, { id: 'untouched' }]));
    expect(updateProfileAllowedGroups('imageGen', ['A', ' D ', 'D'], dir, log, ['A'])).toBe(true);
    expect(contents()).toEqual([opaque, { id: 'im-qqbot', config: { ...rest, imageGen: { ...imageGen, allowedGroups: ['A', 'D'] } } }, { id: 'untouched' }]);
    expect(readdirSync(dir)).toEqual(['cordis.patch.yml']);
  });
  it('can bootstrap and remove the final group without touching a sibling permission', () => {
    expect(updateProfileAllowedGroups('imageGen', ['A'], dir, log)).toBe(true);
    expect(updateProfileAllowedGroups('browser', ['B'], dir, log)).toBe(true);
    expect(updateProfileAllowedGroups('imageGen', [], dir, log, ['A'])).toBe(true);
    expect(contents()).toEqual([{ id: 'im-qqbot', config: { imageGen: { allowedGroups: [] }, browser: { allowedGroups: ['B'] } } }]);
  });
  it('declines a stale approval instead of replacing a newer settings edit', () => {
    expect(updateProfileAllowedGroups('imageGen', ['A', 'B'], dir, log)).toBe(true);
    const before = readFileSync(path);
    expect(updateProfileAllowedGroups('imageGen', ['A', 'C'], dir, log, ['A'])).toBe(false);
    expect(readFileSync(path)).toEqual(before);
  });
  it.each([
    '- id: im-qqbot\n  config: [do-not-log',
    '- insert: [{id: a}]\n',
    '- id: im-qqbot\n- id: im-qqbot\n',
    '- id: im-qqbot\n  config: {imageGen: [do-not-log]}\n',
    '- id: im-qqbot\n  config: {imageGen: {allowedGroups: do-not-log}}\n',
  ])('fails closed on malformed/ambiguous input %#, without leaking YAML', (source) => {
    writeFileSync(path, source);
    expect(updateProfileAllowedGroups('imageGen', ['G'], dir, log)).toBe(false);
    expect(readFileSync(path, 'utf8')).toBe(source);
    expect(log.warn.mock.calls.flat().join(' ')).not.toContain('do-not-log');
    expect(readdirSync(dir)).toEqual(['cordis.patch.yml']);
  });
  it('does not write an invalid list', () => {
    expect(updateProfileAllowedGroups('imageGen', [' '], dir, log)).toBe(false);
    expect(existsSync(path)).toBe(false);
  });
});
