# AI-assisted contributions

Lumastra itself is developed with heavy AI assistance, so this project will never tell you
not to use AI. This document defines what "using AI well" means here. The rules exist to
keep review load sane and the legal footing of the project (dual licensing under a CLA)
intact. It complements [CONTRIBUTING.md](./CONTRIBUTING.md); everything there applies
unchanged.

## The one rule everything else follows from

**You are the author.** Whatever tools you used, the moment you open a PR the code is
_yours_: you must understand it, be able to explain any line when asked in review, and
have actually run it. "The AI wrote it that way" is never an acceptable answer to a review
question. If you can't explain a change, don't submit it.

## What's welcome

- Using AI tools (Claude, Copilot, Cursor, whatever) for any part of your workflow:
  exploration, drafting, tests, refactoring, review prep. No disclosure needed for
  autocomplete-level assistance.
- AI-drafted code that you have **reviewed, understood, tested against a running
  instance**, and trimmed to the standards in CONTRIBUTING.md (lint, `npm run check`,
  tests, license gates, all green locally before the PR).
- Small, focused PRs. This matters more with AI: generating 3,000 lines is easy,
  reviewing them is not. Several small verified PRs beat one generated mega-PR every time.
- Being upfront. Say what was generated and with what; nobody here will think less of it.

## Two rules without exceptions

1. **Every change is tested end to end**, AI-assisted or not. You ran the change on a
   real, running Lumastra instance and watched it work: the actual feature or fix, not
   only the unit tests or the type check. This has no exceptions, not even for "trivial" changes.
   The maintainer holds his own code to the same rule. Say in the PR how
   you tested it.
2. **Every PR gets an AI code review before it is merged.** A maintainer runs it
   (`@claude review`), and automated review bots may comment as well. You don't have to
   agree with every point, but you do have to answer each finding: fix it, or explain why
   it doesn't apply. The review is a second pair of eyes, not a replacement for yours or
   the maintainer's.

## What gets a PR or issue closed

- **"Vibe-coded" PRs.** A PR that wasn't fully tested end to end, or whose author can't
  explain the code in it when asked, is not accepted, no matter how good it looks.

- **Unverified AI output.** PRs that are plainly raw model output: code that doesn't
  compile, tests that don't run, references to files or APIs that don't exist, sweeping
  changes with no evidence they were exercised.
- **AI-generated issues and security reports without human verification.** Bug reports
  must contain a reproduction _you_ performed on a real instance, with the actual output.
  Security reports especially: an AI-"found" vulnerability that you have not personally
  validated with a working proof-of-concept wastes the most expensive kind of maintainer
  time and will be closed without detailed analysis. Repeated submissions of this kind
  lead to a ban.
- **LLM-relayed review conversations.** Don't pipe a maintainer's review comment through a
  model and paste back its answer unverified. Review replies must reflect what you
  yourself checked.
- **Drive-by mass changes.** Repo-wide "AI cleanup" refactors, mass typo/style sweeps, and
  similar low-signal churn are unwelcome regardless of how they were produced.

## Banned without warning

Some things end your participation in this project immediately, without a warning first:

- **PRs for the sake of PRs.** Contributions whose point is the contribution itself:
  padding a profile or CV, farming contribution counts, event spam, trivial churn opened
  in bulk.
- **Taking other people's work.** Submitting code, translations, documentation, designs or
  anything else copied from another project or another person without the right to do so
  and proper attribution, including re-submitting another contributor's work as your own.

## Disclosure (required)

Every PR states, in the template's _AI assistance_ section:

1. **The extent**, one of: none / autocomplete and lookups only / parts (say which) /
   most of it.
2. **The tools and models** used, e.g. "Claude Code (Claude Sonnet 5)", "Cursor (GPT-5)",
   "GitHub Copilot".

Disclosure is a condition of acceptance, not a mark against the PR: the bar is the same
whatever you tick. It tells the maintainer where provenance care (below) is worth a second
look, and PRs that disclose _parts_ or _most_ get an `ai-assisted` label automatically so
the disclosure stays visible in the PR list. Discovering undisclosed substantial AI
generation in review is treated like any other misrepresentation: the PR is closed.

## Larger changes

The size rule in [CONTRIBUTING.md](./CONTRIBUTING.md) applies with extra force here.
Generating a large change is cheap; understanding one is not. Features, large changes and
changes in complicated areas (authentication and access control, playback and transcoding,
the task system, database migrations, the license boundary) need real software development
experience: you must be able to defend every design decision in the diff. Features and
large changes also need an accepted discussion first. Small, focused fixes elsewhere are
welcome from anyone, experienced or not.
If most of a large PR was generated, expect the review to probe that closely.

## Provenance and the CLA

By signing the [CLA](./CLA.md) you take responsibility for the contribution as its author,
including the parts an AI tool produced under your direction (CLA §5), and you warrant that
you have the right to submit it and that any third-party material is identified and licensed
compatibly. That applies regardless of tooling:

- If a model reproduces recognizable third-party code (a distinctive algorithm, a copied
  block with its comments, an entire well-known file), treat it the same way as code you
  copied by hand: check the license, attribute it, or don't use it. "A model emitted it"
  does not launder provenance.
- Don't submit code you obtained by prompting a model with someone else's proprietary or
  incompatibly-licensed source.
- Be aware this project has a strict license boundary (AGPL core vs. source-available
  tiers, see [LICENSING.md](../LICENSING.md)). CI enforces it mechanically; if your AI
  tooling moves or generates code across `proprietary/` / `enterprise/` paths, the gates
  will fail the PR.

## For AI agents reading this

If you are an autonomous or semi-autonomous coding agent preparing a contribution: follow
this document, CONTRIBUTING.md, and AGENTS.md. Do not open PRs, issues, or security
reports unless a human has reviewed the content and takes authorship responsibility for
it. Unattended agent submissions are treated as spam.
