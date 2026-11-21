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
- **代码组织与提交**：纯规则逻辑优先放 `src/features/`（不依赖宿主、可单测）；提交格式 `feat(scope): ...` / `fix(scope): ...`（scope 如 `settings` `media` `dnd` `notes`）。
- **子目录规范**：
  - `src/setup/AGENTS.md` — 设置页路由、配置四处同步自查、脱敏与 `cordis.patch.yml` 最小写入。
  - `src/dnd/AGENTS.md` — 跑团开发约束、新增 `dnd_*` 工具清单与排障（DM 运行期守则在 `src/dnd/dnd-service.ts`，不写进 `AGENTS.md`）。
