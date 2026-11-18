import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { MediaReviewCoordinator } from './media-review-coordinator.ts';
import { MediaReplyReviewBuffer, type ArmMediaReplyReview, type MediaReplyReviewer } from './media-reply-review.ts';
import type { OutboundHandlers } from '../transport/outbound.ts';
import type { DshAgent } from '../session/types.ts';
import type { OperationEvidence } from '../notes/operation-recall.ts';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const sessionId = 'media-session';
const evidence = (incomplete = false): OperationEvidence => ({
  operations: ['media.video.inspect'], query: 'Detailed tool text', media: true, incomplete,
  facts: incomplete ? ['实际覆盖:0–20秒', '音轨未转写'] : ['结果:成功'],
});

function setup(options: { noSteer?: boolean; auditRoot?: string } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'qqbot-media-coordinator-'));
  roots.push(root);
  const buffers = new Map<string, MediaReplyReviewBuffer>();
  const armMediaReview = vi.fn((id: string, options: ArmMediaReplyReview) => {
    buffers.set(id, new MediaReplyReviewBuffer(id, options));
  });
  const clearMediaReview = vi.fn((id: string) => { buffers.delete(id); });
  const outbound = {
    armMediaReview,
    getMediaReviewState: (id: string) => buffers.get(id)?.snapshot(),
    updateMediaReviewEvidence: (id: string, value: unknown) => buffers.get(id)?.updateEvidence(value),
    reviewMediaReply: (id: string, reviewer: MediaReplyReviewer, timeout?: number, signal?: AbortSignal) =>
      buffers.get(id)?.review(reviewer, timeout, signal) ?? Promise.resolve(undefined),
    clearMediaReview,
    routeSessionEvent: vi.fn(), routeStreamFrame: vi.fn(),
  } satisfies OutboundHandlers;
  const steer = vi.fn();
  const agent = { id: 'different-agent-id', session: { id: sessionId }, ...(options.noSteer ? {} : { steer }) } as unknown as DshAgent;
  const warn = vi.fn();
  const coordinator = new MediaReviewCoordinator(outbound, warn, options.auditRoot ?? root);
  const auditPath = join(root, `${createHash('sha256').update(sessionId).digest('hex')}.json`);
  return { root, buffers, outbound, agent, steer, warn, coordinator, auditPath,
    buffer: () => buffers.get(sessionId)!, signal: new AbortController().signal };
}

