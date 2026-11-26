/**
 * 跑团服务：把存储、地城库、骰子拼在一起，供工具、/dnd 命令和 prompt 注入共用。
 *
 * 开团后，这个会话每回合多两段 system prompt：DM 守则 + 精简团况。
 * 不需要切换 preset 或开新会话，/dnd end 之后自动恢复成普通聊天。
 */
import { existsSync, readdirSync, statSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import type { Roller } from './dice.ts';
import { cryptoRoller } from './dice.ts';
import { type Adventure, type AdventureLibrary, findSite, roomGraph, siteOfRoom } from './adventure.ts';
import { type Campaign, CampaignStore, SUMMARY_MAX_CHARS, addSummary, campaignState, clearAllDelegations, createCampaign, ensureSessionSummary, reconcileKnownSites, restoreAllAbsent, summarize, summarizeCombat } from './campaign.ts';
import { CustomEffectStore, type CustomEffectDef } from './custom-effects.ts';
import { PREPARATION_MAX_CHARS, preparationLines, recoveryLines } from './session-recovery.ts';
import { type CheckIn, rosterOf, rosterPrompt } from './check-in.ts';
import { chronicleLines } from './chronicle.ts';
import { hookPromptLines } from './hooks.ts';
import { PromptLatch } from '../features/prompt-latch.ts';
import type { ReplyTarget } from '../types.ts';
import { exitKey, exitsOf, findRoom } from './dungeon.ts';
import { inOpening, openingLines, roomView } from './story.ts';

export interface DndPromptSection {
  name: string;
  order: number;
  text: string;
}

export type DndLifecyclePhase = 'none' | 'active' | 'ending' | 'preparing' | 'paused';

// 开团、停团与战斗代理共用，避免收团后又凭聊天记录拼卡或口头改卡。
const CHARACTER_RULE = '- 玩家要展示、核对角色卡（含物品、法术、资源）或改卡，已有卡先用 dnd_character show 查当前数据；本轮已查则复用。展示时把所需内容发给玩家，工具结果不会自动发群。改卡用 update、建卡用 create 落盘，成功后才说已保存；不凭旧聊天拼卡、不只口头修改。';

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
  '- [Current message] 没带 (@you) 是你插嘴的机会：像旁观的老 DM 接一两句就停，不调用 dnd_* 工具、不点名、不推进、不透露机密；听着像行动也等他 @ 你。例外是待结算或移动借机时回答用不用反应，后面会跟「[系统 · 待结算]」或「[系统 · 借机]」；「[系统 · 反应讨论]」只问规则，不代表同意。',
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
  '- 记住玩家给过的长期约定（「时间充裕就默认上引导术」），之后自动算进去；长期约定与本桌裁定用 dnd_chronicle add kind=ruling 记入团档，不能只留在聊天或压缩摘要里，战斗交接会读取它们。',
  '- dm_override 只用于玩家明确委托和被推被拖这类强制位移，用了要在回复里写明是谁委托、被什么推动的。',
  '- 战利品按模组发；自制或替换魔法物品严格卡当前等级对应的 DMG 稀有度（1-4级普通/非普通，5-6级非普通最高+1，7-10级珍稀）并先核对全队现有魔法装备，不随意叠加高加值与法术特效。',
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
  '- PC 的回合只有他本人说「没了/结束」或点按钮才结束（next 传他的 declared_by），别人催不算。收到「[系统 · 按钮] X 点了结束回合」说明工具已经推进，不要再为 X next。若玩家临时离开并需要托管，用 dnd_character(action="update", name="角色名", delegate="队友名|U编号|dm|none") 把控制权交给其他玩家或由 DM 接管（DM 托管会保留反应窗口并允许 DM 免授权触发反应，防止 AFK 丢反应）。',
  '- 不是当前回合的人宣告了行动：说「记下了，等你的回合」，不提前结算；借机攻击和反应传 reaction=true。叙事里的「轮到谁」必须和工具一致，对不上先 goto。敌人倒光就 end。',
  '- 结果里有「待结算」时先停手：掷骰窗口报成败、问反应；移动借机窗口在触发格等玩家，不先把人走完或 next。PC 反应只认本人明确选择后的服务器 authorization，提问或 declared_by 都不算同意。豁免和检定要不要挂反应窗口由你判（dnd_check hold_for），尤其敌人对奇塔露自己法术的豁免。',
  '- 连击提前返回时先处理停点，照已结击数和骰号继续，不把整批重掷，也不自动向倒下的目标补刀。5e 允许在多次攻击、动作、附赠动作前后拆分移动：中途击倒当前目标且还有剩余攻击与移动力时，按【拆分移动提示】询问玩家是否 dnd_position move 转火其他目标，不要因为贴身没怪就默认收手。',
  '- 挂持续控场用 dnd_check 的 spell_name、targets 和原始 DC。工具播报自动复豁免、受伤解除或唤醒结果后直接采用。催眠图纹可由邻近的其他生物用 dnd_apply wake_by 花主动作唤醒。',
  '- 站位只认 dnd_position 和最新团况的站位行，不凭记忆和前面的叙述。严禁目测坐标断言「走不到 / 绕不开火墙或领域」而拒绝调用 move——玩家宣告接近某目标时必须直接调 dnd_position action="move" to="目标名"，寻路会自动绕开墙、敌人与危险领域区域（火墙术、荆棘丛生、蛛网术、灵体卫士等），并在经过领域技能时给出拆分移动提醒（只有玩家明确要直线硬闯危险区才传 enter_hazards=true）。开战按【场地】提示画图、摆位（优先一次调用 dnd_position action="set"，用 formation={front:[前排], mid:[中排], back:[后排], auto_rest:true} 按前中后优先级自动排好我方，再配合 placements 或 formation.enemies 给出敌方站位，免手算全员坐标撞墙叠格）；移动把玩家的原话交给工具（to、swap、keep_adjacent、away_from、dash、drag、disengage；与队友换位传 swap="队友名"，若对方玩家已在近期消息明确同意可补传 ally_declared_by，否则工具会暂停并弹出「同意换位/不同意」按钮等本人确认，不消耗反应），玩家报了坐标才用 x/y；退到门外的人 move 到门外。走错了 dnd_undo 重走，不用 set 瞬移改正。',
  '- 可转移专注（脆弱诅咒、猎人印记）在原目标倒下或战斗结束后自动保留在施法者身上（团况显示 [专注:…(可转移)]），后续回合转移目标时调用 dnd_resource action="transfer" target="新目标"（消耗附赠动作、零法术位消耗），切勿重复扣减法术位或用裸 dnd_apply 覆盖专注归属。',
  '- 跟玩家讲站位用人话，只讲角色看得见的人。开战摆位完成后若工具已发图片就直接继续。需要发战斗图时用 dnd_map view="battle"。图片确实发不出或玩家点名要文字图时，用 dnd_position show text_grid=true 并原样发工具生成的字符图。',
  '- 上下文压缩后第一次裁定之前，先对一遍最新团况的 HP、先攻指针、站位和最近记录。谁已行动、挂在目标身上的效果（猎人印记、专注）最容易走样，拿不准就查或问。',
  '',
  '【记忆与存档】',
  CHARACTER_RULE,
  '- 玩家提到以前的事，或你要说「没有这人」「没去过」「没发生过」之前，先查（dnd_chronicle search、dnd_character show、dnd_lookup）。查不到只说「我这边没记录」再问玩家；玩家说得对就照他说的补记。',
  '- 玩家讲的角色来历里没了结的事（找的人、欠的债、逃开的地方），用 dnd_hook add 记成钩子；工具结果里的「背景钩子」接不接你定，1-2 档随手用，再往上先 plan，那个人亲自出现之前先问玩家。',
  '- 工具记不到的（临场编的人和事、俘虏、承诺和欠账、线头、背景新发现、本桌裁定）用 dnd_chronicle add 记；一段剧情告一段落、接交任务、快下线时用 dnd_progress 记进度。',
  '- 收团用 dnd_end（与玩家 /dnd end 同一暂停流程），只存档用 dnd_progress；交接记清具体停点、刚发生的事、已定行动、同行与留守、未结事项和下次第一步。dnd_prepare 用来提前准备下一次团的内容（先用 dnd_prepare show 看候选下一站与模组原书目录，再用 dnd_lookup 查卡片，未展开的表格与细则可只读查阅该模组目录并提炼进 dnd_prepare save，避免下次开团临时翻书），不重复总结过去发生的事，也不能当作已发生事实或念给玩家。',
  '- 笔记（qqbot_notes action="save"）只记跨团通用、玩家知道的东西（玩家偏好、DM 约定、角色梗）：DC、怪物数值、DM 笔记、秘密不写；跑团进度只写团档。',
  '- 没有角色卡的玩家，问清名字和职业再建卡。玩家问规则可以提醒他用 /dnd search、/dnd spells 查 wiki；要看地图用 dnd_map。',
  '- 如果现在是要你写对话的压缩摘要（checkpoint）：技术类小节没有必要就写 (none)，工具用法、文件路径不用留。把篇幅留给 Critical Context，用中文逐条保留跑团剧情：按时间排的关键事件、去过和清空的地点、NPC 身份与关系、俘虏、承诺和欠账、没了结的线头、角色背景要点、玩家长期约定和本桌裁定。战斗中还要写明：这一轮谁已行动、谁用过反应、挂在目标身上的效果（猎人印记、专注、神圣武器）；站位和 HP 团况里有，不用转述。',
].join('\n');

