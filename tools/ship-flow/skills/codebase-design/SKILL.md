---
name: codebase-design
description: Shared vocabulary for designing deep modules. Use when the user wants to design or improve a module's interface, find deepening opportunities, decide where a seam goes, make code more testable or AI-navigable, or when another skill needs the deep-module vocabulary.
---

Follow the [shared authorization and completion contract](../AUTHORIZATION.md) before this procedure.

# Codebase Design

> **Output language.** Read `outputLanguage` (a BCP-47 tag, e.g. `ko`) from
> `.claude/ship-flow.config.json` and write **every human-facing prose artifact** — reports, summaries,
> questions, PR and tracked-issue bodies, your final message — in that language. **Code, commands, flags,
> identifiers, file paths, branch names, and quoted tool output stay verbatim; never translate them.** Key
> absent or unreadable → fall back to the language the user is writing in; never error on this.

The vocabulary and principles every design suggestion in this plugin is phrased in. Use these terms
exactly — consistent language is the point, not decoration. Don't drift into "component," "service,"
"API," or "boundary": each of those already means something looser elsewhere, and the looseness is
what lets a shallow module pass as a designed one.

## Glossary

Full definitions, with what to avoid and why, in [LANGUAGE.md](LANGUAGE.md).

- **Module** — anything with an interface and an implementation (function, class, package, slice).
  Deliberately scale-agnostic.
- **Interface** — everything a caller must know to use the module: types, invariants, error modes,
  ordering, config, performance. Not just the type signature.
- **Implementation** — the code inside.
- **Depth** — leverage at the interface: a lot of behaviour behind a small interface. **Deep** = high
  leverage. **Shallow** = interface nearly as complex as the implementation.
- **Seam** — where an interface lives; a place behaviour can be altered without editing in place.
  (Use this, not "boundary.")
- **Adapter** — a concrete thing satisfying an interface at a seam.
- **Leverage** — what callers get from depth.
- **Locality** — what maintainers get from depth: change, bugs, and knowledge concentrated in one place.

## Principles

- **Deletion test.** Imagine deleting the module. If complexity vanishes, it was a pass-through. If
  complexity reappears across N callers, it was earning its keep. Apply this to anything you suspect
  is shallow — it separates "this looks like indirection" from "this is indirection."
- **The interface is the test surface.** A module you can't test through its interface has the wrong
  interface, not a testing problem.
- **One adapter = hypothetical seam. Two adapters = real seam.** A seam with a single implementation
  is a guess about the future; the second implementation is what proves the seam was in the right place.

## When another skill calls this one

Answer in this vocabulary and stop — this skill supplies language and judgment, not a workflow. The
calling skill owns the process:

- [DEEPENING.md](DEEPENING.md) — how to recognise a deepening opportunity and what a good one looks like.
- [INTERFACE-DESIGN.md](INTERFACE-DESIGN.md) — designing an interface twice, in parallel, before committing
  to one. Reach for this when the shape of the deepened module is the open question.
