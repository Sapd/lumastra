// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Audiobookshelf reconcile sweep — executor.
 *
 * Drives {@link planAudiobookSweep} against every `library_paths` row with
 * `provider = 'audiobookshelf'`, then applies the plan.
 *
 * Everything that touches the outside world arrives through the two injected
 * ports ({@link AudiobookshelfSweepSource}, {@link AudiobookSweepStore}), so the
 * whole orchestration — including the abort rails, the error accounting and the
 * ScanResult arithmetic — is unit-testable without a server or a database.
 *
 * ABS is the metadata provider for these items (§6 of the design doc): there is
 * no TMDB/AniDB chain member for audiobooks, so a full reconcile would overwrite
 * any Lumastra-local edit every cycle. The reconcile therefore *owns* the row's
 * title/overview/runtime and rewrites them on every observed revision change.
 */

import type {
    AudiobookItemExpanded,
    AudiobookLibrarySnapshot,
    AudiobookshelfRequestError,
    AudiobookshelfResult,
    ListAllLibraryItemsOptions,
} from '$lib/server/audiobookshelf.js';
import type {
    AudiobookFlagUpdate,
    AudiobookshelfMetadata,
    AudiobookWriteParams,
    LocalAudiobookRow,
} from '$lib/server/database/queries/audiobooks.queries.js';
import type { LibraryPathRow } from '$lib/server/database/queries/library-paths.queries.js';
import { deriveSortTitle } from '$lib/server/utils/sort-title.js';
import { sanitizeAudiobookDescription } from './description-text.js';
import { deriveSeries, sequenceToSortOrder } from './series-derive.js';
import {
    planAudiobookSweep,
    normalizeDismissalRatio,
    DEFAULT_MAX_DISMISSAL_RATIO,
    type AudiobookSweepThresholds,
    type LocalAudiobookState,
    type RemoteAudiobookState,
} from './sweep-diff.js';

/** Plugin-settings key for the deletion rail's percentage cap. */
export const DISMISS_MAX_PERCENT_KEY = 'AUDIOBOOKSHELF_DISMISS_MAX_PERCENT';

/**
 * Read the dismissal cap from plugin settings and convert it to a ratio.
 *
 * Anything unusable (absent, non-numeric, negative, NaN) falls back to the 10%
 * default rather than disabling the rail — a typo in the admin form must never
 * be able to unlock unlimited dismissals. Strings are accepted because
 * `plugin_settings.value` is jsonb and the admin form has historically written
 * numeric fields as strings.
 */
export function resolveDismissalRatio(settings: Record<string, unknown>): number {
    const raw = settings[DISMISS_MAX_PERCENT_KEY];
    const percent = typeof raw === 'string' && raw.trim().length > 0 ? Number(raw) : raw;
    if (typeof percent !== 'number' || !Number.isFinite(percent) || percent < 0) {
        return DEFAULT_MAX_DISMISSAL_RATIO;
    }
    return normalizeDismissalRatio(percent / 100);
}

/** The slice of `AudiobookshelfClient` the sweep needs. */
export interface AudiobookshelfSweepSource {
    listAllLibraryItemsMinified(
        libraryId: string,
        options?: ListAllLibraryItemsOptions,
    ): Promise<AudiobookshelfResult<AudiobookLibrarySnapshot>>;
    getLibraryItemExpanded(itemId: string): Promise<AudiobookshelfResult<AudiobookItemExpanded>>;
}

/** Every database effect the sweep performs. */
export interface AudiobookSweepStore {
    /** Local rows carrying `custom_metadata.audiobookshelf.libraryId = absLibraryId`. */
    listLocal(absLibraryId: string): Promise<LocalAudiobookRow[]>;
    /**
     * Insert a book AND its `external_ids` row atomically, returning the new
     * media UUID. Atomicity is required: a committed `media_items` row without
     * its external id is invisible to {@link AudiobookSweepStore.listLocal}
     * (which joins through `external_ids`), so the next sweep would insert a
     * second copy and keep doing so forever.
     */
    insert(absItemId: string, params: AudiobookWriteParams): Promise<string>;
    /** Rewrite an existing row from a fresh expanded fetch. */
    update(mediaId: string, params: AudiobookWriteParams): Promise<void>;
    /** Batch availability/dismissal toggle. */
    setFlags(mediaIds: string[], flags: AudiobookFlagUpdate): Promise<number>;
    /** Invalidate the caches an audiobook row can appear in. Called once per run. */
    onContentChanged(mediaIds: string[]): Promise<void>;
}

