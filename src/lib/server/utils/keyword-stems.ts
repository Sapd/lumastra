// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Keyword Stem Mappings
 *
 * Centralizes keyword normalization for:
 * 1. Embedding text deduplication (embedding-text-formatter.ts)
 * 2. User preference tracking (for-you.service.ts, database.ts)
 *
 * Maps variations to canonical forms:
 * - "cartoon", "animated", "animation" -> "animation"
 * - "teenager", "teen", "high-school" -> "coming-of-age"
 */

/**
 * Comprehensive stem mappings for semantic deduplication and preference tracking
 * Maps keyword variations to their canonical form
 */
export const KEYWORD_STEM_MAP: Record<string, string> = {
    // ============================================
    // ANIMATION / FAMILY CONTENT (key for preference tracking)
    // ============================================
    // Animation variants (western animation)
    cartoon: 'animation',
    animated: 'animation',
    animation: 'animation',
    cgi: 'animation',
    'cgi-animation': 'animation',
    '3d-animation': 'animation',
    '2d-animation': 'animation',
    'computer-animated': 'animation',

    // Anime (kept separate from western animation)
    anime: 'anime',
    'anime-animation': 'anime',
    'japanese-animation': 'anime',

    // NOTE: Disney and Pixar are intentionally NOT mapped - they're distinct, meaningful keywords
    // Users may like Disney but not Pixar or vice versa
    // 'disney': kept as-is
    // 'pixar': kept as-is
    dreamworks: 'dreamworks',
    illumination: 'illumination',

    // Family/kids content
    'family-friendly': 'family',
    'family-film': 'family',
    'family-movie': 'family',
    'for-children': 'family',

    // Talking animals (common in animated films)
    'talking-animals': 'talking-animals',
    'talking-animal': 'talking-animals',
    anthropomorphic: 'talking-animals',
    anthropomorphism: 'talking-animals',

    // ============================================
    // MYSTERY / THRILLER
    // ============================================
    mysterious: 'mystery',
    mysteries: 'mystery',

    // ============================================
    // DARK / DEATH
    // ============================================
    darkness: 'dark',
    darkly: 'dark',
    deadly: 'death',
    deaths: 'death',
    dead: 'death',
    dying: 'death',

    // ============================================
    // RELATIONSHIPS
    // ============================================
    loving: 'love',
    lover: 'love',
    lovers: 'love',
    loved: 'love',
    friends: 'friendship',
    friendly: 'friendship',
    families: 'family',
    familial: 'family',
    relationships: 'relationship',
    relational: 'relationship',

    // ============================================
    // DISAPPEARANCE / SECRETS
    // ============================================
    disappearance: 'disappear',
    disappearances: 'disappear',
    disappeared: 'disappear',
    disappearing: 'disappear',
    secrets: 'secret',
    secretive: 'secret',

    // ============================================
    // REVENGE / MURDER / DANGER
    // ============================================
    vengeance: 'revenge',
    vengeful: 'revenge',
    murders: 'murder',
    murderer: 'murder',
    murderous: 'murder',
    dangerous: 'danger',
    dangers: 'danger',
    strange: 'strange',
    stranger: 'strange',
    strangeness: 'strange',

    // ============================================
    // ANIMALS / CREATURES
    // ============================================
    animals: 'animal',
    animalistic: 'animal',

    // ============================================
    // CRIME / POLICE
    // ============================================
    crimes: 'crime',
    criminal: 'crime',
    criminals: 'crime',
    cops: 'police',
    cop: 'police',
    policeman: 'police',
    policewoman: 'police',
    detective: 'police',
    detectives: 'police',
    investigations: 'investigation',
    investigator: 'investigation',
    investigate: 'investigation',

    // ============================================
    // ACTION / CHASE / ESCAPE
    // ============================================
    chasing: 'chase',
    chases: 'chase',
    escaping: 'escape',
    escapes: 'escape',
    escaped: 'escape',

    // ============================================
    // PEOPLE / FAMILY MEMBERS
    // ============================================
    children: 'child',
    kids: 'child',
    kid: 'child',
    women: 'woman',
    men: 'man',
    killers: 'killer',
    killing: 'killer',
    kills: 'killer',
    corrupt: 'corruption',
    corrupted: 'corruption',

    // Sibling variants
    siblings: 'sibling',
    'sibling-relationship': 'sibling',
    'sibling-rivalry': 'sibling',
    brother: 'sibling',
    brothers: 'sibling',
    sister: 'sibling',
    sisters: 'sibling',

    // Parent variants
    parents: 'parent',
    parenting: 'parent',
    parental: 'parent',
    mother: 'parent',
    father: 'parent',

    // ============================================
    // EMOTIONS / TRAITS
    // ============================================
    powerful: 'power',
    powers: 'power',
    powerless: 'power',
    fearful: 'fear',
    fears: 'fear',
    feared: 'fear',
    fearing: 'fear',
    scary: 'fear',
    scared: 'fear',
    wealthy: 'wealth',
    rich: 'wealth',
    riches: 'wealth',
    poverty: 'poor',
    impoverished: 'poor',
    truthful: 'truth',
    truths: 'truth',
    lying: 'lie',
    liar: 'lie',
    lies: 'lie',
    trusting: 'trust',
    trusted: 'trust',
    trustworthy: 'trust',
    betrayal: 'betray',
    betrayed: 'betray',
    betraying: 'betray',

    // ============================================
    // HEROES / VILLAINS
    // ============================================
    heroic: 'hero',
    heroes: 'hero',
    heroism: 'hero',
    villainous: 'villain',
    villains: 'villain',
    villainy: 'villain',

    // ============================================
    // SUPERNATURAL CREATURES
    // ============================================
    // Vampire variants
    vampires: 'vampire',
    vampirism: 'vampire',
    'vampire-hunter': 'vampire',
    'vampire-slayer': 'vampire',

    // Zombie variants
    zombies: 'zombie',
    undead: 'zombie',

    // Werewolf variants
    werewolves: 'werewolf',
    lycanthropy: 'werewolf',
    lycanthrope: 'werewolf',

    // Ghost variants
    ghosts: 'ghost',
    ghostly: 'ghost',
    haunted: 'ghost',
    haunting: 'ghost',
    hauntings: 'ghost',
    'haunted-house': 'ghost',
    'haunted-mansion': 'ghost',
    'haunted-place': 'ghost',
    poltergeist: 'ghost',
    specter: 'ghost',
    spectre: 'ghost',
    apparition: 'ghost',
    spirit: 'ghost',
    spirits: 'ghost',

    // Demon variants
    demons: 'demon',
    demonic: 'demon',
    devil: 'demon',
    devils: 'demon',
    satanic: 'demon',
    satan: 'demon',

    // Angel variants
    angels: 'angel',
    angelic: 'angel',

    // Witch variants
    witches: 'witch',
    witchcraft: 'witch',
    witchy: 'witch',
    sorcerer: 'witch',
    sorcery: 'witch',
    sorceress: 'witch',

    // Monster variants
    monsters: 'monster',
    monstrous: 'monster',
    creature: 'monster',
    creatures: 'monster',

    // Alien variants
    aliens: 'alien',
    extraterrestrial: 'alien',
    extraterrestrials: 'alien',
    ufo: 'alien',
    ufos: 'alien',

    // Robot variants
    robots: 'robot',
    robotic: 'robot',
    android: 'robot',
    androids: 'robot',
    cyborg: 'robot',
    cyborgs: 'robot',

    // ============================================
    // LOCATIONS
    // ============================================
    la: 'los-angeles',
    'l.a.': 'los-angeles',
    nyc: 'new-york',
    'new-york-city': 'new-york',
    manhattan: 'new-york',
    brooklyn: 'new-york',
    'london-england': 'london',
    'paris-france': 'paris',
    'tokyo-japan': 'tokyo',

    // ============================================
    // SENSITIVE CONTENT (standardization)
    // ============================================
    // Sexual crimes
    rape: 'sexual-crime',
    rapist: 'sexual-crime',
    incest: 'sexual-crime',
    'sexual-abuse': 'sexual-crime',
    'sexual-assault': 'sexual-crime',
    molestation: 'sexual-crime',
    'child-abuse': 'sexual-crime',
    pedophilia: 'sexual-crime',
    pedophile: 'sexual-crime',

    // Sex work
    prostitute: 'prostitution',
    prostitutes: 'prostitution',
    hooker: 'prostitution',
    escort: 'prostitution',
    'call-girl': 'prostitution',
    'sex-worker': 'prostitution',
    'sex-work': 'prostitution',
    brothel: 'prostitution',

    // Violence
    torture: 'violence',
    torturing: 'violence',
    tortured: 'violence',
    beating: 'violence',
    stabbing: 'violence',
    shooting: 'violence',
    strangling: 'violence',
    strangulation: 'violence',
    decapitation: 'violence',
    dismemberment: 'violence',

    // Addiction
    'drug-addict': 'addiction',
    'drug-addiction': 'addiction',
    alcoholic: 'addiction',
    alcoholism: 'addiction',
    'substance-abuse': 'addiction',
    junkie: 'addiction',

    // Mental health
    suicide: 'mental-health',
    suicidal: 'mental-health',
    'self-harm': 'mental-health',
    depression: 'mental-health',
    depressed: 'mental-health',
    anxiety: 'mental-health',
    ptsd: 'mental-health',
    trauma: 'mental-health',
    traumatic: 'mental-health',

    // Domestic abuse
    'domestic-violence': 'domestic-abuse',
    'domestic-abuse': 'domestic-abuse',
    'spousal-abuse': 'domestic-abuse',
    'wife-beating': 'domestic-abuse',
    'abusive-relationship': 'domestic-abuse',
    'abusive-husband': 'domestic-abuse',
    'abusive-wife': 'domestic-abuse',
    'abusive-parent': 'domestic-abuse',

    // ============================================
    // PARANORMAL / POSSESSION
    // ============================================
    'demonic-possession': 'possession',
    'spirit-possession': 'possession',
    possessed: 'possession',
    possessing: 'possession',
    'paranormal-investigation': 'paranormal',
    'paranormal-activity': 'paranormal',
    'paranormal-phenomena': 'paranormal',
    'supernatural-investigation': 'paranormal',

    // Exorcism
    exorcism: 'exorcist',
    exorcist: 'exorcist',
    exorcists: 'exorcist',

    // ============================================
    // TIME / SPACE / SCI-FI
    // ============================================
    // Time travel
    'time-travel': 'time-travel',
    'time-traveler': 'time-travel',
    'time-traveller': 'time-travel',
    'time-loop': 'time-travel',
    'time-machine': 'time-travel',
    temporal: 'time-travel',
    chronology: 'time-travel',

    // Space
    'outer-space': 'space',
    'deep-space': 'space',
    'space-travel': 'space',
    'space-exploration': 'space',
    spaceship: 'space',
    spacecraft: 'space',
    'space-station': 'space',
    'space-opera': 'space',

    // Apocalypse
    apocalypse: 'apocalypse',
    apocalyptic: 'apocalypse',
    'post-apocalyptic': 'apocalypse',
    'post-apocalypse': 'apocalypse',
    'end-of-the-world': 'apocalypse',
    armageddon: 'apocalypse',
    doomsday: 'apocalypse',

    // Dystopia
    dystopia: 'dystopia',
    dystopian: 'dystopia',

    // Survival
    survival: 'survival',
    survivalist: 'survival',
    survivor: 'survival',
    survivors: 'survival',
    surviving: 'survival',

    // ============================================
    // CRIME SUBGENRES
    // ============================================
    // Serial killer
    'serial-killer': 'serial-killer',
    'serial-murderer': 'serial-killer',
    'serial-killings': 'serial-killer',
    'mass-murderer': 'serial-killer',

    // Heist
    heist: 'heist',
    robbery: 'heist',
    'bank-robbery': 'heist',
    'bank-heist': 'heist',
    'jewel-heist': 'heist',
    'casino-heist': 'heist',
    'art-heist': 'heist',

    // Prison
    prison: 'prison',
    jail: 'prison',
    prisoner: 'prison',
    prisoners: 'prison',
    inmate: 'prison',
    inmates: 'prison',
    incarceration: 'prison',
    imprisoned: 'prison',
    'prison-escape': 'prison',
    jailbreak: 'prison',

    // Conspiracy
    conspiracy: 'conspiracy',
    conspiracies: 'conspiracy',
    'conspiracy-theory': 'conspiracy',
    'cover-up': 'conspiracy',
    coverup: 'conspiracy',

    // ============================================
    // WAR
    // ============================================
    warfare: 'war',
    wartime: 'war',
    'world-war': 'war',
    'world-war-i': 'war',
    'world-war-ii': 'war',
    wwi: 'war',
    wwii: 'war',
    ww1: 'war',
    ww2: 'war',
    'civil-war': 'war',
    'vietnam-war': 'war',
    'korean-war': 'war',
    'gulf-war': 'war',
    'iraq-war': 'war',
    'afghan-war': 'war',

    // ============================================
    // MARTIAL ARTS / COMBAT
    // ============================================
    combat: 'martial-arts',
    fighting: 'martial-arts',
    fight: 'martial-arts',
    'kung-fu': 'martial-arts',
    'kung fu': 'martial-arts',
    karate: 'martial-arts',
    judo: 'martial-arts',
    taekwondo: 'martial-arts',
    'tae-kwon-do': 'martial-arts',
    boxing: 'martial-arts',
    kickboxing: 'martial-arts',
    'kick-boxing': 'martial-arts',
    wrestling: 'martial-arts',
    mma: 'martial-arts',
    'mixed-martial-arts': 'martial-arts',
    aikido: 'martial-arts',
    'jiu-jitsu': 'martial-arts',
    'brazilian-jiu-jitsu': 'martial-arts',
    'muay-thai': 'martial-arts',
    capoeira: 'martial-arts',
    'krav-maga': 'martial-arts',
    wushu: 'martial-arts',
    'hand-to-hand-combat': 'martial-arts',

    // ============================================
    // COMING OF AGE / TEEN
    // ============================================
    'teenage-girl': 'coming-of-age',
    'teenage-boy': 'coming-of-age',
    teenager: 'coming-of-age',
    teenagers: 'coming-of-age',
    teen: 'coming-of-age',
    teens: 'coming-of-age',
    'teen-angst': 'coming-of-age',
    adolescence: 'coming-of-age',
    adolescent: 'coming-of-age',
    puberty: 'coming-of-age',
    'high-school': 'coming-of-age',
    'high-school-student': 'coming-of-age',
    'high-schooler': 'coming-of-age',
    'senior-year': 'coming-of-age',
    'junior-year': 'coming-of-age',
    sophomore: 'coming-of-age',
    freshman: 'coming-of-age',
    prom: 'coming-of-age',
    'first-love': 'coming-of-age',
    'first-kiss': 'coming-of-age',
    'growing-up': 'coming-of-age',
    youth: 'coming-of-age',
    'young-adult': 'coming-of-age',
    bildungsroman: 'coming-of-age',

    // ============================================
    // SCHOOL SETTING
    // ============================================
    'middle-school': 'school',
    'middle-schooler': 'school',
    'junior-high': 'school',
    'junior-high-school': 'school',
    'elementary-school': 'school',
    'primary-school': 'school',
    'grade-school': 'school',
    'boarding-school': 'school',
    'private-school': 'school',
    'public-school': 'school',
    'school-life': 'school',
    'school-setting': 'school',
    classroom: 'school',
    gymnasium: 'school',
    realschule: 'school',
    hauptschule: 'school',
    gesamtschule: 'school',

    // German slang
    pauker: 'lehrer',

    // ============================================
    // COMEDY VARIANTS
    // ============================================
    comedy: 'comedy',
    funny: 'comedy',
    slapstick: 'comedy',
    humor: 'comedy',
    humorous: 'comedy',
    'romantic-comedy': 'romcom',
    'rom-com': 'romcom',
    romcom: 'romcom',
    'dark-comedy': 'dark-comedy',
    'black-comedy': 'dark-comedy',

    // ============================================
    // HORROR VARIANTS
    // ============================================
    horror: 'horror',
    slasher: 'horror',
    'supernatural-horror': 'horror',
    'psychological-horror': 'horror',
    'body-horror': 'horror',
    'horror-comedy': 'horror',
    'creature-horror': 'horror',

    // ============================================
    // DRAMA / ROMANCE / THRILLER
    // ============================================
    drama: 'drama',
    dramatic: 'drama',
    melodrama: 'drama',
    romance: 'romance',
    romantic: 'romance',
    'love-story': 'romance',
    thriller: 'thriller',
    suspense: 'thriller',
    'psychological-thriller': 'psychological-thriller',
    whodunit: 'mystery',

    // ============================================
    // DOCUMENTARY / BIOGRAPHY
    // ============================================
    documentary: 'documentary',
    docudrama: 'documentary',
    'true-story': 'true-story',
    'based-on-true-story': 'true-story',
    biographical: 'biography',
    biography: 'biography',
    biopic: 'biography',

    // ============================================
    // ACTION / SCI-FI
    // ============================================
    action: 'action',
    'action-adventure': 'action',
    'sci-fi': 'sci-fi',
    'science-fiction': 'sci-fi',
    futuristic: 'sci-fi',
};

