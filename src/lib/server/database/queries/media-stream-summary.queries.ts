// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import type postgres from 'postgres';
import { normalizeToIso6391 } from '$lib/utils/language-codes';
import { isSeries } from '$lib/server/utils/media-types';
import type { BestAudioStream } from '$lib/server/utils/media-quality-summary';

/**
 * A coarser SQL-side twin of this module's strict-majority rollup lives at
 * `media-item-languages.queries.ts` (the `media_item_languages` projection,
 * mig 16.148.0). It powers the /browse language filter with the same
 * strict-majority pattern but normalizes to a de/en/ja/ko/'other' bucket set,
 * which is why it can't power this modal's real-language display.
 */

/** Per-unit facts: one unit is a movie (itself) or a series episode. */
export interface UnitFacts {
    unitId: string;
    /** normalized 639-1 audio languages present on this unit (deduped) */
    audioLanguages: string[];
    /** normalized 639-1 subtitle languages (embedded + sidecar) on this unit */
    subtitleLanguages: string[];
    hasAudioStream: boolean;
    hasSubtitleTrack: boolean;
    hasVideoStream: boolean;
    cc: boolean;
    sdh: boolean;
    ad: boolean;
}

export interface MediaStreamSummary {
    audioLanguages: string[];
    subtitleLanguages: string[];
    hasClosedCaptions: boolean;
    hasSDH: boolean;
    hasAudioDescription: boolean;
    bestAudio: BestAudioStream | null;
}

/**
 * Roll units up to a summary. A single unit (movie) collapses to its own union
 * because a language present in the only unit is a strict majority (1*2 > 1).
 * Denominators are per-kind: audio langs & AD over units with audio, subtitle
 * langs & SDH over units with a subtitle track, CC over units with video — so a
 * unit lacking a kind never dilutes that kind's majority.
 */
export function rollupMajority(units: UnitFacts[]): Omit<MediaStreamSummary, 'bestAudio'> {
    const majorityLangs = (
        pick: (u: UnitFacts) => { langs: string[]; present: boolean },
    ): string[] => {
        let denom = 0;
        const counts = new Map<string, number>();
        for (const u of units) {
            const { langs, present } = pick(u);
            if (!present) continue;
            denom += 1;
            for (const lang of new Set(langs)) counts.set(lang, (counts.get(lang) ?? 0) + 1);
        }
        return [...counts.entries()]
            .filter(([, c]) => c * 2 > denom)
            .map(([lang]) => lang)
            .sort();
    };

    const majorityFlag = (pick: (u: UnitFacts) => { flag: boolean; present: boolean }): boolean => {
        let denom = 0;
        let count = 0;
        for (const u of units) {
            const { flag, present } = pick(u);
            if (!present) continue;
            denom += 1;
            if (flag) count += 1;
        }
        return count * 2 > denom;
    };

    return {
        audioLanguages: majorityLangs((u) => ({
            langs: u.audioLanguages,
            present: u.hasAudioStream,
        })),
        subtitleLanguages: majorityLangs((u) => ({
            langs: u.subtitleLanguages,
            present: u.hasSubtitleTrack,
        })),
        hasClosedCaptions: majorityFlag((u) => ({ flag: u.cc, present: u.hasVideoStream })),
        hasSDH: majorityFlag((u) => ({ flag: u.sdh, present: u.hasSubtitleTrack })),
        hasAudioDescription: majorityFlag((u) => ({ flag: u.ad, present: u.hasAudioStream })),
    };
}

const EMPTY: MediaStreamSummary = {
    audioLanguages: [],
    subtitleLanguages: [],
    hasClosedCaptions: false,
    hasSDH: false,
    hasAudioDescription: false,
    bestAudio: null,
};

interface StreamRow {
    unit_id: string;
    stream_type: 'audio' | 'video' | 'subtitle';
    language: string | null;
    is_hearing_impaired: boolean;
    is_visual_impaired: boolean;
    has_closed_captions: boolean;
}
interface SidecarRow {
    unit_id: string;
    language: string | null;
    is_sdh: boolean;
}

/** Resolve the aggregation units for an item: the movie itself, or its episodes. */
async function resolveUnitIds(
    sql: postgres.Sql,
    internalId: string,
    mediaType: string,
): Promise<string[]> {
    if (!isSeries(mediaType)) return [internalId];
    // System rollup — walks the episode/season tree under a series id.
    // eslint-disable-next-line callback-safety/no-unscoped-media-items
    const eps = await sql<{ id: string }[]>`
        SELECT ep.id
        FROM media_items ep
        LEFT JOIN media_items parent ON parent.id = ep.parent_id
        WHERE ep.media_type = 'episode'
          AND COALESCE(parent.parent_id, ep.parent_id) = ${internalId}::uuid
    `;
    return eps.map((e) => e.id);
}

