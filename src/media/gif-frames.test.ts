import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { countGifFrames, isGifBytes } from './gif-sheet.ts';

const ANIMATED_GIF = 'C:/Users/16257/Desktop/Dsh-bot/dsh-qqbot/media/1BFB1482D2721A67B8B3E2EB5E667049_1795616829062_366b13c9.gif';
const STATIC_PNG = 'C:/Users/16257/Desktop/Dsh-bot/dsh-qqbot/stickers/cat_骑肥龙.png';

describe('countGifFrames', () => {
  it('counts graphic-control blocks in a real animated gif', () => {
    const bytes = readFileSync(ANIMATED_GIF);
    expect(isGifBytes(bytes)).toBe(true);
    // ffprobe 同一文件报 36 帧，字节口径应与之一致
    expect(countGifFrames(bytes)).toBe(36);
  });

  it('returns 0 for non-gif input', () => {
    expect(countGifFrames(readFileSync(STATIC_PNG))).toBe(0);
    expect(countGifFrames(Uint8Array.from([0x47, 0x49, 0x46]))).toBe(0);
  });
});
