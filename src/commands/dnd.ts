/**
 * 跑团命令：/dnd — 开团、结团、看团况、列模组
 *
 * 开团后这个会话每回合注入 DM 守则和团况，模型用 dnd_* 工具裁定；结团后恢复普通聊天。
 * 子命令只用英文（start/search/spells…），不和中文混写；回复内容照常是中文。
 */
import type { CommandDeps, CategorizedCommand } from './types.ts';
import type { ReplyTarget } from '../types.ts';
import { getScopePeer } from '../shared/index.ts';
import { playerStatus } from '../dnd/campaign.ts';
import { buildTextMap } from '../dnd/text-map.ts';
import { mapCaption, renderPartyMap } from '../dnd/map-view.ts';
import { join } from 'node:path';

const USAGE = [
  '用法：',
  '/dnd start [模组id] — 开团（同一模组的旧团会接着跑），群里会带签到按钮，人齐自动开场',
  '/dnd new [模组id] [blank] — 存档旧团开新团（默认带上 PC 卡，加 blank 从零建卡）',
  '/dnd status — 看团况（战斗中发战斗图，带血量、先攻和你到各人的距离）',
  '/dnd combat — 查看最近一场战斗代理的模型与用量（缓存单列）',
  '/dnd map [battle|explore] — 发地图：战斗中是站位图，平时是探索过的地方（和 DM 发的是同一张）',
  '/dnd checkpoint [名称|list] — 保存或查看命名检查点（开团与停团均可用，便于整段快速回退）',
  '/dnd undo [list|步数N|cp-编号|检查点名] — 查看可回退记录，或一步回退到检查点/最近 N 步',
  '/dnd checkin — 再发一次签到按钮',
  '/dnd end [摘要] — 原子保存停团交接并唤醒 DM 私有备团（战斗状态保留）；也可直接说「今天先到这」',
  '/dnd dungeons — 列出可用模组',
  '/dnd search <词条> — 查 wiki（法术、技能、职业、专长、怪物…），如 /dnd search 火球术',
  '/dnd spells [职业] — 职业法术列表，如 /dnd spells 牧师',
  '/dnd help — 怎么玩',
].join('\n');

/** 把内部工具快照标签脱敏为玩家安全摘要，避免向群聊泄露 DC、暗骰或 DM 机密参数。 */
function sanitizeUndoLabel(label: string): string {
  const rollMatch = /#R\d+/.exec(label);
  const rollTag = rollMatch !== null ? ` (${rollMatch[0]})` : '';
  if (label.startsWith('恢复检查点')) return label;
  if (label.startsWith('按钮 ')) return label;
  if (label.startsWith('dnd_move')) return '房间移动';
  if (label.startsWith('dnd_check')) return `检定/掷骰${rollTag}`;
  if (label.startsWith('dnd_apply')) return `数值/状态结算${rollTag}`;
  if (label.startsWith('dnd_initiative')) return '战斗先攻变动';
  if (label.startsWith('dnd_position')) return '战场站位变动';
  if (label.startsWith('dnd_character')) return '角色卡改动';
  if (label.startsWith('dnd_resource')) return '资源变动';
  if (label.startsWith('dnd_rest')) return '队伍休息';
  if (label.startsWith('dnd_story')) return '剧情状态变动';
  if (label.startsWith('dnd_progress')) return '进度存档';
  if (label.startsWith('dnd_chronicle')) return '剧情账本变动';
  return `团档改动${rollTag}`;
}

const RULES_WIKI = 'https://dnd.huijiwiki.com/wiki/';

/**
 * 灰机 wiki 查询链接。wiki 前面有 Cloudflare 验证，机器人抓不到正文，只发链接：
 * MediaWiki 搜索词和标题完全一致时会直接跳到词条页，否则给搜索结果。
 */
export function wikiSearchUrl(query: string): string {
  return `https://dnd.huijiwiki.com/index.php?search=${encodeURIComponent(query.trim())}`;
}

const SPELL_CLASSES = ['吟游诗人', '牧师', '德鲁伊', '圣武士', '游侠', '术士', '邪术师', '法师', '奇械师'];

