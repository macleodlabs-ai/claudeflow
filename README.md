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

## Listing in Anthropic's plugin directory

There is no separate directory for mods: a mod is a plugin, and it is listed the same way. Anthropic's directory is browsable at [claude.ai/directory](https://claude.ai/directory) (also [claude.com/marketplace/plugins](https://claude.com/marketplace/plugins)); submissions go through [claude.ai/directory/manage](https://claude.ai/directory/manage). Re-read [the submission guide](https://claude.com/docs/plugins/submit) before submitting: the process below was current in October 2026 and may have changed.

### Before submitting

1. **Remove the development diagnostics.** `writeDiagnostics` in `plugins/streams/hooks/register.tsx` writes `debug.json` into the plugin's own folder every five seconds. That is for development only and must not ship: delete it, its call in `beat`, and the `noteMatched` / `noteUnmatched` calls.
2. **Bump the version** in `plugins/streams/.claude-plugin/plugin.json` and give it an `author` with a contact email and a `homepage` or `repository`.
3. **Pass strict validation and the tests:**
   ```sh
   claude plugin validate --strict plugins/streams
   claude plugin validate --strict .
   claude plugin test plugins/streams
   ```
4. **Be ready to explain what the mod does with data.** Reviewers will see from validation that it calls the model (`$.model.complete`: one small Haiku request per classified prompt, billed to the user), reads the session's transcript file (`$.fs.read`, to file history into streams) and keeps per-project state (`$.store`). Nothing leaves the user's machine apart from those model requests. Say so in the listing.
5. **Add screenshots** of the bar, the navigator pane and the transcript stripes.

### Submitting

1. Sign in to [claude.ai/directory/manage](https://claude.ai/directory/manage). A paid claude.ai plan (Pro or above) is required.
2. Give it the repository URL (`https://github.com/macleodlabs-ai/claudeflow`). The repository may stay private while it is validated; grant the access the portal asks for.
3. Run its validation, then answer the compliance questionnaire.
4. Anthropic runs a security scan and a reviewer approves or returns it with notes.
5. Publish it yourself or choose auto-publish. Claude Code users then get it as `streams@synced` once it syncs to their account.

### Without the directory

Anyone with read access can already install it straight from this repository (see [Install](#install)). Docs: [creating a marketplace](https://code.claude.com/docs/en/plugins/create-marketplace.md), [hosting one](https://code.claude.com/docs/en/plugins/host-marketplace.md). Private repositories work: Claude Code fetches them with the user's own git credentials, so each user needs GitHub access and either an SSH key in `ssh-agent` or an HTTPS credential helper (`gh auth setup-git`).

## Charging for a mod

Neither Claude Code nor Anthropic's directory offers paid listings, licensing or revenue share. The terms ([Anthropic Software Directory Terms](https://support.claude.com/en/articles/13145338-anthropic-software-directory-terms)) do not provide for selling through the directory, so a paid mod is distributed outside it. Ways to charge:

| Model | How | Trade-off |
| --- | --- | --- |
| **Paid access to this private repository** | Sell a subscription (Stripe, GitHub Sponsors tiers, Lemon Squeezy); on payment, add the buyer to a GitHub team with read access; remove them when it lapses | Simplest, nothing to build in the mod. The code is readable by every buyer, and a lapsed buyer keeps the copy they installed |
| **License key in the mod** | Declare a secret `userConfig` field (`licenseKey`); the mod checks it with your licensing server via `$.http` on load and runs in a limited mode without one | Works with any distribution, even a public repo. The check runs in readable code, so it deters rather than prevents |
| **Free mod, paid service** | Keep the mod free and listable; charge for something it connects to (team-wide stream sync, a hosted dashboard) | Fits the directory and reaches the most users; needs a service worth paying for |

A sensible path is to list **streams** for free to build an audience, and sell a team edition (shared streams across a team's sessions, the web dashboard planned in Phase 2) behind paid repository access or a license key.
