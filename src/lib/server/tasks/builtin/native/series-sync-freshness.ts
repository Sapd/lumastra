// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * How recently a series' TMDB metadata must have been written for a non-forced
 * series-sync to skip as already-done.
 *
 * Series metadata does not change on an hourly cadence, and every run costs one
 * TMDB call per season. Paired with the new-descendant escape hatch in the task,
 * so genuinely new episodes still sync immediately rather than waiting this out.
 *
 * Its own module so airing-series-refresh can keep its staleness threshold
 * above it without loading the series-sync task module.
 */
export const SERIES_SYNC_FRESHNESS_MINUTES = 360;
