// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Ingest Metro Map — line definitions and station/train positioning helpers.
 *
 * The Metro Map renders three horizontal "lines" (movie / series / music),
 * each with a fixed sequence of "stations" representing the pipeline stages
 * applicable to that line's media types. "Trains" are media items positioned
 * along their line at the station representing their current state.
 *
 * Hardcoded for v1 — Phase 1b+ may make line definitions data-driven from
 * the TaskRegistry's `coversStages` declarations.
 */

import type { StageStatus } from '$lib/types/pipeline.js';
import { isEpisode, isSeason } from '$lib/shared/media-types.js';
import { toPublicMediaType } from '$lib/shared/media-type-domain';

export type LineId = 'movie' | 'series' | 'music';

export interface MetroLineDef {
    id: LineId;
    label: string;
    /** DB media_type values that belong on this line (DB uses 'tv' for series). */
    mediaTypes: readonly string[];
    /** Stage IDs in left-to-right station order. */
    stations: readonly string[];
    /** Short labels for each station — must match stations length. */
    stationLabels: readonly string[];
    /** Tailwind base color class for trains on this line. */
    trainColor: string;
}

/**
 * Summary-only rows shown below the regular metro lines. These media types
 * have no applicable pipeline stages (no `coversStages` declarations target
 * them) so they can't be drawn as stations + trains. We render them as a
 * single chip with a count + drill-down link.
 *
 * Used by both the IngestMap query (to compute counts) and the IngestMap
 * Svelte component (to render the chips). Single source of truth so the
 * query and UI can't drift apart.
 */
export interface SummaryBucketDef {
    id: string;
    label: string;
    /**
     * Singular and plural unit word for the count (e.g. "channel"/"channels"
     * or "item"/"items"). Rendered after the number so the chip reads as a
     * library inventory tally — `1,368 channels` — rather than ambiguous
     * "1,368" that could be confused with in-flight pipeline items.
     */
    unitSingular: string;
    unitPlural: string;
    /** DB media_type values this bucket aggregates. */
    mediaTypes: readonly string[];
    /** Tailwind base color for the chip. */
    color: string;
    /** Optional drill-down route — set to null to render an unlinked count. */
    drillHref: string | null;
}

export const SUMMARY_BUCKETS: readonly SummaryBucketDef[] = [
    {
        id: 'livetv',
        label: 'Live TV',
        unitSingular: 'channel',
        unitPlural: 'channels',
        mediaTypes: ['tvchannel'],
        color: 'amber',
        drillHref: '/admin/settings/livetv?tab=channels',
    },
    {
        id: 'other',
        label: 'Other media',
        unitSingular: 'item',
        unitPlural: 'items',
        // Anything ingested that isn't a movie/series/episode/season/music
        // and isn't a Live TV channel. Grouped because none of these get any
        // pipeline coverage — embeddings, metadata sync, etc. all skip them.
        mediaTypes: ['extra', 'home_video', 'training', 'personal', 'educational', 'radio'],
        color: 'zinc',
        drillHref: '/admin/tasks/pipeline?view=completion',
    },
] as const;

export const LINES: readonly MetroLineDef[] = [
    {
        id: 'movie',
        label: 'Movies',
        mediaTypes: ['movie'],
        stations: [
            'media-probe-a',
            'tmdb-metadata-sync',
            'library-embeddings',
            'discovery-embeddings',
            'image-sync',
            'trickplay-params-sync',
            'trickplay-generation',
            'mdblist-sync',
        ],
        stationLabels: [
            'scan',
            'tmdb',
            'lib-emb',
            'disc-emb',
            'art',
            'tp-params',
            'tp-gen',
            'mdblist',
        ],
        trainColor: 'sky',
    },
    {
        id: 'series',
        label: 'Series & Episodes',
        mediaTypes: ['tv', 'episode'],
        // `tmdb-metadata-sync` is intentionally NOT a station on this line —
        // its `coversStages.appliesTo` is movies-only (per-episode metadata
        // refresh flows through series-sync). Listing it here would render a
        // permanently-empty station that's just visual noise.
        //
        // Some of these stations apply only to a subset of the line's
        // media_types — e.g. `series-sync` only runs on series-typed items,
        // `trickplay-*` only on episodes. The metro UI now renders those
        // as dashed "ghost" stations for items that pass through without
        // stopping. See STAGE_APPLIES_TO + stationsForMediaType below.
        stations: [
            'media-probe-a',
            'series-sync',
            'library-embeddings',
            'image-sync',
            'mdblist-sync',
            'trickplay-params-sync',
            'trickplay-generation',
            'lumastra-intro-analyzer:visual',
        ],
        stationLabels: [
            'scan',
            'series',
            'lib-emb',
            'art',
            'mdblist',
            'tp-params',
            'tp-gen',
            'intro',
        ],
        trainColor: 'violet',
    },
    {
        id: 'music',
        label: 'Music',
        mediaTypes: ['track', 'album', 'artist'],
        // The Music line had the worst phantom-skip problem: an `album`
        // item structurally applies to only `album-enrichment` (1 of 6
        // stations before image-sync was added). The line now includes
        // image-sync because its coversStages.appliesTo covers album +
        // artist; the dashed-ghost rendering surfaces per-item which
        // stations are actually load-bearing for that media_type.
        stations: [
            'media-probe-a',
            'music-analysis',
            'acoustid-fingerprint',
            'album-enrichment',
            'artist-enrichment',
            'music-embedding-generation',
            'music-popularity',
            'image-sync',
        ],
        stationLabels: ['scan', 'analyze', 'id', 'album', 'artist', 'embed', 'pop', 'art'],
        trainColor: 'emerald',
    },
] as const;

