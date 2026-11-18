import { describe, expect, it, vi } from 'vitest';
import { MediaReplyReviewBuffer } from './media-reply-review.ts';

const make = () => new MediaReplyReviewBuffer('s', { evidence: { status: 'incomplete' }, fallbackText: 'Media review is incomplete.' });

describe('MediaReplyReviewBuffer', () => {
  it('retains unapproved drafts and delivers fallback exactly once', () => {
    const buffer = make();
    buffer.append('I watched it.');
    expect(buffer.finish()).toEqual(['Media review is incomplete.']);
    expect(buffer.finish()).toEqual([]);
    expect(buffer.snapshot()).toMatchObject({ status: 'held', drafts: ['I watched it.'] });
  });

  it('approves or replaces without leaking the original draft', async () => {
    const buffer = make();
    buffer.append('unsupported');
    await buffer.review(async () => ({ action: 'replace', text: 'Only audio was available.' }));
    expect(buffer.finish()).toEqual(['Only audio was available.']);
    expect(buffer.snapshot().drafts).toEqual(['unsupported']);
  });

  it('allows one correction and requires new output before reviewing again', async () => {
    const buffer = make();
    buffer.append('unsupported');
    const reviewer = vi.fn(async () => ({ action: 'correct' as const, instruction: 'Correct the claim.' }));
    expect(await buffer.review(reviewer)).toMatchObject({ action: 'correct' });
    expect(await buffer.review(reviewer)).toBeUndefined();
    expect(reviewer).toHaveBeenCalledTimes(1);
    buffer.append('corrected');
    await buffer.review(async () => ({ action: 'approve' }));
    expect(buffer.finish()).toEqual(['corrected']);
  });

  it('prevents correction loops', async () => {
    const buffer = make();
    const reviewer = async () => ({ action: 'correct' as const, instruction: 'Again' });
    buffer.append('first');
    await buffer.review(reviewer);
    buffer.append('second');
    expect(await buffer.review(reviewer)).toBeUndefined();
    expect(buffer.finish()).toEqual(['Media review is incomplete.']);
  });

  it('bounds a hung reviewer and ignores its eventual approval', async () => {
    vi.useFakeTimers();
    try {
      const buffer = make();
      buffer.append('unsafe');
      let resolve!: (value: { action: 'approve' }) => void;
      const pending = buffer.review(async () => new Promise((r) => { resolve = r; }), 25);
      await vi.advanceTimersByTimeAsync(25);
      await pending;
      resolve({ action: 'approve' });
      await Promise.resolve();
      expect(buffer.snapshot()).toMatchObject({ status: 'held', reason: 'review-timeout' });
      expect(buffer.finish()).toEqual(['Media review is incomplete.']);
    } finally { vi.useRealTimers(); }
  });

  it('does not apply a stale decision to newly appended output', async () => {
    const buffer = make();
    buffer.append('old');
    let resolve!: (value: { action: 'approve' }) => void;
    const pending = buffer.review(async () => new Promise((r) => { resolve = r; }));
    await Promise.resolve();
    buffer.append('new');
    resolve({ action: 'approve' });
    expect(await pending).toBeUndefined();
    expect(buffer.finish()).toEqual(['Media review is incomplete.']);
  });

  it('requires fresh review when evidence changes after approval', async () => {
    const buffer = make();
    buffer.append('draft');
    await buffer.review(async () => ({ action: 'approve' }));
    buffer.updateEvidence({ status: 'failed' });
    expect(buffer.snapshot()).toMatchObject({ status: 'review-required', evidence: { status: 'failed' } });
    expect(buffer.finish()).toEqual(['Media review is incomplete.']);
  });

  it('fails closed on abort and reviewer exception without losing drafts', async () => {
    for (const aborted of [true, false]) {
      const buffer = make();
      buffer.append('original');
      const controller = new AbortController();
      if (aborted) controller.abort();
      await buffer.review(async () => { throw new Error('review failed'); }, 50, controller.signal);
      expect(buffer.snapshot().status).toBe('held');
      expect(buffer.snapshot().drafts).toEqual(['original']);
    }
  });
});
