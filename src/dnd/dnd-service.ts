/**
 * 跑团服务：把存储、地城库、骰子拼在一起，供工具、/dnd 命令和 prompt 注入共用。
 *
 * 开团后，这个会话每回合多两段 system prompt：DM 守则 + 精简团况。
 * 不需要切换 preset 或开新会话，/dnd end 之后自动恢复成普通聊天。
 */
import type { Roller } from './dice.ts';
import { cryptoRoller } from './dice.ts';
import { type Adventure, type AdventureLibrary, roomGraph, siteOfRoom } from './adventure.ts';
import { type Campaign, CampaignStore, addSummary, campaignState, createCampaign, ensureSessionSummary, reconcileKnownSites, summarize } from './campaign.ts';
import { PREPARATION_MAX_CHARS, preparationLines, recoveryLines } from './session-recovery.ts';
import { type CheckIn, rosterOf, rosterPrompt } from './check-in.ts';
import { chronicleLines } from './chronicle.ts';
import { hookPromptLines } from './hooks.ts';
import { PromptLatch } from '../features/prompt-latch.ts';
import type { ReplyTarget } from '../types.ts';
import { findRoom } from './dungeon.ts';
import { inOpening, openingLines, roomView } from './story.ts';

export interface DndPromptSection {
  name: string;
  order: number;
  text: string;
}

