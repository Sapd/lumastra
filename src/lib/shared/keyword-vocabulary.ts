// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Curated keyword vocabulary — the ONE copy.
 *
 * `media_keywords` projects the raw provider keyword space (~84k distinct
 * values on a large catalog, the overwhelming majority hyphenated mdblist
 * slugs like `whore-of-babylon` or `who-s-afraid-of-virginia-woolf`). That raw
 * space is fine as a membership index but unusable as a user-facing vocabulary,
 * so every surface that OFFERS keywords to a user gates on this whitelist:
 *
 *   - For-You "You like X" rails (`fetchPopularKeywords`, keyword rows)
 *   - the /browse keyword facet + `/browse/tags` typeahead
 *     (`queryKeywordFacets` in browse.queries.ts)
 *
 * Kept here rather than in a service so a query module can import it without
 * inverting the tier rule (queries are pure SQL; services sit above them).
 * Display labels for the same vocabulary live below, so the list and its
 * labels can never drift into two homes.
 *
 * Membership FILTERING (`?tag=<keyword>`) deliberately does NOT gate on this
 * list: an existing deep link to a non-curated keyword still resolves.
 */

import * as m from '$lib/paraglide/messages.js';

export const ALLOWED_KEYWORDS = new Set([
    // Genres & Subgenres
    'anime',
    'anime-animation',
    'dark-comedy',
    'romantic-comedy',
    'slapstick-comedy',
    'parody-comedy',
    'psychological-thriller',
    'psychological-drama',
    'psychological-horror',
    'neo-noir',
    'film-noir',
    'dark-fantasy',
    'epic-fantasy',
    'sword-and-sorcery-fantasy',
    'supernatural-fantasy',
    'dystopian-sci-fi',
    'space-sci-fi',
    'cyberpunk',
    'steampunk',
    'outer-space',
    'spaceship',
    'space-opera',
    'space-adventure',
    'space-station',
    'space-battle',
    'supernatural-horror',
    'body-horror',
    'slasher',
    'found-footage',
    'coming-of-age',
    'coming-of-age-drama',
    'teen-fantasy',
    'teen-comedy',
    'period-drama',
    'epic-drama',
    'tragedy-drama',
    'social-commentary',
    'satire',
    'satire-comedy',
    'parody',
    'mockumentary',
    'heist',
    'caper',
    'whodunit',
    'whodunnit-mystery',
    'murder-mystery',
    'spy',
    'espionage',
    'secret-agent',
    'conspiracy',
    'martial-arts',
    'kung-fu',
    'samurai',
    'ninja',
    'superhero',
    'superhero-action',
    'superhero-sci-fi',
    'superhero-fantasy',
    'supervillain',
    'time-travel',
    'alternate-history',
    'parallel-universe',
    'multiverse',
    'survival',
    'post-apocalyptic',
    'apocalypse',
    'disaster',
    'home-invasion',
    'kidnapping',
    'hostage',
    'serial-killer',
    'vampire',
    'werewolf',
    'zombie',
    'ghost',
    'demon',
    'witch',
    'haunted',
    'alien',
    'monster',
    'creature',
    'kaiju',
    'dragon',
    'robot',
    'artificial-intelligence',
    'cyborg',
    'android',

    // Themes & Story Types
    'redemption',
    'revenge-story',
    'underdog',
    'rags-to-riches',
    'love-triangle',
    'forbidden-love',
    'star-crossed-lovers',
    'unrequited-love',
    'dysfunctional-family',
    'family-drama',
    'sibling-rivalry',
    'corruption',
    'organized-crime',
    'gangster',
    'mafia',
    'yakuza',
    'cartel',
    'race-against-time',
    'countdown',
    'ticking-clock',
    'treasure-hunt',
    'quest',
    'quest-adventure',
    'epic-adventure',
    'one-man-army',
    'lone-wolf',
    'vigilante',
    'anti-hero',
    'buddy-cop',
    'unlikely-duo',
    'odd-couple',
    'road-trip',
    'space-travel',
    'space-exploration',
    'first-contact',
    'mind-control',
    'brainwashing',
    'memory-manipulation',
    'hidden-identity',
    'double-life',
    'impostor',
    'doppelganger',
    'island',
    'desert-island',
    'stranded',
    'isolated',
    'prison-escape',
    'escape',
    'on-the-run',
    'fugitive',
    'undercover',
    'infiltration',
    'double-cross',
    'tournament',
    'competition',
    'sports',
    'boxing',
    'fighting',
    'war',
    'world-war-ii',
    'vietnam-war',
    'cold-war',
    'civil-war',
    'historical',
    'ancient-rome',
    'medieval',
    'renaissance',
    'victorian',

    // Anime-specific
    'shounen',
    'seinen',
    'isekai',
    'mecha',
    'harem',
    'slice-of-life',
    'school-life',
    'magical-girl',
    'shojo',
    'josei',
    'ecchi',
    'sports-anime',

    // Settings & Atmosphere
    'noir',
    'gothic',
    'surrealism',
    'dreamlike',
    'psychological',
    'dystopia',
    'utopia',
    'futuristic',
    'retro-futuristic',
    'western',
    'frontier',
    'old-west',
    'jungle',
    'rainforest',
    'arctic',
    'underwater',
    'haunted-house',
    'mansion',
    'castle',
    'dungeon',
    'small-town',
    'rural',
    'urban',
    'big-city',
    'new-york',
    'tokyo',
    'paris',
    'london',

    // Tone & Style
    'black-comedy',
    'dark-humor',
    'absurdist',
    'surreal',
    'feel-good',
    'heartwarming',
    'inspirational',
    'uplifting',
    'intense',
    'suspenseful',
    'edge-of-seat',
    'nail-biting',
    'gritty',
    'realistic',
    'grounded',
    'raw',
    'stylized',
    'visually-stunning',
    'artistic',
    'cult-film',
    'indie',
    'independent-film',
    'arthouse',
    'experimental',
    'grindhouse-film',
    'exploitation',
    'b-movie',

    // Character Types
    'femme-fatale',
    'strong-female-lead',
    'female-warrior',
    'action-heroine',
    'anti-hero',
    'villain-protagonist',
    'morally-ambiguous',
    'genius',
    'prodigy',
    'mastermind',
    'hacker',
    'detective',
    'private-investigator',
    'journalist',
    'reporter',
    'assassin',
    'hitman',
    'mercenary',
    'bounty-hunter',
    'thief',
    'con-artist',
    'grifter',
    'bank-robber',
    'scientist',
    'mad-scientist',
    'inventor',
    'professor',
    // Curated additions from prod keyword analysis (2026-06-14)
    'based-on-true-story',
    'biography',
    'musical',
    'christmas',
    'halloween',
    'military',
    'world-war-two',
    'politics',
    'religion',
    'terrorism',
    'courtroom',
    'high-school',
    'college',
    'magic',
    'supernatural',
    'supernatural-power',
    'survival-horror',
    'folk-horror',
    'alien-invasion',
    'buddy-comedy',
    'teen-drama',
    'lgbt',
]);