const HELP = [
  '🎲 跑团怎么玩',
  '',
  '【开团与签到】',
  '· /dnd start 的那条消息就是签到表：到了点「签到」，人齐了我直接开场。',
  '· 有人来不了就点「开始」，没签到的角色会暂时移出队伍，晚到点「签到」即可归队。想看谁到了点「名单」。',
  '',
  '【说行动】',
  '· 要 @我，并说清角色做什么：「卡厄斯用巨剑砍地精3」「恩佐潜行到门口听动静」。',
  '· 不 @ 的话、吐槽、问规则、「查询状态」都不算行动，不会掷骰也不消耗动作。',
  '· 只能控制自己的角色。想让别人做什么，跟他本人说。',
  '· 骰子都由我掷，点数会写出来；DC、怪物 AC 和血量不报，只说伤势。',
  '',
  '【战斗】',
  '· 按先攻顺序来，轮到你时我会发一条带按钮的消息。',
  '· 动作、附赠动作、移动都说完了，点「结束回合」。只有这个角色的玩家本人点才算。',
  '· 「查看状态」：看大家的血量、资源和行动顺序。',
  '· 没轮到你就先说，我记下来，等你的回合再结算。借机攻击、反应随时可以喊。',
  '',
  '【分头行动】',
  '· 只有说了要去的人才会过去，其他人留在原地。',
  '',
  '【资源与休息】',
  '· 法术位、圣疗、诗人激励、生命骰都有记录，用之前说一声「用掉 xx」。',
  '· 「短休」「长休」直接说，我会结算。',
  '',
  '【判错了】',
  '· 大家同意的话说「卷回到 xx 之前」，或用 /dnd checkpoint 记检查点、/dnd undo 快速回退，不会硬改数字。',
  '',
  '【查规则】',
  '· /dnd search 火球术：给出 wiki 词条链接，法术、技能、职业特性、专长、怪物都能查。',
  '· /dnd spells 牧师：职业法术列表。',
  '· 回合按钮里的「法术/能力」列出你自己卡上的法术、职业动作与充能能力，带 wiki 链接；卡上还没有就找 DM 补。',
  `· wiki 首页：${RULES_WIKI}`,
  '',
  '命令：/dnd start｜new｜status｜combat｜map｜checkpoint｜undo｜checkin｜end｜dungeons｜search｜spells｜help',
].join('\n');

