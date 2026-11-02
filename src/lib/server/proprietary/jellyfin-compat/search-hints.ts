// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: LicenseRef-Lumastra-Proprietary
// Proprietary and source-available — not licensed under AGPL. See LICENSING.md.

/**
 * `GET /Search/Hints` (SearchController.GetSearchHints + SearchManager).
 *
 * jellyfin-androidtv-family clients (Moonfin) call this — not
 * `/Items?searchTerm=` — for their native search screen.
 *
 * Kinds searched: movies, series and episodes (`searchMedia`), artists, albums
 * and songs (`searchMusic`), video and music genres, Live TV channels, and
 * people. A Person hint carries the Id `/Persons` issues for that name (read
 * from the same access-scoped query, `listVisiblePersons`), so it opens via
 * `/Items/{id}` and `/Persons/{name}`; a person credited only on titles the
 * caller cannot see (library access, age rating) never appears.
 * Studios: no Studio hint is issued (Jellyfin clients do not search them here).
 *
 * Which kinds a request wants follows SearchManager.BuildIncludeItemTypes /
 * BuildExcludeItemTypes: `IncludeItemTypes` narrows, `ExcludeItemTypes` and
 * every `Include*=false` flag remove; with `IncludeMedia=false` only the
 * by-name kinds whose flag is on remain. `MediaTypes` keeps kinds of that
 * media type (genres, people, series, albums and artists are `Unknown`).
 * A `ParentId` limits hits to that library/folder (recursively) and drops
 * the by-name kinds and channels, like Jellyfin (`IncludeItemsByName =
 * !ParentId`).
 *
 * Library hits go through `browseMediaItems` with the ranked ids, so ParentId
 * and access scoping apply before paging and `TotalRecordCount` counts every
 * matching hit (up to {@link SEARCH_CANDIDATES} per source), not the page.
 */

import type postgres from 'postgres';
import {
    serializeBaseItems,
    mapRowToMediaItem,
    mapBaseItemToSearchHint,
} from './serializers/base-item';
import { applyJellyfinContentLanguage } from './content-language';
import { enrichItemsWithMusicArtists } from './music-artists-enrichment';
import type { JellyfinSearchHint, JellyfinSearchHintResult } from './types';
import type { JellyfinAccessContext } from './access-context';
import { getParam, getSearchTermParam, hasLiveTvPermission } from './utils';
import {
    csvParam,
    foldName,
    genreId,
    listVisibleVideoGenres,
    normalizeParentId,
    parseBoolParam,
    parseProgramFlags,
    programFlagsExcludeLibraryItems,
} from './genres';
import { listVisibleMusicGenres, musicGenreId } from './music-genres';
import { searchMedia, searchMusic } from '$lib/server/database/queries/search.queries';
import { restrictedAccess } from '$lib/server/database/queries/builders/media-access-boundary';
import { browseMediaItems } from '$lib/server/database/queries/jellyfin-browse.queries';
import { getEpisodesOfAgeHiddenSeries } from '$lib/server/database/queries/jellyfin-filters.queries';
import {
    CREDIT_ROLES,
    listVisiblePersons,
} from '$lib/server/database/queries/jellyfin-people.queries';
import { getLiveTvProvider } from '$lib/server/services/livetv/index';
import { Logger } from '$lib/server/utils/logger';
import type { UserContext } from '$lib/server/types';

const logger = Logger.for('JellyfinCompat:SearchHints');

export const EMPTY_SEARCH_HINTS: JellyfinSearchHintResult = {
    SearchHints: [],
    TotalRecordCount: 0,
};

/**
 * Ranked candidates taken from each source. Jellyfin's providers stop at 100;
 * a little more depth keeps ParentId-scoped searches from running dry, and
 * the browse query that scopes and counts them reads every candidate.
 */
export const SEARCH_CANDIDATES = 200;
/** Page size when the client sends no Limit (Jellyfin's provider default). */
export const DEFAULT_HINT_LIMIT = 100;

/** Jellyfin kinds this endpoint can return, keyed by lower-cased BaseItemKind. */
const KIND_ALIASES: Record<string, Kind> = {
    movie: 'Movie',
    series: 'Series',
    episode: 'Episode',
    audio: 'Audio',
    musicalbum: 'MusicAlbum',
    musicartist: 'MusicArtist',
    genre: 'Genre',
    musicgenre: 'MusicGenre',
    person: 'Person',
    studio: 'Studio',
    tvchannel: 'TvChannel',
    livetvchannel: 'TvChannel',
};

