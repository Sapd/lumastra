// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Channel genre: the category a channel lands in.
 *
 * Providers group by country and bouquet ("SK • SLOVAKIA", "DE • Orb • Low
 * Quali", "PL FILMY i SERIALE", "EVENTS • GRD"), hundreds of groups for a large
 * list. Country is its own filter now (`channel-country.ts`), so the category
 * is the genre, read in the languages providers use:
 *
 *   1. adult / religious / 24/7 channels go to their own category;
 *   2. a genre named by the section or group-title ("Sport", "Filmy", "Детские");
 *   3. a strong genre word in the channel name ("Telesport 1", "LIVE EVENT 03");
 *   4. the group's own label without its country part ("DE • Orb • Low Quali"
 *      -> "Orb"), so a provider's bouquet groups ("Tukan Prime", "EIS2") stay;
 *   5. "General" when nothing is left ("SK • SLOVAKIA", "FHD+ HEVC & WebTV").
 */

import { MAX_LABEL, isAdultLabel, isLoopChannel, isReligiousLabel } from './channel-country.js';

export const GENRE = {
    adult: 'Adult',
    religious: 'Religious',
    loop: '24/7',
    events: 'Live Events',
    radio: 'Radio',
    shopping: 'Shopping',
    sports: 'Sports',
    kids: 'Kids',
    news: 'News',
    documentary: 'Documentary',
    music: 'Music',
    movies: 'Movies',
    series: 'Series',
    entertainment: 'Entertainment',
    freeTv: 'Free TV',
    general: 'General',
    regional: 'Regional',
} as const;

/** A word-ish match: the pattern must not sit inside a longer word. */
const w = (body: string): RegExp =>
    new RegExp(String.raw`(?:^|[^\p{L}\p{N}])(?:${body})(?![\p{L}\p{N}])`, 'iu');

/** Genre words in section and group labels — first match wins. */
const SECTION_RULES: ReadonlyArray<readonly [RegExp, string]> = [
    [w(String.raw`events?|ppv|pay[\s-]?per[\s-]?view|boxing|races?|replays?`), GENRE.events],
    [w(String.raw`radio|rádio|радио`), GENRE.radio],
    [w(String.raw`(?:tele|home)?shop\p{L}*`), GENRE.shopping],
    [
        w(
            String.raw`(?:euro|tele|e)?sports?\p{L}*|spor|спорт\p{L}*|\p{L}*liga|leagues?|calcio|football|fu(?:ss|ß)ball|soccer|formel\s?1|formula\s?1|f1|tennis|golf|wrestling|boks|boxen`,
        ),
        GENRE.sports,
    ],
    [
        w(
            String.raw`kids?|kinder|children|cartoons?|anime|bambini|enfants|çocuk|cocuk|bajki|dzieci\p{L}*|детск\p{L}*|copii|f[eë]mij[eë]t?|ragazzi|infantil|niños|kinderen|märchen|maerchen|kreskówki|bajki`,
        ),
        GENRE.kids,
    ],
    [
        w(
            String.raw`news|nachrichten|haber|новост\p{L}*|информацион\p{L}*|[sș]tiri|lajme|nouvelles|notizie|noticias|wiadomo\p{L}*|informacyjne`,
        ),
        GENRE.news,
    ],
    [
        w(
            String.raw`doku\p{L}*|docu\p{L}*|documentar\p{L}*|dokument\p{L}*|познавательн\p{L}*|belgesel|cultura|kultur|wissen|knowledge`,
        ),
        GENRE.documentary,
    ],
    [
        w(
            String.raw`music|musik|m[uü]zi[kğ]\p{L}*|muzica|muzy\p{L}*|musique|musica|muziek|музык\p{L}*`,
        ),
        GENRE.music,
    ],
    [
        w(
            String.raw`cinema|kino|кино\p{L}*|film\p{L}*|movies?|sinema|cine|pel[ií]culas?|korku|gerilim|horror|thriller`,
        ),
        GENRE.movies,
    ],
    [
        w(String.raw`series|serien|seriale|serial\p{L}*|сериал\p{L}*|dizi\p{L}*|sitcoms?`),
        GENRE.series,
    ],
    [
        w(
            String.raw`entertainments?|unterhaltung|entretenimiento|intrattenimento|divertis+e?ment|развлекательн\p{L}*|rozrywk\p{L}*|e[gğ]lence|lifestyle|stil de viata|reality|tv-shows|shows`,
        ),
        GENRE.entertainment,
    ],
    [w(String.raw`free\s?tv|öffentlich\p{L}*|offentlich\p{L}*`), GENRE.freeTv],
    [
        w(
            String.raw`general\p{L}*|génér\p{L}*|g[eé]n[eé]ral|allgemein|algemeen|gjeneral\p{L}*|og[oó]lne|основн\p{L}*|ulusal|genel|national`,
        ),
        GENRE.general,
    ],
    [w(String.raw`regional\p{L}*|regio|regiotv|regionaal|lokal`), GENRE.regional],
];

/**
 * Genre words strong enough in a channel name alone. Narrower than the section
 * rules ("radio" in a name can be a TV station's name). Generic words only:
 * no broadcaster, brand or league names in code.
 */
const NAME_RULES: ReadonlyArray<readonly [RegExp, string]> = [
    [w(String.raw`event|ppv`), GENRE.events],
    [w(String.raw`[^\p{L}\p{N}]vs\.?`), GENRE.events],
    [w(String.raw`(?:euro|tele|e)?sports?\p{L}*|spor|\p{L}*liga|f1`), GENRE.sports],
    [w(String.raw`kids?|kinder|junior|cartoons?|\p{L}*toons?|baby`), GENRE.kids],
    [w(String.raw`(?:euro)?news|nachrichten|haber`), GENRE.news],
    [
        w(
            String.raw`doku\p{L}*|docu\p{L}*|history|histoire|geschichte|nature|natur|wildlife|science|wissen`,
        ),
        GENRE.documentary,
    ],
    [w(String.raw`music|musik|m[uü]zi[kğ]\p{L}*|hits`), GENRE.music],
    [w(String.raw`cinema|kino|movies?|film`), GENRE.movies],
];

