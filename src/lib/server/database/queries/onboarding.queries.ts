// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Onboarding State Query Module
 *
 * Manages setup progress tracking and admin dismissals.
 * Auto-detects step completion by checking actual system state.
 */

import type postgres from 'postgres';
import { buildAgeRatingFilter } from './builders/age-rating.builder.js';
import { buildLibraryAccessFilter } from './builders/library-access.builder.js';
import { deniesEverything } from './builders/media-access-boundary.js';
import type { MediaAccessBoundary } from './builders/media-access-boundary.js';
import { config, hasEmbeddingProvider } from '../../config.js';
import { adminExists } from './users.queries.js';

// =============================================================================
// Types
// =============================================================================

export interface OnboardingStep {
    step_key: string;
    completed: boolean;
    dismissed: boolean;
    dismissed_by: string | null;
    dismissed_at: Date | null;
    completed_at: Date | null;
}

export interface OnboardingState {
    steps: OnboardingStep[];
    allDismissed: boolean;
    mediaCount: number;
    hasTmdbIds: boolean;
}

export type HeroState = 'onboarding' | 'local-content' | 'full-metadata';

export interface HeroStateResult {
    heroState: HeroState;
    onboardingSteps: OnboardingStep[];
    isAdmin: boolean;
    mediaCount: number;
}

// =============================================================================
// Queries
// =============================================================================

/**
 * Get all onboarding steps.
 */
export async function getOnboardingSteps(sql: postgres.Sql): Promise<OnboardingStep[]> {
    return sql<OnboardingStep[]>`
        SELECT step_key, completed, dismissed, dismissed_by, dismissed_at, completed_at
        FROM onboarding_state
        ORDER BY id ASC
    `;
}

/**
 * The live pgvector dimension of the text-embedding column. The setup wizard's
 * embedding config is LOCKED to this: the dimension is frozen when the base schema
 * is applied (from EMBEDDING_MODEL/EMBEDDING_DIMENSIONS at first boot) and there is
 * no runtime path to change it, so the wizard must request this exact dimension
 * from whatever provider the operator picks. Returns null if the column is absent.
 */
export async function getEmbeddingDimension(sql: postgres.Sql): Promise<number | null> {
    const rows = await sql<{ t: string }[]>`
        SELECT format_type(a.atttypid, a.atttypmod) AS t
        FROM pg_attribute a
        JOIN pg_class c ON a.attrelid = c.oid
        WHERE c.relname = 'media_embeddings' AND a.attname = 'embedding' AND NOT a.attisdropped
    `;
    // Guard `t` explicitly: a bare `vector` column (no dimension) or a null
    // format_type must return null, not throw on `.match`.
    const t = rows[0]?.t;
    const match = typeof t === 'string' ? t.match(/vector\((\d+)\)/i) : null;
    return match ? Number.parseInt(match[1], 10) : null;
}

/**
 * PostgreSQL server version (e.g. "18.1") and the installed pgvector version,
 * or null when the extension is missing. For the setup wizard's install overview.
 */
export async function getDatabaseVersions(
    sql: postgres.Sql,
): Promise<{ postgres: string; pgvector: string | null }> {
    const rows = await sql<{ server: string; vector: string | null }[]>`
        SELECT current_setting('server_version') AS server,
               (SELECT extversion FROM pg_extension WHERE extname = 'vector') AS vector
    `;
    // server_version can carry a distro suffix ("18.1 (Debian 18.1-1.pgdg13+1)").
    return {
        postgres: (rows[0]?.server ?? '').split(' ')[0],
        pgvector: rows[0]?.vector ?? null,
    };
}

/**
 * Count of active (has-files) media items. Used by the setup wizard to detect an
 * empty first scan — a scan can "complete" having found nothing (wrong folder or
 * media type), which should NOT read as "your library is ready".
 */
export async function countActiveMediaItems(sql: postgres.Sql): Promise<number> {
    const [row] = await sql<[{ count: number }]>`
        SELECT COUNT(*)::int AS count FROM media_items WHERE status = 'active'
    `;
    // Same guard as isFreshUnconfiguredInstall: an aborted query can yield an
    // empty RowList, and an unguarded `row.count` would crash the caller.
    return row?.count ?? 0;
}