/**
 * The same vocabulary as a plain array, for `= ANY(${...})` SQL predicates.
 * Derived once at module load so no call site rebuilds it per query.
 */
export const ALLOWED_KEYWORDS_ARRAY: readonly string[] = Array.from(ALLOWED_KEYWORDS);

/**
 * Display labels for the curated vocabulary. Slug-keyed because that is the form
 * `media_keywords` stores and the form `?tag=` carries.
 */
export const KEYWORD_I18N_MAP: Record<string, () => string> = {
    'tragedy-drama': m.keyword_tragedy_drama,
    'social-commentary': m.keyword_social_commentary,
    'murder-mystery': m.keyword_murder_mystery,
    spy: m.keyword_spy,
    espionage: m.keyword_espionage,
    'secret-agent': m.keyword_secret_agent,
    conspiracy: m.keyword_conspiracy,
    superhero: m.keyword_superhero,
    'superhero-action': m.keyword_superhero_action,
    'time-travel': m.keyword_time_travel,
    'post-apocalyptic': m.keyword_post_apocalyptic,
    apocalypse: m.keyword_apocalypse,
    'serial-killer': m.keyword_serial_killer,
    vampire: m.keyword_vampire,
    werewolf: m.keyword_werewolf,
    zombie: m.keyword_zombie,
    ghost: m.keyword_ghost,
    demon: m.keyword_demon,
    witch: m.keyword_witch,
    alien: m.keyword_alien,
    monster: m.keyword_monster,
    dragon: m.keyword_dragon,
    robot: m.keyword_robot,
    'artificial-intelligence': m.keyword_ai,
    redemption: m.keyword_redemption,
    'love-triangle': m.keyword_love_triangle,
    'dysfunctional-family': m.keyword_dysfunctional_family,
    'organized-crime': m.keyword_organized_crime,
    'race-against-time': m.keyword_race_against_time,
    'treasure-hunt': m.keyword_treasure_hunt,
    'quest-adventure': m.keyword_quest_adventure,
    'epic-adventure': m.keyword_epic_adventure,
    'anti-hero': m.keyword_anti_hero,
    'space-travel': m.keyword_space_travel,
    'outer-space': m.keyword_outer_space,
    spaceship: m.keyword_spaceship,
    'space-adventure': m.keyword_space_adventure,
    'space-station': m.keyword_space_station,
    'space-battle': m.keyword_space_battle,
    'mind-control': m.keyword_mind_control,
    'on-the-run': m.keyword_on_the_run,
    fugitive: m.keyword_fugitive,
    war: m.keyword_war,
    'world-war-ii': m.keyword_world_war_ii,
    'school-life': m.keyword_school_life,
    surrealism: m.keyword_surrealism,
    dystopia: m.keyword_dystopia,
    'small-town': m.keyword_small_town,
    'cult-film': m.keyword_cult_film,
    'strong-female-lead': m.keyword_strong_female_lead,
    detective: m.keyword_detective,
    assassin: m.keyword_assassin,
    hitman: m.keyword_hitman,
    thief: m.keyword_thief,
    'con-artist': m.keyword_con_artist,
    scientist: m.keyword_scientist,
    anime: m.keyword_anime,
    'anime-animation': m.keyword_anime_animation,
    'dark-comedy': m.keyword_dark_comedy,
    'romantic-comedy': m.keyword_romantic_comedy,
    'slapstick-comedy': m.keyword_slapstick_comedy,
    'parody-comedy': m.keyword_parody_comedy,
    'psychological-thriller': m.keyword_psychological_thriller,
    'psychological-drama': m.keyword_psychological_drama,
    'psychological-horror': m.keyword_psychological_horror,
    'neo-noir': m.keyword_neo_noir,
    'film-noir': m.keyword_film_noir,
    'dark-fantasy': m.keyword_dark_fantasy,
    'epic-fantasy': m.keyword_epic_fantasy,
    'sword-and-sorcery-fantasy': m.keyword_sword_and_sorcery_fantasy,
    'supernatural-fantasy': m.keyword_supernatural_fantasy,
    'dystopian-sci-fi': m.keyword_dystopian_sci_fi,
    'space-sci-fi': m.keyword_space_sci_fi,
    cyberpunk: m.keyword_cyberpunk,
    steampunk: m.keyword_steampunk,
    'space-opera': m.keyword_space_opera,
    'supernatural-horror': m.keyword_supernatural_horror,
    'body-horror': m.keyword_body_horror,
    slasher: m.keyword_slasher,
    'found-footage': m.keyword_found_footage,
    'coming-of-age': m.keyword_coming_of_age,
    'coming-of-age-drama': m.keyword_coming_of_age_drama,
    'teen-fantasy': m.keyword_teen_fantasy,
    'teen-comedy': m.keyword_teen_comedy,
    'period-drama': m.keyword_period_drama,
    'epic-drama': m.keyword_epic_drama,
    satire: m.keyword_satire,
    'satire-comedy': m.keyword_satire_comedy,
    parody: m.keyword_parody,
    mockumentary: m.keyword_mockumentary,
    heist: m.keyword_heist,
    caper: m.keyword_caper,
    whodunit: m.keyword_whodunit,
    'whodunnit-mystery': m.keyword_whodunnit_mystery,
    'martial-arts': m.keyword_martial_arts,
    'kung-fu': m.keyword_kung_fu,
    samurai: m.keyword_samurai,
    ninja: m.keyword_ninja,
    'superhero-sci-fi': m.keyword_superhero_sci_fi,
    'superhero-fantasy': m.keyword_superhero_fantasy,
    supervillain: m.keyword_supervillain,
    'alternate-history': m.keyword_alternate_history,
    'parallel-universe': m.keyword_parallel_universe,
    multiverse: m.keyword_multiverse,
    survival: m.keyword_survival,
    disaster: m.keyword_disaster,
    'home-invasion': m.keyword_home_invasion,
    kidnapping: m.keyword_kidnapping,
    hostage: m.keyword_hostage,
    haunted: m.keyword_haunted,
    creature: m.keyword_creature,
    kaiju: m.keyword_kaiju,
    cyborg: m.keyword_cyborg,
    android: m.keyword_android,
    'revenge-story': m.keyword_revenge_story,
    underdog: m.keyword_underdog,
    'rags-to-riches': m.keyword_rags_to_riches,
    'forbidden-love': m.keyword_forbidden_love,
    'star-crossed-lovers': m.keyword_star_crossed_lovers,
    'unrequited-love': m.keyword_unrequited_love,
    'family-drama': m.keyword_family_drama,
    'sibling-rivalry': m.keyword_sibling_rivalry,
    corruption: m.keyword_corruption,
    gangster: m.keyword_gangster,
    mafia: m.keyword_mafia,
    yakuza: m.keyword_yakuza,
    cartel: m.keyword_cartel,
    countdown: m.keyword_countdown,
    'ticking-clock': m.keyword_ticking_clock,
    quest: m.keyword_quest,
    'one-man-army': m.keyword_one_man_army,
    'lone-wolf': m.keyword_lone_wolf,
    vigilante: m.keyword_vigilante,
    'buddy-cop': m.keyword_buddy_cop,
    'unlikely-duo': m.keyword_unlikely_duo,
    'odd-couple': m.keyword_odd_couple,
    'road-trip': m.keyword_road_trip,
    'space-exploration': m.keyword_space_exploration,
    'first-contact': m.keyword_first_contact,
    brainwashing: m.keyword_brainwashing,
    'memory-manipulation': m.keyword_memory_manipulation,
    'hidden-identity': m.keyword_hidden_identity,
    'double-life': m.keyword_double_life,
    impostor: m.keyword_impostor,
    doppelganger: m.keyword_doppelganger,
    island: m.keyword_island,
    'desert-island': m.keyword_desert_island,
    stranded: m.keyword_stranded,
    isolated: m.keyword_isolated,
    'prison-escape': m.keyword_prison_escape,
    escape: m.keyword_escape,
    undercover: m.keyword_undercover,
    infiltration: m.keyword_infiltration,
    'double-cross': m.keyword_double_cross,
    tournament: m.keyword_tournament,
    competition: m.keyword_competition,
    sports: m.keyword_sports,
    boxing: m.keyword_boxing,
    fighting: m.keyword_fighting,
    'vietnam-war': m.keyword_vietnam_war,
    'cold-war': m.keyword_cold_war,
    'civil-war': m.keyword_civil_war,
    historical: m.keyword_historical,
    'ancient-rome': m.keyword_ancient_rome,
    medieval: m.keyword_medieval,
    renaissance: m.keyword_renaissance,
    victorian: m.keyword_victorian,
    shounen: m.keyword_shounen,
    seinen: m.keyword_seinen,
    isekai: m.keyword_isekai,
    mecha: m.keyword_mecha,
    harem: m.keyword_harem,
    'slice-of-life': m.keyword_slice_of_life,
    'magical-girl': m.keyword_magical_girl,
    shojo: m.keyword_shojo,
    josei: m.keyword_josei,
    ecchi: m.keyword_ecchi,
    'sports-anime': m.keyword_sports_anime,
    noir: m.keyword_noir,
    gothic: m.keyword_gothic,
    dreamlike: m.keyword_dreamlike,
    psychological: m.keyword_psychological,
    utopia: m.keyword_utopia,
    futuristic: m.keyword_futuristic,
    'retro-futuristic': m.keyword_retro_futuristic,
    western: m.keyword_western,
    frontier: m.keyword_frontier,
    'old-west': m.keyword_old_west,
    jungle: m.keyword_jungle,
    rainforest: m.keyword_rainforest,
    arctic: m.keyword_arctic,
    underwater: m.keyword_underwater,
    'haunted-house': m.keyword_haunted_house,
    mansion: m.keyword_mansion,
    castle: m.keyword_castle,
    dungeon: m.keyword_dungeon,
    rural: m.keyword_rural,
    urban: m.keyword_urban,
    'big-city': m.keyword_big_city,
    'new-york': m.keyword_new_york,
    tokyo: m.keyword_tokyo,
    paris: m.keyword_paris,
    london: m.keyword_london,
    'black-comedy': m.keyword_black_comedy,
    'dark-humor': m.keyword_dark_humor,
    absurdist: m.keyword_absurdist,
    surreal: m.keyword_surreal,
    'feel-good': m.keyword_feel_good,
    heartwarming: m.keyword_heartwarming,
    inspirational: m.keyword_inspirational,
    uplifting: m.keyword_uplifting,
    intense: m.keyword_intense,
    suspenseful: m.keyword_suspenseful,
    'edge-of-seat': m.keyword_edge_of_seat,
    'nail-biting': m.keyword_nail_biting,
    gritty: m.keyword_gritty,
    realistic: m.keyword_realistic,
    grounded: m.keyword_grounded,
    raw: m.keyword_raw,
    stylized: m.keyword_stylized,
    'visually-stunning': m.keyword_visually_stunning,
    artistic: m.keyword_artistic,
    indie: m.keyword_indie,
    'independent-film': m.keyword_independent_film,
    arthouse: m.keyword_arthouse,
    experimental: m.keyword_experimental,
    'grindhouse-film': m.keyword_grindhouse_film,
    exploitation: m.keyword_exploitation,
    'b-movie': m.keyword_b_movie,
    'femme-fatale': m.keyword_femme_fatale,
    'female-warrior': m.keyword_female_warrior,
    'action-heroine': m.keyword_action_heroine,
    'villain-protagonist': m.keyword_villain_protagonist,
    'morally-ambiguous': m.keyword_morally_ambiguous,
    genius: m.keyword_genius,
    prodigy: m.keyword_prodigy,
    mastermind: m.keyword_mastermind,
    hacker: m.keyword_hacker,
    'private-investigator': m.keyword_private_investigator,
    journalist: m.keyword_journalist,
    reporter: m.keyword_reporter,
    mercenary: m.keyword_mercenary,
    'bounty-hunter': m.keyword_bounty_hunter,
    grifter: m.keyword_grifter,
    'bank-robber': m.keyword_bank_robber,
    'mad-scientist': m.keyword_mad_scientist,
    inventor: m.keyword_inventor,
    professor: m.keyword_professor,
    'based-on-true-story': m.keyword_based_on_true_story,
    biography: m.keyword_biography,
    musical: m.keyword_musical,
    christmas: m.keyword_christmas,
    halloween: m.keyword_halloween,
    military: m.keyword_military,
    'world-war-two': m.keyword_world_war_two,
    politics: m.keyword_politics,
    religion: m.keyword_religion,
    terrorism: m.keyword_terrorism,
    courtroom: m.keyword_courtroom,
    'high-school': m.keyword_high_school,
    college: m.keyword_college,
    magic: m.keyword_magic,
    supernatural: m.keyword_supernatural,
    'supernatural-power': m.keyword_supernatural_power,
    'survival-horror': m.keyword_survival_horror,
    'folk-horror': m.keyword_folk_horror,
    'alien-invasion': m.keyword_alien_invasion,
    'buddy-comedy': m.keyword_buddy_comedy,
    'teen-drama': m.keyword_teen_drama,
    lgbt: m.keyword_lgbt,
};

