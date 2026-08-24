# Publish handoff — why step 5 hands off, and why by file

Background for `SKILL.md` step 5's handoff to the `ship-flow:publisher` agent. The step itself
states what to do; this file states why, so the pattern isn't "simplified" back into the shape it
was written to replace.

## Why this session doesn't publish its own work

ADR-0003 (this plugin's repo, issue #15). From step 0 through step 4 the Builder session has been
reading untrusted content — tracked-issue bodies, linked pages, dependency changelogs, web search
results — while holding full write access to a worktree. A session in that position must not *also*
be the one executing the external action that publishes the result of that work. Splitting the two
means a prompt injection that lands in the Builder's context cannot, by itself, reach `git push`,
`gh pr create`, or the tracker.

`ship-flow:publisher` exists to be the narrow half of that split: it executes literal commands it
was handed and nothing else. It does not read repository files on its own initiative, fetch
content, or compose PR/comment text. That is why step 5 has to hand it *finished strings* — a
publisher that has to go read the diff to write a PR body is just the Builder again with a
different name.

Composing the text is not an external state change, which is why the Builder session may still do
it. Only the publishing act moves.

## Why the handoff is file-based, not a heredoc

The obvious way to pass a multi-line PR body into a shell command is a heredoc assigned to a
variable:

```bash
BODY=$(cat <<'EOF'
… PR body …
EOF
)
```

This is unsafe here, and the quoted delimiter (`<<'EOF'`) does not fix it. Quoting the delimiter
suppresses parameter and command expansion *inside* the body — it does **not** stop the heredoc from
ending early. The heredoc terminates at the first line that is exactly the delimiter word, and
everything after that line is read back by the shell as real commands.

The PR body is derived from content this session read out of tracked issues and the web. Untrusted
text that happens to contain a line reading `EOF` — placed there deliberately or by accident —
therefore closes the heredoc and turns the remainder into executed shell. There is no delimiter
choice that removes this: whatever word is picked, the attacker-supplied text can contain it.

Writing the text to a file with the **Write tool** has no equivalent collision. The file's bytes are
never parsed as shell; the command line only ever carries a path.

## The safe pattern

1. `mktemp -d` — a fresh directory, never a predictable fixed path (a fixed path is writable by any
   other process on the machine between the write and the read).
2. Write the PR title, the PR body, and the tracked-issue comment text to **separate files** in it,
   using the Write tool.
3. Hand `ship-flow:publisher` the file paths plus the exact commands to run.

Commands use the CLI's own file flags where they exist — `gh pr create --body-file <path>`,
`gh issue comment --body-file <path>` — and `"$(cat <path>)"` interpolated into a **double-quoted**
variable where they don't. `agents/publisher.md`'s "What you do" section carries the exact form and
the same reasoning from the executing side.

The same rule covers the retry path. A `--force-with-lease` push after a rebase is still an external
action taken by a session holding untrusted-input history, so it goes through `ship-flow:publisher`
too, with the branch name passed as a literal value and interpolated only inside double quotes —
never bare, never through a heredoc.
