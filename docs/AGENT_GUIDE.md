# Agent 安装与版本迁移指引（`dsh-dungeon-master`）

本文档面向帮助终端用户安装、初始化、配置或升级 `dsh-dungeon-master`（Cordis 插件 ID：`im-qqbot`）的 AI Agent（如 DSH Agent、Claude Code、Antigravity、Codex 等），提供可直接执行的检查流程、操作红线与 `0.8.x → 0.9.0` 迁移清单。

---

## 一、操作红线（Agent Guardrails）

1. **禁止修改包内公开模板**
   - 严禁修改 `node_modules/dsh-dungeon-master/cordis.patch.yml` 或仓库源码目录下的 `cordis.patch.yml`。
   - 所有用户级配置一律写入宿主 profile 目录下的 `~/.dsh/profiles/<profile>/cordis.patch.yml`（Windows 为 `%USERPROFILE%\.dsh\profiles\<profile>\cordis.patch.yml`；未指定时默认 `<profile>` 为 `web`）。
2. **修改配置前必备份，并做 YAML 最小合并**
   - 改写 `~/.dsh/profiles/<profile>/cordis.patch.yml` 前，先复制一份时间戳或 `.bak` 备份。
   - 用 YAML 解析器（如 `js-yaml`）解析顶层数组后，仅定位并合并 `id === 'im-qqbot'` 条目的 `config`；严禁整文件字符串覆盖，避免误删其他插件条目、已有凭据或权限名单。
3. **凭据脱敏，禁止代填未知渠道**
   - 绝不在终端回显或聊天回复中输出 `appSecret`、`apiKey`、环境变量真实密钥或私人 TTS `voice_id`。
   - 绝不自行编造或硬编码第三方 API 网关 URL、模型 ID 或 Key 环境变量名；缺失时先询问用户自有渠道配置，或留空继承 DSH 主模型路由。
4. **注意热更新与重载边界**
   - 新装或升级 `dsh-dungeon-master`、或重建构建产物 `dist/` 后，必须**重启 `dsh` 进程**，服务端新代码才会生效（DSH 仅重载 profile 时不会刷新 Node 的 ESM 模块缓存；仅刷新浏览器只会更新前端面板 `lib/client.js`）。

---

## 二、全新安装指引（Fresh Installation）

### 1. 环境预检

向用户确认目标 `<profile>`（常见为 `web` 或 `qqbot`）后，检查：

```bash
node -v        # 需 >= 20.3.0
dsh --version  # 需 >= 0.1.0-rc.6 且 < 1.0.0
```

### 2. 冲突插件检查（若此前装过上游 `@tencent-connect/dsh-qqbot`）

`dsh-dungeon-master` 与 `@tencent-connect/dsh-qqbot` 共用 Cordis 插件 ID `im-qqbot`，不能同时启用：

1. 检查 `~/.dsh/profiles/<profile>/package.json` 的 `dependencies` 是否包含 `@tencent-connect/dsh-qqbot`。
2. 若已安装上游包：
   - 先备份 `~/.dsh/profiles/<profile>/cordis.patch.yml`；
   - 运行 `dsh plugin --profile <profile> remove @tencent-connect/dsh-qqbot`（或按宿主命令卸载旧包）；
   - 原 `cordis.patch.yml` 中 `id: im-qqbot` 下的 `appId`、`appSecret`、`ownerOpenid`、白名单与媒体配置可直接沿用，无需重绑。

### 3. 安装插件

- **方式 A：从 npm 安装（推荐）**

  ```bash
  dsh plugin --profile <profile> add dsh-dungeon-master
  ```

- **方式 B：从本地源码挂载（开发者 / 改源码用户）**

  ```bash
  pnpm install && pnpm run build
  dsh plugin --profile <profile> add /abs/path/to/dsh-dungeon-master
  ```