/**
 * Resolve a keyword to a human-readable, localized label.
 *
 * Resolution order:
 *   1. {@link KEYWORD_I18N_MAP} — covers the curated vocabulary, so on any
 *      surface gated by `ALLOWED_KEYWORDS` this is effectively always the hit.
 *   2. Last-resort fallback: title-case the raw value (`dark-comedy` → `Dark
 *      Comedy`, `time travel` → `Time Travel`). Only reachable for a keyword
 *      outside the curated set, e.g. a hand-typed `?tag=` deep link. Splits on
 *      whitespace as well as hyphens because `media_keywords` stores BOTH forms:
 *      `mdblist_keywords` are hyphenated slugs, `keywords` are provider keyword
 *      names with spaces (both merely lowercased + trimmed).
 */
export function keywordDisplayName(keyword: string): string {
    const i18nFn = KEYWORD_I18N_MAP[keyword];
    if (i18nFn) return i18nFn();
    return keyword
        .split(/[-\s]+/)
        .filter(Boolean)
        .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
        .join(' ');
}

/**
 * Near-duplicate slug → canonical slug.
 *
 * The raw provider space carries several slugs for ONE concept (`whodunit` /
 * `whodunnit-mystery`, `spy` / `espionage`, `world-war-ii` / `world-war-two`).
 * Curating the list did not fix that — it just admitted two members of the same
 * cluster, and the typeahead then rendered two options with the SAME label,
 * indistinguishable to the user and each filtering to a different subset of the
 * catalog.
 *
 * So the cluster gets one canonical member. Suggestion surfaces offer only
 * canonicals; counts and `?tag=` membership both span the whole group, which is
 * what keeps the documented invariant intact — a suggestion's count equals what
 * `?tag=<that slug>` returns.
 *
 * ONLY for slugs that mean the same thing. Pairs that merely collide in ONE
 * translation (`race-against-time` / `ticking-clock`, `satire` / `satire-comedy`)
 * are distinct concepts and are fixed in the message files instead — aliasing
 * them would silently merge two real filters.
 *
 * Every key and every value must also be in {@link ALLOWED_KEYWORDS}; the
 * accompanying test asserts that, so a typo cannot quietly disable a group.
 */