/**
 * Aggregate audio/subtitle languages + CC/SDH/AD flags for a movie or series,
 * plus a best-audio stream (used to populate audioCodec/Atmos for series, which
 * the base media-detail query leaves null). Movie = union across its files;
 * series = strict majority across episodes.
 */
export async function getMediaStreamSummary(
    sql: postgres.Sql,
    internalId: string,
    mediaType: string,
): Promise<MediaStreamSummary> {
    const unitIds = await resolveUnitIds(sql, internalId, mediaType);
    if (unitIds.length === 0) return EMPTY;

    const streams = await sql<StreamRow[]>`
        SELECT mfi.media_item_id AS unit_id, ms.stream_type, ms.language,
               ms.is_hearing_impaired, ms.is_visual_impaired, ms.has_closed_captions
        FROM media_streams ms
        JOIN media_file_items mfi ON mfi.file_id = ms.file_id
        WHERE mfi.media_item_id = ANY(${unitIds})
    `;
    const sidecars = await sql<SidecarRow[]>`
        SELECT mfi.media_item_id AS unit_id, esf.language, esf.is_sdh
        FROM external_subtitle_files esf
        JOIN media_file_items mfi ON mfi.file_id = esf.file_id
        WHERE mfi.media_item_id = ANY(${unitIds})
    `;

    const facts = new Map<string, UnitFacts>();
    const factsFor = (id: string): UnitFacts => {
        let f = facts.get(id);
        if (!f) {
            f = {
                unitId: id,
                audioLanguages: [],
                subtitleLanguages: [],
                hasAudioStream: false,
                hasSubtitleTrack: false,
                hasVideoStream: false,
                cc: false,
                sdh: false,
                ad: false,
            };
            facts.set(id, f);
        }
        return f;
    };
    // Seed every unit so a unit with zero streams still contributes nothing (not missing).
    for (const id of unitIds) factsFor(id);

    const audioSets = new Map<string, Set<string>>();
    const subSets = new Map<string, Set<string>>();
    const setFor = (m: Map<string, Set<string>>, id: string): Set<string> => {
        let s = m.get(id);
        if (!s) {
            s = new Set();
            m.set(id, s);
        }
        return s;
    };

    for (const row of streams) {
        const f = factsFor(row.unit_id);
        if (row.stream_type === 'audio') {
            f.hasAudioStream = true;
            const lang = normalizeToIso6391(row.language);
            if (lang) setFor(audioSets, row.unit_id).add(lang);
            if (row.is_visual_impaired) f.ad = true;
        } else if (row.stream_type === 'subtitle') {
            f.hasSubtitleTrack = true;
            const lang = normalizeToIso6391(row.language);
            if (lang) setFor(subSets, row.unit_id).add(lang);
            if (row.is_hearing_impaired) f.sdh = true;
        } else if (row.stream_type === 'video') {
            f.hasVideoStream = true;
            if (row.has_closed_captions) f.cc = true;
        }
    }
    for (const row of sidecars) {
        const f = factsFor(row.unit_id);
        f.hasSubtitleTrack = true;
        const lang = normalizeToIso6391(row.language);
        if (lang) setFor(subSets, row.unit_id).add(lang);
        if (row.is_sdh) f.sdh = true;
    }
    for (const [id, set] of audioSets) factsFor(id).audioLanguages = [...set];
    for (const [id, set] of subSets) factsFor(id).subtitleLanguages = [...set];

    const core = rollupMajority([...facts.values()]);

    let bestAudio: BestAudioStream | null = null;
    if (isSeries(mediaType)) {
        const [row] = await sql<BestAudioStream[]>`
            SELECT ms.codec, ms.channels, ms.channel_layout, ms.profile
            FROM media_streams ms
            JOIN media_file_items mfi ON mfi.file_id = ms.file_id
            WHERE mfi.media_item_id = ANY(${unitIds}) AND ms.stream_type = 'audio'
            ORDER BY ms.channels DESC NULLS LAST, ms.bitrate DESC NULLS LAST
            LIMIT 1
        `;
        bestAudio = row ?? null;
    }

    return { ...core, bestAudio };
}