- **可选运行依赖与性能建议（提示用户按需开启）**：
  - `sharp`：可选安装，用于在 `/dnd map` 与战斗回合输出 PNG 战棋/迷雾地图（缺省时自动降级字符图）。
  - 系统 `ffmpeg` / `ffprobe`：用于视频抽帧/关键帧分析及部分语音格式转码。
  - **推荐开启 PTC / Code 模式**（如 `@deepseek-ai/dsh-tool-executor-ptc` 或宿主预设中的 Code 模式）：跑团单回合常连续调用多个 `dnd_*` 工具，开启 PTC 可显著降低工具往返轮次、时延与上下文消耗。

### 4. 首次绑定与 5 分钟跑通检查

1. **绑定 QQ 机器人**：引导用户启动 `dsh web`（或 DSH Desktop），打开「**插件 → QQ 机器人**」通过扫码（或页面表单填 AppID / AppSecret）完成绑定；**避免让用户把 `appSecret` 直接粘贴在聊天窗口里**。
2. **拉群与配置主人 `ownerOpenid`**：
   - 将机器人拉入目标 QQ 群；
   - 让用户在私聊或群内向机器人发送 `/bot-me` 获取自己的 `openid`（群里会同时返回本群 `openid`）；
   - 将用户的 `openid` 填入设置页首屏「快速上手 → 主人 openid」（或写入 profile `cordis.patch.yml` 的 `ownerOpenid`）。
3. **最小验收**：
   - 在 QQ 内发送 `/bot-ping`（验证双向消息链路）；
   - 发送 `/bot-doctor`（验证运行态配置、可选依赖健康度）；
   - 在群内发送 `/dnd start` 并 `@bot` 描述角色行动，确认能正常发出签到卡并结算行动。

---

## 三、版本迁移指引（Version Migration）

### 通用升级步骤

1. **备份配置（团档无需担心）**：
   - 备份 `~/.dsh/profiles/<profile>/cordis.patch.yml`。
   - 跑团存档与日志存放在 `<dnd.root>/campaigns/`（默认 `<cwd>/dnd/campaigns/`），插件升级不会删除团档与角色卡。
2. **执行升级**：
   - npm 安装用户：执行 `dsh plugin --profile <profile> upgrade dsh-dungeon-master`（若宿主要求指定版本或重装，可用 `dsh plugin --profile <profile> add dsh-dungeon-master@latest`）。
   - 源码挂载用户：进入插件目录执行 `git pull && npm run clean && npm run build`。
3. **重启运行态并验证**：
   - 必须重启 `dsh` 进程使新版后端生效（仅重载 profile 不会刷新 Node ESM 缓存），如打开网页面板也顺手刷新一次页面；
   - 通过 `/bot-version` 确认版本号已更新，并运行 `/bot-doctor` 检查配置与依赖状态。

---

### `0.8.x → 0.9.0` 迁移检查表（Agent 逐项核对）

`0.9.0` 的核心变化是**剥离作者个人默认配置、移除内置重型浏览器依赖、精简设置页首屏**。帮用户升级时请逐一核对以下 5 项：

#### 1. 非核心扩展工具改为默认关闭（Opt-in）
- **变更**：`bili`（B 站只读）、`fanart`（搜图）、`reverseImage`（以图搜图）、`sing`（外部点歌）全部默认 `enabled: false`。
- **Agent 检查与处理**：
  - 读取用户旧 `cordis.patch.yml` 与使用习惯，确认升级前是否依赖其中某些工具。
  - 若需要保留，向用户确认后在 `im-qqbot.config` 显式补齐 `enabled: true`（`sing` 另配 `baseUrl`），或提示用户在设置页「共享笔记、上游监测与扩展工具」折叠抽屉中开启。