const NARRATIVE_DM_RULES = DM_RULES.replace(/【战斗】[\s\S]*?(?=【记忆与存档】)/,
  '【战斗委派】\n- 你负责探索、剧情和准备参战角色。开战前核对角色卡与临时先攻增益，用 dnd_initiative start 掷先攻（梦境试炼、幻境或点到为止的切磋演练传 rehearsal=true，必要时传 rehearsal_hp 与 temporary_monsters，结束时自动恢复真实状态与场地图），叙述开场后停下；回复结束后战斗代理自动准备场地图、摆位与回合结算。战后按交接中的结果摘要与未播报战斗账本补叙战况并接续剧情，不重复扣血、扣资源或掷骰。\n\n');

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
  CHARACTER_RULE,
  '- 玩家要求建卡或改卡：直接用 dnd_character create/update 写 PC，再用 dnd_resource set 配置法术位和职业资源，不用先开团。player_id 填消息标签里的 U 编号；不翻文件找 openid、不手改团档。工具成功后才说已入库；停团不能建怪、删卡、移动或结算行动。',
  '- 收到 [系统 · 停团交接与下场备团] 唤醒或玩家明确要求备团时，可用 dnd_prepare show/save 提前准备下一次团的内容（先用 dnd_prepare show 看候选下一站与模组原书目录，再用 dnd_lookup 查卡片，未展开的随机遭遇表、机关与支线可只读查阅该模组目录并提炼进 dnd_prepare save，避免下次开团临时翻书；不写过去总结），计划仅 DM 可见，不推进剧情，禁止修改原书文件或发给玩家。收团后补写交接可用 dnd_end summary，不用重新 start；不把 DM 计划发到群里。',
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

