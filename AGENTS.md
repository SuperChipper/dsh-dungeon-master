# dsh-qqbot — 仓库约定

QQ Bot IM 插件（Cordis，宿主 deepseek-harness）。服务端 `src/`，浏览器侧 `src/client/`；构建产物 `dist/` 与 `lib/client.js` 均已 gitignore。

## 构建、测试与生效

```bash
npm run build                    # tsc + tsdown -> dist/ 与 lib/client.js
npm run typecheck:client         # 浏览器侧类型检查（tsconfig.client.json）
npx vitest run --pool=threads    # 默认沙箱里 video-tool 真实 ffmpeg 用例会 EPERM，属环境限制
```

改完 `dist/` 或 `lib/client.js` 后宿主**不会**自动重载插件代码，需一次 profile 重组（保存一次设置或插件管理器操作）才生效；仅刷新浏览器只能拿到新前端 bundle。

## 关键红线与目录约定

- **改配置字段**：必须同步 `src/config.ts`、`src/setup/bind-routes.ts`、`src/client/config-panel.ts`、`src/setup/bind-routes.test.ts`；密钥不上表单、不回传，嵌套组未上表单字段 POST 时需回填（详规见 `src/setup/AGENTS.md`）。
- **插件边界与宿主适配**：
  - `src/host-adapter/index.ts`（服务端）与 `src/client/host-adapter.ts`（浏览器端）是访问未公开宿主接口/事件的唯一出口；其余 `src/` 业务代码禁止直接写 `ctx as unknown`、`scope as unknown`、`symbols.original`、`compactIfNeeded`、`suppressRuntimeContext` 等宿主探测或补丁（由 `src/host-adapter/index.test.ts` 自动守卫）。
  - 源码、测试夹具、`personas/` 与仓内公开模板 `cordis.patch.yml` 严禁写入个人密钥、真实 `voice_id`、特定第三方渠道默认值或个人跨插件胶水；非核心扩展工具（B 站/搜图/点歌/以图搜图等）默认 `enabled: false`。
  - 个人运行态配置一律写入仓外 DSH profile（`~/.dsh/profiles/<profile>/cordis.patch.yml`）或已忽略本地覆盖文件（`cordis.dev.yml`），严禁将个人配置填回 `cordis.patch.yml`（该文件随 `package.json` `files` 发布到 npm）。
- **发版与版本迁移同步**：凡修改默认配置开关、增删或重命名配置键/内置工具、调整必选或可选依赖、或准备发布新版本，必须同步更新 `docs/AGENT_GUIDE.md`（补齐对应版本的迁移检查表）、`CHANGELOG.md` / `CHANGELOG_EN.md`，以及 `README.md` / `README_EN.md` 顶部迁移指引版本号。
- **代码组织与提交**：纯规则逻辑优先放 `src/features/`（不依赖宿主、可单测）；提交格式 `feat(scope): ...` / `fix(scope): ...`（scope 如 `settings` `media` `dnd` `notes`）。
- **子目录规范与指南**：
  - `src/setup/AGENTS.md` — 设置页路由、配置四处同步自查、脱敏与 `cordis.patch.yml` 最小写入。
  - `src/dnd/AGENTS.md` — 跑团开发约束、新增 `dnd_*` 工具清单与排障（DM 运行期守则在 `src/dnd/dnd-service.ts`，不写进 `AGENTS.md`）。
  - `docs/AGENT_GUIDE.md` — 面向终端用户的 Agent 安装、排障与跨版本迁移操作手册（随 npm 包发布）。