type Kind =
    | 'Movie'
    | 'Series'
    | 'Episode'
    | 'Audio'
    | 'MusicAlbum'
    | 'MusicArtist'
    | 'Genre'
    | 'MusicGenre'
    | 'Person'
    | 'Studio'
    | 'TvChannel';

const DB_TYPE: Partial<Record<Kind, string>> = {
    Movie: 'movie',
    Series: 'tv',
    Episode: 'episode',
    Audio: 'track',
    MusicAlbum: 'album',
    MusicArtist: 'artist',
};

const MEDIA_TYPE: Record<Kind, string> = {
    Movie: 'video',
    Series: 'unknown',
    Episode: 'video',
    Audio: 'audio',
    MusicAlbum: 'unknown',
    MusicArtist: 'unknown',
    Genre: 'unknown',
    MusicGenre: 'unknown',
    Person: 'unknown',
    Studio: 'unknown',
    TvChannel: 'video',
};

const BY_NAME_KINDS: Kind[] = ['Genre', 'MusicGenre', 'Person', 'Studio'];

/** A requested kind list; names Lumastra has nothing for are kept as `null`. */
function parseKinds(value: string | null): (Kind | null)[] {
    return csvParam(value).map((k) => KIND_ALIASES[k.toLowerCase()] ?? null);
}

/** Which kinds the request allows (SearchManager rules, see the module comment). */
export function allowedKinds(url: URL): Set<Kind> {
    const flag = (name: string): boolean => parseBoolParam(getParam(url, name)) ?? true;
    const includeGenres = flag('IncludeGenres');
    const includePeople = flag('IncludePeople');
    const includeStudios = flag('IncludeStudios');
    const includeArtists = flag('IncludeArtists');
    const includeMedia = flag('IncludeMedia');

    const rawInclude = parseKinds(getParam(url, 'IncludeItemTypes'));
    const exclude = new Set(parseKinds(getParam(url, 'ExcludeItemTypes')));
    if (!includeGenres) {
        exclude.add('Genre');
        exclude.add('MusicGenre');
    }
    if (!includePeople) exclude.add('Person');
    if (!includeStudios) exclude.add('Studio');
    if (!includeArtists) exclude.add('MusicArtist');

    const include = new Set(rawInclude);
    if (!includeMedia) {
        // Jellyfin re-checks the list it is growing (IsEmptyOrContains), so
        // once genres are added a bare IncludeMedia=false adds nothing else.
        const emptyOr = (k: Kind): boolean => include.size === 0 || include.has(k);
        if (includeGenres && emptyOr('Genre')) {
            include.add('Genre');
            include.add('MusicGenre');
        }
        if (includePeople && emptyOr('Person')) include.add('Person');
        if (includeStudios && emptyOr('Studio')) include.add('Studio');
        if (includeArtists && emptyOr('MusicArtist')) include.add('MusicArtist');
    }

    const mediaTypes = csvParam(getParam(url, 'MediaTypes')).map((m) => m.toLowerCase());
    const all = Object.keys(MEDIA_TYPE) as Kind[];
    return new Set(
        all.filter(
            (k) =>
                (include.size === 0 || include.has(k)) &&
                !exclude.has(k) &&
                (mediaTypes.length === 0 || mediaTypes.includes(MEDIA_TYPE[k])),
        ),
    );
}

/** Exact name match first, then prefix match, then the source's own order. */
function titleTier(title: string, term: string): number {
    const t = foldName(title);
    if (t === term) return 0;
    if (t.startsWith(term)) return 1;
    return 2;
}

interface Ranked<T> {
    tier: number;
    value: T;
}

function byTier<T>(entries: Ranked<T>[]): Ranked<T>[] {
    return entries
        .map((e, order) => ({ e, order }))
        .sort((a, b) => a.e.tier - b.e.tier || a.order - b.order)
        .map(({ e }) => e);
}

/** Merge two tier-ordered lists; on equal tiers library items come first. */
function mergeByTier<T>(a: Ranked<T>[], b: Ranked<T>[]): Ranked<T>[] {
    const out: Ranked<T>[] = [];
    let i = 0;
    let j = 0;
    while (i < a.length || j < b.length) {
        if (j >= b.length || (i < a.length && a[i].tier <= b[j].tier)) out.push(a[i++]);
        else out.push(b[j++]);
    }
    return out;
}

function byNameHint(id: string, name: string, type: Kind, isFolder: boolean): JellyfinSearchHint {
    return {
        ItemId: id,
        Id: id,
        Name: name,
        Type: type,
        MediaType: 'Unknown',
        IsFolder: isFolder,
        Artists: [],
    };
}