/**
 * Noise keywords that should be excluded from preference analysis.
 * These are metadata tags about distribution/format, not content.
 * They appear on nearly every movie and don't indicate user taste.
 */
export const NOISE_KEYWORDS: Set<string> = new Set([
    // Media formats - describe HOW movie is distributed, not WHAT it's about
    'has-trailer',
    'blu-ray',
    '2k-blu-ray',
    '4k-blu-ray',
    '4k-ultra-hd',
    'dvd',
    'dolby-vision',
    'dolby-atmos',
    'hdr10',
    'hdr10+',
    'hdr',
    'digital-3d',
    '3d',
    'imax',
    'imax-3d',
    'sdh-subtitles',
    'closed-captions',
    'theatrical-release',

    // Collection/franchise metadata
    'belongs-to-collection',
    'collection-follow-up',
    'sequel',
    'prequel',
    'spin-off',
    'remake',
    'reboot',
    'franchise',
    'cinematic-universe',
    'shared-universe',

    // Credits/structure metadata
    'no-opening-credits',
    'mid-credits-scene',
    'post-credits-scene',
    'after-credits-scene',
    'end-credits-scene',
    'opening-credits-at-end',

    // Narrative techniques (too generic)
    'flashback',
    'flash-forward',
    'non-linear-timeline',
    'narrator',
    'voice-over',
    'voiceover',

    // Production metadata
    'blockbuster',
    'big-budget',
    'low-budget',
    'independent-film',
    'indie-film',
    'studio-film',

    // Awards / review-aggregator metadata
    'certified-fresh',
    'certified-hot',
    'oscar-winner',
    'oscar-nominated',
    'academy-award',
    'golden-globe',
    'cannes',
    'sundance',
    'berlin-film-festival',
    'venice-film-festival',

    // Rating/certification (metadata, not content)
    'pg',
    'pg-13',
    'r-rated',
    'nc-17',
    'unrated',
    'directors-cut',
    'extended-cut',
    'theatrical-cut',

    // Generic plot elements (appear on too many movies to be meaningful)
    'kiss',
    'surprise-ending',
    'twist-ending',
    'plot-twist',
]);

