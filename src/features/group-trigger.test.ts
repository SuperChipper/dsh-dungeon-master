import { describe, expect, it } from 'vitest';
import { resolveGroupTriggerMode, resolveGroupTriggerPolicy } from './group-trigger.ts';

describe('groupTriggerMode 策略解析', () => {
  it('显式 groupTriggerMode 覆盖历史分散开关', () => {
    expect(resolveGroupTriggerPolicy({
      groupTriggerMode: 'mention',
      requireMention: false,
      groupReplyProbability: 0.5,
      replyDesire: { enabled: true },
    })).toEqual({
      mode: 'mention',
      requireMentionInGroup: true,
      passthroughToDecider: false,
      implicitProbability: 0,
      replyDesireEnabled: false,
      requireMentionHint: true,
    });

    expect(resolveGroupTriggerPolicy({
      groupTriggerMode: 'probability',
      requireMention: false,
      groupReplyProbability: 0.25,
      replyDesire: { enabled: true },
    })).toEqual({
      mode: 'probability',
      requireMentionInGroup: true,
      passthroughToDecider: false,
      implicitProbability: 0.25,
      replyDesireEnabled: false,
      requireMentionHint: true,
    });

    expect(resolveGroupTriggerPolicy({
      groupTriggerMode: 'desire',
      requireMention: true,
      groupReplyProbability: 0.8,
      replyDesire: { enabled: false },
    })).toEqual({
      mode: 'desire',
      requireMentionInGroup: true,
      passthroughToDecider: true,
      implicitProbability: 0,
      replyDesireEnabled: true,
      requireMentionHint: true,
    });

    expect(resolveGroupTriggerPolicy({
      groupTriggerMode: 'all',
      requireMention: true,
      groupReplyProbability: 0.3,
      replyDesire: { enabled: true },
    })).toEqual({
      mode: 'all',
      requireMentionInGroup: false,
      passthroughToDecider: false,
      implicitProbability: 0,
      replyDesireEnabled: false,
      requireMentionHint: false,
    });
  });

  it('未设置 groupTriggerMode 时兼容存量 requireMention / replyDesire / groupReplyProbability', () => {
    expect(resolveGroupTriggerMode({ requireMention: false })).toBe('all');
    expect(resolveGroupTriggerMode({ requireMention: false, replyDesire: { enabled: true } })).toBe('all');
    expect(resolveGroupTriggerMode({ requireMention: true, replyDesire: { enabled: true } })).toBe('desire');
    expect(resolveGroupTriggerMode({ requireMention: true, groupReplyProbability: 0.15 })).toBe('probability');
    expect(resolveGroupTriggerMode({ requireMention: true, groupReplyProbability: 0 })).toBe('mention');
    expect(resolveGroupTriggerMode({})).toBe('mention');
  });
});
