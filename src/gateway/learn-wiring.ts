import type { Context } from '@deepseek-ai/cordis';
import type { ContentBlock } from '@deepseek-ai/dsh-llm';
import { join } from 'node:path';
import type { ImQQBotConfig } from '../config.ts';
import { isLearnRequest, LearnInbox, preferenceExcerpt } from '../features/learn-inbox.ts';
import { onHostAgentLifecycle, onHostSessionEvent, onHostToolsResult, tryReadSessionEvents } from '../host-adapter/index.ts';
import type { DshAgent, SessionManager } from '../session/index.ts';
import type { Logger } from '../types.ts';
import type { SessionLike } from '../transport/outbound.ts';
import type { RawSessionEvent } from '../transport/events.ts';

const TOOL = 'qqbot_learn_inbox';

interface UserInput {
  id?: string;
  source?: { kind?: string; name?: string; rpcId?: string; principal?: { kind?: string } };
  content?: Array<{ type: string; text?: string }>;
}
interface ReviewEvent { type: string; data?: UserInput }

/** Read the current human gesture from the host log, including on a hot reload. */
function hostRequestedReview(events: readonly ReviewEvent[], ownerChat: boolean): boolean {
  let invoked = false;
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i]!;
    if (event.type === 'turn/end' || event.type === 'turn/start') break;
    if (event.type !== 'user/message') continue;
    const source = event.data?.source;
    if (source?.kind === 'skill-invocation' && source.name === 'learn') invoked = true;
    if (source?.kind !== 'user') continue;
    // The host stamps rpcId on Web/Desktop prompts; share viewers also carry a non-owner principal.
    if (source.principal !== undefined && source.principal?.kind !== 'owner') return false;
    if (!ownerChat && !(typeof source.rpcId === 'string' && source.rpcId.length)) return false;
    return event.data?.content?.some(block => block.type === 'text' && typeof block.text === 'string'
      && (isLearnRequest(block.text) || (invoked && /(?:请用|使用|运行|执行|调用|启动)\s*\/learn(?=\s|$)/u.test(block.text)))) === true;
  }
  return false;
}

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
  const recordFor = (agent: DshAgent) => manager.findByAgent(agent) ?? manager.findBySessionId(agent.session.id);

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
    description: 'Read this bot owner’s pending drafts during an explicit /learn from the owner’s QQ private chat or local host session. Search existing scoped notes before proposing a change. Wait for approval before writing.',
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
      const agent = exec.agent;
      if (!agent?.session?.id) throw new Error('请在主人会话显式发起 /learn。');
      const chat = recordFor(agent);
      if (chat && chat.sessionId !== agent.session.id) throw new Error('请在当前主人会话发起 /learn。');
      const events = tryReadSessionEvents<ReviewEvent>(agent.session) ?? [];
      const drafts = inbox.list(chat, args?.limit, hostRequestedReview(events, !!chat && inbox.allows(chat)));
      // Existing log content, read only for a specifically identified preference from this active session.
      const pending = new Set(drafts.filter(d => d.kind === 'preference' && d.evidence.sessionId === agent.session.id)
        .map(d => d.evidence.agentMessageId));
      const source = new Map<string, string>();
      if (pending.size) for (const event of events) {
        const data = event.data;
        if (event.type !== 'user/message' || data?.source?.kind !== 'user' || !data.id || !pending.has(data.id)) continue;
        const text = data.content?.find(block => block.type === 'text')?.text;
        const excerpt = typeof text === 'string' ? preferenceExcerpt(text) : undefined;
        if (excerpt) source.set(data.id, excerpt);
      }
      return { drafts: drafts.map(d => ({ ...d, ...(d.evidence.agentMessageId && source.has(d.evidence.agentMessageId)
        ? { sourceExcerpt: source.get(d.evidence.agentMessageId) } : {}) })) };
    },
  }, { when: ({ agent }) => {
    if (!agent?.session?.id) return false;
    const chat = recordFor(agent);
    return chat === undefined || inbox.allows(chat);
  } });
}