/**
 * Mirror of every builtin task's `coversStages[].appliesTo` declaration.
 * Used by the metro-line UI to compute, per-item, which stations on the
 * line that item actually stops at — versus which it merely passes
 * through (rendered as dashed "ghost" stations).
 *
 * **Keep in sync** with each task file's `coversStages.appliesTo`. There's
 * an ESLint rule pending to enforce this at build time; for now the
 * authority is the registry at runtime (mirrored here because the metro
 * map renders in the browser and can't import server-only registry code).
 *
 * Source of truth: `src/lib/server/tasks/builtin/native/*.ts`
 */
export const STAGE_APPLIES_TO: Record<string, ReadonlyArray<string>> = {
    'media-probe-a': ['movie', 'episode', 'track'],
    'media-probe-b': ['movie', 'episode'],
    'tmdb-metadata-sync': ['movie'],
    'series-sync': ['series'],
    'library-embeddings': ['movie', 'series'],
    'discovery-embeddings': ['movie', 'series'],
    'image-sync': ['movie', 'series', 'episode'],
    'trickplay-params-sync': ['movie', 'episode'],
    'trickplay-generation': ['movie', 'episode'],
    'lumastra-intro-analyzer:visual': ['movie', 'episode'],
    'mdblist-sync': ['movie', 'series'],
    'music-analysis': ['track'],
    'album-enrichment': ['album'],
    'artist-enrichment': ['artist'],
    'music-embedding-generation': ['track'],
    'acoustid-fingerprint': ['track'],
    'sonic-embedding-backfill': ['track'],
    'music-popularity': ['artist'],
    'chapter-sync': ['series', 'movie'],
    // Mirrors fribb-anime-sync.ts's coversStages.appliesTo, which covers
    // 'movie' too (BUG 5 fix there) — this mirror had drifted (pre-existing,
    // unrelated to the admin-ia redesign; fixed while eslint's
    // stage-applies-to-mirror-in-sync rule flagged it against this file).
    'fribb-anime-sync': ['movie', 'series'],
    'mal-anime-id-enrichment': ['series'],
    'metadata-update': ['movie', 'series'],
    'integrity-file-present': ['movie', 'episode', 'track'],
    // provider-artwork-* — SDK spelling: the TV branch is 'series', never 'tv'.
    // The eligibility SQL in provider-artwork-backfill.ts uses 'tv'; these
    // arrays are matched AFTER stage-state.service.ts:207-211 translates.
    'provider-artwork-poster': ['movie', 'series', 'episode'],
    'provider-artwork-backdrop': ['movie', 'series', 'episode'],
    'provider-artwork-logo': ['movie', 'series'],
    'provider-artwork-thumb': ['episode'],
    'provider-artwork-season-poster': ['season'],
};

/**
 * Resource class each stage's task runs in. Used by the metro station
 * tooltip to surface queue contention — "your station has 5 items
 * pending but the cpu queue has 450 items ahead in the same worker
 * pool" tells the operator the station isn't stuck, it's just waiting
 * its turn behind a different task.
 *
 * Same mirror-of-task-definitions pattern as STAGE_APPLIES_TO and same
 * keep-in-sync hazard. ENFORCED: callback-safety/stage-applies-to-mirror-in-sync
 * reports missingResourceClass / mismatchResourceClass against this map and is
 * set to 'error' in eslint.config.cjs:135.
 */
