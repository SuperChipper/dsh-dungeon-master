# DSH Dungeon Master

**[English](./README_EN.md) | 简体中文** ｜ **[🤖 Agent 安装与版本迁移指引](./docs/AGENT_GUIDE.md)**

**在 QQ 群里跑 D&D 5e 的 AI 地下城主。** 本项目基于 [tencent-connect/dsh-qqbot](https://github.com/tencent-connect/dsh-qqbot) 二次开发：群里发一句 `/dnd start`，bot 即成为该群 DM——掷骰、检定、先攻、站位、反应与血量全由确定性工具结算，模型专注叙事。

基础扫码绑定、通用配置项与整体架构详见 **[上游 README](https://github.com/tencent-connect/dsh-qqbot#readme)**。请勿在同一 profile 中同时启用 `@tencent-connect/dsh-qqbot`（共用 `im-qqbot` 插件 ID）。

---

## 快速开始

### 1. 安装与运行

#### 方式一：复制 Prompt 交给 AI Agent 安装或升级（推荐）

把下面这段直接发给你的 AI 助手（DSH / Claude Code / Antigravity / Codex）：

```text
请帮我在本地安装或升级 DSH 插件 dsh-dungeon-master（插件 ID：im-qqbot）：
1. 先阅读本仓库的 docs/AGENT_GUIDE.md；如果当前目录还没有该文件，请在安装后读取 node_modules/dsh-dungeon-master/docs/AGENT_GUIDE.md，或先查看 https://github.com/SuperChipper/dsh-dungeon-master/blob/main/docs/AGENT_GUIDE.md，严格遵守其中的操作红线。
2. 向我确认要使用的 DSH profile（未指定时默认 web），检查 Node（>= 20.3.0）与 dsh 版本；如发现同一 profile 已装过冲突包 @tencent-connect/dsh-qqbot，先备份 ~/.dsh/profiles/<profile>/cordis.patch.yml 再平滑卸载旧包并保留已有凭据。
3. 执行安装或升级（npm：dsh plugin --profile <profile> add dsh-dungeon-master；源码模式请先构建再挂载）。若我是从 0.8.x 升级到 0.9.0，请按 AGENT_GUIDE 的 5 项迁移检查表逐项核对我的 cordis.patch.yml，修改前必须先备份，且只用 YAML 解析器合并 im-qqbot 条目。
4. 绝不在聊天或日志中回显 appSecret、apiKey 或私人 voice_id；也不要编造未确认的第三方网关、模型 ID 或 Key 环境变量名。
5. 完成后提醒我重启一次 dsh 进程以加载新版后端代码，并引导我打开 DSH Web「插件 → QQ 机器人」安全扫码绑定，用 /bot-me、/bot-doctor 和 /dnd start 完成验收。
```

完整迁移细则见 **[`docs/AGENT_GUIDE.md`](./docs/AGENT_GUIDE.md)**（已随 npm 包附带）。

#### 方式二：手动命令行安装

```bash
# 从 npm 安装（推荐）
dsh plugin --profile web add dsh-dungeon-master

# 或从本地源码构建并挂载
pnpm install && pnpm build
npx @deepseek-ai/dsh plugin --profile qqbot add /path/to/dsh-dungeon-master
npx @deepseek-ai/dsh --profile qqbot
```

> **强烈建议默认启用 PTC（Programmatic Tool Calling / Code 模式）**
>
> D&D 跑团过程中工具调用非常密集（查卡、寻路、多连击/群体豁免、扣资源、管理持续区域等）。在宿主 DSH 中默认开启 PTC（如启用 `@deepseek-ai/dsh-tool-executor-ptc` 或对应 Code 模式配置），可让模型在单次脚本执行中批量编排多步 `dnd_*` 调用，显著减少工具往返轮次、响应延迟与上下文开销。

- **运行要求**：`Node >= 20.3.0`，`DSH >= 0.1.0-rc.6 <1.0.0`（已验证 `0.1.0-rc.8`、`0.2.0-rc.2`、`0.2.1-rc.5`、`0.2.2-rc.5`）。
- **可选依赖**：安装 `sharp` 启用 PNG 战棋地图与迷雾地图；视频工具依赖系统 `ffmpeg` / `ffprobe`。
- **升级与重载注意**：升级插件包或修改源码并 `pnpm build` 后，**请重启 `dsh` 进程**（仅刷新浏览器只会更新前端面板，重载 profile 不会刷新 Node ESM 缓存里的后端代码）。

### 2. 三步开团

1. 运行 `dsh plugin --profile web add dsh-dungeon-master`，打开 DSH Web「插件 → QQ 机器人」扫码绑定（或填好 AppID / AppSecret）。
2. 把机器人拉入 QQ 群；如需管理权限、审批卡片或主人私聊全权限，给机器人发 `/bot-me` 拿到自己的 `openid`，填入设置页「主人 openid」。
3. 群内发 `/dnd start`（自带签到按钮，人齐自动开场，也可点「开始」提前进场），随后直接 `@bot` 描述角色行动（如「卡厄斯用巨剑砍地精 3」「恩佐潜行到门口听动静」）。

全程无需切换 preset 或另开会话；开团期间自动注入「DM 守则 + 精简团况」，`/dnd end` 后原子停团并恢复普通聊天。

---

## 🎲 跑团

### 核心设计

- **裁定走工具，秘密不泄底**：HP、检定、豁免、站位与资源仅经 `dnd_*` 工具修改；怪物 AC/HP/DC 与 DM 笔记不暴露在日常回复或团况中，玩家仅见状态与伤势词（毫发无伤 / 受了点伤 / 伤得不轻 / 摇摇欲坠）。
- **只认本人与灵活托管**：PC 绑定玩家 `openid` 并校验近期发言；玩家暂离/AFK 时可用 `dnd_character` 的 `delegate` 将控制权临时转给队友或交由 DM 托管（`delegate="dm"`），保留原绑定且不丢失反应窗口。
- **完整 5e 战斗引擎**：
  - **反应窗口**：支持借机攻击、护盾术、法术反制（含 60 尺自动挂起与 `DC = 10 + 环阶` 检定）、尖刻言语等，凭按钮或明确宣告生成的一次性 `authorization` 结算。
  - **状态、被动与光环**：覆盖 PHB 主要状态与力竭、可转移专注（`脆弱诅咒` / `猎人印记` 击杀与跨短休保留）、条件被动（巨兽杀手、偷袭、凶蛮攻击等）、圣武士/牧师光环与生命领域加成，并附敌方施法「DM 战术提醒」。
  - **战场空间与批量结算**：一格 5 尺 Dijkstra 寻路、`z` 轴飞行与坠落、持续危害区域、多段命中 `attacks` 与命中后 `on_hit`。开战阵型可选 5 / 10 / 15 尺目标间距，也可单独修正一名角色的位置。
  - **可扩展规则（`dnd_rule`）**：支持按 `campaign` / `global` 作用域热注册自定义攻击、附伤、抗性、豁免修正、持续状态的解除规则、光环与治疗公式。 [扩展规则指南](./skills/dnd-rule-extension/SKILL.md)
- **状态长期化与回滚**：完整团档落盘为 JSON 并保留 40 步历史快照，支持按步数或 `#R` 骰号通过 `dnd_undo` 精确撤销；`/dnd end` 通过状态机原子保存交接、清理实时战斗态并内部唤醒 DM 准备下场内容；`DndSnapshotGate` 采用“同轮锁死、跨轮首步穿透”节流，避免工具循环内重复刷屏上下文。

### 常用命令

| 命令 | 说明 |
|------|------|
| `/dnd start [模组id]` | 开团或续跑同模组旧团，发送签到按钮 |
| `/dnd new [模组id] [blank]` | 归档旧团并重开（默认继承旧角色卡，加 `blank` 从零建卡） |
| `/dnd status` | 玩家视角团况（HP、资源、先攻顺序与战斗测距） |
| `/dnd map [battle\|explore]` | 发送战斗站位图或已探索迷雾图（需 `sharp`，否则发字符图） |
| `/dnd checkin` / `/dnd end [摘要]` | 重发签到按钮 / 原子保存交接并停团 |
| `/dnd combat` | 查看最近一场独立战斗代理的模型与 Token 用量 |
| `/dnd dungeons` / `/dnd search <词条>` / `/dnd spells [职业]` | 列模组 / 查[灰机 D&D wiki](https://dnd.huijiwiki.com/wiki/) / 查职业法术表 |
| `/bot-me` | 查看你自己的 `openid`（群里同时返回群 `openid`，配主人/白名单时使用） |
| `/bot-doctor` | 检查插件运行时配置与依赖健康状态 |

### 独立战斗代理（可选，默认关闭）

默认关闭（直接由 DSH 主模型跑完整个战局）；在「设置 → 跑团进阶与战斗代理 → 独立战斗代理」启用后，开战先攻与开场由主 DM 负责，随后自动交棒独立战斗子代理持续结算；战后子代理先在群内完整播报尾轮战况，再将状态变化与账本交回主 DM。

```yaml
dnd:
  combatAgent:
    enabled: true
    provider: <your-provider-id>   # 需为你已在 DSH 配好的 provider
    model: <your-model-id>         # 对应模型 ID
    reasoningEffort: high
    contextChars: 8000
```

- **权限隔离**：子代理仅拥有战斗所需 `dnd_*` 工具，无终端、文件或任意子代理权限，无需增加群终端白名单。
- **多级容错**：启用 `modelFailover` 时优先切备用渠道，不可用时降级复用主 DM 生效路由或平滑退回主 DM，不重放已落账行动。
- **透明计费**：`/dnd combat` 单独统计各次调用与缓存命中；私密交接记录存在跑团目录 `combat-runs/`。

### DM 工具概览

| 类别 | 工具 | 核心职责 |
|------|------|----------|
| 掷骰 | `dnd_roll` / `dnd_check` / `dnd_apply` | 骰子表达式、检定/攻击/群体豁免（含 `attacks` / `on_hit` / `bonus_dice`）、批量伤害治疗与反应结算 |
| 角色 | `dnd_character` / `dnd_resource` / `dnd_rest` | 建卡改卡、玩家绑定与 `delegate` 托管、SRD 刷怪、法术位/专长次数管理、`transfer` 转移专注、短休/长休 |
| 规则 | `dnd_rule` | 热注册/管理 `campaign` 或 `global` 自定义规则钩子（安全无 `eval` 公式求值） |
| 战斗 | `dnd_initiative` / `dnd_position` | 先攻推进与演练模式（`rehearsal`）、摆位/换位（`swap`）/寻路移动、3D 高度、`area` 覆盖、持续区域 `zone` |
| 探索与剧情 | `dnd_move` / `dnd_map` / `dnd_story` / `dnd_lookup` / `dnd_hook` / `dnd_chronicle` | 房间移动与暗门、地图推送、模组剧情与私密资料查询、背景钩子、长期剧情账本 |
| 存档与百科 | `dnd_undo` / `dnd_progress` / `dnd_prepare` / `dnd_end` / `dnd_srd` | 40 步回滚、分段存进度、DM 私有备团、停团收尾、5e SRD 查询 |

### 模组、配置与延伸阅读

- **内置「沉钟修道院」**：原创 7 房间 1–3 级小地城；自定义模组 JSON 放入 `<dnd.root>/adventures/` 即可热重载生效（商业模组请勿提交至仓库）。
- **仅开团可见**：未开团的 QQ 会话与私聊不挂载 `dnd_*` 工具（节省约上万 Token），停团期仅保留查账本与备团所需工具。
- **相关文档**：**[模组编写指南](./skills/dnd-module-authoring/guide.md)** ｜ **[扩展规则 Skill](./skills/dnd-rule-extension/SKILL.md)** ｜ **[状态长期化开发笔记](./docs/dnd-long-lived-state.md)**

| 配置项 | 默认值 | 说明 |
|--------|--------|------|
| `dnd.enabled` | `true` | 跑团总开关（`/dnd` 命令与 `dnd_*` 工具） |
| `dnd.root` | `cwd/dnd` | 团档（`campaigns/`）与模组目录 |
| `dnd.turnButtons` | `true` | PC 回合时附带互动按钮（需 QQ 开放平台按钮权限，失败自动降级纯文本） |
| `dnd.interjections` | `true` | 开团期间保留按概率随机吐槽（只吐槽不结算）；关闭则仅响应 `@` |

---

## ✨ 其他功能与安全

除跑团外，本插件还在 DSH Web「插件」配置面板集成以下扩展能力：

| 模块 | 说明 |
|------|------|
| 💬 群聊增强 | 未 `@` 接话概率与「回复欲望」评分、群消息/历史图片落盘续接、超限自动压缩、`/new` 带摘要继承（`/new blank` 全清） |
| 🎭 人设切换 | `/persona`（`/人设`）支持群聊/私聊独立切换与各自历史隔离，跨人格生成增量交接，保留实际选用模型；切换宿主后可用 `node scripts/check-persona-handoff-host.mjs` 离线校对编解码器 |
| 🧠 共享记忆 | `notes/` Markdown 笔记按 BM25 自动召回，`chat` 作用域仅限本群，主人私聊可用 `/bot-notes` 巡检 |
| 😺 表情与创作 | 情绪自动收藏（`qqbot_save_sticker`）、哈希匹配（`qqbot_match_sticker`）、[`qqbot-sticker-maker`](./skills/qqbot-sticker-maker/SKILL.md) Q 版透明表情制作与 [`qqbot-image-studio`](./skills/qqbot-image-studio/SKILL.md) 生图工作流 |
| 🖼 多模态 | 图文同发（`caption`）、原生多模态读图（主模型支持图片输入时）、在线 TTS / 可配置 ASR 与整段视频关键帧理解 |
| 🔧 实用工具 | B 站只读工具、同人图挑选、以图搜图、外部点歌工具（均可选且默认关闭 `enabled: false`），以及临时文件定期清理（`/bot-cleanup`） |
| ⏰ 定时与高可用 | `/new` 与人设切换自动迁移定时任务、群聊主动发送失败补发、`modelFailover` 主备模型自动故障转移 |

### 权限与隐私安全

- **默认拒绝与特权隔离**：`allowlist` 为空时不开放访问（fail-closed）；`/model`、`/preset`、`/persona` 及审批卡片仅限 `ownerOpenid` / `adminOpenids`。
- **会话工具隔离（`toolAccess`，默认开启）**：受限 QQ 群无终端与子代理权限，文件读写限制在媒体、表情库、临时目录与 `toolAccess.readRoots`，且始终拦截 `fileAccess.sensitivePaths`。
- **按群精细授权**：生图可经 `qqbot_access(capability="image_gen", action="grant")` 发 10 分钟群审批卡单独授权，仅影响 `imageGen.allowedGroups`；B 站登录/字幕限主人或管理员私聊使用。
- **隐私与仓洁**：凭据仅放配置/环境变量；`notes/` 跨会话共享召回，请勿记录个人隐私；`media/`、`stickers/`、`notes/`、`dnd/`、`tmp/` 均不入库。

---

## 致谢与许可

- 上游仓库：[tencent-connect/dsh-qqbot](https://github.com/tencent-connect/dsh-qqbot)（MIT）｜ 宿主框架：[deepseek-harness](https://github.com/deepseek-ai/deepseek-harness)
- 怪物与法术数据：SRD 5.1（Wizards of the Coast，[CC BY 4.0](https://creativecommons.org/licenses/by/4.0/)）｜ 规则参考：[灰机 D&D wiki](https://dnd.huijiwiki.com/wiki/) ｜ B 站接口参考：[dsh-bili-scroll](https://github.com/c1overzz/dsh-bili-scroll)（MIT）

[MIT](./LICENSE)
