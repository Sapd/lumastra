# tasks/builtin/

Builtin task implementations for the task system. Every builtin registers directly against an SDK `defineX` contract from `@sapd/lumastra-plugin-sdk`.

## Files

| File       | What                                                                    | When to read                                                             |
| ---------- | ----------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| `index.ts` | `loadBuiltins(registry)` — autoloader; called once at orchestrator boot | Wiring the orchestrator into startup, or debugging missing-plugin issues |

## Subdirectories

| Directory               | What                                                                                                                                                         | When to read                                                              |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------- |
| `native/`               | All ~40 builtin task / provider / feature / integration / external-service / media-source / watch-sync / trickplay plugins                                   | Writing a new builtin (use one of these as a template)                    |
| `native/media-sources/` | All 3 media-source plugins (`kavita.ts`, `audiobookshelf.ts`, `file-scanner.ts`); file-scanner helpers live in `native/media-sources/_helpers/file-scanner/` | Working on library scanning, watcher, or media-source availability checks |
| `native/__tests__/`     | Ported tests for plugins with deep failures/retry/backlog coverage (media-probe, music-analysis, artist-enrichment, etc.)                                    | Adding regression coverage for backlog/failures hooks                     |

## Native exemplars

Each is tutorial-grade commented (`// TUTORIAL:` markers). Pick the smallest exemplar that matches your task shape and copy it.

| Plugin                         | Demonstrates                                                         |
| ------------------------------ | -------------------------------------------------------------------- |
| `native/dummy-sync.ts`         | Smallest possible plugin — read this FIRST                           |
| `native/cache-cleanup.ts`      | Scheduled maintenance with Valkey                                    |
| `native/tmdb-metadata-sync.ts` | External API: rate limit + secrets + retry + cost                    |
| `native/library-embeddings.ts` | Chunked drain via `backlog: { stages, compute }`                     |
| `native/file-system-scan.ts`   | Multi-stage pipeline + conditional `when:` + `scope: 'libraryGroup'` |

## Boot wireup

```ts
// orchestrator boot path (see ../orchestrator.ts:getOrchestrator)
import { loadBuiltins } from './builtin/index.js';

await loadBuiltins();
// registry is now populated; runner subscription is safe
```

`getOrchestrator()` calls `loadBuiltins()` lazily on the first orchestrator access, so the registry is populated before `TaskOrchestrator.start()` subscribes to queue events. The autoloader wraps each native import in `safeRegister` — a misbehaving builtin won't prevent orchestrator startup, only its own jobs from running.

## Drain-backlog context note

`drainBacklog` from `plugins/runtime/drain-backlog.ts` only reads `logger` and `abortSignal` from its context argument. `TaskContext` satisfies this shape structurally — pass `{ logger, abortSignal: signal }` or `{ logger, abortSignal: ctx.signal }` directly; no shim or cast needed. See `native/media-probe.ts` for the canonical pattern.