const SKIP_SOURCE_ENTRIES = new Set(['adventure.json', 'sites', 'img', 'build', '_source.json']);

function formatAdventureDir(dir: string, cwd: string): string {
  const absCwd = resolve(cwd);
  const absDir = resolve(dir);
  const rel = relative(absCwd, absDir);
  if (rel === '') return '.';
  if (!rel.startsWith('..') && !isAbsolute(rel)) return rel.replace(/\\/g, '/');
  return absDir;
}

function listModuleSourceEntries(dir: string): string[] {
  if (!existsSync(dir)) return [];
  try {
    const items = readdirSync(dir)
      .filter((name) => !name.startsWith('.') && !SKIP_SOURCE_ENTRIES.has(name))
      .map((name) => {
        let isDir = false;
        try { isDir = statSync(join(dir, name)).isDirectory(); } catch { /* treat as file */ }
        return { label: isDir ? `${name}/` : name, isDir };
      });
    items.sort((a, b) => (a.isDir === b.isDir ? a.label.localeCompare(b.label) : a.isDir ? -1 : 1));
    return items.map((x) => x.label);
  } catch {
    return [];
  }
}

function upcomingCandidateLines(campaign: Campaign, adventure: Adventure): string[] {
  const graph = roomGraph(adventure);
  const currentSite = siteOfRoom(adventure, campaign.currentRoom);
  const lines: string[] = [];

  if (currentSite?.kind === 'hub') {
    const unvisited = currentSite.rooms.filter((r) => r.id !== campaign.currentRoom && !campaign.revealed.includes(r.id));
    if (unvisited.length > 0) {
      const shown = unvisited.slice(0, 12).map((r) => `${r.name}(${r.id})`).join('；');
      const tail = unvisited.length > 12 ? `（等共 ${unvisited.length} 处）` : '';
      lines.push(`当前城镇未探访地点：${shown}${tail}`);
    }
  } else {
    const exits = exitsOf(graph, campaign.currentRoom);
    if (exits.length > 0) {
      const items = exits.map((e) => {
        const target = findRoom(graph, e.to);
        const tags = [campaign.revealed.includes(e.to) ? '去过' : '未去过'];
        if (e.hidden === true) {
          tags.push(campaign.discoveredExits.includes(exitKey(campaign.currentRoom, e.to)) ? '暗门已发现' : '暗门未发现');
        }
        return `${target?.name ?? e.to}(${e.to}，${tags.join('、')})`;
      });
      lines.push(`当前房间相邻去向：${items.join('；')}`);
    }
  }

  const candidateSites: string[] = [];
  const seenSites = new Set<string>(currentSite !== undefined ? [currentSite.id] : []);
  for (const id of campaign.knownSites) {
    if (seenSites.has(id)) continue;
    const site = findSite(adventure, id);
    if (site === undefined || !site.rooms.some((r) => !campaign.revealed.includes(r.id))) continue;
    seenSites.add(id);
    candidateSites.push(`${site.name}(${site.id})`);
  }
  if (currentSite !== undefined) {
    for (const route of adventure.routes ?? []) {
      const otherId = route.from === currentSite.id ? route.to : route.to === currentSite.id ? route.from : undefined;
      if (otherId === undefined || seenSites.has(otherId)) continue;
      const site = findSite(adventure, otherId);
      if (site === undefined) continue;
      seenSites.add(otherId);
      const isKnown = campaign.knownSites.includes(otherId);
      candidateSites.push(`${site.name}(${site.id}${isKnown ? '' : '，未公开'})`);
    }
  }
  if (candidateSites.length > 0) {
    const shown = candidateSites.slice(0, 10).join('；');
    const tail = candidateSites.length > 10 ? `（等共 ${candidateSites.length} 个）` : '';
    lines.push(`其他候选场景：${shown}${tail}`);
  }

  return lines.length === 0 ? [] : ['【候选下一站 · DM 参考】', ...lines];
}

