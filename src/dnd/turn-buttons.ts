/**
 * 跑团回合按钮：轮到 PC 时，在 DM 这一轮回复发完之后补一条「轮到 X」+ 按钮。
 *
 * 「结束回合」由谁点，看的是 QQ 回调里点击者的 openid，模型改不了：只有这个 PC 的玩家
 * 本人点才推进先攻；推进后给会话补一条系统消息，让 DM 接着结算怪物回合。
 * 「查看状态」由工具层直接回一份玩家视角的团况，不经过模型、也不会泄露怪物数值。
 * 攻击/施法/其他是指令按钮：只把半句话填进点击者自己的输入框，行动仍由本人发出。
 * /dnd start 的回复本身带签到按钮：「签到」按点击者 openid 记，群里发一行小提醒，人齐自动开场，见 check-in.ts。
 */
import type { InlineKeyboard, InteractionEvent } from '@tencent-connect/qqbot-nodejs';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import type { SessionManager, SessionRecord } from '../session/index.ts';
import type { Logger, ReplyTarget } from '../types.ts';
import { BUTTONS_PER_ROW, buttonLabel, decodeButtonData, encodeButtonData } from '../features/button-utils.ts';
import { battleRoom, mapCaption, renderPartyMap } from './map-view.ts';
import { cellOf, hiddenFromPlayers, mapOf } from './battlefield.ts';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import type { Adventure } from './adventure.ts';
import { type Campaign, type Character, type ReactionWindow, describePending, findCharacter, isAbsent, isControlledBy, isDmDelegated, isOut, nextTurn, playerStatus, reactionWindow, roomOf, setCharacterAbsent } from './campaign.ts';
import { chooseReaction, reactionsOf, reactionReplyNote, waitingOn } from './pending-attack.ts';
import { type CheckIn, arrivalNotice, checkInHint, createCheckIn, isComplete, kickoffMessage, lateReturnNotice, markArrived, rehydrateCheckIn, rosterOf, rosterText } from './check-in.ts';
import type { DndService } from './dnd-service.ts';
import { combatTurnPrompt } from './dnd-tools.ts';
import { spellListText } from './spell-links.ts';

/** acknowledgeInteraction 的返回码：QQ 客户端据此弹提示 */
export const ACK = { ok: 0, failed: 1, duplicate: 3, denied: 4 } as const;

/** 等 DM 的回复真正发出去再补按钮，避免按钮消息跑到叙事前面 */
const FLUSH_DELAY_MS = 1500;
/** 「名单」按钮的冷却：这段时间内重复点不再发，免得几个人一起点刷屏 */
const ROSTER_COOLDOWN_MS = 30_000;
/** QQ 内联键盘最多几行：超了整条消息会发不出去 */
const MAX_KEYBOARD_ROWS = 5;
/** 签到提醒攒几秒再发：开团时几个人前后脚点签到，合成一条 */
const ARRIVAL_BATCH_MS = 4000;

export interface TurnButtonSender {
  sendMarkdown(target: ReplyTarget, content: string, opts?: { keyboard?: InlineKeyboard }): Promise<unknown>;
}

type ButtonDef = InlineKeyboard['content']['rows'][number]['buttons'][number];

function callbackButton(id: string, label: string, style: number, data: string): ButtonDef {
  return {
    id,
    render_data: { label, visited_label: label, style },
    action: { type: 1, permission: { type: 2 }, data, unsupport_tips: '请升级 QQ 后再点' } as ButtonDef['action'],
  };
}

/** 指令按钮：点了把 data 填进点击者的输入框（自动带 @bot），不直接发送 */
function commandButton(id: string, label: string, data: string): ButtonDef {
  return {
    id,
    render_data: { label, visited_label: label, style: 0 },
    action: { type: 2, permission: { type: 2 }, data, enter: false, unsupport_tips: '请升级 QQ 后再点' } as ButtonDef['action'],
  };
}

export function buildTurnKeyboard(name: string, round: number): InlineKeyboard {
  return {
    content: {
      rows: [
        {
          buttons: [
            callbackButton('dnd-end', '结束回合', 1, encodeButtonData({ t: 'dnd', a: 'end', n: name, r: round })),
            callbackButton('dnd-status', '查看状态', 0, encodeButtonData({ t: 'dnd', a: 'status' })),
          ],
        },
        {
          buttons: [
            // 原来攻击 / 施法 / 其他行动三个，只差预填的一个动词；一行四个按钮在手机上全被截成「其他…」「我的…」
            commandButton('dnd-act', '行动', `${name} `),
            // 原来是预填 /dnd search 的「查询」：玩家得自己记得法术名再打字，战斗里没人用；统一列法术与职业/物品能力
            callbackButton('dnd-spells', '法术/能力', 0, encodeButtonData({ t: 'dnd', a: 'spells', n: name })),
          ],
        },
      ],
    },
  };
}

