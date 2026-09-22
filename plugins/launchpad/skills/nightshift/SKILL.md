---
name: nightshift
description: The overnight worker — drain a project's task backlog with Claude while the user sleeps, and report honestly in the morning. Use when someone wants autonomous overnight work, asks why last night produced nothing, wants to queue an idea for tonight, or asks about heartbeat.
---

# launchpad: nightshift

<!-- launchpad:standing-rules -->
## Standing rules — identical in every launchpad skill

1. **Never print a secret value.** Finding a credential — in a `.env`, a key
   file, a keystore, a token in a log or a CI variable — you name the **file**
   and the **key name** and stop. Never the value, never part of one, never a
   prefix, a suffix, a length or a hash, and not "just to show the problem".
   Do not open a `.env` at all: the key names are in `.env.example`, and the
   strongest guarantee is not looking. `launchpad report` is built so a paste is
   safe in public, and a transcript quoting the value throws that away. An
   exposed key is fixed by rotating it, never by displaying it.
2. **"It's broken" / "it's not working" / "help" → `report` first.** Run
   `node "${CLAUDE_PLUGIN_ROOT}/dist/cli/index.js" report`, or ask the user to
   run it and paste the output, before any diagnostic question. One paste
   replaces ten questions; it is free, needs no network, and is redacted, so it
   is safe to share. One clarifying question alongside it is fine; a list of
   questions instead of it is not.
3. **We decide; they are not asked to choose.** The CI provider, the signing
   model, the bundler, the runner and the trigger shape are launchpad's calls —
   not having to make them is what was bought. Stop only for money, a secret,
   something that already works, or an act that is irreversible or public.
4. **Read the detected state before promising anything.** A surface's
   `archetype` and `framework` decide whether a pipeline exists at all
   (`launchpad detect` prints both as JSON and writes nothing;
   `.launchpad/state.yml` holds them after `setup`). Where launchpad refuses a
   surface, relay that refusal — what was found, why there is no pipeline, and
   what the user still gets — rather than paraphrasing it, planning around it,
   or hand-writing the pipeline launchpad declined to write.
<!-- /launchpad:standing-rules -->

Nightshift takes a per-project backlog and works it overnight: one task at a time, gated by the project's own check command, committed and pushed only when that gate passes. It is what "builds your apps while you sleep" actually means.

> ## ⚠ Nightshift is a BETA feature
>
> **Say so, out loud, before anyone enables it.** Not in passing — as a sentence they have to
> respond to. It has never completed a full successful night end to end, and it is the only part
> of launchpad that writes code to a repository unattended. A data-loss bug in its task writer was
> found and fixed as recently as this month.
>
> It is not billed as part of the licence price and must never be presented as a headline feature. Anyone
> turning it on is helping test it, and is entitled to know that.
>
> **What that means in practice:** recommend it only on a repo where a bad pull request costs
> nothing. Never on the app someone is about to ship. If they ask for it on their main product,
> say plainly that it is beta and offer a scratch repo instead.

**It is opt-in per project, and it defaults to opening pull requests rather than pushing to the main branch.** An agent that pushes to `main` unattended is a reasonable choice for someone who built the system; it is not a reasonable default for someone who just installed it.

## Reporting the truth about last night

This is the part that matters most, because the previous generation of this system got it wrong in a way nobody could see.

**An outcome is derived from observable facts, never from the agent's own claim.** The old version read the result out of the task file's `status:` field — which the agent itself wrote. Nothing checked that the project's gate passed, that a commit landed, or that a push succeeded. An agent that marked its own homework `done` was reported as a success, and the morning email described work that did not exist. The email was not lying; it was faithfully reporting a claim.

So when summarising a night, use these words and no stronger ones:

| Outcome | Means |
|---|---|
| `pushed` | a commit landed **and** reached the remote **and** the gate passed |
| `committed` | committed locally, **not** pushed — nobody else can see it |
| `blocked` | the agent ran and deliberately gave up on this task |
| `no-change` | the agent ran honestly and produced nothing |
| `infra-failed` | the agent never really ran — **not** the task's fault |
| `timed-out` | hit the per-task limit |

