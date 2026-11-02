// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Unified Embedding Text Formatter
 *
 * Creates clean, natural language text for embedding models.
 * Optimized for OpenAI's text-embedding-3-small and similar models.
 *
 * Key improvements over the old pipe-delimited format:
 * - Uses newlines instead of pipes for better semantic separation
 * - German labels for German-focused content (Jellyfin)
 * - Removes noisy technical IDs (IMDB ID, internal statuses)
 * - Focuses on semantically meaningful content
 * - Consistent structure across all sources
 */

import { extractSemanticRoot } from '../utils/keyword-stems.js';

export interface EmbeddingTextInput {
    // Required
    title: string;
    year?: number | null;

    // Content
    overview?: string | null;
    genres?: string[];
    keywords?: string[];

    // Runtime and ratings
    runtimeMinutes?: number | null;
    imdbRating?: number | null;
    tmdbRating?: number | null;
    letterboxdRating?: number | null;
    rtCriticsScore?: number | null;
    rtAudienceScore?: number | null;
    traktScore?: number | null;
    metacriticScore?: number | null;
    malScore?: number | null;
    mdblistScore?: number | null;

    // Cast & Crew
    directors?: string[];
    actors?: string[];
    producers?: string[];
    writers?: string[];

    // Production
    networks?: string[];
    studios?: string[];
    countries?: string[];
    languages?: string[];

    // Classification
    certification?: string | null;
    mediaType?: 'movie' | 'tv';

    // Anime-specific
    isAnime?: boolean;
    animeGenres?: string[];
}

export interface EmbeddingTextOptions {
    /** Include Details line (runtime, rating, certification) */
    includeRatings?: boolean;
    /** Maximum number of actors to include */
    maxActors?: number;
    /** Maximum number of keywords to include */
    maxKeywords?: number;
}

const DEFAULT_OPTIONS: Required<EmbeddingTextOptions> = {
    includeRatings: true,
    maxActors: 6,
    maxKeywords: 15,
};

/**
 * Exact-match keywords to exclude from embeddings (O(1) Set lookup).
 * These were formerly /^word$/i patterns — stored lowercase for case-insensitive matching.
 * Format/distribution tags, generic adjectives, noise that doesn't describe story content.
 */