export class DndService {
  public combatInstructions(): string {
    return [
      DM_RULES,
      '【专用战斗代理】',
      '你接替主 DM 主持当前这场战斗。只处理战斗、战斗规则提问和当场反应；所有数值仍实时通过 dnd_* 写入团档。',
      '主 DM 已经讲过开战场景，不重复开场。先核对最近的【团况 · DM 视角】基线快照（每数轮对话同步一次，单轮内连续调用工具与间隔轮次内不再重复刷屏；快照之后的最新 HP、资源、先攻与站位变化直接以紧随其后的 dnd_* 工具返回与【当前回合账本】为准）；最近对话只补充行动意图与效果，不覆盖团档。能力不明用 dnd_character show 查卡或 dnd_srd 查规则，不自行猜测。',
      '【角色能力与被动】包含职业、属性、熟练与专精、武器、法术、反应、资源和备注；固定加值只认结构化字段，未接入引擎的备注被动仍须核对，但已自动结算项切勿重复手掷或重复填进 damage。已自动结算包括：14种PHB状态与力竭、巨武器战斗、箭术、精灵精准、战地施法者、不死坚韧、守护灵光、生命门徒、神佑医者、巨兽杀手/巨像屠夫、偷袭、精通至圣斩、祝福打击、神圣狂怒、凶蛮攻击、精通重击/卓越重击、集群战术、血腥狂乱、武器多段 riders、以及状态/资源触发的战斗英姿、咒剑诅咒、脆弱诅咒、猎人印记、神恩、变巨术、狂暴、灵体卫士、防护毒素与 dnd_rule 已登记扩展规则（当出现【条件被动】或【未注册被动提醒】时按提示核对）。持续区域法术/毒雾/黑暗术用 dnd_position action=zone 放置，飞行单位用 z 高度移动。',
      '每次只处理当前宣告；轮到 PC 或有反应待答就停。敌人倒光或战斗以其他方式确定结束，用 dnd_initiative end（若演练/切磋未开 rehearsal=true 但临时画了竞技场地形，结束前先 dnd_position clear_terrain 清理），并在本条回复中完整播报最后一轮的掷骰过程与胜负收场，播报完即停，等待主 DM 接手战后剧情。',
      '专注、猎人印记、临时增益、未完成动作、本桌裁定不能只留在叙述里：备注用 dnd_character update notes、状态用 dnd_apply add_conditions/remove_conditions，本桌裁定用 dnd_chronicle 记清目标、持续时间和已使用情况。',
      '战斗结束后不继续探索、不重开下一场、不替玩家选择行动；主 DM 会收到系统生成的最新团况与队伍消耗。',
      '收到暂停要求可用 dnd_end；遇到需要剧情裁定的事先问玩家，不补编模组秘密。',
    ].join('\n');
  }

  public readonly store: CampaignStore;
  public readonly library: AdventureLibrary;
  public readonly roller: Roller;
  public readonly customEffects: CustomEffectStore;
  /** 地图 PNG 输出目录 */
  public readonly mapDir: string;
  /** 发图片到群里：启动时由 bootstrap 接上，/dnd map 和 dnd_map 发同一张图；没接上时 /dnd map 退回文字地图 */
  public sendImage?: (target: ReplyTarget, path: string, caption?: string) => Promise<void>;
  /** 这一次开团的签到表（会话 key → 签到）；只在内存里，见 check-in.ts */
  public readonly checkIns = new Map<string, CheckIn>();
  /** 团开始、暂停时通知（会话可见的 dnd_* 工具要跟着变，见 tool-scope.ts） */
  public onStateChange?: (key: string) => void;
  /** 这段对话 system prompt 里锁住的背景，见 promptSections */
  private readonly background: PromptLatch;
  private readonly forceSnapshotSeq = new Map<string, number>();
  private readonly agentSyncedSnapshots = new Map<string, { main: string; combat: string }>();
  private readonly cwd: string;

