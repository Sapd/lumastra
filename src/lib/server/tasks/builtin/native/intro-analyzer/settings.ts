// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only
import type postgres from 'postgres';
import type { Logger as SdkLogger } from '@sapd/lumastra-plugin-sdk';
import { config as serverConfig } from '$lib/server/config.js';
const PLUGIN_ID = 'lumastra-intro-analyzer';
export const ANALYZER_VISUAL_VERSION = 5;
export const ANALYZER_ACOUSTIC_VERSION = 4;
// Exported for the database-backed combined-file regression test.
export interface EffectiveConfig {
    chapterDetection: boolean;
    blackframeDetection: boolean;
    chromaprintDetection: boolean;
    batchSize: number;
    episodeConcurrency: number;
    ffmpegThreads: number;
    // Tunables previously hardcoded across the chapter/blackframe/chromaprint
    // analyzers. Surfaced so operators can tune without code changes.
    maxIntroDuration: number;
    /**
     * How far a detector LOOKS for credits (blackframe search window,
     * chromaprint tail window). Deliberately NOT the bound on what answer is
     * accepted — see `maxPlausibleCreditsDuration`. Conflating the two is the
     * defect this split exists to fix: widening the window to catch long credit
     * rolls also widened the window edge that a truncated blackframe walk
     * reported as a detection.
     */
    maxCreditsDuration: number;
    maxMovieCreditsDuration: number;
    /** Longest credits run an EPISODE may plausibly have. Answer bound, not search bound. */
    maxPlausibleCreditsDuration: number;
    /** Same for movies — a feature credit roll is legitimately many minutes. */
    maxPlausibleMovieCreditsDuration: number;
    /** Smallest `start / duration` at which a segment may still be read as closing credits. */
    outroMinStartFraction: number;
    /** How far a derived boundary may move to land on an authored chapter mark. */
    snapToleranceSec: number;
    maxPointDifferences: number;
    maxTimeSkip: number;
    introWindowFraction: number;
    introWindowMaxSec: number;
    invertedIndexShift: number;
    minSegmentDuration: number;
    animePreviewFromCreditsEnd: boolean;
}

export const SETTINGS_DEFAULTS: EffectiveConfig = {
    chapterDetection: true,
    blackframeDetection: true,
    chromaprintDetection: true,
    batchSize: 150,
    episodeConcurrency: 2,
    ffmpegThreads: 2,
    maxIntroDuration: 120,
    maxCreditsDuration: 300,
    maxMovieCreditsDuration: 900,
    maxPlausibleCreditsDuration: 150,
    maxPlausibleMovieCreditsDuration: 900,
    outroMinStartFraction: 0.8,
    snapToleranceSec: 10,
    maxPointDifferences: 6,
    maxTimeSkip: 3.5,
    introWindowFraction: 0.25,
    introWindowMaxSec: 600,
    invertedIndexShift: 2,
    minSegmentDuration: 15,
    animePreviewFromCreditsEnd: false,
};

/**
 * Coerce a number setting with finite + range validation. Falls back to the
 * default on any malformed input. Used to keep readTaskSettings compact.
 * When `key` and `logger` are supplied and the value was present but invalid,
 * emits a warn so operators know their value was rejected.
 */
function pickFiniteNumber(
    raw: unknown,
    fallback: number,
    min: number,
    max: number,
    key?: string,
    logger?: SdkLogger,
): number {
    if (typeof raw !== 'number' || !Number.isFinite(raw) || raw < min || raw > max) {
        if (raw !== undefined && key && logger) {
            logger.warn(
                `[intro-analyzer] setting "${key}" value ${JSON.stringify(raw)} is invalid (expected finite number in [${min}, ${max}]); using default ${fallback}`,
            );
        }
        return fallback;
    }
    return raw;
}