export const KEYWORD_ALIASES: Readonly<Record<string, string>> = Object.assign(
    // Null-prototype: `?tag=` is user input, and a plain object literal would
    // answer `constructor` / `toString` / `__proto__` lookups with something off
    // Object.prototype instead of "not an alias". Harmless in SQL (postgres.js
    // stringifies the parameter and it matches nothing), but the active-filter
    // chip would render "[object Object]" as its label.
    Object.create(null) as Record<string, string>,
    {
        'whodunnit-mystery': 'whodunit',
        espionage: 'spy',
        'world-war-two': 'world-war-ii',
        'anime-animation': 'anime',
        'coming-of-age-drama': 'coming-of-age',
    },
);

/**
 * Canonical slug → every slug in its group (the canonical first). Derived once
 * at module load; canonicals with no alias are absent, so callers should treat
 * a miss as "group of one" — see {@link keywordGroupMembers}.
 */
const KEYWORD_ALIAS_GROUPS: ReadonlyMap<string, readonly string[]> = (() => {
    const groups = new Map<string, string[]>();
    for (const [alias, canonical] of Object.entries(KEYWORD_ALIASES)) {
        const members = groups.get(canonical) ?? [canonical];
        members.push(alias);
        groups.set(canonical, members);
    }
    return groups;
})();

