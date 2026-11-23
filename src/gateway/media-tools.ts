/**
 * 网关内置媒体与扩展工具注册（视觉、视频、转写、文件发送、语音、生图、B 站、点歌、搜图、表情、笔记、历史）
 */
import type { Context } from '@deepseek-ai/cordis';
import { delimiter, dirname, isAbsolute, join, resolve } from 'node:path';
import type { ImQQBotConfig } from '../config.ts';
import type { SessionManager } from '../session/index.ts';
import type { Logger } from '../types.ts';
import { PLUGIN_ROOT } from '../shared/index.ts';
import { BiliClient } from '../bili/client.ts';
import { registerBiliTools } from '../bili/tools.ts';
import { biliPermission } from '../bili/permissions.ts';
import { registerFanartTool } from '../fanart/fanart-tool.ts';
import { createHttpGet } from '../fanart/http.ts';
import { FanartSeenStore, markSentCandidate } from '../fanart/seen.ts';
import { registerHistorySearchTool } from '../features/history-tool.ts';
import { MEDIA_ROOT } from '../media/media-cleaner.ts';
import { resolveTmpDir } from '../media/tmp-dir.ts';
import { ensureVisionInputModal, registerDescribeImageTool } from '../media/vision-tool.ts';
import { locateFfmpeg, registerDescribeVideoTool } from '../media/video-tool.ts';
import { registerTranscribeTool } from '../media/transcribe-tool.ts';
import { registerSendFileTool } from '../media/send-file-tool.ts';
import { registerSpeakTool } from '../media/speak-tool.ts';
import { registerImageGenTool } from '../media/image-gen-tool.ts';
import { registerSingTool } from '../media/sing-tool.ts';
import { registerStickerTool } from '../media/sticker-tool.ts';
import { registerReverseImageTool } from '../media/reverse-image-tool.ts';
import type { StickerStore } from '../media/sticker-store.ts';
import type { NotesStore } from '../notes/notes-store.ts';
import { registerNotesTools } from '../notes/notes-tools.ts';
import type { GatewaySenders } from './senders.ts';

export interface RegisterGatewayToolsDeps {
  ctx: Context;
  config: ImQQBotConfig;
  manager: SessionManager;
  senders: GatewaySenders;
  stickerStore?: StickerStore;
  notesStore?: NotesStore;
  logger: Logger;
}

