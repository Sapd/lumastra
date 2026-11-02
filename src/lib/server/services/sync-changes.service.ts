// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import type { Sql } from 'postgres';
import type { UserContext } from '$lib/server/types';
import type { SearchAccessContext } from '$lib/server/utils/search-access-context';
import { buildSearchAccessContext } from '$lib/server/utils/search-access-context';
import {
    SyncCatalogKindSchema,
    SyncUserKindSchema,
    type SyncChange,
    type SyncChangesResponse,
    type SyncUserStateResponse,
    type SyncLibraryResponse,
    type SyncErrorReason,
    type SyncUserKind,
    type SyncStateFields,
} from '$lib/schemas/api-sync';
import { apiUrl } from '$lib/shared/api-urls';
import { SYNC_KIND_BY_MEDIA_TYPE } from '$lib/server/sync/capture-registry';
import {
    accessTag,
    encodeSyncCursor,
    decodeSyncCursor,
    compareSyncPositions,
    syncVersion,
    type SyncPosition,
} from '$lib/server/sync/cursor';
import {
    readSyncState,
    scanSyncLog,
    readSyncLibraryIds,
    readSyncItemFacts,
    readSyncUserData,
    oldestSyncWriterAge,
    type SyncLogRow,
    type SyncItemFacts,
} from '$lib/server/database/queries/sync-read.queries';
import { Logger } from '$lib/server/utils/logger';
import { withTx } from '$lib/server/database/with-tx';
import { checkSyncInstance } from '$lib/server/database/queries/sync-changes.queries';
import { ApiProblem } from '$lib/server/api/problem';

export class SyncReadError extends Error {
    constructor(public readonly reason: SyncErrorReason | 'invalid_param') {
        super(reason);
        this.name = 'SyncReadError';
    }
}

/** Rows must be in ascending position order: the first known age is the old boundary. */
export function mergeSyncRows(rows: readonly SyncLogRow[]): SyncLogRow {
    if (!rows.length) throw new Error('Cannot merge an empty sync group');
    const sorted = [...rows].sort(compareSyncPositions);
    const newest = sorted[sorted.length - 1];
    const age = sorted.find((row) => row.prev_age_known);
    return {
        ...newest,
        prev_library_ids: [...new Set(sorted.flatMap((row) => row.prev_library_ids))],
        prev_libs_known: sorted.some((row) => row.prev_libs_known),
        prev_age_known: age !== undefined,
        prev_age_rating: age?.prev_age_rating ?? null,
    };
}

export function decideCatalogChange(
    row: SyncLogRow,
    facts: SyncItemFacts | undefined,
    ctx: Pick<SearchAccessContext, 'deniedGroupIds' | 'ageRating'>,
): 'upsert' | 'delete' | null {
    if (facts?.in_sync_set && facts.passes_boundary) return 'upsert';
    if (!facts && (!row.prev_libs_known || !row.prev_age_known)) return null;
    const libraries = row.prev_libs_known ? row.prev_library_ids : (facts?.library_ids ?? []);
    if (!libraries.length || (!row.prev_libs_known && !facts?.has_any_files)) return null;
    const denied = ctx.deniedGroupIds;
    const libraryAllowed = denied === null || libraries.some((id) => !denied.includes(id));
    const age = row.prev_age_known ? row.prev_age_rating : (facts?.effective_age ?? null);
    const ageAllowed =
        ctx.ageRating?.maxAgeRating == null ||
        (age === null ? ctx.ageRating.allowUnrated : age <= ctx.ageRating.maxAgeRating);
    return libraryAllowed && ageAllowed ? 'delete' : null;
}

/** Sync errors as problem+json: 410 `gone` + `reason` means "drop the cursor and reload". */
export function syncErrorResponse(error: SyncReadError, invalidParamMessage?: string): Response {
    if (error.reason === 'invalid_param') {
        return ApiProblem.validationFailed(
            invalidParamMessage ?? 'Invalid sync parameter or malformed cursor',
        );
    }
    return ApiProblem.gone('Discard the sync cursor and run the initial load again', {
        reason: error.reason,
        headers: { 'Cache-Control': 'private, no-store' },
    });
}

/**
 * Sync is for people's own clients: sessions, forward auth, OAuth bearer and PATs.
 * Service tokens, stream tokens and /j compat credentials are not accepted.
 */
export function isSyncCredential(kind: string | undefined, url?: URL): boolean {
    if (kind === undefined || !['session', 'forward_auth', 'pat', 'bearer'].includes(kind))
        return false;
    // Long-lived credentials must not travel in URLs (access logs, proxies, referrers).
    if (url && (url.searchParams.has('api_key') || url.searchParams.has('stream_token')))
        return false;
    return true;
}