/** Words that say nothing about a group: quality, transport, filler. */
const NOISE_RE = w(
    String.raw`f?hd\+?|uhd|hdr|4k|sd|hevc|h\.?265|raw|hdraw|whdraw|web\s?tv|webtv|iptv|tv|mix|low|quali\p{L}*|backup|sat|cable|kabel|mobil\p{L}*|transcoded|only|live|channels?|kanal\p{L}*|local|lokal|&|and|und|et|i|e`,
);

/** Country and region names and tags that make up a group label's country part. */
const COUNTRY_WORD_RE = w(
    String.raw`de|at|ch|uk|us|usa|ca|fr|it|es|pt|prt|nl|be|dk|se|no|fi|pl|cz|sk|hu|ro|bg|gr|tr|al|hr|rs|srb|ba|bih|mk|mkd|me|mne|si|slo|ru|ua|ie|ar|ku|exyu|exy|arab|arabia|arabic|germany|deutschland|austria|österreich|swiss|schweiz|switzerland|italia|italy|spain|españa|france|portugal|polska|poland|polskie|turkey|türkiye|romania|greece|hungary|czech|slovakia|slovenia|croatia|serbia|bosnia|macedonia|n\.|montenegro|albania|denmark|dänemark|norway|sweden|finland|netherlands|belgium|canada|ukraine|russia|azerbaijan|kurdish|egypt|iraq|saudi|libya|kuwait|jordan|lebanon|palestine|syria|tunisie|tunisia|yemen|sudan|qatar|oman|bahrain|algerie|algeria|maroc|morocco|uae|ksa|egy|jor|lby|kuw|leb|tun|syr|pales|bahr|yemen|qatar|oman|emirates|aze|maurit\p{L}*`,
);

const COUNTRY_WORD_GLOBAL = new RegExp(COUNTRY_WORD_RE.source, 'giu');
const NOISE_GLOBAL = new RegExp(NOISE_RE.source, 'giu');

/** Remove every match, again until stable: adjacent matches share a boundary. */
function stripRepeated(label: string, global: RegExp): string {
    let prev: string;
    let out = label;
    do {
        prev = out;
        out = out.replace(global, ' ');
    } while (out !== prev);
    return out;
}

/**
 * A group label's own name once its country part and noise are gone, or
 * undefined when nothing meaningful is left. "DE • Orb • Low Quali" -> "Orb",
 * "CZECH [OrbLinkCZ]" -> "OrbLinkCZ", "SK • SLOVAKIA" -> undefined.
 */
export function bouquetLabel(label: string): string | undefined {
    const stripped = stripRepeated(
        stripRepeated(foldTurkishI(label), COUNTRY_WORD_GLOBAL),
        NOISE_GLOBAL,
    )
        .replace(/[^\p{L}\p{N}+'.&-]+/gu, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        // "ZAHRA ZAHRA GROUP" -> "ZAHRA GROUP"
        .replace(/\b(\S+)(?:\s+\1\b)+/giu, '$1');
    const letters = stripped.replace(/[^\p{L}]/gu, '');
    return letters.length >= 3 ? stripped : undefined;
}

/**
 * Turkish dotted/dotless I do not case-fold to i/I under the `i` flag
 * ("SİNEMA", "DİZİLER"); fold them first.
 */
function foldTurkishI(label: string): string {
    return label.replace(/İ/g, 'I').replace(/ı/g, 'i');
}

function firstMatch(
    label: string | undefined,
    rules: ReadonlyArray<readonly [RegExp, string]>,
): string | undefined {
    if (!label) return undefined;
    const folded = foldTurkishI(label);
    for (const [re, genre] of rules) if (re.test(folded)) return genre;
    return undefined;
}

/** The genre a channel name alone names, if any (step 3). */
export function genreFromName(name: string): string | undefined {
    return firstMatch(name.slice(0, MAX_LABEL), NAME_RULES);
}

const GENRE_NAMES: ReadonlySet<string> = new Set(Object.values(GENRE));

/** A category from step 4: the provider's bouquet label, not one of our genres. */
export function isBouquetCategory(category: string): boolean {
    return !GENRE_NAMES.has(category);
}

/** The genre a section or group label names, if any (step 2). */
export function genreFromSection(label: string | undefined): string | undefined {
    return firstMatch(label, SECTION_RULES);
}

/** The category of one channel; see the module comment for the order. */
export function categorizeChannel(name: string, group: string | undefined): string {
    name = name.slice(0, MAX_LABEL);
    group = group?.slice(0, MAX_LABEL);
    if (isAdultLabel(name) || isAdultLabel(group)) return GENRE.adult;
    if (isReligiousLabel(name) || isReligiousLabel(group)) return GENRE.religious;
    if (isLoopChannel(name) || isLoopChannel(group)) return GENRE.loop;

    const fromSection = genreFromSection(group);
    // A specific genre from the section wins; "General"/"Free TV" are what a
    // provider calls its catch-all, so a clear word in the name refines them.
    if (fromSection && fromSection !== GENRE.general && fromSection !== GENRE.freeTv) {
        return fromSection;
    }
    return (
        firstMatch(name, NAME_RULES) ??
        fromSection ??
        (group ? bouquetLabel(group) : undefined) ??
        GENRE.general
    );
}