async function libraryCandidates(
    sql: postgres.Sql,
    term: string,
    kinds: Set<Kind>,
    access: JellyfinAccessContext,
): Promise<string[]> {
    const videoTypes = (['movie', 'tv', 'episode'] as const).filter((t) =>
        [...kinds].some((k) => DB_TYPE[k] === t),
    );
    const musicTypes = (['artist', 'album', 'track'] as const).filter((t) =>
        [...kinds].some((k) => DB_TYPE[k] === t),
    );
    // Translation-only: searchMedia/searchMusic take the legacy pair.
    const searchAccess = restrictedAccess({
        deniedGroupIds: access.deniedGroupIds ?? [],
        maxAgeRating: access.ageRating?.maxAgeRating ?? null,
        allowUnrated: access.ageRating?.allowUnrated ?? false,
    });
    const [videoHits, musicHits] = await Promise.all([
        videoTypes.length > 0
            ? searchMedia(sql, term, searchAccess, {
                  limit: SEARCH_CANDIDATES,
                  offset: 0,
                  mediaTypes: [...videoTypes],
                  fileBackedOnly: true,
              }).then((rows) =>
                  rows
                      .filter((r) => typeof r.internal_id === 'string' && r.internal_id)
                      .map((r) => ({
                          id: r.internal_id as string,
                          title: r.title ?? '',
                          mediaType: r.media_type as string,
                      })),
              )
            : Promise.resolve([]),
        musicTypes.length > 0
            ? // playableOnly drops file-less tracks/albums a client can't play.
              searchMusic(sql, term, SEARCH_CANDIDATES, searchAccess, {
                  offset: 0,
                  mediaTypes: musicTypes,
                  excludeVariousArtists: true,
                  playableOnly: true,
              }).then((rows) =>
                  rows.map((r) => ({ id: r.id, title: r.title, mediaType: r.media_type })),
              )
            : Promise.resolve([]),
    ]);
    // Episodes have no age rating of their own: hold them to their series'.
    const hidden = new Set(
        await getEpisodesOfAgeHiddenSeries(
            sql,
            videoHits.filter((h) => h.mediaType === 'episode').map((h) => h.id),
            access.boundary,
        ),
    );
    const folded = foldName(term);
    const ranked = byTier(
        [...videoHits, ...musicHits]
            .filter((h) => !hidden.has(h.id))
            .map((h) => ({ tier: titleTier(h.title, folded), value: h })),
    );
    return [...new Set(ranked.map((r) => r.value.id))];
}

async function byNameCandidates(
    sql: postgres.Sql,
    term: string,
    kinds: Set<Kind>,
    user: UserContext,
    access: JellyfinAccessContext,
): Promise<Ranked<JellyfinSearchHint>[]> {
    const folded = foldName(term);
    const matches = (name: string): boolean => foldName(name).includes(folded);
    const hints: Ranked<JellyfinSearchHint>[] = [];
    const push = (name: string, hint: JellyfinSearchHint): void => {
        hints.push({ tier: titleTier(name, folded), value: hint });
    };

    const [videoGenres, musicGenres, people, channels] = await Promise.all([
        kinds.has('Genre') ? listVisibleVideoGenres(sql, access) : Promise.resolve([]),
        kinds.has('MusicGenre') ? listVisibleMusicGenres(sql, access) : Promise.resolve([]),
        // Same visibility rule as /Persons: only credits of titles this caller can see.
        kinds.has('Person')
            ? listVisiblePersons(sql, access.boundary, {
                  roles: CREDIT_ROLES,
                  searchTerm: term,
                  startIndex: 0,
                  limit: SEARCH_CANDIDATES,
              }).then((r) => r.rows)
            : Promise.resolve([]),
        kinds.has('TvChannel') && hasLiveTvPermission(user)
            ? getLiveTvProvider()
                  .then((p) => p.getChannels())
                  .catch((error: unknown) => {
                      // Live TV trouble must not take the library search down with it.
                      logger.warn('Live TV channels unavailable for search hints', {
                          error: error instanceof Error ? error.message : String(error),
                      });
                      return [];
                  })
            : Promise.resolve([]),
    ]);

    for (const g of videoGenres) {
        if (matches(g.name)) push(g.name, byNameHint(genreId(g.name), g.name, 'Genre', true));
    }
    for (const g of musicGenres) {
        if (matches(g.genre)) {
            push(g.genre, byNameHint(musicGenreId(g.genre), g.genre, 'MusicGenre', true));
        }
    }
    for (const person of people) {
        push(person.name, byNameHint(person.id, person.name, 'Person', false));
    }
    for (const channel of channels) {
        if (!matches(channel.name)) continue;
        push(channel.name, {
            ItemId: channel.id,
            Id: channel.id,
            Name: channel.name,
            Type: 'TvChannel',
            MediaType: 'Video',
            IsFolder: false,
            PrimaryImageTag: channel.images.primary?.href ? '0' : undefined,
            Artists: [],
        });
    }
    return byTier(hints);
}

