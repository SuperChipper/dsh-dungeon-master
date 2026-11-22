/**
 * L1 高内聚统一表情工具 — qqbot_sticker。
 *
 * 将原来的 `qqbot_save_sticker`（情绪触发入库）和 `qqbot_match_sticker`
 * （按 SHA-256 查找本地表情库）按 `action` 收口为单工具，复用同一套 StickerStore。
 */
import type { Context } from '@deepseek-ai/cordis';
import type { ContentBlock } from '@deepseek-ai/dsh-llm';
import type { Logger } from '../types.ts';
import { StickerStore, type SaveStickerResult } from './sticker-store.ts';

export const STICKER_TOOL_NAME = 'qqbot_sticker';

const DESCRIPTION =
  'Manage and look up your own sticker/meme collection. '
  + 'action="save": save a user-sent image when it genuinely captures a mood you would reuse later (deduplicates by SHA-256, updates stickers/index.json; never write <qqbot_sticker> or <qqbot_save_sticker> tags in reply text). '
  + 'If you also want to reply after saving, call this tool first with empty text and write the reply after the result. '
  + 'action="match": read-only SHA-256 lookup against your sticker library for quoted/earlier/downloaded images outside the current message (current-message images are already matched on arrival).';

interface ToolsRegistryLike {
  register(definition: unknown): unknown;
}

interface StickerArgs {
  action: 'save' | 'match';
  image: string;
  emotion?: string;
  look?: string;
  note?: string;
  file?: string;
}

interface MatchStickerOutput {
  matched: boolean;
  file?: string;
  emotion?: string;
  note?: string;
  bytes?: number;
  total?: number;
  message: string;
}

export function registerStickerTool(
  ctx: Context,
  store: StickerStore,
  logger: Logger,
): void {
  const tools = ctx.get('tools') as ToolsRegistryLike | undefined;
  if (!tools?.register) {
    logger.warn(`im-qqbot: tools 服务不可用，${STICKER_TOOL_NAME} 工具未注册`);
    return;
  }

  tools.register({
    name: STICKER_TOOL_NAME,
    description: DESCRIPTION,
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['save', 'match'],
          description: '"save" to add an image to your sticker collection; "match" to check whether an image is already in it.',
        },
        image: {
          type: 'string',
          description: "Absolute local path of the image; copy it from the user message's `- Image:` line.",
        },
        emotion: {
          type: 'string',
          description: '(action="save" required) Your own mood/reaction at this moment as a short label (e.g. 破防, 被萌到, 无语, 骄傲).',
        },
        look: {
          type: 'string',
          description: '(action="save" required) What the image actually shows in a short Chinese phrase (at most 40 chars).',
        },
        note: {
          type: 'string',
          description: '(action="save") Optional one-sentence reason why this sticker is worth keeping.',
        },
        file: {
          type: 'string',
          description: '(action="save") Optional preferred file name (e.g. fish_破防.png). Omit to derive from emotion.',
        },
      },
      required: ['action', 'image'],
      additionalProperties: false,
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args: unknown, value: unknown): ContentBlock[] => [
        { type: 'text', text: (value as SaveStickerResult | MatchStickerOutput).message },
      ],
    },
    async execute(args: unknown): Promise<SaveStickerResult | MatchStickerOutput> {
      const { action, image, emotion, look, note, file } = (args ?? {}) as Partial<StickerArgs>;
      if (action !== 'save' && action !== 'match') {
        throw new Error('qqbot_sticker: `action` 必须是 "save" 或 "match"');
      }
      if (typeof image !== 'string' || image.trim().length === 0) {
        throw new Error('qqbot_sticker: `image` 必须是图片绝对路径');
      }

      if (action === 'match') {
        const match = store.match(image.trim());
        if (match === undefined) {
          return {
            matched: false,
            message: '表情库里没有完全相同的图片。先自己看图读出文字和模板（看不到原图或文字太小时再用 qqbot_describe_image），再用 web_search 查梗。',
          };
        }
        const extraNote = match.note !== undefined ? `；备注：${match.note}` : '';
        return {
          matched: true,
          file: match.file,
          emotion: match.emotion,
          ...(match.note !== undefined ? { note: match.note } : {}),
          bytes: match.bytes,
          total: match.total,
          message: `表情库命中「${match.emotion}」→ ${match.file}（${match.bytes} bytes，共 ${match.total} 条${extraNote}）。可用 qqbot_send_file 发出，或直接用这个情绪回应。`,
        };
      }

      if (typeof emotion !== 'string' || emotion.trim().length === 0) {
        throw new Error('qqbot_sticker: action="save" 时 `emotion` 必须是你此刻的情绪标签');
      }
      if (typeof look !== 'string' || look.trim().length === 0) {
        throw new Error('qqbot_sticker: action="save" 时 `look` 必须写清图里实际画的是什么');
      }
      return store.save({
        source: image,
        emotion,
        look,
        ...(typeof note === 'string' ? { note } : {}),
        ...(typeof file === 'string' ? { file } : {}),
      });
    },
  });

  logger.info(`im-qqbot: ${STICKER_TOOL_NAME} 工具已注册`);
}
