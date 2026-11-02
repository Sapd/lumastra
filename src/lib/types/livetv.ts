// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * LiveTV Types
 *
 * Re-exported from Zod schemas (SINGLE SOURCE OF TRUTH).
 * Import types from here; import schemas from '$lib/schemas/livetv'.
 */

export type {
    LiveTvProgram,
    LiveTvStation,
    LiveTvChannel,
    LiveTvCategory,
    LiveTvStreamInfo,
    LiveTvSource,
    LiveTvSourceConfig,
} from '$lib/schemas/livetv';

/**
 * Import result summary — client-safe mirror of server ImportResult.
 * Used as display-only prop in ImportGuidedSetup.
 */
export interface ImportResult {
    sourceId: string;
    sourceName: string;
    channelCount: number;
    backupGroupCount: number;
    categoryCount: number;
    epgMatchCount: number;
    programCount: number;
    errors: string[];
    warnings: string[];
    duration: number;
}
