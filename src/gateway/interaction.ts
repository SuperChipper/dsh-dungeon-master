/**
 * 互动回调（按钮点击）统一分发与事件绑定
 *
 * QQ 只有一个 interaction 入口，按 button_data 的顶层 `t` 判别字段路由，
 * 避免多通道各自 try 导致误判；同时缓存 event_id 供被动回复使用。
 */
import type { InteractionEvent, QQBot } from '@tencent-connect/qqbot-nodejs';
import type { SessionManager } from '../session/index.ts';
import type { ChatScope } from '../types.ts';
import { cacheEventId } from '../transport/msgid-cache.ts';
import { decodeButtonData } from '../features/button-utils.ts';
import type { GroupAccess, GroupAccessFeature } from '../features/group-access.ts';
import type { PersonaSwitch } from '../features/persona-switch.ts';
import type { ToolAccess } from '../features/tool-access.ts';
import { ACK, type DndTurnButtons } from '../dnd/turn-buttons.ts';

/**
 * interaction 统一分发器：按 button_data 的顶层 `t` 判别字段，路由到对应
 * channel（question / approval / dnd / access / persona）。
 */
export function dispatchInteraction(
  event: InteractionEvent,
  manager: SessionManager,
  dndButtons?: DndTurnButtons,
  toolAccess?: ToolAccess,
  groupAccess?: Partial<Record<GroupAccessFeature, GroupAccess>>,
  personaSwitch?: PersonaSwitch,
): number {
  const raw = event.data?.resolved?.button_data;
  if (!raw) return ACK.duplicate;
  const button = decodeButtonData(raw);
  if (!button) return ACK.duplicate;
  // 跑团按钮自己决定返回码：不是本人点「结束回合」时回 denied，QQ 会弹无权限提示
  if (button.t === 'dnd') return dndButtons?.handleInteraction(event) ?? ACK.duplicate;
  // 终端白名单确认：只认主人点击，别人点回 denied
  if (button.t === 'access') return toolAccess?.handleInteraction(event) ?? ACK.duplicate;
  if (button.t === 'browser-access') return groupAccess?.browser?.handleInteraction(event) ?? ACK.duplicate;
  if (button.t === 'image-gen-access') return groupAccess?.imageGen?.handleInteraction(event) ?? ACK.duplicate;
  if (button.t === 'persona') return personaSwitch?.handleInteraction(event) ?? ACK.duplicate;
  const matched = button.t === 'question'
    ? manager.questionChannel?.handleInteraction(event) ?? false
    : manager.approvalChannel?.handleInteraction(event) ?? false;
  return matched ? ACK.ok : ACK.duplicate;
}

/** 绑定 bot 的 interaction 回调 */
export function bindInteractionHandler(
  bot: QQBot,
  manager: SessionManager,
  dndButtons?: DndTurnButtons,
  toolAccess?: ToolAccess,
  groupAccess?: Partial<Record<GroupAccessFeature, GroupAccess>>,
  personaSwitch?: PersonaSwitch,
): void {
  bot.on('interaction', async (_iCtx: unknown, event: InteractionEvent) => {
    // scope/targetId 推导对齐消息事件（inbound.ts）：按 scene 判定类型，群用 group_openid，私聊用 user_openid
    const scope: ChatScope = event.scene === 'group' ? 'group' : 'c2c';
    const targetId = scope === 'group' ? (event.group_openid ?? event.user_openid) : event.user_openid;
    // 记录互动事件 id，作为后续被动回复候选（event_id）
    cacheEventId(scope, targetId, event.id);

    const code = dispatchInteraction(event, manager, dndButtons, toolAccess, groupAccess, personaSwitch);
    await bot.acknowledgeInteraction(event.id, code).catch(() => {});
  });
}