export async function readTaskSettings(
    sql: postgres.Sql,
    logger?: SdkLogger,
): Promise<EffectiveConfig> {
    // Migration 15.0.0 dropped task_settings in favour of plugin_settings (rows
    // per (plugin_id, key) instead of a single JSONB blob). Reconstruct the
    // object shape locally so the rest of the function stays unchanged.
    // Skip prototype-mutation keys defensively; plugin_settings is operator-
    // writable from the admin UI.
    const rows = await sql<{ key: string; value: unknown }[]>`
        SELECT key, value FROM plugin_settings WHERE plugin_id = ${PLUGIN_ID}
    `;
    const raw: Record<string, unknown> = Object.create(null);
    for (const r of rows) {
        if (r.key === '__proto__' || r.key === 'constructor' || r.key === 'prototype') continue;
        raw[r.key] = r.value;
    }
    return {
        chapterDetection: raw.chapterDetection !== false,
        blackframeDetection: raw.blackframeDetection !== false,
        chromaprintDetection: raw.chromaprintDetection !== false,
        batchSize: (() => {
            if (typeof raw.batchSize === 'number' && raw.batchSize > 0)
                return Math.floor(raw.batchSize);
            if (raw.batchSize !== undefined && logger)
                logger.warn(
                    `[intro-analyzer] setting "batchSize" value ${JSON.stringify(raw.batchSize)} is invalid (expected positive integer); using default ${SETTINGS_DEFAULTS.batchSize}`,
                );
            return SETTINGS_DEFAULTS.batchSize;
        })(),
        episodeConcurrency: (() => {
            if (typeof raw.episodeConcurrency === 'number' && raw.episodeConcurrency >= 1)
                return Math.floor(raw.episodeConcurrency);
            if (raw.episodeConcurrency !== undefined && logger)
                logger.warn(
                    `[intro-analyzer] setting "episodeConcurrency" value ${JSON.stringify(raw.episodeConcurrency)} is invalid (expected integer >= 1); using default ${SETTINGS_DEFAULTS.episodeConcurrency}`,
                );
            return SETTINGS_DEFAULTS.episodeConcurrency;
        })(),
        ffmpegThreads: (() => {
            if (typeof raw.ffmpegThreads === 'number' && raw.ffmpegThreads >= 0)
                return Math.floor(raw.ffmpegThreads);
            if (raw.ffmpegThreads !== undefined && logger)
                logger.warn(
                    `[intro-analyzer] setting "ffmpegThreads" value ${JSON.stringify(raw.ffmpegThreads)} is invalid (expected integer >= 0); using default ${serverConfig.ANALYSIS_FFMPEG_THREADS}`,
                );
            return serverConfig.ANALYSIS_FFMPEG_THREADS;
        })(),
        maxIntroDuration: pickFiniteNumber(
            raw.maxIntroDuration,
            SETTINGS_DEFAULTS.maxIntroDuration,
            1,
            3600,
            'maxIntroDuration',
            logger,
        ),
        maxCreditsDuration: pickFiniteNumber(
            raw.maxCreditsDuration,
            SETTINGS_DEFAULTS.maxCreditsDuration,
            1,
            3600,
            'maxCreditsDuration',
            logger,
        ),
        maxMovieCreditsDuration: pickFiniteNumber(
            raw.maxMovieCreditsDuration,
            SETTINGS_DEFAULTS.maxMovieCreditsDuration,
            1,
            3600,
            'maxMovieCreditsDuration',
            logger,
        ),
        maxPlausibleCreditsDuration: pickFiniteNumber(
            raw.maxPlausibleCreditsDuration,
            SETTINGS_DEFAULTS.maxPlausibleCreditsDuration,
            1,
            3600,
            'maxPlausibleCreditsDuration',
            logger,
        ),
        maxPlausibleMovieCreditsDuration: pickFiniteNumber(
            raw.maxPlausibleMovieCreditsDuration,
            SETTINGS_DEFAULTS.maxPlausibleMovieCreditsDuration,
            1,
            7200,
            'maxPlausibleMovieCreditsDuration',
            logger,
        ),
        outroMinStartFraction: pickFiniteNumber(
            raw.outroMinStartFraction,
            SETTINGS_DEFAULTS.outroMinStartFraction,
            0,
            1,
            'outroMinStartFraction',
            logger,
        ),
        snapToleranceSec: pickFiniteNumber(
            raw.snapToleranceSec,
            SETTINGS_DEFAULTS.snapToleranceSec,
            0,
            120,
            'snapToleranceSec',
            logger,
        ),
        maxPointDifferences: pickFiniteNumber(
            raw.maxPointDifferences,
            SETTINGS_DEFAULTS.maxPointDifferences,
            0,
            32,
            'maxPointDifferences',
            logger,
        ),
        maxTimeSkip: pickFiniteNumber(
            raw.maxTimeSkip,
            SETTINGS_DEFAULTS.maxTimeSkip,
            0,
            60,
            'maxTimeSkip',
            logger,
        ),
        introWindowFraction: pickFiniteNumber(
            raw.introWindowFraction,
            SETTINGS_DEFAULTS.introWindowFraction,
            0,
            1,
            'introWindowFraction',
            logger,
        ),
        introWindowMaxSec: pickFiniteNumber(
            raw.introWindowMaxSec,
            SETTINGS_DEFAULTS.introWindowMaxSec,
            1,
            3600,
            'introWindowMaxSec',
            logger,
        ),
        invertedIndexShift: pickFiniteNumber(
            raw.invertedIndexShift,
            SETTINGS_DEFAULTS.invertedIndexShift,
            0,
            10,
            'invertedIndexShift',
            logger,
        ),
        minSegmentDuration: pickFiniteNumber(
            raw.minSegmentDuration,
            SETTINGS_DEFAULTS.minSegmentDuration,
            1,
            600,
            'minSegmentDuration',
            logger,
        ),
        animePreviewFromCreditsEnd: raw.animePreviewFromCreditsEnd === true,
    };
}