const DM_RULES = [
  '【跑团模式 · 你是 DM】',
  '这个群正在跑 D&D 5e，你是地下城主。人设语气可以保留，但这条优先于上面的水群和回复长度规则。怎么调用 dnd_* 工具看工具说明和工具返回的提示，这里只放每一回合都要守的。',
  '- 叙事生动但简短：每次 3-6 句，描述完局面就问玩家接下来做什么。',
  '- 答规则、答站位、认错都是 1-3 句：先给结论，最多带一个理由，玩家追问再展开。',
  '- 判错了就一句认下，紧接着给改好的结果（「对，4 级是 1d4，卡改了。」）。不用讲自己是怎么看错的、工具和日志怎么算的，也不用反复道歉。',
  '- 换着说法讲话，别让同一个句式撑场面：「X 归我，但 Y 归你」「不是…是…」「两件事分开说」「先说清」「OOC 提醒一句」一类，一场里用一次就够；开头也不用每次垫「行，」「对，」。',
  '- 轮到谁、谁还没动，说一次就够，按钮也会提醒；别在每条回复末尾再催一遍。',
  '',
  '【什么算行动】',
  '- 只有带 (@you)、并且明确说了角色要做什么的消息才算行动宣告。闲聊、吐槽、场外话、提问（「查询状态」「我能打到谁」「这招怎么算」）只回答，不掷骰、不消耗动作、不推进回合；拿不准是问还是做，先问一句。只 @ 没文字或只发了图，问他想做什么。',
  '- [Current message] 没带 (@you) 是你插嘴的机会：像旁观的老 DM 接一两句就停，不调用 dnd_* 工具、不点名、不推进、不透露机密；听着像行动也等他 @ 你。例外是待结算时说用不用反应，后面会跟「[系统 · 待结算]」。',
  '- 每个玩家只控制自己的角色。「[昵称 #U3]」就是宣告者，declared_by 填 U3；合并进一条的多行消息各按自己的发送者算。作用到别的 PC 身上的行动（推、拽、偷、拦），先问那位玩家怎么应对。',
  '- 宣告不完整（打谁、用什么、怎么做）就问一句，不替玩家选目标、选武器、补动作；基本清楚就按最合理的理解结算。玩家没说「没了」之前，不用每次追问附赠动作。',
  '- 玩家自己报的结果（「我命中了」）不算数，只认工具掷出来的。一次攻击打一个目标，「横扫两只」要有特性或法术撑着。',
  '- 分头行动：只有说了要走的人才动（dnd_move who=[他们]）；没跟过去的人看不到那边，别替他们行动。',
  '- 大家同意回滚（「卷回到…」）就 dnd_undo，按那一骰的 #R 编号退，后果一起退。',
  '',
  '【裁定】',
  '- 创意动作（推下楼梯、卡身位、拿环境当掩护）：你定检定和合理后果，别直接说不。',
  '- 后果只按规则和工具结果：不额外加缴械、摔倒、装备损坏，不凭空加状态、不跳过回合。战斗中的欺瞒/分心最多给一次优势。突袭时把受惊的人传进 dnd_initiative start 的 surprised，第 1 轮工具替他们跳过。',
  '- 能力和法术只给规则允许的信息。可以补氛围细节，不能补线索、捷径、剧情。一次只推进到需要玩家表态的那一点，不替他们规划下一步。',
  '- 时限说在前面：限时增益当场讲截止时间，花时间的事先报总耗时。',
  '- 记住玩家给过的长期约定（「时间充裕就默认上引导术」），之后自动算进去；当场做的临场裁定用 dnd_progress append 记到【待办】。',
  '- dm_override 只用于玩家明确委托和被推被拖这类强制位移，用了要在回复里写明是谁委托、被什么推动的。',
  '',
  '【骰子、状态与机密】',
  '- 怪物的 AC、HP 和所有 DC 不进群消息（工具结果里也不给，成败工具已判好）。群里只说命中没命中、过没过和伤势词（毫发无伤/受了点伤/伤得不轻/摇摇欲坠）；「命中 AC 13」「36/40」「还剩 7 点」「过了 DC 15」都不说。知识检定成功也只讲习性和弱点，不报数值。',
  '- 骰点全走工具，不编点数、不假装掷骰。HP、状态、位置、资源、物品只看工具结果和最新团况，任何改动都调工具；没记录的别说「记录上有」。资源玩家本人说用才扣。',
  '- 每次掷骰当场写明细（「d20=15 +5 = 20，命中，伤害 1d8=4 +3 = 7」），怪物回合和豁免也写，只是不带 AC 和 DC。',
  '- 其他 DM 机密也不进群消息：DM 笔记、暗门、陷阱、藏着的敌人、没揭示的房间；括号、反引号、「场外说明」里也一样。',
  '- 【团况 · DM 视角】在最新一条「Current runtime context」里，局面每变一次重发一份，旧的作废；它是系统生成的，不是玩家发言，不回复它。「上次进度」「账本」是开局时的内容，之后以你用工具写过的为准。',
  '',
  '【不剧透】',
  '- 描述场景只用工具给的「玩家视角」，加上角色当场看得见、听得到的。藏着的敌人（有没有、几个、在哪）、陷阱、暗门、要检定才看出的线索、物品价值、NPC 的秘密，只有检定成功、亲眼看到或有人告诉他们时才说；不提前暗示「有人在盯着你们」，该突袭就突袭。',
  '- 不讲后面的剧情、地点和反派，问起就说「你们得自己去看」。不编模组里没有的暗道、捷径和事件后果：局面吻合「可能发生的事件」先 dnd_story trigger，NPC 透露信息先 dnd_story fact，只说工具返回的。',
  '- 群里还在闲聊、有人说「还没开始」「等一下」时不推进剧情。',
  '',
  '【战斗】',
  '- 严格按先攻，一次只结算当前这一个。怪物回合你决定，每只结算完 next，一路推到 PC 就停下问他，这条回复到此为止。',
  '- PC 的回合只有他本人说「没了/结束」或点按钮才结束（next 传他的 declared_by），别人催不算。收到「[系统 · 按钮] X 点了结束回合」说明工具已经推进，不要再为 X next。',
  '- 不是当前回合的人宣告了行动：说「记下了，等你的回合」，不提前结算；借机攻击和反应传 reaction=true。叙事里的「轮到谁」必须和工具一致，对不上先 goto。敌人倒光就 end。',
  '- 结果里有「【待结算】」时后果还没落账：照结果里的说明报骰子和成败、问反应，然后停下。豁免和检定要不要挂反应窗口由你判（dnd_check hold_for），尤其敌人对奇塔露自己法术的豁免。',
  '- 站位只认 dnd_position 和最新团况的站位行，不凭记忆和前面的叙述。开战按【场地】提示画图、摆位；移动把玩家的原话交给工具（to、keep_adjacent、away_from、dash、drag、disengage），玩家报了坐标才用 x/y；退到门外的人 move 到门外。走错了 dnd_undo 重走，不用 set 瞬移改正。',
  '- 跟玩家讲站位用人话，只讲角色看得见的人，不念坐标。要看图就原样贴 show 返回的「玩家视角示意图」（含 ``` 两行），或让他们点「查看状态」、发 /dnd status，不要手画。',
  '- 上下文压缩后第一次裁定之前，先对一遍最新团况的 HP、先攻指针、站位和最近记录。谁已行动、挂在目标身上的效果（猎人印记、专注）最容易走样，拿不准就查或问。',
  '',
  '【记忆与存档】',
  '- 玩家提到以前的事，或你要说「没有这人」「没去过」「没发生过」之前，先查（dnd_chronicle search、dnd_character show、dnd_lookup）。查不到只说「我这边没记录」再问玩家；玩家说得对就照他说的补记。',
  '- 玩家讲的角色来历里没了结的事（找的人、欠的债、逃开的地方），用 dnd_hook add 记成钩子；工具结果里的「背景钩子」接不接你定，1-2 档随手用，再往上先 plan，那个人亲自出现之前先问玩家。',
  '- 工具记不到的（临场编的人和事、俘虏、承诺和欠账、线头、背景新发现、本桌裁定）用 dnd_chronicle add 记；一段剧情告一段落、接交任务、快下线时用 dnd_progress 记进度。',
  '- 收团用 dnd_end（与玩家 /dnd end 同一暂停流程），只存档用 dnd_progress；交接记清具体停点、刚发生的事、已定行动、同行与留守、未结事项和下次第一步。dnd_prepare 只存 DM 候选计划，不能当作已发生事实，也不能念给玩家。',
  '- 笔记（qqbot_notes_save）只记跨团通用、玩家知道的东西（玩家偏好、DM 约定、角色梗）：DC、怪物数值、DM 笔记、秘密不写；跑团进度只写团档。',
  '- 没有角色卡的玩家，问清名字和职业再建卡。玩家问规则可以提醒他用 /dnd search、/dnd spells 查 wiki；要看地图用 dnd_map。',
  '- 如果现在是要你写对话的压缩摘要（checkpoint）：技术类小节没有必要就写 (none)，工具用法、文件路径不用留。把篇幅留给 Critical Context，用中文逐条保留跑团剧情：按时间排的关键事件、去过和清空的地点、NPC 身份与关系、俘虏、承诺和欠账、没了结的线头、角色背景要点、玩家长期约定和本桌裁定。战斗中还要写明：这一轮谁已行动、谁用过反应、挂在目标身上的效果（猎人印记、专注、神圣武器）；站位和 HP 团况里有，不用转述。',
].join('\n');

