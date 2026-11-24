# Changelog

> [简体中文](./CHANGELOG.md)

This file records significant `dsh-dungeon-master` updates from a product perspective, focusing on user-visible changes.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

## [0.9.0] - 2026-11-24

### Upgrade Notes from 0.8.x (Agent Migration & Troubleshooting)

- **Let an AI Agent migrate or troubleshoot**: This package bundles [`docs/AGENT_GUIDE.md`](./docs/AGENT_GUIDE.md) (checklist, YAML merge guardrails, and troubleshooting quick reference), or paste the ready-to-copy Quick Start prompt from [`README_EN.md`](./README_EN.md) to your AI assistant.
- ① **Restart the `dsh` process once after upgrading**: Marketplace updates or profile reloads alone do not invalidate Node's ESM cache for the backend bundle. Restart `dsh`, then run `/bot-doctor` in QQ to check for configuration drift.
- ② **Optional utility tools are now opt-in (`enabled: false`)**: `bili`, `fanart`, `reverseImage`, and `sing` default to disabled. Re-enable the ones you rely on under the **Shared Notes, Failover & Extra Tools** drawer in Settings.
- ③ **Built-in Playwright browser & third-party vendor defaults removed**: `qqbot_browser` (`playwright-core`) and preset third-party gateways/models (`asr.chat*`, `video` direct endpoint, `modelFailover.backup*`, `dnd.combatAgent.*`) have been cleared. Legacy `0.8.x` `cordis.patch.yml` files remain loadable without blocking startup; saving Settings automatically removes stale `browser` keys, and an inline cleanup card clears legacy `groupPrompt`/`directPrompt` fields.

### Added

- **Persona Directory & Custom Persona Manager**: View the active personas folder and loaded personas (`both` / `group` / `direct` badges), open the folder in the OS file manager (Windows uses `ShellExecuteExW` with `explorer.exe` fallback), copy its path, and create new `<id>.md` templates directly from Settings; surfaces clear restart guidance if the backend returns `404`.
- **Agent Install/Migration Guide & Dual Quick Start**: Added bundled [`docs/AGENT_GUIDE.md`](./docs/AGENT_GUIDE.md) covering fresh install, replacing `@tencent-connect/dsh-qqbot`, `0.8.x -> 0.9.0` migration checks, and troubleshooting; split `README.md` / `README_EN.md` Quick Start into a ready-to-copy Agent prompt option and manual CLI option.
- **`/bot-doctor` 0.9.0 Drift Diagnostics & Legacy Prompt Cleanup Banner**: `/bot-doctor` detects leftover `browser` blocks, enabled `asr` (chat)/`modelFailover`/`dnd.combatAgent` with missing custom routes, and disabled `fanart`/`sing` with stale settings; Settings shows a targeted cleanup card only when legacy `groupPrompt`/`directPrompt` values exist, and `persist` strips deprecated `browser` entries on save.

### Changed

- **Collapsible Web Settings Panel**: Keeps Quick Start and core D&D controls at the top level while grouping advanced settings into four collapsible `<details>` drawers with active-state summaries, removing the deprecated `groupPrompt`/`directPrompt` fields from the form.
- **De-personalized Defaults & Bundled Public Personas**: Ships bundled public `personas/`, switches TTS `roleVoices` (ElevenLabs / DeepSeek / local TTS) to match directly by active `personaId`, clears built-in third-party vendor defaults, and removes `src/browser/` + `playwright-core` to slim package footprint.
- **Host-Adapter Boundary Hardening**: Consolidated Cordis host `ctx` access inside `src/host-adapter/` with boundary guard tests and stripped personal defaults across public docs and config templates.

## [0.8.1] - 2026-11-24

### Added

- **Atomic `/dnd end` pause & next-session preparation state machine**: integrates `/dnd end` into a transactional state machine that atomically persists saves, cleans up live combat state, and dispatches an internal post-session preparation prompt to the DM, removing the legacy static pause reply.
- **PC delegation (player control transfer & DM-managed reaction windows)**: adds a `delegate` parameter on `dnd_character` to temporarily transfer control to a teammate (by character name or U-number) or to the DM (`delegate="dm"`) while preserving the original player binding; delegated controllers gain button and verbal authorization, and DM-managed characters keep reaction windows unblocked so AFK players do not miss reactions or stall turns.

### Changed