  public constructor(options: { store: CampaignStore; library: AdventureLibrary; mapDir: string; roller?: Roller; cwd?: string; latchFile?: string }) {
    this.store = options.store;
    this.library = options.library;
    this.mapDir = options.mapDir;
    this.roller = options.roller ?? cryptoRoller;
    this.cwd = options.cwd ?? process.cwd();
    this.background = new PromptLatch(options.latchFile);
    this.customEffects = new CustomEffectStore(join(options.store.root, '..', 'custom-effects.json'));
  }

  /** 当前会话团档对应的目录形式模组根目录（开团与停团均有效；无团档或单文件/内置模组返回 undefined） */
  public adventureDir(key: string): string | undefined {
    const campaign = this.store.load(key);
    if (campaign === undefined) return undefined;
    return this.library.get(campaign.adventureId)?.dir;
  }

  public globalEffects(): Record<string, CustomEffectDef> {
    return this.customEffects.loadAll();
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

  /** 暂停中的团（收团后、下次 /dnd start 前）；供查询、备团与受限写卡使用 */
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
    this.forceNextSnapshot(key);
    if (existing !== undefined && existing.adventureId === adventure.id && !fresh) {
      existing.active = true;
      existing.sessionStartedAt = Date.now();
      delete existing.endPrep;
      restoreAllAbsent(existing);
      clearAllDelegations(existing);
      reconcileKnownSites(existing, adventure);
      this.store.save(existing);
      this.onStateChange?.(key);
      return { campaign: existing, adventure, resumed: true, carried: [] };
    }
    if (existing !== undefined) this.store.archive(key);
    const campaign = createCampaign(key, adventure);
    campaign.sessionStartedAt = Date.now();
    if (existing !== undefined && options.keepParty !== false) {
      for (const ch of existing.characters.filter((x) => x.kind === 'pc')) {
        const copy = structuredClone(ch);
        delete copy.room;
        delete copy.absent;
        campaign.characters.push(copy);
      }
    }
    this.store.save(campaign);
    this.onStateChange?.(key);
    return { campaign, adventure, resumed: false, carried: campaign.characters.map((ch) => ch.name) };
  }

  public lifecyclePhase(key: string): DndLifecyclePhase {
    const campaign = this.store.load(key);
    if (campaign === undefined) return 'none';
    if (campaign.active) return 'active';
    return campaign.endPrep?.phase ?? 'paused';
  }

  public validateStop(
    key: string,
    summary?: string,
  ): { ok: true; active: boolean } | { ok: false; reason: 'inactive' | 'invalid'; message?: string } {
    const campaign = this.store.load(key);
    if (campaign === undefined || (!campaign.active && summary === undefined)) {
      return { ok: false, reason: 'inactive' };
    }
    if (summary !== undefined) {
      const value = summary.trim();
      if (value.length === 0) {
        return { ok: false, reason: 'invalid', message: '结团摘要不能为空' };
      }
      if (value.length > SUMMARY_MAX_CHARS) {
        return {
          ok: false,
          reason: 'invalid',
          message: `进度共 ${value.length} 字，超过 ${SUMMARY_MAX_CHARS} 字，未保存、旧进度保留。请用 summary 精简后整份重写。`,
        };
      }
    }
    return { ok: true, active: campaign.active };
  }

  /** 命令和 DM 工具共用一次落盘；暂停后也允许补写交接，不会重新开团。 */
  public stop(key: string, summary?: string, options?: { endPrepId?: string }): Campaign | undefined {
    const campaign = this.store.load(key);
    if (campaign === undefined || (!campaign.active && summary === undefined)) return undefined;
    if (summary !== undefined) {
      if (!summary.trim()) throw new Error('结团摘要不能为空');
      addSummary(campaign, summary);
    }
    campaign.active = false;
    restoreAllAbsent(campaign);
    clearAllDelegations(campaign);
    ensureSessionSummary(campaign);
    if (options?.endPrepId !== undefined) {
      campaign.endPrep = {
        id: options.endPrepId,
        phase: 'preparing',
        startedAt: Date.now(),
        hasSummary: summary !== undefined,
      };
    } else if (summary !== undefined && campaign.endPrep !== undefined) {
      campaign.endPrep.hasSummary = true;
    }
    this.store.save(campaign);
    this.background.forget(key);
    this.forceNextSnapshot(key);
    this.checkIns.delete(key);
    this.onStateChange?.(key);
    return campaign;
  }

  public completeEndPreparation(key: string, id?: string): boolean {
    const campaign = this.store.load(key);
    if (campaign?.endPrep === undefined) return false;
    if (id !== undefined && campaign.endPrep.id !== id) return false;
    delete campaign.endPrep;
    this.store.save(campaign);
    return true;
  }

