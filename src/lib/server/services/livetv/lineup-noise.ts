// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Channels that make a large provider's lineup noisy without being TV
 * stations: info and welcome screens, event slots that stay dark until a match,
 * a network's local stations, film and fairy-tale loops, and radio. Configure
 * Lineup offers one switch per kind (`lineup-filter.ts`).
 *
 * Most kinds are only visible across the lineup ("<stem> 1".."<stem> 40"
 * without a guide, 300 stations of one network each with its own call sign),
 * so `classifyLineup` looks at a source's channels together. Structure and
 * generic words only: no broadcaster, brand or league names in code.
 *
 * @module services/livetv/lineup-noise
 */

import { MAX_LABEL, isLoopChannel, stripCountryTag } from './channel-country.js';
import { GENRE } from './channel-genre.js';
import { detectQualityTier, extractBaseName } from './auto-processor.js';

export type NoiseKind = 'info' | 'eventSlot' | 'localStation' | 'loop' | 'radio';

export const NOISE_KINDS: readonly NoiseKind[] = [
    'info',
    'eventSlot',
    'localStation',
    'loop',
    'radio',
];

export interface NoiseChannel {
    id: string;
    title: string;
    category_name: string | null;
    epg_channel_id: string | null;
    /** Position in the provider's playlist; neighbours tell a VOD block apart. */
    playlist_index: number | null;
}

/** Each kind's channel ids; a channel can be several kinds. */
export type LineupNoise = Record<NoiseKind, Set<string>>;

export function emptyNoise(): LineupNoise {
    return {
        info: new Set(),
        eventSlot: new Set(),
        localStation: new Set(),
        loop: new Set(),
        radio: new Set(),
    };
}

/** The kinds one channel is, for `isChannelKept`. */
export function noiseKindsOf(noise: LineupNoise, id: string): Set<NoiseKind> {
    const out = new Set<NoiseKind>();
    for (const kind of NOISE_KINDS) if (noise[kind].has(id)) out.add(kind);
    return out;
}

// ── Info and welcome screens ─────────────────────────────────────────────

/**
 * A provider's announcement channel: "Event Info", "Welcome Channel",
 * "Programmübersicht (EPG)", "<Bouquet> Programme Guide". "ZDF Info" or "SRF
 * Info" are stations ("info" alone after a name) and stay.
 */
const INFO_RE =
    /(?:^|[^\p{L}\p{N}])(?:events?\s*[-:]?\s*info(?:s|rmation)?|info(?:s|rmation)?\s*(?:channel|kanal)|welcome\s+(?:channel|tv|screen)|willkommens?kanal|programm?e?\s*(?:übersicht|uebersicht|guide|overview|info)|programmübersicht|channel\s*(?:list|guide|overview)|kanalübersicht|senderübersicht|\(\s*epg\s*\))(?![\p{L}\p{N}])/iu;

/** "Welcome" or "Willkommen" as the whole name, decoration aside ("☆ Welcome ☆"). */
const BARE_WELCOME_RE = /^[^\p{L}\p{N}]*(?:welcome|willkommen)[^\p{L}\p{N}]*$/iu;

export function isInfoChannel(title: string): boolean {
    const name = title.slice(0, MAX_LABEL);
    return (INFO_RE.test(name) || BARE_WELCOME_RE.test(name)) && !isLoopChannel(name);
}

// ── Event slots ──────────────────────────────────────────────────────────

/**
 * A bracketed note that the feed only carries live events: "[EVENT ONLY]",
 * "[ONLY DURING MATCH]", "(LIVE DURING EVENTS ONLY)", "(LIVE ON MATCH)".
 */
const EVENT_ONLY_RE =
    /[[(][^\])]{0,40}?\b(?:event|events|match|matches|game|games|spiel|spiele|veranstaltung\p{L}*)\b[^\])]{0,40}[\])]/iu;
const EVENT_ONLY_WORD_RE = /\b(?:only|nur|during|while|wenn|während|on\s+match|on\s+event)\b/iu;

export function hasEventOnlyMarker(title: string): boolean {
    const name = title.slice(0, MAX_LABEL);
    const match = EVENT_ONLY_RE.exec(name);
    return match !== null && EVENT_ONLY_WORD_RE.test(match[0]);
}