export interface SweepLogger {
    info(msg: string, meta?: object): void;
    warn(msg: string, meta?: object): void;
    error(msg: string, meta?: object): void;
    debug(msg: string, meta?: object): void;
}

export interface AudiobookSweepDeps {
    source: AudiobookshelfSweepSource;
    store: AudiobookSweepStore;
    logger: SweepLogger;
    /** `library_paths` rows with `provider = 'audiobookshelf'` and `enabled = true`. */
    libraryPaths: LibraryPathRow[];
    thresholds?: AudiobookSweepThresholds;
    /** Cancellation from the task runner. */
    signal?: AbortSignal;
    /** Page size handed to the upstream listing. */
    pageSize?: number;
}

/**
 * Matches the SDK's `ScanResult`, redeclared structurally so this helper does
 * not depend on the plugin SDK.
 *
 * Field semantics for this source:
 * - `added` — books inserted.
 * - `updated` — rows written (metadata rewrite and/or availability toggle).
 * - `removed` — books dismissed (`is_dismissed = true`, `has_files = false`).
 *   **Never** a `status = 'deleted'`; see the query module's header.
 * - `unmatched` — upstream books that could not be turned into a row this cycle
 *   because their expanded fetch failed or was malformed. They stay eligible
 *   next cycle.
 * - `skipped` — books already in sync, rows an operator moved out of
 *   `status = 'active'`, books dismissed on an earlier cycle and still absent,
 *   and dismissal candidates a rail suppressed.
 */
export interface AudiobookSweepResult {
    added: number;
    updated: number;
    removed: number;
    unmatched: number;
    skipped: number;
    durationMs: number;
    errors: string[];
    /**
     * The same accounting split per `library_paths.id`, so one failing ABS
     * library does not have to be read as a failure of every other one.
     * Every configured row gets an entry, including rows that were never
     * reached (`listed: false`).
     */
    libraries: Record<string, AudiobookLibrarySweepResult>;
}

/**
 * One library's slice of {@link AudiobookSweepResult}.
 *
 * - `listed` — the upstream listing was proven complete, so absence from it
 *   means the book is gone. False for a failed listing, a misconfigured or
 *   duplicate row, and every library the run never reached.
 * - `dismissed` — books dismissed (the run-wide `removed`).
 * - `errors` — how many errors this library recorded, including ones beyond
 *   the run-wide string cap and a tripped dismissal cap.
 */
export interface AudiobookLibrarySweepResult {
    listed: boolean;
    added: number;
    updated: number;
    dismissed: number;
    unmatched: number;
    skipped: number;
    errors: number;
}

type LibraryCounter = Exclude<keyof AudiobookLibrarySweepResult, 'listed' | 'errors'>;

/** Ids per `setFlags` statement — keeps the parameter array a sane size. */
const FLAG_UPDATE_CHUNK = 500;

/**
 * Cap on collected error strings. A library whose every expanded fetch fails
 * would otherwise return one string per book and blow up the run record.
 */
const MAX_COLLECTED_ERRORS = 25;

/** Year values Postgres `make_date` accepts; anything else is stored as NULL. */
const MIN_YEAR = 1;
const MAX_YEAR = 9999;

function describeError(error: AudiobookshelfRequestError): string {
    const parts: string[] = [error.kind];
    if (error.status !== undefined) parts.push(`HTTP ${error.status}`);
    if (error.code !== undefined) parts.push(error.code);
    return `${parts.join(' ')}: ${error.message}`;
}

/**
 * An error kind that means "the server is gone", not "this one item is odd".
 *
 * Continuing through hundreds of these produces hundreds of identical failures
 * and hammers a server that is already down, so the run stops instead.
 */
function isFatalTransportError(error: AudiobookshelfRequestError): boolean {
    return error.kind === 'network' || error.kind === 'not-configured';
}

function chunk<T>(items: T[], size: number): T[][] {
    const out: T[][] = [];
    for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
    return out;
}

