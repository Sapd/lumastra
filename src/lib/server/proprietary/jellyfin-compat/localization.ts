// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: LicenseRef-Lumastra-Proprietary
// Proprietary and source-available — not licensed under AGPL. See LICENSING.md.

/**
 * The static lists behind /Localization/* (Jellyfin LocalizationController).
 *
 * Apps read these on settings screens: Cultures and Countries fill the
 * metadata/subtitle language and country pickers, ParentalRatings the
 * parental-control picker, Options the UI-language picker.
 *
 * - Cultures: every ISO 639-2 language, de-duplicated by display name and
 *   sorted by it, as Jellyfin does.
 * - Countries: ISO 3166-1, in table order.
 * - ParentalRatings: Jellyfin answers the rating table of the server's
 *   metadata country plus a few fixed entries. Lumastra enforces age limits
 *   as plain ages (0–21) and has no per-country table, so this is the US
 *   table (MPAA + TV Parental Guidelines, the system most provider metadata
 *   uses) plus the same fixed entries Jellyfin adds: "Unrated" and the "21"
 *   catch-all above the highest rating.
 * - Options: the languages Lumastra's own UI ships in.
 */

import type {
    JellyfinCountryInfo,
    JellyfinCultureDto,
    JellyfinLocalizationOption,
    JellyfinParentalRating,
} from './types';
import { ISO_3166_1, ISO_639_2 } from './localization-data';
import { locales } from '$lib/paraglide/runtime';

let cultures: JellyfinCultureDto[] | null = null;
let countries: JellyfinCountryInfo[] | null = null;

export function getCultures(): JellyfinCultureDto[] {
    if (cultures) return cultures;
    const seen = new Set<string>();
    const list: JellyfinCultureDto[] = [];
    for (const row of ISO_639_2) {
        const [terminology, bibliographic, twoLetter, name] = row.split('|');
        const key = name.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        const threeLetter = bibliographic ? [terminology, bibliographic] : [terminology];
        list.push({
            Name: name,
            DisplayName: name,
            TwoLetterISOLanguageName: twoLetter,
            ThreeLetterISOLanguageName: terminology,
            ThreeLetterISOLanguageNames: threeLetter,
        });
    }
    list.sort((a, b) =>
        a.DisplayName < b.DisplayName ? -1 : a.DisplayName > b.DisplayName ? 1 : 0,
    );
    cultures = list;
    return list;
}

export function getCountries(): JellyfinCountryInfo[] {
    if (countries) return countries;
    countries = ISO_3166_1.map((row) => {
        const [twoLetter, threeLetter, name] = row.split('|');
        return {
            Name: twoLetter,
            DisplayName: name,
            TwoLetterISORegionName: twoLetter,
            ThreeLetterISORegionName: threeLetter,
        };
    });
    return countries;
}

/** US rating strings by minimum age (`score`); `subScore` marks content descriptors. */
const US_RATINGS: ReadonlyArray<readonly [string, number, number]> = [
    ['Approved', 0, 0],
    ['G', 0, 0],
    ['TV-G', 0, 0],
    ['TV-Y', 0, 0],
    ['TV-Y7', 7, 0],
    ['TV-Y7-FV', 7, 1],
    ['PG', 10, 0],
    ['TV-PG', 10, 0],
    ['PG-13', 13, 0],
    ['TV-14', 14, 0],
    ['R', 17, 0],
    ['TV-MA', 17, 0],
    ['NC-17', 18, 0],
];

export function getParentalRatings(): JellyfinParentalRating[] {
    const ratings: JellyfinParentalRating[] = US_RATINGS.map(([name, score, subScore]) => ({
        Name: name,
        Value: score,
        RatingScore: { score, subScore },
    }));
    ratings.push({ Name: 'Unrated', Value: null, RatingScore: null });
    // Jellyfin's catch-all when a country's table tops out below 21: lets a
    // parental limit admit every rated item except adult content.
    ratings.push({ Name: '21', Value: 21, RatingScore: { score: 21, subScore: null } });
    return ratings;
}

export function getLocalizationOptions(): JellyfinLocalizationOption[] {
    return locales.map((locale) => ({
        Name: nativeLanguageName(locale),
        Value: locale,
    }));
}

function nativeLanguageName(locale: string): string {
    try {
        const name = new Intl.DisplayNames([locale], { type: 'language' }).of(locale);
        if (name) return name.charAt(0).toLocaleUpperCase(locale) + name.slice(1);
    } catch {
        // Unknown tag to this ICU build — fall back to the code.
    }
    return locale;
}
