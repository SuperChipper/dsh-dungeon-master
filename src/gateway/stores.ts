/**
 * 网关持久存储初始化：表情收藏、共享笔记库、跑团服务
 */
import { existsSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import type { ImQQBotConfig } from '../config.ts';
import type { Logger } from '../types.ts';
import { PLUGIN_ROOT } from '../shared/index.ts';
import { qqbotLegacyMediaDir } from '../shared/paths.ts';
import { MEDIA_ROOT } from '../media/media-cleaner.ts';
import { StickerStore } from '../media/sticker-store.ts';
import { resolveTmpDir } from '../media/tmp-dir.ts';
import { NotesStore } from '../notes/notes-store.ts';
import { EmbeddingCache, createOpenAIEmbedder, resolveEmbeddingApiKey } from '../notes/embedding.ts';
import { CampaignStore } from '../dnd/campaign.ts';
import { AdventureLibrary } from '../dnd/adventure.ts';
import { DndService } from '../dnd/dnd-service.ts';

/** 解析表情包目录与允许来源，构建 StickerStore（关闭时返回 undefined） */
export function createStickerStore(config: ImQQBotConfig, logger: Logger): StickerStore | undefined {
  const stickers = config.stickers ?? {
    enabled: true,
    root: '',
    extraRoots: [],
    maxBytes: 8 * 1024 * 1024,
    maxAutoEntries: 200,
  };
  if (!stickers.enabled) return undefined;

  const configuredRoot = stickers.root.trim();
  const root = configuredRoot === ''
    ? resolve(PLUGIN_ROOT, 'stickers')
    : (isAbsolute(configuredRoot) ? configuredRoot : resolve(PLUGIN_ROOT, configuredRoot));

  const allowedRoots = [MEDIA_ROOT];
  // 兼容旧版 media 根目录（升级前下载的图片仍可被收藏）
  const legacyMediaRoot = qqbotLegacyMediaDir();
  if (existsSync(legacyMediaRoot)) allowedRoots.push(legacyMediaRoot);
  for (const extra of stickers.extraRoots) {
    if (extra.trim() === '') continue;
    allowedRoots.push(isAbsolute(extra) ? extra : resolve(PLUGIN_ROOT, extra));
  }

  const store = new StickerStore({
    root,
    allowedRoots,
    sensitivePaths: config.fileAccess?.sensitivePaths ?? [],
    maxBytes: stickers.maxBytes,
    maxAutoEntries: stickers.maxAutoEntries,
    logger,
  });
  logger.info(`im-qqbot: 表情收藏已启用 root=${store.root}`);
  return store;
}

/** 解析笔记目录，构建共享笔记库（关闭时返回 undefined）；默认放在 agent 工作目录下，不进插件仓库 */
export function createNotesStore(config: ImQQBotConfig, logger: Logger): NotesStore | undefined {
  const notes = config.notes;
  if (notes === undefined || !notes.enabled) return undefined;
  const cwd = config.cwd || process.cwd();
  const configuredRoot = notes.root.trim();
  const root = configuredRoot === ''
    ? resolve(cwd, 'notes')
    : (isAbsolute(configuredRoot) ? configuredRoot : resolve(cwd, configuredRoot));
  logger.info(`im-qqbot: 共享笔记库已启用 root=${root}`);
  const store = new NotesStore(root, logger);
  const semantic = notes.semantic;
  if (semantic?.enabled) {
    // 没密钥也照样挂上：baseUrl 可能指向不需要鉴权的本地服务（Ollama 等）；鉴权失败会进冷却、退回 BM25
    if (resolveEmbeddingApiKey(semantic) === '') logger.warn('im-qqbot: 笔记语义检索已启用但没有密钥（QQBOT_EMBEDDING_API_KEY），远程接口会拒绝请求');
    store.setSemantic(new EmbeddingCache(createOpenAIEmbedder(semantic), semantic.timeoutMs, logger), semantic);
    logger.info(`im-qqbot: 笔记语义检索已启用 model=${semantic.model} minSimilarity=${semantic.minSimilarity} minMargin=${semantic.minMargin}`);
  }
  return store;
}

/** 解析跑团目录，构建 DndService（关闭时返回 undefined）；数据放在 agent 工作目录下，不进插件仓库 */
export function createDndService(config: ImQQBotConfig, logger: Logger): DndService | undefined {
  const dnd = config.dnd;
  if (dnd === undefined || !dnd.enabled) return undefined;
  const cwd = config.cwd || process.cwd();
  const configuredRoot = dnd.root.trim();
  const root = configuredRoot === ''
    ? resolve(cwd, 'dnd')
    : (isAbsolute(configuredRoot) ? configuredRoot : resolve(cwd, configuredRoot));
  logger.info(`im-qqbot: 跑团已启用 root=${root}`);
  return new DndService({
    store: new CampaignStore(join(root, 'campaigns')),
    library: new AdventureLibrary({ dungeons: join(root, 'dungeons'), adventures: join(root, 'adventures') }, logger),
    mapDir: join(resolveTmpDir(config), 'dnd-maps'),
    cwd,
    latchFile: join(root, 'prompt-latch.json'),
  });
}