const logger = Logger.for('LibrarySync');
let lastWriterCheck = 0;

/** A diagnostic query failure must not abort the repeatable-read transaction. */
async function warnAboutOldWriter(sql: Sql): Promise<void> {
    const now = Date.now();
    if (now - lastWriterCheck < 5 * 60_000) return;
    lastWriterCheck = now;
    try {
        const age = await oldestSyncWriterAge(sql);
        if (age !== null && age > 15 * 60) {
            logger.warn('Open write transaction is delaying library sync', { ageSeconds: age });
        }
    } catch {
        // Diagnostics can be unavailable to the app role; sync remains usable.
    }
}

/** One snapshot for the log scan, the visibility query and the inline state. */
async function snapshotRead<T>(sql: Sql, fn: (db: Sql) => Promise<T>): Promise<T> {
    return await withTx(sql, async (db) => {
        await db`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY`;
        return await fn(db);
    });
}

let lastInstanceCheck = 0;

/** A failover or restore while the process keeps running: re-check at most once a minute. */
async function checkInstanceSometimes(sql: Sql): Promise<void> {
    const now = Date.now();
    if (now - lastInstanceCheck < 60_000) return;
    lastInstanceCheck = now;
    try {
        await checkSyncInstance(sql);
    } catch (error) {
        logger.warn(
            'Library sync instance check failed',
            error instanceof Error ? error : new Error(String(error)),
        );
    }
}

export async function readSyncChanges(options: {
    sql: Sql;
    user: UserContext;
    cursor?: string;
    limit: number;
    surface?: 'v1' | 'internal';
}): Promise<SyncChangesResponse> {
    const { sql, user, cursor: rawCursor, limit, surface = 'v1' } = options;
    if (!Number.isInteger(limit) || limit < 1 || limit > 1000)
        throw new SyncReadError('invalid_param');
    const decoded = rawCursor === undefined ? undefined : decodeSyncCursor(rawCursor, user.userId);
    if (decoded?.status === 'malformed') throw new SyncReadError('invalid_param');
    if (decoded?.status === 'invalid') throw new SyncReadError('invalid_cursor');
    const cursor = decoded?.status === 'ok' ? decoded.cursor : undefined;
    await checkInstanceSometimes(sql);
    const result = await snapshotRead(sql, async (db) => {
        const state = await readSyncState(db);
        // Scope construction uses the same narrowed UserContext as library endpoints.
        const ctx = await buildSearchAccessContext(db, user);
        const tag = accessTag(ctx);
        if (cursor) {
            if (cursor.instanceId !== state.instance_id || cursor.epoch !== state.epoch) {
                throw new SyncReadError('log_reset');
            }
            if (BigInt(cursor.xid) > BigInt(state.xmax)) throw new SyncReadError('log_reset');
            if (
                state.pruned_xid !== null &&
                compareSyncPositions(cursor, {
                    xid: state.pruned_xid,
                    seq: state.pruned_seq,
                }) < 0
            )
                throw new SyncReadError('cursor_expired');
            if (cursor.accessTag !== tag) throw new SyncReadError('access_changed');
        }
        const encode = (position: SyncPosition): string =>
            encodeSyncCursor({
                ...position,
                instanceId: state.instance_id,
                epoch: state.epoch,
                userId: user.userId,
                accessTag: tag,
            });
        if (!cursor)
            return {
                items: [],
                page: {
                    limit,
                    nextCursor: encode({ xid: state.horizon, seq: '0' }),
                    hasMore: false,
                },
                initialLoad: [
                    ...SyncCatalogKindSchema.options.map((kind) => ({
                        kind,
                        href: apiUrl(surface, `/sync/library?kind=${kind}&limit=1000`),
                    })),
                    ...SyncUserKindSchema.options.map((kind) => ({
                        kind,
                        href: apiUrl(surface, `/sync/user-state?kind=${kind}&limit=500`),
                    })),
                ],
            } satisfies SyncChangesResponse;
        const cap = 10 * limit;
        const catalog = await scanSyncLog(db, null, cursor, state.horizon, cap);
        const own = await scanSyncLog(db, user.userId, cursor, state.horizon, cap);
        const merged = [...catalog, ...own].sort(compareSyncPositions);
        const page = merged.slice(0, cap);
        let hasMore = merged.length > cap;
        const facts = new Map(
            (
                await readSyncItemFacts(
                    db,
                    [
                        ...new Set(
                            page.filter((row) => row.user_id === null).map((row) => row.entity_id),
                        ),
                    ],
                    ctx,
                )
            ).map((item) => [item.id, item]),
        );
        const data = new Map<string, SyncStateFields>();
        for (const kind of SyncUserKindSchema.options) {
            const ids = [
                ...new Set(
                    page
                        .filter((row) => row.user_id !== null && row.kind === kind)
                        .map((row) => row.entity_id),
                ),
            ];
            for (const item of await readSyncUserData(db, user.userId, ctx, kind, {
                ids,
                limit: cap,
            })) {
                data.set(`${kind}:${item.id}`, item.state);
            }
        }
        const entry = (row: SyncLogRow): SyncChange | null => {
            if (row.user_id !== null) {
                const value = data.get(`${row.kind}:${row.entity_id}`);
                return {
                    kind: row.kind,
                    id: row.entity_id,
                    version: syncVersion(row),
                    op: value === undefined ? 'delete' : 'upsert',
                    ...value,
                };
            }
            const item = facts.get(row.entity_id);
            const op = decideCatalogChange(row, item, ctx);
            if (!op) return null;
            const kind =
                item && Object.hasOwn(SYNC_KIND_BY_MEDIA_TYPE, item.media_type)
                    ? SYNC_KIND_BY_MEDIA_TYPE[
                          item.media_type as keyof typeof SYNC_KIND_BY_MEDIA_TYPE
                      ]
                    : row.kind;
            return { kind, id: row.entity_id, op, version: syncVersion(row) };
        };
        const groups = new Map<string, SyncLogRow>();
        const entries = new Map<string, SyncChange>();
        let consumed: SyncPosition = cursor;
        for (const row of page) {
            // Catalog identity survives a kind change, so merge both logged kinds into one id.
            const key =
                row.user_id === null ? `catalog:${row.entity_id}` : `${row.kind}:${row.entity_id}`;
            const previous = groups.get(key);
            const combined = previous ? mergeSyncRows([previous, row]) : row;
            const change = entry(combined);
            if (change && !entries.has(key) && entries.size === limit) {
                hasMore = true;
                break;
            }
            groups.set(key, combined);
            if (change) entries.set(key, change);
            else entries.delete(key);
            consumed = row;
        }
        const horizon = { xid: state.horizon, seq: '0' };
        const next = hasMore
            ? consumed
            : compareSyncPositions(cursor, horizon) > 0
              ? cursor
              : horizon;
        return {
            items: [...entries.values()].sort((a, b) => a.version.localeCompare(b.version)),
            page: { limit, nextCursor: encode(next), hasMore },
        } satisfies SyncChangesResponse;
    });
    // Outside the data transaction: monitoring privileges/errors never poison its snapshot.
    await warnAboutOldWriter(sql);
    return result;
}