const EXCLUDED_KEYWORDS_EXACT = new Set<string>([
    // Physical formats
    'dvd',
    'vhs',
    'laserdisc',
    'uhd',
    'widescreen',
    'letterbox',
    'imax',
    // Distribution/release
    'unrated',
    'criterion',
    'restored',
    // Technical audio
    'stereo',
    'mono',
    'atmos',
    'dts',
    // Non-semantic meta tags
    'trailer',
    // Format/medium tags (not story themes)
    'anime',
    'animation',
    'cgi',
    'cartoon',
    'animated',
    // Genre labels that leak into keywords
    'shounen',
    'shonen',
    'shoujo',
    'shojo',
    'seinen',
    'josei',
    'isekai',
    'mecha',
    // Self-referential/franchise tags
    'marvel',
    'mcu',
    'dcu',
    // Database/scraper slugs
    'second-part',
    'third-part',
    // Too generic single-word tags
    'attack',
    'fight',
    'escape',
    'chase',
    'death',
    'love',
    'war',
    'hero',
    'villain',
    'complex',
    'playful',
    'embarrassed',
    'excited',
    // Visual/physical descriptors
    'muscular',
    'bikini',
    'swimsuit',
    'underwear',
    'lingerie',
    'stripper',
    // Technical animation format tags
    '2d',
    '3d',
    '4k',
    '8k',
    'rotoscope',
    // Structural/meta tags
    'sequel',
    'prequel',
    'reboot',
    'remake',
    'spinoff',
    'crossover',
    'adaptation',
    'standalone',
    'anthology',
    // Micro-actions/objects
    'ledge',
    'cut',
    'hood',
    'lake',
    'table',
    'lemming',
    'sunglasses',
    'cigarette',
    'cigar',
    'wine',
    'beer',
    'coffee',
    'phone',
    'computer',
    'laptop',
    'car',
    'door',
    'window',
    'roof',
    'floor',
    'wall',
    'stairs',
    'elevator',
    'hallway',
    'bathroom',
    'bedroom',
    'kitchen',
    'office',
    'street',
    'road',
    'bridge',
    'building',
    'house',
    'apartment',
    'hotel',
    'restaurant',
    'bar',
    'club',
    'school',
    'hospital',
    'church',
    'park',
    'beach',
    'forest',
    'mountain',
    'river',
    'ocean',
    'island',
    // Body part descriptors
    'hand',
    'hands',
    'foot',
    'feet',
    'head',
    'face',
    'eye',
    'eyes',
    'hair',
    // Clothing items
    'shirt',
    'pants',
    'dress',
    'suit',
    'jacket',
    'coat',
    'hat',
    'shoes',
    'boots',
    // Review/critic opinion adjectives
    'thoughtful',
    'imaginative',
    'inspirational',
    'inspiring',
    'beautiful',
    'stunning',
    'gorgeous',
    'breathtaking',
    'moving',
    'touching',
    'heartwarming',
    'heartbreaking',
    'gripping',
    'riveting',
    'compelling',
    'captivating',
    'fascinating',
    'intriguing',
    'entertaining',
    'enjoyable',
    'fun',
    'funny',
    'hilarious',
    'witty',
    'clever',
    'smart',
    'brilliant',
    'masterful',
    'impressive',
    'remarkable',
    'outstanding',
    'excellent',
    'superb',
    'wonderful',
    'amazing',
    'incredible',
    'fantastic',
    'terrific',
    'great',
    'good',
    'nice',
    'decent',
    'solid',
    'strong',
    'powerful',
    'intense',
    'dark',
    'light',
    'heavy',
    'slow',
    'fast',
    'quick',
    'long',
    'short',
    'big',
    'small',
    'new',
    'old',
    'young',
    'modern',
    'classic',
    'original',
    'unique',
    'different',
    'special',
    'interesting',
    'boring',
    'dull',
    'tedious',
    'predictable',
    'surprising',
    'unexpected',
    'shocking',
    'disturbing',
    'unsettling',
    'creepy',
    'eerie',
    'atmospheric',
    'moody',
    'stylish',
    'visually-stunning',
    'well-acted',
    'well-written',
    'well-directed',
    'well-made',
    'well-crafted',
    'underrated',
    'overrated',
    'must-watch',
    'must-see',
    'recommended',
    'worth-watching',
    // Trivia/meta tags
    'woman-director',
    'female-director',
    'male-director',
    'debut-film',
    'directorial-debut',
    'first-film',
    'last-film',
    'final-film',
    'posthumous',
    'oscar-winner',
    'oscar-nominated',
    // Random professions that leak in
    'engineer',
    'accountant',
    'lawyer',
    'doctor',
    'nurse',
    'teacher',
    'professor',
    'student',
    'businessman',
    'businesswoman',
    'secretary',
    'receptionist',
    'janitor',
    'waiter',
    'waitress',
    'bartender',
    'chef',
    'cook',
    'driver',
    'pilot',
    'mechanic',
    'plumber',
    'electrician',
    'carpenter',
    'farmer',
    'fisherman',
    'miner',
    'factory-worker',
    'office-worker',
    'salesman',
    'saleswoman',
    'clerk',
    'cashier',
    'banker',
    'realtor',
    'journalist',
    'reporter',
    'photographer',
    'artist',
    'musician',
    'actor',
    'actress',
    'singer',
    'dancer',
    'writer',
    'author',
    'poet',
    'painter',
    'sculptor',
    'architect',
    // Note: "detective", "spy", "assassin", "soldier" are kept - they ARE plot-relevant
    // Crude/vulgar specific acts
    'masturbation',
    'masturbating',
    'urination',
    'urinating',
    'defecation',
    'defecating',
    'vomiting',
    'vomit',
    'farting',
    'fart',
    'burping',
    'burp',
    'spitting',
    'spit',
    'sneezing',
    'coughing',
    'sweating',
    'bleeding',
    'crying',
    'screaming',
    'yelling',
    'shouting',
    'whispering',
    'laughing',
    'smiling',
    'frowning',
    'winking',
    // Documentary style descriptors
    'informative',
    'educational',
    'reenactment',
    'reenactments',
    'dramatization',
    'dramatized',
    'docudrama',
    'mockumentary',
    'found-footage',
    'interview',
    'interviews',
    'talking-head',
    'talking-heads',
    'narrator',
    'narration',
    'voice-over',
    'voiceover',
    'reality-tv',
    'reality-show',
    'reality-television',
    'scripted-reality',
    'unscripted',
    'game-show',
    'talk-show',
    'variety-show',
    'competition',
    'contest',
    // Redundant temporal markers
    '21st-century',
    '20th-century',
    '19th-century',
    'contemporary',
    'present-day',
    'modern-day',
    'current',
    // Specific animals (too granular for semantic search)
    'yak',
    'moose',
    'shrew',
    'sloth',
    'otter',
    'beaver',
    'badger',
    'raccoon',
    'squirrel',
    'chipmunk',
    'hamster',
    'gerbil',
    'guinea-pig',
    'rabbit',
    'bunny',
    'hare',
    'deer',
    'elk',
    'buffalo',
    'bison',
    'gazelle',
    'antelope',
    'giraffe',
    'zebra',
    'hippo',
    'hippopotamus',
    'rhino',
    'rhinoceros',
    'elephant',
    'lion',
    'tiger',
    'leopard',
    'cheetah',
    'jaguar',
    'panther',
    'cougar',
    'puma',
    'lynx',
    'bobcat',
    'fox',
    'wolf',
    'coyote',
    'bear',
    'polar-bear',
    'grizzly',
    'koala',
    'kangaroo',
    'wombat',
    'platypus',
    'penguin',
    'seal',
    'walrus',
    'whale',
    'dolphin',
    'shark',
    'octopus',
    'squid',
    'jellyfish',
    'crab',
    'lobster',
    'shrimp',
    'clam',
    'oyster',
    'snail',
    'slug',
    'worm',
    'caterpillar',
    'butterfly',
    'moth',
    'bee',
    'wasp',
    'ant',
    'spider',
    'scorpion',
    'beetle',
    'fly',
    'mosquito',
    'frog',
    'toad',
    'lizard',
    'gecko',
    'iguana',
    'chameleon',
    'snake',
    'cobra',
    'python',
    'crocodile',
    'alligator',
    'turtle',
    'tortoise',
    'eagle',
    'hawk',
    'falcon',
    'owl',
    'crow',
    'raven',
    'sparrow',
    'robin',
    'pigeon',
    'dove',
    'parrot',
    'flamingo',
    'peacock',
    'swan',
    'goose',
    'duck',
    'chicken',
    'rooster',
    'turkey',
    'pig',
    'boar',
    'cow',
    'bull',
    'ox',
    'sheep',
    'lamb',
    'goat',
    'horse',
    'pony',
    'donkey',
    'mule',
    'camel',
    'llama',
    'alpaca',
    'monkey',
    'ape',
    'gorilla',
    'chimpanzee',
    'orangutan',
    'baboon',
    'lemur',
    'bat',
    'mouse',
    'rat',
    'mole',
    'hedgehog',
    'porcupine',
    // Note: Keep "dog" and "cat" as they're often thematic (e.g., "dog movie", "cat lover")
    // Ironic/sarcastic user tags
    'comforting',
    'cozy',
    'relaxing',
    'calming',
    'soothing',
    'feel-good',
    'uplifting',
    'wholesome',
    'family-friendly',
    'kid-friendly',
    'safe',
    'gentle',
    'sweet',
    'cute',
    'adorable',
    'charming',
    'delightful',
    'pleasant',
    'lovely',
    // Spoiler/micro-detail body parts
    'amputation',
    'amputee',
    'prosthetic',
    'wheelchair',
    'blind',
    'deaf',
    'mute',
    // Singular religious terms out of context
    'god',
    'gods',
    'goddess',
    'deity',
    'divine',
    'holy',
    'sacred',
    'blessed',
    'prayer',
    'praying',
    'temple',
    'mosque',
    'synagogue',
    // Note: Keep "religion", "religious", "faith", "spiritual" as they can be thematic
    // Car brands (exact-match only; substring car brands handled by regex below)
    'bmw',
    'audi',
    'tesla',
    'ford',
    'chevy',
    'dodge',
    'toyota',
    'honda',
    'nissan',
    'mazda',
    'subaru',
    'volkswagen',
    'volvo',
    'jeep',
    'hummer',
    'cadillac',
    'lincoln',
    'buick',
    'pontiac',
    'oldsmobile',
    // Medical objects/treatments
    'insulin',
    'syringe',
    'needle',
    'pill',
    'pills',
    'medication',
    'medicine',
    'prescription',
    'surgery',
    'operation',
    'bandage',
    'cast',
    'crutches',
    'iv',
    'catheter',
    'x-ray',
    'mri',
    'ct-scan',
    'blood-test',
    'transfusion',
    'transplant',
    'chemotherapy',
    'radiation',
    // Note: Keep conditions like "diabetes", "cancer", "alzheimer's" as they can drive plot
    // Cities/towns (exact-match; kept as Set to avoid false regex anchoring)
    'biarritz',
    'aspen',
    'vail',
    'monaco',
    'monte-carlo',
    'st-tropez',
    'marseille',
    'lyon',
    'bordeaux',
    'toulouse',
    'nantes',
    'strasbourg',
    'lille',
    'munich',
    'frankfurt',
    'hamburg',
    'cologne',
    'dusseldorf',
    'stuttgart',
    'milan',
    'rome',
    'naples',
    'florence',
    'genoa',
    'turin',
    'barcelona',
    'madrid',
    'valencia',
    'seville',
    'malaga',
    'bilbao',
    'amsterdam',
    'rotterdam',
    'brussels',
    'antwerp',
    'zurich',
    'geneva',
    'vienna',
    'prague',
    'budapest',
    'warsaw',
    'krakow',
    'stockholm',
    'oslo',
    'copenhagen',
    'helsinki',
    'dublin',
    'edinburgh',
    'glasgow',
    'manchester',
    'birmingham',
    'liverpool',
    'leeds',
    'bristol',
    'sydney',
    'melbourne',
    'brisbane',
    'perth',
    'auckland',
    'wellington',
    'toronto',
    'vancouver',
    'montreal',
    'calgary',
    'ottawa',
    'mexico-city',
    'cancun',
    'rio',
    'sao-paulo',
    'buenos-aires',
    'bogota',
    'lima',
    'santiago',
    'seoul',
    'osaka',
    'kyoto',
    'beijing',
    'shanghai',
    'hong-kong',
    'singapore',
    'bangkok',
    'mumbai',
    'delhi',
    'dubai',
    'tel-aviv',
    'cairo',
    'johannesburg',
    'cape-town',
    // Note: Keep major plot-relevant cities like "new-york", "los-angeles", "london", "paris", "tokyo" in stem mappings
    // Source metadata
    'book',
    'novel',
    'short-story',
    'comic',
    'comic-book',
    'graphic-novel',
    'manga',
    'video-game',
    'board-game',
    'true-story',
    'real-events',
    'biographical',
    // Sociological/academic terms
    'future-shock',
    'culture-shock',
    'paradigm-shift',
    'social-commentary',
    'political-commentary',
    'satire',
    // Specific medical procedures
    'plastic-surgery',
    'cosmetic-surgery',
    'face-lift',
    'facelift',
    'nose-job',
    'rhinoplasty',
    'liposuction',
    'botox',
    'breast-augmentation',
    'breast-reduction',
    'tummy-tuck',
    'appendectomy',
    'tonsillectomy',
    'hysterectomy',
    'vasectomy',
    'colonoscopy',
    'endoscopy',
    'biopsy',
    'dialysis',
    'physical-therapy',
    'physiotherapy',
    'rehabilitation',
    'therapy',
    'counseling',
    'psychiatry',
    'psychology',
    // Generic crime/legal terms
    'blood',
    'danger',
    'suspect',
    'suspects',
    'criminal',
    'criminals',
    'judge',
    'judges',
    'trial',
    'trials',
    'court',
    'courtroom',
    'verdict',
    'jury',
    'evidence',
    'clue',
    'clues',
    'witness',
    'witnesses',
    'testimony',
    'arrest',
    'arrested',
    'handcuffs',
    'interrogation',
    'confession',
    'guilty',
    'innocent',
    'conviction',
    'sentence',
    'sentencing',
    'prosecution',
    'prosecutor',
    'defense',
    'defendant',
    'plaintiff',
    'lawsuit',
    'legal',
    'attorney',
    'solicitor',
    'barrister',
    'case',
    'cases',
    'crime-scene',
    'forensic',
    'forensics',
    'autopsy',
    'morgue',
    'coroner',
    'medical-examiner',
    'lab',
    'laboratory',
    'dna',
    'fingerprint',
    'fingerprints',
    'ballistics',
    // Generic action terms
    'action',
    'adventure',
    'excitement',
    'thrilling',
    'suspense',
    'suspenseful',
    'tension',
    'tense',
    'dramatic',
    'drama',
    // Action hero clichés
    'tough-guy',
    'tough',
    'badass',
    'bad-ass',
    'one-man-army',
    'lone-wolf',
    'anti-hero',
    'antihero',
    'reluctant-hero',
    'unlikely-hero',
    'vigilante',
    'maverick',
    'rogue',
    'rebel',
    'outcast',
    'underdog',
    'loner',
    'brooding',
    'stoic',
    'grizzled',
    'hardened',
    'battle-hardened',
    'war-veteran',
    'ex-military',
    'ex-cop',
    'ex-soldier',
    'ex-marine',
    'ex-special-forces',
    // Specific scene/event descriptors
    'birthday-party',
    'birthday',
    'wedding',
    'funeral',
    'graduation',
    'christmas-party',
    'dinner-party',
    'house-party',
    'pool-party',
    'private-lessons',
    'private-lesson',
    'tutoring',
    'tutor',
    // Generic emotions
    'jealousy',
    'jealous',
    'envy',
    'envious',
    'anger',
    'angry',
    'sadness',
    'sad',
    'happiness',
    'happy',
    'loneliness',
    'lonely',
    'guilt',
    'shame',
    'ashamed',
    'regret',
    'remorse',
    'grief',
    'grieving',
    'sorrow',
    'despair',
    'hopelessness',
    'frustration',
    'frustrated',
    'anxiety',
    'anxious',
    'nervous',
    'worried',
    'worry',
    'stressed',
    'stress',
    'confusion',
    'confused',
    'disappointment',
    'disappointed',
    'resentment',
    'bitterness',
    'bitter',
    // Internal database flags/ratings
    'parental-guide',
    'age-rating',
    'content-rating',
    'viewer-discretion',
    'kid-safe',
    'child-safe',
    'pg-rated',
    'r-rated',
    'g-rated',
    'nc-17',
    'tv-ma',
    'tv-14',
    'tv-pg',
    'tv-g',
    'tv-y',
    'tv-y7',
    // Specific weapon models/types
    'ak-47',
    'ak47',
    'm-16',
    'm16',
    'ar-15',
    'ar15',
    'uzi',
    'glock',
    'beretta',
    'colt',
    'remington',
    'winchester',
    'smith-and-wesson',
    'magnum',
    'revolver',
    'shotgun',
    'rifle',
    'pistol',
    'handgun',
    'machine-gun',
    'submachine-gun',
    'sniper-rifle',
    'assault-rifle',
    'silencer',
    'suppressor',
    'holster',
    'ammunition',
    'ammo',
    'bullet',
    'bullets',
    'cartridge',
    'grenade',
    'rocket-launcher',
    'bazooka',
    'rpg',
    'missile',
    'bomb',
    'explosive',
    'dynamite',
    'c4',
    'detonator',
    // Minor character professions
    'inventor',
    'scientist',
    'researcher',
    'librarian',
    'mailman',
    'postman',
    'delivery-man',
    'shopkeeper',
    'store-owner',
    'landlord',
    'tenant',
    'neighbor',
    'neighbour',
    'coworker',
    'colleague',
    'classmate',
    'roommate',
    'housemate',
    // Venice / Nice / Cannes appear in both city and festival lists — consolidated here
    'venice',
    'nice',
    'cannes',
]);

