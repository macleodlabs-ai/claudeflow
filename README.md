<div align="center">

![Streams — one Claude Code session, many threads of work, untangled into live, colour-coded streams](assets/hero.jpg)

<h1>Streams</h1>

<p>
  <a href="LICENSE"><img alt="License: Proprietary" src="https://img.shields.io/badge/license-proprietary-7c83ff?style=for-the-badge"></a>
  <a href="https://github.com/macleodlabs-ai/claudeflow/releases"><img alt="Version 2.0.7" src="https://img.shields.io/badge/version-2.0.7-5fe4f2?style=for-the-badge"></a>
  <img alt="Claude Code 2.1.287+" src="https://img.shields.io/badge/Claude%20Code-2.1.287%2B-b9a2ff?style=for-the-badge">
  <img alt="Tests 285 passing" src="https://img.shields.io/badge/tests-285%20passing-2fd67b?style=for-the-badge&logo=checkmarx&logoColor=white">
</p>
<p>
  <a href="#-install"><img alt="Install: /plugin marketplace add macleodlabs-ai/claudeflow" src="https://img.shields.io/badge/%2Fplugin%20marketplace%20add-macleodlabs--ai%2Fclaudeflow-070a1f?style=for-the-badge&logo=gnubash&logoColor=white&labelColor=7c83ff"></a>
</p>
<p>
  <a href="#-install"><img alt="Installs" src="https://img.shields.io/endpoint?url=https%3A%2F%2Fraw.githubusercontent.com%2Fmacleodlabs-ai%2Fclaudeflow%2Fstats%2Finstalls.json&style=for-the-badge&logo=download&logoColor=white"></a>
  <a href="https://github.com/macleodlabs-ai/claudeflow/stargazers"><img alt="GitHub stars" src="https://img.shields.io/github/stars/macleodlabs-ai/claudeflow?style=for-the-badge&logo=github&color=ff94d1&label=stars"></a>
</p>
<p>
  <img alt="Claude Code mod" src="https://img.shields.io/badge/Claude%20Code-mod-b9a2ff?style=flat-square">
  <img alt="Platform macOS | Linux | Windows" src="https://img.shields.io/badge/platform-macOS%20%7C%20Linux%20%7C%20Windows-6ff0c0?style=flat-square">
  <img alt="TypeScript" src="https://img.shields.io/badge/TypeScript-strict-3178c6?style=flat-square&logo=typescript&logoColor=white">
  <img alt="Classifier Haiku" src="https://img.shields.io/badge/classifier-Haiku-f2d6a2?style=flat-square">
  <a href="https://github.com/macleodlabs-ai/claudeflow/issues"><img alt="Open issues" src="https://img.shields.io/github/issues/macleodlabs-ai/claudeflow?style=flat-square&color=ffb88a"></a>
  <a href="https://github.com/macleodlabs-ai/claudeflow/commits/main"><img alt="Last commit" src="https://img.shields.io/github/last-commit/macleodlabs-ai/claudeflow?style=flat-square&color=8a90c8"></a>
  <a href="https://macleodlabs.ai"><img alt="Made by Macleod Labs" src="https://img.shields.io/badge/made%20by-Macleod%20Labs-1a2050?style=flat-square"></a>
</p>

<p>
  <a href="#-install">Install</a> ·
  <a href="#-what-you-get">What you get</a> ·
  <a href="#-use">Use</a> ·
  <a href="#%EF%B8%8F-configure">Configure</a> ·
  <a href="#-troubleshooting">Troubleshooting</a> ·
  <a href="#-work-with-macleod-labs">Work with us</a>
</p>

<table>
<tr>
<td width="50%" valign="top">
<sub>STREAMS REMOTE</sub><br>
<b>Every session, on your phone.</b><br>
Answer Claude, approve prompts and send photos from your phone or tablet. End-to-end encrypted.<br>
<a href="https://streams.macleodlabs.com/?utm_source=github&utm_medium=readme&utm_campaign=streams"><b>Start the 3-day free trial →</b></a>
</td>
<td width="50%" valign="top">
<sub>MACLEOD LABS</sub><br>
<b>Built by the people who make Streams.</b><br>
Claude Code mods, agent workflows and AI tooling, built for your team.<br>
<a href="https://macleodlabs.ai/?utm_source=github&utm_medium=readme&utm_campaign=streams"><b>Work with us →</b></a>
</td>
</tr>
</table>

