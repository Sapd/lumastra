// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Library-wide artist-credit evidence, loaded from the database and shared
 * across one scan.
 *
 * Every file a scan touches resolves its artist credit, so the index is built
 * once and reused rather than re-queried per track. A snapshot taken at the
 * start of a scan cannot see tags the same scan is still inserting — on a
 * fresh library it is empty and every ambiguous credit is kept whole. That is
 * the safe direction, and `mergeCollaborationArtists` rebuilds the evidence
 * FRESH after the scan and splits whatever the complete library proves, so a
 * scan still converges in one pass. The TTL only bounds how stale the snapshot
 * a later scan starts from can be.
 */
import type postgres from 'postgres';
import { listArtistCreditEvidenceSources } from '../../../../../../database/queries/artist-merge.queries.js';
import { Logger } from '$lib/server/utils/logger.js';
import {
    buildArtistCreditEvidence,
    NO_ARTIST_CREDIT_EVIDENCE,
    type ArtistCreditEvidence,
} from './artist-credit.js';

const logger = Logger.for('ArtistCreditEvidence');

const EVIDENCE_TTL_MS = 10 * 60 * 1000;

let cached: { at: number; evidence: Promise<ArtistCreditEvidence> } | null = null;

async function loadEvidence(sql: postgres.Sql): Promise<ArtistCreditEvidence> {
    const { tags, knownActs } = await listArtistCreditEvidenceSources(sql);
    return buildArtistCreditEvidence(tags, knownActs);
}

/**
 * The shared evidence snapshot. `fresh: true` rebuilds it now (and replaces the
 * shared copy) — the post-scan passes use that so they decide on the complete
 * library, not on whatever the scan started with, and a failed fresh load
 * throws so the pass is skipped. A failed shared load degrades to NO evidence
 * (every ambiguous credit kept whole — the safe direction) rather than failing
 * every file of the scan.
 */
export async function getArtistCreditEvidence(
    sql: postgres.Sql,
    opts: { fresh?: boolean } = {},
): Promise<ArtistCreditEvidence> {
    const now = Date.now();
    // Transaction and reserved handles can see rows that later roll back. Never
    // consume or publish the process-wide snapshot through those handles.
    const handle = sql as unknown as { begin?: unknown; savepoint?: unknown };
    const cacheable = typeof handle.begin === 'function' && typeof handle.savepoint !== 'function';
    if (!cacheable && opts.fresh) cached = null;
    let entry = cacheable ? cached : null;
    if (opts.fresh || !entry || now - entry.at >= EVIDENCE_TTL_MS) {
        entry = { at: now, evidence: loadEvidence(sql) };
        if (cacheable) cached = entry;
    }
    try {
        return await entry.evidence;
    } catch (err) {
        // Never pin a failed load; the next caller retries.
        if (cached === entry) cached = null;
        if (opts.fresh) throw err;
        logger.warn('Artist-credit evidence unavailable — keeping credits whole', {
            error: err instanceof Error ? err.message : String(err),
        });
        return NO_ARTIST_CREDIT_EVIDENCE;
    }
}

/** Test hook: forget the shared snapshot. */
export function resetArtistCreditEvidenceCache(): void {
    cached = null;
}