/**
 * The suggestible vocabulary: the curated set minus every aliased slug.
 *
 * This is what a typeahead or facet may OFFER. Filtering still accepts the full
 * `ALLOWED_KEYWORDS` (and beyond — see `buildKeywordMembershipFilter`), so old
 * `?tag=whodunnit-mystery` deep links keep resolving.
 */
export const CANONICAL_KEYWORDS_ARRAY: readonly string[] = ALLOWED_KEYWORDS_ARRAY.filter(
    (kw) => !(kw in KEYWORD_ALIASES),
);

/**
 * Fold a slug onto its canonical form. Unknown slugs (non-curated `?tag=` deep
 * links) pass through untouched.
 */
export function canonicalKeyword(keyword: string): string {
    return KEYWORD_ALIASES[keyword] ?? keyword;
}

/**
 * Every slug that should be treated as the given one — the canonical plus its
 * aliases, canonicalizing the input first so a non-canonical `?tag=` deep link
 * resolves to the same group as the canonical.
 *
 * Returns `[keyword]` for anything outside the alias map, which covers both
 * curated slugs with no alias and the entire non-curated long tail.
 */
export function keywordGroupMembers(keyword: string): readonly string[] {
    const canonical = canonicalKeyword(keyword);
    return KEYWORD_ALIAS_GROUPS.get(canonical) ?? [canonical];
}