- **Tightened `DndSnapshotGate` to same-turn lock with next-turn first-step breakthrough**: locks `runtime-context` snapshots across structural changes (`structKey`: room moves, combat start/end, check-in/absent toggles) within the same user dialogue turn to avoid mid-turn re-emissions, allowing immediate mid-turn breakthrough only on compaction (`epoch`) or `dnd_undo` (`forceSeq`), and automatically breaking through on the first step of the next user turn to sync the final settled state once.
- **Manifest dependencies & README cleanup**: declared `engines.dsh` (`>=0.1.0-rc.6 <1.0.0`), cleaned up `@deepseek-ai/dsh-*` `peerDependencies` ranges and `0.2.2-rc.5` compatibility metadata, and streamlined `README.md` / `README_EN.md` with a default PTC recommendation.

## [0.8.0] - 2026-11-22

### Added

- **D&D 5e combat completeness (transferable concentration, swap, auto-layout & status ring rendering)**: `Hex` and `Hunter's Mark` persist across target kills and short rests and can be reassigned at zero slot cost via `dnd_resource(action="transfer")`; `dnd_position(action="swap")` swaps ally positions upon confirmation without spending reactions; `dnd_position(action="auto")` auto-places units by front/mid/back rank priorities; battlemaps draw blue/red/dual-tone status rings and bottom condition badges; movement paths crossing hazardous zones emit split/detour hints.
- **Conditional combat passives & richer declarative `dnd_rule` hooks**: natively settles Colossus Slayer, Sneak Attack, Savage Attacks, Improved/Superior Critical, Divine Fury, Improved Divine Smite, Blessed Strikes, War Caster, Pack Tactics, and Blood Frenzy alongside unregistered passive reminders; adds `class_level`, `target_hp`, and `target_max_hp` formula variables plus `passive` / `class_filter` and target/turn-scoped hook filters, with matching updates to the bundled `dnd-rule-extension` skill.
- **End-to-end Counterspell & Shield reactions with DM-only enemy caster hints**: `reactionsOf` infers reaction spells from `spells` with higher-slot fallback; hostile save spells, damageless spell attacks, Magic Missile, spell zones, and leveled buff spells auto-hold within 60 ft for deterministic Counterspell checks (`DC 10 + spell level`) and `Shield` (`+5 AC` default / Magic Missile immunity); PC spells and non-crit hits on enemy casters append DM-only `【DM战术提醒】` hints.
- **Platform, diagnostics & multimodal additions**: added `/bot-doctor` runtime self-checks, `qqbot_image_gen` with bundled `qqbot-image-studio` skill, online TTS backends and configurable ASR/video gateways, unified group trigger modes and expanded config panel UI, bundled personas with transactional switching, scoped memory recall/media review, and archiving of bot outbound group messages.

### Changed & Fixed

- **Turn-throttled runtime context & resource synchronization**: `runtime-context` battle state injection is throttled by dialogue turn so multi-attack turns avoid repeated re-injections while room changes/compaction/undo/end bypass immediately; fixed multiclass/level-up spell slot `0/N` initialization and same-name resource collisions, automatically syncing hit dice and 5e spell slot maximums.
- **Modularization & hardening**: split `gateway` wiring, `client/config-panel` UI, and `atomic-fs`/`paths` helpers; tightened group access control and session tool scopes; and hardened check-in recovery, spell links, and read-only module access.

## [0.7.0] - 2026-11-18

### Added

