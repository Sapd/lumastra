// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { config } from '../config.js';
import { resolveAgeRatingCountry } from '../../shared/age-rating-country.js';

/**
 * The country whose age-rating system is in effect: the "Age Rating Country"
 * setting, or, while it is "Automatic", the one the TMDB metadata language implies
 * (de-DE -> DE, en-US -> US, en-GB -> GB). Always a supported country code.
 */
export function effectiveAgeRatingCountry(): string {
    return resolveAgeRatingCountry(config.AGE_RATING_COUNTRY, config.TMDB_LANGUAGE);
}
