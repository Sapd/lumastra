// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only
import { z } from 'zod';
export const LanguageTrackSchema = z
    .object({
        language: z
            .string()
            .nullable()
            .describe(
                'Recorded language tag; null or und means the track exists but its language is unknown.',
            ),
        isDefault: z
            .boolean()
            .nullable()
            .describe(
                'Recorded default disposition; null when the source has no default flag, including sidecar subtitles.',
            ),
        isForced: z
            .boolean()
            .nullable()
            .describe(
                'Recorded forced disposition; null when unavailable, never inferred from language.',
            ),
        source: z
            .enum(['embedded', 'sidecar'])
            .describe('Embedded media stream or discovered external subtitle file.'),
    })
    .describe('One recorded audio or subtitle track, preserving source and known dispositions.');
export const FileLanguageSummarySchema = z
    .object({
        originalLanguage: z
            .string()
            .optional()
            .describe('Original production language of the linked title or series'),
        fileId: z
            .uuid()
            .describe('Physical media-file identity; languages are never unioned across versions.'),
        probed: z
            .boolean()
            .describe(
                'The physical file has a probed_at timestamp and is not missing; missing-file queue sentinels do not establish an empty embedded inventory. Recorded tracks remain available independently.',
            ),
        isMissing: z
            .boolean()
            .describe(
                'The physical file is currently marked missing; listed languages are retained inventory evidence.',
            ),
        audio: z
            .array(LanguageTrackSchema)
            .describe(
                'Recorded embedded audio tracks in stream order; empty and unprobed is unknown.',
            ),
        subtitles: z
            .array(LanguageTrackSchema)
            .describe(
                'Recorded embedded subtitle tracks followed by external sidecars for this exact file.',
            ),
    })
    .describe('Language inventory scoped to one physical file.');
export const EpisodeLanguageSummarySchema = z
    .object({
        selectedFileId: z
            .uuid()
            .nullable()
            .describe(
                'Default playback file, or explicitly labeled first-linked fallback; null when no file is linked.',
            ),
        selection: z
            .enum(['default', 'fallback', 'none'])
            .describe(
                'Whether selection follows an actual default association, a deterministic fallback, or no linked file.',
            ),
        files: z
            .array(
                FileLanguageSummarySchema.extend({
                    label: z
                        .string()
                        .describe('Association label, edition or filename for version comparison.'),
                    isDefault: z
                        .boolean()
                        .describe(
                            'Actual default association for this episode, independent of stream disposition flags.',
                        ),
                }),
            )
            .describe(
                'Separate language inventories for all episode file versions; the selected file is not a union.',
            ),
    })
    .describe('Episode playback-file language summary with separate alternate versions.');
export type LanguageTrack = z.infer<typeof LanguageTrackSchema>;
export type FileLanguageSummary = z.infer<typeof FileLanguageSummarySchema>;
export type EpisodeLanguageSummary = z.infer<typeof EpisodeLanguageSummarySchema>;