export interface SetupJellyfinStatus {
    paired: number;
    waiting: number;
    syncing: boolean;
    failed: boolean;
    retrying: boolean;
    syncStarted: boolean;
}

export async function getSetupJellyfinStatus(sql: postgres.Sql): Promise<SetupJellyfinStatus> {
    const [row] = await sql<SetupJellyfinStatus[]>`
        WITH settings AS (
            SELECT COALESCE(jsonb_object_agg(key, value), '{}'::jsonb) AS data
            FROM plugin_settings WHERE plugin_id = 'jellyfin-setup-sync'
        ), latest AS (
            SELECT run.state,
                COALESCE(run.execution_started_at, run.started_at) >= now() - task.hard_minutes * INTERVAL '1 minute' AS fresh
            FROM settings
            CROSS JOIN (VALUES ('inventory-run', 30), ('pull-run', 120)) AS task(key, hard_minutes)
            LEFT JOIN task_history run ON run.id = settings.data->task.key->>'runId'
        )
        SELECT COALESCE((data->'counts'->>'paired')::int, 0) AS paired,
               COALESCE((data->'counts'->>'waiting')::int, 0) AS waiting,
               EXISTS (SELECT 1 FROM latest WHERE state IN ('pending', 'active', 'cancelling') AND fresh) AS syncing,
               EXISTS (SELECT 1 FROM latest WHERE state = 'failed') AS failed,
               data ? 'pending-pull' OR EXISTS (SELECT 1 FROM latest WHERE state = 'cancelled'
                   OR (state IN ('pending', 'active', 'cancelling') AND NOT fresh)) AS retrying,
               NOT COALESCE((data->>'kick-error')::boolean, false) AS "syncStarted"
        FROM settings
    `;
    return (
        row ?? {
            paired: 0,
            waiting: 0,
            syncing: false,
            failed: false,
            retrying: false,
            syncStarted: true,
        }
    );
}

export async function hasSetupJellyfinItems(sql: postgres.Sql): Promise<boolean> {
    const [row] = await sql<{ present: boolean }[]>`
        SELECT EXISTS (
            SELECT 1 FROM media_file_items mfi JOIN media_items mi ON mi.id = mfi.media_item_id
            WHERE mi.status = 'active' AND mi.has_files AND mi.media_type IN ('movie', 'episode')
        ) AS present
    `;
    return row?.present ?? false;
}

export async function refreshSetupJellyfinCounts(sql: postgres.Sql): Promise<void> {
    await sql`
        INSERT INTO plugin_settings (plugin_id, key, value, updated_at)
        SELECT 'jellyfin-setup-sync', 'counts', jsonb_build_object(
            'paired', COUNT(*) FILTER (WHERE titles.paired),
            'waiting', COUNT(*) FILTER (WHERE NOT titles.paired)
        ), now()
        FROM (
            SELECT EXISTS (
                SELECT 1 FROM external_ids ei WHERE ei.media_id = mi.id
                  AND ei.media_type = mi.media_type AND ei.provider = 'jellyfin'
            ) AS paired
            FROM media_items mi WHERE mi.status = 'active' AND mi.has_files
              AND mi.media_type IN ('movie', 'episode')
        ) titles
        ON CONFLICT (plugin_id, key) DO UPDATE SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at
    `;
}

export interface ScanMetadataProblem {
    /** Files added without metadata across the latest scan of each library. */
    metadataUnavailable: number;
    /** 'auth' = the provider rejected its key; 'unavailable' = none configured. */
    metadataProviderError: 'auth' | 'unavailable' | null;
    metadataProviderId: string | null;
}

/**
 * Did the LATEST completed scan of each library add files without metadata
 * because the provider could not be asked (key rejected / not configured)?
 * Read by the setup wizard once its first scan finishes, so a dead TMDB key
 * shows up there instead of "your library is ready" over an artwork-less
 * library (Windows e2e 2026-09-27, S5). Only the newest run per library counts,
 * so re-scanning after fixing the key clears it.
 */