export function dndCommand({ manager }: CommandDeps): CategorizedCommand {
  return {
    name: 'dnd',
    category: 'qqbot',
    description: '跑团：开团/结团/团况/检查点回退/战斗用量/玩法说明（用法: /dnd start|new|status|combat|map|checkpoint|undo|checkin|end|dungeons|search|spells|help）',
    handler: async (cmdCtx) => {
      const service = manager.dndService;
      if (service === undefined) return '跑团功能未启用（配置 dnd.enabled）';
      const { scope, peerId } = getScopePeer(cmdCtx);
      const key = manager.sessionKey(scope, peerId);
      const [sub = '', arg, ...more] = (cmdCtx.command?.raw ?? '').trim().split(/\s+/);
      const rest = [arg, ...more].filter((s): s is string => s !== undefined && s.length > 0).join(' ');
      // 带按钮的回复直接回这条 /dnd 消息（被动回复），不借会话里上一条消息的 msgId
      const target: ReplyTarget = { scope, targetId: peerId, msgId: cmdCtx.message.messageId, receivedAt: Date.now() };
      if (sub === 'combat') return manager.combatAgents?.report(key) ?? '战斗代理不可用。';

      // 查规则不需要开团，也不需要启用跑团服务之外的东西
      if (sub === 'search') {
        if (rest.length === 0) return `用法：/dnd search <词条>，如 /dnd search 火球术\nwiki 首页：${RULES_WIKI}`;
        return `📖 ${rest}：${wikiSearchUrl(rest)}`;
      }
      if (sub === 'spells') {
        if (rest.length === 0) {
          return ['📖 职业法表（点开是 wiki 搜索，标题对上会直接跳到词条页）：', ...SPELL_CLASSES.map((cls) => `${cls}：${wikiSearchUrl(`${cls}法术列表`)}`)].join('\n');
        }
        return `📖 ${rest}法表：${wikiSearchUrl(`${rest}法术列表`)}`;
      }

      if (sub === 'dungeons') {
        return ['可用模组：', ...service.library.list().map((a) => {
          const rooms = a.sites.reduce((n, s) => n + s.rooms.length, 0);
          return `- ${a.id}：${a.name}（${a.sites.length > 1 ? `${a.sites.length} 个场景，` : ''}${rooms} 个房间）`;
        })].join('\n');
      }

      if (sub === 'start' || sub === 'new') {
        await manager.waitForDndTransition?.(scope, peerId);
        let text: string;
        try {
          // blank 不带旧角色卡；其余的词当模组 id
          const words = [arg, ...more].filter((s): s is string => s !== undefined && s.length > 0);
          const blank = words.includes('blank');
          const id = words.find((w) => w !== 'blank');
          const { adventure, resumed, campaign, carried } = service.start(key, id, sub === 'new', { keepParty: !blank });
          const party = campaign.characters.filter((ch) => ch.kind === 'pc').map((ch) => ch.name);
          const lines = [
            `🎲 ${resumed ? '继续' : '开团'}：${adventure.name}`,
            resumed ? `队伍：${party.join('、') || '还没有角色'}` : adventure.hook,
          ];
          if (carried.length > 0) lines.push(`带上了 ${carried.length} 张角色卡：${carried.join('、')}（HP、资源、物品照旧）。想从空卡开始：/dnd new ${adventure.id} blank`);
          lines.push('', scope === 'group' ? '跑团期间 @ 我说你的行动。' : '直接说你的行动；还没有角色就先告诉我名字和职业。');
          text = lines.join('\n');
        } catch (err) {
          return err instanceof Error ? err.message : String(err);
        }
        // 群里：开团消息本身就是签到表（每次开团清空重来）；按钮不可用时退回纯文字
        if (scope === 'group' && await manager.dndButtons?.openCheckIn(key, target, text, true) === true) return { kind: 'noop' as const };
        return scope === 'group' ? `${text}\n还没有角色的先 @ 我说名字和职业来建卡。` : text;
      }

      if (sub === 'end') {
        const summary = rest.trim() || undefined;
        if (typeof manager.endDndSession === 'function') {
          const outcome = await manager.endDndSession({
            scope,
            peerId,
            senderId: cmdCtx.message.senderId,
            target,
            ...(summary !== undefined ? { summary } : {}),
          });
          if (outcome.status === 'handed_off' || outcome.status === 'busy') return { kind: 'noop' as const };
          if (outcome.status === 'inactive') return '现在没有进行中的团。';
          return outcome.message;
        }
        try {
          const stopped = service.stop(key, summary);
          return stopped === undefined ? '现在没有进行中的团。' : { kind: 'noop' as const };
        } catch (err) {
          return err instanceof Error ? err.message : String(err);
        }
      }

      if (sub === 'status') {
        const found = service.active(key);
        if (found === undefined) return '现在没有进行中的团。';
        // markdown 发得出去就画站位图；发不出去退回纯文字的坐标列表
        if (await manager.dndButtons?.sendStatus(key, target, cmdCtx.message.senderId) === true) return { kind: 'noop' as const };
        return `🎲 ${found.adventure.name}\n${playerStatus(found.campaign, found.adventure, cmdCtx.message.senderId)}`;
      }

      if (sub === 'map') {
        const found = service.active(key);
        if (found === undefined) return '现在没有进行中的团。';
        const view = arg === 'battle' || arg === 'explore' ? arg : 'auto';
        if (service.sendImage !== undefined) {
          try {
            const out = join(service.mapDir, `${key.replace(/[^a-zA-Z0-9_-]+/g, '_')}-cmd-${Date.now()}.png`);
            const globalEffects = service.globalEffects();
            const map = await renderPartyMap(found.campaign, found.adventure, out, view, { globalEffects });
            if (map !== undefined) {
              await service.sendImage(target, map.path, mapCaption(found.campaign, found.adventure, map.kind, globalEffects));
              return { kind: 'noop' as const };
            }
          } catch (err) {
            // 战斗图要场地图；还没画就说一句，别退回一张对不上的文字图
            if (view === 'battle') return `${err instanceof Error ? err.message : String(err)}，等 DM 摆好位再看。`;
          }
        }
        // 没装 sharp 或者图发不出去：退回聊天框里的文字地图
        return buildTextMap(found.campaign, found.adventure);
      }

      if (sub === 'checkpoint') {
        const found = service.active(key) ?? service.saved(key);
        if (found === undefined) return '这个群还没有团档，先用 /dnd start 开团。';
        if (arg === 'list') {
          const cps = service.store.checkpoints(key).slice(-10).reverse();
          if (cps.length === 0) return '还没有保存过检查点。用 /dnd checkpoint <名称> 保存一个。';
          return [
            '📌 已保存的检查点（新→旧，用 /dnd undo cp-N 一步回退）：',
            ...cps.map((cp) => `- ${cp.id}「${cp.name}」${cp.auto === true ? '[自动]' : '[手动]'}`),
          ].join('\n');
        }
        try {
          const cp = service.store.saveCheckpoint(key, rest.trim() || '手动检查点');
          return `📌 已保存检查点 ${cp.id}「${cp.name}」。需要回退时发送 /dnd undo ${cp.id}。`;
        } catch (err) {
          return err instanceof Error ? err.message : String(err);
        }
      }

      if (sub === 'undo') {
        const found = service.active(key) ?? service.saved(key);
        if (found === undefined) return '这个群还没有团档，先用 /dnd start 开团。';
        if (rest.length === 0 || arg === 'list') {
          const cps = service.store.checkpoints(key).slice(-8).reverse();
          const steps = service.store.snapshots(key).slice(-8).reverse();
          if (cps.length === 0 && steps.length === 0) return '没有可回退的检查点或改动记录。';
          const parts: string[] = [];
          if (cps.length > 0) {
            parts.push([
              '📌 检查点（/dnd undo cp-N 一步回退）：',
              ...cps.map((cp) => `- ${cp.id}「${cp.name}」${cp.auto === true ? '[自动]' : '[手动]'}`),
            ].join('\n'));
          }
          if (steps.length > 0) {
            parts.push([
              '⏪ 最近改动（/dnd undo N 回退前 N 步）：',
              ...steps.map((s, i) => `${i + 1}. ${sanitizeUndoLabel(s.label)}`),
            ].join('\n'));
          }
          return parts.join('\n\n');
        }
        try {
          if (/^\d+$/.test(rest)) {
            const count = Number(rest);
            const undone = service.store.undo(key, count);
            service.forceNextSnapshot(key);
            return [
              `⏪ 已回退最近 ${undone.length} 步：`,
              ...undone.map((l, i) => `${i + 1}. ${sanitizeUndoLabel(l)}`),
            ].join('\n');
          }
          const { checkpoint } = service.store.restoreCheckpoint(key, rest);
          service.forceNextSnapshot(key);
          return `⏪ 已回退到检查点 ${checkpoint.id}「${checkpoint.name}」（回退前状态已留档，误回退可发 /dnd undo 1 恢复）。`;
        } catch (err) {
          return err instanceof Error ? err.message : String(err);
        }
      }

      if (sub === 'checkin') {
        if (service.active(key) === undefined) return '现在没有进行中的团，先 /dnd start。';
        if (scope !== 'group') return '签到只在群里用。';
        if (await manager.dndButtons?.openCheckIn(key, target, '', false) === true) return { kind: 'noop' as const };
        return '签到按钮没开（配置 dnd.turnButtons，或机器人没有消息按钮权限）。';
      }

      if (sub === 'help') return HELP;

      return USAGE;
    },
  };
}
