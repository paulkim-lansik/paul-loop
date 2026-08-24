# Risk gate — background

Why the gate is shaped the way it is, and what the rule set typically covers. `SKILL.md`'s
[Risk gate](SKILL.md) section carries the part needed at the moment of running the classifier (the
command, the three exit codes, the TRACK routing table); this file is the reasoning behind it. Read
it when a classification looks wrong, when deciding whether to pass `--agent-*` input, or when this
repo is layering its own rules on top.

## Why the agent doesn't score its own risk

The three-valued decision rule itself is mechanical: `reversibility=none` or an unclassified
dimension → `REQUIRE`; reversible but `blast=high OR cost=high` → `DENY_AND_LOG`; anything else →
`AUTO`.

The gap that matters is **who assigns blast/reversibility/cost**. Inside this skill that would
otherwise be the same agent doing the work, which turns self-scoring into a rubber stamp — an agent
that wants to proceed can always find a reading of its own change that scores low. So classification
is derived **from the change itself** (paths, commands, stage) by the classifier first, and agent
input is folded in as `final = max(rule, agent)`: agent input is **only allowed to raise** a
classification, never lower it. Pass `--agent-blast-radius` / `--agent-reversibility` /
`--agent-cost` when the agent genuinely knows something the paths don't show (e.g. a small diff that
changes a payment amount); never to argue a rule-matched change back down.

## The two channels of `DENY_AND_LOG` (exit 11)

`DENY_AND_LOG` means different things depending on where the classifier is consulted, and this is
deliberate:

- **On the verdict channel** (what `ship-feature` uses): log the evidence — run the same
  classification again with `--render-md` and paste the markdown block into the PR — and proceed.
  Human review happens at the PR/merge boundary that already exists, so the run doesn't stall
  waiting on someone.
- **On a command-execution channel** (a `PreToolUse` hook, where one is wired): block the command
  instead. There is no later boundary there — the command either runs or it doesn't.

Treating exit 11 as "stop and wait for a human" on the verdict channel is a common misreading; that
is what exit 10 (`REQUIRE`) is for.

## What the rule set typically covers

Rule sets vary per repo, but the surfaces that normally carry a rule are:

- schema migrations (`reversibility=none`)
- row-level security, or whatever this repo's equivalent tenant-isolation schema is
- auth and guards
- outbound send/call (anything that reaches a real user or a third party)
- the harness/constitution layer — `.claude/**`, this repo's CLAUDE.md, `docs/adr/**`, loop-engine
  tooling
- CI and deploy configuration
- workspace-root config
- 11+ files touched

**Below that threshold**, with **≤10 files, 0 commands, and no rule match**, a low-risk app-code
baseline applies (`low/full/low` → AUTO). Everything else unmatched — an unmatched *command*, or 11+
files with no classification — is **fail-closed REQUIRE**. Silence is not AUTO; an unclassified
change is an unknown one.

**Merge, deploy, release, and send are never classified as anything but REQUIRE.** `--stage
merge|deploy|release|send`, and merge/deploy *commands*, are always `reversibility=none` regardless
of any other input, including agent input. This is the one classification no rule set can relax.

## Layering this repo's own rules

If this repo ships its own `risk-rules.json` on top of loop-engine's defaults, `classify-risk.sh`
picks it up automatically — there's no flag to pass. A repo's own rules add to the defaults; they
are not a replacement, so a change can match both.

## The track is an output, not a separate axis

`TRACK:` is not something the agent chooses alongside the risk classification — it is printed *by*
the classification, and it routes the rest of the sequence. Skipping a step because of the track is
legitimate; skipping one for any other reason is not. Either way a skipped step leaves a one-line
reason in the PR body, so the decision is auditable after the fact rather than invisible.