export async function readSyncUserState(options: {
    sql: Sql;
    user: UserContext;
    kind: SyncUserKind;
    cursor?: string;
    limit: number;
}): Promise<SyncUserStateResponse> {
    const { sql, user, kind, cursor: after, limit } = options;
    if (!Number.isInteger(limit) || limit < 1 || limit > 500)
        throw new SyncReadError('invalid_param');
    if (after !== undefined) {
        const valid =
            kind === 'playlist'
                ? /^\d{1,10}$/.test(after) && Number(after) > 0 && Number(after) <= 2147483647
                : /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(after);
        if (!valid) throw new SyncReadError('invalid_param');
    }
    return await snapshotRead(sql, async (db) => {
        const ctx = await buildSearchAccessContext(db, user);
        const rows = await readSyncUserData(db, user.userId, ctx, kind, {
            after,
            limit: limit + 1,
        });
        const items = rows.slice(0, limit).map((row) => ({ id: row.id, ...row.state }));
        return {
            items,
            page: {
                limit,
                hasMore: rows.length > limit,
                ...(rows.length > limit ? { nextCursor: items[items.length - 1].id } : {}),
            },
        };
    });
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function readSyncLibrary(options: {
    sql: Sql;
    user: UserContext;
    kind: string;
    cursor?: string;
    limit: number;
}): Promise<SyncLibraryResponse> {
    const { sql, user, kind, cursor: after, limit } = options;
    if (!SyncCatalogKindSchema.safeParse(kind).success) throw new SyncReadError('invalid_param');
    if (!Number.isInteger(limit) || limit < 1 || limit > 1000)
        throw new SyncReadError('invalid_param');
    if (after !== undefined && !UUID_RE.test(after)) throw new SyncReadError('invalid_param');
    return await snapshotRead(sql, async (db) => {
        const ctx = await buildSearchAccessContext(db, user);
        const ids = await readSyncLibraryIds(db, ctx, kind, { after, limit: limit + 1 });
        const page = ids.slice(0, limit);
        return {
            items: page.map((id) => ({ id })),
            page: {
                limit,
                hasMore: ids.length > limit,
                ...(ids.length > limit ? { nextCursor: page[page.length - 1] } : {}),
            },
        };
    });
}
