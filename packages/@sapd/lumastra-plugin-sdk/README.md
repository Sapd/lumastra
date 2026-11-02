# @sapd/lumastra-plugin-sdk

> **Pre-1.0 notice:** The `@sapd/lumastra-plugin-sdk` is pre-1.0. Every minor may break the API. Pin exact versions.

SDK for building Lumastra plugins. Ships eleven `define*` helpers — one per contract family (`defineTask`, `defineProvider`, `defineTrickplayProvider`, `defineWatchSync`, `defineFeature`, `defineIntegration`, `defineMediaSource`, `defineExternalService`, `defineSubtitleProvider`, `defineLyricsProvider`, `defineAuthProvider`) — plus `definePlugin` for bundling several contracts into one plugin, shared type definitions, a `TaskError` class, and testing utilities.

## One plugin, one or many contracts

A plugin's default export is either a **single** contract def or a **`definePlugin` aggregate** carrying several:

```js
// One install that registers a watch-sync AND its backfill task.
export default {
    watchSyncs: [/* id: 'trakt'          — the anchor */],
    tasks: [/* id: 'trakt-backfill' */],
};
```

Two rules the host enforces on an aggregate:

- **Namespace** — every contract id must be the plugin's name or start with `<name>-`. A bundle can never register an id in another plugin's namespace.
- **Anchor** — exactly one contract must be named after the plugin itself. That id is how the host answers "is this plugin loaded?", so a bundle without it is rejected.

A signed manifest declares the contracts in `kinds: ['watch-sync', 'task']` (multi) or `kind: 'task'` (single) — exactly one of the two. Validation is all-or-nothing: if any contract in the bundle is invalid, none of them register.

## Install

```bash
npm install --save-dev @sapd/lumastra-plugin-sdk
```

**Dev-time only.** A plugin must never `import` this package at runtime — the
host loads plugins with the SDK marked external, so a runtime import throws
`ERR_MODULE_NOT_FOUND` on your first line (the loader detects that exact mistake
and says so). Use `import type` in TypeScript or `@type` JSDoc in JavaScript.

You do not need the `defineX()` helpers at runtime either: the host runs the very
same validators over your definition when it loads you.

Full authoring guide: <https://lumastra.org/developers/plugins/>.

## Usage

```ts
import { defineTask } from '@sapd/lumastra-plugin-sdk';
import { z } from 'zod';

export default defineTask({
    id: 'my-sync-task',
    name: 'My Sync Task',
    version: '1.0.0',
    processingVersion: 1,
    minAppVersion: '1.0.0',
    capabilities: { database: true, http: true },
    resourceClass: 'io',
    inputSchema: z.object({ libraryGroupId: z.string().optional() }),
    identityFor: (input) => input.libraryGroupId ?? 'global',
    async execute(ctx) {
        ctx.logger.info('starting sync');
        return { success: true, itemsProcessed: 0 };
    },
});
```

### Deriving `TInput` from the schema

Pair `defineTaskFromSchema` with a Zod schema to skip the explicit `TInput`
generic — the input type is inferred from the schema, eliminating the
Zod/TS drift class:

```ts
import { defineTaskFromSchema } from '@sapd/lumastra-plugin-sdk';
import { z } from 'zod';

const Input = z.object({ libraryGroupId: z.string() });

export default defineTaskFromSchema(Input, {
    id: 'my-sync-task',
    name: 'My Sync Task',
    version: '1.0.0',
    processingVersion: 1,
    minAppVersion: '1.0.0',
    capabilities: { database: true },
    resourceClass: 'io',
    identityFor: (input) => input.libraryGroupId,
    async execute(ctx) {
        // ctx.input is typed as { libraryGroupId: string } without annotation.
        return { success: true };
    },
});
```

## Testing

```ts
import { runTask, mockContext, expectRun } from '@sapd/lumastra-plugin-sdk-testing';
import myTask from './index.js';

it('completes successfully', async () => {
    const result = await runTask(myTask, { libraryGroupId: 'abc' });
    expect(result.success).toBe(true);
});

it('charges the expected API budget', async () => {
    await expectRun(myTask, { libraryGroupId: 'abc' })
        .toCompleteSuccessfully()
        .toSpendExactly('api_calls', 3)
        .toNotSpend('openai_tokens');
});
```

## Plugin contracts

| Helper                    | Lifecycle              | Use case                           |
| ------------------------- | ---------------------- | ---------------------------------- |
| `defineTask`              | Queue-driven (BullMQ)  | Background sync, scans, drains     |
| `defineProvider`          | Request-time           | Metadata search/detail (TMDB, MAL) |
| `defineTrickplayProvider` | Request-time (<100ms)  | Thumbnail strip data               |
| `defineWatchSync`         | Queue + immediate push | Bidirectional watch state          |
| `defineFeature`           | Startup (HTTP mount)   | Route registration                 |
| `defineIntegration`       | Webhook + notification | Sonarr/Radarr/Jellyseerr           |
| `definePlugin`            | Aggregate              | Multi-contract plugin bundle       |

## Database access

Plugins that declare `capabilities: { database: true }` receive a raw `postgres.Sql` tagged-template handle via `ctx.sql`. **This is full trust** — a plugin can read or write any table, drop tables, run arbitrary SQL. If you can't trust a plugin's author, don't install it.

**Prefer the convenience APIs (`ctx.catalog`, `ctx.mediaItems`, `ctx.mediaFiles`) for media operations.** Raw INSERTs into `external_ids` break the `(provider, external_id, media_type)` composite-key invariant and silently corrupt cross-media-type lookups (TMDB id `1429` resolves to "25th Hour" the movie AND "Attack on Titan" the series — whichever row wins depends on insert order). The host enforces the composite key transactionally; reach for `ctx.sql` only when the convenience surface genuinely doesn't cover what you need.

```ts
// Good — composite-key safe, lifecycle hooks fire correctly.
await ctx.catalog.upsertExternalId({
    provider: 'tmdb',
    externalId: '550',
    mediaType: 'movie',
    mediaItemId: mediaUuid,
});

const hit = await ctx.catalog.findByExternalId({
    provider: 'tmdb',
    externalId: '550',
    mediaType: 'movie',
});

const item = await ctx.mediaItems.getById(mediaUuid);
const file = await ctx.mediaFiles.findByPath('/movies/Fight Club.mkv');
```

The convenience surface accepts any common case for `mediaType` (`'Movie'`, `'MOVIE'`, `'movie'`) plus the two cross-system aliases the SDK contracts: `'series'` → `'tv'`, `'song'` → `'track'`.
