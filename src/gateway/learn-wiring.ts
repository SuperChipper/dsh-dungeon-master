import type { Context } from '@deepseek-ai/cordis';
import type { ContentBlock } from '@deepseek-ai/dsh-llm';
import { join } from 'node:path';
import type { ImQQBotConfig } from '../config.ts';
import { LearnInbox } from '../features/learn-inbox.ts';
import { onHostAgentLifecycle, onHostSessionEvent, onHostToolsResult, tryReadSessionEvents } from '../host-adapter/index.ts';
import type { DshAgent, SessionManager } from '../session/index.ts';
import type { Logger } from '../types.ts';
import type { SessionLike } from '../transport/outbound.ts';
import type { RawSessionEvent } from '../transport/events.ts';

const TOOL = 'qqbot_learn_inbox';

export function wireLearnInbox(ctx: Context, manager: SessionManager, config: ImQQBotConfig,
  profileDir: string, logger: Logger): void {
  if (!config.ownerOpenid?.trim()) return;
  const tools = ctx.get('tools') as { register(definition: unknown, options?: {
    when(context: { agent?: DshAgent }): boolean;
  }): unknown } | undefined;
  if (!tools?.register) return;
  const inbox = new LearnInbox(join(profileDir, 'qqbot-learn-inbox'), config.appId,
    () => config.ownerOpenid, () => logger.warn('im-qqbot: 无法保存经验草稿，正式笔记未改动'));
  manager.learnInbox = inbox;

  onHostSessionEvent<SessionLike, RawSessionEvent>(ctx, (session, event) => {
    const chat = manager.findBySessionId(session.header.id);
    if (chat?.sessionId === session.header.id) inbox.observe(chat, event);
  });
  onHostToolsResult<{ agent?: DshAgent; name: string; callId: string; arguments: unknown }, { isError: boolean; value?: unknown }>(
    ctx, (exec, result) => {
      if (exec.agent === undefined) return;
      const chat = manager.findByAgent(exec.agent);
      if (chat !== undefined) inbox.observeTool(chat, exec, result);
    },
  );
  onHostAgentLifecycle<DshAgent>(ctx, 'agent/disposed', ({ agent }) => {
    if (agent?.session?.id) inbox.forget(agent.session.id);
  });

  tools.register({
    name: TOOL,
    description: 'Read unfiled experience drafts during an explicit /learn in the bot owner’s QQ private chat. Does not modify notes or skills.',
    parameters: {
      type: 'object',
      properties: { limit: { type: 'integer', minimum: 1, maximum: 12 } },
      additionalProperties: false,
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args: unknown, value: unknown): ContentBlock[] => {
        const drafts = (value as { drafts?: unknown[] } | undefined)?.drafts ?? [];
        if (drafts.length === 0) {
          return [{ type: 'text', text: 'qqbot_learn_inbox：没有待归档的经验草稿。' }];
        }
        return [{
          type: 'text',
          text: `qqbot_learn_inbox：${drafts.length} 条草稿\n${JSON.stringify(drafts, null, 2)}`,
        }];
      },
    },
    async execute(args: { limit?: number }, exec: { agent?: DshAgent }) {
      const chat = exec.agent === undefined ? undefined : manager.findByAgent(exec.agent);
      if (chat === undefined) throw new Error('仅供主人在当前 QQ 私聊输入 /learn 后使用。');
      const drafts = inbox.list(chat, args?.limit);
      // Existing log content, read only for a specifically identified preference from this active session.
      type UserEvent = { type: string; data?: { id?: string; source?: { kind?: string }; content?: Array<{ type: string; text?: string }> } };
      const pending = new Set(drafts.filter(d => d.kind === 'preference' && d.evidence.sessionId === chat.sessionId)
        .map(d => d.evidence.agentMessageId));
      const source = new Map<string, string>();
      if (pending.size) for (const event of tryReadSessionEvents<UserEvent>(chat.agent.session) ?? []) {
        const data = event.data;
        if (event.type !== 'user/message' || data?.source?.kind !== 'user' || !data.id || !pending.has(data.id)) continue;
        const text = data.content?.find(block => block.type === 'text')?.text;
        if (typeof text === 'string') source.set(data.id, text.slice(0, 420));
      }
      return { drafts: drafts.map(d => ({ ...d, ...(d.evidence.agentMessageId && source.has(d.evidence.agentMessageId)
        ? { sourceExcerpt: source.get(d.evidence.agentMessageId) } : {}) })) };
    },
  }, { when: ({ agent }) => {
    // Tool snapshots may be prepared before user/message is committed. Gate the
    // definition by owner and gate the actual read by the admitted /learn input.
    const chat = agent === undefined ? undefined : manager.findByAgent(agent);
    return chat !== undefined && inbox.allows(chat);
  } });
}