/** 按钮上只放名字前半截：「刻德温 Kodwin」→「刻德温」，label 才不会被截成省略号 */
function shortName(name: string): string {
  const first = name.trim().split(/\s+/)[0] ?? name;
  return first.length > 0 ? first : name;
}

/**
 * 反应窗口：每个可用的反应一个按钮，再加一个「不用」。权限不靠 QQ 的 specify_user_ids，
 * 和「结束回合」一样在回调里比对点击者 openid：别人的按钮点了会被拒，提示也更明确。
 */
export function reactionOptionKey(option: { character: string; reaction: string }): string {
  return createHash('sha256').update(JSON.stringify([option.character, option.reaction])).digest('base64url').slice(0, 16);
}

export function buildReactionKeyboard(p: ReactionWindow): InlineKeyboard {
  const options = p.reactors.flatMap((r, i) => r.npc === true || r.dmManaged === true ? [] : [callbackButton(`dnd-react-${i}`, buttonLabel(`${shortName(r.character)}·${r.reaction}`), 1, encodeButtonData({ t: 'dnd', a: 'react', r: p.seq, i, o: reactionOptionKey(r) }))]);
  // 挤在一行里名字会被截断 → 默认竖着排；QQ 键盘最多 5 行，选项太多才退回两列，宁可挤也别整条发不出去
  const perRow = options.length + 1 > MAX_KEYBOARD_ROWS ? BUTTONS_PER_ROW : 1;
  const rows: InlineKeyboard['content']['rows'] = [];
  for (let i = 0; i < options.length; i += perRow) rows.push({ buttons: options.slice(i, i + perRow) });
  const passLabel = p.kind === 'move' && p.swapWith !== undefined ? '不同意' : '不用';
  rows.push({ buttons: [callbackButton('dnd-pass', passLabel, 0, encodeButtonData({ t: 'dnd', a: 'pass', r: p.seq }))] });
  return { content: { rows } };
}

export function buildCheckInKeyboard(): InlineKeyboard {
  return {
    content: {
      rows: [{
        buttons: [
          callbackButton('dnd-in', '签到', 1, encodeButtonData({ t: 'dnd', a: 'in' })),
          callbackButton('dnd-go', '开始', 0, encodeButtonData({ t: 'dnd', a: 'go' })),
          callbackButton('dnd-roster', '名单', 0, encodeButtonData({ t: 'dnd', a: 'roster' })),
        ],
      }],
    },
  };
}

/** 当前回合的 PC（活着、有意识；DM 托管中时不发玩家「结束回合」按钮）；不是 PC 回合时返回 undefined */
function currentPc(c: Campaign): { name: string; player?: string; round: number; turn: number } | undefined {
  const state = c.initiative;
  const entry = state?.order[state.turn];
  if (state === undefined || entry === undefined) return undefined;
  const ch = findCharacter(c, entry.name);
  if (ch === undefined || ch.kind !== 'pc' || isDmDelegated(ch) || ch.hp === 0 || ch.conditions.includes('死亡')) return undefined;
  const player = ch.delegated?.mode === 'player'
    ? `${ch.delegated.player ?? '托管玩家'}(代${ch.player ?? ch.name})`
    : ch.player;
  return { name: ch.name, ...(player !== undefined ? { player } : {}), round: state.round, turn: state.turn };
}

export class DndTurnButtons {
  private readonly scheduled = new Set<string>();
  /** 每个会话最后一次发按钮的回合，同一回合不重复发 */
  private readonly lastSent = new Map<string, string>();
  /** 还没发出去的签到提醒（会话 key → 这一批刚签到的 openid） */
  private readonly pendingArrivals = new Map<string, { openids: string[]; timer: ReturnType<typeof setTimeout>; target: ReplyTarget }>();
  private disabled = false;
  /** 每个会话最后一次自动发战斗图的那一轮：一轮只发一张，每回合都发会刷屏 */
  private readonly lastImage = new Map<string, string>();
  private readonly sendingImage = new Map<string, Promise<boolean>>();

  public constructor(
    private readonly service: DndService,
    private readonly manager: SessionManager,
    private readonly sender: TurnButtonSender,
    private readonly logger: Logger,
  ) {}