/** A short code after the slot number: "Event 1 IT", "Klub 8 HR". */
const TRAILING_CODE_RE = / \p{Lu}{2,3}$/u;
const SLOT_SEPARATORS_RE = /[\s|#.:-]+$/u;

/**
 * The name without one trailing bracketed note ("[EVENT ONLY]", "(ENG)") or
 * short code. By hand, not a regex: provider names are untrusted, and an
 * unanchored bracket pattern backtracks on long runs of "(".
 */
function withoutTrailingNote(name: string): string {
    const last = name.at(-1);
    if (last === ')' || last === ']') {
        const open = name.lastIndexOf(last === ')' ? '(' : '[');
        return open > 0 ? name.slice(0, open).trimEnd() : name;
    }
    return name.replace(TRAILING_CODE_RE, '');
}

interface Slot {
    stem: string;
    number: number;
}

/** The family stem and slot number of a numbered name, quality and notes removed. */
export function parseSlot(title: string): Slot | undefined {
    // extractBaseName collapses whitespace runs.
    let name = extractBaseName(title.slice(0, MAX_LABEL));
    for (let i = 0; i < 4; i++) {
        const next = withoutTrailingNote(name);
        if (next === name) break;
        name = next;
    }
    // "<stem> 12", "<stem> | 07", "<stem> #3", "<stem>-4": the number first,
    // then the stem before it, so no pattern spans the whole name.
    const number = /\d{1,3}$/u.exec(name);
    if (!number || /\d/u.test(name.charAt(number.index - 1))) return undefined;
    const stem = name.slice(0, number.index).replace(SLOT_SEPARATORS_RE, '').toLowerCase();
    // "TV 1", "3 2": too little left to be a family.
    if ((stem.match(/\p{L}/gu) ?? []).length < 3) return undefined;
    return { stem, number: Number.parseInt(number[0], 10) };
}

/**
 * Numbers a stem needs before its members count as slots. A network's own
 * numbered stations rarely pass 7 ("<Net> Sports 1..5"); slot families run to
 * 15-80. A stem that says "event" ("<Bouquet> Event 3", "Live Event 12") or
 * "court" needs fewer.
 */
const SLOT_FAMILY_MIN = 8;
const EVENT_STEM_FAMILY_MIN = 5;
const EVENT_STEM_RE = /(?:^|[^\p{L}])(?:events?|ppv|court|match|matches|game|games)(?![\p{L}])/iu;
/** Share of a family's members with a real guide above which they are stations ("<Net> Sport 1..10"). */
const SLOT_FAMILY_MAX_GUIDED = 0.5;
/**
 * Below this share of guided channels the lineup has no guide to speak of, so
 * "no guide" says nothing: only "event"/"court" stems and the bracketed
 * event-only note count there.
 */
const GUIDED_LINEUP_MIN = 0.1;

// ── Local stations ───────────────────────────────────────────────────────

/**
 * A call sign in brackets: "(WFMY)", "(WXVT-LD)", "(MY WPWR)", "(WBAL - Baltimore MD)".
 * The ITU call-sign shape of broadcast stations with a K or W prefix (three or
 * four letters, an optional "-XX" suffix); bracketed language or country codes
 * ("(POL)", "(ENG)") never start that way often enough to make a network.
 */
const CALL_SIGN_RE =
    /\(\s*(?:\p{Lu}{2,4}\s+)?([KW]\p{Lu}{2,3})(?:-[\p{Lu}\d]{1,3})?\b[^)]{0,40}\)/u;

/** Bracketed words that are feed tags or languages, never call signs. */
const NOT_A_CALL_SIGN = new Set([
    'HDR',
    'FHD',
    'UHD',
    'HEVC',
    'RAW',
    'ENG',
    'GER',
    'DEU',
    'ESP',
    'FRA',
    'ITA',
    'LIVE',
    'ALT',
    'WEB',
    'LOW',
    'MULTI',
    'AUDIO',
    'BACKUP',
    'TEST',
]);