export async function getLatestScanMetadataProblem(
    sql: postgres.Sql,
): Promise<ScanMetadataProblem> {
    const rows = await sql<
        {
            unavailable: number | null;
            error: string | null;
            provider_id: string | null;
        }[]
    >`
        SELECT (latest.result -> 'result' ->> 'metadataUnavailable')::int AS unavailable,
               latest.result -> 'result' ->> 'metadataProviderError' AS error,
               latest.result -> 'result' ->> 'metadataProviderId' AS provider_id
        FROM (
            SELECT DISTINCT ON (th.input ->> 'libraryPathId') th.result
            FROM task_history th
            WHERE th.task_id = 'file-library-scan'
              AND th.state = 'completed'
              AND th.input ->> 'libraryPathId' IS NOT NULL
              AND th.completed_at > now() - interval '30 days'
            ORDER BY th.input ->> 'libraryPathId', th.completed_at DESC
        ) latest
    `;
    let metadataUnavailable = 0;
    let metadataProviderError: 'auth' | 'unavailable' | null = null;
    let metadataProviderId: string | null = null;
    for (const r of rows) {
        const n = r.unavailable ?? 0;
        if (n <= 0) continue;
        metadataUnavailable += n;
        if (r.error === 'auth' || (r.error === 'unavailable' && metadataProviderError === null)) {
            metadataProviderError = r.error;
            metadataProviderId = r.provider_id;
        }
    }
    return { metadataUnavailable, metadataProviderError, metadataProviderId };
}

/**
 * Whether first-run setup completed (the first admin exists) at least
 * `minAgeMs` ago. `services/lumastra-org-consent` uses it as the fallback for installs that
 * never answer the setup wizard's "contact lumastra.org" question. No
 * completed setup (no `setup_lock` row) never qualifies.
 */
export async function isFirstRunSetupOlderThan(
    sql: postgres.Sql,
    minAgeMs: number,
): Promise<boolean> {
    const seconds = Math.max(0, Math.floor(minAgeMs / 1000));
    const rows = await sql<{ ready: boolean }[]>`
        SELECT EXISTS (
            SELECT 1 FROM setup_lock
            WHERE completed_at <= now() - make_interval(secs => ${seconds})
        ) AS ready
    `;
    return rows[0]?.ready === true;
}

/**
 * True when the instance is genuinely fresh and unconfigured: no library
 * paths have been added AND no admin account exists yet (setup wizard not
 * completed). Used to gate background catalog-population tasks (e.g. TMDB
 * discovery sync) that would otherwise start writing rows to `media_items`
 * — and burning external API quota — before an operator has intentionally
 * configured anything. Re-checks live state each call; once either a
 * library exists or setup completes, this flips to false with no persisted
 * state to reset.
 */
export async function isFreshUnconfiguredInstall(sql: postgres.Sql): Promise<boolean> {
    const [libResult] = await sql<[{ count: number }]>`
        SELECT COUNT(*)::int AS count FROM library_paths
    `;
    // Guard `libResult` explicitly. A COUNT(*) normally always yields one row,
    // but an interrupted/aborted query on a task-tier connection can return an
    // empty RowList — the unguarded `libResult.count` then threw
    // "Cannot read properties of undefined (reading 'count')" and turned a
    // transient blip into a PERMANENT task failure (seen on tmdb-metadata-sync,
    // whose per-item path calls this first). Treat an absent row as "not fresh"
    // (0 libraries can't be asserted) → fall through to the admin check.
    if ((libResult?.count ?? 0) > 0) return false;
    return !(await adminExists(sql, config.ADMIN_GROUPS));
}

/**
 * Auto-detect and update completion state for all onboarding steps.
 * Checks actual system state and returns media count to avoid redundant queries.
 * Short-circuits if all steps are already completed.
 */