/**
 * Regex patterns to exclude from embeddings — genuine wildcards that cannot be reduced to
 * a simple Set lookup (contain anchors with quantifiers, alternation, or suffix/prefix matching).
 */
const EXCLUDED_KEYWORD_REGEX: RegExp[] = [
    // Physical formats (any resolution + blu-ray/dvd)
    /^\d+k$/i, // 2k, 4k, 8k
    /^\d+k[- ]blu[- ]?ray$/i, // 2k blu ray, 4k-blu-ray, etc
    /blu[- ]?ray/i, // blu-ray, bluray, blu ray
    /^hd[- ]?dvd$/i,
    /ultra[- ]?hd/i,
    /^\d+p$/i, // 720p, 1080p, 2160p
    // Aspect ratios / presentation
    /pan-and-scan/i,
    /^\d+mm$/i, // 35mm, 70mm
    /^\d+-\d+-\d+$/i, // aspect ratios: 1-85-1, 2-35-1, etc.
    /^\d+\.\d+:\d+$/i, // aspect ratios: 1.85:1, 2.35:1
    // Distribution/release
    /^theatrical(-cut)?$/i,
    /director'?s?-?cut/i,
    /extended-?cut/i,
    /special-?edition/i,
    /collector'?s?-?edition/i,
    /^remaster(ed)?$/i,
    // Technical audio
    /^dolby(-atmos)?$/i,
    /surround-?sound/i,
    // Non-semantic meta tags
    /credits?[- ]?stinger/i,
    /^post[- ]?credits$/i,
    /^has[- ]?trailer$/i,
    // Platform/streaming tags
    /netflix-original/i,
    /amazon-original/i,
    /hulu-original/i,
    /disney-original/i,
    /apple-original/i,
    /hbo-original/i,
    /max-original/i,
    /peacock-original/i,
    /paramount-original/i,
    /prime-video/i,
    /^original-?series$/i,
    /^original-?film$/i,
    // Content warnings / MPAA descriptors (not semantic themes)
    /nudity/i, // nudity, female-nudity, male-nudity, brief-nudity
    /topless/i, // female-topless-nudity, topless
    /see-?through/i, // see-through-bra, see-through-clothing
    /\bsex\b/i, // interrupted-sex, sex-scene, etc
    /\bf-word\b/i,
    /\bs-word\b/i,
    /\bc-word\b/i,
    /\bn-word\b/i,
    /profanity/i,
    /strong-language/i,
    /language/i, // "crude-language", "sexual-language"
    /graphic-violence/i,
    /gore\b/i,
    /blood-and-gore/i,
    /sexual-content/i,
    /explicit/i,
    /adult-content/i,
    /violence/i, // violence, gun-violence, etc (too generic)
    /drug-use/i,
    /smoking/i,
    /drinking/i,
    /alcohol/i,
    // Generic/unhelpful
    /^based-on/i, // "based-on-novel" etc - too generic
    /^feature-?film$/i,
    /^motion-?picture$/i,
    /^hollywood$/i,
    /^independent-film$/i,
    /^indie$/i,
    // Scraper artifacts (cameos, fragments, metadata noise)
    /-character$/i, // "larry-king-character", "stan-lee-character" - cameos, not themes
    /^rotten$/i, // fragment from "Rotten Tomatoes"
    /^tomatoes$/i,
    /^fresh$/i, // Rotten Tomatoes "fresh" rating
    /^certified-?fresh$/i,
    /^imdb$/i,
    /^tmdb$/i,
    /^letterboxd$/i,
    /^metacritic$/i,
    /metacritic-must-see/i, // review artifact
    /^trakt$/i,
    /reference-to-/i, // "reference-to-star-wars" - too meta
    /cameo$/i, // "celebrity-cameo"
    /^uncredited$/i,
    /^archive-footage$/i,
    /^stock-footage$/i,
    /box-?office/i, // "box-office-hit", "box-office-bomb"
    /^award-?winning$/i,
    /^critically-?acclaimed$/i,
    // Format/medium tags (not story themes)
    /^live-?action$/i,
    // Genre labels that leak into keywords
    /^slice-?of-?life$/i,
    // Self-referential/franchise tags
    /^one-?piece$/i, // title of the show
    /^dc-?comics$/i,
    // NOTE: disney and pixar are NOT excluded - they're meaningful for user preference tracking
    /^star-?wars$/i,
    /^star-?trek$/i,
    /^harry-?potter$/i,
    /^lord-?of-?the-?rings$/i,
    /^game-?of-?thrones$/i,
    /belongs-to-collection/i, // meta tag from TMDB
    // Database/scraper slugs
    /movie-in-title/i, // scraper artifact
    /-in-title$/i, // "number-in-title", "year-in-title"
    /number-\d+-in-title/i,
    // Visual/physical descriptors
    /bare-?chested/i, // bare-chested-male, bare-chested-female
    /shirtless/i,
    /^tank-?top$/i,
    /^cell-?phone$/i,
    /-scene$/i, // dance-scene, fight-scene, sex-scene, etc
    /undress/i, // undressing, man-undresses, woman-undresses
    // Strip/dance performance descriptors
    /strip-?club/i,
    /strip-?tease/i,
    /strip-?show/i,
    /strip-?dance/i,
    /pole-?danc/i,
    /lap-?dance/i,
    // Overly specific action descriptors
    /throwing-.*-out/i, // throwing-a-cell-phone-out-a-car-window
    /obscene-?gesture/i,
    /hand-?gesture/i,
    /middle-?finger/i,
    // Generic dance tags (keep specific dance forms like "ballet")
    /^danc(e|ing)$/i,
    // Corporate/studio branding in keywords
    /disney-animated/i, // disney-animated-sequel, disney-animated-feature
    /pixar-animated/i,
    /dreamworks-animated/i,
    /-sequel$/i, // disney-animated-sequel, action-sequel
    /-prequel$/i,
    /-reboot$/i,
    /-remake$/i,
    /-spinoff$/i,
    /-franchise$/i,
    // Technical animation format tags
    /^cgi-animation$/i,
    /^3d-animation$/i,
    /^2d-animation$/i,
    /^stop-?motion$/i,
    /^motion-?capture$/i,
    /^computer-animated$/i,
    /^hand-?drawn$/i,
    // Trivia/meta tags
    /\bword-title$/i, // four-word-title, one-word-title, etc.
    /^academy-award/i,
    /^emmy/i,
    /^golden-globe/i,
    /^sundance/i,
    /^berlin/i,
    /^tribeca/i,
    // Technical format tags (animation/live-action combos)
    /live-action-and-animation/i,
    /animation-and-live-action/i,
    /live-action-animation/i,
    /mixed-media/i,
    /hybrid-animation/i,
    // Decade spam (when show aired, not setting)
    /^1\d{3}s$/i, // 1990s, 1980s, etc.
    /^2\d{3}s$/i, // 2000s, 2010s, 2020s, etc.
    /^19\d{2}$/i, // specific years: 1990, 1985, etc.
    /^20\d{2}$/i, // specific years: 2000, 2015, etc.
    /^mid-\d+s$/i, // mid-90s, mid-2000s
    /^early-\d+s$/i, // early-90s
    /^late-\d+s$/i, // late-90s
    // Documentary style descriptors
    /docuseries/i,
    // Technical format tags (video/audio)
    /^dolby/i, // dolby-vision, dolby-atmos, dolby-digital
    /^hdr/i, // hdr, hdr10, hdr10+
    /^dts/i,
    // Spoiler/micro-detail body parts
    /loss-of-/i, // loss-of-arm, loss-of-leg, loss-of-eye
    /missing-/i, // missing-arm, missing-leg
    // Specific car models/brands (substring patterns)
    /corvette/i,
    /stingray/i,
    /mustang$/i, // Ford Mustang (but keep "mustang" as horse type is already filtered)
    /camaro/i,
    /challenger/i,
    /charger/i,
    /ferrari/i,
    /lamborghini/i,
    /porsche/i,
    /mercedes/i,
    /maserati/i,
    /bugatti/i,
    /chevrolet/i,
    /delorean/i,
    // Location duplicates with country suffix
    /-turkey$/i, // istanbul-turkey -> just keep Istanbul
    /-france$/i, // paris-france -> just keep Paris
    /-germany$/i,
    /-italy$/i,
    /-spain$/i,
    /-japan$/i,
    /-china$/i,
    /-russia$/i,
    /-usa$/i,
    /-uk$/i,
    /-england$/i,
    // Location duplicates with state/region suffix (e.g., los-angeles-california)
    /-california$/i,
    /-new-york$/i,
    /-texas$/i,
    /-florida$/i,
    /-nevada$/i,
    // "Based on..." metadata (not thematic)
    /^adapted-from/i,
    /^adaptation-of/i,
    /^inspired-by/i,
    /^remake-of/i,
    /^reboot-of/i,
    /^sequel-to/i,
    /^prequel-to/i,
    /^spinoff-of/i,
    // Internal database flags/ratings
    /common-sense/i, // common-sense-selection, common-sense-media
];

