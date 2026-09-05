---
name: tdd
description: Test-driven development with a bounded red-green loop and review-stage refactoring. Use when user wants to build features or fix bugs using TDD, mentions "red-green-refactor", wants integration tests, or asks for test-first development.
---

Follow the [shared authorization and completion contract](../AUTHORIZATION.md) before this procedure.

# Test-Driven Development

> **Output language.** Read `outputLanguage` (a BCP-47 tag, e.g. `ko`) from
> `.claude/ship-flow.config.json` and write **every human-facing prose artifact** — reports, summaries,
> questions, PR and tracked-issue bodies, your final message — in that language. **Code, commands, flags,
> identifiers, file paths, branch names, and quoted tool output stay verbatim; never translate them.** Key
> absent or unreadable → fall back to the language the user is writing in; never error on this.

## Philosophy

**Core principle**: Tests should verify behavior through public interfaces, not implementation details. Code can change entirely; tests shouldn't.

**Good tests** are integration-style: they exercise real code paths through public APIs. They describe _what_ the system does, not _how_ it does it. A good test reads like a specification - "user can checkout with valid cart" tells you exactly what capability exists. These tests survive refactors because they don't care about internal structure.

**Bad tests** are coupled to implementation. They mock internal collaborators, test private methods, or verify through external means (like querying a database directly instead of using the interface). The warning sign: your test breaks when you refactor, but behavior hasn't changed. If you rename an internal function and tests fail, those tests were testing implementation, not behavior.

**Tautological tests** restate the implementation inside the assertion, so they pass by construction and give zero confidence. When the expected value is computed the way the code computes it — `expect(add(a, b)).toBe(a + b)`, snapshotting a figure you derived by hand the same way the code does, asserting a constant equals itself — the test can never disagree with the code: break the code wrong and the assertion breaks wrong with it. The expected value must come from an independent source of truth — a known-good literal, a worked example, the spec.

See [tests.md](tests.md) for examples and [mocking.md](mocking.md) for mocking guidelines.

## Seams: where tests go

A **seam** is the public boundary you test at — the interface where you observe behavior without reaching inside. Tests live at seams, never against internals.

**Test at documented seams.** Reuse the caller's plan, settled decisions, and authorization. Before
writing a test, identify the public seam and the behavior it proves. Choose an existing or clearly
justified reversible seam within scope without another approval round. Ask only if the choice changes
the product contract, widens scope, or needs an approval that is not already present. Prioritize
critical paths and complex logic; do not make the user re-approve ordinary test design.

When the shape of that boundary is itself in question — how deep the module should be, where the seam belongs, what the interface should expose — call the Skill tool with "codebase-design" for the vocabulary. It owns the module/interface/depth/**seam**/adapter/leverage/locality terms, and it is a reference to consult, not a session to run. For the narrower question of shaping an interface so it can be tested at all (inject dependencies, return results instead of mutating, keep the surface small), see [interface-design.md](interface-design.md).

## Reward-Hack Guard

If this repo has a reward-hack guard armed on working branches (a hook that blocks Edit/Write/Bash
mutation of test/config/snapshot files while a loop is in progress, so "fix the code under test, not
the test" is mechanical instead of a promise) — respect its window-opening convention rather than
working around it. The `loop-engine@paul-loop` plugin's own guard, where installed, arms by branch
condition (any branch outside the repo's integration/release branches) with no manual arm/disarm step:

- **RED (writing the failing test)** *is* a legitimate protected-file edit: open a reasoned window
  first — check this repo's guard docs for the exact command (loop-engine's convention is
  `echo '<reason> — tdd red: <what test>' > .loop/guard-off`; empty file is invalid, the window
  expires after 30 minutes) — write the test, then close the window before starting GREEN.
- **GREEN/refactor of production code** needs no window — source files aren't protected. If you feel
  the urge to edit the test during GREEN, that is exactly the reward-hack the guard exists to stop;
  if the test itself is genuinely wrong, reopen a window with the reason and state that reason in the
  PR body.
- A loop-runner script may own a separate "loop in progress" sentinel that overrides the guard-off
  window during its own runs — never create or remove that sentinel yourself if one exists.

## Anti-Pattern: Horizontal Slices

**DO NOT write all tests first, then all implementation.** This is "horizontal slicing" - treating RED as "write all tests" and GREEN as "write all code."

This produces **crap tests**:

- Tests written in bulk test _imagined_ behavior, not _actual_ behavior
- You end up testing the _shape_ of things (data structures, function signatures) rather than user-facing behavior
- Tests become insensitive to real changes - they pass when behavior breaks, fail when behavior is fine
- You outrun your headlights, committing to test structure before understanding the implementation

**Correct approach**: Vertical slices via tracer bullets. One test → one implementation → repeat. Each test responds to what you learned from the previous cycle. Because you just wrote the code, you know exactly what behavior matters and how to verify it.

```
WRONG (horizontal):
  RED:   test1, test2, test3, test4, test5
  GREEN: impl1, impl2, impl3, impl4, impl5

RIGHT (vertical):
  RED→GREEN: test1→impl1
  RED→GREEN: test2→impl2
  RED→GREEN: test3→impl3
  ...
```

## Workflow

### 1. Planning

When exploring the codebase, read `CONTEXT.md` (if it exists) so that test names and interface vocabulary match the project's domain language, and respect ADRs in the area you're touching.

Before writing any code:

- [ ] Reuse the caller's required interface changes and settled behavior priorities
- [ ] Record the exact **seams** under test and why they prove the required behavior
- [ ] Resolve remaining reversible choices within the authorized scope
- [ ] Design interfaces for [testability](interface-design.md)
- [ ] List the behaviors to test (not implementation steps)
- [ ] Check inherited authorization; return only unresolved material decisions to the caller

**You can't test everything.** Use the acceptance criteria to prioritize critical paths and complex
logic. If a missing priority would materially change the result, ask that narrow question while
continuing independent authorized work. An approved plan does not need another approval at this step.

### 2. Tracer Bullet

Write ONE test that confirms ONE thing about the system:

```
RED:   Write test for first behavior → test fails
GREEN: Write minimal code to pass → test passes
```

This is your tracer bullet - proves the path works end-to-end.

### 3. Incremental Loop

For each remaining behavior:

```
RED:   Write next test → fails
GREEN: Minimal code to pass → passes
```

Rules:

- One test at a time
- Only enough code to pass current test
- Don't anticipate future tests
- Keep tests focused on observable behavior

## Rules of the loop

- **Red before green.** Write the failing test first, then only enough code to pass it. Don't anticipate future tests or add speculative features.
- **One slice at a time.** One seam, one test, one minimal implementation per cycle.
- **Refactoring is not part of the loop.** It belongs to the review stage, not the red → green cycle: `ship-feature` step 4 runs `ship-flow:code-reviewer` and `ship-flow:test-hunter` against the finished diff, and structural work beyond that is what the `improve-codebase-architecture` skill is for. Restructuring while you still owe the next test is how a cycle turns into a rewrite.

## Checklist Per Cycle

```
[ ] Test describes behavior, not implementation
[ ] Test uses public interface only
[ ] Test would survive internal refactor
[ ] Expected values are independent literals, not recomputed from the code
[ ] Code is minimal for this test
[ ] No speculative features added
```