  public savePreparation(key: string, text: string): void {
    const campaign = this.store.load(key);
    if (campaign === undefined) throw new Error('这个群没有团档');
    const value = text.trim();
    if (value.length > PREPARATION_MAX_CHARS) throw new Error(`备团计划超过 ${PREPARATION_MAX_CHARS} 字，未保存，请精简`);
    if (value.length === 0) delete campaign.preparation;
    else {
      campaign.preparation = { at: Date.now(), state: campaignState(campaign), text: value };
      delete campaign.endPrep;
    }
    this.store.save(campaign);
  }

  public buildEndPreparationPrompt(
    key: string,
    options?: { userSummary?: string; combatHandoff?: string },
  ): string {
    const found = this.saved(key) ?? this.active(key);
    const hasOngoingCombat = found?.campaign.initiative !== undefined;
    const summaryText = found?.campaign.summaries.at(-1)?.text;
    const hasCustomSummary = summaryText !== undefined && (found?.campaign.sessionStartedAt === undefined || (found?.campaign.summaries.at(-1)?.at ?? 0) >= found.campaign.sessionStartedAt);
    const lines = [
      '[系统 · 停团交接与下场备团 · DM 私有]',
      `玩家刚执行了 /dnd end：团档、角色卡${hasOngoingCombat ? '与当前进行中的战斗状态（先攻/站位/待结算）' : ''}已原子暂停并保存。禁止再推进剧情、改变站位、掷骰或重复发停团状态。`,
      ...(options?.combatHandoff !== undefined ? [options.combatHandoff] : []),
      ...(options?.userSummary !== undefined
        ? [`玩家附带停团摘要「${options.userSummary}」（已记入交接；若不够完整，可补充调用 dnd_end summary）。`]
        : [hasCustomSummary
            ? `当前已有停团交接摘要，如需补充未结线头可直接调用 dnd_end(summary=...) 更新；不要重新 start。`
            : '若本场还没有完整六段交接（【位置】【刚刚发生】【已定行动】【同行与留守】【未结事项】【下次接续】），请用 dnd_end(summary=...) 补写玩家已知事实。']),
      '【必须执行的下场备团】现在立刻依次调用：',
      '1. `dnd_prepare(action="show")` 查看最新团况、候选下一站、近期日志与模组原书只读目录；',
      '2. 用 `dnd_lookup` 查候选房间/NPC（如目录有原书文件，用 read/glob/grep 只读查阅未展开的遭遇表、机关 DC 与支线）；',
      '3. 调用 `dnd_prepare(action="save", plan=...)` 保存一份不超过 2000 字的 DM 私有前瞻计划（仅写后续可能用到的场景/检定/陷阱/NPC 要点，不写已发生总结，也绝不把未来计划当成已发生事实）。',
      '4. 保存完成后，向群里只回复一段简短、不剧透的停团确认（说明进度/角色卡已归档、战斗或探险状态已保留、下场资料已备好，下次 `/dnd start` 继续；严禁透露任何 DM 私有计划、未去过的房间/剧情剧透或怪物 AC/HP/DC）。',
    ];
    return lines.join('\n');
  }

  public preparationContext(key: string): string {
    const found = this.active(key) ?? this.saved(key);
    if (found === undefined) throw new Error('这个群没有团档（或模组文件丢失）');
    const { campaign, adventure } = found;
    const sourceGuide = adventure.dir !== undefined
      ? (() => {
          const displayDir = formatAdventureDir(adventure.dir, this.cwd);
          const entries = listModuleSourceEntries(adventure.dir);
          return [
            `模组原书目录（只读，供 DM 备团用 read/glob/grep 查阅；禁止修改或用 qqbot_send_file 发给玩家）：${displayDir}${entries.length > 0 ? `（含：${entries.join('、')}）` : ''}`,
            '备团要提前准备下一次可能涉及的候选地点、原书表格（随机遭遇/战利品/局势）、机关检定、NPC 与个人钩子，不重复总结已发生的事。先用 dnd_lookup 查候选场景与角色，卡片未展开的表格与细则直接只读查阅上述模组目录，再将要点提炼进 dnd_prepare save，避免下次开团临时翻书；未来安排不是事实，不替玩家选路，不自动修改任务或资源。',
          ];
        })()
      : [
          '当前模组没有独立原书目录；先用 dnd_lookup 提前查好候选场景、房间、NPC、任务与线索，将要点提炼进 dnd_prepare save，避免下次开团临时翻查；未来安排不是事实，不替玩家选路，不自动修改任务或资源。',
        ];
    return [
      '【备团资料 · DM 私有】以下已记录事实与候选计划分别列出；不要向玩家转发。',
      summarize(campaign, adventure),
      `最近进度：${campaign.summaries.at(-1)?.text ?? '尚未写过；需查账本确认具体停点。'}`,
      ...(campaign.log.length > 5 ? [`近期完整日志（共 ${campaign.log.length} 条）：${campaign.log.join('；')}`] : []),
      ...upcomingCandidateLines(campaign, adventure),
      ...recoveryLines(campaign), ...chronicleLines(campaign), ...sceneLines(campaign, adventure),
      ...hookPromptLines(campaign), ...preparationLines(campaign),
      ...sourceGuide,
    ].join('\n');
  }

