/**
 * 跑团签到 — /dnd start 的那条消息本身就是签到表，玩家点按钮签到。
 *
 * 少刷屏：点「签到」后群里只发一行小提醒（几秒内连着签到的合成一条），让没点的人看到有人到了；
 * 人到齐了（或有人点「开始」）就不发提醒，让 DM 直接开场，开场叙述本身就是「人齐了」的信号。
 * 完整名单只在有人点「名单」时才发。
 *
 * 签到只是这一次开团的出勤，不进 campaign 存档：存档里的东西会被 dnd_undo 回滚，
 * 签到不该跟着回滚；bot 重启丢了也无所谓，/dnd checkin 再开一张就行。
 * 点击者身份取 QQ 回调里的 openid，按角色卡上绑定的 playerId 对上角色。
 */
import type { Campaign, Character } from './campaign.ts';

export interface CheckIn {
  openedAt: number;
  /** 签到的 openid → 签到时间 */
  arrived: Map<string, number>;
  /** 已经开场（人齐自动开，或有人点了「开始」）；之后再签到不再触发开场 */
  started: boolean;
  /** 上次在群里发名单的时间：「名单」按钮有冷却，连点不会刷屏 */
  rosterPostedAt?: number;
}

export interface Roster {
  /** 已签到、绑定了角色的玩家 */
  arrived: Character[];
  /** 绑定了角色但还没签到 */
  missing: Character[];
  /** 签到了但名下没有角色卡的人数（还没建卡的新玩家） */
  newcomers: number;
  /** 没绑定玩家的 PC：没法按人签到，单独列出来提醒绑定 */
  unbound: Character[];
}

export function createCheckIn(now = Date.now()): CheckIn {
  return { openedAt: now, arrived: new Map(), started: false };
}

/** bot 重启后内存签到表丢失时，按团档里的 absent 状态恢复签到态（已进入暂离态说明本场已开场） */
export function rehydrateCheckIn(c: Campaign, now = Date.now()): CheckIn {
  const pcs = c.characters.filter((ch) => ch.kind === 'pc' && !ch.conditions.includes('死亡') && ch.playerId !== undefined);
  if (pcs.some((ch) => ch.absent === true)) {
    const arrived = new Map(pcs.filter((ch) => ch.absent !== true).map((ch) => [ch.playerId!, now]));
    return { openedAt: now, arrived, started: true };
  }
  return createCheckIn(now);
}

/** 签到；已经签过返回 false */
export function markArrived(ci: CheckIn, openid: string, now = Date.now()): boolean {
  if (ci.arrived.has(openid)) return false;
  ci.arrived.set(openid, now);
  return true;
}

export function rosterOf(ci: CheckIn, c: Campaign): Roster {
  const pcs = c.characters.filter((ch) => ch.kind === 'pc' && !ch.conditions.includes('死亡'));
  const bound = pcs.filter((ch) => ch.playerId !== undefined);
  const owners = new Set(bound.map((ch) => ch.playerId!));
  return {
    arrived: ci.started ? bound.filter((ch) => ch.absent !== true) : bound.filter((ch) => ci.arrived.has(ch.playerId!)),
    missing: ci.started ? bound.filter((ch) => ch.absent === true) : bound.filter((ch) => !ci.arrived.has(ch.playerId!)),
    newcomers: [...ci.arrived.keys()].filter((id) => !owners.has(id)).length,
    unbound: pcs.filter((ch) => ch.playerId === undefined),
  };
}

/** 绑定了玩家的角色全都签到了（至少有一个）：可以自动开场 */
export function isComplete(r: Roster): boolean {
  return r.arrived.length > 0 && r.missing.length === 0;
}

function who(ch: Character): string {
  return ch.player !== undefined ? `${ch.name}〈${ch.player}〉` : ch.name;
}

/** 给群里看的签到名单 */
export function rosterText(r: Roster, started = false): string {
  const total = r.arrived.length + r.missing.length;
  const lines = [`📋 签到 ${r.arrived.length}/${total}${isComplete(r) ? ' · 全员到齐' : ''}`];
  lines.push(`✅ 已到：${r.arrived.map(who).join('、') || '还没人签到'}`);
  if (r.missing.length > 0) {
    lines.push(started ? `💤 暂离（未签到，已移出队伍）：${r.missing.map(who).join('、')}` : `⏳ 未到：${r.missing.map(who).join('、')}`);
  }
  if (r.newcomers > 0) lines.push(`🆕 还有 ${r.newcomers} 位没有角色卡的玩家签到了，@ 我说名字和职业来建卡`);
  if (r.unbound.length > 0) lines.push(`（${r.unbound.map((ch) => ch.name).join('、')} 没绑定玩家，签不了到）`);
  return lines.join('\n');
}

