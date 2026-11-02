// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { z } from 'zod';

export const PlaybackProgressSchema = z
    .object({
        positionMs: z.number().int().nullable(),
        durationMs: z.number().int().nullable(),
        fraction: z.number().min(0).max(1).nullable(),
        finished: z.boolean(),
        updatedAt: z.iso.datetime({ offset: true }).nullable(),
    })
    .meta({ id: 'PlaybackProgress' });

export type PlaybackProgress = z.infer<typeof PlaybackProgressSchema>;

export interface PlaybackProgressInput {
    positionMs?: number | null;
    durationMs?: number | null;
    fraction?: number | null;
    finished?: boolean;
    updatedAt?: string | Date | null;
}

function milliseconds(value: number | null | undefined): number | null {
    if (typeof value !== 'number' || !Number.isFinite(value)) return null;
    const rounded = Math.trunc(value);
    return Number.isSafeInteger(rounded) ? rounded : null;
}

function clampFraction(value: number | null | undefined): number | null {
    return typeof value === 'number' && Number.isFinite(value)
        ? Math.min(1, Math.max(0, value))
        : null;
}

/** A finished item is always fraction 1. Otherwise explicit fractions take precedence, then position/duration when the duration is known. */
export function buildPlaybackProgress(input: PlaybackProgressInput = {}): PlaybackProgress {
    const rawPosition = milliseconds(input.positionMs);
    const positionMs = rawPosition === null ? null : Math.max(0, rawPosition);
    const durationMs = milliseconds(input.durationMs);
    const fraction = input.finished === true
        ? 1
        : clampFraction(input.fraction)
        ?? (positionMs !== null && durationMs !== null && durationMs > 0
            ? clampFraction(positionMs / durationMs)
            : null);
    const updatedAt = input.updatedAt instanceof Date
        ? (Number.isFinite(input.updatedAt.getTime()) ? input.updatedAt.toISOString() : null)
        : (input.updatedAt ?? null);
    return {
        positionMs,
        durationMs,
        fraction,
        finished: input.finished ?? false,
        updatedAt: updatedAt !== null && PlaybackProgressSchema.shape.updatedAt.safeParse(updatedAt).success
            ? updatedAt : null,
    };
}

/** Convert a source's 0..100 percent into the shared 0..1 progress fraction. */
export function buildPlaybackProgressFromPercent(
    percent: number | null | undefined,
    input: Omit<PlaybackProgressInput, 'fraction'> = {},
): PlaybackProgress {
    return buildPlaybackProgress({
        ...input,
        fraction: typeof percent === 'number' ? percent / 100 : null,
    });
}