#### 2. 第三方渠道默认预设已清空（继承宿主路由或按需显式填写）
- **变更**：`asr.chatBaseUrl` / `asr.chatModel` / `asr.chatApiKeyEnv`、`video` 直传端点、`modelFailover.backup*` 与 `dnd.combatAgent.*` 不再内置特定第三方厂商默认值，未填写时全部为空。
- **Agent 检查与处理**：
  - 检查 `cordis.patch.yml` 中是否开启了以下任意项：
    - `asr.enabled: true` 且 `asr.mode === 'chat'`（或未指定 `mode`，默认 `'chat'`）
    - `video.directEnabled !== false`（若不配直传网关且已配 `vision` + `ffmpeg`，会自动降级本地抽帧宫格 + 视觉模型）
    - `modelFailover.enabled: true`
    - `dnd.combatAgent.enabled: true`
  - **若开启了其中某项但相关渠道字段为空**：不要留着隐式等报错，也不要编造厂商 URL，请明确询问用户自有的 `<your-provider-id>` / `<your-base-url>` / `<your-model-id>` / `<YOUR_API_KEY_ENV>` 后补写（`dnd.combatAgent` 若不需独立小模型，建议直接保持 `enabled: false` 继承 DSH 主模型）。

#### 3. TTS 人设音色映射改为按 `personaId` 直接匹配
- **变更**：移除了旧版硬编码的三别名转换，在线 TTS（ElevenLabs / DeepSeek）与本地 TTS 直接按当前会话激活的 `personaId` 匹配 `roleVoices`（顺序：精确 `personaId` 映射 → 人设 `.md` frontmatter `voiceId` → `defaultVoiceId`）。
- **Agent 检查与处理**：
  - 检查 `im-qqbot.config.speak.elevenlabs.roleVoices` 与 `speak.deepseek.roleVoices`（以及 `personas.root` / `~/.dsh-qqbot/personas/` 下现有 `.md` 文件名）。
  - 若发现旧键名映射且对应用户人设 ID 并不叫该旧名，**在用户确认人设 ID 后**，把旧键原值无损复制到对应 `personaId` 键名下（例如 `default`、`soft-whale` 或用户自定义文件名，**操作中切勿输出原 `voice_id` 明文**）。

#### 4. 移除内置 Playwright 浏览器与跨插件桌宠余额钩子
- **变更**：彻底移除 `qqbot_browser`、`src/browser/` 与 `playwright-core` 依赖（大幅缩小安装体积），同时移除针对特定本地模型余额的桌宠钩子。
- **Agent 检查与处理**：
  - **兼容性**：用户旧 `cordis.patch.yml` 若仍残存 `browser:` 配置块，新版 `ConfigSchema` **会安全容忍未知键，不会启动报错**；可在征得用户同意后再清理该冗余片段。
  - 若用户此前用 `qqbot_browser` 做网页交互，建议其在 DSH 中改用独立 Computer Use 插件或浏览器 MCP 方案。

#### 5. Web 设置面板结构调整（兼容性无破坏）
- **变更**：打开 DSH Web「插件 → QQ 机器人」设置页时，首屏仅保留「快速上手」（私聊/群聊权限、主人 `openid` 含 `/bot-me` 指引、群触发模式）与「跑团」核心开关，其余设置归入 4 个默认折叠的 `<details>` 抽屉中（抽屉右侧附当前启用项摘要）。
- **Agent 注意**：配置键名与保存协议完全未变，只需在引导用户手动改某个进阶选项时，按新分组名提示其在对应折叠抽屉内查找：
  1. `跑团进阶与战斗代理`
  2. `会话、权限与人设进阶`
  3. `富媒体、视觉、语音与生图`
  4. `共享笔记、上游监测与扩展工具`

---

### 从上游 `@tencent-connect/dsh-qqbot` 迁移清单

1. 备份 `~/.dsh/profiles/<profile>/cordis.patch.yml` 与现有 `dnd/`、`notes/` 目录。
2. 在 `<profile>` 中卸载 `@tencent-connect/dsh-qqbot`（确保不会在同一个 `package.json` 并存两份 `im-qqbot`）。
3. 安装 `dsh-dungeon-master`，保存配置触发重载后即可沿用原有绑定凭据、权限名单与笔记。

---

## 四、升级 / 安装后验收清单

在结束迁移或安装任务前，Agent 应逐项核对以下条件均成立：

