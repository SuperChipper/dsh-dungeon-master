import { describe, it, expect, vi } from 'vitest';
import { boundedRecall, inboundOperations, noteRevisionKey, operationQueryTerms, RecallTurnState, toolOperationEvidence } from './operation-recall.ts';

describe('operation recall', () => {
  it('detects media without requiring model names and keeps ordinary chat empty', () => {
    expect(inboundOperations('https://b23.tv/example', [])).toContain('media.video.inspect');
    expect(inboundOperations('你好', [])).toEqual([]);
    expect(inboundOperations('这是谁', ['image'])).toEqual(['media.image.inspect', 'media.image.origin']);
    expect(operationQueryTerms(['media.video.inspect'])).toContain('视频');
  });
  it('uses media text for content recall, not arbitrary shell or tool arguments', () => {
    expect(toolOperationEvidence('pwsh', { value: { text: 'private' } })).toBeUndefined();
    const evidence = toolOperationEvidence('qqbot_describe_video', { value: { text: '鲸娘拿Claude工牌', transcribed: true } });
    expect(evidence?.query).toContain('Claude');
    expect(evidence?.incomplete).toBe(false);
  });
  it('classifies errors without copying secret-bearing raw diagnostics', () => {
    const evidence = toolOperationEvidence('qqbot_transcribe', { isError: true, error: { message: '缺少凭证 fake-secret', code: 'ERR' } });
    expect(evidence?.operations).toContain('credentials.resolve.missing');
    expect(JSON.stringify(evidence)).not.toContain('fake-secret');
  });
  it('partial, truncated and missing speech retain coverage facts', () => {
    const evidence = toolOperationEvidence('qqbot_describe_video', { value: { partial: true, analyzedStart: 0, analyzedEnd: 30, transcribed: false } });
    expect(evidence?.incomplete).toBe(true);
    expect(evidence?.facts.join(' ')).toContain('0–30秒');
  });
  it('content revision changes dedup identity', () => {
    expect(noteRevisionKey({ file: 'a', heading: 'b', text: 'one' })).not.toBe(noteRevisionKey({ file: 'a', heading: 'b', text: 'two' }));
  });
  it('serializes concurrent recall commits and continues after failure', async () => {
    const state = new RecallTurnState('q', []); const order: number[] = [];
    const a = state.serialize(async () => { order.push(1); throw new Error('x'); });
    const b = state.serialize(async () => { order.push(2); });
    await expect(a).rejects.toThrow('x'); await b;
    expect(order).toEqual([1, 2]);
  });
  it('bounded read returns no late content and aborts promptly', async () => {
    vi.useFakeTimers();
    try {
      const result = boundedRecall(new Promise<string>(() => {}), 10);
      await vi.advanceTimersByTimeAsync(10); expect(await result).toBeUndefined();
      const abort = new AbortController();
      const pending = boundedRecall(new Promise<string>(() => {}), 1000, abort.signal);
      abort.abort(); expect(await pending).toBeUndefined();
    } finally { vi.useRealTimers(); }
  });
});