function toLocalState(row: LocalAudiobookRow, libraryPathId: string): LocalAudiobookState {
    return {
        mediaId: row.mediaId,
        absItemId: row.absItemId,
        status: row.status,
        hasFiles: row.hasFiles,
        isDismissed: row.isDismissed,
        // Re-adding a removed library gives it a new local path id, without
        // changing ABS's revision. Refetch so the language join is reattached.
        absUpdatedAt:
            row.libraryPathId !== undefined && row.libraryPathId !== libraryPathId
                ? null
                : row.absUpdatedAt,
        absMtimeMs: row.absMtimeMs,
    };
}

function parseYear(raw: string | null): number | null {
    if (!raw) return null;
    // ABS stores publishedYear as free text ("1997", "1997-04", "MCMXCVII").
    // Take the first 4-digit run and ignore anything that is not a plain year.
    const match = /\d{4}/.exec(raw);
    if (!match) return null;
    const year = Number(match[0]);
    if (!Number.isFinite(year) || year < MIN_YEAR || year > MAX_YEAR) return null;
    return year;
}

function positiveSeconds(value: number | null): number | null {
    if (value === null || !Number.isFinite(value) || value <= 0) return null;
    return Math.round(value);
}

function epochToDate(value: number): Date | null {
    if (!Number.isFinite(value) || value <= 0) return null;
    return new Date(value);
}

function basename(relPath: string | null): string | null {
    if (!relPath) return null;
    const segments = relPath.split('/').filter((s) => s.length > 0);
    return segments.length > 0 ? segments[segments.length - 1] : null;
}

export interface BuildAudiobookWriteParamsInput {
    expanded: AudiobookItemExpanded;
    /** `library_paths.provider_path` — the ABS library id. */
    absLibraryId: string;
    /** `library_paths.id`. */
    libraryPathId: string;
    /** `library_paths.library_group_id` — the whole access-control chain hangs off it. */
    libraryGroupId: string;
    /**
     * `library_paths.language` — the DECLARED language of this library, used
     * for sort-title article stripping. Operator-configured, never inferred
     * from the ABS library name (another install will name its libraries
     * anything). Omitted or unknown falls back to English.
     */
    language?: string | null;
    /** Title from the listing, used when the expanded item has none. */
    fallbackTitle?: string | null;
}

/**
 * Map an expanded ABS item onto the columns and `custom_metadata` payload of a
 * `media_items` row. Pure — no I/O, no clock.
 *
 * The revision keys stored are the **expanded** item's, not the listing's: the
 * expanded response is the revision actually imported, so recording it avoids a
 * guaranteed refetch next cycle whenever a book was edited between the listing
 * and the fetch.
 */