  /**
   * 进 system prompt 的部分：DM 守则和背景。
   * 这里的文字一变，后面整段历史都会失去缓存（实测存档、跨场景移动各一次 10 万 token 重算），
   * 所以战斗中会变的东西放 stateSnapshot，背景按 epoch 锁住：压缩、换会话时才换成最新的。
   * 存档和账本不用补进快照：模型刚写过，都在对话里。不传 epoch 时不锁，直接给最新的。
   */
  public promptSections(key: string, epoch?: string, delegateCombat = false): DndPromptSection[] {
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
      { name: 'qqbot:dnd-dm', order: 96, text: delegateCombat ? NARRATIVE_DM_RULES : DM_RULES },
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
      lines.push('DM 备团计划对应的团况已变化：旧计划仅作参考（仍适用的后续设定可直接沿用，不能照演或当作已发生事实）；需更新或清空时再调 dnd_prepare save/clear，不必每回合重复 show。');
    }
    const checkIn = this.checkIns.get(key);
    if (checkIn !== undefined) lines.push(rosterPrompt(rosterOf(checkIn, campaign), checkIn.started));
    return lines.join('\n');
  }

  public static readonly TURN_SNAPSHOT_HEADER = '【团况 · DM 视角（本轮最新快照，旧快照作废）】';

  /** 专用战斗子代理使用的精简快照（不含全图出口、场外角色资源与主线剧情进展） */
  public combatStateSnapshot(key: string): string {
    const found = this.active(key);
    if (found === undefined) return '';
    const { campaign, adventure } = found;
    if (campaign.initiative === undefined) return this.stateSnapshot(key);
    return [DndService.TURN_SNAPSHOT_HEADER, summarizeCombat(campaign, adventure, this.globalEffects())].join('\n');
  }

  /** 非演练战斗的当前房间静态环境/DM 笔记，放在开战交接固定前缀中一次，避免随每次扣血重复追加 */
  public roomCombatNotes(key: string): string {
    const found = this.active(key);
    if (found === undefined) return '';
    const { campaign, adventure } = found;
    if (inOpening(campaign) || campaign.initiative?.rehearsal === true) return '';
    const room = findRoom(roomGraph(adventure), campaign.currentRoom);
    const notes = room === undefined ? '' : roomView(campaign, adventure, room).dmNotes;
    return notes ? `本房间环境与 DM 笔记（只给你裁定地形/机关用，不要直接念）：${notes}` : '';
  }

  /** 标记该会话下一次进入模型步骤时跳过轮数节流、立即刷新完整团况（用于 dnd_undo 回滚、开停团、战斗交回等） */
  public forceNextSnapshot(key: string): void {
    this.forceSnapshotSeq.set(key, (this.forceSnapshotSeq.get(key) ?? 0) + 1);
    this.agentSyncedSnapshots.delete(key);
  }

  public snapshotForceSeq(key: string): number {
    return this.forceSnapshotSeq.get(key) ?? 0;
  }

  /**
   * 记录本次团档变动来自 Agent 自身刚执行的 dnd_* 工具（模型已在紧邻的工具返回值中拿到增量明细），
   * 允许后续在轮数节流窗口内暂缓重发整份团况；反之若发生工具外改档（外部命令/后台变更），将立即识别并穿透节流。
   */
  public recordAgentToolSync(key: string): void {
    try {
      this.agentSyncedSnapshots.set(key, {
        main: this.stateSnapshot(key),
        combat: this.combatStateSnapshot(key),
      });
    } catch {
      this.agentSyncedSnapshots.delete(key);
    }
  }

  public isExternallyDirty(key: string, kind: 'main' | 'combat', currentSnap: string, lastInjected?: string): boolean {
    const baseline = this.agentSyncedSnapshots.get(key)?.[kind] ?? lastInjected;
    return baseline !== undefined && baseline !== currentSnap;
  }

  /**
   * 决定团况快照是否跨越关键场景边界的签名：
   * 换房间（需新房间 DM 笔记）、开战/结战、开场揭幕、签到/暂离变化等结构变化在同轮内先锁住，
   * 待进入下一轮用户对话第一步时立即穿透 4 轮节流同步；上下文压缩（epoch）与 dnd_undo（forceSeq）可在同轮立即穿透。
   */
  public snapshotStructuralKey(key: string, epoch = ''): string {
    const found = this.active(key);
    if (found === undefined) return `${epoch}|inactive`;
    const { campaign } = found;
    const ci = this.checkIns.get(key);
    const ciKey = ci === undefined ? '' : `${ci.openedAt}:${ci.started ? 1 : 0}:${[...ci.arrived.keys()].sort().join(',')}`;
    const absentKey = campaign.characters.filter((ch) => ch.absent === true).map((ch) => ch.name).join(',');
    return [
      epoch,
      campaign.currentRoom,
      campaign.chapter ?? '',
      inOpening(campaign) ? 'open' : 'play',
      campaign.initiative !== undefined ? 'combat' : 'explore',
      ciKey,
      absentKey,
    ].join('|');
  }
}