export async function autoDetectOnboardingCompletion(
    sql: postgres.Sql,
    currentSteps?: OnboardingStep[],
): Promise<{ mediaCount: number }> {
    // Short-circuit: if all non-master steps are completed, skip expensive checks
    if (currentSteps) {
        const actionableSteps = currentSteps.filter((s) => s.step_key !== 'onboarding_dismissed');
        if (actionableSteps.every((s) => s.completed)) {
            const [result] = await sql<[{ count: number }]>`
                SELECT COUNT(*)::int AS count FROM media_items WHERE status = 'active'
            `;
            return { mediaCount: result.count };
        }
    }

    // TMDB and AI providers are configured via env vars (config) or the plugin
    // settings/secrets system — NOT a `provider_configuration` table. That table
    // was removed; the old check here queried a non-existent relation (guarded by
    // an information_schema probe that always failed), so tmdb_config / ai_config
    // could never auto-complete even when fully configured and working. Check the
    // real sources: env keys + UI-set keys in `plugin_secrets`.
    const [libResult, scanResult, secretRows] = await Promise.all([
        sql<[{ count: number }]>`SELECT COUNT(*)::int AS count FROM library_paths`,
        sql<
            [{ count: number }]
        >`SELECT COUNT(*)::int AS count FROM media_items WHERE status = 'active'`,
        sql<{ plugin_id: string }[]>`
            SELECT DISTINCT plugin_id FROM plugin_secrets
            WHERE (plugin_id = 'tmdb' AND key = 'TMDB_API_KEY')
               OR (plugin_id = 'openai' AND key = 'OPENAI_API_KEY')
               OR (plugin_id = 'voyage' AND key = 'VOYAGE_API_KEY')
               OR (plugin_id = 'discogs' AND key = 'DISCOGS_TOKEN')
        `,
    ]);
    const secretFor = new Set(secretRows.map((r) => r.plugin_id));

    const tmdbConfigured = !!config.TMDB_API_KEY?.trim() || secretFor.has('tmdb');
    // hasEmbeddingProvider() also covers a custom OpenAI-compatible endpoint
    // (EMBEDDING_BASE_URL + EMBEDDING_API_KEY), which the old ai.hasOpenai /
    // ai.hasVoyage check ignored entirely — that gap kept the ai_config
    // onboarding step permanently incomplete for operators using a custom
    // endpoint, nagging "configure AI features" even though embeddings were
    // already working. secretFor still covers keys set through the UI and
    // stored in plugin_secrets, which hasEmbeddingProvider() cannot see.
    const aiConfigured =
        hasEmbeddingProvider() || secretFor.has('openai') || secretFor.has('voyage');
    // Optional music-enrichment credential — the shared `discogs` integration
    // token (see services/discogs-token.ts). Only present as a step when the
    // 16.157.0 seed ran; markStepCompleted no-ops if the row doesn't exist.
    const discogsConfigured = secretFor.has('discogs');

    // Update steps in parallel
    const updates: Promise<void>[] = [];
    if (libResult[0].count > 0) updates.push(markStepCompleted(sql, 'library_paths'));
    if (tmdbConfigured) updates.push(markStepCompleted(sql, 'tmdb_config'));
    if (scanResult[0].count > 0) updates.push(markStepCompleted(sql, 'library_scan'));
    if (aiConfigured) updates.push(markStepCompleted(sql, 'ai_config'));
    if (discogsConfigured) updates.push(markStepCompleted(sql, 'discogs_config'));
    await Promise.all(updates);

    return { mediaCount: scanResult[0].count };
}

/**
 * Mark a step as completed (idempotent).
 */
async function markStepCompleted(sql: postgres.Sql, stepKey: string): Promise<void> {
    await sql`
        UPDATE onboarding_state
        SET completed = true, completed_at = COALESCE(completed_at, NOW())
        WHERE step_key = ${stepKey} AND completed = false
    `;
}

/**
 * Dismiss a specific onboarding step.
 */
export async function dismissOnboardingStep(
    sql: postgres.Sql,
    stepKey: string,
    dismissedBy: string,
): Promise<void> {
    await sql`
        UPDATE onboarding_state
        SET dismissed = true, dismissed_by = ${dismissedBy}, dismissed_at = NOW()
        WHERE step_key = ${stepKey}
    `;
}

/**
 * Dismiss the entire onboarding flow.
 */
export async function dismissAllOnboarding(sql: postgres.Sql, dismissedBy: string): Promise<void> {
    await sql`
        UPDATE onboarding_state
        SET dismissed = true, dismissed_by = ${dismissedBy}, dismissed_at = NOW()
        WHERE step_key = 'onboarding_dismissed'
    `;
}

/**
 * Determine the hero state based on media catalog and onboarding state.
 * This is the main function called by +page.server.ts.
 */