// STEM_MAPPINGS and extractSemanticRoot are now imported from keyword-stems.ts

/**
 * Normalize a keyword for deduplication:
 * - lowercase
 * - replace hyphens with spaces
 * - trim whitespace
 * This ensures "sexual abuse" and "sexual-abuse" are treated as the same
 */
function normalizeKeywordForDedup(keyword: string): string {
    return keyword.toLowerCase().replace(/-/g, ' ').trim();
}

/**
 * Filter out format/distribution keywords that don't describe story content
 * Also deduplicates keywords using:
 * 1. Exact dedup (hyphens -> spaces): "sexual-abuse" = "sexual abuse"
 * 2. Stem-based dedup: "mysterious-girl" + "mysterious-past" + "mysteries" -> keep one
 */
export function filterKeywords(keywords: string[]): string[] {
    const seenExact = new Set<string>();
    const seenStems = new Set<string>();
    const result: string[] = [];

    // First pass: collect all keywords that pass exclusion filters
    const candidates: Array<{
        original: string;
        normalized: string;
        stem: string;
    }> = [];

    for (const keyword of keywords) {
        const normalized = keyword.toLowerCase().trim();
        // Also create hyphenated version for pattern matching (MDBList uses spaces, patterns use hyphens)
        const hyphenated = normalized.replace(/\s+/g, '-');

        // Skip if it matches an exclusion pattern.
        // O(1) Set lookup first, then regex scan of the (much smaller) regex array.
        if (
            EXCLUDED_KEYWORDS_EXACT.has(normalized) ||
            EXCLUDED_KEYWORDS_EXACT.has(hyphenated) ||
            EXCLUDED_KEYWORD_REGEX.some(
                (pattern) => pattern.test(normalized) || pattern.test(hyphenated),
            )
        ) {
            continue;
        }

        const dedupKey = normalizeKeywordForDedup(keyword);
        const stem = extractSemanticRoot(keyword);

        candidates.push({ original: keyword, normalized: dedupKey, stem });
    }

    // Sort by length (shorter = more likely the canonical form)
    // "mystery" before "mysterious-girl"
    candidates.sort((a, b) => a.normalized.length - b.normalized.length);

    // Second pass: keep only unique keywords by stem
    for (const { original, normalized, stem } of candidates) {
        // Skip exact duplicates
        if (seenExact.has(normalized)) {
            continue;
        }

        // Skip if we already have a keyword with this stem
        if (seenStems.has(stem)) {
            continue;
        }

        seenExact.add(normalized);
        seenStems.add(stem);
        result.push(original);
    }

    return result;
}