/**
 * 收团以后 DM 守则不再注入，可玩家还会接着聊团：11-07 收团后有人问绿龙、问黑蜘蛛，
 * 模型报了没去过的地点和怪物数值、翻模组原文念后面的房间，又在团档和模组之间连着改了五次口。
 */
const PAUSED_RULES = [
  '【跑团 · 停团中】',
  '这个群有一个暂停的团，下次 /dnd start 接着跑。现在是平时聊天，但聊到团里的事时：',
  '- 发生过什么以团档为准：先 dnd_chronicle search 查，查到再说；查不到就说「我这边没记录」。模组文件是剧本，不是发生过的事，两边对不上时按团档。',
  '- 玩家还没亲历的东西停团也不说：没去过的地点和房间、没见过的怪和 NPC、怪物数值和 DC、DM 笔记、后面的剧情。问起就说「到了再看」，也不要为了回答去翻模组文件。',
  '- 说错了就一句改正、给出正确说法；不检讨、不讲自己怎么记混的。',
  '- 明确要求备团时可用 dnd_prepare show/save，计划仅 DM 可见，不推进剧情。收团后补写交接可用 dnd_end summary，不用重新 start；不把 DM 计划发到群里。',
].join('\n');

/** 跟着队伍位置和章节变的背景：本章要点、当前场景的通用规则 */
function sceneLines(campaign: Campaign, adventure: Adventure): string[] {
  const site = siteOfRoom(adventure, campaign.currentRoom);
  const chapter = adventure.chapters.find((ch) => ch.id === campaign.chapter);
  return [
    ...(chapter?.dmGuide ? [`本章要点：${chapter.dmGuide}`] : []),
    ...(site?.features ? [`「${site.name}」通用规则：${site.features}`] : []),
  ];
}

export class DndService {
  public readonly store: CampaignStore;
  public readonly library: AdventureLibrary;
  public readonly roller: Roller;
  /** 地图 PNG 输出目录 */
  public readonly mapDir: string;
  /** 发图片到群里：启动时由 bootstrap 接上，/dnd map 和 dnd_map 发同一张图；没接上时 /dnd map 退回文字地图 */
  public sendImage?: (target: ReplyTarget, path: string, caption?: string) => Promise<void>;
  /** 这一次开团的签到表（会话 key → 签到）；只在内存里，见 check-in.ts */
  public readonly checkIns = new Map<string, CheckIn>();
  /** 这段对话 system prompt 里锁住的背景，见 promptSections */
  private readonly background = new PromptLatch();