/**
 * Check if a keyword is a noise keyword that should be excluded from preference analysis
 */
export function isNoiseKeyword(keyword: string): boolean {
    return NOISE_KEYWORDS.has(keyword.toLowerCase().trim());
}

/**
 * Filter out noise keywords from an array
 */
export function filterNoiseKeywords(keywords: string[]): string[] {
    return keywords.filter((kw) => !isNoiseKeyword(kw));
}

/**
 * Normalize a keyword to its stem
 * Returns the stem if mapped, otherwise returns the original keyword lowercased
 */
export function normalizeKeyword(keyword: string): string {
    const lower = keyword.toLowerCase().trim().replace(/\s+/g, '-');
    return KEYWORD_STEM_MAP[lower] ?? lower;
}

/**
 * Normalize an array of keywords to their stems
 * Removes duplicates after normalization
 */
export function normalizeKeywords(keywords: string[]): string[] {
    const seen = new Set<string>();
    const result: string[] = [];

    for (const kw of keywords) {
        const stem = normalizeKeyword(kw);
        if (!seen.has(stem)) {
            seen.add(stem);
            result.push(stem);
        }
    }

    return result;
}

/**
 * Get all raw keywords that map to a given stem
 * Useful for expanding a stem back to all its variants for querying
 */
export function getKeywordsForStem(stem: string): string[] {
    const keywords: string[] = [];
    for (const [raw, mappedStem] of Object.entries(KEYWORD_STEM_MAP)) {
        if (mappedStem === stem) {
            keywords.push(raw);
        }
    }
    // Also include the stem itself if it's not already in the list
    if (!keywords.includes(stem)) {
        keywords.push(stem);
    }
    return keywords;
}