/**
 * The curated slugs a typeahead prefix should scan — WHOLE groups, not the
 * individual members that matched.
 *
 * A group is included when ANY of its members starts with the prefix, and then
 * ALL of its members come along. That is what makes the offered count equal the
 * filtered count: typing "espio" matches the `espionage` alias, whose group
 * canonicalizes to `spy`, and `?tag=spy` filters on the whole group — so the
 * suggestion must be counted over the whole group too, not over `espionage`
 * alone.
 *
 * An empty prefix means "no narrowing" and returns the full curated set.
 *
 * @returns raw slugs for a `= ANY(...)` predicate; empty when nothing matches
 */
export function curatedKeywordsForPrefix(prefix: string): readonly string[] {
    const normalized = prefix.trim().toLowerCase();
    if (!normalized) return ALLOWED_KEYWORDS_ARRAY;

    const slugs: string[] = [];
    for (const canonical of CANONICAL_KEYWORDS_ARRAY) {
        const members = keywordGroupMembers(canonical);
        if (members.some((member) => member.startsWith(normalized))) slugs.push(...members);
    }
    return slugs;
}

/**
 * The alias map as two parallel arrays, for `unnest($1::text[], $2::text[])` in
 * SQL. Built once at module load so a per-query facet aggregation does not
 * rebuild it.
 */
export const KEYWORD_ALIAS_SQL_PAIRS: {
    readonly from: readonly string[];
    readonly to: readonly string[];
} = {
    from: Object.keys(KEYWORD_ALIASES),
    to: Object.values(KEYWORD_ALIASES),
};
