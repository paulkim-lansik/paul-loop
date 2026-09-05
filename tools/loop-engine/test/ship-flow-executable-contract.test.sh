#!/usr/bin/env bash
# ship-flow executable-contract guard — the forensic audit of 12 real ship-feature runs (2026-08-24)
# found the skill's mandated deterministic tools executed 0/12 times. Root cause: the skill wrote its
# commands as *description* ("<however this repo invokes its installed loop-engine plugin's bin
# scripts> verdict-run.sh -- ...") rather than as a string an agent could run, so every run silently
# fell back to the raw verify command it already knew. Secondary damage from the same prose form:
# 4 runs pasted a spurious `--` into classify-risk.sh and got a usage error.
#
# Like verdict-wrap-required.test.sh and skill-guard-prose-wiring.test.sh, this is a TEXT-LEVEL
# regression guard on skill prose. It cannot prove an agent obeyed an instruction — only that the
# instruction hasn't quietly reverted to the shape that provably wasn't obeyable. Everything asserted
# here is a mechanical property of the file (a token is present, a wrong argument form is absent), not
# a judgement about wording.
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$HERE/../../.."
SF="$ROOT/tools/ship-flow"
SHIP="$SF/skills/ship-feature/SKILL.md"
SETUP="$SF/skills/setup/SKILL.md"

fail() { echo "FAIL: $1"; exit 1; }
for f in "$SHIP" "$SETUP"; do [ -f "$f" ] || fail "missing file: $f"; done

# ── F1: no prose placeholder anywhere; commands are substitutable literals ────────────────────────
if grep -rn 'however this repo invokes its installed loop-engine' "$SF" >/dev/null 2>&1; then
  grep -rn 'however this repo invokes its installed loop-engine' "$SF" >&2
  fail "the prose command placeholder is back — an agent cannot execute a description, which is what left the mandated tools at 0/12 executions"
fi
if grep -rn '<loop-engine [a-z-]*\.sh>\|<loop-engine bin resolver>' "$SF" >/dev/null 2>&1; then
  fail "a '<loop-engine ...>' prose placeholder is back — same failure mode as the one above"
fi
echo "PASS: no prose command placeholders remain under tools/ship-flow"

for rel in skills/ship-feature/SKILL.md skills/hotfix/SKILL.md skills/retrospect/SKILL.md skills/deps-audit/SKILL.md; do
  f="$SF/$rel"
  [ -f "$f" ] || fail "missing file: $f"
  grep -q '{{pluginBinPrefix}}' "$f" \
    || fail "$rel invokes loop-engine bin scripts but carries no {{pluginBinPrefix}} substitutable literal"
  grep -q 'ship-flow\.config\.json' "$f" \
    || fail "$rel uses {{pluginBinPrefix}} without telling the reader where the value comes from"
done
echo "PASS: ship-feature/hotfix/retrospect/deps-audit all use the {{pluginBinPrefix}} literal + name its config source"

grep -q 'pluginBinPrefix' "$SETUP" \
  || fail "setup/SKILL.md must interview for / record pluginBinPrefix — otherwise the key every other skill substitutes never gets written"
echo "PASS: setup/SKILL.md records pluginBinPrefix"

# F1 (argument form): classify-risk.sh / ac-verify.sh / lessons.sh take no `--`; verdict-run.sh needs one.
if grep -rnE '(classify-risk\.sh|ac-verify\.sh|lessons\.sh|deps-audit\.mjs) +--( |$)' "$SF" >/dev/null 2>&1; then
  grep -rnE '(classify-risk\.sh|ac-verify\.sh|lessons\.sh|deps-audit\.mjs) +--( |$)' "$SF" >&2
  fail "a bare '--' separator crept back after a script that rejects one (unknown-arg usage error, observed in 4 real runs)"
fi
grep -q 'verdict-run\.sh -- <verifyCommand>' "$SHIP" \
  || fail "ship-feature lost verdict-run.sh's REQUIRED '--' separator — the one script here that needs it"
echo "PASS: argument forms intact (no spurious '--'; verdict-run.sh keeps its required one)"

# ── F2: review agents named with the ship-flow: namespace ────────────────────────────────────────
for a in code-reviewer test-hunter verifier-integrity-hunter; do
  grep -q "ship-flow:$a" "$SHIP" || fail "ship-feature must name the review agent as ship-flow:$a"
done
if grep -nE '(^|[^:a-z-])`code-reviewer`' "$SHIP" | grep -vi 'collides\|pr-review-toolkit' >/dev/null 2>&1; then
  fail "ship-feature names a bare \`code-reviewer\` outside the collision note — it resolves ambiguously against pr-review-toolkit:code-reviewer"
fi
echo "PASS: review agents are ship-flow:-namespaced in ship-feature"