export const STAGE_RESOURCE_CLASS: Record<string, string> = {
    'media-probe-a': 'ingest',
    'media-probe-b': 'ingest',
    'tmdb-metadata-sync': 'bulk',
    'series-sync': 'bulk',
    'library-embeddings': 'embedding',
    'discovery-embeddings': 'discovery',
    'image-sync': 'ingest',
    'trickplay-params-sync': 'ingest',
    'trickplay-generation': 'cpu',
    'lumastra-intro-analyzer:visual': 'analysis',
    'mdblist-sync': 'bulk',
    'music-analysis': 'analysis',
    'album-enrichment': 'bulk',
    'artist-enrichment': 'bulk',
    'music-embedding-generation': 'embedding',
    'acoustid-fingerprint': 'analysis',
    'sonic-embedding-backfill': 'embedding',
    'music-popularity': 'bulk',
    'chapter-sync': 'ingest',
    'fribb-anime-sync': 'bulk',
    'mal-anime-id-enrichment': 'bulk',
    'metadata-update': 'bulk',
    'integrity-file-present': 'ingest',
    'provider-artwork-poster': 'bulk',
    'provider-artwork-backdrop': 'bulk',
    'provider-artwork-logo': 'bulk',
    'provider-artwork-thumb': 'bulk',
    'provider-artwork-season-poster': 'bulk',
};

/**
 * The media_type values media_items.media_type carries in Postgres differ
 * from the canonical SDK names used in `coversStages.appliesTo`. `media_items`
 * uses 'tv' for the series row; the SDK uses 'series'. Translate at the
 * boundary so STAGE_APPLIES_TO lookups work for the live DB representation.
 */
function canonicalMediaType(raw: string): string {
    // Promote 'tv' → 'series' to match the SDK stage names; pass provider-only
    // values (which have no public form) through unchanged.
    return toPublicMediaType(raw) ?? raw;
}

/**
 * Does this stage apply (structurally) to items of the given media_type?
 * Returns `true` when the stage's `appliesTo` includes the type, or when
 * we don't have a mapping for the stage (defensive default — better to
 * show as solid than to mistakenly ghost an applicable station).
 */
export function stageAppliesTo(stageId: string, mediaType: string | undefined): boolean {
    if (!mediaType) return true;
    const list = STAGE_APPLIES_TO[stageId];
    if (!list) return true;
    return list.includes(canonicalMediaType(mediaType));
}

/**
 * Per-station display metadata used by hover tooltips. Keyed by stage_id so a
 * station that appears on multiple lines (e.g. `library-embeddings` is on the
 * Movies + Series lines) shares one description.
 *
 * Sourced from each task's `name` field in `src/lib/server/tasks/builtin/native/*`.
 * Kept here (not loaded dynamically from the registry) because the Metro Map
 * runs in the browser and can't import the task definitions; copying the strings
 * is the simplest path and rarely drifts (stations are stable).
 */
export interface StationInfo {
    fullName: string;
    description: string;
}