// Label mappings
const LABELS = {
    en: {
        title: 'Title',
        plot: 'Plot',
        genre: 'Genre',
        details: 'Details',
        director: 'Director',
        actors: 'Cast',
        keywords: 'Themes',
        anime: 'Anime',
        animeGenres: 'Anime Genres',
    },
};

/**
 * Build the consolidated Details line with Rating (IMDB), Certification, and Runtime
 * Example: "Details: IMDB 5.7/10, PG-13, Runtime: 93 min"
 */
function buildDetailsLine(input: EmbeddingTextInput, labels: typeof LABELS.en): string | null {
    const parts: string[] = [];

    // Rating (IMDB or fallback to TMDB) - always first
    const rating = input.imdbRating ?? input.tmdbRating;
    if (rating && rating > 0) {
        parts.push(`IMDB ${Number(rating).toFixed(1)}/10`);
    }

    // Certification - second
    if (input.certification?.trim()) {
        parts.push(input.certification.trim());
    }

    // Runtime - last
    if (input.runtimeMinutes && input.runtimeMinutes > 0) {
        parts.push(`Runtime: ${input.runtimeMinutes} min`);
    }

    if (parts.length === 0) return null;

    return `${labels.details}: ${parts.join(', ')}`;
}

/**
 * Create clean, natural language embedding text
 *
 * Output format example:
 * ```
 * Title: The Stepford Wives (2004)
 * Plot: Joanna and Walter Eberhart move from Manhattan...
 * Themes: Android, Housewife, Transformation, Suburb, Battle of the Sexes
 * Genre: Comedy, Science Fiction, Horror
 * Director: Frank Oz
 * Cast: Nicole Kidman, Matthew Broderick, Bette Midler, Glenn Close
 * Details: IMDB 5.7/10, PG-13, Runtime: 93 min
 * ```
 *
 * REMOVED from embeddings (noise for semantic search):
 * - Studios, Networks, Countries, Writers (business/production metadata)
 * - Scraper artifacts like "larry-king-character", "rotten"
 * - Duplicate keywords (sexual-abuse vs sexual abuse)
 */