# ── F3: planner is wired in (a dead agent no caller invokes is the alternative this rejected) ────
grep -q 'ship-flow:planner' "$SHIP" \
  || fail "agents/planner.md exists but ship-feature never invokes it — either wire it into step 1 or delete the agent"
[ -f "$SF/agents/planner.md" ] || fail "ship-feature invokes ship-flow:planner but agents/planner.md is gone"
echo "PASS: ship-flow:planner is both shipped and invoked"

# ── F4: review subagents must not run deep gates; a stalled review is a BLOCK ─────────────────────
for a in code-reviewer test-hunter verifier-integrity-hunter; do
  f="$SF/agents/$a.md"
  [ -f "$f" ] || fail "missing agent file: $f"
  # Specifically the prohibition, not any incidental mention of deep gates (all three files already
  # said "this doesn't replace ... deep gates" before this rule existed).
  grep -qi 'docker-based deep gate' "$f" \
    || fail "$a.md must forbid running docker-based deep gates itself (3-way container collision → watchdog timeouts, observed)"
  grep -qi 'result logs\|already-produced' "$f" \
    || fail "$a.md forbids running deep gates but doesn't say to consume the main session's already-produced result logs instead"
done
echo "PASS: all three review agents forbid self-run deep gates and point at the session's result logs"

grep -qi 'watchdog' "$SHIP" \
  || fail "ship-feature step 4 must state that a watchdog/stall failure counts as BLOCK, not 'no findings'"
echo "PASS: ship-feature treats a stalled review agent as BLOCK"

# ── F5: hard termination after the PR, and a scope guard on the grill step ───────────────────────
grep -qi 'hard termination' "$SHIP" \
  || fail "ship-feature step 5 must name an explicit hard-termination clause — a bare 'Stop here' left runs opening new worktrees/issues/PRs afterwards"
grep -qi 'scope guard' "$SHIP" \
  || fail "ship-feature step 1 must carry a scope guard — grilling that widens scope has to split into a separate issue, with THIS run continuing at its original scope"
echo "PASS: ship-feature has both the hard-termination clause and the grill scope guard"

# ── F6: question qualification + where a taken decision gets recorded ────────────────────────────
grep -q 'Decisions taken' "$SHIP" \
  || fail "ship-feature must name the 'Decisions taken' PR-body section — 17/17 sampled design round-trips were answered 'go with your recommendation'"
grep -qi 'reversible' "$SHIP" \
  || fail "ship-feature's question-qualification rule must key on reversibility (proceed on a clear recommendation when the decision is reversible)"
echo "PASS: ship-feature qualifies questions and records taken decisions in the PR body"