export const STATION_INFO: Record<string, StationInfo> = {
    'media-probe-a': {
        fullName: 'Media probe — quick scan',
        description:
            'ffprobe pass that reads container, codecs, duration, and embedded chapters from the file.',
    },
    'media-probe-b': {
        fullName: 'Media probe — deep scan',
        description:
            'Second ffprobe pass for trickplay seeking, stream details, and HDR / Dolby Vision metadata.',
    },
    'tmdb-metadata-sync': {
        fullName: 'TMDB metadata sync',
        description:
            'Fetches title, year, overview, cast, and crew from TMDB. Movies only — series get series-sync.',
    },
    'series-sync': {
        fullName: 'Series sync',
        description:
            'Refreshes series-level metadata and walks the season / episode tree from the resolved metadata provider.',
    },
    'library-embeddings': {
        fullName: 'Library embeddings',
        description:
            'Generates OpenAI embeddings for items in the library. Powers For-You and mood-vector recommendations.',
    },
    'discovery-embeddings': {
        fullName: 'Discovery embeddings',
        description:
            'Generates embeddings for items in the TMDB / MDBList discovery pool (things the user does not own yet).',
    },
    'image-sync': {
        fullName: 'Image sync',
        description: 'Downloads poster / backdrop / logo artwork and caches it locally.',
    },
    'trickplay-params-sync': {
        fullName: 'Trickplay params sync',
        description:
            'Reads existing trickplay metadata from the provider and writes the per-file params (tile dimensions, interval). Lightweight precondition step before the ffmpeg render.',
    },
    'trickplay-generation': {
        fullName: 'Trickplay generation',
        description:
            'ffmpeg sprite-sheet rendering that produces the actual scrub-bar thumbnails. CPU-bound; short-circuits when tiles already exist on disk.',
    },
    'mdblist-sync': {
        fullName: 'MDBList sync',
        description: 'Pulls additional ratings (Rotten Tomatoes, Metacritic, etc.) from MDBList.',
    },
    'lumastra-intro-analyzer:visual': {
        fullName: 'Intro analyzer',
        description:
            'Detects opening and credit segments inside the audio so the player can offer skip controls.',
    },
    'music-analysis': {
        fullName: 'Music analysis',
        description:
            'Measures loudness (LUFS), BPM, and key from audio files so playback / EQ has the data it needs.',
    },
    'album-enrichment': {
        fullName: 'Album enrichment',
        description:
            'Fills in album-level metadata (release date, cover art, MusicBrainz ID) from external providers.',
    },
    'artist-enrichment': {
        fullName: 'Artist enrichment',
        description: 'Fills in artist-level metadata (biography, genre tags, images).',
    },
    'acoustid-fingerprint': {
        fullName: 'AcoustID fingerprint',
        description:
            'Identifies tracks without MusicBrainz tags by their sound (needs an AcoustID key), so album art and popularity can use the MusicBrainz ids.',
    },
    'music-embedding-generation': {
        fullName: 'Music embeddings',
        description:
            'Generates embeddings for tracks. Powers music recommendations and Quick Picks clustering.',
    },
    'sonic-embedding-backfill': {
        fullName: 'Sonic embeddings (audio)',
        description:
            'Generates MSCLAP audio embeddings for tracks via the sonic embedder. Powers sound-alike, the music map, song paths, clustering, and text-to-sound search.',
    },
    'music-popularity': {
        fullName: 'Music popularity',
        description:
            'Refreshes play-count derived popularity scores for tracks, albums, and artists.',
    },
};

export type TrainMode = 'running' | 'waiting' | 'failed' | 'done';

export interface ItemStageRow {
    stage_id: string;
    status: StageStatus;
    processing_version: number;
    attempt: number;
    last_error: { message: string; code?: string } | null;
    updated_at: Date | string;
    /**
     * Why the row is in a skipped_* status (e.g. 'predicate-false',
     * 'ineligible-by-legacy-filter'). Null for non-skipped rows.
     * Server-side mirror of media_item_stage_state.skipped_reason.
     */
    skipped_reason?: string | null;
    /**
     * When a failed_transient or skipped_transient row becomes
     * eligible for retry. Null for terminal/running/non-retry states.
     * Always a string on the wire — the page-server preload coerces
     * Date → ISO string and SSE events don't carry this field, so the
     * client never sees a raw `Date` here.
     */
    next_eligible_at?: string | null;
}

/**
 * Format the headline label for a train pill or list entry.
 *
 * For episodes, we want "Haus des Geldes · S01E22" to dominate so the
 * viewer can tell which series a "Folge 22" episode belongs to. The
 * episode's own title gets demoted to subtitle (rendered separately).
 *
 * For seasons, the item's own title is often just "Season 1" or
 * "Specials" — a name shared by hundreds of shows and useless for
 * telling them apart in a list. Prefix it with the series title when
 * available: "Haus des Geldes · Season 1".
 *
 * For everything else, just the item title — that's all the info the
 * line provides anyway.
 */
export interface ItemLabelInput {
    media_type: string;
    title: string;
    series_title?: string | null;
    season_number?: number | null;
    episode_number?: number | null;
}

function pad2(n: number): string {
    return n < 10 ? `0${n}` : String(n);
}

export function formatTrainHeadline(item: ItemLabelInput): string {
    if (isSeason(item.media_type)) {
        const series = item.series_title?.trim();
        return series ? `${series} · ${item.title}` : item.title;
    }
    if (!isEpisode(item.media_type)) return item.title;
    const series = item.series_title?.trim();
    const s = item.season_number;
    const e = item.episode_number;
    if (series && s != null && e != null) {
        return `${series} · S${pad2(s)}E${pad2(e)}`;
    }
    if (series) return `${series} · ${item.title}`;
    if (s != null && e != null) return `S${pad2(s)}E${pad2(e)} — ${item.title}`;
    return item.title;
}