describe('MediaReviewCoordinator', () => {
  it('does not arm ordinary chat or unrelated operations', () => {
    const { coordinator, agent, outbound } = setup();
    coordinator.arm(agent, []);
    coordinator.arm(agent, ['credentials.resolve.missing', 'notes.search']);
    expect(outbound.armMediaReview).not.toHaveBeenCalled();
  });

  it('logs a late-arm transport rejection without crashing or creating a gate', () => {
    const { coordinator, agent, outbound, warn, buffers } = setup();
    outbound.armMediaReview.mockImplementation(() => { throw new Error('Media review must be armed before assistant output'); });
    expect(() => coordinator.arm(agent, ['media.video.inspect'])).not.toThrow();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('after output began'));
    expect(buffers.size).toBe(0);
  });

  it('arms media once using session identity and preserves the active turn on steer', () => {
    const { coordinator, agent, outbound, buffer } = setup();
    coordinator.arm(agent, ['media.video.inspect']);
    buffer().append('original draft');
    coordinator.arm(agent, ['media.audio.transcribe']);
    expect(outbound.armMediaReview).toHaveBeenCalledTimes(1);
    expect(outbound.armMediaReview).toHaveBeenCalledWith(sessionId, expect.objectContaining({
      evidence: { operations: ['media.video.inspect'], results: [] }, fallbackText: expect.any(String),
    }));
    expect(buffer().snapshot().drafts).toEqual(['original draft']);
  });

  it('approves native images with no tool path without manufacturing an incomplete-media claim', async () => {
    const { coordinator, agent, buffer, steer, signal } = setup();
    coordinator.arm(agent, ['media.image.inspect']);
    buffer().append('A native-image response.');
    await coordinator.stopping(agent, signal);
    expect(steer).not.toHaveBeenCalled();
    expect(buffer().snapshot().status).toBe('approved');
    expect(buffer().finish()).toEqual(['A native-image response.']);
  });

  it('approves completed tool evidence directly', async () => {
    const { coordinator, agent, buffer, steer, signal } = setup();
    coordinator.arm(agent, ['media.video.inspect']);
    coordinator.observe(agent, evidence());
    buffer().append('Completed media response.');
    await coordinator.stopping(agent, signal);
    expect(steer).not.toHaveBeenCalled();
    expect(buffer().finish()).toEqual(['Completed media response.']);
  });

  it.each(['没看完视频，只分析了前二十秒。', '尚未完整解析，音轨也没有听完。', '没有看完整个视频。'])('approves explicit limitation unchanged: %s', async draft => {
    const { coordinator, agent, buffer, steer, signal } = setup();
    coordinator.arm(agent, ['media.video.inspect']);
    coordinator.observe(agent, evidence(true));
    buffer().append(draft);
    await coordinator.stopping(agent, signal);
    expect(steer).not.toHaveBeenCalled();
    expect(buffer().snapshot().status).toBe('approved');
    expect(buffer().snapshot().correctionRequested).toBe(false);
    expect(buffer().finish()).toEqual([draft]);
  });

  it('steers once for partial evidence and delivers only the corrected output', async () => {
    const { coordinator, agent, buffer, steer, signal } = setup();
    coordinator.arm(agent, ['media.video.inspect']);
    coordinator.observe(agent, evidence(true));
    buffer().append('I watched the entire video.');
    await coordinator.stopping(agent, signal);
    expect(steer).toHaveBeenCalledTimes(1);
    const message = JSON.stringify(steer.mock.calls[0]?.[0]);
    expect(message).toContain('实际覆盖:0–20秒');
    expect(message).toContain('音轨未转写');
    expect(buffer().snapshot().status).toBe('correction-requested');
    await coordinator.stopping(agent, signal);
    expect(steer).toHaveBeenCalledTimes(1);
    buffer().append('Only the first twenty seconds were analyzed; the audio was not transcribed.');
    await coordinator.stopping(agent, signal);
    expect(steer).toHaveBeenCalledTimes(1);
    expect(buffer().finish()).toEqual(['Only the first twenty seconds were analyzed; the audio was not transcribed.']);
    expect(buffer().snapshot().drafts).toHaveLength(2);
  });

  it('retains the original and uses fallback when correction steering is unavailable', async () => {
    const { coordinator, agent, buffer, warn, signal } = setup({ noSteer: true });
    coordinator.arm(agent, ['media.video.inspect']);
    coordinator.observe(agent, evidence(true));
    buffer().append('unsupported original');
    await coordinator.stopping(agent, signal);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('correction unavailable'));
    const output = buffer().finish();
    expect(output).toHaveLength(1);
    expect(output).not.toContain('unsupported original');
    expect(buffer().snapshot()).toMatchObject({ status: 'held', drafts: ['unsupported original'] });
  });

  it('passes aborted stopping through without steering or releasing the original', async () => {
    const { coordinator, agent, buffer, steer } = setup();
    coordinator.arm(agent, ['media.video.inspect']);
    coordinator.observe(agent, evidence(true));
    buffer().append('unsupported original');
    const controller = new AbortController();
    controller.abort();
    await coordinator.stopping(agent, controller.signal);
    expect(steer).not.toHaveBeenCalled();
    expect(buffer().snapshot()).toMatchObject({ status: 'held', reason: 'review-aborted' });
    expect(buffer().finish()).not.toContain('unsupported original');
  });

  it('retains only the latest evidence for a retried operation', () => {
    const { coordinator, agent, buffer } = setup();
    coordinator.arm(agent, ['media.video.inspect']);
    coordinator.observe(agent, evidence(true));
    for (let i = 0; i < 20; i++) coordinator.observe(agent, { ...evidence(), facts: [String(i)] });
    const stored = buffer().snapshot().evidence as { results: OperationEvidence[] };
    expect(stored.results).toHaveLength(1);
    expect(stored.results[0]).toMatchObject({ facts: ['19'], incomplete: false, query: '' });
  });

  it('bounds stored results and omits detailed tool query text', () => {
    const { coordinator, agent, buffer } = setup();
    coordinator.observe(agent, evidence(true));
    coordinator.arm(agent, ['media.video.inspect']);
    for (let i = 0; i < 20; i++) coordinator.observe(agent, { ...evidence(), operations: [`media.test.${i}`], facts: [String(i)] });
    const stored = buffer().snapshot().evidence as { results: OperationEvidence[] };
    expect(stored.results).toHaveLength(16);
    expect(stored.results[0]?.facts).toEqual(['4']);
    expect(stored.results.every(result => result.query === '')).toBe(true);
  });

  it('persists the original audit atomically before clearing the buffer', () => {
    const { coordinator, agent, buffer, outbound, auditPath, buffers } = setup();
    coordinator.arm(agent, ['media.video.inspect']);
    buffer().append('unapproved original');
    buffer().finish();
    outbound.clearMediaReview.mockImplementation((id: string) => {
      const audit = JSON.parse(readFileSync(auditPath, 'utf8'));
      expect(audit).toMatchObject({ sessionId, status: 'held', drafts: ['unapproved original'] });
      expect(audit.at).toEqual(expect.any(String));
      expect(audit.note).toContain('not evidence of QQ delivery');
      buffers.delete(id);
    });
    coordinator.ended(sessionId);
    expect(outbound.clearMediaReview).toHaveBeenCalledExactlyOnceWith(sessionId);
    expect(buffers.has(sessionId)).toBe(false);
  });

  it('retains failed audit diagnostics while clearing the active gate for the next turn', () => {
    const { root, agent, buffer, outbound, warn, buffers } = setup();
    const notDirectory = join(root, 'not-a-directory');
    writeFileSync(notDirectory, 'block mkdir');
    const coordinator = new MediaReviewCoordinator(outbound, warn, notDirectory);
    coordinator.arm(agent, ['media.image.inspect']);
    buffer().append('retained original');
    buffer().finish();
    coordinator.ended(sessionId);
    expect(outbound.clearMediaReview).toHaveBeenCalledExactlyOnceWith(sessionId);
    expect(buffers.has(sessionId)).toBe(false);
    expect(coordinator.retainedAudit(sessionId)).toMatchObject({ status: 'held', drafts: ['retained original'] });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('bounded diagnostic memory'));
    coordinator.arm(agent, ['media.image.inspect']);
    expect(outbound.armMediaReview).toHaveBeenCalledTimes(2);
    expect(buffer().snapshot()).toMatchObject({ status: 'collecting', drafts: [] });
    expect(coordinator.retainedAudit(sessionId)).toMatchObject({ drafts: ['retained original'] });
  });

  it('preserves separate historical audits for two turns of the same session', () => {
    const { root, coordinator, agent, buffer, auditPath } = setup();
    for (const draft of ['first held draft', 'second held draft']) {
      coordinator.arm(agent, ['media.image.inspect']);
      buffer().append(draft);
      buffer().finish();
      coordinator.ended(sessionId);
    }
    const prefix = createHash('sha256').update(sessionId).digest('hex');
    const histories = readdirSync(root).filter(name => name.startsWith(`${prefix}-`) && name.endsWith('.json'));
    expect(histories).toHaveLength(2);
    const audits = histories.map(name => JSON.parse(readFileSync(join(root, name), 'utf8')));
    expect(audits.map(audit => audit.drafts[0]).sort()).toEqual(['first held draft', 'second held draft']);
    expect(audits.every(audit => audit.deliveryConfirmed === false)).toBe(true);
    expect(JSON.parse(readFileSync(auditPath, 'utf8')).drafts).toEqual(['second held draft']);
    expect(coordinator.retainedAudit(sessionId)).toBeUndefined();
  });

  it('does not write or clear an absent review', () => {
    const { coordinator, outbound, warn } = setup();
    coordinator.ended('ordinary-chat-session');
    expect(outbound.clearMediaReview).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });
});
