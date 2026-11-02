// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Shared utilities for request status service
 */

import { config } from '$lib/server/config.js';
import type { RequestStatusQuery } from './types.js';
import { isMovie, isSeries } from '$lib/server/utils/media-types';

/**
 * Format release date using configurable locale and timezone
 * Uses DATE_LOCALE and DATE_TIMEZONE from config
 */
export function formatReleaseDate(dateStr: string | undefined): string | null {
    if (!dateStr) return null;
    try {
        const date = new Date(dateStr);
        if (Number.isNaN(date.getTime())) return null;
        return new Intl.DateTimeFormat(config.DATE_LOCALE, {
            timeZone: config.DATE_TIMEZONE,
            day: 'numeric',
            month: 'long',
            year: 'numeric',
        }).format(date);
    } catch {
        return null;
    }
}

/**
 * Check if a date is in the future
 */
export function isDateInFuture(dateStr: string | undefined): boolean {
    if (!dateStr) return false;
    try {
        const date = new Date(dateStr);
        return date.getTime() > Date.now();
    } catch {
        return false;
    }
}

/**
 * Validate a single request query
 * Requires externalIds with at least one provider ID.
 */
export function validateRequestQuery(
    req: unknown,
    index: number,
): { valid: true; data: RequestStatusQuery } | { valid: false; error: string } {
    if (typeof req !== 'object' || req === null) {
        return {
            valid: false,
            error: `Request at index ${index} is not an object`,
        };
    }

    const r = req as Record<string, unknown>;

    // Validate externalIds
    if (!r.externalIds || typeof r.externalIds !== 'object' || r.externalIds === null) {
        return {
            valid: false,
            error: `Request at index ${index} must have externalIds`,
        };
    }

    const externalIds = r.externalIds as Record<string, unknown>;
    const hasAtLeastOneId = Object.values(externalIds).some(
        (val) => typeof val === 'string' && val.length > 0,
    );

    if (!hasAtLeastOneId) {
        return {
            valid: false,
            error: `Request at index ${index} must have at least one valid external ID`,
        };
    }

    // Validate mediaType
    if (!isMovie(r.mediaType as string) && !isSeries(r.mediaType as string)) {
        return {
            valid: false,
            error: `Invalid mediaType at index ${index}: must be 'movie' or 'tv'`,
        };
    }

    // Validate seasons (optional)
    let normalizedSeasons: number[] | undefined;
    if (r.seasons !== undefined) {
        if (!Array.isArray(r.seasons)) {
            return {
                valid: false,
                error: `Invalid seasons at index ${index}: must be an array`,
            };
        }
        if (r.seasons.length > 50) {
            return {
                valid: false,
                error: `Too many seasons at index ${index}: max 50`,
            };
        }
        normalizedSeasons = [];
        const seasonsValue: unknown[] = r.seasons;
        for (let i = 0; i < seasonsValue.length; i++) {
            const season = seasonsValue[i];
            if (typeof season !== 'number' || !Number.isInteger(season) || season < 0) {
                return {
                    valid: false,
                    error: `Invalid season number at index ${index}, season ${i}: must be a non-negative integer`,
                };
            }
            normalizedSeasons.push(season);
        }
    }

    return {
        valid: true,
        data: {
            externalIds: externalIds,
            // Normalise: the isMovie/isSeries guard accepts 'series' too, so a bare
            // cast would carry 'series' through wearing the 'tv' type.
            mediaType: isMovie(r.mediaType as string) ? 'movie' : 'tv',
            seasons: normalizedSeasons,
        },
    };
}
