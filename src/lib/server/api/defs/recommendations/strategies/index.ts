// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Strategy registry — single import point for all recommendation strategies.
 *
 * New strategies register here; the `/feed` and `/recommendations` endpoints
 * resolve strategies from this map.
 */

import { trendingStrategy } from './trending.strategy.js';
import { aiStrategy } from './ai.strategy.js';
import { moodStrategy } from './mood.strategy.js';
import { forYouStrategy } from './for-you.strategy.js';
import { fulfilledRequestsStrategy } from './fulfilled-requests.strategy.js';
import { becauseYouWatchedStrategy } from './because-you-watched.strategy.js';
import { editorialStrategy } from './editorial.strategy.js';
import { popularShowsStrategy } from './popular-shows.strategy.js';
import { freshReleasesStrategy } from './fresh-releases.strategy.js';
import { bingeWorthyStrategy } from './binge-worthy.strategy.js';
import { animeStrategy } from './anime.strategy.js';
import { shortMoviesStrategy } from './short-movies.strategy.js';
import { recentlyAddedStrategy } from './recently-added.strategy.js';
import { randomPicksStrategy } from './random-picks.strategy.js';
import type { RecommenderStrategy } from '../recommender.js';

export { trendingStrategy } from './trending.strategy.js';
export { aiStrategy } from './ai.strategy.js';
export { moodStrategy } from './mood.strategy.js';
export { forYouStrategy } from './for-you.strategy.js';
export { fulfilledRequestsStrategy } from './fulfilled-requests.strategy.js';
export { becauseYouWatchedStrategy } from './because-you-watched.strategy.js';
export { editorialStrategy } from './editorial.strategy.js';
export { popularShowsStrategy } from './popular-shows.strategy.js';
export { freshReleasesStrategy } from './fresh-releases.strategy.js';
export { bingeWorthyStrategy } from './binge-worthy.strategy.js';
export { animeStrategy } from './anime.strategy.js';
export { shortMoviesStrategy } from './short-movies.strategy.js';
export { recentlyAddedStrategy } from './recently-added.strategy.js';
export { randomPicksStrategy } from './random-picks.strategy.js';

/**
 * Named strategy registry.
 *
 * Keys correspond to the `type` query param accepted by `GET /recommendations`.
 * The `for-you` key is the default when no type is specified.
 */
export const STRATEGY_REGISTRY = new Map<string, RecommenderStrategy>([
    ['trending', trendingStrategy],
    ['ai', aiStrategy],
    ['mood', moodStrategy],
    ['for-you', forYouStrategy],
    ['fulfilled-requests', fulfilledRequestsStrategy],
    ['because-you-watched', becauseYouWatchedStrategy],
    ['editorial', editorialStrategy],
    // Folded curated for-you rails (formerly GET /api/for-you/*).
    ['popular-shows', popularShowsStrategy],
    ['fresh-releases', freshReleasesStrategy],
    ['binge-worthy', bingeWorthyStrategy],
    ['anime', animeStrategy],
    ['short-movies', shortMoviesStrategy],
    ['recently-added', recentlyAddedStrategy],
    ['random-picks', randomPicksStrategy],
    // Alias: the web Home "From your ratings" rail is the `ai` taste-profile
    // strategy (served on web via /api/for-you/taste). Expose it under an
    // explicit, self-describing type so native clients get naming/label parity
    // with web instead of calling the opaque `ai` type. Same generator, same
    // output — deliberately points at the SAME strategy instance as 'ai'.
    ['from-your-ratings', aiStrategy],
]);

/** Look up a strategy by name; returns undefined if not found. */
export function getStrategy(name: string): RecommenderStrategy | undefined {
    return STRATEGY_REGISTRY.get(name);
}