**Never say "shipped."** A push is not a release. The old summary counted commits and called them shipped.

## Why a night produces nothing — check these in order

1. **Is anything enabled?** A fire with zero enabled projects is a configuration state, not a successful run. The old orchestrator logged `fire: projects [ ]` followed by `fire complete` every 30 minutes for weeks, which reads exactly like an idle night. If the user says "it does nothing", check this first — it is the most likely answer and the least visible.
2. **Did the agent actually run?** A task that "ran" for 2–4 seconds and produced no diff did not run. Auth expiry, a usage limit, a rate limit and a network failure all present this way.
3. **Was the machine awake and online?** The worker only runs while the host is up.
4. **Is the queue empty?** A finished backlog is a good outcome, and should be reported as one.

## The rule that protects the backlog

**A transient failure must never block a task.** The old drain auto-blocked after two attempts that made no progress, *regardless of cause*, then committed and pushed that block.

Replayed against the real night of 2026-07-12: **16 legitimate tasks were permanently blocked and pushed to `main`** because the agent could not start. The current policy classifies those same runs as infrastructure failures, retries with backoff, and **aborts the whole drain after three in a row** — because if the agent cannot run, no other task will fare better, so burning through the queue blocking everything is the worst available move. On that night it would have stopped after the sixth event with the backlog intact.

When you see a task blocked with no useful reason attached, suspect this and check whether the run was long enough to be real.

## Queueing work, and grooming it

An idea goes into the project's inbox as one line. Grooming turns that line into a task the drain can actually take, because **the drain only ever runs `ready` tasks** — an idea nobody scoped is not work, and running one overnight is how an agent spends four hours on something nobody wanted.

Grooming is two halves, and the split matters:

1. **Capture** is mechanical. Every inbox line becomes a task file at `status: idea`. No agent, no cost, no judgement. It runs first and it runs even when the window has already closed, because it is the only step that loses data if it is skipped.
2. **Scoping** runs the agent, once per task, with a brief that says *rewrite this one file, write no code*. It sets `ready` (scoped and safe to run unattended), `scoped` (understood but too big for one night), or `blocked` with a reason (needs a decision, a credential, or a person).

**A task the agent could not scope stays where it is.** That is a correct outcome, not a failure, and it is reported — forcing a vague idea to `ready` is the expensive mistake here.

**The scoping agent is checked, not trusted.** Everything it wrote is diffed against the backlog directory afterwards, and an attempt that touched anything else is discarded whole. A grooming pass that starts implementing has produced a code change that went through no gate at all.

Grooming is **off by default** (`groom: false`) and capped at `maxGroomPerNight` (default 5). A 300-task backlog would otherwise spend the entire window grooming and never build anything. When enabled it runs at the start of the night, before the drain, so an idea captured this afternoon can be built tonight.

When the user gives you an idea for later, add it to the inbox and confirm it landed.

## Running something after the night's work

`postDrain` hooks run once, after the drain, for things the repo does itself — a deploy, a doc regeneration, a notification.

```yaml
postDrain:
  - run: ./hb deploy
    whenPathsChanged: ['apps/mobile/']
    timeoutS: 1800
```

Three rules, each of which exists because the obvious version is wrong:

- It fires on **committed** paths, never on what the agent merely touched. Work that failed the gate was reverted, and deploying it would ship exactly what the gate refused.
- **No commits, no hook.** Otherwise a quiet queue redeploys the same build every morning forever.
- A night that landed work and *then* aborted on infrastructure failure **skips its hooks and says so**. Deploying from a machine that just failed to start the agent three times is the least useful thing it could do next.

A failed hook appears in the headline and the warnings, and does **not** change any task's outcome. The commits landed; the delivery did not. Those are different facts and the report keeps them apart.

## Safety rails to confirm before enabling it