/**
 * Estimate the visual width of `s` in monospace-half-width units, then
 * truncate so the result fits inside `maxUnits`. A Latin character is 1
 * unit; a CJK ideograph, Hangul syllable, or full-width punctuation
 * mark is 2 (roughly matching the rendered width in the train-pill
 * font). Without this the SVG `<text>` overflows the pill rect for any
 * title containing Chinese / Japanese / Korean / full-width
 * punctuation — observed on preprod with a "2025 腾讯视频 …" series
 * where 18-codepoint truncation still spilled past the pill.
 *
 * The thresholds correspond to one CJK char ≈ 2 Latin chars in width.
 * Tested against the 132 px train pill at 11 px font: ~16 half-units
 * fits comfortably. Slight under-fill on all-Latin strings is fine —
 * better to leave a few px of margin than to overflow on the next
 * Unicode-heavy title.
 */
function isDoubleWidthCodepoint(cp: number): boolean {
    // CJK Unified Ideographs (incl. extensions A blocks):  U+3000–U+9FFF
    if (cp >= 0x3000 && cp <= 0x9fff) return true;
    // Hangul Syllables:                                     U+AC00–U+D7AF
    if (cp >= 0xac00 && cp <= 0xd7af) return true;
    // Halfwidth/Fullwidth Forms (fullwidth half):           U+FF00–U+FFEF
    if (cp >= 0xff00 && cp <= 0xffef) return true;
    // CJK Unified Ideographs Extension B–F                  U+20000–U+2FFFF
    if (cp >= 0x20000 && cp <= 0x2ffff) return true;
    return false;
}

export function truncateForPill(s: string, maxUnits = 18): string {
    let units = 0;
    let outChars = 0;
    // Walk codepoints (not UTF-16 code units) so a surrogate pair counts
    // as one wide char, not two narrow ones.
    const codepoints = Array.from(s);
    for (const ch of codepoints) {
        const cp = ch.codePointAt(0);
        if (cp === undefined) continue;
        const w = isDoubleWidthCodepoint(cp) ? 2 : 1;
        if (units + w > maxUnits) break;
        units += w;
        outChars += 1;
    }
    if (outChars >= codepoints.length) return s;
    return codepoints.slice(0, outChars).join('') + '…';
}

/** Subtitle to render beneath the headline. Empty string means no subtitle. */
export function formatTrainSubtitle(item: ItemLabelInput): string {
    if (!isEpisode(item.media_type)) return '';
    // For episodes, the headline carries series + SxxEyy; we WANT the raw
    // episode title surfaced as subtitle so concise titles ("Folge 22",
    // "Pilot") are visible. BUT some providers return overview-shaped
    // strings as the title field — e.g. on Kyousougiga, TMDB emits the
    // show synopsis as the per-episode `title`. Rendering that runs the
    // tooltip past 200 chars of noise.
    //
    // Gate: only show the subtitle when it's plausibly a real title —
    // short, and visually different from the headline. Empty string
    // means the UI omits the subtitle row entirely.
    const t = item.title.trim();
    if (t.length === 0) return '';
    if (t.length > 40) return '';
    const headline = formatTrainHeadline(item);
    if (headline.includes(t)) return '';
    return t;
}

export interface CurrentStation {
    /** Index into the line's stations array. `stations.length` means "past the end" (done). */
    index: number;
    mode: TrainMode;
}

/**
 * Pick the line whose mediaTypes include this item's media_type.
 * Returns null when no line matches (e.g., unknown media type).
 */
export function lineForMediaType(mediaType: string): MetroLineDef | null {
    for (const line of LINES) {
        if (line.mediaTypes.includes(mediaType)) return line;
    }
    return null;
}

