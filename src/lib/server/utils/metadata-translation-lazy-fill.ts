// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Lazy-fill (multilingual-metadata spec §4.3): fire-and-forget a single-item
 * translations backfill when the viewer's language is admin-enabled but this
 * item has no translation row for it yet. The caller's response always
 * serves the (primary-language) fallback — no added request latency.
 *
 * Movie/series only. Episodes are deliberately excluded: TMDB's episode
 * overview coverage is sparse enough in practice that re-enqueueing on every
 * view would just burn API calls without producing data TMDB doesn't have.
 *
 * Shared by every read path that resolves a movie/series detail — each
 * caller resolves its own `langs` once per request (see
 * `resolveMetadataLanguage`) and passes them in, so the enqueue decision here
 * stays a synchronous, side-effect-free check on top of that shared result.
 */

import type postgres from 'postgres';
import { hasTranslation } from '$lib/server/database/queries/media-translations.queries.js';
import { Logger } from './logger.js';

const logger = Logger.for('MetadataTranslationLazyFill');

/** Resolved overlay languages — `null` means "primary; skip that field". */
export interface LazyFillLanguages {
    titleLang: string | null;
    textLang: string | null;
}

export interface LazyFillContext {
    /** Attached to the enqueued run's trigger for tracing which read path fired it. */
    sourceRoute: string;
}

/**
 * Fire-and-forget enqueue of a metadata-translations-sync run for
 * `internalId`, when all of: a user is present, `publicType` is movie or
 * series, at least one of `langs.titleLang`/`langs.textLang` is non-null,
 * no translation row already exists for the resolved language, and the
 * item's sync stage isn't already sitting in a terminal
 * (failed_permanent/skipped_permanent) state. Never throws — enqueue
 * failures are caught and logged.
 */
export function triggerMetadataTranslationLazyFill(
    sql: postgres.Sql,
    internalId: string,
    publicType: string,
    userId: string | undefined,
    langs: LazyFillLanguages,
    context: LazyFillContext,
): void {
    if (
        !userId ||
        (publicType !== 'movie' && publicType !== 'series') ||
        !(langs.titleLang || langs.textLang)
    ) {
        return;
    }

    void (async () => {
        // Title preference wins when both title/text resolve to different
        // languages — mirrors the overlay's own title-vs-text split, but
        // the backfill enqueue is single-language (the sync task re-syncs
        // every admin-enabled language for the item in one run anyway).
        const lang = langs.titleLang ?? langs.textLang;
        if (!lang) return;
        if (await hasTranslation(sql, internalId, lang)) return;
        // Only enqueue when the stage row is pending/absent — never for
        // failed_permanent/skipped_permanent, so items TMDB genuinely
        // can't translate don't re-enqueue on every view.
        const [stageRow] = await sql<{ status: string }[]>`
            SELECT status FROM media_item_stage_state
             WHERE media_item_id = ${internalId}::uuid
               AND stage_id = 'metadata-translations-sync'
        `;
        if (stageRow && stageRow.status !== 'pending') return;
        const { orchestrator } = await import('$lib/server/tasks/orchestrator.js');
        await orchestrator.startRun(
            'metadata-translations-sync',
            { mediaItemId: internalId },
            {
                trigger: { kind: 'in-process', sourceRoute: context.sourceRoute },
                // Same `coverage:` key stage-sweep uses (stage-sweep.ts
                // ~:690) so repeated detail views of the same title — and
                // the sweep itself — dedupe against one in-flight run
                // instead of enqueueing a duplicate per view while the
                // stage row sits 'pending' in a deep backlog (the
                // watch-sync 324-pending incident class).
                idempotencyKey: `coverage:metadata-translations-sync:${internalId}`,
            },
        );
    })().catch((err: unknown) => {
        logger.debug('metadata-translations-sync lazy-fill failed', {
            mediaId: internalId,
            error: err instanceof Error ? err.message : String(err),
        });
    });
}