- **Persistent battlefield zones (`BattleZone`) & map rendering**: `dnd_position` adds `zone` / `remove_zone` with built-in presets (Darkness, Fog Cloud, Poison Mist, Cloudkill, Stinking Cloud, Web, Cloud of Daggers, Moonbeam, Spike Growth, Wall of Fire, Silence) and customizable save/damage/obscurement/terrain parameters; `/dnd status` and PNG/ASCII battle maps render zone overlays and remaining rounds live, automatically trigger saves and damage on movement entry/exit or turn boundaries, suppress opportunity attacks under heavy obscurement, link to caster concentration, and clean up automatically on expiry or combat end.
- **2.5D flight altitude & crash falls**: characters and monsters support `fly_speed`, `hover`, `z` altitude, and room `ceiling` with 3D melee reach and opportunity checks; non-hovering flyers knocked prone, reduced to 0 speed, or incapacitated automatically fall and resolve `1d6 / 10 ft` bludgeoning damage plus prone.
- **Aura engine, automatic on-hit riders & concentration closure**: natively resolves Paladin Aura of Protection dynamic save bonuses, Spirit Guardians 15 ft enemy slow and upcast radiant save damage, automatic on-hit riders (Hex, Hunter's Mark, Divine Favor, Enlarge, Rage, and multi-part weapon `riders`), Life Domain healing bonuses (Disciple of Life, Blessed Healer, Preserve Life), Protection from Poison, and explicit `dnd_apply(drop_concentration)` cleanup for derived states and zones.
- **Extensible rule engine (`dnd_rule`) & `dnd-rule-extension` skill**: hot-registers `campaign`- or `global`-scoped custom attack, on-hit rider, defense/resistance, save, aura, and healing hooks evaluated by a sandboxed no-`eval` formula parser, paired with the bundled `dnd-rule-extension` skill guide for table house rules and third-party supplements (such as Warcraft 5e, signature weapons, and destiny passives).
- **Chibi sticker creation & registration skill (`qqbot-sticker-maker`)**: bundled skill and offline `sharp`-powered `sticker-cli.cjs` tool supporting 1024 alignment grids, red/cyan overlay diffs, local patch splicing, white-background flood matting with enclosed-pocket detection, native-alpha export, 1:1 light/dark 256px previews, and atomic `stickers/index.json` registration.

### Fixed

- **Combat subagent final-round narration cutoff**: fixed combat ending transitions via `dnd_initiative(action="end")` handing control back before broadcasting the closing turn's rolls and outcome; the subagent now narrates the final round to the group before returning the post-combat handoff to the main DM.
- **Model failover restart desync**: fixed `ModelWatch` starting out of sync when restarting on a backup channel with `modelFailover` enabled, preventing recovery back to primary, and automatically clears stale persisted `failover` markers when `modelFailover` is disabled.
- **Combat subagent context growth & group history cursor continuity**: suppressed optional host runtime contexts via `suppressRuntimeContext` and forced `required: true` runtime contexts (`qqbot:dnd-state` / `qqbot:sticker-additions`) to return empty for combat child sessions (preventing per-step `Current runtime context` re-emissions), injecting a compact delta-only `combatStateSnapshot` once per turn only when combatant state changes, and deduplicating redundant hit-die keys in `resourceTag`; disabled both host-level automatic/overflow compaction (`compaction.compactIfNeeded`) and plugin `maybeAutoCompact` for disposable combat subagents so active fights are never summarized away or cache-busted mid-combat; pinned `SessionManager.sessionIdFor` to the main session ID so combat handoffs and failovers never flush full group chat history; and added multi-tier subagent failover (`combatAgent -> modelFailover backup -> subagent reusing the main DM's effective model route -> main DM`) with cross-model `reasoningEffort` isolation.
- **Combat resolution guardrails, Chinese alias unification & `Slow` automation**: `dnd_apply` rejects simultaneous `damage` and `heal` arguments in the same call, adds bonus-action spellcasting economy reminders, and filters negated phrases (such as "cannot take opportunity attacks") from `reactionsOf` trait scanning; completes 5e `缓慢术`/`迟缓术` automation (-2 AC, halved speed, -2 DEX saves, blocked reactions/opportunity attacks, and multi-attack reminder), unifies multi-edition Chinese spell/condition/zone/aura/trait aliases across lookup and mechanics engines, and forwards `global`-scoped custom hazard auras to `/dnd status` and `/dnd map` rendering.

## [0.6.0] - 2026-11-16

### Added

- **D&D 5e AI Dungeon Master (`/dnd` and 17 `dnd_*` tools)**: adventure modules (dungeon & town hub modes), character sheets with unified spell/feature/item kit buttons, SRD lookup, grid battlefield pathfinding & AoE coverage, fog-of-war player maps and PNG/emoji battlemaps, chronicle ledger, backstory hooks, check-in roster, and snapshot undo.
- **Structured 5e condition engine & turn ledger**: automatic PHB condition, exhaustion (1–6), concentration, and combat state modifiers (advantage/disadvantage, AC/save dice, speed zeroing, prone half-speed stand-up, rage/petrified resistance) with single-line turn ledgers and `ignore_state_mods` escape hatches.
- **Staged reaction windows & targeted undo**: multi-stage reaction prompts (`foe_attacks`/`attacked`, `enemy_crit`, `damaged`) with one-time server authorization tokens; `dnd_undo` supports `steps`, `#R` roll IDs, and initial placement rollback without wiping combat initiative.
- **Dedicated combat subagent, automatic channel failover & rehearsal sandbox**: optional isolated combat subagent handoff with automatic post-combat delta/ledger summaries; automatically switches to the `modelFailover` backup route on 429 quota or upstream errors (or hands back cleanly to the main DM with failure reasons while suppressing raw error spam in chat), plus `rehearsal=true` dream/sparring fights that restore pre-combat state on completion.
- **Module authoring skill (`dnd-module-authoring`)**: bundled agent skill and guide for authoring adventure modules.
- **DSH plugin management**: install, enable/disable, and configure `dsh-dungeon-master` from the DSH Web Plugins page and the bundle detail form, without hand-editing profile files.
- **More editable settings**: group reply probability, group history size, session idle timeout, owner openid, and file-access allowlist / sensitive paths.
- **Automatic sticker collection**: the bot decides — based on how it feels about an image — whether to call `qqbot_save_sticker`; the tool deduplicates by content hash, updates `stickers/index.json`, and injects the new sticker into later turns' catalog, so the fixed persona table no longer needs manual edits.
- **Media with caption**: `qqbot_send_file` now accepts `caption`, so an image/video/file and the full reply can be sent as one rich-media message; the QQ-session prompt prefers caption over a separate text reply.
- **Bilibili read-only tools**: added `bili_search`, `bili_video`, `bili_comments`, `bili_subtitle` and QR login `bili_login` / `bili_login_check`; read-only, credentials stored locally, no comment/upload/DM write tools.
- **Native image input**: added the `deepseek-native` pi-ai route (`deepseek-flash`, text+image) and `vision.native`; QQ inbound images are committed as attachments and passed as ImageBlocks to the main model, skipping the `qqbot_describe_image` transcription. The tool remains as the OCR/chart fallback.
- **Automatic schedule migration after `/new`**: `/new` captures the old session's active daily/weekly/every schedules and injects a `schedule_list` / `schedule_create` rebuild instruction into the new session's first message; one-shot after/at tasks are not migrated.
- **Meme/sticker matching**: added `qqbot_match_sticker` (SHA-256 against the local `stickers/index.json`) plus a `meme-recognition` skill that falls back to OCR + KnowYourMeme/Moegirlpedia/Baidu/Bilibili text search. Exact hash only for now; perceptual hash is a follow-up.
- **Shared notes (long-term memory)**: Markdown under `notes.root` (default `cwd/notes`) is memory shared by all sessions; relevant sections are auto-recalled into each message, plus `qqbot_notes_search` / `qqbot_notes_save` tools. Local BM25 with Chinese bigrams, no vector service.
- **Group history images**: group memory records image URLs; on a trigger the latest 4 history images are downloaded, tagged `[图片#n]` and injected natively, so the bot can see images posted earlier.

### Changed

- **Config location**: in-app config moved from Settings → QQ Bot to Plugins → Installed plugins → `dsh-dungeon-master`; Settings keeps QR binding and status.
- **Linked installs**: profile resolution now uses `ctx.baseUrl`, `DSH_PROFILE_DIR`, and the installed link, fixing QR/config writes that could not locate the profile for local-path installs.
- **Runtime note**: in Web-plugin mode the bot shares the DSH Web process; do not run the standalone profile at the same time, or the same bot may open two connections.

### Fixed

- **Model ID clarification**: under `deepseek-official`, V4.1 Flash is `deepseek-flash`; `deepseek-v4-flash` belongs to the `deepseek-vision` route. This avoids keeping the old ID on the official route.
- **Long prompts failed to save**: raised the manual-config request body limit from 4KB to 256KB, so the config panel can save two full system prompts without `request body too large`.
- **Pseudo tool-call fallback**: when the model writes `qqbot_save_sticker` as text tags, the outbound layer strips the tags and executes the collection instead of sending XML to the user.
- **Pseudo send_file fallback**: `<qqbot_send_file>...` text tags are stripped by the outbound layer and do not trigger a second send.
- **Old session lost after `/new`**: kept a retired-session mapping (`old sessionId → current session`) so a resumed old schedule still routes to the current QQ conversation; failed sends are queued and a `[上次未送达]` hint is injected on the next user message for a resend.
- **Desktop pet balance with `deepseek-native`**: registered a matching balance provider via `petApi7340.balance.register` (`/user/balance` + `DEEPSEEK_API_KEY`) with the DeepSeek peak/idle tier, so switching to native no longer shows `unsupported`.
- **Approval card failed**: pending is now registered before the card is sent (race fix); stale cards/plugin-reload clicks say “审批已失效” instead of showing a QQ approval failure.

### Security

- **Hardened permissions**: an empty allowlist no longer degrades to `['*']` (fail-closed); `/model` and `/preset` changes are owner/admin-only; approval buttons accept only owner/admin clicks; added `adminOpenids`.
- **Bilibili login permission**: `bili_login` / `bili_login_check` are c2c owner/admin-only and rejected in groups; when a credential exists, `bili_subtitle` is also c2c owner/admin-only; search/video/comments now use guest mode and do not consume the owner's account.

### Documentation

- README covers the Web-plugin workflow, file-access settings, automatic sticker collection, and safe-commit guidance; `.gitignore` / `.npmignore` now exclude runtime media and the local sticker pack.

## [0.5.2] - 2026-10-12

### Fixed

- **Fixed clean installs failing to activate**: 0.5.1 shipped with the old SDK range (`^1.0.4`), so clean installs resolved 1.0.4 and the disconnect logging feature crashed at startup (`TypeError`), failing plugin activation. The range is now `^1.0.5`.
- **Graceful degradation on stale SDKs**: environments that still carry an older SDK now skip the disconnect listener with an upgrade hint instead of failing activation.

## [0.5.1] - 2026-10-12

### Added

- **In-app QR binding**: bind your bot entirely from the DSH Desktop / Web settings page — scan with your phone's QQ or enter the AppID / AppSecret manually, with live binding status; the sidebar opens a guided page automatically while unbound. Credential rotation and unbinding are one click away.
- **In-app config panel**: no more hand-editing files — c2c/group access control (open, allowlist, disabled), mention-required in groups, streaming, tool-result display, model overrides and extra prompts, all applied automatically on save.

### Improved

- **Upgraded the QQ Bot SDK to 1.0.5**: disconnects are now logged with the reason and whether the bot will recover on its own, and a connection that can never be established fails fast with a clear reason instead of waiting forever.

## [0.5.0] - 2026-09-08

### Added

- **Image understanding**: send images to the bot and it will automatically understand their content (screenshots, photos, charts, etc.), and can analyze them together with text instructions.
- **File sending**: the bot can send local files (documents, images, etc.) directly to you, no longer limited to plain-text replies.
- **Proactive questions**: when the bot encounters uncertain information, it proactively asks you questions, letting you pick an answer with a single tap for smoother interaction.
- **Action confirmation**: before performing sensitive or critical operations, the bot requests confirmation, which you approve or block via "Allow/Deny" buttons.
- **Session compaction**: new `/compact` command to compress the current session history in one step, preserving context while freeing space — ideal for very long conversations.
- **Preset switching**: new `/preset` command to view or switch the bot's persona/behavior preset.
- **Network latency test**: upgraded `/bot-ping` to return network transport time and plugin processing time, making it easier to diagnose connection latency.

### Improved

- Long-task execution timeout extended to 30 minutes, so complex tasks are no longer interrupted mid-way.
- Direct and group chats now receive more context-appropriate system prompts.
- Failed proactive message pushes automatically fall back to passive replies, reducing "the bot didn't respond" situations.
- Media files such as images are automatically cleaned up after use, avoiding long-term disk usage.

### Fixed

- Fixed the `/stop` command not actually aborting in-progress generation (it was previously a no-op).
- Fixed the registration order of the approval channel, ensuring confirmation requests are captured and handled correctly.

### Documentation

- README updated with the new `/preset` and `/compact` commands, plus QR-code upgrade guidance.

## [0.4.0] - 2026-08-16

### Added

- **QR link**: when the QR code renders incorrectly, you can click the link printed in the terminal to complete scanning in a browser.

### Improved

- Supports auto-saving QR credentials on Windows (previously failed due to path issues).
- When auto-saving credentials fails, it now clearly guides manual configuration instead of silently dropping existing config.

### Documentation

- Added QR-code screenshots and upgrade guidance.

## [0.3.0] - 2026-08-15

### Added

- **File understanding**: send a file to the bot and it will automatically download and understand its contents, supporting extract, read, analyze, and more.
- **Streaming replies**: replies are displayed incrementally in real time, no need to wait for full generation — a smoother, more natural experience.
- **Visible progress**: when the bot runs tasks (running commands, reading/writing files), you can see what it is doing — no longer a "black box".
- **Error feedback**: when a task ends abnormally, the bot clearly explains the reason, no more "half replies" or "no response at all".

### Improved

- Correctly displays the speaker's nickname in group chats instead of an unreadable string.
- Automatically clears group chat history after replying to avoid cross-conversation interference.
- Voice messages are recognized and kept as text only, without extra invalid links.
- The bot now "actually gets things done": for requests like "download, extract, install", it executes real tool actions instead of just restating the steps.

### Fixed

- Fixed the bot being unable to read/write files (the working directory was misconfigured).
- Fixed duplicate content and too-few chunks in streaming replies.

## [0.1.0] - 2026-08-14

### Added

- **First release**: QQ bot integrated with an AI assistant, supporting direct and group chats.
- **Model switching**: supports switching between different AI models.
- **Common commands**: built-in help, status query, session management, and more.
- **QR binding**: bind the bot by scanning a QR code on first use, with simple setup.

### Fixed

- Fixed config parsing issues.