/** Result-affecting settings only; scheduling/concurrency changes preserve evidence. */
const ranges = {
    maxIntroDuration: [1, 3600],
    maxCreditsDuration: [1, 3600],
    maxMovieCreditsDuration: [1, 3600],
    maxPlausibleCreditsDuration: [1, 3600],
    maxPlausibleMovieCreditsDuration: [1, 7200],
    outroMinStartFraction: [0, 1],
    snapToleranceSec: [0, 120],
    maxPointDifferences: [0, 32],
    maxTimeSkip: [0, 60],
    introWindowFraction: [0, 1],
    introWindowMaxSec: [1, 3600],
    invertedIndexShift: [0, 10],
    minSegmentDuration: [1, 600],
} as const;
const booleanKeys = [
    'chapterDetection',
    'blackframeDetection',
    'chromaprintDetection',
    'animePreviewFromCreditsEnd',
] as const;
export function analyzerConfigGenerationSql(
    sql: postgres.Sql,
    effective?: EffectiveConfig,
): postgres.PendingQuery<postgres.Row[]> {
    const expressions: postgres.PendingQuery<postgres.Row[]>[] = [];
    for (const key of booleanKeys) {
        const fallback = SETTINGS_DEFAULTS[key];
        expressions.push(
            effective
                ? sql`${effective[key]}::boolean`
                : sql`COALESCE((SELECT CASE WHEN jsonb_typeof(value)='boolean' THEN (value #>> '{}')::boolean ELSE ${fallback} END FROM plugin_settings WHERE plugin_id=${PLUGIN_ID} AND key=${key}),${fallback})`,
        );
    }
    for (const key of Object.keys(ranges) as (keyof typeof ranges)[]) {
        const [min, max] = ranges[key],
            fallback = SETTINGS_DEFAULTS[key];
        expressions.push(
            effective
                ? sql`trim_scale(${effective[key]}::numeric)`
                : sql`trim_scale(COALESCE((SELECT CASE WHEN jsonb_typeof(value)='number' THEN CASE WHEN (value #>> '{}')::numeric BETWEEN ${min} AND ${max} THEN (value #>> '{}')::numeric ELSE ${fallback} END ELSE ${fallback} END FROM plugin_settings WHERE plugin_id=${PLUGIN_ID} AND key=${key}),${fallback})::numeric)`,
        );
    }
    const list = expressions.reduce((previous, current) => sql`${previous},${current}`);
    return sql`md5(jsonb_build_array(${list})::text)`;
}