/** "Reg:", "Teams:" and similar labels in front of the network name. */
const LEADING_LABEL_RE = /^\s*[\p{L}\d][\p{L}\d .&'-]{0,24}:\s+/u;

/** Distinct call signs one network needs before its stations count as local stations. */
const LOCAL_STATION_MIN = 8;

function callSign(title: string): string | undefined {
    const match = CALL_SIGN_RE.exec(title);
    if (!match) return undefined;
    return NOT_A_CALL_SIGN.has(match[1]) ? undefined : match[1];
}

/** The network a local station belongs to: the first word once country tag and labels are gone. */
function networkStem(title: string): string | undefined {
    let name = stripCountryTag(title) ?? title;
    for (let i = 0; i < 3 && LEADING_LABEL_RE.test(name); i++) {
        name = name.replace(LEADING_LABEL_RE, '');
    }
    const word = /^[^\p{L}\p{N}]{0,20}([\p{L}\p{N}][\p{L}\p{N}+&'.]*)/u.exec(name);
    return word ? word[1].toLowerCase() : undefined;
}

// ── Loops: provider theme families, single titles ────────────────────────

/** A film title with its year: "Ein Film (1998)", "TR • Ein Film (2011)". */
const YEAR_TITLE_RE = /\((?:19|20)\d{2}\)\s*$/u;

export function isSingleTitle(title: string): boolean {
    return YEAR_TITLE_RE.test(title.slice(0, MAX_LABEL));
}

/**
 * Different themes one two-word prefix needs before it is a provider's loop
 * family ("<Provider> Cinema <actor>", 60+ of them). A network's real theme
 * channels ("<Net> Cinema Action/Comedy/…", even across countries) stay well
 * below.
 */
const LOOP_FAMILY_MIN = 30;

const RADIO_WORD_RE = /(?:^|[^\p{L}\p{N}])(?:radio|fm|rádio|радио)(?![\p{L}\p{N}])/iu;

/**
 * A loop family's member is a bare theme name: no quality or feed tag, no
 * brackets, no "Label:" or "|" sections. Station lists with a shared label
 * ("<League> Teams: …", "VIP SPORT: … (RO)") carry those and stay out.
 */
function loopPrefix(title: string): { prefix: string; theme: string } | undefined {
    const plain = stripCountryTag(title) ?? title;
    if (
        /[[\](){}:|•]/u.test(plain) ||
        detectQualityTier(plain) !== undefined ||
        RADIO_WORD_RE.test(plain)
    ) {
        return undefined;
    }
    const words = extractBaseName(plain)
        .split(/[^\p{L}\p{N}'&.+]+/u)
        .filter((word) => /[\p{L}\p{N}]/u.test(word));
    if (words.length < 3) return undefined;
    const theme = words
        .slice(2)
        .join(' ')
        .replace(/\s*\d+$/u, '')
        .toLowerCase();
    if (!/\p{L}/u.test(theme)) return undefined;
    return { prefix: words.slice(0, 2).join(' ').toLowerCase(), theme };
}

/**
 * A name that reads like a station: quality or feed tag, a country tag,
 * "TV"/"Channel"/"Kanal"/"Sender", a number, a "|"/"•" section. A VOD block next to
 * loop channels ends at one of these.
 */
const STATION_WORD_RE =
    /(?:^|[^\p{L}\p{N}])(?:tv|channel|kanal|sender|television|fernsehen|live|radio|fm)(?![\p{L}\p{N}])/iu;

function looksLikeStation(ch: NoiseChannel): boolean {
    const title = ch.title.slice(0, MAX_LABEL);
    return (
        detectQualityTier(title) !== undefined ||
        stripCountryTag(title) !== undefined ||
        STATION_WORD_RE.test(title) ||
        /[\d|•]/u.test(title)
    );
}

/** Most single titles one tagged loop run takes in on each side. */
const SINGLE_TITLE_RUN = 30;

// ── Guides ───────────────────────────────────────────────────────────────

/**
 * Stations under one guide id, with that many different first words, make the
 * id a placeholder ("epginfobot", "keinepg"): the EPG matcher drops those on
 * import, but rows imported before still carry them.
 */
const PLACEHOLDER_STATIONS = 10;
const PLACEHOLDER_FIRST_WORDS = 5;

function placeholderGuideIds(channels: readonly NoiseChannel[]): Set<string> {
    const firstWords = new Map<string, Set<string>>();
    const stations = new Map<string, Set<string>>();
    for (const ch of channels) {
        const id = ch.epg_channel_id;
        if (!id) continue;
        const base = extractBaseName(ch.title.slice(0, MAX_LABEL)).toLowerCase();
        const words = firstWords.get(id) ?? new Set<string>();
        words.add(base.split(' ')[0] ?? '');
        firstWords.set(id, words);
        const names = stations.get(id) ?? new Set<string>();
        names.add(base);
        stations.set(id, names);
    }
    const out = new Set<string>();
    for (const [id, names] of stations) {
        if (
            names.size >= PLACEHOLDER_STATIONS &&
            (firstWords.get(id)?.size ?? 0) >= PLACEHOLDER_FIRST_WORDS
        ) {
            out.add(id);
        }
    }
    return out;
}

// ── Classification ───────────────────────────────────────────────────────

/** Sort key for the playlist: imports before `playlist_index` existed have none. */
function playlistOrder(channels: readonly NoiseChannel[]): NoiseChannel[] {
    return channels
        .filter((ch) => ch.playlist_index !== null)
        .sort((a, b) => (a.playlist_index ?? 0) - (b.playlist_index ?? 0));
}

/**
 * Sort a source's channels into the noise kinds. Pure; the whole lineup goes
 * in at once because families and neighbours decide most kinds.
 */
export function classifyLineup(channels: readonly NoiseChannel[]): LineupNoise {
    const noise = emptyNoise();
    const placeholders = placeholderGuideIds(channels);
    const hasGuide = (ch: NoiseChannel): boolean =>
        !!ch.epg_channel_id && !placeholders.has(ch.epg_channel_id);
    const guidedLineup =
        channels.length > 0 &&
        channels.filter(hasGuide).length / channels.length >= GUIDED_LINEUP_MIN;
    /** Loops by their own name (24/7 tag, episode, film year): the seeds of the single-title extension. */
    const tagged = new Set<string>();

    const slots = new Map<string, Array<{ ch: NoiseChannel; number: number }>>();
    const networks = new Map<string, Array<{ ch: NoiseChannel; sign: string }>>();
    const loopFamilies = new Map<string, Array<{ ch: NoiseChannel; theme: string }>>();

    for (const ch of channels) {
        const title = ch.title.slice(0, MAX_LABEL);
        if (ch.category_name === GENRE.radio) noise.radio.add(ch.id);
        if (isInfoChannel(title)) noise.info.add(ch.id);
        if (hasEventOnlyMarker(title)) noise.eventSlot.add(ch.id);
        // A year names a film, unless the channel has a schedule of its own.
        if (isLoopChannel(title) || (isSingleTitle(title) && !hasGuide(ch))) tagged.add(ch.id);
        if (tagged.has(ch.id) || isLoopChannel(ch.category_name ?? undefined)) {
            noise.loop.add(ch.id);
        }

        // "<Show> S1 E4" is a loop, not a slot.
        const slot = noise.loop.has(ch.id) ? undefined : parseSlot(title);
        if (slot) {
            const list = slots.get(slot.stem) ?? [];
            list.push({ ch, number: slot.number });
            slots.set(slot.stem, list);
        }

        const sign = callSign(title);
        const network = sign ? networkStem(title) : undefined;
        if (sign && network) {
            const list = networks.get(network) ?? [];
            list.push({ ch, sign });
            networks.set(network, list);
        }

        if (ch.category_name !== GENRE.radio) {
            const loop = loopPrefix(title);
            if (loop) {
                const list = loopFamilies.get(loop.prefix) ?? [];
                list.push({ ch, theme: loop.theme });
                loopFamilies.set(loop.prefix, list);
            }
        }
    }

    for (const [stem, members] of slots) {
        const eventStem = EVENT_STEM_RE.test(stem);
        if (!eventStem && !guidedLineup) continue;
        const min = eventStem ? EVENT_STEM_FAMILY_MIN : SLOT_FAMILY_MIN;
        if (new Set(members.map((m) => m.number)).size < min) continue;
        const guided = members.filter((m) => hasGuide(m.ch)).length;
        if (guided / members.length > SLOT_FAMILY_MAX_GUIDED) continue;
        // A member with its own schedule is a station, whatever its family.
        for (const m of members) if (!hasGuide(m.ch)) noise.eventSlot.add(m.ch.id);
    }

    for (const members of networks.values()) {
        if (new Set(members.map((m) => m.sign)).size < LOCAL_STATION_MIN) continue;
        for (const m of members) noise.localStation.add(m.ch.id);
    }

    for (const members of loopFamilies.values()) {
        if (new Set(members.map((m) => m.theme)).size < LOOP_FAMILY_MIN) continue;
        for (const m of members) noise.loop.add(m.ch.id);
    }

    // Single titles ("Rapunzel", "Ein Film") sit in the playlist right next to
    // the provider's episode loops: extend each tagged loop run over at most
    // SINGLE_TITLE_RUN neighbours without a guide that do not read like a
    // station. Only tagged loops seed it, so it never grows from its own finds.
    const ordered = playlistOrder(channels);
    const vodLike = (j: number): boolean =>
        !hasGuide(ordered[j]) && !looksLikeStation(ordered[j]) && !noise.radio.has(ordered[j].id);
    for (let i = 0; i < ordered.length; i++) {
        if (!tagged.has(ordered[i].id)) continue;
        for (const step of [-1, 1]) {
            for (
                let j = i + step, n = 0;
                j >= 0 && j < ordered.length && n < SINGLE_TITLE_RUN && !tagged.has(ordered[j].id);
                j += step, n++
            ) {
                if (!vodLike(j)) break;
                noise.loop.add(ordered[j].id);
            }
        }
    }

    return noise;
}

/** How many channels each kind holds, for the setup summary. */
export function countNoise(noise: LineupNoise): Record<NoiseKind, number> {
    return {
        info: noise.info.size,
        eventSlot: noise.eventSlot.size,
        localStation: noise.localStation.size,
        loop: noise.loop.size,
        radio: noise.radio.size,
    };
}