export async function determineHeroState(
    sql: postgres.Sql,
    isAdmin: boolean,
): Promise<HeroStateResult> {
    // First fetch steps, then run auto-detection with steps for short-circuit optimization
    const steps = await getOnboardingSteps(sql);

    // Run auto-detection (returns mediaCount) and TMDB check in parallel
    const [autoDetectResult, tmdbResult] = await Promise.all([
        autoDetectOnboardingCompletion(sql, steps),
        sql<[{ count: number }]>`
            SELECT COUNT(*)::int AS count
            FROM external_ids
            WHERE provider = 'tmdb'
        `,
    ]);

    const mediaCount = autoDetectResult.mediaCount;
    const hasTmdbIds = tmdbResult[0].count > 0;
    const allDismissed =
        steps.find((s) => s.step_key === 'onboarding_dismissed')?.dismissed ?? false;

    let heroState: HeroState;

    if (mediaCount === 0 && !allDismissed) {
        heroState = 'onboarding';
    } else if (mediaCount === 0 && allDismissed) {
        heroState = 'onboarding'; // Will be handled as "dismissed" variant in the component
    } else if (!hasTmdbIds) {
        heroState = 'local-content';
    } else {
        heroState = 'full-metadata';
    }

    return {
        heroState,
        onboardingSteps: steps,
        isAdmin,
        mediaCount,
    };
}

/**
 * Return a lightweight OnboardingState snapshot for the attention adapter.
 * Mirrors the exact queries used by determineHeroState so both stay consistent:
 *  - mediaCount  → COUNT(*) FROM media_items WHERE status = 'active' (same short-circuit path)
 *  - hasTmdbIds  → EXISTS on external_ids WHERE provider = 'tmdb' (no type filter, same as hero)
 *  - allDismissed → driven by the 'onboarding_dismissed' step (same as hero)
 */
export async function getOnboardingState(sql: postgres.Sql): Promise<OnboardingState> {
    // Reconcile stored completion against live system state before reading, so
    // the attention nudge never advertises a step the operator already satisfied
    // (e.g. TMDB configured via env). autoDetect short-circuits once all steps
    // are complete and markStepCompleted is idempotent, so this stays cheap.
    const priorSteps = await getOnboardingSteps(sql);
    // autoDetect already counted the active items (on both of its paths); reuse
    // that count instead of running the same full COUNT a second time.
    const { mediaCount } = await autoDetectOnboardingCompletion(sql, priorSteps);
    const steps = await getOnboardingSteps(sql);
    const allDismissed =
        steps.find((s) => s.step_key === 'onboarding_dismissed')?.dismissed ?? false;

    // adaptOnboarding (the sole attention-adapter caller) never reads
    // mediaCount / hasTmdbIds — it only uses `steps` and `allDismissed`. Skip
    // the TMDB check when onboarding is fully dismissed. (autoDetect above
    // still counts active items on every call; that count is what mediaCount
    // reuses below.)
    if (allDismissed) {
        return { steps, allDismissed, mediaCount: 0, hasTmdbIds: false };
    }

    // EXISTS, not COUNT(*) > 0: same answer, stops at the first row.
    const [tmdbResult] = await sql<[{ has: boolean }]>`
        SELECT EXISTS (SELECT 1 FROM external_ids WHERE provider = 'tmdb') AS has
    `;
    const hasTmdbIds = tmdbResult?.has ?? false;
    return { steps, allDismissed, mediaCount, hasTmdbIds };
}

// =============================================================================
// Library item queries (access-scoped)
// =============================================================================

/**
 * A library row returned by the access-scoped item queries below.
 */
export interface LibraryItemRow {
    id: string;
    title: string;
    media_type: string;
    year: number | null;
    overview: string | null;
}

/** {@link LibraryItemRow} plus the row's creation timestamp. */
export interface RecentlyAddedItemRow extends LibraryItemRow {
    created_at: Date;
}

/**
 * Get random media items for the local-content hero state.
 *
 * `access` is REQUIRED on both axes — there is no permissive default. A caller
 * that genuinely wants every row must say so explicitly with
 * `unrestrictedAccess()` so the decision is greppable; a caller that may see
 * nothing uses `denyAllAccess()` (previously inexpressible).
 *
 * NOTE: `media_items` is aliased `mi` here specifically because
 * `buildLibraryAccessFilter` hardcodes that alias in its correlated subqueries
 * (it takes no alias parameter) and `buildAgeRatingFilter` defaults to it. The
 * alias was added with the boundary; do not remove it.
 */