</div>

---

A real Claude Code session is never one task. You start a feature, ask a side question mid-turn, leave a `/loop` watching a deploy, and fan out three subagents to chase a bug. It all lands in **one transcript**, interleaved.

**streams**, the mod in this repository, sorts that work into **semantic streams** as it happens, and gives each one its own colour, status and history.

![The streams pane beside a transcript: coloured stripes per stream, live agent status, loop countdowns and the pill bar](assets/preview.jpg)

## ✨ What you get

<table>
<tr>
<td width="33%" valign="top">

### 🧭 Navigator pane
Every stream beside the transcript: its main turn and subagents with **live status**, what each is doing right now, elapsed time, tool count, and loop countdowns.

</td>
<td width="33%" valign="top">

### 💊 Pill bar
One pill per stream above the prompt, coloured by health. **Number keys** jump between them; `0` shows everything.

</td>
<td width="33%" valign="top">

### 🎨 Stream stripes
A thin pastel line down the left of every prompt, reply and tool row. **Focus** a stream and the rest fold to one-line stubs.

</td>
</tr>
<tr>
<td valign="top">

### 🧠 Semantic routing
Structure first (subagents, loops, follow-ups, `#tags` with autocomplete), then one small **Haiku** call for anything new. Prompts sent mid-turn go to the right stream.

</td>
<td valign="top">

### 🗂️ History, in parallel
Existing sessions are filed into streams in the background, with batched, **parallel** classification and a live progress line.

</td>
<td valign="top">

### 📦 Archive & fold
Hide finished streams with `✕` and bring them back later; finished streams left alone for a day archive themselves, and `✕ idle` clears every stream not running in one go. Fold any stream to its last 10 rows, last row, or header. Idle streams fold themselves.

</td>
</tr>
</table>

### 📋 Status card

Type `status` (the word on its own), or press `status` in the bar, and a card opens above the prompt with every piece of work in the session and where it stands. It is answered locally, so it costs no model call and works while a turn is running. Anything else, `status?` included, goes to Claude.

![The status card above the prompt: git branch and uncommitted files, then each stream as running, waiting for you, done or idle, with what it is doing](assets/status-card.jpg)

- **What needs you comes first**: running work, then loops, then streams **waiting for you** (their last reply ended on a question you have not typed past, shown as the detail; once you send any prompt, in any stream, earlier questions count as seen), then failures, then finished work.
- **Git rows on top**: the branch, whether anything is unpushed, and which files are uncommitted.
- **Tickets**: any ticket id you name in a prompt or an agent's task (`APP-260`, `ENG-1042`) gets its own row: running agents on it say what they are doing and how long they have been quiet; otherwise its latest news, or that its agent failed.
- **Plan limits at the bottom**: each window (5-hour, week) as a bar and percent, green, then yellow from 50%, red from 80%, with how long until it resets and the weekday and time it does.
- **Click a stream's name** to open it in the pane. `✕ close` (top right) or your next prompt hides the card.
- **Scroll a long card** with the wheel, or press <kbd>ctrl</kbd>+<kbd>x</kbd> <kbd>tab</kbd> to move focus to it: then <kbd>↑</kbd> <kbd>↓</kbd> scroll and <kbd>q</kbd> closes it, without touching Claude's turn.

### 📱 Streams Remote

Want your sessions on your phone? **Streams Remote** puts every running session on your phone and tablet: answer Claude, approve permission prompts, send prompts and photos, and share a project with a teammate. It is a paid add-on to this free mod, with a 3-day free trial.

<p align="center"><img src="assets/phone-app.jpg" width="300" alt="Streams Remote on a phone: a session's streams, a permission prompt with Allow and Deny, and a waiting question"></p>

<p align="center"><a href="https://streams.macleodlabs.com/?utm_source=github&utm_medium=readme&utm_campaign=streams"><b>Learn more and start the free trial →</b></a></p>

### 🔄 Updates without a restart

Once a session starts, and every six hours after, streams checks every plugin you have installed against its marketplace. When one has a newer release, an **⬆ update** button appears in the bar and the pane, and a toast says so. Pressing it (or <kbd>u</kbd>, or `/streams update`) installs the updates on your Mac and reloads plugins into the running session: no restart.

### Status at a glance

