import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
import type { ImQQBotConfig } from '../config.ts';
import { createToolGuard, hasFullToolAccess, type ToolGuardSession } from './tool-guard.ts';

const OWNER = 'OWNER';
const GROUP = 'GROUP_A';
const WHITE_GROUP = 'GROUP_W';

function makeConfig(over: Partial<ImQQBotConfig['toolAccess']> = {}, sensitivePaths: string[] = []): ImQQBotConfig {
  return {
    ownerOpenid: OWNER,
    fileAccess: { sensitivePaths },
    toolAccess: { enabled: true, fullAccessGroups: [WHITE_GROUP], fullAccessUsers: [], readRoots: [], ...over },
  } as unknown as ImQQBotConfig;
}

function setup(config = makeConfig()) {
  const cwd = mkdtempSync(join(tmpdir(), 'guard-'));
  const media = join(cwd, 'media');
  mkdirSync(media);
  const campaigns = join(cwd, 'dnd', 'campaigns');
  mkdirSync(campaigns, { recursive: true });
  writeFileSync(join(media, 'a.png'), 'x');
  writeFileSync(join(cwd, '.env'), 'SECRET=1');
  const agents = new Map<object, ToolGuardSession>();
  const agentFor = (session: ToolGuardSession): object => {
    const agent = {};
    agents.set(agent, session);
    return agent;
  };
  const guard = createToolGuard({
    config,
    isFullAccess: (s) => hasFullToolAccess(s, config),
    findSession: (agent) => agents.get(agent as object),
    roots: [media],
    noWriteRoots: [campaigns],
    cwd,
  });
  return { guard, cwd, media, campaigns, agentFor };
}

describe('hasFullToolAccess', () => {
  const config = makeConfig();
  it('主人私聊和白名单群有完整权限，其它没有', () => {
    expect(hasFullToolAccess({ scope: 'c2c', peerId: OWNER }, config)).toBe(true);
    expect(hasFullToolAccess({ scope: 'group', peerId: WHITE_GROUP }, config)).toBe(true);
    expect(hasFullToolAccess({ scope: 'group', peerId: GROUP }, config)).toBe(false);
    expect(hasFullToolAccess({ scope: 'c2c', peerId: 'someone' }, config)).toBe(false);
    // 群 openid 恰好等于主人 openid 也不算主人私聊
    expect(hasFullToolAccess({ scope: 'group', peerId: OWNER }, config)).toBe(false);
  });

  it('运行时授予的白名单生效；关闭限制时全部放行', () => {
    expect(hasFullToolAccess({ scope: 'group', peerId: GROUP }, config, { groups: [GROUP], users: [] })).toBe(true);
    expect(hasFullToolAccess({ scope: 'group', peerId: GROUP }, makeConfig({ enabled: false }))).toBe(true);
  });
});