# ── F7: every skill and agent carries the output-language anchor, and setup records the key ──────
missing=""
for f in "$SF"/skills/*/SKILL.md "$SF"/agents/*.md; do
  grep -qi 'Output language' "$f" || missing="$missing $(basename "$(dirname "$f")")/$(basename "$f")"
done
[ -z "$missing" ] || fail "no output-language anchor in:$missing — prose drifted to English (once to Japanese) at the report/PR step in 21 of 78 sampled sessions"
echo "PASS: every ship-flow skill and agent carries an output-language anchor"

for f in "$SF"/skills/*/SKILL.md "$SF"/agents/*.md; do
  grep -qi 'outputLanguage' "$f" \
    || fail "$(basename "$(dirname "$f")")/$(basename "$f") mentions output language but not the outputLanguage config key — a language rule with no config source is the prose-only shape this audit exists to stop"
  # The prose/verbatim boundary is the part that goes wrong destructively (translated commands).
  grep -qi 'verbatim' "$f" \
    || fail "$(basename "$(dirname "$f")")/$(basename "$f") states an output language without the code/commands-stay-verbatim boundary"
done
echo "PASS: every anchor names the outputLanguage key and the stays-verbatim boundary"

grep -q '"outputLanguage"' "$SETUP" \
  || fail "setup/SKILL.md must write outputLanguage into .claude/ship-flow.config.json — otherwise every skill's anchor resolves to nothing"
grep -qi 'BCP-47' "$SETUP" \
  || fail "setup/SKILL.md must record outputLanguage as a BCP-47 tag — a free-text language name has several spellings and stops being matchable"
echo "PASS: setup/SKILL.md interviews for and records outputLanguage as a BCP-47 tag"

# F8: every entry point resolves the same authorization contract (without becoming another skill).
for f in "$SF"/skills/*/SKILL.md "$SF"/agents/*.md; do
  grep -q 'AUTHORIZATION.md' "$f" || fail "missing shared authorization contract: $f"
done
[ -f "$SF/skills/AUTHORIZATION.md" ] || fail "shared authorization contract is missing"

# F9: execute the publisher's documented example with isolated fake commands. These checks exercise
# dependency failures and literal bytes; they do not contact a remote or modify the shared checkout.
python3 - "$SF" <<'PYTEST' || exit 1
import json, os, pathlib, re, subprocess, sys, tempfile
sf = pathlib.Path(sys.argv[1])
source = (sf / 'agents/publisher.md').read_text()
blocks = re.findall(r'```bash\n(.*?)\n```', source, re.S)
assert len(blocks) == 1, 'publisher must have one unambiguous executable example'
script = blocks[0]
# The fixture logs argv and exact body bytes before an injected failure.
stub = r"""#!/usr/bin/env python3
import json, os, pathlib, sys
args = sys.argv[1:]
name = pathlib.Path(sys.argv[0]).name
entry = {'command': name, 'args': args}
if '--body-file' in args:
    entry['body'] = pathlib.Path(args[args.index('--body-file') + 1]).read_text()
with open(os.environ['CALL_LOG'], 'a') as f:
    f.write(json.dumps(entry) + '\n')
mode = os.environ['MODE']
if name == 'git':
    assert args[:3] == ['push', '-u', 'origin'], args
    sys.exit(17 if mode == 'push-fail' else 0)
if args[:2] == ['pr', 'create']:
    if mode == 'pr-fail': sys.exit(18)
    if mode != 'empty-url': print('https://example.invalid/repo/pull/42')
    sys.exit(0)
assert args[:2] == ['issue', 'comment'], args
sys.exit(19 if mode == 'comment-fail' else 0)
"""
with tempfile.TemporaryDirectory(prefix='ship-flow-publisher-test-') as td:
    root = pathlib.Path(td)
    bin_dir = root / 'bin'; bin_dir.mkdir()
    for name in ('git', 'gh'):
        tool = bin_dir / name; tool.write_text(stub); tool.chmod(0o700)
    cases = [
        ('success', 0, ['git', 'gh', 'gh']),
        ('push-fail', 17, ['git']),
        ('pr-fail', 18, ['git', 'gh']),
        ('empty-url', 1, ['git', 'gh']),
        ('comment-fail', 19, ['git', 'gh', 'gh']),
        ('empty-branch', 2, []), ('multiline-title', 2, []),
        ('option-branch', 2, []), ('missing-body', 2, []), ('existing-result', 2, []),
    ]
    for mode, expected_code, commands in cases:
        work = root / mode; work.mkdir()
        handoff = work / 'handoff with spaces'; handoff.mkdir()
        # Delimiter-looking prose, quotes, newlines and command substitutions remain inert data.
        title = 'fix: "literal" $(touch PWNED) `touch ALSO_PWNED`'
        body = 'Korean: 한글\nEOF\n$(touch PWNED)\n`touch ALSO_PWNED`\n"quoted"\n'
        comment = 'reviewed literal comment\nEOF\n$(touch PWNED)\n'
        values = {'branch.txt': 'codex/fix', 'base.txt': 'main', 'pr-title.txt': title,
                  'issue.txt': '9', 'pr-body.txt': body, 'issue-comment.txt': comment}
        if mode == 'empty-branch': values['branch.txt'] = ''
        if mode == 'option-branch': values['branch.txt'] = '--mirror'
        if mode == 'multiline-title': values['pr-title.txt'] = 'first\nsecond'
        for name, value in values.items(): (handoff / name).write_text(value)
        if mode == 'missing-body': (handoff / 'pr-body.txt').unlink()
        if mode == 'existing-result': (handoff / 'issue-comment-final.txt').write_text('prior result')
        log = work / 'calls.jsonl'
        env = dict(os.environ, PATH=str(bin_dir) + os.pathsep + os.environ['PATH'],
                   HANDOFF_DIR=str(handoff), CALL_LOG=str(log), MODE=mode)
        result = subprocess.run(['bash', '-c', script], cwd=work, env=env, capture_output=True, text=True)
        calls = [json.loads(x) for x in log.read_text().splitlines()] if log.exists() else []
        assert result.returncode == expected_code, (mode, result.returncode, result.stderr)
        assert [x['command'] for x in calls] == commands, (mode, calls)
        assert not (work / 'PWNED').exists() and not (work / 'ALSO_PWNED').exists(), mode
        assert (handoff / 'issue-comment.txt').read_text() == comment, mode
        if len(calls) >= 2:
            args = calls[1]['args']
            assert args[args.index('--title') + 1] == title, (mode, args)
            assert calls[1]['body'] == body, mode
        if len(calls) == 3:
            assert calls[2]['body'] == comment + '\n\nPR: https://example.invalid/repo/pull/42\n', mode
        if mode in ('success', 'comment-fail'):
            assert 'https://example.invalid/repo/pull/42' in result.stdout, mode
        print('PASS: publisher documented sequence ' + mode)
PYTEST

exit 0