export async function getRandomMediaItems(
    sql: postgres.Sql,
    limit: number,
    access: MediaAccessBoundary,
): Promise<LibraryItemRow[]> {
    // denyAll short-circuits before the round trip. The builders would emit
    // `AND false` and return nothing anyway, but this query has a TABLESAMPLE
    // fast path with a full-scan fallback, so without the short-circuit a
    // deny-everything caller would pay TWO scans to be handed zero rows.
    if (deniesEverything(access)) return [];

    const pick = (sampled: boolean): postgres.PendingQuery<LibraryItemRow[]> =>
        sql`
        SELECT mi.id, mi.title, mi.media_type, mi.year, mi.overview
        FROM media_items mi ${sampled ? sql`TABLESAMPLE BERNOULLI(20)` : sql``}
        WHERE mi.status = 'active'
          AND mi.has_files = true
          AND mi.media_type IN ('movie', 'tv')
          ${buildAgeRatingFilter(sql, access.age)}
          ${buildLibraryAccessFilter(sql, access.library)}
        ORDER BY RANDOM()
        LIMIT ${limit}
    `;
    // TABLESAMPLE BERNOULLI is a fast path for large libraries but can return
    // fewer than `limit` (or nothing) on small ones — fall back to a full random
    // scan so small libraries still get picks.
    const sampled = await pick(true);
    return sampled.length >= limit ? sampled : pick(false);
}

/**
 * Get recently added media items for the For You fallback.
 *
 * `access` is REQUIRED — see {@link getRandomMediaItems}.
 */
export async function getRecentlyAddedItems(
    sql: postgres.Sql,
    limit: number,
    access: MediaAccessBoundary,
): Promise<RecentlyAddedItemRow[]> {
    if (deniesEverything(access)) return [];

    return sql<RecentlyAddedItemRow[]>`
        SELECT mi.id, mi.title, mi.media_type, mi.year, mi.overview, mi.created_at
        FROM media_items mi
        WHERE mi.status = 'active'
          AND mi.parent_id IS NULL
          AND mi.has_files = true
          AND mi.media_type IN ('movie', 'tv')
          ${buildAgeRatingFilter(sql, access.age)}
          ${buildLibraryAccessFilter(sql, access.library)}
        ORDER BY COALESCE(mi.library_added_at, mi.created_at) DESC
        LIMIT ${limit}
    `;
}

/**
 * Get random media items for the For You Random Picks section.
 *
 * `access` is REQUIRED — see {@link getRandomMediaItems}.
 */
export async function getRandomPickItems(
    sql: postgres.Sql,
    limit: number,
    access: MediaAccessBoundary,
    mediaTypes: readonly ('movie' | 'tv')[] | null = null,
): Promise<LibraryItemRow[]> {
    // See getRandomMediaItems: without this, a denyAll caller pays the sampled
    // scan AND the full-scan fallback (the sample can never reach `limit`).
    if (deniesEverything(access)) return [];

    const pick = (sampled: boolean): postgres.PendingQuery<LibraryItemRow[]> =>
        sql`
        SELECT mi.id, mi.title, mi.media_type, mi.year, mi.overview
        FROM media_items mi ${sampled ? sql`TABLESAMPLE BERNOULLI(20)` : sql``}
        WHERE mi.status = 'active'
          AND mi.parent_id IS NULL
          AND mi.has_files = true
          AND mi.media_type = ANY(${mediaTypes ?? ['movie', 'tv']})
          ${buildAgeRatingFilter(sql, access.age)}
          ${buildLibraryAccessFilter(sql, access.library)}
        ORDER BY RANDOM()
        LIMIT ${limit}
    `;
    // TABLESAMPLE is a fast path for large libraries but can under-deliver on
    // small ones — fall back to a full random scan so small libraries still
    // get picks. NOTE: a heavily restricted caller can under-fill the sample for
    // access reasons and pay the second scan; correctness is unaffected (the
    // fallback is unfiltered-by-SAMPLING, never unfiltered-by-ACCESS).
    const sampled = await pick(true);
    return sampled.length >= limit ? sampled : pick(false);
}