/**
 * Convert KEYWORD_STEM_MAP to SQL VALUES format for use in queries
 * Returns array of [raw_keyword, stem] pairs
 */
export function getStemMapAsArrays(): {
    rawKeywords: string[];
    stems: string[];
} {
    const rawKeywords: string[] = [];
    const stems: string[] = [];

    for (const [raw, stem] of Object.entries(KEYWORD_STEM_MAP)) {
        rawKeywords.push(raw);
        stems.push(stem);
    }

    return { rawKeywords, stems };
}

/**
 * Extract the semantic root of a compound keyword
 * "mysterious-girl" -> "mysterious" -> "mystery"
 * "dark-mysteries" -> "mysteries" -> "mystery"
 */
export function extractSemanticRoot(keyword: string): string {
    const normalized = keyword.toLowerCase().replace(/-/g, ' ').trim();
    const words = normalized.split(/\s+/);

    // Check each word for stem mapping
    for (const word of words) {
        const hyphenated = word.replace(/\s+/g, '-');
        if (KEYWORD_STEM_MAP[word]) {
            return KEYWORD_STEM_MAP[word];
        }
        if (KEYWORD_STEM_MAP[hyphenated]) {
            return KEYWORD_STEM_MAP[hyphenated];
        }
        // Also check if the word itself is a canonical stem
        if (Object.values(KEYWORD_STEM_MAP).includes(word)) {
            return word;
        }
    }

    // Return the full normalized keyword if no stem found
    return normalized;
}