| Colour | Status | Meaning |
| :---: | --- | --- |
| 🟨 | **RUNNING** | A turn, subagent or loop is working now |
| 🟩 | **DONE** | Finished cleanly |
| 🟦 | **WAITING FOR YOU** | On the status card: the stream's last reply asked you something, and you have sent nothing since |
| 🟥 | **ERROR** | A subagent or turn failed |
| 🟧 | **STALLED** | No activity for longer than expected |
| ↻ | **LOOP** | A `/loop`, cron or Monitor is armed, with a countdown to the next tick as the runtime clamped it (a cron's from its schedule) and why. Ticks that changed nothing fold into one line, `··· 3 quiet ticks · last change 12:04 "PR merged"`. A loop that stops, is deleted, or lapses 10 minutes without re-arming, drops back to its stream's status |

---

## 🚀 Install

```bash
claude plugin marketplace add macleodlabs-ai/claudeflow
claude plugin install streams@claudeflow
```

<details>
<summary><b>From inside Claude Code</b></summary>

```text
/plugin marketplace add macleodlabs-ai/claudeflow
/plugin install streams@claudeflow
```

</details>

New sessions load it automatically; in a running session, run `/reload-plugins`. The pane opens by itself in fullscreen terminals at least **144 columns** wide. Anywhere else, type `/streams`.

> [!TIP]
> **Several Claude Code accounts?** Plugins install per account, so sign in to each one and run the install there (or, if you use [claude-sessions](https://github.com/macleodlabs-ai/claude-sessions), once from each `cc-<client>` launcher).

<details>
<summary><b>From a local checkout</b> (live edits, no reinstall)</summary>

Add the folder as the marketplace. Claude Code reads it straight from disk, so `/reload-plugins` picks up your changes:

```bash
git clone https://github.com/macleodlabs-ai/claudeflow
claude plugin marketplace add ./claudeflow
claude plugin install streams@claudeflow
```

Or for one session only, without installing:

```bash
claude --plugin-dir ./claudeflow/plugins/streams
```

</details>

**Want streams on your phone or tablet?** That is [Streams Remote](https://streams.macleodlabs.com/?utm_source=github&utm_medium=readme&utm_campaign=streams), with a 3-day free trial.

### Update or remove

| Action | Command |
| --- | --- |
| Update | `claude plugin update streams@claudeflow` |
| Uninstall | `claude plugin uninstall streams@claudeflow` |

---

## 🎛 Use

### Commands

| Command | What it does |
| --- | --- |
| `status` or `status?` | Show the status card above the prompt: every stream's state (running, loop, waiting for you, done) and what it is doing, plus git branch and uncommitted files. Answered locally: no model call, works mid-turn |
| `/streams` | Open the navigator pane |
| `/streams status` | Same as typing `status` |
| `/streams archive idle` | Archive every stream not running a turn (restore from `▸ archived`) |
| Streams Remote's commands | See [streams.macleodlabs.com](https://streams.macleodlabs.com) |
| `/streams update` | Check every installed plugin for a newer release, install them, and reload plugins into this session, no restart |
| `/stream <name>` | Focus one stream; others fold to stubs |
| `/stream off` | Show every stream again |
| `/stream move <name>` | Refile the last prompt, and everything after it, under another stream (created if new) when it was sorted wrongly |
| `/stream` | List streams with their summaries |
| `/streams import` | List this project's past sessions |
| `/streams import <id>` | File a past session into streams (re-importing replaces, never duplicates) |

### In the pane and bar

| To | Do |
| --- | --- |
| See the status of all work | Press `status` in the bar (<kbd>t</kbd> when the bar has focus), or type `status` on its own. Click a stream's name on the card to open it; `✕ close` or your next prompt hides it |
| Focus a stream | Click its name in the pane, or press its pill |
| Show everything | `← all streams`, or the `all` pill |
| File a prompt by hand | Start it with `#name`, e.g. `#billing why is the total off?` Type `#` and the bar lists matching streams; <kbd>tab</kbd> completes the first |
| Fold a stream | `▾ all` cycles **all → last 10 → last 1 → header only** |
| Archive or restore | `✕` beside a stream; `▸ archived (N)` lists them |
| Archive all idle | `✕ idle (N)` at the top of the pane, or `/streams archive idle`: every stream not running a turn |
| Collapse everything | `collapse all` / `expand all` at the top of the pane |
| Fold the pane away | `⇥ hide` (<kbd>h</kbd>) folds the docked pane to a `◂ streams` tab at the right of the bar; the tab (<kbd>s</kbd>) brings it back at the width it had. It stays folded in new sessions until you open it |
| Switch a stream's chat view | The stream header shows `view ◉ full ○ compact`: full draws the chat as the session does, with markdown, syntax-highlighted code and diffs; compact is one line per row. Every card in the all-streams list has the same `◉ full ○ compact` beside its fold and `✕`, and its recent rows follow it: it is one choice for the whole pane. Click either, or press <kbd>v</kbd> in the pane |

### Keyboard

| Keys | Action |
| --- | --- |
| <kbd>ctrl</kbd>+<kbd>x</kbd> then <kbd>tab</kbd> | Move focus to the pill bar |
| <kbd>0</kbd> | All streams |
| <kbd>1</kbd>–<kbd>9</kbd> | Jump to stream *n* |
| <kbd>s</kbd> | Open the pane |

Streams persist **per project directory**, across sessions.

---

## ⚙️ Configure

Settings live in `/config` under **streams**, or in `settings.json`:

```json
{
  "pluginConfigs": {
    "streams@claudeflow": {
      "options": { "autoArchiveHours": 24, "chatStyle": "full", "completionCheck": true, "diagnostics": false }
    }
  }
}
```

| Setting | Default | Description |
| --- | :---: | --- |
| `autoArchiveHours` | `24` | A finished stream (by its status, or found finished by the completion check) with no activity for this many hours archives itself. It stays under `▸ archived` in the pane, and a restored one stays until it has been active again. Never a running, waiting, looping or failed stream. `0`: off. |
| `chatStyle` | `full` | How the pane draws a stream's chat, in its own view and in each card's recent rows: `full`, as the session draws it, with markdown, syntax-highlighted commands and file contents, and edits as coloured diffs; or `compact`, one line per row. The `◉ full ○ compact` switch on a stream's header or any card's header changes it for the session. |
| `completionCheck` | `true` | Streams that show WAITING or stalled are sent to Haiku in one small call (when the session starts, after a turn ends while idle, when the status card opens, and for any stuck 5 minutes). One it finds finished shows DONE with `checked ✓` and the reason, in the terminal, the pane and on the phone. A stream is asked again only after something new happens in it; with nothing waiting or stalled, no call is made. |
| `diagnostics` | `false` | Writes `debug.json` into the plugin folder every few seconds: what the pane last drew, rows it could not place, and the last background error. Turn on only when troubleshooting. |

### Model use

| Event | Haiku requests |
| --- | --- |
| New prompt | 1 |
| Follow-up (`yes`, `continue`), slash command, `#tag`ged prompt | 0 |
| Filing history | 1 per 25 prompts, plus 1 merge pass, plus 1 per turn that had a mid-turn prompt |

---

## 🧪 Develop

| Part | Where | Check |
| --- | --- | --- |
| The streams mod | `plugins/streams` | `claude plugin test .` (285 tests) and `claude plugin validate --strict .` |

---

## 🩺 Troubleshooting

| Symptom | Fix |
| --- | --- |
| No pill bar | It appears once the first prompt is sorted. Check `/plugin` lists **streams** as enabled. |
| Pane doesn't open | The terminal is under 144 columns or not fullscreen. Type `/streams`. |
| Dim `streams: …` line in the transcript | Claude Code is reporting a failed hook; the line names it. Include it in an issue. |
| Older rows have no stripe | History is still filing; watch the progress line at the top of the pane. |

---

## 🤝 Work with Macleod Labs

<table>
<tr>
<td>

**Streams is built by [Macleod Labs](https://macleodlabs.ai).** We build Claude Code mods, agent workflows and AI tooling for engineering teams: custom plugins, multi-agent pipelines, and getting your team productive with Claude Code.

<a href="https://macleodlabs.ai/?utm_source=github&utm_medium=readme&utm_campaign=streams"><img alt="Hire Macleod Labs" src="https://img.shields.io/badge/Hire%20Macleod%20Labs-%E2%86%92-7c5cff?style=for-the-badge&labelColor=12164a"></a>

</td>
</tr>
</table>

---

<div align="center">

**Proprietary** · © 2026 [Macleod Labs](https://macleodlabs.ai) · See [LICENSE](LICENSE)

</div>