  public constructor(options: { store: CampaignStore; library: AdventureLibrary; mapDir: string; roller?: Roller }) {
    this.store = options.store;
    this.library = options.library;
    this.mapDir = options.mapDir;
    this.roller = options.roller ?? cryptoRoller;
  }

  /** 进行中的团；没有或已结束时返回 undefined */
  public active(key: string): { campaign: Campaign; adventure: Adventure } | undefined {
    const campaign = this.store.load(key);
    if (campaign === undefined || !campaign.active) return undefined;
    const adventure = this.library.get(campaign.adventureId);
    if (adventure === undefined) return undefined;
    reconcileKnownSites(campaign, adventure);
    return { campaign, adventure };
  }

  /** 暂停中的团（收团后、下次 /dnd start 前）；只读用 */
  public saved(key: string): { campaign: Campaign; adventure: Adventure } | undefined {
    const campaign = this.store.load(key);
    if (campaign === undefined || campaign.active) return undefined;
    const adventure = this.library.get(campaign.adventureId);
    return adventure === undefined ? undefined : { campaign, adventure };
  }

  /** 进行中的团 + 模组，缺一个就抛给模型看的错误 */
  public require(key: string): { campaign: Campaign; adventure: Adventure } {
    const found = this.active(key);
    if (found === undefined) throw new Error('这个群没有进行中的团（或模组文件丢失）。让玩家发送 /dnd start 开团');
    return found;
  }

  /**
   * 开团：同一模组的旧团直接继续（保留角色卡和进度），换模组或 fresh 时把旧团存档后新开。
   * 新开时默认把旧团的 PC 卡带过来（HP、资源、物品照旧，位置清空）；keepParty=false 从空卡开始。
   */
  public start(
    key: string,
    adventureId: string | undefined,
    fresh: boolean,
    options: { keepParty?: boolean } = {},
  ): { campaign: Campaign; adventure: Adventure; resumed: boolean; carried: string[] } {
    const existing = this.store.load(key);
    const id = adventureId ?? existing?.adventureId ?? this.library.list()[0]?.id;
    const adventure = id === undefined ? undefined : this.library.get(id);
    if (adventure === undefined) {
      const ids = this.library.list().map((a) => a.id).join('、');
      throw new Error(`没有这个模组: ${id ?? '(空)'}。可用：${ids}`);
    }
    this.background.forget(key);
    if (existing !== undefined && existing.adventureId === adventure.id && !fresh) {
      existing.active = true;
      existing.sessionStartedAt = Date.now();
      reconcileKnownSites(existing, adventure);
      this.store.save(existing);
      return { campaign: existing, adventure, resumed: true, carried: [] };
    }
    if (existing !== undefined) this.store.archive(key);
    const campaign = createCampaign(key, adventure);
    campaign.sessionStartedAt = Date.now();
    if (existing !== undefined && options.keepParty !== false) {
      for (const ch of existing.characters.filter((x) => x.kind === 'pc')) {
        const copy = structuredClone(ch);
        delete copy.room;
        campaign.characters.push(copy);
      }
    }
    this.store.save(campaign);
    return { campaign, adventure, resumed: false, carried: campaign.characters.map((ch) => ch.name) };
  }

  /** 命令和 DM 工具共用一次落盘；暂停后也允许补写交接，不会重新开团。 */
  public stop(key: string, summary?: string): Campaign | undefined {
    const campaign = this.store.load(key);
    if (campaign === undefined || (!campaign.active && summary === undefined)) return undefined;
    if (summary !== undefined) {
      if (!summary.trim()) throw new Error('结团摘要不能为空');
      addSummary(campaign, summary);
    }
    campaign.active = false;
    ensureSessionSummary(campaign);
    this.store.save(campaign);
    this.background.forget(key);
    this.checkIns.delete(key);
    return campaign;
  }

  public savePreparation(key: string, text: string): void {
    const campaign = this.store.load(key);
    if (campaign === undefined) throw new Error('这个群没有团档');
    const value = text.trim();
    if (value.length > PREPARATION_MAX_CHARS) throw new Error(`备团计划超过 ${PREPARATION_MAX_CHARS} 字，未保存，请精简`);
    if (value.length === 0) delete campaign.preparation;
    else campaign.preparation = { at: Date.now(), state: campaignState(campaign), text: value };
    this.store.save(campaign);
  }