export function buildAudiobookWriteParams(
    input: BuildAudiobookWriteParamsInput,
): AudiobookWriteParams {
    const { expanded, absLibraryId, libraryPathId, libraryGroupId } = input;
    const metadata = expanded.media.metadata;

    // `media_items.title` is NOT NULL and drives sort_title and the search
    // vector, so it degrades through every identifier we have rather than
    // risking an empty string.
    const title =
        firstNonEmpty(metadata.title, input.fallbackTitle, basename(expanded.relPath)) ??
        `Untitled (${expanded.id})`;

    const absMetadata: AudiobookshelfMetadata = {
        libraryId: absLibraryId,
        libraryPathId,
        updatedAt: expanded.updatedAt,
        mtimeMs: expanded.mtimeMs,
        addedAt: expanded.addedAt > 0 ? expanded.addedAt : null,
        relPath: expanded.relPath,
        coverPath: expanded.media.coverPath,
        subtitle: metadata.subtitle,
        authors: metadata.authors.map((a) => a.name).filter((n) => n.length > 0),
        narrators: metadata.narrators.filter((n) => n.length > 0),
        // Series + sequence are ingested now even though series parent rows are
        // deferred, so the follow-up does not need a full re-ingest backfill.
        series: metadata.series.map((s) => ({ id: s.id, name: s.name, sequence: s.sequence })),
        // The shelf the destination actually groups on. AudiobookShelf's own
        // series metadata is not sufficient on real libraries — measured against
        // a 1188-item server, 81% of one 666-item library had NO seriesName, with
        // the folder carrying it instead. See series-derive.ts.
        derivedSeries: deriveSeries({
            seriesName: metadata.series[0]?.name ?? null,
            absSequence: metadata.series[0]?.sequence ?? null,
            title: metadata.title,
            relPath: expanded.relPath,
        }),
        genres: metadata.genres,
        publisher: metadata.publisher,
        publishedYear: metadata.publishedYear,
        language: metadata.language,
        isbn: metadata.isbn,
        asin: metadata.asin,
        explicit: metadata.explicit,
        abridged: metadata.abridged,
        duration: expanded.media.duration,
        // Persisted because the player builds its single continuous timeline
        // from these: `startOffset` accumulates the durations, and `ino`
        // addresses each file. Deriving the runtime from them is not enough.
        audioFiles: expanded.media.audioFiles.map((f) => ({
            index: f.index,
            ino: f.ino,
            duration: f.duration,
            mimeType: f.mimeType,
            codec: f.codec,
        })),
        chapters: expanded.media.chapters.map((c) => ({
            id: c.id,
            start: c.start,
            end: c.end,
            title: c.title,
        })),
    };

    return {
        requireConfiguredLibrary: true,
        title,
        // `sort_title` has no DB trigger — the app is its only writer, and
        // skipping it breaks A-Z on the /audiobooks destination.
        // Language-aware: without it a German library piles under D and E
        // (Der/Die/Das/Ein) and A-Z browsing is useless.
        sortTitle: deriveSortTitle(title, null, null, input.language, {
            declaredLanguageOnly: true,
        }),
        // ABS stores this as an HTML fragment (its own editor writes
        // `<p>…</p>` bodies) — see description-text.ts for why the fix lives
        // here at ingest rather than at each of `overview`'s render sites.
        overview: sanitizeAudiobookDescription(metadata.description),
        year: parseYear(metadata.publishedYear),
        runtimeSeconds: positiveSeconds(expanded.media.duration),
        // "Playable in this install" — false only while ABS reports the files
        // gone. See the query module header.
        hasFiles: !expanded.isMissing,
        libraryGroupId,
        libraryAddedAt: epochToDate(expanded.addedAt),
        // Mirrors the derived position so the destination can ORDER BY a plain
        // integer column instead of digging through JSONB on every row.
        sortOrder: sequenceToSortOrder(absMetadata.derivedSeries.sequence),
        metadata: absMetadata,
    };
}

function firstNonEmpty(...values: Array<string | null | undefined>): string | null {
    for (const value of values) {
        if (typeof value === 'string') {
            const trimmed = value.trim();
            if (trimmed.length > 0) return trimmed;
        }
    }
    return null;
}

/** Mutable per-run accounting, shared across libraries. */
class SweepTally {
    added = 0;
    updated = 0;
    removed = 0;
    unmatched = 0;
    skipped = 0;
    readonly touched: string[] = [];
    readonly libraries: Record<string, AudiobookLibrarySweepResult> = {};
    private readonly errors: string[] = [];
    private suppressedErrors = 0;

    /** The per-library slice, created unlisted with zero counts on first use. */
    library(libraryPathId: string): AudiobookLibrarySweepResult {
        let entry = this.libraries[libraryPathId];
        if (!entry) {
            entry = {
                listed: false,
                added: 0,
                updated: 0,
                dismissed: 0,
                unmatched: 0,
                skipped: 0,
                errors: 0,
            };
            this.libraries[libraryPathId] = entry;
        }
        return entry;
    }

    /** Count toward one library and the matching run-wide total. */
    count(libraryPathId: string, counter: LibraryCounter, n = 1): void {
        this.library(libraryPathId)[counter] += n;
        if (counter === 'dismissed') this.removed += n;
        else this[counter] += n;
    }

    /**
     * Record an error string. With a `libraryPathId` it counts against that
     * library. Without one it is run-wide and counts against every library
     * already listed, so a per-library proof fails closed on it.
     */
    addError(message: string, libraryPathId?: string): void {
        if (libraryPathId !== undefined) this.library(libraryPathId).errors++;
        else for (const entry of Object.values(this.libraries)) if (entry.listed) entry.errors++;
        if (this.errors.length < MAX_COLLECTED_ERRORS) {
            this.errors.push(message);
            return;
        }
        this.suppressedErrors++;
    }

