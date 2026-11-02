// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import type postgres from 'postgres';
import { config } from '$lib/server/config.js';
import { withTx } from '$lib/server/database/with-tx.js';
import {
    getReconciliationCatalogInputs,
    getReconciliationEvidence,
    lockReconciliationEvidence,
    type ReconciliationEvidence,
} from '$lib/server/database/queries/episode-reconciliation.queries.js';
import type { TmdbCatalogEpisode } from './episode-reconciliation.service.js';

interface CatalogOrigin {
    seriesId: string;
    evidence: ReconciliationEvidence;
    language: string;
}
export const reconciliationCatalogEvidence = new WeakMap<TmdbCatalogEpisode[], CatalogOrigin>();

/** Clone provider objects so callers cannot mutate a privately proven plan. */
export function snapshotReconciliationCatalog(
    catalog: TmdbCatalogEpisode[],
    origin: CatalogOrigin,
): TmdbCatalogEpisode[] {
    const snapshot = catalog.map((entry) => {
        const copy = { ...entry, altNames: [...(entry.altNames ?? [])] };
        Object.freeze(copy.altNames);
        return Object.freeze(copy);
    });
    Object.freeze(snapshot);
    reconciliationCatalogEvidence.set(snapshot, origin);
    return snapshot;
}

/** Start BEFORE the series producer performs provider I/O or consumes language.
 * Only this closure can finish that operation. Its own catalog child writes may
 * change the graph; they cannot bless changed provider identity or language.
 * Completion captures the resulting graph coherently, without provider I/O
 * under locks. An arbitrary caller array never receives apply authority. */
export type ReconciliationCatalogResult =
    | { status: 'ready'; catalog: TmdbCatalogEpisode[] }
    | { status: 'skipped'; reason: 'stale-catalog' };

export async function beginReconciliationCatalog(
    sql: postgres.Sql,
    seriesId: string,
): Promise<(catalog: TmdbCatalogEpisode[]) => Promise<ReconciliationCatalogResult>> {
    const inputs = await getReconciliationCatalogInputs(sql, seriesId);
    const language = config.TMDB_LANGUAGE;
    return async (catalog) =>
        withTx(sql, async (tx) => {
            await tx`SELECT set_config('lock_timeout', '10s', true)`;
            await tx`SELECT pg_advisory_xact_lock(hashtext(${seriesId})::bigint)`;
            await lockReconciliationEvidence(tx, seriesId);
            if (
                language !== config.TMDB_LANGUAGE ||
                inputs !== (await getReconciliationCatalogInputs(tx, seriesId))
            )
                return { status: 'skipped', reason: 'stale-catalog' } as const;
            return {
                status: 'ready',
                catalog: snapshotReconciliationCatalog(catalog, {
                    seriesId,
                    language,
                    evidence: await getReconciliationEvidence(tx, seriesId),
                }),
            } as const;
        });
}
