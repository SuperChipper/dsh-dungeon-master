export type MediaReviewDecision =
  | { action: 'approve' }
  | { action: 'replace'; text: string }
  | { action: 'correct'; instruction: string };

export interface MediaReplyReviewState {
  readonly sessionId: string;
  readonly evidence: unknown;
  readonly drafts: readonly string[];
  readonly status: 'collecting' | 'review-required' | 'correction-requested' | 'approved' | 'replaced' | 'held';
  readonly correctionRequested: boolean;
  readonly reason?: string;
}

export interface ArmMediaReplyReview {
  /** Must be armed before any assistant stream or message in this turn. */
  evidence: unknown;
  /** Visible, evidence-neutral response used when review cannot approve the draft. */
  fallbackText: string;
}

export type MediaReplyReviewer = (state: MediaReplyReviewState, signal: AbortSignal) => Promise<MediaReviewDecision>;

/** No host dependencies: the owner supplies evidence and performs any returned steering. */
export class MediaReplyReviewBuffer {
  private drafts: string[] = [];
  private status: MediaReplyReviewState['status'] = 'collecting';
  private correctionRequested = false;
  private correctionStart = 0;
  private reason: string | undefined;
  private output: string[] | undefined;
  private reviewing: Promise<MediaReviewDecision | undefined> | undefined;
  private revision = 0;

  public constructor(public readonly sessionId: string, private readonly options: ArmMediaReplyReview) {
    if (!options.fallbackText.trim()) throw new Error('Media review requires nonempty fallbackText');
  }

  public updateEvidence(evidence: unknown): void {
    this.options.evidence = evidence;
    this.revision++;
    this.output = undefined;
    if (this.drafts.length > 0) this.status = 'review-required';
  }

  public snapshot(): MediaReplyReviewState {
    return {
      sessionId: this.sessionId, evidence: this.options.evidence, drafts: [...this.drafts],
      status: this.status, correctionRequested: this.correctionRequested,
      ...(this.reason ? { reason: this.reason } : {}),
    };
  }

  public append(text: string): void {
    if (!text.trim()) return;
    this.output = undefined;
    this.drafts.push(text);
    this.revision++;
    this.status = 'review-required';
  }

  public review(reviewer: MediaReplyReviewer, timeoutMs = 3000, signal?: AbortSignal): Promise<MediaReviewDecision | undefined> {
    if (this.reviewing) return this.reviewing;
    if (this.output !== undefined || this.status === 'held' || this.status === 'correction-requested' || this.drafts.length === 0) return Promise.resolve(undefined);
    if (this.correctionRequested && this.drafts.length <= this.correctionStart) return Promise.resolve(undefined);
    const revision = this.revision;
    this.reviewing = this.runReview(reviewer, Math.max(1, Math.min(timeoutMs, 30_000)), signal, revision)
      .finally(() => { this.reviewing = undefined; });
    return this.reviewing;
  }

  private async runReview(reviewer: MediaReplyReviewer, timeout: number, signal: AbortSignal | undefined, revision: number): Promise<MediaReviewDecision | undefined> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let abort: (() => void) | undefined;
    try {
      const stopped = new Promise<never>((_, reject) => {
        abort = () => { controller.abort(); reject(new Error('review-aborted')); };
        signal?.addEventListener('abort', abort, { once: true });
        timer = setTimeout(() => { controller.abort(); reject(new Error('review-timeout')); }, timeout);
        if (signal?.aborted) abort();
      });
      const decision = await Promise.race([Promise.resolve().then(() => reviewer(this.snapshot(), controller.signal)), stopped]);
      if (revision !== this.revision || this.output !== undefined || this.status === 'held') return undefined;
      if (decision.action === 'correct' && !this.correctionRequested && decision.instruction.trim()) {
        this.correctionRequested = true;
        this.correctionStart = this.drafts.length;
        this.status = 'correction-requested';
        return decision;
      }
      if (decision.action === 'approve') {
        // After a correction, only the new step is deliverable; earlier drafts remain inspectable.
        this.output = this.correctionRequested ? this.drafts.slice(this.correctionStart) : [...this.drafts];
        this.status = 'approved';
      } else if (decision.action === 'replace' && decision.text.trim()) {
        this.output = [decision.text];
        this.status = 'replaced';
      } else {
        this.hold('correction-limit-or-invalid-decision');
        return undefined;
      }
      return decision;
    } catch (error) {
      if (revision === this.revision && this.output === undefined) this.hold(error instanceof Error ? error.message : 'review-failed');
      return undefined;
    } finally {
      if (timer) clearTimeout(timer);
      if (abort) signal?.removeEventListener('abort', abort);
      controller.abort();
    }
  }

  private hold(reason: string): void {
    this.status = 'held';
    this.reason = reason;
  }

  /** Exactly one delivery. Unapproved originals stay available to persistence/event-memory hooks. */
  public finish(): readonly string[] {
    if (this.status === 'collecting' && this.drafts.length === 0) return [];
    if (this.output === undefined) {
      this.hold(this.reason ?? 'turn-ended-without-approval');
      this.output = [this.options.fallbackText];
    }
    const output = this.output;
    this.output = [];
    return output;
  }
}
