# src/setup — 配置路由与持久化约定

1. **配置字段四处同步**（`src/config.ts` 的 `ConfigSchema` 是唯一真源，但单改它不会出现在设置页）：
   - `src/config.ts`：字段、默认值与可复用子 Schema（导出 `XxxSchema`）。
   - `src/setup/bind-routes.ts`：`EDITABLE_CONFIG_KEYS` 加键、`EDITABLE_CONFIG_SCHEMAS` 挂校验（漏掉保存会 400）。
   - `src/client/config-panel.ts`：补对应控件与 `ConfigWire` 字段。
   - `src/setup/bind-routes.test.ts`：覆盖合法值通过与越界/类型错误被拒。
   - 自查：`grep -n "<键名>" src/config.ts src/setup/bind-routes.ts src/client/config-panel.ts` 三处齐全。
2. **密钥与嵌套未上表单字段**：
   - `GET /qqbot/im-qqbot/config` 剔除 `appSecret`、`asr.apiKey` 等密钥类字段；表单仅提示用环境变量或 patch 配置。
   - 嵌套组里不上表单的字段（密钥、复杂规则数组如 `asr.apiKey`、`cleanup.rules`）必须在 POST 时从当前生效配置回填，避免被 Schema 默认值覆盖。
3. **写回 `cordis.patch.yml`**：遵守最小写入，只写用户提交的顶层键，不固化默认值。
