// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import type postgres from 'postgres';
import { withTx } from '$lib/server/database/with-tx.js';
import {
    resolveMusicArtistCredit,
    findMusicArtistByName,
    isActiveMusicArtistCredit,
    findMusicArtistProviderMatches,
} from '$lib/server/database/queries/media-items.queries.js';
import {
    resolveArtistCredit,
    NO_ARTIST_CREDIT_EVIDENCE,
    type ArtistCreditEvidence,
} from '$lib/server/tasks/builtin/native/media-sources/_helpers/file-scanner/artist-credit.js';
import { clampTagText } from '$lib/server/utils/tag-text.js';
import { extractRemixerCandidates } from '$lib/shared/remix-credit.js';

export interface TrackArtistCredit {
    id: string | null;
    credited_name: string;
}
export interface ArtistCreditReconciliationOptions {
    libraryGroupId?: string | null;
    evidence?: ArtistCreditEvidence;
    /** Reject a plan made from an older stored tag snapshot. */
    expectedMetadata?: Record<string, unknown>;
    resolutionCache?: Map<string, string | null>;
}
const nameKey = (name: string): string => name.normalize('NFC').toLowerCase().trim();
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function strings(value: unknown): string[] {
    return Array.isArray(value)
        ? value
              .filter((v): v is string => typeof v === 'string')
              .slice(0, 64)
              .map(clampTagText)
              .filter(Boolean)
        : [];
}
function ids(value: unknown): string[] {
    return strings(value).filter((id) => UUID.test(id));
}
function names(
    meta: Record<string, unknown>,
    multi: string,
    single: string,
    evidence: ArtistCreditEvidence,
): string[] {
    const values = strings(meta[multi]);
    if (values.length > 1) {
        // "Björk" twice, once NFD or in other case, is one performer.
        const seen = new Set<string>();
        return values
            .map((name) => name.trim())
            .filter((name) => name && !seen.has(nameKey(name)) && Boolean(seen.add(nameKey(name))));
    }
    const scalar =
        values[0] ?? (typeof meta[single] === 'string' ? clampTagText(meta[single]) : '');
    return scalar.trim() ? resolveArtistCredit(scalar.trim(), evidence).slice(0, 64) : [];
}

