/**
 * dnd_* 跑团工具：骰子、检定、伤害/治疗/状态、角色卡、先攻、移动、地图、剧情、模组查询、结团、SRD 查询。
 *
 * 工具结果只给模型看（showToolResults 对 dnd_* 永远不展示），DM 机密留在这里，
 * 由模型决定哪些说给玩家。团按会话 key 区分：每个群一份。
 *
 * 这里只是入口：共用部分在 tools/shared.ts，工具按类别分在 tools/ 下各自的文件里。
 */
import type { Context } from '@deepseek-ai/cordis';
import { registerDiceTools } from './tools/dice.ts';
import { registerCharacterTools } from './tools/character.ts';
import { registerCombatTools } from './tools/combat.ts';
import { registerExploreTools } from './tools/explore.ts';
import { registerStoryTools } from './tools/story.ts';
import { registerSaveTools } from './tools/saves.ts';
import { registerSrdTools } from './tools/srd.ts';
import { createToolKit, type DndToolDeps } from './tools/shared.ts';

export {
  DND_TOOL_PREFIX,
  characterBrief,
  combatJoinHint,
  combatTurnPrompt,
  critExpression,
  diceCount,
  fetchSrd,
  formatSrd,
  greatWeaponRoller,
  lookup,
  lookupSrd,
  partySizeHint,
  srdMonsterInput,
  storyAction,
  turnPrompt,
  type DndToolDeps,
  type MemberIds,
  type SrdLookup,
  type TurnPromptOptions,
} from './tools/shared.ts';

/** 注册全部 dnd_* 工具，返回注册上的工具名（tools 服务不可用时为空） */
export function registerDndTools(ctx: Context, deps: DndToolDeps): string[] {
  const kit = createToolKit(ctx, deps);
  if (kit === undefined) return [];
  registerDiceTools(kit);
  registerCharacterTools(kit);
  registerCombatTools(kit);
  registerExploreTools(kit);
  registerStoryTools(kit);
  registerSaveTools(kit);
  registerSrdTools(kit);
  deps.logger.info(`im-qqbot: 跑团工具已注册 campaigns=${deps.service.store.root}`);
  return kit.names;
}
