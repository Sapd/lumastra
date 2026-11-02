// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Friendly task names for the attention spine's alert titles.
 *
 * `adapters.ts` builds several titles/details around a raw `taskId` (e.g.
 * `'fribb-anime-sync'`), which reads as a developer-facing slug rather than
 * something an operator recognises. Every registered task already carries a
 * curated `name` (`TaskDefinition.name`, e.g. "Fribb Anime ID Sync") on the
 * in-memory task registry — this module is the sibling lookup for that,
 * following the same pattern as `labels.ts` (stage ids / health-component
 * keys / onboarding step keys → friendly text).
 *
 * SERVER-ONLY: `$lib/server/tasks/registry.js` pulls in the whole task
 * system and must never be imported from client bundles. `adapters.ts` is
 * itself server-only (imports `$lib/server/config.js` etc.), so importing
 * this module there is safe.
 *
 * The registry lookup is a synchronous in-memory `Map.get` (see
 * `TaskRegistry.getTask`), registered once at boot — cheap enough for the
 * attention derive cycle's hot path. A taskId absent from the registry (a
 * removed task, a plugin that failed to load, a stale id left over in old
 * DB rows) falls back to `prettify()`, the same house pattern `labels.ts`
 * uses, so an unknown id still reads as a plausible name instead of a blank
 * or a raw slug.
 */

import { getRegistry } from '$lib/server/tasks/registry.js';
import { taskDisplayName } from '$lib/utils/admin/task-names.js';
import { prettify } from './labels.js';

/**
 * Operator name for a task id (e.g. `fribb-anime-sync` → "Map Anime IDs
 * (MyAnimeList, AniList)") — the same curated name every other surface uses
 * (`task-names.ts`), then the registry's SDK name, then a prettified id.
 */
export function taskName(taskId: string): string {
    return taskDisplayName(taskId, getRegistry().getTask(taskId)?.name ?? prettify(taskId));
}
