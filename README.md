# claudeflow

Mods for [Claude Code](https://code.claude.com) by MacLeod Labs. This repository is a Claude Code plugin marketplace; today it holds one mod, **streams**.

## streams

A single Claude Code session ends up doing several things at once: you ask about one feature, slip in a side question mid-turn, a `/loop` keeps ticking, and subagents fan out. All of it lands in one transcript, interleaved. **streams** sorts that work into semantic streams and shows each one on its own.

- **Semantic routing.** Each prompt is filed into a stream: short follow-ups ("yes", "continue") stay on the current one, everything else is classified by one small Haiku call against your open streams. `#name` at the start of a prompt picks the stream by hand (the tag is stripped before Claude reads the prompt).
- **Mid-turn prompts.** A prompt sent while Claude is working gets its own stream without hijacking the running turn; the reply that answers it is moved to that stream once it arrives.
- **Subagents and loops.** Subagents inherit the stream that spawned them; every tick of a `/loop` lands in one stream; background-task notifications go back to the stream that started the task.
- **Navigator pane.** Every stream with its live status, its main turn and subagents (solid badges: yellow running with a live clock and what it is doing, green done, red error), active loops with a countdown, and its recent activity. Click a stream to open it and focus the transcript on it.
- **Status bar.** One colour-coded pill per stream above the prompt; number keys jump to a stream.
- **Transcript stripes.** Every prompt, reply and tool row in the main chat gets a thin line in its stream's pastel colour. Focus a stream and the other streams' rows collapse to one-line stubs (ctrl+o expands; the model's context is untouched).
- **Collapse and archive.** Fold any stream to its last 10 rows, last row or header; idle streams fold themselves after ten quiet minutes and open again when they wake. `✕` archives a stream (restore it later; a new prompt for it brings it back).
- **History.** Streams persist per project directory, and the current session's transcript is filed into streams when the mod loads, so starting it mid-session loses nothing.

### Install

The repository is private: you need read access to `macleodlabs-ai/claudeflow` and a GitHub login git can use (for example `gh auth login`).

```sh
claude plugin marketplace add macleodlabs-ai/claudeflow
claude plugin install streams@claudeflow
```

Or inside Claude Code: `/plugin marketplace add macleodlabs-ai/claudeflow`, then `/plugin install streams@claudeflow`. Restart the session (or run `/reload-plugins`) and the bar appears once your first prompt has been filed.

To try it from a checkout without installing: `claude --plugin-dir ./plugins/streams`.

### Use

| You want to | Do |
| --- | --- |
| See every stream | `/streams` opens the navigator pane (it opens by itself on a wide terminal) |
| Focus on one stream | Click its name in the pane, press its pill in the bar, or `/stream <name>` |
| Show everything again | `← all streams`, `show all`, the bar's `all` pill, or `/stream off` |
| File a prompt by hand | Start it with `#name`, for example `#billing why is the total off?` |
| Fold a stream | The `▾ all` button cycles all → last 10 → last 1 → header only |
| Archive / restore | `✕` next to a stream; `▸ archived (N)` at the bottom of the pane lists them |
| Use the bar from the keyboard | ctrl+x then tab focuses it; `0` all, `1`–`9` streams, `s` the pane |

**Cost.** Classifying a prompt costs one small Haiku request; follow-ups and `#tag`ged prompts cost nothing. Filing a session's history costs one request per prompt plus one per turn that had a mid-turn prompt.

### Develop

```sh
cd plugins/streams
claude plugin validate .        # what the engine will load, and anything it would refuse
claude plugin test .            # the mod's tests, run against the engine
```

`tests/snapshot.test.ts` draws the navigator pane as text at 40, 60 and 90 columns; read its output to judge layout.

In a session where the mod is hot-reloaded, a dim `streams: reload failed` line in the transcript means the new version was refused and the old one is still running. One rule neither `validate` nor the tests catch: every function that takes `$` must have a name used nowhere else in the module (no local variable may share it).

## Listing on a mod directory

_Filled in below once confirmed against the current Claude Code docs._

## Charging for a mod

_Filled in below once confirmed against the current Claude Code docs._