export interface TitleRemixerMembership {
    title_remixer_artist_ids: string[];
    independent_remixer_artist_ids: string[];
    remixer_artist_ids: string[];
}
/** Preserve explicit role ownership even when the same artist also has a title credit. */
export function reconcileTitleRemixerMembership(
    meta: Record<string, unknown>,
    titleIds: string[],
): TitleRemixerMembership {
    const previousTitle = new Set(ids(meta.title_remixer_artist_ids));
    const independent = [
        ...new Set([
            ...ids(meta.independent_remixer_artist_ids),
            ...ids(meta.remixer_artist_ids).filter((id) => !previousTitle.has(id)),
        ]),
    ];
    return {
        title_remixer_artist_ids: [...new Set(titleIds)],
        independent_remixer_artist_ids: independent,
        remixer_artist_ids: [...new Set([...independent, ...titleIds])],
    };
}
function storedCredits(value: unknown): TrackArtistCredit[] {
    return Array.isArray(value)
        ? value.filter(
              (entry: unknown): entry is TrackArtistCredit =>
                  typeof entry === 'object' &&
                  entry !== null &&
                  'credited_name' in entry &&
                  typeof entry.credited_name === 'string' &&
                  'id' in entry &&
                  (entry.id === null || (typeof entry.id === 'string' && UUID.test(entry.id))),
          )
        : [];
}
/** Reconcile a complete ordered performer credit under the track row lock. */
export async function reconcileTrackArtistCredits(
    sql: postgres.Sql,
    trackId: string,
    options: ArtistCreditReconciliationOptions = {},
): Promise<boolean> {
    return withTx(sql, async (tx): Promise<boolean> => {
        // Trusted scanner/migration identity maintenance; public reads apply their own access gates.
        // eslint-disable-next-line callback-safety/no-unscoped-media-items
        const [row] = await tx<
            {
                custom_metadata: Record<string, unknown>;
                library_group_id: string | null;
                title: string;
                metadata_locked: boolean;
            }[]
        >`
            SELECT COALESCE(custom_metadata, '{}'::jsonb) AS custom_metadata, library_group_id, title, metadata_locked
            FROM media_items WHERE id = ${trackId} AND media_type = 'track' AND status = 'active'
              AND ${options.expectedMetadata === undefined ? tx`true` : tx`COALESCE(custom_metadata, '{}'::jsonb) = ${tx.json(options.expectedMetadata as Record<string, never>)}`}
            FOR UPDATE
        `;
        if (!row) return false;
        const meta = row.custom_metadata;
        // Locked metadata belongs to the operator, including legacy rows that
        // do not yet have structured credits.
        if (row.metadata_locked) return false;
        // A retag moves the old credit aside (audio-processor) so unchanged
        // names keep their established identity.
        const parked =
            typeof meta.artist_credit_previous === 'object' && meta.artist_credit_previous !== null
                ? (meta.artist_credit_previous as Record<string, unknown>)
                : undefined;
        const previousCredits = storedCredits(
            Array.isArray(meta.track_artist_credits) ? meta.track_artist_credits : parked?.credits,
        );
        const evidence = options.evidence ?? NO_ARTIST_CREDIT_EVIDENCE;
        let performers = names(meta, 'artists', 'artist', evidence);
        const albums = names(meta, 'album_artists', 'album_artist', evidence);
        const providerIds = ids(meta.musicbrainz_artist_ids);
        const explicitNames = strings(meta.artists);
        const wholeScalar =
            explicitNames[0] ?? (typeof meta.artist === 'string' ? clampTagText(meta.artist) : '');
        if (
            providerIds.length === 1 &&
            Array.isArray(meta.musicbrainz_artist_ids) &&
            meta.musicbrainz_artist_ids.length === 1 &&
            explicitNames.length <= 1 &&
            wholeScalar.trim() &&
            (await findMusicArtistProviderMatches(tx, providerIds[0])).length > 0
        ) {
            // A verified indivisible act outranks name-splitting evidence. An
            // ambiguous claim remains one unresolved credit, never its parts.
            performers = [wholeScalar.trim()];
        }
        // Only explicit multi-values, or a single indivisible credit, establish
        // positional correspondence. A composite scalar + several IDs does not.
        const aligned =
            Array.isArray(meta.musicbrainz_artist_ids) &&
            meta.musicbrainz_artist_ids.length === providerIds.length &&
            providerIds.length === performers.length &&
            (strings(meta.artists).length === performers.length || performers.length === 1);
        const resolve = async (name: string, providerId?: string): Promise<string | null> => {
            const key = JSON.stringify([nameKey(name), providerId ?? null]);
            const cache = options.resolutionCache;
            if (cache?.has(key)) {
                const cached = cache.get(key) ?? null;
                if (cached === null || (await isActiveMusicArtistCredit(tx, cached, providerId)))
                    return cached;
                cache.delete(key);
            }
            const id = await resolveMusicArtistCredit(
                tx,
                name,
                providerId,
                options.libraryGroupId ?? row.library_group_id,
            );
            cache?.set(key, id);
            return id;
        };
        const source = { performers, albums, provider_ids: aligned ? providerIds : [] };
        const sourceValue = meta.artist_credit_source ?? parked?.source;
        const previousSource =
            typeof sourceValue === 'object' && sourceValue !== null
                ? (sourceValue as Record<string, unknown>)
                : undefined;
        // Pass 1 decides which credits keep their established identity
        // (read-only). Pass 2 resolves the rest in one global order: creating
        // an artist holds its unique-index entry until this transaction
        // commits, so two scanners creating {A, B} in opposite orders would
        // otherwise deadlock.
        const performerPlan: { name: string; providerId?: string; id?: string }[] = [];
        for (const [index, name] of performers.entries()) {
            const providerId = aligned ? providerIds[index] : undefined;
            const prior = previousCredits.find(
                (credit) => nameKey(credit.credited_name) === nameKey(name),
            );
            const previousIndex = previousSource
                ? strings(previousSource.performers).findIndex(
                      (value) => nameKey(value) === nameKey(name),
                  )
                : -1;
            const providerEvidenceUnchanged =
                !previousSource ||
                (previousIndex >= 0 &&
                    (strings(previousSource.provider_ids)[previousIndex] ?? undefined) ===
                        providerId);
            const retain =
                providerEvidenceUnchanged &&
                prior?.id &&
                (await isActiveMusicArtistCredit(tx, prior.id, providerId));
            performerPlan.push({
                name,
                providerId,
                ...(retain && prior?.id ? { id: prior.id } : {}),
            });
        }
        const previousAlbumIds = ids(meta.album_artist_ids);
        const albumPlan: { name: string; id?: string }[] = [];
        for (const name of albums) {
            const previousIndex = previousSource
                ? strings(previousSource.albums).findIndex(
                      (value) => nameKey(value) === nameKey(name),
                  )
                : -1;
            const priorId =
                previousIndex >= 0 &&
                strings(previousSource?.albums).length === previousAlbumIds.length
                    ? previousAlbumIds[previousIndex]
                    : undefined;
            albumPlan.push({
                name,
                ...(priorId && (await isActiveMusicArtistCredit(tx, priorId))
                    ? { id: priorId }
                    : {}),
            });
        }
        const resolved = new Map<string, string | null>();
        const pending = [
            ...performerPlan.filter((p) => p.id === undefined),
            ...albumPlan
                .filter((p) => p.id === undefined)
                .map((p) => ({ name: p.name, providerId: undefined })),
        ].sort(
            (a, b) =>
                nameKey(a.name).localeCompare(nameKey(b.name)) ||
                (a.providerId ?? '').localeCompare(b.providerId ?? ''),
        );
        for (const { name, providerId } of pending) {
            const key = JSON.stringify([nameKey(name), providerId ?? null]);
            if (!resolved.has(key)) resolved.set(key, await resolve(name, providerId));
        }
        const resolvedId = (name: string, providerId?: string): string | null =>
            resolved.get(JSON.stringify([nameKey(name), providerId ?? null])) ?? null;
        const credits: TrackArtistCredit[] = [];
        for (const { name, providerId, id: retained } of performerPlan) {
            const id = retained ?? resolvedId(name, providerId);
            // Unresolved duplicates differing only in case/NFC are one credit.
            if (
                !credits.some((credit) =>
                    id
                        ? credit.id === id
                        : !credit.id && nameKey(credit.credited_name) === nameKey(name),
                )
            ) {
                credits.push({ id, credited_name: name });
            }
        }
        const albumIds: string[] = [];
        for (const { name, id: retained } of albumPlan) {
            const id = retained ?? resolvedId(name);
            if (id && !albumIds.includes(id)) albumIds.push(id);
        }
        // Remixer title credits are match-only. This also classifies legacy
        // additional IDs before canonical performer reads stop consulting them.
        const titleRemixerIds: string[] = [];
        for (const candidate of extractRemixerCandidates(row.title)) {
            for (const name of resolveArtistCredit(candidate, evidence)) {
                const id = await findMusicArtistByName(tx, name);
                if (id && !titleRemixerIds.includes(id)) titleRemixerIds.push(id);
            }
        }
        const remixerMembership = reconcileTitleRemixerMembership(meta, titleRemixerIds);
        const remixerIds = remixerMembership.remixer_artist_ids;
        const fileIds = credits.flatMap((credit) => (credit.id ? [credit.id] : []));
        const previousOwned = new Set([
            ...ids(meta.file_artist_ids),
            ...ids(meta.album_artist_ids),
            ...ids(meta.remixer_artist_ids),
        ]);
        const independent = ids(meta.additional_artist_ids).filter((id) => !previousOwned.has(id));
        const nextIds = [...new Set([...independent, ...fileIds, ...albumIds, ...remixerIds])];
        const raw = meta.raw_artist_tags ?? {
            source: 'stored_metadata',
            ...(typeof meta.artist === 'string' ? { artist: clampTagText(meta.artist) } : {}),
            ...(Array.isArray(meta.artists) ? { artists: strings(meta.artists) } : {}),
            ...(typeof meta.album_artist === 'string'
                ? { album_artist: clampTagText(meta.album_artist) }
                : {}),
            ...(Array.isArray(meta.album_artists)
                ? { album_artists: strings(meta.album_artists) }
                : {}),
            ...(providerIds.length ? { musicbrainz_artist_ids: providerIds } : {}),
        };
        const patch = {
            raw_artist_tags: raw,
            track_artist_credits: credits,
            file_artist_ids: fileIds,
            album_artist_ids: albumIds,
            ...remixerMembership,
            artist_credit_source: source,
            additional_artist_ids: nextIds,
        };
        const [changed] = await tx<{ id: string }[]>`
            UPDATE media_items SET custom_metadata = COALESCE(custom_metadata, '{}'::jsonb)
                - ARRAY['artist_credit_repair_error', 'artist_credit_previous'] || ${tx.json(patch as unknown as Record<string, never>)}
            WHERE id = ${trackId}
              AND COALESCE(custom_metadata, '{}'::jsonb) IS DISTINCT FROM
                  COALESCE(custom_metadata, '{}'::jsonb) - ARRAY['artist_credit_repair_error', 'artist_credit_previous']
                      || ${tx.json(patch as unknown as Record<string, never>)}
            RETURNING id
        `;
        return Boolean(changed);
    });
}
