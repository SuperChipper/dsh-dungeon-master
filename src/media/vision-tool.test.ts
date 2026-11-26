import { describe, expect, it } from 'vitest';
import type { VisionConfig } from '../config.ts';
import { callVision, type LlmRuntimeLike } from './vision-tool.ts';

describe('callVision', () => {
  const baseVision: VisionConfig = {
    enabled: true,
    native: false,
    provider: 'test-provider',
    model: 'test-vision',
    defaultPrompt: 'describe',
    maxBytes: 1024 * 1024,
    maxTokens: 256,
    timeoutMs: 30,
  };

  const fakeImageRef = {
    id: 'att-1',
    mediaType: 'image/png',
    byteLength: 16,
  } as unknown as Parameters<typeof callVision>[3];

  it('尊重 vision.timeoutMs，超时时通过 AbortSignal 中断底层视觉请求', async () => {
    let observedAborted = false;
    const llm: LlmRuntimeLike = {
      async *stream(options) {
        await new Promise<void>((_resolve, reject) => {
          const onAbort = () => {
            observedAborted = true;
            reject(options.signal?.reason ?? new Error('aborted'));
          };
          if (options.signal?.aborted) {
            onAbort();
            return;
          }
          options.signal?.addEventListener('abort', onAbort, { once: true });
        });
        yield { type: 'finish', reason: { kind: 'stop' } };
      },
    };

    await expect(
      callVision(llm, baseVision, 'what is this?', fakeImageRef, new AbortController().signal),
    ).rejects.toThrow();
    expect(observedAborted).toBe(true);
  });
});