async function serializeLibraryHints(
    sql: postgres.Sql,
    rows: readonly Record<string, unknown>[],
    user: UserContext,
): Promise<JellyfinSearchHint[]> {
    if (rows.length === 0) return [];
    const items = rows.map(mapRowToMediaItem);
    await applyJellyfinContentLanguage(sql, user.userId, items);
    const serialized = serializeBaseItems(items);
    // SearchHint.Artists / AlbumArtist / Album come from the enriched BaseItemDto.
    await enrichItemsWithMusicArtists(sql, serialized);
    return serialized.map(mapBaseItemToSearchHint);
}

export async function searchHints(
    sql: postgres.Sql,
    url: URL,
    user: UserContext,
    access: JellyfinAccessContext,
): Promise<JellyfinSearchHintResult> {
    const searchTerm = getSearchTermParam(url)?.trim();
    if (!searchTerm) return EMPTY_SEARCH_HINTS;

    const rawLimit = parseInt(getParam(url, 'Limit') ?? String(DEFAULT_HINT_LIMIT), 10);
    const limit = Math.min(
        Math.max(0, isNaN(rawLimit) ? DEFAULT_HINT_LIMIT : rawLimit),
        SEARCH_CANDIDATES,
    );
    const startIndex = Math.max(0, parseInt(getParam(url, 'StartIndex') ?? '0', 10) || 0);
    const parentId = normalizeParentId(getParam(url, 'ParentId'));

    const kinds = allowedKinds(url);
    if (parentId) {
        for (const k of [...BY_NAME_KINDS, 'TvChannel' as const]) kinds.delete(k);
    }
    const includeItemTypes = csvParam(getParam(url, 'IncludeItemTypes'));
    if (
        kinds.size === 0 ||
        programFlagsExcludeLibraryItems(parseProgramFlags(url), includeItemTypes)
    ) {
        return EMPTY_SEARCH_HINTS;
    }

    const libraryTypes = [...kinds].map((k) => DB_TYPE[k]).filter((t): t is string => !!t);
    const [ids, nameHints] = await Promise.all([
        libraryTypes.length > 0
            ? libraryCandidates(sql, searchTerm, kinds, access)
            : Promise.resolve<string[]>([]),
        byNameCandidates(sql, searchTerm, kinds, user, access),
    ]);

    // Rows up to the end of the requested page are enough to merge and page;
    // COUNT(*) OVER() still counts every scoped hit.
    const window = startIndex + limit;
    let libraryTotal = 0;
    let libraryRanked: Ranked<Record<string, unknown>>[] = [];
    if (ids.length > 0) {
        const { rows, totalCount } = await browseMediaItems(sql, {
            mediaTypes: libraryTypes,
            parentId,
            searchTerm: null,
            genres: [],
            years: [],
            nameStartsWith: null,
            isFavoriteFilter: false,
            isPlayedFilter: false,
            isUnplayedFilter: false,
            enableUserData: false,
            userId: user.userId,
            idList: ids,
            orderByIdList: true,
            recursive: parentId !== null,
            sortBy: 'SortName',
            sortOrder: 'Ascending',
            limit: Math.max(window, 1),
            startIndex: 0,
            access: access.boundary,
        });
        const folded = foldName(searchTerm);
        libraryTotal = totalCount;
        libraryRanked = rows.map((row) => ({
            tier: titleTier(String(row.title ?? ''), folded),
            value: row as Record<string, unknown>,
        }));
    }

    type Entry =
        { kind: 'row'; row: Record<string, unknown> } | { kind: 'hint'; hint: JellyfinSearchHint };
    const merged = mergeByTier<Entry>(
        libraryRanked.map((r) => ({ tier: r.tier, value: { kind: 'row', row: r.value } })),
        nameHints.map((h) => ({ tier: h.tier, value: { kind: 'hint', hint: h.value } })),
    ).slice(startIndex, window);

    const pageRows = merged.flatMap((e) => (e.value.kind === 'row' ? [e.value.row] : []));
    const serialized = await serializeLibraryHints(sql, pageRows, user);
    const byId = new Map(serialized.map((h) => [h.Id, h]));
    const hints = merged
        .map((e) => (e.value.kind === 'hint' ? e.value.hint : byId.get(String(e.value.row.id))))
        .filter((h): h is JellyfinSearchHint => h != null);

    return {
        SearchHints: hints,
        TotalRecordCount: libraryTotal + nameHints.length,
    };
}