describe('createToolGuard', () => {
  it('本机会话（不在 QQ 会话表里）不受影响', () => {
    const { guard } = setup();
    expect(guard({ name: 'pwsh', arguments: { command: 'type .env' }, agent: {} })).toBeUndefined();
  });

  it('非白名单群：终端和子 agent 一律拒绝', () => {
    const { guard, agentFor } = setup();
    const agent = agentFor({ scope: 'group', peerId: GROUP });
    expect(guard({ name: 'pwsh', arguments: { command: 'dir' }, agent })).toMatch(/终端权限/);
    expect(guard({ name: 'terminal_open', arguments: {}, agent })).toMatch(/终端权限/);
    expect(guard({ name: 'subagent', arguments: {}, agent })).toMatch(/子 agent/);
  });

  it('非白名单群：文件工具只能碰允许的目录', () => {
    const { guard, agentFor, cwd, media } = setup();
    const agent = agentFor({ scope: 'group', peerId: GROUP });
    expect(guard({ name: 'read', arguments: { file_path: join(media, 'a.png') }, agent })).toBeUndefined();
    expect(guard({ name: 'read', arguments: { file_path: join(cwd, '.env') }, agent })).toMatch(/不在允许范围/);
    expect(guard({ name: 'read', arguments: { file_path: 'media/../.env' }, agent })).toMatch(/不在允许范围/);
    expect(guard({ name: 'write', arguments: { file_path: join(cwd, 'x.txt'), content: '' }, agent })).toMatch(/不在允许范围/);
    expect(guard({ name: 'qqbot_send_file', arguments: { file_path: join(cwd, '.env') }, agent })).toMatch(/不在允许范围/);
    expect(guard({ name: 'qqbot_video_frames', arguments: { video: join(media, 'clip.mp4'), timestamps: [0] }, agent })).toBeUndefined();
    expect(guard({ name: 'qqbot_video_frames', arguments: { video: join(cwd, 'private.mp4'), timestamps: [0] }, agent })).toMatch(/不在允许范围/);
    expect(guard({ name: 'qqbot_image_gen', arguments: { prompt: 'hi', images: [join(media, 'a.png')] }, agent })).toBeUndefined();
    expect(guard({ name: 'qqbot_image_gen', arguments: { prompt: 'hi', images: [join(cwd, '.env')] }, agent })).toMatch(/不在允许范围/);
    expect(guard({ name: 'qqbot_image_gen', arguments: { prompt: 'hi', out_dir: cwd }, agent })).toMatch(/不在允许范围/);
  });

  it('非白名单群：grep/glob 必须给 path，通配不能跳出', () => {
    const { guard, agentFor, media } = setup();
    const agent = agentFor({ scope: 'group', peerId: GROUP });
    expect(guard({ name: 'grep', arguments: { pattern: 'SECRET' }, agent })).toMatch(/必须用 path/);
    expect(guard({ name: 'grep', arguments: { pattern: '/SECRET/', path: media }, agent })).toBeUndefined();
    expect(guard({ name: 'glob', arguments: { pattern: '../**/*.env', path: media }, agent })).toMatch(/不在允许范围/);
    expect(guard({ name: 'glob', arguments: { pattern: 'C:/Users/**', path: media }, agent })).toMatch(/不在允许范围/);
    expect(guard({ name: 'glob', arguments: { pattern: '**/*.png', path: media }, agent })).toBeUndefined();
  });

  it('白名单群和主人私聊放行任意路径和终端，敏感路径也不拦', () => {
    const base = setup();
    const config = makeConfig({}, [join(base.cwd, '.env')]);
    const { guard, agentFor, cwd } = setup(config);
    const owner = agentFor({ scope: 'c2c', peerId: OWNER });
    const white = agentFor({ scope: 'group', peerId: WHITE_GROUP });
    expect(guard({ name: 'pwsh', arguments: { command: 'dir' }, agent: white })).toBeUndefined();
    expect(guard({ name: 'read', arguments: { file_path: join(cwd, 'notes.md') }, agent: owner })).toBeUndefined();

    const sensitive = setup(makeConfig({}, ['.env']));
    const ownerAgent = sensitive.agentFor({ scope: 'c2c', peerId: OWNER });
    expect(sensitive.guard({ name: 'read', arguments: { file_path: join(sensitive.cwd, '.env') }, agent: ownerAgent })).toBeUndefined();
  });

  it('敏感路径：受限会话照拦（哪怕在 readRoots 里）；toolAccess 关掉时对所有会话都拦', () => {
    const inRoots = setup(makeConfig({}, [join('media', 'a.png')]));
    const restricted = inRoots.agentFor({ scope: 'group', peerId: GROUP });
    expect(inRoots.guard({ name: 'read', arguments: { file_path: join(inRoots.media, 'a.png') }, agent: restricted })).toMatch(/敏感路径/);

    const off = setup(makeConfig({ enabled: false }, ['.env']));
    const owner = off.agentFor({ scope: 'c2c', peerId: OWNER });
    const anyone = off.agentFor({ scope: 'group', peerId: GROUP });
    expect(off.guard({ name: 'read', arguments: { file_path: join(off.cwd, '.env') }, agent: owner })).toMatch(/敏感路径/);
    expect(off.guard({ name: 'read', arguments: { file_path: join(off.cwd, '.env') }, agent: anyone })).toMatch(/敏感路径/);
    expect(off.guard({ name: 'pwsh', arguments: { command: 'dir' }, agent: anyone })).toBeUndefined();
  });

  it('跑团存档目录：白名单会话也不能用 write/edit 改，读照常', () => {
    const { guard, agentFor, campaigns } = setup();
    const white = agentFor({ scope: 'group', peerId: WHITE_GROUP });
    const save = join(campaigns, 'qqbot_group_x.json');
    expect(guard({ name: 'edit', arguments: { file_path: save, old_string: 'a', new_string: 'b' }, agent: white })).toMatch(/dnd_\* 工具/);
    expect(guard({ name: 'write', arguments: { file_path: save, content: '{}' }, agent: white })).toMatch(/dnd_\* 工具/);
    expect(guard({ name: 'qqbot_image_gen', arguments: { prompt: 'map', out_dir: campaigns }, agent: white })).toMatch(/dnd_\* 工具/);
    expect(guard({ name: 'qqbot_image_gen', arguments: { prompt: 'map', images: [join(campaigns, 'pc.png')] }, agent: white })).toBeUndefined();
    expect(guard({ name: 'read', arguments: { file_path: save }, agent: white })).toBeUndefined();
    // 本机会话不受影响
    expect(guard({ name: 'edit', arguments: { file_path: save, old_string: 'a', new_string: 'b' }, agent: {} })).toBeUndefined();
  });

  it('按会话动态只读目录：有团档可只读查阅当前模组，禁止写与外发、禁止跨模组/穿越/无团档读取', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'guard-adv-'));
    const media = join(cwd, 'media');
    const toa = join(cwd, 'dnd', 'adventures', 'toa');
    const lmop = join(cwd, 'dnd', 'adventures', 'lmop');
    const campaigns = join(cwd, 'dnd', 'campaigns');
    mkdirSync(media, { recursive: true });
    mkdirSync(join(toa, 'text-zh'), { recursive: true });
    mkdirSync(join(toa, 'img'), { recursive: true });
    mkdirSync(lmop, { recursive: true });
    mkdirSync(campaigns, { recursive: true });
    writeFileSync(join(toa, 'text-zh', 'ch1.md'), '# ch1');
    writeFileSync(join(toa, 'img', 'map.png'), 'png');
    writeFileSync(join(lmop, 'adventure.json'), '{}');
    writeFileSync(join(campaigns, 'group_a.json'), '{}');

    const config = makeConfig({}, [join(toa, 'secret.txt')]);
    const agents = new Map<object, ToolGuardSession>();
    const agentFor = (session: ToolGuardSession): object => {
      const agent = {};
      agents.set(agent, session);
      return agent;
    };
    const guard = createToolGuard({
      config,
      isFullAccess: (s) => hasFullToolAccess(s, config),
      findSession: (agent) => agents.get(agent as object),
      roots: [media],
      readOnlyRootsFor: (s) => (s.scope === 'group' && s.peerId === GROUP ? [toa] : []),
      noWriteRoots: [campaigns],
      cwd,
    });

    const withCampaign = agentFor({ scope: 'group', peerId: GROUP });
    const withoutCampaign = agentFor({ scope: 'group', peerId: 'GROUP_B' });

    // 允许 read / read_image / glob / grep 查阅当前模组
    expect(guard({ name: 'read', arguments: { file_path: join(toa, 'text-zh', 'ch1.md') }, agent: withCampaign })).toBeUndefined();
    expect(guard({ name: 'read_image', arguments: { file_path: join(toa, 'img', 'map.png') }, agent: withCampaign })).toBeUndefined();
    expect(guard({ name: 'glob', arguments: { pattern: '**/*.md', path: toa }, agent: withCampaign })).toBeUndefined();
    expect(guard({ name: 'grep', arguments: { pattern: 'ch1', path: toa }, agent: withCampaign })).toBeUndefined();

    // 禁止写入、外发、生图输出与视频抽帧操作该只读目录
    for (const call of [
      { name: 'write', arguments: { file_path: join(toa, 'text-zh', 'ch1.md'), content: 'x' } },
      { name: 'edit', arguments: { file_path: join(toa, 'text-zh', 'ch1.md'), old_string: 'a', new_string: 'b' } },
      { name: 'str_replace_editor', arguments: { path: join(toa, 'text-zh', 'ch1.md') } },
      { name: 'qqbot_send_file', arguments: { file_path: join(toa, 'text-zh', 'ch1.md') } },
      { name: 'qqbot_image_gen', arguments: { prompt: 'x', images: [join(toa, 'img', 'map.png')] } },
      { name: 'qqbot_image_gen', arguments: { prompt: 'x', out_dir: toa } },
      { name: 'qqbot_video_frames', arguments: { video: join(toa, 'clip.mp4'), timestamps: [0] } },
    ]) {
      const denied = guard({ ...call, agent: withCampaign });
      expect(denied).toMatch(/只读/);
      expect(denied).toMatch(/不在允许范围/);
    }

    // 禁止穿越、无 path 搜索、读另一模组、读存档目录、读敏感路径
    expect(guard({ name: 'read', arguments: { file_path: join(toa, '..', 'lmop', 'adventure.json') }, agent: withCampaign })).toMatch(/不在允许范围/);
    expect(guard({ name: 'glob', arguments: { pattern: '../lmop/**', path: toa }, agent: withCampaign })).toMatch(/不在允许范围/);
    expect(guard({ name: 'grep', arguments: { pattern: 'ch1' }, agent: withCampaign })).toMatch(/必须用 path/);
    expect(guard({ name: 'read', arguments: { file_path: join(lmop, 'adventure.json') }, agent: withCampaign })).toMatch(/不在允许范围/);
    expect(guard({ name: 'read', arguments: { file_path: join(campaigns, 'group_a.json') }, agent: withCampaign })).toMatch(/不在允许范围/);
    expect(guard({ name: 'read', arguments: { file_path: join(toa, 'secret.txt') }, agent: withCampaign })).toMatch(/敏感路径/);

    // 没有团档的群连当前模组也读不到
    expect(guard({ name: 'read', arguments: { file_path: join(toa, 'text-zh', 'ch1.md') }, agent: withoutCampaign })).toMatch(/不在允许范围/);
  });
});