export function formatEmbeddingText(
    input: EmbeddingTextInput,
    options: EmbeddingTextOptions = {},
): string {
    const opts = { ...DEFAULT_OPTIONS, ...options };
    const labels = LABELS.en;
    const lines: string[] = [];

    // Title with year (always first)
    const titleLine = input.year
        ? `${labels.title}: ${input.title} (${input.year})`
        : `${labels.title}: ${input.title}`;
    lines.push(titleLine);

    // Overview/Plot (the most important semantic content)
    if (input.overview?.trim()) {
        lines.push(`${labels.plot}: ${input.overview.trim()}`);
    }

    // Keywords/Themes BEFORE genre (most semantically important for similarity)
    // Filter out format/distribution keywords and deduplicate
    if (input.keywords?.length) {
        const filteredKeywords = filterKeywords(input.keywords).slice(0, opts.maxKeywords);
        if (filteredKeywords.length > 0) {
            lines.push(`${labels.keywords}: ${filteredKeywords.join(', ')}`);
        }
    }

    // Genres (merged with anime genres if present, filter out undefined/empty)
    const allGenres = [...(input.genres || [])].filter((g): g is string => !!g);
    if (input.animeGenres?.length) {
        // Merge anime genres into main genre list, avoiding duplicates
        for (const animeGenre of input.animeGenres) {
            if (!animeGenre) continue;
            const normalized = animeGenre.toLowerCase();
            const isDuplicate = allGenres.some((g) => g.toLowerCase() === normalized);
            if (!isDuplicate) {
                allGenres.push(animeGenre);
            }
        }
    }
    if (allGenres.length > 0) {
        lines.push(`${labels.genre}: ${allGenres.join(', ')}`);
    }

    // Director
    if (input.directors?.length) {
        const dirLabel = input.directors.length === 1 ? labels.director : 'Directors';
        lines.push(`${dirLabel}: ${input.directors.slice(0, 3).join(', ')}`);
    }

    // Cast
    if (input.actors?.length) {
        lines.push(`${labels.actors}: ${input.actors.slice(0, opts.maxActors).join(', ')}`);
    }

    // Details line at the END (consolidated: Rating, Certification, Runtime)
    if (opts.includeRatings) {
        const detailsLine = buildDetailsLine(input, labels);
        if (detailsLine) {
            lines.push(detailsLine);
        }
    }

    // Note: Anime genres are now merged into the main Genre field above
    // The isAnime flag is still available for other purposes if needed

    // Join with newlines for natural language structure
    return lines.join('\n');
}

