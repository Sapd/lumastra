// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Mood profile lookup table (keywords + genres, no i18n).
 *
 * Single source of truth shared by MoodRecommendationsService and the
 * /api/mood-recommendations route so the keyword/genre rules used for a
 * given mood can never drift between the two callers.
 */

export interface MoodProfile {
    keywords: string[];
    genres: number[];
    excludeGenres: number[];
    excludeKeywords: string[];
    minRuntime?: number;
    maxRuntime?: number;
    minRating?: number;
    maxRating?: number;
    maxPopularity?: number;
    minPopularity?: number;
    minYear?: number;
    maxYear?: number;
}

// Exported so the /api/v1/recommendations OpenAPI query schema's `mood` enum
// can be tested against this list directly — the two must never drift (that
// drift is exactly what left `mood` undocumented in the spec despite the
// server always having required it).
export const MOOD_PROFILES: Record<string, MoodProfile> = {
    relaxing: {
        keywords: [
            'feel-good',
            'heartwarming',
            'cozy',
            'comfort',
            'wholesome',
            'family-friendly',
            'heartfelt',
            'feel-good-romance',
            'gentle-cinema',
            'calming',
            'peaceful',
            'lighthearted',
        ],
        genres: [35, 10749, 10751],
        excludeGenres: [27, 53, 80, 10752, 16],
        excludeKeywords: ['anime', 'manga', 'shonen', 'seinen', 'isekai', 'mecha'],
        maxRuntime: 120,
    },
    exciting: {
        keywords: [
            'action-packed',
            'adrenaline',
            'thrilling',
            'suspense',
            'intense',
            'edge-of-seat',
            'explosive',
            'fast-paced',
            'high-octane',
        ],
        genres: [28, 12, 878, 53],
        excludeGenres: [],
        excludeKeywords: ['slow-burn', 'slow-cinema', 'meditative', 'contemplative'],
        minRating: 6.5,
    },
    brainfood: {
        keywords: [
            'mind-bending',
            'mystery',
            'twist',
            'puzzle',
            'complex-plot',
            'non-linear',
            'psychological',
            'cerebral',
            'intricate',
            'mystery-thriller',
        ],
        genres: [9648, 53, 878, 18],
        excludeGenres: [35, 10751],
        excludeKeywords: ['slapstick', 'mindless', 'action-comedy'],
        minRuntime: 90,
    },
    thoughtful: {
        keywords: [
            'thought-provoking',
            'philosophical',
            'deep',
            'meaningful',
            'artistic',
            'indie',
            'arthouse',
            'slow-cinema',
        ],
        genres: [18, 99, 36],
        excludeGenres: [],
        excludeKeywords: [],
    },
    emotional: {
        keywords: [
            'emotional',
            'tearjerker',
            'cathartic',
            'heartbreaking',
            'moving',
            'touching',
            'poignant',
            'bittersweet',
            'melancholic',
            'sad',
            'beautiful',
        ],
        genres: [18, 10749, 10751],
        excludeGenres: [27, 53, 35],
        excludeKeywords: ['horror', 'scary', 'parody', 'satire', 'irreverent'],
    },
    funny: {
        keywords: [
            'comedy',
            'funny',
            'hilarious',
            'slapstick',
            'parody',
            'satire',
            'absurd-comedy',
            'dark-comedy',
        ],
        genres: [35],
        excludeGenres: [27, 53],
        excludeKeywords: [],
    },
    romantic: {
        keywords: [
            'romance',
            'love-story',
            'romantic-comedy',
            'feel-good-romance',
            'first-love',
            'love-triangle',
        ],
        genres: [10749, 35],
        excludeGenres: [27, 53, 80],
        excludeKeywords: [],
    },
    spooky: {
        keywords: [
            'horror',
            'scary',
            'supernatural',
            'ghost',
            'haunted',
            'creepy',
            'psychological-horror',
        ],
        genres: [27, 9648, 53],
        excludeGenres: [35, 10751],
        excludeKeywords: [],
    },
    quickwatch: {
        keywords: ['short', 'episodic', 'anthology', 'sitcom', 'comedy', 'lighthearted'],
        // Family (10751) removed: kids/animated content shouldn't be boosted
        // into an adult-oriented "quick watch" mood.
        genres: [35, 10749],
        excludeGenres: [27, 53],
        excludeKeywords: ['epic', 'saga', 'trilogy', 'complex-plot', 'heavy'],
        maxRuntime: 100,
    },
    hiddengems: {
        keywords: [
            'indie',
            'arthouse',
            'festival',
            'critically-acclaimed',
            'underrated',
            'cult-classic',
        ],
        genres: [18, 53, 878, 9648],
        excludeGenres: [],
        excludeKeywords: [],
        maxPopularity: 50,
        minRating: 7.0,
    },
    cozy: {
        keywords: [
            'cozy',
            'comfort',
            'wholesome',
            'heartwarming',
            'feel-good',
            'warm',
            'gentle',
            'uplifting',
            'lighthearted',
            'comforting',
        ],
        genres: [35, 10749, 10751, 16],
        excludeGenres: [27, 53, 80, 10752],
        excludeKeywords: ['dark', 'gritty', 'disturbing', 'violent', 'intense', 'horror'],
        maxRuntime: 130,
    },
    epic: {
        keywords: [
            'epic',
            'grand-scale',
            'fantasy',
            'world-building',
            'spectacular',
            'sweeping',
            'saga',
            'trilogy',
            'epic-fantasy',
            'blockbuster',
        ],
        genres: [14, 12, 878, 36],
        excludeGenres: [],
        excludeKeywords: ['intimate', 'small-scale', 'mumblecore', 'minimalist'],
        minRuntime: 140,
        minRating: 7.0,
        // No popularity floor. TMDB `popularity` is a volatile, time-decaying
        // score that drops into the ~15-50 band once a film leaves its theatrical
        // window — a floor of 100 admitted only currently-in-theatres titles and
        // collapsed the rail to currently popular releases, while excluding older
        // high-quality films. The minRuntime(140) + minRating(7.0) + epic-genre gate
        // already enforces "grand scale + high quality"; every sibling mood profile
        // relies on minRating alone (hiddengems uses a maxPopularity *ceiling*),
        // so epic carries no popularity floor either.
    },
    nostalgic: {
        keywords: [
            'classic',
            'retro',
            '90s',
            '80s',
            'childhood',
            'timeless',
            'nostalgic',
            'vintage',
            'old-school',
        ],
        genres: [16, 35, 12, 10751],
        excludeGenres: [],
        excludeKeywords: ['modern', 'contemporary', 'current'],
        minYear: 1975,
        maxYear: 2005,
        minRating: 6.5,
    },
    inspiring: {
        keywords: [
            'inspiring',
            'motivational',
            'underdog',
            'triumph',
            'biographical',
            'sports-drama',
            'overcome',
            'uplifting',
            'based-on-true-story',
            'inspirational',
        ],
        genres: [18, 36],
        excludeGenres: [27, 53],
        excludeKeywords: ['tragedy', 'downbeat', 'depressing', 'dark', 'bleak'],
        minRating: 7.0,
    },
    darkgritty: {
        keywords: [
            'noir',
            'gritty',
            'dark',
            'morally-complex',
            'crime-drama',
            'neo-noir',
            'bleak',
            'cynical',
            'psychological',
            'dark-thriller',
        ],
        genres: [80, 53, 18, 9648],
        excludeGenres: [35, 10751],
        excludeKeywords: ['feel-good', 'wholesome', 'family-friendly', 'lighthearted', 'uplifting'],
        minRating: 7.0,
    },
    familynight: {
        keywords: [
            'family-friendly',
            'all-ages',
            'wholesome',
            'pixar',
            'disney',
            'ghibli',
            'animated',
            'kids',
            'family',
        ],
        genres: [16, 10751, 12],
        excludeGenres: [27, 53, 80],
        excludeKeywords: ['adult-themes', 'violence', 'scary', 'dark', 'mature'],
        maxRuntime: 110,
    },
    datenight: {
        keywords: [
            'romantic-comedy',
            'adventure-romance',
            'fun',
            'date-movie',
            'crowd-pleaser',
            'charming',
            'delightful',
        ],
        genres: [10749, 35, 12],
        excludeGenres: [27, 10752],
        excludeKeywords: ['tearjerker', 'horror', 'dark', 'depressing', 'heavy', 'bleak'],
        minRuntime: 90,
        maxRuntime: 130,
        minRating: 6.5,
    },
    educational: {
        keywords: [
            'documentary',
            'educational',
            'historical',
            'biography',
            'true-story',
            'informative',
            'nature',
            'science',
            'based-on-true-events',
        ],
        genres: [99, 36],
        excludeGenres: [14, 878],
        excludeKeywords: ['fiction', 'fantasy', 'fictional'],
        minRating: 7.5,
    },
    guiltypleasure: {
        keywords: [
            'campy',
            'b-movie',
            'guilty-pleasure',
            'popcorn-flick',
            'so-bad-its-good',
            'cheesy',
            'mindless-fun',
            'trashy',
        ],
        genres: [28, 35, 27],
        excludeGenres: [99, 36],
        excludeKeywords: ['critically-acclaimed', 'arthouse', 'serious', 'masterpiece', 'artistic'],
        minRating: 4.5,
        maxRating: 6.5,
        maxRuntime: 100,
    },
    visuallystunning: {
        keywords: [
            'visually-stunning',
            'cinematography',
            'beautiful',
            'visual-masterpiece',
            'artistic',
            'colorful',
            'gorgeous',
            'breathtaking',
        ],
        genres: [18, 878, 14, 16],
        excludeGenres: [],
        excludeKeywords: ['bland', 'generic', 'low-budget', 'cheap'],
        minRating: 7.5,
    },
    comfortrewatch: {
        keywords: [
            'sitcom',
            'episodic',
            'comfort-watch',
            'easy-watching',
            'binge-worthy',
            'rewatch',
            'background-friendly',
        ],
        // Animation (16) removed: kids/animated content shouldn't be boosted
        // into an adult-oriented "comfort rewatch" mood.
        genres: [35],
        excludeGenres: [53, 9648],
        excludeKeywords: ['complex-plot', 'mystery', 'thriller', 'mind-bending'],
        maxRuntime: 30,
    },
    eveningchill: {
        keywords: [
            'feel-good',
            'lighthearted',
            'easy-watching',
            'comfort',
            'relaxing',
            'gentle',
            'calming',
            'cozy',
        ],
        genres: [35, 10749, 10751],
        excludeGenres: [27, 53, 80],
        excludeKeywords: ['intense', 'dark', 'violent', 'disturbing', 'horror'],
        maxRuntime: 120,
    },
};
