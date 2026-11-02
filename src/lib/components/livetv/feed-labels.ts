// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import type { LiveTvFeed } from '$lib/schemas/livetv.js';

const QUALITY_LABELS: Record<NonNullable<LiveTvFeed['qualityTier']>, string> = {
    uhd: 'UHD',
    fhd: 'FHD',
    hd: 'HD',
    sd: 'SD',
};

/** The badge for a feed's quality tier (the same abbreviation in every language). */
export function feedQualityLabel(tier: NonNullable<LiveTvFeed['qualityTier']>): string {
    return QUALITY_LABELS[tier];
}