/**
 * Convert library movie data to embedding text input format
 */
export function libraryToEmbeddingInput(movie: {
    Name?: string;
    ProductionYear?: number;
    Overview?: string;
    GenreItems?: Array<{ Name: string }>;
    Genres?: string[];
    RunTimeTicks?: number;
    CommunityRating?: number;
    CriticRating?: number;
    OfficialRating?: string;
    People?: Array<{ Name: string; Type: string }>;
}): EmbeddingTextInput {
    // Extract cast and crew from People array (filter out undefined/empty names)
    const directors =
        movie.People?.filter((p) => p.Type === 'Director' && p.Name)
            .map((p) => p.Name)
            .slice(0, 3) || [];

    const actors =
        movie.People?.filter((p) => p.Type === 'Actor' && p.Name)
            .map((p) => p.Name)
            .slice(0, 8) || [];

    const writers =
        movie.People?.filter((p) => (p.Type === 'Writer' || p.Type === 'Screenplay') && p.Name)
            .map((p) => p.Name)
            .slice(0, 3) || [];

    const producers =
        movie.People?.filter((p) => p.Type === 'Producer' && p.Name)
            .map((p) => p.Name)
            .slice(0, 3) || [];

    // Extract genres (filter out undefined/empty names)
    const genres =
        movie.GenreItems?.map((g) => g.Name).filter((name): name is string => !!name) ||
        movie.Genres?.filter(Boolean) ||
        [];

    // Calculate runtime in minutes
    const runtimeMinutes = movie.RunTimeTicks ? Math.round(movie.RunTimeTicks / 600000000) : null;

    return {
        title: movie.Name || 'Unknown',
        year: movie.ProductionYear,
        overview: movie.Overview,
        genres,
        runtimeMinutes,
        tmdbRating: movie.CommunityRating,
        rtCriticsScore: movie.CriticRating,
        certification: movie.OfficialRating,
        directors,
        actors,
        writers,
        producers,
    };
}

/**
 * Convert discovery/TMDB movie data to embedding text input format
 */
