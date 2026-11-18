import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { mkdirSync, writeFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import type { DshAgent } from '../session/types.ts';
import type { OutboundHandlers } from '../transport/outbound.ts';
import type { OperationEvidence } from '../notes/operation-recall.ts';
import { QQBOT_MESSAGE_SOURCE } from '../shared/message-source.ts';

interface Evidence { operations: string[]; results: OperationEvidence[] }
export class MediaReviewCoordinator {
  private readonly failedAudits = new Map<string, unknown>();
  retainedAudit(sessionId: string): unknown { return this.failedAudits.get(sessionId); }
  constructor(private readonly outbound: OutboundHandlers,
    private readonly warn: (message: string) => void,
    private readonly auditRoot = join(homedir(), '.dsh', 'qqbot-media-review')) {}

  arm(agent: DshAgent, operations: readonly string[]): void {
    if (!operations.some(op => op.startsWith('media.'))) return;
    const id = agent.session.id;
    const existing = this.outbound.getMediaReviewState(id);
    if (existing) return; // steered input belongs to the already-buffered turn
    try {
      this.outbound.armMediaReview(id, { evidence: { operations: [...operations], results: [] } satisfies Evidence,
        fallbackText: '这轮媒体回复未完成核验，暂未发送原稿；需要重新确认解析结果。' });
    } catch {
      this.warn('im-qqbot: media input arrived after output began; pre-send buffering unavailable for this turn');
    }
  }

  observe(agent: DshAgent, result: OperationEvidence): void {
    const id = agent.session.id;
    const state = this.outbound.getMediaReviewState(id);
    if (!state) return;
    const evidence = state.evidence as Evidence;
    // Keep execution facts; detailed tool text is already in the host log and is not duplicated here.
    this.outbound.updateMediaReviewEvidence(id, { operations: evidence.operations,
      results: [...evidence.results.filter(previous => previous.operations[0] !== result.operations[0]).slice(-15), { ...result, query: '' }] } satisfies Evidence);
  }

  async stopping(agent: DshAgent, signal: AbortSignal): Promise<void> {
    const decision = await this.outbound.reviewMediaReply(agent.session.id, async state => {
      const evidence = state.evidence as Evidence;
      const incomplete = evidence.results.filter(result => result.incomplete);
      const draft = state.drafts.at(-1) ?? '';
      const explicitLimit = /(?:没|未|没有|尚未|不能|无法|并未)[^。！？\n]{0,18}(?:看完|听完|完整|覆盖|确认|解析)|仅(?:看|读|分析|处理)|只(?:看|读|分析|处理)|部分(?:片段|画面|内容)/u.test(draft);
      const claimsComplete = !explicitLimit && /(?:已经|已|都|全部|完整地?)?(?:看完|听完|完整观看|完整读完|完整听过)/u.test(draft);
      const hasVideoInspection = evidence.results.some(result => result.operations.includes('media.video.inspect') && !result.incomplete);
      const unsupportedVideoClaim = evidence.operations.includes('media.video.inspect') && !hasVideoInspection && claimsComplete;
      if (explicitLimit || (!incomplete.length && !unsupportedVideoClaim)) return { action: 'approve' };
      if (state.correctionRequested) {
        if (claimsComplete) return { action: 'replace', text: '本次媒体解析尚有未确认部分，不能据此称已完整看过或听过。' };
        return { action: 'approve' }; // bounded consistency check, not semantic certification
      }
      return { action: 'correct', instruction: '[媒体回复发送前核对]\n原稿尚未发送。根据本轮工具实际结果检查并重新输出最终答复：\n'
        + incomplete.flatMap(result => result.facts).join('；')
        + '\n不要把未解析的画面、未转写的音轨或未覆盖片段当作已读事实；历史笔记仅供背景参考。如果已明确说明这些限制，保持该说明即可，不必继续调用工具。只输出修订后的完整答复。' };
    }, 1500, signal);
    if (decision?.action === 'correct' && !signal.aborted) {
      if (!agent.steer) {
        this.warn('im-qqbot: media correction unavailable; keeping buffered fallback');
        return;
      }
      agent.steer(createUserMessage({ content: [{ type: 'text', text: decision.instruction }], source: QQBOT_MESSAGE_SOURCE }));
    }
  }

  ended(sessionId: string): void {
    const state = this.outbound.getMediaReviewState(sessionId);
    if (!state) return;
    try {
      mkdirSync(this.auditRoot, { recursive: true });
      const name = createHash('sha256').update(sessionId).digest('hex');
      const path = join(this.auditRoot, `${name}.json`);
      const temp = `${path}.${process.pid}.tmp`;
      writeFileSync(temp, JSON.stringify({ ...state, at: new Date().toISOString(),
        note: 'Buffered drafts are not evidence of QQ delivery; only transport delivery events confirm it.' }), { mode: 0o600 });
      renameSync(temp, path);
      writeFileSync(join(this.auditRoot, `${name}-${Date.now()}-${randomUUID()}.json`),
        JSON.stringify({ ...state, at: new Date().toISOString(), deliveryConfirmed: false }), { mode: 0o600 });
      this.outbound.clearMediaReview(sessionId);
      this.failedAudits.delete(sessionId);
    } catch {
      this.failedAudits.set(sessionId, state);
      while (this.failedAudits.size > 32) this.failedAudits.delete(this.failedAudits.keys().next().value!);
      this.warn('im-qqbot: media review audit failed; original draft retained in bounded diagnostic memory');
      try { this.outbound.clearMediaReview(sessionId); } catch { /* active auto-steer boundary: retain active gate */ }
    }
  }
}