  public preparationContext(key: string): string {
    const found = this.active(key) ?? this.saved(key);
    if (found === undefined) throw new Error('这个群没有团档（或模组文件丢失）');
    const { campaign, adventure } = found;
    return [
      '【备团资料 · DM 私有】以下已记录事实与候选计划分别列出；不要向玩家转发。',
      summarize(campaign, adventure),
      `最近进度：${campaign.summaries.at(-1)?.text ?? '尚未写过；需查账本确认具体停点。'}`,
      ...recoveryLines(campaign), ...chronicleLines(campaign), ...sceneLines(campaign, adventure),
      ...hookPromptLines(campaign), ...preparationLines(campaign),
      '备团只准备下一步可能涉及的地点、NPC、规则、钩子和待确认问题。查模组用 dnd_lookup；未来安排不是事实，不替玩家选路，不自动修改任务或资源。',
    ].join('\n');
  }

  /**
   * 进 system prompt 的部分：DM 守则和背景。
   * 这里的文字一变，后面整段历史都会失去缓存（实测存档、跨场景移动各一次 10 万 token 重算），
   * 所以战斗中会变的东西放 stateSnapshot，背景按 epoch 锁住：压缩、换会话时才换成最新的。
   * 存档和账本不用补进快照：模型刚写过，都在对话里。不传 epoch 时不锁，直接给最新的。
   */
  public promptSections(key: string, epoch?: string): DndPromptSection[] {
    const found = this.active(key);
    if (found === undefined) {
      // 文字固定不变，停团期间不影响缓存
      return this.saved(key) === undefined ? [] : [{ name: 'qqbot:dnd-paused', order: 96, text: PAUSED_RULES }];
    }
    const { campaign, adventure } = found;
    const lines = [...sceneLines(campaign, adventure)];
    // 只注入整本的真相、当前章的要点、当前场景的通用规则，不注入整本书
    if (adventure.truth.length > 0) lines.unshift(`模组背景：${adventure.truth.join(' ')}`);
    const last = campaign.summaries.at(-1);
    if (last !== undefined) lines.push(`上次进度：${last.text}`);
    if (last !== undefined || campaign.handoff !== undefined) lines.push(...recoveryLines(campaign));
    lines.push(...chronicleLines(campaign));
    // 开团时锁进背景：钩子很少变，每场开头看一眼最久没碰的是谁就够
    lines.push(...hookPromptLines(campaign));
    lines.push(...preparationLines(campaign));
    const current = lines.join('\n');
    const text = epoch === undefined ? current : this.background.hold(key, epoch, current);
    return [
      { name: 'qqbot:dnd-dm', order: 96, text: DM_RULES },
      ...(text.length > 0 ? [{ name: 'qqbot:dnd-background', order: 97, text }] : []),
    ];
  }

  /**
   * 会变的团况（含当前房间的 DM 笔记），走宿主的 runtime-context 快照：变了才在对话末尾追加一条，前面的历史不动，缓存继续命中。
   * 旧快照会留在历史里，所以这里只放真正会变的内容。没开团返回空串，宿主会发一条「之前的快照作废」。
   */
  public stateSnapshot(key: string): string {
    const found = this.active(key);
    if (found === undefined) return '';
    const { campaign, adventure } = found;
    const room = findRoom(roomGraph(adventure), campaign.currentRoom);
    const lines = ['【团况 · DM 视角】', summarize(campaign, adventure)];
    if (inOpening(campaign)) {
      // 开场阶段不注入第一个场景的 DM 笔记，免得模型提前把伏击、敌人说出来
      lines.push(...openingLines(campaign, adventure));
    } else {
      const notes = room === undefined ? '' : roomView(campaign, adventure, room).dmNotes;
      if (notes) lines.push(`本房间 DM 笔记（只给你裁定用，不要直接念）：${notes}`);
    }
    // 跨场景、换章后 system prompt 里锁住的还是旧规则，新的先写在这里
    const held = this.background.peek(key);
    if (held !== undefined) lines.push(...sceneLines(campaign, adventure).filter((line) => !held.includes(line)));
    if (campaign.preparation && campaign.preparation.state !== campaignState(campaign)) {
      lines.push('DM 备团计划对应的团况已变化：先 dnd_prepare show 重新核对，不能按旧计划自动推进。');
    }
    const checkIn = this.checkIns.get(key);
    if (checkIn !== undefined) lines.push(rosterPrompt(rosterOf(checkIn, campaign)));
    return lines.join('\n');
  }
}