export function discoveryToEmbeddingInput(movie: {
    title?: string;
    name?: string;
    releaseDate?: string;
    first_air_date?: string;
    overview?: string;
    genres?: Array<{ id: number; name: string }>;
    runtime?: number;
    voteAverage?: number;
    mediaType?: 'movie' | 'tv';
    networks?: Array<{ name: string }>;
    productionCompanies?: Array<{ name: string }>;
    productionCountries?: Array<{ name: string; iso_3166_1?: string }>;
    spokenLanguages?: Array<{ name: string; iso_639_1?: string }>;
    keywords?: Array<{ name: string }>;
    cast?: Array<{ name: string; order?: number }>;
    crew?: Array<{ name: string; job: string }>;
    releaseDates?: {
        results: Array<{
            iso_3166_1: string;
            release_dates: Array<{ certification: string }>;
        }>;
    };
    // MDBList enrichment
    letterboxd_rating?: number;
    rt_rating?: number;
    rt_audience_score?: number;
    trakt_score?: number;
    metacritic_score?: number;
    mdblist_score?: number;
    mdblist_keywords?: string[];
    mal_score?: number;
    streaming_services?: string[];
}): EmbeddingTextInput {
    // Parse year from release date
    const releaseDate = movie.releaseDate || movie.first_air_date;
    const year = releaseDate ? new Date(releaseDate).getFullYear() : null;

    // Extract genres (filter out undefined/empty names)
    const genres = movie.genres?.map((g) => g.name).filter((name): name is string => !!name) || [];

    // Extract directors (filter out undefined/empty names)
    const directors =
        movie.crew
            ?.filter((c) => c.job === 'Director' && c.name)
            .map((c) => c.name)
            .slice(0, 3) || [];

    // Extract actors (sorted by billing order, filter out undefined/empty names)
    // Use ?? instead of || to correctly handle order: 0 (lead actor)
    const actors =
        movie.cast
            ?.filter((c) => c.name)
            .sort((a, b) => (a.order ?? 999) - (b.order ?? 999))
            .map((c) => c.name)
            .slice(0, 8) || [];

    // Extract writers (filter out undefined/empty names)
    const writers =
        movie.crew
            ?.filter(
                (c) =>
                    (c.job === 'Writer' || c.job === 'Screenplay' || c.job === 'Story') && c.name,
            )
            .map((c) => c.name)
            .slice(0, 3) || [];

    // Extract producers (filter out undefined/empty names)
    const producers =
        movie.crew
            ?.filter((c) => (c.job === 'Producer' || c.job === 'Executive Producer') && c.name)
            .map((c) => c.name)
            .slice(0, 3) || [];

    // Networks (for TV, filter out undefined/empty names)
    const networks =
        movie.networks?.map((n) => n.name).filter((name): name is string => !!name) || [];

    // Studios (filter out undefined/empty names)
    const studios =
        movie.productionCompanies?.map((c) => c.name).filter((name): name is string => !!name) ||
        [];

    // Countries (filter out undefined/empty names)
    const countries =
        movie.productionCountries?.map((c) => c.name).filter((name): name is string => !!name) ||
        [];

    // Languages (filter out undefined/empty names)
    const languages =
        movie.spokenLanguages?.map((l) => l.name).filter((name): name is string => !!name) || [];

    // Keywords (combine TMDB + MDBList, filter out undefined/empty)
    const allKeywords = new Set<string>();
    movie.keywords?.forEach((k) => k.name && allKeywords.add(k.name));
    movie.mdblist_keywords?.forEach((k) => k && allKeywords.add(k));
    const keywords = Array.from(allKeywords);

    // Get US certification
    let certification: string | null = null;
    if (movie.releaseDates?.results) {
        const usRelease = movie.releaseDates.results.find((r) => r.iso_3166_1 === 'US');
        certification = usRelease?.release_dates?.[0]?.certification || null;
    }

    // Check if anime (based on genres or MAL score)
    const isAnime = genres.some(
        (g) =>
            g.toLowerCase() === 'animation' &&
            (movie.productionCountries?.some((c) => c.iso_3166_1 === 'JP') || movie.mal_score),
    );

    return {
        title: movie.title || movie.name || 'Unknown',
        year: year && !isNaN(year) ? year : null,
        overview: movie.overview,
        genres,
        runtimeMinutes: movie.runtime,
        tmdbRating: movie.voteAverage,
        letterboxdRating: movie.letterboxd_rating,
        rtCriticsScore: movie.rt_rating,
        rtAudienceScore: movie.rt_audience_score,
        traktScore: movie.trakt_score,
        metacriticScore: movie.metacritic_score,
        mdblistScore: movie.mdblist_score,
        malScore: movie.mal_score,
        mediaType: movie.mediaType,
        directors,
        actors,
        writers,
        producers,
        networks,
        studios,
        countries,
        languages,
        keywords,
        certification,
        isAnime,
    };
}

/**
 * Create library embedding text
 */
export function createLibraryEmbeddingText(
    movie: Parameters<typeof libraryToEmbeddingInput>[0],
): string {
    const input = libraryToEmbeddingInput(movie);
    return formatEmbeddingText(input, {
        includeRatings: true,
        maxActors: 5,
        maxKeywords: 10,
    });
}

/**
 * Create discovery/TMDB embedding text (comprehensive metadata)
 */
export function createDiscoveryEmbeddingText(
    movie: Parameters<typeof discoveryToEmbeddingInput>[0],
): string {
    const input = discoveryToEmbeddingInput(movie);
    return formatEmbeddingText(input, {
        includeRatings: true,
        maxActors: 6,
        maxKeywords: 15,
    });
}