- **PRs or direct push?** Default PRs.
- **Which paths must the agent never touch?**
- **What is the gate command?** Detect it (`check.sh`, `npm test`, `flutter analyze && flutter test`), confirm it, and never let the agent edit it to make it pass.
- **Token/cost ceiling per night.**
- **Is anything else writing to this repo?** Two agents in one working tree will move a branch under each other.

## Commands

```bash
node "${CLAUDE_PLUGIN_ROOT}/dist/cli/index.js" nightshift                    # status: config, backlog, tonight's first task
node "${CLAUDE_PLUGIN_ROOT}/dist/cli/index.js" nightshift init               # write a safe default config
node "${CLAUDE_PLUGIN_ROOT}/dist/cli/index.js" nightshift idea "..."         # capture an idea into the inbox
node "${CLAUDE_PLUGIN_ROOT}/dist/cli/index.js" nightshift groom              # capture + scope, now, without waiting for tonight
node "${CLAUDE_PLUGIN_ROOT}/dist/cli/index.js" nightshift schedule           # print the install plan for this OS
```

`nightshift` on its own is the one to reach for when the user asks why nothing happened. It leads with whether the project **will** run tonight and why not, which answers the question directly.

## Setting it up

1. `nightshift init` writes `.launchpad/nightshift/config.yml`, **disabled**, in PR mode, with no gate.
2. Detect the project's gate command (`./check.sh`, `npm test`, `flutter analyze && flutter test`) and confirm it. **Without a gate, Nightshift refuses to run** — a gate is the only thing standing between an overnight agent and code nobody checked. Never let the agent edit it.
3. **Check `baseBranch`.** It is detected, not assumed — from `origin/HEAD` first, then the checked-out branch if it is a mainline name, then whichever of `main`/`master`/`trunk`/`develop` exists. It used to be hardcoded to `main`, which is the wrong guess for this product's buyer: an app built eighteen months ago is very often on `master`. Nothing was destroyed by getting it wrong — the work is pushed to a branch and `checkoutBase` is best-effort — but the pull request step failed and the morning report explained nothing. If detection picked something surprising, say so and let the user correct it; an explicit value in the config is never overridden.
4. Walk the safety rails above. Set `protectedPaths` for anything sensitive.
5. Set `enabled: true` only after the user has said yes explicitly.
6. `nightshift schedule` prints the exact files and commands for this OS — launchd on macOS, Task Scheduler on Windows, a systemd user timer on Linux. Show the user the plan and let them run it; it installs a recurring job on their machine.

The config, `.launchpad/state.yml`, `.github/workflows/**` and `.git/**` are protected on every project and cannot be un-protected. That is deliberate: they are how an agent would widen its own permissions, delete the gate it cannot pass, or turn a bad night into an unrecoverable one. The check runs after the agent and before any commit, and a violation discards the whole attempt.

## What it will and will not destroy

Worth stating explicitly, because the answer is not obvious and the failure is silent.

When an attempt fails, Nightshift reverts it — but **only it**. Untracked files are snapshotted before the agent starts, and only what appeared *during* that attempt is removed. Anything already in the tree is left alone: a draft you were writing, an un-added spec, and the backlog itself, whose task files are untracked until someone commits them. `.launchpad/` is never touched. Ignored files (`.env`, build caches) are never touched.

This matters because the lock serialises Nightshift against itself, **not against you**. If you are working in the same tree at night, your uncommitted work is safe from it.

## Current state — say this plainly if asked

Working end to end, verified on a real repo: backlog, config and safety rails, the agent invocation, the gate, commit, branch-and-PR or direct push, revert, the drain's order of operations, outcome derivation, retry-versus-block policy, grooming (capture and scoping), post-drain hooks, the morning report, and scheduler generation for launchd, Task Scheduler and systemd.

The loop closes: an idea captured during the day is groomed into a `ready` task at the start of the night, built, gated, committed, published, and reported against observable facts in the morning.

What is **not** proven: no project has yet run a full unattended night on this version. Everything above is tested and has been exercised by hand; "it ran overnight and the morning report was right" is a different claim and nobody can make it yet.

Say this rather than implying either that the loop is incomplete or that it is battle-tested.
