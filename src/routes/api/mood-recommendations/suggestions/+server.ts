// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Mood Suggestions API - Server-Driven UI
 *
 * Returns mood metadata and time-based suggestions without fetching recommendations.
 * Used by the MoodSelector component to display available moods.
 *
 * GET /api/mood-recommendations/suggestions
 * Response: {
 *   primary: string,      // Time-based primary suggestion
 *   secondary: string,    // Time-based secondary suggestion
 *   moods: MoodInfo[]     // All available moods with metadata
 * }
 */
import { json } from '@sveltejs/kit';
import { defineEndpoint } from '$lib/server/api/define.js';
import { ApiProblem } from '$lib/server/api/problem.js';
import { mount } from '$lib/server/api/mount.js';
import { getAllMoodConfigs, getAvailableMoodKeys } from '$lib/server/services/mood-vector-seeds';
import { MoodSuggestionsResponseSchema } from '$lib/schemas/api-for-you-responses';
import * as m from '$lib/paraglide/messages';

// Built-in moods are translated through paraglide keys whose suffix is the mood
// key (`mood_profile_<key>_name` / `_desc`), fully populated for every shipped
// locale. The JSON config only carries English `displayName`/`description`, so
// resolving them straight from the config always returned English regardless of
// the request locale. We look the localized string up dynamically here and fall
// back to the config's English text for any admin-added custom mood that has no
// message key.
const moodMessages = m as unknown as Record<string, (() => string) | undefined>;

function translateMoodField(moodKey: string, field: 'name' | 'desc', fallback: string): string {
    const fn = moodMessages[`mood_profile_${moodKey}_${field}`];
    return typeof fn === 'function' ? fn() : fallback;
}

type MoodKey = string;

function getTimeBasedMood(availableMoods: Set<string>): {
    primary: MoodKey;
    secondary: MoodKey;
} {
    const now = new Date();
    const hour = now.getHours();
    const dayOfWeek = now.getDay();

    const isWeekend = dayOfWeek === 0 || dayOfWeek === 6;
    const isFriday = dayOfWeek === 5;

    const validateMood = (mood: string): string => {
        if (availableMoods.has(mood)) return mood;
        const first = availableMoods.values().next().value;
        return first || 'relaxing';
    };

    if (hour >= 6 && hour < 12) {
        if (isWeekend)
            return { primary: validateMood('nostalgic'), secondary: validateMood('familynight') };
        if (dayOfWeek === 1)
            return { primary: validateMood('inspiring'), secondary: validateMood('funny') };
        return { primary: validateMood('funny'), secondary: validateMood('quickwatch') };
    }
    if (hour >= 12 && hour < 17) {
        if (isWeekend)
            return { primary: validateMood('epic'), secondary: validateMood('visuallystunning') };
        if (dayOfWeek === 1)
            return { primary: validateMood('inspiring'), secondary: validateMood('educational') };
        return { primary: validateMood('hiddengems'), secondary: validateMood('educational') };
    }
    if (hour >= 17 && hour < 21) {
        if (isFriday)
            return { primary: validateMood('datenight'), secondary: validateMood('exciting') };
        if (dayOfWeek === 6)
            return {
                primary: validateMood('brainfood'),
                secondary: validateMood('visuallystunning'),
            };
        if (dayOfWeek === 0)
            return { primary: validateMood('familynight'), secondary: validateMood('cozy') };
        return { primary: validateMood('relaxing'), secondary: validateMood('comfortrewatch') };
    }
    if (hour >= 21 && hour < 24) {
        if (isFriday)
            return { primary: validateMood('guiltypleasure'), secondary: validateMood('spooky') };
        if (dayOfWeek === 6)
            return { primary: validateMood('darkgritty'), secondary: validateMood('hiddengems') };
        if (dayOfWeek === 0)
            return { primary: validateMood('emotional'), secondary: validateMood('inspiring') };
        return { primary: validateMood('quickwatch'), secondary: validateMood('comfortrewatch') };
    }
    if (isWeekend)
        return { primary: validateMood('visuallystunning'), secondary: validateMood('hiddengems') };
    return { primary: validateMood('comfortrewatch'), secondary: validateMood('nostalgic') };
}

// ---------------------------------------------------------------------------
// Endpoint definition
// ---------------------------------------------------------------------------

const def = defineEndpoint({
    auth: { kind: 'user' },
    visibility: 'internal',
    handlers: {
        GET: async (event, _ctx) => {
            const { locals } = event;

            // Age-restricted profiles cannot access mood recommendations
            if (locals.user?.isAgeRestricted) {
                return ApiProblem.forbidden(
                    'This feature is not available for age-restricted profiles',
                );
            }

            try {
                const moodConfigs = getAllMoodConfigs();
                const availableMoodKeys = new Set(getAvailableMoodKeys());

                if (moodConfigs.length === 0) {
                    return json(
                        MoodSuggestionsResponseSchema.parse({
                            primary: null,
                            secondary: null,
                            moods: [],
                        }),
                    );
                }

                const timeBased = getTimeBasedMood(availableMoodKeys);

                const moods = moodConfigs.map((config) => ({
                    key: config.moodKey,
                    displayName: translateMoodField(config.moodKey, 'name', config.displayName),
                    description: translateMoodField(config.moodKey, 'desc', config.description),
                }));

                return json(
                    MoodSuggestionsResponseSchema.parse({
                        primary: timeBased.primary,
                        secondary: timeBased.secondary,
                        moods,
                    }),
                );
            } catch {
                return ApiProblem.internalError('Failed to fetch mood suggestions');
            }
        },
    },
});

export const { GET } = mount(def, { surface: 'internal' });