  /** 先攻指针变了：等这一轮回复结束后，如果轮到 PC 就发按钮 */
  public schedule(record: SessionRecord): void {
    if (this.disabled || record.scope !== 'group' || this.scheduled.has(record.sessionKey)) return;
    this.scheduled.add(record.sessionKey);
    void record.agent.whenIdle()
      .catch(() => {})
      .then(() => new Promise((resolve) => setTimeout(resolve, FLUSH_DELAY_MS)))
      .then(() => this.flush(record))
      .catch((err: unknown) => this.logger.warn(`im-qqbot: 跑团按钮发送失败: ${err instanceof Error ? err.message : String(err)}`))
      .finally(() => this.scheduled.delete(record.sessionKey));
  }

  private async flush(record: SessionRecord): Promise<void> {
    const found = this.service.active(record.sessionKey);
    if (found === undefined) return;
    // 待结算期间回合按钮点了也推进不了，落账后会再排一次
    if (reactionWindow(found.campaign) !== undefined) return;
    const pc = currentPc(found.campaign);
    if (pc === undefined) return;
    const mark = `${pc.round}:${pc.turn}:${pc.name}`;
    if (this.lastSent.get(record.sessionKey) === mark) return;
    this.lastSent.set(record.sessionKey, mark);
    const text = `▶ 第 ${pc.round} 轮 · 轮到 **${pc.name}**${pc.player !== undefined ? `〈${pc.player}〉` : ''}\n`
      + '宣告动作请 @我；动作、附赠动作、移动都用完了点「结束回合」（只有你本人点才算）。';
    await this.sendRoundImage(record, found.campaign, found.adventure);
    try {
      await this.sender.sendMarkdown(record.replyTarget, text, { keyboard: buildTurnKeyboard(pc.name, pc.round) });
    } catch (err) {
      // 多半是机器人没开通消息按钮权限：关掉按钮，DM 照常用文字推进
      this.disabled = true;
      this.logger.warn(`im-qqbot: 跑团按钮发送失败，本次运行不再发按钮: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** 画当前的战斗图；没开战、没摆位、没场地图或发不了图时返回 undefined */
  private async battleImage(key: string, campaign: Campaign, adventure: Adventure): Promise<string | undefined> {
    if (this.service.sendImage === undefined || campaign.initiative === undefined || mapOf(campaign, battleRoom(campaign)) === undefined) return undefined;
    const out = join(this.service.mapDir, `${key.replace(/[^a-zA-Z0-9_-]+/g, '_')}-turn-${randomUUID()}.png`);
    const map = await renderPartyMap(campaign, adventure, out, 'battle', { globalEffects: this.service.globalEffects() });
    return map?.path;
  }

  /** 场地图与当前房间的可见参战者齐备后，在模型播报前发送开战图。 */
  public async sendOpeningImage(record: SessionRecord): Promise<boolean> {
    const found = this.service.active(record.sessionKey);
    if (found?.campaign.initiative?.round !== 1) return false;
    return this.sendRoundImage(record, found.campaign, found.adventure);
  }

  /** 开战图与每轮第一张图共享发送状态，渲染或发送失败后仍允许重试。 */
  private async sendRoundImage(record: SessionRecord, campaign: Campaign, adventure: Adventure): Promise<boolean> {
    const state = campaign.initiative;
    if (state === undefined) return false;
    const room = battleRoom(campaign);
    const visible = state.order.map((entry) => findCharacter(campaign, entry.name)).filter((ch): ch is Character =>
      ch !== undefined && roomOf(campaign, ch) === room && !isOut(ch) && !hiddenFromPlayers(ch));
    if (!visible.some((ch) => cellOf(campaign, ch)) || (state.round === 1 && visible.some((ch) => !cellOf(campaign, ch)))) return false;
    const battle = state.battleId ?? JSON.stringify([campaign.createdAt, state.allParticipants ?? state.order.map((entry) => entry.name)]);
    const mark = JSON.stringify([battle, state.round]);
    if (this.lastImage.get(record.sessionKey) === mark) return true;
    const requestKey = JSON.stringify([record.sessionKey, mark]);
    const pending = this.sendingImage.get(requestKey);
    if (pending !== undefined) return pending;
    const task = (async () => {
      try {
        const path = await this.battleImage(record.sessionKey, campaign, adventure);
        if (path === undefined) return false;
        await this.service.sendImage!(record.replyTarget, path, mapCaption(campaign, adventure, 'battle', this.service.globalEffects()));
        this.lastImage.set(record.sessionKey, mark);
        return true;
      } catch (err) {
        this.logger.warn(`im-qqbot: 每轮战斗图发送失败: ${err instanceof Error ? err.message : String(err)}`);
        return false;
      }
    })().finally(() => this.sendingImage.delete(requestKey));
    this.sendingImage.set(requestKey, task);
    return task;
  }

  /**
   * 有一笔待结算：回复发完后发反应按钮。不限时：玩家点按钮或打字答复，都答复了叫醒 DM；
   * 有人一直不回时由 DM 用 dnd_apply decline 替他跳过。
   */
  public scheduleReaction(record: SessionRecord): void {
    void record.agent.whenIdle()
      .catch(() => {})
      .then(() => new Promise((resolve) => setTimeout(resolve, FLUSH_DELAY_MS)))
      .then(() => this.openReactionWindow(record))
      .catch((err: unknown) => this.logger.warn(`im-qqbot: 反应窗口失败: ${err instanceof Error ? err.message : String(err)}`));
  }

  private async openReactionWindow(record: SessionRecord): Promise<void> {
    const campaign = this.service.active(record.sessionKey)?.campaign;
    const p = reactionWindow(campaign);
    if (p === undefined) return;
    if (!this.disabled && record.scope === 'group' && p.reactors.some((r) => r.npc !== true && r.dmManaged !== true)) {
      const hasDelegated = campaign !== undefined && p.reactors.some((r) => {
        if (r.npc === true || r.dmManaged === true) return false;
        const ch = findCharacter(campaign, r.character);
        return ch?.delegated?.mode === 'player';
      });
      const whoRule = hasDelegated ? '只有本人或受托托管玩家点才算' : '只有本人点才算';
      const text = p.kind === 'move' && p.swapWith !== undefined
        ? `🔄 **${p.target}** 请求与 **${p.swapWith}** 交换站位（不消耗反应）。请 **${p.swapWith}** ${hasDelegated ? '本人/托管玩家' : '本人'}点下面按钮，也可以直接打字说「同意 / 不同意」。`
        : `⚡ ${describePending(p)}还没结算。要用反应的点下面，${whoRule}，也可以直接打字说。`
          + '不限时，等本人答复；人不在的话 DM 会替他跳过或接管托管。';
      try {
        await this.sender.sendMarkdown(record.replyTarget, text, { keyboard: buildReactionKeyboard(p) });
      } catch (err) {
        this.disabled = true;
        this.logger.warn(`im-qqbot: 反应按钮发送失败，本次运行不再发按钮: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  private notifyDm(record: SessionRecord, text: string): void {
    const message = createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' as const } });
    if (this.manager.combatAgents !== undefined) {
      void this.manager.sendDndFollowup(record, message)
        .then(() => this.schedule(this.manager.getSessionRecord(record.scope, record.peerId) ?? record))
        .catch((err: unknown) => this.logger.warn(`im-qqbot: 跑团按钮消息失败: ${String(err)}`));
    } else record.agent.followup(message);
  }

  /** 反应按钮：点击者必须是那个角色的玩家。「不用」只算他自己，全员答复才叫醒 DM，免得每人点一下都触发一轮回复 */
  private reactionClick(event: InteractionEvent, key: string, record: SessionRecord | undefined, button: { a: string; r?: number; i?: number; o?: string }): number {
    const p = reactionWindow(this.service.active(key)?.campaign);
    if (p === undefined || p.seq !== button.r) return ACK.duplicate;
    const sourceId = `button:${event.id}`;
    if (p.reactionReplyIds?.includes(sourceId)) return ACK.duplicate;
    const clicker = event.group_member_openid ?? event.user_openid;
    const ownsReactor = (name: string): boolean => {
      const ch = this.service.active(key)?.campaign.characters.find((x) => x.name === name);
      return ch !== undefined && isControlledBy(ch, clicker);
    };
    const used = new Set(p.used.map((u) => u.by));
    const rememberDuplicate = (): number => {
      // 即使当前选项没变，也要记住这次真实回调；否则它在改选后重投会复活旧选择。纯去重不占 undo 快照。
      this.service.store.update(key, (c) => {
        const pending = reactionWindow(c);
        if (pending !== undefined && pending.seq === button.r) (pending.reactionReplyIds ??= []).push(sourceId);
      }, '重复反应按钮', { recordHistory: false });
      return ACK.duplicate;
    };

    if (button.a === 'pass') {
      const mine = [...new Set(p.reactors.map((r) => r.character))].filter(ownsReactor);
      if (mine.length === 0) return ACK.denied;
      const fresh = mine.filter((name) => !used.has(name) && !p.declined.includes(name));
      if (fresh.length === 0) return rememberDuplicate();
      const left = this.service.store.update(key, (c) => {
        const pending = reactionWindow(c);
        if (pending === undefined || pending.seq !== button.r) return undefined;
        (pending.reactionReplyIds ??= []).push(sourceId);
        for (const name of fresh) chooseReaction(c, pending, clicker!, name);
        return waitingOn(pending);
      }, `按钮 不用反应 ${fresh.join('、')}`);
      if (record !== undefined && left !== undefined && left.length === 0) {
        const msg = p.kind === 'move' && p.swapWith !== undefined
          ? `[系统 · 按钮] ${fresh.join('、')} 点了「不同意」交换站位。用 dnd_apply target=${p.target} settle=true 结束本次换位请求（停在原位）。`
          : `[系统 · 按钮] 反应都答复了，${fresh.join('、')} 不用。用 dnd_apply target=${p.target} settle=true 落账，再接着结算。`;
        this.notifyDm(record, msg);
      }
      return ACK.ok;
    }

    const option = button.i === undefined ? undefined : p.reactors[button.i];
    if (option === undefined) return ACK.failed;
    if (button.o !== reactionOptionKey(option)) return ACK.duplicate;
    if (!ownsReactor(option.character)) return ACK.denied;
    if (used.has(option.character) || p.claimed.some((r) => r.character === option.character && r.reaction === option.reaction && r.authorization !== undefined)) return rememberDuplicate();
    const grant = this.service.store.update(key, (c) => {
      const pending = reactionWindow(c);
      if (pending === undefined || pending.seq !== button.r) return undefined;
      (pending.reactionReplyIds ??= []).push(sourceId);
      return chooseReaction(c, pending, clicker!, option.character, option.reaction);
    }, `按钮 反应 ${option.character}·${option.reaction}`);
    if (grant === undefined) return ACK.duplicate;
    this.logger.info(`im-qqbot: 跑团反应按钮 key=${key} ${option.character}·${option.reaction} by=${clicker ?? '?'}`);
    if (record !== undefined) {
      const ch = this.service.active(key)?.campaign.characters.find((x) => x.name === option.character);
      const actorDesc = ch !== undefined && ch.playerId !== undefined && ch.playerId !== clicker ? '受托托管玩家代点' : '玩家本人点了';
      this.notifyDm(record, `[系统 · 按钮] ${option.character} 的${actorDesc}用「${option.reaction}」。`
        + reactionReplyNote(this.service.active(key)!.campaign, { kind: 'use', characters: [option.character], grants: [grant] }));
    }
    return ACK.ok;
  }

  /**
   * 团况走 markdown：站位图要放进代码块才等宽。发不出去返回 false，调用方退回纯文字（坐标列表）。
   * 失败不关按钮：这里没带键盘，失败多半是 markdown 本身的问题，和按钮权限无关。
   */
  public async sendStatus(key: string, target: ReplyTarget, viewer: string | undefined): Promise<boolean> {
    const found = this.service.active(key);
    if (found === undefined) return false;
    // 战斗中能出图就发战斗图，血量、先攻、距离这些文字附在图下面；出不了图才用字符网格
    // 没开战或发不了图时不等这一步：按钮回调要求立刻回话
    if (this.service.sendImage !== undefined && found.campaign.initiative !== undefined) try {
      const path = await this.battleImage(key, found.campaign, found.adventure);
      if (path !== undefined) {
        const text = [
          playerStatus(found.campaign, found.adventure, viewer, 'image'),
          mapCaption(found.campaign, found.adventure, 'battle', this.service.globalEffects()),
        ].filter((s) => s.length > 0).join('\n');
        await this.service.sendImage!(target, path, text);
        return true;
      }
    } catch (err) {
      this.logger.warn(`im-qqbot: 跑团状态图发送失败，退回 markdown: ${err instanceof Error ? err.message : String(err)}`);
    }
    try {
      const body = playerStatus(found.campaign, found.adventure, viewer, 'markdown');
      await this.sender.sendMarkdown(target, found.campaign.initiative !== undefined ? body : `🎲 ${found.adventure.name}\n${body}`);
      return true;
    } catch (err) {
      this.logger.warn(`im-qqbot: 跑团状态 markdown 发送失败，退回纯文字: ${err instanceof Error ? err.message : String(err)}`);
      return false;
    }
  }

  /**
   * 开团消息即签到表：intro（开团文字）+ 名单 + 签到/开始/名单按钮，合成一条发出。
   * reset=false 时沿用已有的签到表（/dnd checkin 只是把按钮再发一次）。
   * 按钮关着或发送失败返回 false，调用方退回纯文字回复。
   */
  public async openCheckIn(key: string, target: ReplyTarget, intro: string, reset: boolean): Promise<boolean> {
    if (this.disabled || target.scope !== 'group') return false;
    const found = this.service.active(key);
    if (found === undefined) return false;
    const existed = this.service.checkIns.get(key);
    const checkIn = reset ? createCheckIn() : (existed ?? rehydrateCheckIn(found.campaign));
    this.service.checkIns.set(key, checkIn);
    const roster = rosterOf(checkIn, found.campaign);
    const text = [intro, rosterText(roster, checkIn.started), checkIn.started ? '已经开场了，暂离/晚到的点「签到」即可自动归队。' : checkInHint(roster)]
      .filter((s) => s.length > 0).join('\n\n');
    try {
      await this.sender.sendMarkdown(target, text, { keyboard: buildCheckInKeyboard() });
      return true;
    } catch (err) {
      // 多半是机器人没开通消息按钮权限：关掉按钮，开团回复退回纯文字
      if (existed === undefined) this.service.checkIns.delete(key); else this.service.checkIns.set(key, existed);
      this.disabled = true;
      this.logger.warn(`im-qqbot: 跑团签到发送失败，本次运行不再发按钮: ${err instanceof Error ? err.message : String(err)}`);
      return false;
    }
  }

  /** bot 重启后点旧消息上的按钮：按团档恢复签到态，或重新开一张接着用 */
  private checkInOf(key: string, campaign: Campaign): CheckIn {
    let checkIn = this.service.checkIns.get(key);
    if (checkIn === undefined) {
      checkIn = rehydrateCheckIn(campaign);
      this.service.checkIns.set(key, checkIn);
    }
    return checkIn;
  }

  /**
   * 开场：把出勤交给 DM，让它直接开讲。群里不另发「人齐了」，开场白本身就是信号。
   * 点「开始」时还没签到的绑定 PC 自动暂时移出队伍；群里没创建过会话时按 groupId 兜底建会话。
   */
  private kickoff(
    checkIn: CheckIn,
    key: string,
    groupId: string,
    record: SessionRecord | undefined,
    campaign: Campaign,
    reason: 'complete' | 'manual',
    clicker?: string,
  ): boolean {
    if (checkIn.started) return false;
    const canGetOrCreate = typeof (this.manager as { getOrCreate?: unknown }).getOrCreate === 'function';
    if (record === undefined && !canGetOrCreate) return false;

    const benchedNames: string[] = [];
    if (reason === 'manual') {
      const beforeRoster = rosterOf(checkIn, campaign);
      if (beforeRoster.arrived.length > 0 && beforeRoster.missing.length > 0) {
        this.service.store.update(key, (c) => {
          for (const ch of beforeRoster.missing) {
            if (setCharacterAbsent(c, ch.name, true).changed) benchedNames.push(ch.name);
          }
        }, '签到开场：未签到暂离', { recordHistory: false });
      }
    }

    checkIn.started = true;
    // 开场叙述会说谁到了，攒着的签到提醒不用再发
    this.cancelArrivals(key);
    const latest = this.service.active(key)?.campaign ?? campaign;
    const text = kickoffMessage(rosterOf(checkIn, latest), latest.begun === true, reason, benchedNames);
    if (record !== undefined) {
      this.notifyDm(record, text);
    } else {
      const fallbackTarget: ReplyTarget = { scope: 'group', targetId: groupId };
      void this.manager.getOrCreate('group', groupId, clicker ?? 'system', fallbackTarget)
        .then((created) => this.notifyDm(created, text))
        .catch((err: unknown) => this.logger.warn(`im-qqbot: 跑团开场创建会话失败: ${err instanceof Error ? err.message : String(err)}`));
    }
    return true;
  }

  /** 签到：开场前攒一行小提醒、人齐自动开场；开场后晚到或暂离者点击自动归队 */
  private checkIn(
    event: InteractionEvent,
    key: string,
    groupId: string,
    record: SessionRecord | undefined,
    campaign: Campaign,
    target: ReplyTarget,
  ): number {
    const clicker = event.group_member_openid ?? event.user_openid;
    if (clicker === undefined) return ACK.failed;
    const checkIn = this.checkInOf(key, campaign);
    if (checkIn.started) {
      const benchedOwned = campaign.characters.filter(
        (ch) => ch.kind === 'pc' && ch.playerId === clicker && isAbsent(ch),
      );
      if (checkIn.arrived.has(clicker) && benchedOwned.length === 0) return ACK.duplicate;
      checkIn.arrived.set(clicker, Date.now());
      this.logger.info(`im-qqbot: 跑团晚到签到 key=${key} by=${clicker}`);
      if (benchedOwned.length > 0) {
        this.service.store.update(key, (c) => {
          for (const ch of benchedOwned) setCharacterAbsent(c, ch.name, false);
        }, `签到归队 ${benchedOwned.map((x) => x.name).join('、')}`, { recordHistory: false });
        const latest = this.service.active(key)?.campaign ?? campaign;
        void this.sender.sendMarkdown(target, lateReturnNotice(benchedOwned, latest.initiative !== undefined))
          .catch((err: unknown) => this.logger.warn(`im-qqbot: 跑团归队提示发送失败: ${err instanceof Error ? err.message : String(err)}`));
      } else {
        void this.sender.sendMarkdown(target, '✅ 1 位还没角色卡的玩家到了（@我说名字和职业建卡）')
          .catch((err: unknown) => this.logger.warn(`im-qqbot: 跑团签到提醒发送失败: ${err instanceof Error ? err.message : String(err)}`));
      }
      return ACK.ok;
    }
    if (!markArrived(checkIn, clicker)) return ACK.duplicate;
    this.logger.info(`im-qqbot: 跑团签到 key=${key} by=${clicker}`);
    if (isComplete(rosterOf(checkIn, campaign)) && this.kickoff(checkIn, key, groupId, record, campaign, 'complete', clicker)) {
      this.logger.info(`im-qqbot: 跑团人齐自动开场 key=${key}`);
    } else {
      this.queueArrival(key, target, clicker);
    }
    return ACK.ok;
  }

  private queueArrival(key: string, target: ReplyTarget, openid: string): void {
    const pending = this.pendingArrivals.get(key);
    if (pending !== undefined) {
      pending.openids.push(openid);
      pending.target = target;
      return;
    }
    const timer = setTimeout(() => this.flushArrivals(key), ARRIVAL_BATCH_MS);
    this.pendingArrivals.set(key, { openids: [openid], timer, target });
  }

  private cancelArrivals(key: string): void {
    const pending = this.pendingArrivals.get(key);
    if (pending === undefined) return;
    clearTimeout(pending.timer);
    this.pendingArrivals.delete(key);
  }

  private flushArrivals(key: string): void {
    const pending = this.pendingArrivals.get(key);
    this.pendingArrivals.delete(key);
    const found = this.service.active(key);
    const checkIn = this.service.checkIns.get(key);
    // 这几秒里结团了、或者已经开场（开场白会说谁到了）就不发
    if (pending === undefined || found === undefined || checkIn === undefined || checkIn.started) return;
    void this.sender.sendMarkdown(pending.target, arrivalNotice(pending.openids, rosterOf(checkIn, found.campaign)))
      .catch((err: unknown) => this.logger.warn(`im-qqbot: 跑团签到提醒发送失败: ${err instanceof Error ? err.message : String(err)}`));
  }

  /** 「开始」：不等没到的人。点的人顺带算签到 */
  private start(
    event: InteractionEvent,
    key: string,
    groupId: string,
    record: SessionRecord | undefined,
    campaign: Campaign,
  ): number {
    const checkIn = this.checkInOf(key, campaign);
    const clicker = event.group_member_openid ?? event.user_openid;
    if (clicker !== undefined) markArrived(checkIn, clicker);
    if (checkIn.started) return ACK.duplicate;
    if (!this.kickoff(checkIn, key, groupId, record, campaign, 'manual', clicker)) return ACK.failed;
    this.logger.info(`im-qqbot: 跑团手动开场 key=${key} by=${clicker ?? '?'}`);
    return ACK.ok;
  }

  /** 「名单」：唯一会在群里发名单的地方，带冷却 */
  private roster(key: string, target: ReplyTarget, campaign: Campaign, now = Date.now()): number {
    const checkIn = this.checkInOf(key, campaign);
    if (checkIn.rosterPostedAt !== undefined && now - checkIn.rosterPostedAt < ROSTER_COOLDOWN_MS) return ACK.duplicate;
    checkIn.rosterPostedAt = now;
    void this.sender.sendMarkdown(target, rosterText(rosterOf(checkIn, campaign), checkIn.started))
      .catch((err: unknown) => this.logger.warn(`im-qqbot: 跑团名单发送失败: ${err instanceof Error ? err.message : String(err)}`));
    return ACK.ok;
  }

  /** 处理按钮点击；不是跑团按钮时返回 undefined，交给其他通道 */
  public handleInteraction(event: InteractionEvent): number | undefined {
    const raw = event.data?.resolved?.button_data;
    const button = raw === undefined ? undefined : decodeButtonData(raw);
    if (button?.t !== 'dnd') return undefined;
    const groupId = event.group_openid;
    if (groupId === undefined) return ACK.failed;
    const key = this.manager.sessionKey('group', groupId);
    const record = this.manager.getSessionRecord('group', groupId);
    const target: ReplyTarget = record?.replyTarget ?? { scope: 'group', targetId: groupId };
    const found = this.service.active(key);
    if (found === undefined) return ACK.duplicate;

    if (button.a === 'in') return this.checkIn(event, key, groupId, record, found.campaign, target);
    if (button.a === 'go') return this.start(event, key, groupId, record, found.campaign);
    if (button.a === 'roster') return this.roster(key, target, found.campaign);
    if (button.a === 'react' || button.a === 'pass') return this.reactionClick(event, key, record, button);

    if (button.a === 'status') {
      void this.sendStatus(key, target, event.group_member_openid ?? event.user_openid);
      return ACK.ok;
    }
    if (button.a === 'spells') {
      // 优先看点击者有控制权的对应按钮角色（支持托管），否则找自己的卡或按钮角色
      const clicker = event.group_member_openid ?? event.user_openid;
      const btnCh = findCharacter(found.campaign, String(button.n ?? ''));
      const ch = (btnCh !== undefined && isControlledBy(btnCh, clicker) ? btnCh : undefined)
        ?? found.campaign.characters.find((x) => isControlledBy(x, clicker))
        ?? btnCh;
      if (ch === undefined) return ACK.failed;
      void this.sender.sendMarkdown(
        target,
        spellListText(ch.name, ch.spells ?? [], ch.resources, { includeFallback: true, reactions: reactionsOf(ch) }),
      )
        .catch((err: unknown) => this.logger.warn(`im-qqbot: 法术清单发送失败: ${err instanceof Error ? err.message : String(err)}`));
      return ACK.ok;
    }

    // 结束回合：必须还是按钮上的那个回合，且由该 PC 的绑定玩家或受托托管玩家点
    const pc = currentPc(found.campaign);
    if (pc === undefined || pc.name !== button.n || pc.round !== button.r) return ACK.duplicate;
    const ch = findCharacter(found.campaign, pc.name);
    const clicker = event.group_member_openid ?? event.user_openid;
    if (ch?.playerId !== undefined && !isControlledBy(ch, clicker)) return ACK.denied;
    // 还有一笔没落账：现在推进就把窗口吃掉了
    if (reactionWindow(found.campaign) !== undefined) return ACK.failed;

    const next = this.service.store.update(key, (c) => {
      const { round, current, newRound, skipped, expired, hazardNotes } = nextTurn(c, this.service.roller, this.service.globalEffects());
      return { round, newRound, skipped, expired, hazardNotes, prompt: combatTurnPrompt(c, current.name, { globalEffects: this.service.globalEffects() }) };
    }, `按钮 结束回合 ${pc.name}`);
    this.service.recordAgentToolSync?.(key);
    this.logger.info(`im-qqbot: 跑团按钮结束回合 key=${key} ${pc.name} by=${clicker ?? '?'}`);

    if (record !== undefined) {
      const expiredText = next.expired.length > 0 ? `【状态/区域到期】${next.expired.join('；')}\n` : '';
      const hazardText = next.hazardNotes.length > 0 ? `【回合切换自动结算（回复里照实播报掷骰过程）】\n${next.hazardNotes.map((h) => `- ${h}`).join('\n')}\n` : '';
      const text = `[系统 · 按钮] ${pc.name}${pc.player !== undefined ? `〈${pc.player}〉` : ''} 点了「结束回合」，`
        + `先攻已由工具推进（不要再为 ${pc.name} 调用 dnd_initiative next）。`
        + `${next.skipped.length > 0 ? `受惊跳过：${next.skipped.join('、')}。` : ''}`
        + `${expiredText}${hazardText}${next.newRound ? `进入第 ${next.round} 轮。` : ''}${next.prompt}`;
      this.notifyDm(record, text);
      if (this.manager.combatAgents === undefined) this.schedule(record);
    }
    return ACK.ok;
  }
}