    collectErrors(): string[] {
        if (this.suppressedErrors === 0) return [...this.errors];
        return [...this.errors, `…and ${this.suppressedErrors} further error(s) suppressed`];
    }
}

/**
 * Reconcile every configured ABS library against `media_items`.
 *
 * One library's failure never aborts the others — each is diffed and applied
 * independently, and a library whose listing could not be proven complete is
 * skipped entirely rather than diffed against a partial id set.
 */
export async function runAudiobookshelfSweep(
    deps: AudiobookSweepDeps,
): Promise<AudiobookSweepResult> {
    const start = Date.now();
    const tally = new SweepTally();

    // Every configured row starts unlisted, so a library the run never reached
    // (abort, unreachable server) reads as unproven rather than as missing.
    for (const row of deps.libraryPaths) tally.library(row.id);

    const targets = resolveTargets(deps.libraryPaths, tally, deps.logger);

    for (const target of targets) {
        if (deps.signal?.aborted) {
            tally.addError('Sweep aborted before completing every library');
            break;
        }
        const outcome = await sweepLibrary(target, deps, tally);
        if (outcome === 'stop-unreachable') {
            tally.addError(
                'Audiobookshelf server became unreachable — remaining libraries were not swept',
            );
            break;
        }
        if (outcome === 'stop-aborted') break;
    }

    if (tally.touched.length > 0) {
        try {
            await deps.store.onContentChanged(tally.touched);
        } catch (err) {
            deps.logger.warn('Audiobookshelf sweep: cache invalidation failed (non-fatal)', {
                error: err instanceof Error ? err.message : String(err),
            });
        }
    }

    return {
        added: tally.added,
        updated: tally.updated,
        removed: tally.removed,
        unmatched: tally.unmatched,
        skipped: tally.skipped,
        durationMs: Date.now() - start,
        errors: tally.collectErrors(),
        libraries: tally.libraries,
    };
}

interface SweepTarget {
    libraryPathId: string;
    absLibraryId: string;
    libraryGroupId: string;
    /** `library_paths.language`, threaded through to the sort-title derivation. */
    language: string | null;
}

/**
 * Turn `library_paths` rows into sweep targets, dropping the ones that cannot
 * address an ABS library.
 *
 * `provider_path` carries the ABS library id (`path` is the synthetic
 * `abs://…` sentinel and is not a lookup key). A row without it is a
 * misconfiguration that would otherwise silently sweep nothing.
 */
function resolveTargets(
    rows: LibraryPathRow[],
    tally: SweepTally,
    logger: SweepLogger,
): SweepTarget[] {
    const targets: SweepTarget[] = [];
    const seen = new Set<string>();

    for (const row of rows) {
        const absLibraryId = row.provider_path?.trim();
        if (!absLibraryId) {
            tally.addError(
                `library_paths ${row.id} has provider 'audiobookshelf' but no provider_path (ABS library id); skipped`,
                row.id,
            );
            continue;
        }
        if (seen.has(absLibraryId)) {
            // Two rows claiming one ABS library would each see the other's books
            // as their own and fight over them every cycle.
            tally.addError(
                `ABS library ${absLibraryId} is claimed by more than one library_paths row; only the first is swept`,
                row.id,
            );
            continue;
        }
        seen.add(absLibraryId);
        targets.push({
            libraryPathId: row.id,
            absLibraryId,
            libraryGroupId: row.library_group_id,
            language: row.language ?? null,
        });
    }

    logger.debug('Audiobookshelf sweep: resolved targets', { count: targets.length });
    return targets;
}

/**
 * What the caller should do next.
 *
 * `stop-aborted` and `stop-unreachable` are distinguished so the run's error
 * list names the real cause — "the operator cancelled" and "the server went
 * away" call for very different operator responses.
 */
type SweepOutcome = 'continue' | 'stop-aborted' | 'stop-unreachable';