/**
 * Compute the station index and visual mode for a train on a given line.
 *
 * Our pipeline fires stages CONCURRENTLY — stage-sweep enqueues every
 * eligible coverage row in parallel, so stages complete out of order.
 * A naïve "rightmost completed" wins-it parking scheme produced false
 * "done" trains: e.g. an item with mdblist-sync completed but
 * media-probe-a still pending would render as a finished train at the
 * end of the line, hiding the upstream backlog.
 *
 * Correct semantics: the train sits at the LEFTMOST station that hasn't
 * settled into a terminal "we don't need to do this" status
 * (`completed` or `skipped_permanent`). That's where the work
 * actually is, regardless of which downstream stations have already
 * finished.
 *
 * Decision order:
 *   1. Any `running` stage → train AT that station, animated (running).
 *   2. Any `failed_permanent` stage → train AT the leftmost such, parked.
 *   3. Any `failed_transient` stage → train AT the leftmost such, parked.
 *   4. Leftmost not-terminal station (pending / obsolete / skipped_transient
 *      / unknown / missing-row) → train AT that station, waiting.
 *   5. All stations terminal → train at last station, mode='done'.
 *
 * Stages on `stages` that aren't in this line's stations array are ignored.
 */
export function currentStationIndex(
    stations: readonly string[],
    stages: readonly ItemStageRow[],
    /**
     * Optional. When provided, "not-applicable" stations (where the
     * stage's `appliesTo` doesn't include this media_type) are skipped
     * in the leftmost-non-terminal scan — so an item never gets parked
     * at a station it structurally can't stop at. The returned index
     * still refers to the original `stations` array (so the renderer
     * can place the train), it just skips ghost stations.
     */
    mediaType?: string,
): CurrentStation {
    if (stations.length === 0) return { index: 0, mode: 'waiting' };

    const stageByName = new Map<string, ItemStageRow>();
    for (const s of stages) stageByName.set(s.stage_id, s);

    const TERMINAL = new Set<StageStatus>(['completed', 'skipped_permanent']);

    // Helper — true iff this station is a "ghost" (structurally
    // not-applicable) for the current item. Ghost stations don't count
    // for "current station" decisions; the train passes through them.
    const isGhost = (stationId: string): boolean =>
        mediaType != null && !stageAppliesTo(stationId, mediaType);

    // 1. running takes priority — the train is actively moving here.
    for (let i = 0; i < stations.length; i++) {
        if (isGhost(stations[i])) continue;
        const s = stageByName.get(stations[i]);
        if (s?.status === 'running') return { index: i, mode: 'running' };
    }

    // 2. + 3. Failed states pin the train where the failure is. Leftmost
    // wins so a downstream failure doesn't hide an upstream one.
    for (let i = 0; i < stations.length; i++) {
        if (isGhost(stations[i])) continue;
        const s = stageByName.get(stations[i]);
        if (s?.status === 'failed_permanent') return { index: i, mode: 'failed' };
    }
    for (let i = 0; i < stations.length; i++) {
        if (isGhost(stations[i])) continue;
        const s = stageByName.get(stations[i]);
        if (s?.status === 'failed_transient') return { index: i, mode: 'failed' };
    }

    // 4. Leftmost not-terminal applicable station. Pending, obsolete,
    // skipped_transient, or "no row recorded yet" all count as
    // not-yet-done — the user wants to see WHERE the work is parked.
    // Ghost stations are skipped so a series-typed item doesn't get
    // parked at `lumastra-intro-analyzer` (episodes-only) and stay there
    // forever waiting for work that will never run.
    for (let i = 0; i < stations.length; i++) {
        if (isGhost(stations[i])) continue;
        const s = stageByName.get(stations[i]);
        if (!s || !TERMINAL.has(s.status)) {
            return { index: i, mode: 'waiting' };
        }
    }

    // 5. All applicable stations terminal — train at the last APPLICABLE
    // station (not the last visible one, which might be a ghost).
    for (let i = stations.length - 1; i >= 0; i--) {
        if (!isGhost(stations[i])) return { index: i, mode: 'done' };
    }
    // Defensive fallback: every station is a ghost for this media_type.
    // Shouldn't happen in practice; return last station so the train still renders.
    return { index: stations.length - 1, mode: 'done' };
}

/** Approximate "completed in last hour" check using stage updated_at timestamps. */
export function recentlyCompleted(
    stations: readonly string[],
    stages: readonly ItemStageRow[],
    now: number,
    windowMs = 60 * 60 * 1000,
): boolean {
    const station = currentStationIndex(stations, stages);
    if (station.mode !== 'done') return false;
    // Compute latest updated_at across stations.
    let latest = 0;
    for (const s of stages) {
        const t =
            typeof s.updated_at === 'string' ? Date.parse(s.updated_at) : s.updated_at.getTime();
        if (Number.isFinite(t) && t > latest) latest = t;
    }
    return latest > 0 && now - latest <= windowMs;
}