- [ ] `~/.dsh/profiles/<profile>/cordis.patch.yml` 可正常解析为 YAML 数组，且 `id: im-qqbot` 的既有凭据、`ownerOpenid` 与白名单完整保留；
- [ ] `package.json`（profile 侧）不存在 `@tencent-connect/dsh-qqbot` 与 `dsh-dungeon-master` 并存冲突；
- [ ] 升级至 `0.9.0` 时，已向用户确认扩展工具开关（`bili` / `fanart` / `reverseImage` / `sing`）、`combatAgent` / `modelFailover` / `asr` 自定义渠道以及 `speak.*.roleVoices` 人设键名；
- [ ] 原跑团存档目录（`<dnd.root>/campaigns/` 或 `<cwd>/dnd/campaigns/`）完好；
- [ ] 已重启 `dsh` 进程使新版后端生效，且 `/bot-version`、`/bot-doctor`、`/bot-ping` 与（开团后）`/dnd status` 均返回正常。

---

## 五、常见升级排障速查

**开发版笔记库与 `/learn`**。包内提供 `skills/learn/SKILL.md`。如宿主尚未发现这个 skill，可将包内的 `skills/learn` 复制到目标工作区的 `.agents/skills/learn`。若已有自定义版本，先比对再合并。主人可在 QQ 私聊或本地 DSH Web/Desktop 会话显式发送 `/learn` 审阅该 bot 的 QQ 草稿。偏好可用习惯、默认做法、纠正或下次约定表达。跨会话复盘只列证据指针，当前会话才能附上对应原句。确认后才写入正式笔记。新节用「召回正文：」开头，把决策条件、做法和例外写在一起，另起一段用「依据：」记录来源。预算只够一条时优先保留完整正文；显式搜索可看完整依据。已有笔记无需迁移。

**0.9.1 发布时的行为（主人私聊经验草稿 & 设置页检查更新）：** 无需迁移笔记或增加配置。经验草稿仅在配置了主人 openid 且能定位 profile 时启用，保存在该 profile 的 `qqbot-learn-inbox` 目录，不在笔记索引中；需要可调用 `qqbot_learn_inbox` 的宿主及配套 `/learn` skill，重启宿主后在主人 QQ 私聊发送 `/learn` 审阅（非主人、群聊、本地 Web 会话或未经直接请求均不能读取；技术证据首版仅识别同轮、同目录、同命令的定向 Vitest 失败→文件改动→复验全过，偏好草稿只保留原消息指针，未批准前不写正式笔记）。设置页顶部同步提供只读「检查更新」与「复制升级 Prompt」入口。

遇到以下异常时，Agent 可直接按现象定位并修复：

1. **设置页人设区提示 `404` / 找不到新版人设接口**：升级后只刷新浏览器或仅在页面点「重载 profile」时，Node ESM 缓存仍停留在旧版 `dist/`；**请提示用户重启一次 `dsh` 进程**，再刷新设置页。
2. **`/bot-doctor` 提示残留 `browser` 或内嵌 `groupPrompt` / `directPrompt`**：让用户在 DSH Web「插件 → QQ 机器人 → 会话、权限与人设进阶」人设管理器下方点击「清除旧内嵌提示词」并点击「保存设置」（保存动作同时会自动清除已下线的 `browser` 字段）；或按本文档红线备份后用 YAML 解析器移除对应字段。
3. **升级后搜图 / B 站 / 以图搜图 / 点歌不可用**：`0.9.0` 起 `bili`、`fanart`、`reverseImage`、`sing` 改为默认 `enabled: false`；确认用户仍需使用后，引导用户在设置页「共享笔记、上游监测与扩展工具」抽屉开启，或在 `im-qqbot.config` 中显式补充 `enabled: true`。
4. **`asr`（chat 模式）/ `modelFailover` / `dnd.combatAgent` 报错或未生效**：`0.9.0` 已清空第三方厂商默认预设；按 `/bot-doctor` 输出的提示询问用户自有网关 / 模型配置并补填，或将对应开关设为 `false` 继承 DSH 主模型路由。