async function sweepLibrary(
    target: SweepTarget,
    deps: AudiobookSweepDeps,
    tally: SweepTally,
): Promise<SweepOutcome> {
    const snapshot = await deps.source.listAllLibraryItemsMinified(target.absLibraryId, {
        limit: deps.pageSize,
    });

    if (!snapshot.ok) {
        // Rail 1, in its strongest form: the client proves completeness or
        // returns nothing, so there is no partial id set to diff against and the
        // library is skipped whole. Additions and updates are lost for this
        // cycle only; the next one recovers them.
        tally.addError(
            `Library ${target.absLibraryId}: upstream listing failed — ${describeError(snapshot.error)}; nothing was changed`,
            target.libraryPathId,
        );
        deps.logger.warn('Audiobookshelf sweep: listing failed, library skipped', {
            libraryId: target.absLibraryId,
            kind: snapshot.error.kind,
        });
        return isFatalTransportError(snapshot.error) ? 'stop-unreachable' : 'continue';
    }

    tally.library(target.libraryPathId).listed = true;
    const localRows = await deps.store.listLocal(target.absLibraryId);

    const remote: RemoteAudiobookState[] = snapshot.value.items.map((item) => ({
        id: item.id,
        updatedAt: item.updatedAt,
        mtimeMs: item.mtimeMs,
        isMissing: item.isMissing,
    }));
    const titleById = new Map(snapshot.value.items.map((item) => [item.id, item.title]));

    const plan = planAudiobookSweep({
        remote,
        local: localRows.map((row) => toLocalState(row, target.libraryPathId)),
        snapshotComplete: true,
        thresholds: deps.thresholds,
    });

    deps.logger.info('Audiobookshelf sweep: plan', {
        libraryId: target.absLibraryId,
        upstream: remote.length,
        local: localRows.length,
        additions: plan.additions.length,
        changes: plan.changes.length,
        dismissals: plan.dismissals.length,
        alreadyDismissed: plan.alreadyDismissed.length,
        dismissalSkip: plan.dismissalSkip?.reason ?? null,
    });

    const lib = target.libraryPathId;
    tally.count(
        lib,
        'skipped',
        plan.unchanged.length + plan.skippedInactive.length + plan.alreadyDismissed.length,
    );
    if (plan.duplicateRemoteIds > 0) {
        tally.addError(
            `Library ${target.absLibraryId}: upstream returned ${plan.duplicateRemoteIds} duplicate item id(s); extras ignored`,
            lib,
        );
    }

    // --- Additions -------------------------------------------------------
    for (const addition of plan.additions) {
        if (deps.signal?.aborted) {
            tally.addError('Sweep aborted while inserting new books', lib);
            return 'stop-aborted';
        }
        const expanded = await deps.source.getLibraryItemExpanded(addition.id);
        if (!expanded.ok) {
            tally.count(lib, 'unmatched');
            tally.addError(
                `Library ${target.absLibraryId}: could not fetch item ${addition.id} — ${describeError(expanded.error)}`,
                lib,
            );
            if (isFatalTransportError(expanded.error)) return 'stop-unreachable';
            continue;
        }

        const params = buildAudiobookWriteParams({
            expanded: expanded.value,
            absLibraryId: target.absLibraryId,
            libraryPathId: target.libraryPathId,
            language: target.language,
            libraryGroupId: target.libraryGroupId,
            fallbackTitle: titleById.get(addition.id) ?? null,
        });

        try {
            const mediaId = await deps.store.insert(addition.id, params);
            tally.count(lib, 'added');
            tally.touched.push(mediaId);
        } catch (err) {
            tally.count(lib, 'unmatched');
            tally.addError(
                `Library ${target.absLibraryId}: insert failed for item ${addition.id} — ${err instanceof Error ? err.message : String(err)}`,
                lib,
            );
        }
    }

    // --- Changes ---------------------------------------------------------
    // Flag-only changes are batched by their target flag pair; a refetch is a
    // per-item round trip because it needs the expanded body anyway.
    const flagOnly = new Map<string, { flags: AudiobookFlagUpdate; ids: string[] }>();

    for (const change of plan.changes) {
        if (deps.signal?.aborted) {
            // Return rather than fall through: the dismissal pass below is a
            // bulk write, and a cancelled run must not perform one.
            tally.addError('Sweep aborted while updating books', lib);
            return 'stop-aborted';
        }

        if (!change.needsRefetch) {
            const key = `${change.hasFiles}`;
            const bucket = flagOnly.get(key) ?? {
                flags: { hasFiles: change.hasFiles, isDismissed: false },
                ids: [],
            };
            bucket.ids.push(change.local.mediaId);
            flagOnly.set(key, bucket);
            continue;
        }

        const expanded = await deps.source.getLibraryItemExpanded(change.remote.id);
        if (!expanded.ok) {
            tally.count(lib, 'unmatched');
            tally.addError(
                `Library ${target.absLibraryId}: could not refetch item ${change.remote.id} — ${describeError(expanded.error)}`,
                lib,
            );
            if (isFatalTransportError(expanded.error)) return 'stop-unreachable';
            continue;
        }

        const params = buildAudiobookWriteParams({
            expanded: expanded.value,
            absLibraryId: target.absLibraryId,
            libraryPathId: target.libraryPathId,
            language: target.language,
            libraryGroupId: target.libraryGroupId,
            fallbackTitle: titleById.get(change.remote.id) ?? null,
        });

        try {
            // `update` also clears any dismissal and re-imports chapters (they
            // travel inside `params.metadata`), which is why a revision change
            // is enough to resurrect a book that came back upstream.
            await deps.store.update(change.local.mediaId, params);
            tally.count(lib, 'updated');
            tally.touched.push(change.local.mediaId);
        } catch (err) {
            tally.addError(
                `Library ${target.absLibraryId}: update failed for item ${change.remote.id} — ${err instanceof Error ? err.message : String(err)}`,
                lib,
            );
        }
    }

    // Re-checked after the per-item loop, not only inside it: a cancellation that
    // lands on the last iteration would otherwise fall straight through into the
    // bulk availability and dismissal writes below.
    if (deps.signal?.aborted) {
        tally.addError('Sweep aborted before the availability and dismissal writes', lib);
        return 'stop-aborted';
    }

    for (const bucket of flagOnly.values()) {
        for (const ids of chunk(bucket.ids, FLAG_UPDATE_CHUNK)) {
            try {
                const affected = await deps.store.setFlags(ids, bucket.flags);
                tally.count(lib, 'updated', affected);
                tally.touched.push(...ids);
            } catch (err) {
                tally.addError(
                    `Library ${target.absLibraryId}: availability update failed for ${ids.length} item(s) — ${err instanceof Error ? err.message : String(err)}`,
                    lib,
                );
            }
        }
    }

    // --- Dismissals ------------------------------------------------------
    if (plan.dismissalSkip) {
        tally.count(lib, 'skipped', plan.dismissalSkip.candidates);
        const message = `Library ${target.absLibraryId}: ${plan.dismissalSkip.message}`;
        tally.addError(message, lib);
        // A suppressed threshold is the loud case the rail exists for — an
        // operator has to look at it, so it is logged at error level even though
        // the sweep itself completed successfully.
        if (plan.dismissalSkip.reason === 'threshold-exceeded') {
            deps.logger.error('Audiobookshelf sweep: dismissal threshold exceeded', {
                libraryId: target.absLibraryId,
                candidates: plan.dismissalSkip.candidates,
                total: plan.dismissalSkip.total,
                allowed: plan.dismissalSkip.allowed,
                ratio: plan.dismissalSkip.ratio,
                thresholdRatio: plan.dismissalSkip.thresholdRatio,
            });
        } else {
            deps.logger.warn('Audiobookshelf sweep: dismissal pass skipped', {
                libraryId: target.absLibraryId,
                reason: plan.dismissalSkip.reason,
                candidates: plan.dismissalSkip.candidates,
            });
        }
        return 'continue';
    }

    const dismissIds = plan.dismissals.map((row) => row.mediaId);
    for (const ids of chunk(dismissIds, FLAG_UPDATE_CHUNK)) {
        try {
            const affected = await deps.store.setFlags(ids, { hasFiles: false, isDismissed: true });
            tally.count(lib, 'dismissed', affected);
            tally.touched.push(...ids);
        } catch (err) {
            tally.addError(
                `Library ${target.absLibraryId}: dismissal failed for ${ids.length} item(s) — ${err instanceof Error ? err.message : String(err)}`,
                lib,
            );
        }
    }

    return 'continue';
}