/** 统一注册 qqbot 网关工具并探测/注入 ffmpeg 路径 */
export async function registerGatewayTools(deps: RegisterGatewayToolsDeps): Promise<void> {
  const { ctx, config, manager, senders, stickerStore, notesStore, logger } = deps;
  const { mediaSender, rawSendVoice, rememberMedia } = senders;

  // ── 视觉工具注册（qqbot_describe_image，原生优先 + dsh llm 兜底） ──
  ensureVisionInputModal(config.vision, logger);
  registerDescribeImageTool(ctx, config.vision, logger, {
    getFfmpegPath: () => manager.ffmpegPath,
  });

  // ── 视频理解工具（qqbot_describe_video：抽帧宫格 + 音轨 ASR；ffmpeg 不可用时跳过） ──
  // 先找 ffmpeg：winget 装的不在 PATH 里时，把它的目录补进本进程 PATH（终端工具会继承），并在 prompt 里点名路径
  const ffmpegBins = await locateFfmpeg(config.video.ffmpegPath);
  if (ffmpegBins !== undefined && isAbsolute(ffmpegBins.ffmpeg)) {
    const binDir = dirname(ffmpegBins.ffmpeg);
    const pathKey = Object.keys(process.env).find((k) => k.toUpperCase() === 'PATH') ?? 'PATH';
    const entries = (process.env[pathKey] ?? '').split(delimiter);
    if (!entries.some((e) => e.toLowerCase() === binDir.toLowerCase())) {
      process.env[pathKey] = [binDir, ...entries].filter(Boolean).join(delimiter);
    }
    manager.ffmpegPath = ffmpegBins.ffmpeg;
    logger.info(`im-qqbot: 使用 ffmpeg ${ffmpegBins.ffmpeg}（目录已补进 PATH）`);
  }
  await registerDescribeVideoTool(
    ctx,
    ffmpegBins !== undefined ? { ...config.video, ffmpegPath: ffmpegBins.ffmpeg === 'ffmpeg' ? '' : ffmpegBins.ffmpeg } : config.video,
    config.vision,
    config.asr,
    logger,
    resolveTmpDir(config),
  );

  // ── 听音频（qqbot_transcribe）：跟随 config.asr 协议/网关与 ffmpeg 路径 ──
  registerTranscribeTool(ctx, logger, config.asr, ffmpegBins);

  // ── 搜图工具（qqbot_fanart）：pick 候选落在 tmp/fanart，booru 单抽与发送去重共用 FanartSeenStore ──
  const fanartCandidatesDir = join(resolveTmpDir(config), 'fanart');
  const fanartSeen = new FanartSeenStore(join(MEDIA_ROOT, 'fanart'));
  if (config.fanart.enabled) {
    const poolDir = config.fanart.poolDir.trim();
    const fanartGet = createHttpGet(config.fanart.proxy);
    registerFanartTool(ctx, config, {
      get: fanartGet,
      seen: fanartSeen,
      poolDir: poolDir === '' ? resolve(PLUGIN_ROOT, 'scripts') : (isAbsolute(poolDir) ? poolDir : resolve(PLUGIN_ROOT, poolDir)),
      candidatesDir: fanartCandidatesDir,
    }, logger);
  }
  registerSendFileTool(ctx, mediaSender, manager, config, logger, (absPath) => {
    if (config.fanart.enabled && markSentCandidate(fanartSeen, fanartCandidatesDir, absPath)) {
      logger.info(`im-qqbot: 搜图候选已发，记为已发: ${absPath}`);
    }
  });

  // ── 语音合成工具注册（qqbot_speak） ──
  // 放在插件里而不是让模型自己跑命令：沙箱里联网要人审批，开一次口弹一次确认太出戏。
  if (config.speak.enabled) {
    registerSpeakTool(ctx, { sendVoice: rawSendVoice }, manager, config, logger, {
      onSent: (target, spoken, result) => rememberMedia(target, '语音', spoken)(result),
    });
  }

  // ── 生图与参考图编辑工具（qqbot_image_gen） ──
  if (config.imageGen?.enabled === true) {
    registerImageGenTool(ctx, mediaSender, manager, config, logger);
  }

  // ── Bilibili 只读工具（按 config.bili.enabled 显式开启） ──
  if (config.bili?.enabled === true) {
    const biliTools = ctx.get('tools') as { register(definition: unknown): unknown } | undefined;
    if (biliTools !== undefined) {
      const biliClient = new BiliClient();
      registerBiliTools(biliTools, {
        client: biliClient,
        logger,
        ffmpegPath: ffmpegBins !== undefined && isAbsolute(ffmpegBins.ffmpeg) ? ffmpegBins.ffmpeg : undefined,
        permission: (agent, kind = 'login') => biliPermission(
          manager.findByAgent(agent as never), kind, config,
        ),
        sendQr: async (agent, qrPath, caption) => {
          const record = manager.findByAgent(agent as never);
          if (record === undefined) return false;
          await mediaSender.sendImage(record.replyTarget, { localPath: qrPath }, { content: caption });
          return true;
        },
      });
    }
  }

  // ── 点歌（qqbot_sing，按 config.sing.enabled 显式开启） ──
  if (config.sing?.enabled === true) {
    registerSingTool(ctx, mediaSender, manager, logger, config.sing.baseUrl);
  }

  // ── 表情收藏工具注册（qqbot_sticker：收藏/匹配） ──
  if (stickerStore !== undefined) {
    registerStickerTool(ctx, stickerStore, logger);
  }

  // ── 以图搜图（trace.moe + SauceNAO，按 config.reverseImage.enabled 显式开启） ──
  if (config.reverseImage?.enabled === true) {
    registerReverseImageTool(ctx, logger);
  }

  // ── 共享笔记工具注册（qqbot_notes_search / qqbot_notes_save） ──
  if (notesStore !== undefined) {
    registerNotesTools(ctx, notesStore, manager, logger, { ownerOpenid: config.ownerOpenid });
  }

  // ── 历史归档检索（qqbot_history_search）：归档写得多、读得少，这里补一个查询口 ──
  registerHistorySearchTool(ctx, config.appId, manager, logger);
}
