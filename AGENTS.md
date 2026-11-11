# dsh-qqbot — 仓库约定

QQ Bot IM 插件（Cordis 插件，宿主为 deepseek-harness）。服务端 `src/`，浏览器侧
`src/client/`，构建产物 `dist/`（宿主）与 `lib/client.js`（Web 客户端，均有 gitignore）。

## 改配置项时：三处必须同步

`src/config.ts` 的 `ConfigSchema` 是唯一真源，但**只改它不会出现在设置页**。新增/修改字段时逐项检查：

1. `src/config.ts` — 字段 + 默认值 + 子 Schema（嵌套组导出成 `XxxSchema`，便于复用）。
2. `src/setup/bind-routes.ts` — `EDITABLE_CONFIG_KEYS` 加键、`EDITABLE_CONFIG_SCHEMAS` 挂校验；
   缺了这一步，设置页保存直接 400「不支持的字段」。
3. `src/client/config-panel.ts` — 加对应控件与 `ConfigWire` 字段；缺了这一步，配置只能手改
   `cordis.patch.yml`，设置页看不到（这个漂移已经发生过：notes、replyDesire 都是先漏了 UI）。
4. `src/setup/bind-routes.test.ts` — 至少覆盖：新键合法值通过、越界/类型错误被拒。

自查：`grep -n "<键名>" src/config.ts src/setup/bind-routes.ts src/client/config-panel.ts`，
三处都要有。嵌套组里**不上表单**的字段（密钥、复杂规则数组）必须在 POST 处从当前生效配置
回填，否则 Schema 默认值会把用户已保存的值冲掉（参考 `asr.apiKey`、`cleanup.rules`）。

## 密钥不上表单、不回传

`GET /qqbot/im-qqbot/config` 会剔除 `appSecret`，`asr.apiKey` 同样脱敏；新增密钥类字段照此处理，
表单只给「用环境变量/patch 配置」的提示。

## 构建与测试

```bash
npm run build            # tsc + tsdown，产出 dist/ 与 lib/client.js
npm run typecheck:client # 浏览器侧单独类型检查（tsconfig.client.json）
npx vitest run --pool=threads   # 默认沙箱里 video-tool 的真实 ffmpeg 用例会 EPERM，属环境限制
```

改了 `dist/` 或 `lib/client.js` 后，宿主**不会**自动重载插件代码：需要一次 profile 重组
（保存一次设置、或用插件管理器操作）才生效；只刷新浏览器只能拿到新的客户端 bundle。

## 约定

- 作为仓库所有者审视代码：改动要对之后的维护负责，不只是让眼前的任务通过。
- 提交信息：`feat(scope): ...` / `fix(scope): ...`，scope 如 `settings` `media` `dnd` `notes`。
- 注释写「为什么」；不写复述代码的注释。
- 写回 `cordis.patch.yml` 遵守最小写入：只写用户提交的顶层键，不固化默认值。
- 纯规则逻辑（如回复欲望打分）优先放 `src/features/`，保持可单测、不依赖宿主。

## 跑团（dnd）：写给 DM 的规则不放这里

这个文件 DM 平时读不到：宿主只在碰到 `dsh-qqbot/` 下的文件时才注入它，而跑团会话的工作目录在上一级
（session `c5a6a808` 的 2364 回合里只注入过两回，都是 DM 在改这个文件）。所以：

- 给 DM 的规则写进 `src/dnd/dnd-service.ts` 的 DM 守则，压缩摘要要保留什么也在那里。
- 守则每回合整段注入，越长每条越没分量（守则写着用 adjacent_to，45 次移动一次没用）。只放每回合都要守的；
  某个工具怎么调、某一步要注意什么，写进那个工具的说明或返回值。
- 能由代码保证的放工具返回值，比规则更管用：`dnd_move` 再进房间时的「这里来过」、
  `dnd_position` 的借机和够不到提醒。模型在那一步正好看得到。
- 怪物的 AC、HP 和 DC 不进例行的工具结果和团况，只给伤势词和成败（只有 `dnd_character show` 这种专门查的才给）。
  数字写在正文里会被整行照抄，包进 `【机密：…】` 也一样：11-07 结果写着「命中【机密：AC 13】」，群里照样说「命中 AC 13」。
- 模组里的具名反派、俘虏要写 `knows`，连「他不知道什么」也写（布鲁戈尔：跟黑蜘蛛没往来）。`knows` 空着，
  审问时 DM 会现编口供，编出来的地点和人后面就成了真的（维瑞丝供出的「断崖下营地」让黑蜘蛛死在了洞外）。
- 停团后不注入 DM 守则，只注入一小段 `PAUSED_RULES`；玩家收团后最爱聊团，那段要管住剧透和凭印象答。
- 战斗中要跨压缩保留的状态必须进 `summarize()`（团况每次变化都重发）。压缩摘要是转述，
  站位这类细节走样过：格罗尔走开时漏算借机、狼咬完人又被报成「离你十来尺」。
- 新增 `dnd_*` 工具时同步：DM 守则、`README.md` / `README_EN.md` 的工具表、测试。工具放进 `src/dnd/tools/` 下对应类别的文件；停团后也要能用的，加进 `src/dnd/tool-scope.ts` 的 `PAUSED_DND_TOOLS`（没开团的会话看不到任何 `dnd_*` 工具，停团的只看得到这份名单）。

查问题时：

- `dnd_*` 的结果永远不发到群里（`showToolResults`），群里看不到调用记录不等于没调用。
- 会话记录在 `~/.dsh/sessions/<cwd>/<id>/session.v4.jsonl.zstd`，是一串独立的 zstd 帧。Node 的流式解压
  只解第一帧，要按魔数切开逐帧解。
- 战役档 `dnd/campaigns/qqbot_*_<群openid>.json`：`revealed` 里有的房间 = 演过，再看 `log` 和聊天记录确认演到哪一步。