/** 晚到或暂离角色在开场后点「签到」归队的群内提示 */
export function lateReturnNotice(returned: readonly Character[], inCombat: boolean): string {
  return `✅ ${returned.map((ch) => ch.name).join('、')} 签到归队（${inCombat ? '战斗进行中，请 @我 宣告入战或等 DM 用先攻加入' : '已回到队伍当前位置'}）`;
}

/**
 * 签到后群里的一行小提醒：谁刚到、还差谁。openids 是这一批刚签到的人（按签到顺序）。
 * 名下没有角色卡的人只报个数，顺带提醒建卡。
 */
export function arrivalNotice(openids: readonly string[], r: Roster): string {
  const byOwner = new Map(r.arrived.map((ch) => [ch.playerId!, ch]));
  const named = openids.map((id) => byOwner.get(id)).filter((ch): ch is Character => ch !== undefined);
  const strangers = openids.length - named.length;
  const parts: string[] = [];
  if (named.length > 0) parts.push(`${named.map((ch) => ch.name).join('、')} 到了`);
  if (strangers > 0) parts.push(`${strangers} 位还没角色卡的玩家到了（@我说名字和职业建卡）`);
  const total = r.arrived.length + r.missing.length;
  const tail = total === 0 ? '' : ` · ${r.arrived.length}/${total}${r.missing.length > 0 ? `，还差 ${r.missing.map((ch) => ch.name).join('、')}` : ''}`;
  return `✅ ${parts.join('；')}${tail}`;
}

/** 签到表下面的说明：大家点什么、什么时候开场 */
export function checkInHint(r: Roster): string {
  return r.arrived.length + r.missing.length > 0
    ? '到了的点「签到」，人齐了自动开场；不等了就点「开始」（未签到的角色会暂时移出队伍，晚到点「签到」即可归队）。'
    : '到了的点「签到」；还没有角色卡的先 @ 我说名字和职业建卡，准备好了点「开始」。';
}

/** 给 DM（模型）看的出勤：开场后未签到者已暂时移出队伍，不参与探索、先攻与战斗 */
export function rosterPrompt(r: Roster, started = false): string {
  const parts = [`本次签到：已到 ${r.arrived.map((ch) => ch.name).join('、') || '无'}`];
  if (r.missing.length > 0) {
    const names = r.missing.map((ch) => ch.name).join('、');
    parts.push(
      started
        ? `未签到 ${names}（已暂时移出队伍，不参与探索、先攻、战斗与休息；别替他们行动或拉入先攻；本人点「签到」会自动归队，或本人明确要求加入时用 dnd_character update absent=false 归队）`
        : `未签到 ${names}（点「开始」后未签到的角色会自动暂时移出队伍；开场前不要替他们行动）`,
    );
  }
  return parts.join('；');
}

/**
 * 开场时发给 DM 的系统消息。群里不再单独发「人齐了」，由 DM 的开场白一句带过，
 * 少一条消息。begun=false 是新团（按开场叙述），否则先回顾上次进度。
 */
export function kickoffMessage(
  r: Roster,
  begun: boolean,
  reason: 'complete' | 'manual',
  benched: readonly string[] = [],
): string {
  const head = reason === 'complete'
    ? `[系统 · 签到] 人到齐了（${r.arrived.map((ch) => ch.name).join('、')}），开始这次跑团。`
    : `[系统 · 签到] 有人点了「开始」，不等了。已到：${r.arrived.map((ch) => ch.name).join('、') || '无'}`
      + `${r.missing.length > 0 ? `；未到：${r.missing.map((ch) => ch.name).join('、')}` : ''}`
      + `${benched.length > 0 ? `（${benched.join('、')} 已暂时移出队伍，本次不参与探索、先攻与战斗，晚到点「签到」自动归队）` : ''}。`;
  return `${head}开场第一句简短说明谁到了${benched.length > 0 ? '、谁暂离队伍' : (r.missing.length > 0 ? '、谁没来' : '')}，然后`
    + `${begun ? '先核对最新团况、停团交接和玩家已定行动，再用两三句回顾上次的进度，接着描述现在的处境；大区域房间名不代表队伍退回起点，备团计划不代表事情已经发生；若战斗未完，沿原先攻与待结算继续' : '按开场要求叙述'}，最后问大家做什么。不要再列签到名单。`;
}