interface SnapshotGateEntry {
  lastInjected: string;
  lastTurnTag?: string;
  lastEpoch: string;
  lastStructKey: string;
  lastForceSeq: number;
  turnsSinceInject: number;
}

/**
 * 团况 runtime-context 节流门控（同轮锁死、跨轮首步穿透）：
 * 1. 单轮对话内（turnTag 未变）：即使连续调用移动（换房）、开战/结战、暂离/签到等工具，也一律锁定返回本轮初同一快照字符串，
 *    同时保持 `lastStructKey` 不提前推进，使宿主 diff 判定无变化、单轮工具循环内 0 次重发 runtime-context；
 *    同轮仅在上下文压缩（`epoch` 变化）或 `dnd_undo` 回滚（`forceSeq` 变化）导致前文失效时立即穿透；
 * 2. 跨到下一轮用户对话开头（turnTag 递增）：若上一轮发生过 `structKey` 变化（如批量切房、开战/结战等），
 *    第一步即命中 `structKey !== lastStructKey` 并跳过 `intervalTurns`（默认 4 轮）节流，一次性同步最终稳定团况；
 * 3. 常规对话轮次按 `intervalTurns`（默认 4 轮）刷新，结团/停团（fresh === ''）立即清空作废。
 */
export class DndSnapshotGate {
  private readonly entries = new WeakMap<object, SnapshotGateEntry>();

  public resolve(options: {
    agentKey: object;
    fresh: string;
    turnTag?: string;
    epoch?: string;
    structKey: string;
    forceSeq: number;
    externallyDirty?: boolean;
    intervalTurns: number;
  }): string {
    const { agentKey, fresh, turnTag, structKey, forceSeq, externallyDirty } = options;
    const epoch = options.epoch ?? '';
    const interval = Math.max(1, Math.trunc(options.intervalTurns || 4));
    if (fresh === '') {
      this.entries.delete(agentKey);
      return '';
    }
    const prev = this.entries.get(agentKey);
    if (prev === undefined) {
      this.entries.set(agentKey, {
        lastInjected: fresh,
        ...(turnTag !== undefined ? { lastTurnTag: turnTag } : {}),
        lastEpoch: epoch,
        lastStructKey: structKey,
        lastForceSeq: forceSeq,
        turnsSinceInject: 0,
      });
      return fresh;
    }

    const epochChanged = epoch !== prev.lastEpoch;
    const forceChanged = forceSeq !== prev.lastForceSeq;
    const structChanged = structKey !== prev.lastStructKey;

    // 同一轮对话的多步工具调用循环内：同轮锁死 structKey 变化，仅在压缩（epoch）或 dnd_undo（forceSeq）使旧文失效时穿透
    if (turnTag !== undefined && turnTag === prev.lastTurnTag) {
      if (!epochChanged && !forceChanged) return prev.lastInjected;
      prev.lastInjected = fresh;
      prev.lastEpoch = epoch;
      prev.lastStructKey = structKey;
      prev.lastForceSeq = forceSeq;
      prev.turnsSinceInject = 0;
      return fresh;
    }

    // 进入新的一轮用户对话：若上一轮有被同轮锁住的 structKey 变化，首步即刻穿透节流同步最终稳定态
    if (turnTag !== undefined) prev.lastTurnTag = turnTag;
    prev.turnsSinceInject += 1;

    if (epochChanged || forceChanged || structChanged || externallyDirty === true || prev.turnsSinceInject >= interval) {
      prev.lastEpoch = epoch;
      prev.lastStructKey = structKey;
      prev.lastForceSeq = forceSeq;
      if (fresh !== prev.lastInjected) {
        prev.lastInjected = fresh;
        prev.turnsSinceInject = 0;
        return fresh;
      }
      prev.turnsSinceInject = interval;
      return prev.lastInjected;
    }

    return prev.lastInjected;
  }
}
