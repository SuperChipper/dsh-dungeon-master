# DSH Dungeon Master

**[简体中文](./README.md) | English**

**An AI dungeon master that runs D&D 5e in QQ groups.** This is a fork of [tencent-connect/dsh-qqbot](https://github.com/tencent-connect/dsh-qqbot): send `/dnd start` in a group and the bot becomes that group's DM. Dice, checks, initiative, positions and hit points are all resolved by tools; the model only tells the story.

> Installation, QR-code binding, the base config options, built-in commands and the overall architecture are unchanged from upstream: see the **[upstream README](https://github.com/tencent-connect/dsh-qqbot#readme)**. This document is mostly about campaigns; the other additions are listed briefly [at the end](#other-features).

## Start a game in three steps

1. Install the plugin as described in [Running locally](#running-locally) and add the bot to a group.
2. Send `/dnd start` in the group. The message carries check-in buttons and the game opens when everyone is in; if someone can't make it, click "Start".
3. @ the bot and say what your character does: "Kaes swings his greatsword at goblin 3", "Enzo sneaks to the door and listens".

There is no preset switch and no new session: while a campaign is active, every turn gets two extra system prompts (the DM rules and a compact campaign state), and `/dnd end` returns the bot to normal chat.

---

## 🎲 Campaigns

### Design principles

- **Every ruling goes through a tool.** Dice, checks, damage, HP, conditions, positions and resources only change through `dnd_*` tools; the model cannot make up a roll.
- **Secrets stay out of reach.** DM notes and secret doors only appear in tool results, and `dnd_*` results are never shown in the group. Monster AC, HP and DCs are kept out of routine tool results and the campaign state too: those give only success or failure and a wound word (unhurt / lightly hurt / badly hurt / barely standing). When a ruling needs the numbers, the DM looks them up with `dnd_character show`.
- **Only a PC's own player can act for it.** PCs are bound to their player's openid. The tool also checks that this person really sent a message recently, so the model can't impersonate someone by copying an openid.
- **Strict turn order.** In combat only the creature whose turn it is can act, and only a PC's own player can end that PC's turn.
- **State lives in the save file, not in the model's memory.** The full state is one JSON file and each turn gets only a compact summary. Anything that has to survive context compaction, such as positions and pending reactions, is in that summary instead of relying on a paraphrased recap.
- **Wrong rulings can be rolled back.** Every change leaves a snapshot, and you can undo by step count or by roll number.

### Player commands

| Command | What it does |
|---------|--------------|
| `/dnd start [module id]` | Start a campaign (an earlier campaign in the same module resumes); the message carries check-in buttons and the game opens when everyone is in |
| `/dnd new [module id] [blank]` | Archive the old campaign and start fresh (keeps the old character sheets unless you add `blank`) |
| `/dnd status` | Campaign state from the players' point of view: HP, resources and initiative order, plus your distance to everyone in combat |
| `/dnd map [battle\|explore]` | Send the map: the battle map in combat, otherwise the fog-of-war map of what has been explored |
| `/dnd checkin` | Re-send the check-in buttons |
| `/dnd end [recap]` | Save a handoff and pause, preserving combat; saying you're stopping for tonight also works |
| `/dnd dungeons` | List available modules |
| `/dnd search <term>` | Look up the [Huiji D&D wiki](https://dnd.huijiwiki.com/wiki/) (spells, skills, classes, feats, monsters…) |
| `/dnd spells [class]` | A class's spell list |
| `/dnd help` | How to play |

### How a session runs

- **Declaring actions.** Only @-ing the bot and saying what your character does counts as an action. Chatting, rules questions and "show me the status" don't roll dice or use up your action. You can only control your own character.
- **Turn buttons.** When it's a PC's turn, the bot sends a message with buttons after the DM's reply.
  - **End turn** only works for the PC's own player; after the click the tool advances initiative and the DM resolves the monsters' turns.
  - **Status** is answered directly by the tool, without the model.
  - **My spells** lists the clicker's own spells and slots, each with a wiki link.
  - **Act** fills the character's name into the clicker's own input box.
  - The bot needs message-button permission on the QQ Open Platform. If sending buttons fails, they switch off for the rest of that run and the game continues in plain text.
- **Reaction windows.** When someone could react, an attack only rolls and is held as pending until that player answers (Shield, Vicious Mockery, a Chronal Shift reroll). If nobody answers, the DM skips them.
- **Splitting up.** Only the characters who said they're going move; everyone else stays put, and the map marks every occupied room with a head count.
- **Rollbacks.** If the table agrees something was resolved wrongly, say "roll back to before X". The DM restores a snapshot instead of patching numbers by hand.
- **Ending and resuming.** Pausing writes a handoff (location, what just happened, declared actions, who is with whom, loose ends, where to pick up). Initiative, positions and pending reactions are kept as they are, and the next `start` carries on. While paused, the bot doesn't spoil the module and checks the ledger before answering questions about the game.

### Maps and combat positions

- **Positions in combat.** One square is 5 feet, and each room gets a battle map (walls, doors, the corridor outside, obstacles, difficult terrain). Movement follows intent (close on someone, hold the door, move away, dash, drag someone, disengage), paths around walls, costs double in difficult terrain, reports opportunity attacks when leaving reach, and checks distance and walls on attacks.
- **Area spells.** Spheres, cubes and lines can be checked for which friends and foes they cover before casting.
- **Image maps** (need the optional dependency `sharp`). In combat the bot sends the current room's battle map with positions and coordinates, on the module's own art if it has any. Otherwise it sends the fog-of-war map of what has been explored, using the book's player map when there is one. Without `sharp` it falls back to a character map in chat.

### DM tools

| Group | Tool | What it does |
|-------|------|--------------|
| Dice | `dnd_roll` | Any dice expression (`2d6+3`, `4d6kh3`…) |
| | `dnd_check` | Skill/ability checks, saves, attacks, death saves; hidden DC/AC, damage applied on a hit, a failed save can add a condition; every roll gets a `#R` number |
| | `dnd_apply` | Damage (type/crit), healing, temp HP, conditions; adjusts a held attack, save or check, or rerolls its d20, before committing it |
| Characters | `dnd_character` | Create/edit sheets (player binding, weapons, spell list, items and gold); `srd=goblin count=3` adds monsters with real SRD stats |
| | `dnd_resource` | Spell slots, Lay on Hands, Bardic Inspiration, class feature uses |
| | `dnd_rest` | Short rest (the tool rolls hit dice) / long rest |
| Combat | `dnd_initiative` | Initiative start / next / goto / end / status; `surprised` creatures are skipped in round 1 by the tool |
| | `dnd_position` | Positions in combat: draw the battle map, place tokens, move within a turn, query distances, `area` for area spells |
| Exploration | `dnd_move` | Room movement (`who` for splitting up, secret-door discovery); returns the player-facing description plus DM secrets |
| | `dnd_map` | Send the battle map or the fog-of-war map to the group |
| Story | `dnd_story` | Change story state written into the module, by id: triggers, facts, quests, whether an NPC is alive or travelling with the party |
| | `dnd_lookup` | Read module details (rooms, NPCs, clues), for the DM only |
| | `dnd_hook` | Backstory hooks: unresolved threads from a character's past sit on the PC sheet, remind the DM when a trigger word comes up, and escalate through 5 tiers |
| | `dnd_chronicle` | Long-term story ledger: improvised facts, promises, prisoners and loose ends, searchable by keyword; still available while paused |
| Saves | `dnd_undo` | List recent changes / undo N steps / take back one roll by number along with everything after it |
| | `dnd_progress` | Save progress without pausing, edited section by section |
| | `dnd_prepare` | Private DM prep: check the state against the handoff and save candidate plans; doesn't advance the story or post to the group |
| | `dnd_end` | Shares the save-and-pause operation with `/dnd end` |
| Lookup | `dnd_srd` | Look up 5e SRD monsters/spells (dnd5eapi.co) |

The tool layer also handles some rules automatically: PCs dropping to 0 HP and death saves, instant death from overflow damage, doubled dice on a crit, and Undead Fortitude. Manually removing "dead" is refused.

### Modules

- **Built-in "The Sunken Bell Abbey".** An original 7-room dungeon for 3–5 characters of level 1–3, playable in one evening. Monster stats are from SRD 5.1 (CC BY 4.0).
- **Writing your own.** Put JSON in `<dnd.root>/adventures/`: one file for a small module, one file per site for a large one. Files are re-read when they change, with no restart. A module can define chapters, sites, rooms, NPCs (including `knows`: what they know and what they don't), clues, quests, triggers and battle maps. The full format is in the **[module authoring guide](./docs/dnd-module-authoring.md)** (Chinese).
- The old single-dungeon format (`dungeons/*.json`) still works.
- **Copyright.** Text converted from commercial modules (such as *Lost Mine of Phandelver*) stays on your own machine. Don't commit it to the repo.

### Data and configuration

- Each group has one save file, `<dnd.root>/campaigns/<chat>.json`, with change snapshots in `campaigns/history/` (the last 40 steps). Saves can only be changed through `dnd_*` tools; file tools cannot write to them.
- `dnd_*` tools are only visible to QQ chats that have a campaign. Chats without one don't carry them (saving roughly ten thousand tokens of tool definitions), a paused campaign keeps only the ledger, prep and handoff tools, and `/dnd start` makes all of them available.
- How state survives compaction and pauses, and the incidents that shaped it, is written up in the **[long-lived campaign state notes](./docs/dnd-long-lived-state.md)** (Chinese).

| Option | Default | Description |
|--------|---------|-------------|
| `dnd.enabled` | `true` | Campaigns on/off (`/dnd` command + `dnd_*` tools) |
| `dnd.root` | `cwd/dnd` | Data directory for saves and modules |
| `dnd.turnButtons` | `true` | Send turn buttons when it's a player's turn |
| `dnd.interjections` | `true` | Keep making random remarks during a campaign (remarks only, nothing is resolved); off means the bot only answers @ |

---

## Other features

Besides campaigns, this fork adds the following on top of upstream. Every option is documented on the QQ bot settings page under "Plugins" in DSH Web.

| Area | Contents |
|------|----------|
| 💬 Group chat | Joins in without an @ by probability or a reply-desire score; group messages are persisted and survive restarts; sees earlier images; merged messages keep each sender; automatic compaction when context grows too large; `/new` compacts the old session first and carries the summary into the new one (`/new blank` starts from nothing) |
| 🧠 Memory | A Markdown notes library under `notes/`, shared by every session and recalled by content; `chat`-scoped notes are visible only in their own group. The owner can send `/bot-notes` in a private chat to see what gets injected |
| 😺 Stickers | Saves stickers based on the bot's mood (`qqbot_save_sticker`), matches by hash (`qqbot_match_sticker`), a meme-recognition skill |
| 🖼 Media | Text and media in one message (`caption`), native image input via `deepseek-native`, voice recognition, whole-video understanding with keyframe review, audio transcription, images inside forwarded chat records |
| 🔧 Tools | Reverse image search, read-only Bilibili tools, fanart picker, Playwright browser (off by default, granted per group), agent temp directory and scheduled cleanup (`/bot-cleanup`) |
| ⏰ Schedules | Scheduled tasks migrate on `/new` and persona switches; failed proactive group messages are resent later |
| 🔁 Models | Upstream status monitoring with automatic primary/backup model switching (`modelFailover`, off by default) |
| 🧩 DSH integration | Install, enable and configure from the "Plugins" page in DSH Web; pet balance works with `deepseek-native` |

### Permissions

- An empty `allowlist` rejects everyone (fail-closed). `/model`, `/preset` and approval buttons only work for `ownerOpenid` / `adminOpenids`.
- **Per-chat tool limits** (`toolAccess`, on by default). The owner's private chat and allowlisted chats are unrestricted. Other QQ chats get no terminal and no sub-agents, and file tools can only touch media, the sticker library, the temp directory and `toolAccess.readRoots`. Local sessions (Web/Desktop) are unaffected.
- The owner can say "give group XX a terminal" in a private chat to allowlist it. In a group the model can only file a request, which the owner approves by clicking a button.
- Paths in `fileAccess.sensitivePaths` are always blocked for restricted chats, even inside `readRoots`. Allowlisted chats have a terminal anyway, so they are not blocked. With `toolAccess` turned off, the paths are blocked for every QQ chat.
- Bilibili login and subtitles are limited to the owner/admins in private chat. Reverse image search uploads the image to third-party services, so it is only called when a user explicitly asks for a source.

> Shared notes are visible to every session, so something said in a private chat can be recalled in a group. Don't have the bot remember private information, and the owner should review `notes/` from time to time.

## Running locally

```bash
pnpm install && pnpm build
npx @deepseek-ai/dsh plugin --profile qqbot add /path/to/dsh-dungeon-master
npx @deepseek-ai/dsh --profile qqbot
```

The plugin loads from `dist/`: after changing code, run `pnpm build` and **restart dsh** for it to take effect. Image maps need the optional dependency `sharp`, and the video tools need ffmpeg/ffprobe. Other installation methods are in the upstream README.

## Security and privacy

- Keep credentials in the profile's `cordis.patch.yml` or in environment variables, never in the repo.
- Runtime data stays out of the repo: `media/` (attachments from group and private chats, which may involve other people's privacy), `stickers/`, `notes/`, `dnd/`, `tmp/`.
- Check `git status --short` and `git diff --cached` before committing.

## Credits and license

- Upstream: [tencent-connect/dsh-qqbot](https://github.com/tencent-connect/dsh-qqbot) (MIT)
- Host: [deepseek-harness](https://github.com/deepseek-ai/deepseek-harness)
- Monster and spell data: System Reference Document 5.1 (Wizards of the Coast, [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/))
- Rules reference: [Huiji D&D wiki](https://dnd.huijiwiki.com/wiki/)
- Bilibili API approach based on [dsh-bili-scroll](https://github.com/c1overzz/dsh-bili-scroll) (MIT)

[MIT](./LICENSE)
