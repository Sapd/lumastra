// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Music Mood Chips
 *
 * Shared source of truth for the /music mood chip row and the rotating
 * mood-shelf sections. `genre` doubles as the bare mood key used to look up
 * the pre-computed vector in `mood_vectors` (prefixed with `music:` at the
 * query site) and to build genre-search autoplay seeds.
 *
 * @module constants/music-moods
 */

export interface MoodChip {
    label: string;
    genre: string;
    emoji: string;
}

export const MOOD_CHIPS: readonly MoodChip[] = [
    { label: 'Chill', genre: 'chill', emoji: '\u{1f60c}' },
    { label: 'Workout', genre: 'workout', emoji: '\u{1f4aa}' },
    { label: 'Focus', genre: 'focus', emoji: '\u{1f3af}' },
    { label: 'Party', genre: 'party', emoji: '\u{1f389}' },
    { label: 'Energetic', genre: 'energetic', emoji: '⚡' },
    { label: 'Sad', genre: 'sad', emoji: '\u{1f327}️' },
    { label: 'Happy', genre: 'happy', emoji: '\u{1f60a}' },
    { label: 'Romantic', genre: 'romantic', emoji: '\u{1f495}' },
] as const;
