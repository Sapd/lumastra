// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: LicenseRef-Lumastra-Proprietary
// Proprietary and source-available — not licensed under AGPL. See LICENSING.md.

/**
 * The one implementation behind `GET /Items` and the legacy
 * `GET /Users/{userId}/Items` (Jellyfin serves both from ItemsController with
 * the same query; the legacy route only takes the user from the path).
 *
 * The two routes used to be separate copies and drifted: the legacy one had no
 * root-views branch, no playlist listing / playlist contents, no ArtistIds, no
 * episode order for season folders and a smaller Limit cap. Both now run this.
 */

import { json, type RequestEvent } from '@sveltejs/kit';
import type postgres from 'postgres';
import {
    serializeBaseItems,
    mapRowToMediaItem,
    type MediaItemForSerialization,
} from './serializers/base-item';
import { applyJellyfinContentLanguage } from './content-language';
import { enrichItemsWithMediaSources } from './media-source-enrichment';
import { enrichItemsWithProviderIds } from './provider-ids-enrichment';
import { enrichItemsWithMusicArtists } from './music-artists-enrichment';
import { enrichItemsWithImages } from './image-enrichment';
import { enrichItemsWithCredits, parseCreditFields, parsePersonTypes } from './people-studios';
import { expandLanguageCodes } from './language-codes';
import { enrichItemsForList } from './item-details-enrichment';
import {
    DEFAULT_DTO_OPTIONS,
    parseDtoOptions,
    shapeItemsResponse,
    type DtoOptions,
} from './dto-options';
import { certificationToAge } from '$lib/server/utils/certification-parser';
import {
    normalizeUuids,
    personKeysForNames,
    studioKeysForNames,
} from '$lib/server/database/queries/jellyfin-people.queries';
import type { JellyfinBaseItemDto, JellyfinItemsResponse } from './types';
import { getDb } from '$lib/server/database';
import { ApiResponses } from '$lib/server/utils/api-responses';
import { Logger } from '$lib/server/utils/logger';
import { getParam, getParamAll, getJfToken, getSearchTermParam } from './utils';
import { buildJellyfinAccessContext, type JellyfinAccessContext } from './access-context';
import { searchMedia, searchMusic } from '$lib/server/database/queries/search.queries';
import { restrictedAccess } from '$lib/server/database/queries/builders/media-access-boundary';
import {
    getOwnedPlaylists,
    getSharedPlaylists,
    getPlaylistItems,
    type PlaylistRow,
} from '$lib/server/database/queries/playlists.queries';
import { capDistinct } from '$lib/server/utils/filter-list';
import { JELLYFIN_SERVER_ID, USER_ROOT_FOLDER_ID } from './constants';
import {
    browseMediaItems,
    mapJellyfinMediaTypes,
    mapJellyfinTypes,
    type BrowseItemsOptions,
} from '$lib/server/database/queries/jellyfin-browse.queries';
import { buildLibraryViews } from './library-views-utils';
import { applyFolderUserData } from './folder-user-data';
import { playlistIdToUuid, uuidToPlaylistId } from './playlist-id';
import { getUserRole } from '$lib/server/utils/playlist-utils';
import type { UserContext } from '$lib/server/types';

const logger = Logger.for('JellyfinCompat:Items');

/**
 * Real Jellyfin returns ALL matching items when no Limit is provided — what
 * library scanners (Seerr/Jellyseerr) rely on: getLibraryContents calls /Items
 * with Recursive=true and no Limit and takes the response as the full library.
 * Recursive requests may therefore page up to 10k; browse-style calls keep a
 * modest cap so a UI bug can't request the entire catalog.
 */
const SCAN_MAX = 10000;
const BROWSE_MAX = 100;

export interface ItemsHandlerOptions {
    /**
     * `/Users/{userId}/Items`: an untyped SearchTerm also searched episodes
     * there (never on `/Items`); kept so older clients see no change.
     */
    legacyUserRoute?: boolean;
}

function csv(value: string | null): string[] {
    return value
        ? value
              .split(',')
              .map((v) => v.trim())
              .filter(Boolean)
        : [];
}

function bool(value: string | null): boolean | null {
    if (value === null) return null;
    const v = value.trim().toLowerCase();
    return v === 'true' ? true : v === 'false' ? false : null;
}

/**
 * Jellyfin `Filters` (InternalItemsQuery.ApplyFilters). Filters override the
 * matching `isPlayed` / `isFavorite` booleans; a contradictory pair is a
 * client error in Jellyfin (ArgumentException → 400) and here (the project's
 * error taxonomy answers it as 422 validation_failed).
 */
export interface ItemFilters {
    isFavorite: boolean | null;
    isPlayed: boolean | null;
    isResumable: boolean;
    isFolder: boolean | null;
    conflict: boolean;
}

export function parseItemFilters(
    filters: string | null,
    isFavoriteParam: boolean | null,
    isPlayedParam: boolean | null,
): ItemFilters {
    const set = new Set(csv(filters).map((f) => f.toLowerCase()));
    const has = (f: string): boolean => set.has(f.toLowerCase());
    const conflict =
        (has('IsFolder') && has('IsNotFolder')) ||
        (has('IsPlayed') && has('IsUnplayed')) ||
        (has('Likes') && has('Dislikes'));
    return {
        // Lumastra has no separate "like": IsFavoriteOrLikes is the favourites.
        isFavorite: has('IsFavorite') || has('IsFavoriteOrLikes') ? true : isFavoriteParam,
        isPlayed: has('IsPlayed') ? true : has('IsUnplayed') ? false : isPlayedParam,
        isResumable: has('IsResumable'),
        isFolder: has('IsFolder') ? true : has('IsNotFolder') ? false : null,
        conflict,
    };
}

/** `ParentId=<user root folder>` (from `/Items/Root`) means no parent, like Jellyfin. */
function parentOrRoot(parentId: string | null): string | null {
    if (!parentId) return null;
    return parentId.replace(/-/g, '').toLowerCase() === USER_ROOT_FOLDER_ID ? null : parentId;
}

/** Every `/Items` query parameter the handler reads, parsed once. */
export interface ItemsQuery {
    limit: number;
    startIndex: number;
    recursive: boolean;
    includeItemTypes: string | null;
    mediaTypes: string[];
    parentId: string | null;
    sortByParam: string | null;
    sortBy: string;
    sortOrder: string;
    searchTerm: string | null;
    genres: string[];
    years: number[];
    filters: string | null;
    nameStartsWith: string | null;
    enableUserData: boolean;
    idList: string[];
    artistIds: string[];
    mediaTypesParam: string | null;
    excludeMediaTypes: string[];
    genreIds: string[];
    itemFilters: ItemFilters;
    /** `PersonIds` (ids as sent; malformed ones are dropped when resolved). */
    personIds: string[];
    /** `Person`: one person by name. */
    personName: string | null;
    personTypes: string | null;
    studioIds: string[];
    /** `Studios`: names, pipe-delimited like Genres. */
    studioNames: string[];
    /** `Fields` (only People / Studios / Tags change the output here). */
    fields: string | null;
    /** `ExcludeItemIds` (valid UUIDs only). */
    excludeIds: string[];
    nameLessThan: string | null;
    nameStartsWithOrGreater: string | null;
    officialRatings: string[];
    /** `Tags`: pipe-delimited only (keywords can contain commas). */
    tags: string[];
    /** `AudioLanguages` / `SubtitleLanguages`, expanded to every ISO spelling. */
    audioLanguages: string[];
    subtitleLanguages: string[];
    imageTypes: string[];
    albumIds: string[];
    albumArtistIds: string[];
    hasParentalRating: boolean | null;
    /** `MaxOfficialRating` as an age; null when absent or not a known rating. */
    maxAge: number | null;
    /**
     * `CollapseBoxSetItems`: read, and nothing to do — Lumastra has no
     * collections (BoxSets, see collections.ts), so no item is ever folded
     * into one.
     */
    collapseBoxSetItems: boolean | null;
    /** Fields / EnableImages / ImageTypeLimit / EnableImageTypes / EnableUserData / EnableTotalRecordCount. */
    dto: DtoOptions;
}

/** Pipe-delimited values (commas too, for older clients), like `Genres`. */
function pipeList(value: string | null): string[] {
    return (value ?? '').split('|').flatMap((v) => csv(v));
}

export function parseItemsQuery(url: URL): ItemsQuery {
    const rawLimitParam = getParam(url, 'Limit');
    const recursive = (getParam(url, 'Recursive') ?? '').toLowerCase() === 'true';
    const rawLimit = parseInt(rawLimitParam ?? (recursive ? String(SCAN_MAX) : '20'), 10);
    const cap = recursive ? SCAN_MAX : BROWSE_MAX;
    // The official SDK repeats array keys; jellyfin-web also sends CSV lists.
    const includeItemTypes = getParamAll(url, 'IncludeItemTypes').join(',') || null;
    const sortByParam = getParam(url, 'SortBy');
    const excludeItemTypes = getParam(url, 'ExcludeItemTypes');
    return {
        limit: Math.min(Math.max(0, isNaN(rawLimit) ? 20 : rawLimit), cap),
        startIndex: Math.max(0, parseInt(getParam(url, 'StartIndex') ?? '0', 10) || 0),
        recursive,
        includeItemTypes,
        mediaTypes: includeItemTypes ? mapJellyfinTypes(includeItemTypes) : [],
        parentId: parentOrRoot(getParam(url, 'ParentId')),
        sortByParam,
        sortBy: sortByParam ?? 'SortName',
        sortOrder: getParam(url, 'SortOrder') ?? 'Ascending',
        searchTerm: getSearchTermParam(url),
        // Jellyfin binds Genres pipe-delimited; older clients send commas.
        genres: (getParam(url, 'Genres') ?? '').split('|').flatMap((g) => csv(g)),
        genreIds: csv(getParam(url, 'GenreIds')),
        years: csv(getParam(url, 'Years'))
            .map((y) => parseInt(y, 10))
            .filter((y) => !isNaN(y)),
        filters: getParam(url, 'Filters'),
        nameStartsWith: getParam(url, 'NameStartsWith'),
        enableUserData: getParam(url, 'EnableUserData') !== 'false',
        idList: csv(getParam(url, 'Ids')),
        artistIds: csv(getParam(url, 'ArtistIds')),
        mediaTypesParam: getParam(url, 'MediaTypes'),
        excludeMediaTypes: excludeItemTypes ? mapJellyfinTypes(excludeItemTypes) : [],
        itemFilters: parseItemFilters(
            getParam(url, 'Filters'),
            bool(getParam(url, 'IsFavorite')),
            bool(getParam(url, 'IsPlayed')),
        ),
        personIds: csv(getParam(url, 'PersonIds')),
        personName: getParam(url, 'Person')?.trim() || null,
        personTypes: getParam(url, 'PersonTypes'),
        studioIds: csv(getParam(url, 'StudioIds')),
        studioNames: (getParam(url, 'Studios') ?? '')
            .split('|')
            .map((v) => v.trim())
            .filter(Boolean),
        fields: getParam(url, 'Fields'),
        excludeIds: capDistinct(normalizeUuids(csv(getParam(url, 'ExcludeItemIds')))),
        nameLessThan: getParam(url, 'NameLessThan')?.trim() || null,
        nameStartsWithOrGreater: getParam(url, 'NameStartsWithOrGreater')?.trim() || null,
        officialRatings: capDistinct(pipeList(getParam(url, 'OfficialRatings'))),
        // Pipe only: a keyword may contain a comma (Jellyfin binds Tags pipe-delimited).
        tags: capDistinct(
            (getParam(url, 'Tags') ?? '')
                .split('|')
                .map((v) => v.trim())
                .filter(Boolean),
            true,
        ),
        // Capped before expanding to every ISO spelling.
        audioLanguages: expandLanguageCodes(
            capDistinct(csv(getParam(url, 'AudioLanguages')), true),
        ),
        subtitleLanguages: expandLanguageCodes(
            capDistinct(csv(getParam(url, 'SubtitleLanguages')), true),
        ),
        // One EXISTS per type: the query keeps only the known ones.
        imageTypes: capDistinct(csv(getParam(url, 'ImageTypes')), true),
        albumIds: capDistinct(normalizeUuids(csv(getParam(url, 'AlbumIds')))),
        albumArtistIds: capDistinct(normalizeUuids(csv(getParam(url, 'AlbumArtistIds')))),
        hasParentalRating: bool(getParam(url, 'HasParentalRating')),
        maxAge: maxAgeOf(getParam(url, 'MaxOfficialRating')),
        collapseBoxSetItems: bool(getParam(url, 'CollapseBoxSetItems')),
        dto: parseDtoOptions(url),
    };
}

/** `MaxOfficialRating` (PG-13, TV-MA, FSK 16, …) as an age, like Jellyfin's rating score. */
function maxAgeOf(rating: string | null): number | null {
    if (!rating?.trim()) return null;
    const age = certificationToAge(rating.trim());
    return age !== null && age >= 0 ? age : null;
}

/** Does the request use any of the brief-09 list filters? */
function hasListFilter(q: ItemsQuery): boolean {
    return (
        q.nameLessThan !== null ||
        q.nameStartsWithOrGreater !== null ||
        q.officialRatings.length > 0 ||
        q.tags.length > 0 ||
        q.audioLanguages.length > 0 ||
        q.subtitleLanguages.length > 0 ||
        q.imageTypes.length > 0 ||
        q.albumIds.length > 0 ||
        q.albumArtistIds.length > 0 ||
        // HasParentalRating=true filters nothing (Jellyfin), so it keeps root views.
        q.hasParentalRating === false ||
        q.maxAge !== null
    );
}

/** Does the request filter by person or studio at all? */
function hasCreditFilter(q: ItemsQuery): boolean {
    return (
        q.personIds.length > 0 ||
        q.personName !== null ||
        q.studioIds.length > 0 ||
        q.studioNames.length > 0
    );
}

/**
 * PersonIds / Person / PersonTypes and StudioIds / Studios as browse options.
 * Names become ids in Postgres (the same person_key()/studio_key() every
 * emitted id comes from). A filter whose every value is malformed matches
 * nothing rather than being dropped.
 */
async function creditFilters(
    sql: postgres.Sql,
    q: ItemsQuery,
): Promise<Partial<BrowseItemsOptions>> {
    const out: Partial<BrowseItemsOptions> = {};
    if (q.personIds.length > 0 || q.personName) {
        out.personIds = [
            ...new Set([
                ...normalizeUuids(q.personIds),
                ...(q.personName ? await personKeysForNames(sql, [q.personName]) : []),
            ]),
        ];
        if (q.personTypes) out.personRoles = parsePersonTypes(q.personTypes);
    }
    if (q.studioIds.length > 0 || q.studioNames.length > 0) {
        out.studioIds = [
            ...new Set([
                ...normalizeUuids(q.studioIds),
                ...(await studioKeysForNames(sql, q.studioNames)),
            ]),
        ];
    }
    return out;
}

/** Serialize browse rows (in the given order) the way every /Items branch does. */
async function serializeRows(
    sql: postgres.Sql,
    user: UserContext,
    locals: App.Locals,
    rows: readonly Record<string, unknown>[],
    access: JellyfinAccessContext,
    fields: string | null = null,
    dto: DtoOptions | null = null,
): Promise<JellyfinBaseItemDto[]> {
    const items: MediaItemForSerialization[] = rows.map(mapRowToMediaItem);
    await applyJellyfinContentLanguage(sql, user.userId, items);
    await applyFolderUserData(sql, items, user.userId, access.boundary);
    const serialized = serializeBaseItems(items);
    const apiKey = getJfToken(locals as unknown as Record<string, unknown>);
    // Playable items get files/streams: multi-version movies get one
    // MediaSource per file so Infuse can render a version picker.
    await enrichItemsWithMediaSources(sql, serialized, apiKey);
    // ProviderIds were always sent: whatever `Fields` says, they stay.
    await enrichItemsWithProviderIds(sql, serialized);
    await enrichItemsWithMusicArtists(sql, serialized);
    if (!dto || dto.enableImages) await enrichItemsWithImages(sql, serialized);
    await enrichItemsWithCredits(sql, serialized, parseCreditFields(fields));
    await enrichItemsForList(sql, serialized, dto ?? DEFAULT_DTO_OPTIONS);
    return serialized;
}

/** The user-data / kind filters every filtered /Items branch applies. */
function browseFilters(q: ItemsQuery): Partial<BrowseItemsOptions> {
    return {
        isFavorite: q.itemFilters.isFavorite,
        isPlayed: q.itemFilters.isPlayed,
        isResumable: q.itemFilters.isResumable,
        isFolder: q.itemFilters.isFolder,
        playableMediaTypes: q.mediaTypesParam
            ? mapJellyfinMediaTypes(q.mediaTypesParam)
            : undefined,
        excludeMediaTypes: q.excludeMediaTypes,
        genreIds: q.genreIds,
        recursive: q.recursive,
        excludeIds: q.excludeIds,
        nameLessThan: q.nameLessThan,
        nameStartsWithOrGreater: q.nameStartsWithOrGreater,
        officialRatings: q.officialRatings,
        tags: q.tags,
        audioLanguages: q.audioLanguages,
        subtitleLanguages: q.subtitleLanguages,
        imageTypes: q.imageTypes,
        albumIds: q.albumIds,
        albumArtistIds: q.albumArtistIds,
        // Jellyfin: HasParentalRating=false keeps only unrated items unless a
        // max rating is also given; HasParentalRating=true filters nothing.
        unratedOnly: q.hasParentalRating === false && q.maxAge === null,
        maxAge: q.maxAge,
        // EnableTotalRecordCount=false: no count at all (Jellyfin reports the page size).
        skipCount: !q.dto.enableTotalRecordCount,
    };
}

function baseBrowse(
    q: ItemsQuery,
    user: UserContext,
    access: JellyfinAccessContext,
): BrowseItemsOptions {
    return {
        mediaTypes: [],
        parentId: null,
        searchTerm: null,
        genres: [],
        years: [],
        nameStartsWith: null,
        isFavoriteFilter: false,
        isPlayedFilter: false,
        isUnplayedFilter: false,
        enableUserData: q.enableUserData,
        userId: user.userId,
        idList: [],
        sortBy: 'SortName',
        sortOrder: 'Ascending',
        limit: q.limit,
        startIndex: 0,
        access: access.boundary,
    };
}

/** `MediaTypes=Audio` narrows playlists to music playlists. */
function isMusicPlaylistRequest(q: ItemsQuery): boolean {
    return q.mediaTypesParam?.toLowerCase().includes('audio') ?? false;
}

/** Every playlist the caller can see (owned, then shared), before paging. */
async function visiblePlaylists(
    sql: postgres.Sql,
    q: ItemsQuery,
    user: UserContext,
    access: JellyfinAccessContext,
): Promise<PlaylistRow[]> {
    const playlistType = isMusicPlaylistRequest(q) ? 'music' : undefined;
    // The boundary only filters the cover collage, which this handler does
    // not serialize — passed anyway so the argument is never dropped.
    const [owned, shared] = await Promise.all([
        getOwnedPlaylists(sql, user.userId, playlistType, access.boundary),
        getSharedPlaylists(sql, user.userId, playlistType, access.boundary),
    ]);
    return [...owned, ...shared];
}

/** `/Items` DTOs for one page of playlists, with entry counts and watched state. */
async function playlistDtos(
    sql: postgres.Sql,
    page: PlaylistRow[],
    q: ItemsQuery,
    user: UserContext,
    access: JellyfinAccessContext,
): Promise<JellyfinBaseItemDto[]> {
    const isMusic = isMusicPlaylistRequest(q);
    const visible = await Promise.all(
        page.map((p) =>
            getPlaylistItems(sql, Number(p.id), user.userId, undefined, access.boundary, {
                mode: 'offset',
                availableOnly: true,
            }),
        ),
    );

    const items = page.map((p, index) => {
        const id = playlistIdToUuid(Number(p.id));
        const entries = visible[index];
        const total = entries.length;
        const watched = entries.filter((entry) => entry.watched).length;
        return {
            Name: p.name as string,
            Id: id,
            ServerId: JELLYFIN_SERVER_ID,
            Type: 'Playlist' as const,
            MediaType: isMusic ? 'Audio' : 'Video',
            ChildCount: total,
            RunTimeTicks: 0,
            IsFolder: true,
            ImageTags: {},
            BackdropImageTags: [],
            UserData: {
                IsFavorite: false,
                PlaybackPositionTicks: 0,
                PlayedPercentage: total > 0 ? Math.round((watched / total) * 100) : 0,
                PlayCount: watched > 0 ? 1 : 0,
                Played: total > 0 && watched >= total,
                Key: id,
                ItemId: id,
            },
        };
    });
    return items as JellyfinBaseItemDto[];
}

async function listPlaylists(
    sql: postgres.Sql,
    q: ItemsQuery,
    user: UserContext,
    access: JellyfinAccessContext,
): Promise<Response> {
    // Playlists have no favourite state in Lumastra (their DTO always reports
    // IsFavorite=false). Apply the filter before paging/counting, as for media.
    if (q.itemFilters.isFavorite === true) {
        return json(
            shapeItemsResponse({ Items: [], TotalRecordCount: 0, StartIndex: q.startIndex }, q.dto),
        );
    }
    const allPlaylists = await visiblePlaylists(sql, q, user, access);
    const paged = allPlaylists.slice(q.startIndex, q.startIndex + q.limit);
    return json(
        shapeItemsResponse(
            {
                Items: await playlistDtos(sql, paged, q, user, access),
                TotalRecordCount: allPlaylists.length,
                StartIndex: q.startIndex,
            },
            q.dto,
        ),
    );
}

/** Playlists whose name contains the SearchTerm, case-insensitively: a playlist has no other searchable text. */
function playlistsNamed(rows: PlaylistRow[], term: string): PlaylistRow[] {
    const needle = term.trim().toLowerCase();
    if (!needle) return [];
    return rows.filter((p) => p.name.toLowerCase().includes(needle));
}

async function listPlaylistContents(
    sql: postgres.Sql,
    q: ItemsQuery,
    playlistId: number,
    user: UserContext,
    locals: App.Locals,
    access: JellyfinAccessContext,
    opts: ItemsHandlerOptions,
): Promise<Response> {
    // Playlist ids are sequential integers behind a UUID encoding, so trivially
    // enumerable: gate on the caller's role, 404 (not 403) on no access.
    const { role } = await getUserRole(sql, playlistId, user.username);
    if (!role) return ApiResponses.notFound('Playlist not found');

    const playlistItemType = q.mediaTypes.includes('track')
        ? 'music'
        : q.mediaTypes.includes('movie') || q.mediaTypes.includes('episode')
          ? 'video'
          : undefined;
    let playlistItems = await getPlaylistItems(
        sql,
        playlistId,
        user.userId,
        playlistItemType,
        access.boundary,
    );
    if (q.searchTerm) {
        // A SearchTerm narrows a playlist like any other parent: keep only the
        // entries the same search ranks, so the playlist is not returned whole.
        const matched = new Set(await searchMediaIds(sql, q, q.searchTerm, opts, access));
        playlistItems = playlistItems.filter((pi) => matched.has(pi.media_id));
    }
    const paged = playlistItems.slice(q.startIndex, q.startIndex + q.limit);
    const mediaIds = paged.map((pi) => pi.media_id as string).filter(Boolean);

    // Re-hydrate the media_ids as full media items so each entry serializes
    // with its REAL type (Movie/Episode/Audio), runtime, media sources and
    // provider ids — a hardcoded `Type: 'Audio'` made video playlists unplayable.
    if (mediaIds.length > 0) {
        const { rows } = await browseMediaItems(sql, {
            ...baseBrowse(q, user, access),
            enableUserData: true,
            idList: mediaIds,
            limit: mediaIds.length,
        });
        // Preserve playlist order (browseMediaItems sorts by name).
        const byId = new Map(rows.map((r) => [String(r.id), r]));
        const ordered = mediaIds
            .map((id) => byId.get(id))
            .filter((r): r is NonNullable<typeof r> => r != null);
        const response: JellyfinItemsResponse = {
            Items: await serializeRows(sql, user, locals, ordered, access, q.fields, q.dto),
            TotalRecordCount: playlistItems.length,
            StartIndex: q.startIndex,
        };
        return json(shapeItemsResponse(response, q.dto));
    }

    // Fallback: legacy/partial rows without a resolvable media_id.
    const items = paged.map((pi) => ({
        Name: (pi.title as string) ?? 'Unknown',
        Id: pi.media_id as string,
        ServerId: JELLYFIN_SERVER_ID,
        Type: 'Audio' as const,
        RunTimeTicks: 0,
        Artists: pi.artist ? [pi.artist as string] : [],
        AlbumArtist: (pi.artist as string) ?? undefined,
        Album: (pi.series_name as string) ?? undefined,
        AlbumId: (pi.parent_id as string) ?? undefined,
        ParentId: (pi.parent_id as string) ?? undefined,
        ImageTags: {},
        BackdropImageTags: [],
    }));
    return json(
        shapeItemsResponse(
            {
                Items: items as JellyfinBaseItemDto[],
                TotalRecordCount: playlistItems.length,
                StartIndex: q.startIndex,
            },
            q.dto,
        ),
    );
}

/**
 * Ranked candidates a SearchTerm may draw from. Jellyfin asks its search
 * providers for `Limit * 3` and then filters; this keeps the whole ranked set
 * (bounded) so ParentId / filters apply before paging and TotalRecordCount is
 * the filtered total, not the length of the page.
 */
const SEARCH_CANDIDATES = 500;

/** Video kinds a SearchTerm searches with `searchMedia`. */
type SearchVideoType = 'movie' | 'tv' | 'episode' | 'music';

function searchVideoTypes(q: ItemsQuery, opts: ItemsHandlerOptions): SearchVideoType[] {
    // searchMedia indexes movie / tv / episode / music only. Untyped searches
    // stay as they were per route (episodes only on the legacy route).
    if (q.mediaTypes.length === 0) {
        return opts.legacyUserRoute
            ? ['movie', 'tv', 'episode', 'music']
            : ['movie', 'tv', 'music'];
    }
    const requestable: SearchVideoType[] = ['movie', 'tv', 'episode', 'music'];
    return requestable.filter((t) => q.mediaTypes.includes(t));
}

/** Music kinds a SearchTerm searches with `searchMusic`, as the Search/Hints route does. */
function searchMusicTypes(q: ItemsQuery): ('artist' | 'album' | 'track')[] {
    return (['artist', 'album', 'track'] as const).filter((t) => q.mediaTypes.includes(t));
}

/**
 * Ranked ids the SearchTerm matches for the types the request names: video
 * first, then music. Empty when the request names no searchable type (person,
 * boxset, …), so such a request matches nothing rather than movies.
 */
async function searchMediaIds(
    sql: postgres.Sql,
    q: ItemsQuery,
    searchTerm: string,
    opts: ItemsHandlerOptions,
    access: JellyfinAccessContext,
): Promise<string[]> {
    const videoTypes = searchVideoTypes(q, opts);
    const musicTypes = searchMusicTypes(q);
    // Translation-only: /j auth semantics are out of scope for the
    // access-boundary migration, so the existing pair is adapted verbatim.
    const searchAccess = restrictedAccess({
        deniedGroupIds: access.deniedGroupIds ?? [],
        maxAgeRating: access.ageRating?.maxAgeRating ?? null,
        allowUnrated: access.ageRating?.allowUnrated ?? false,
    });
    const videoHits: Awaited<ReturnType<typeof searchMedia>> =
        videoTypes.length > 0
            ? await searchMedia(sql, searchTerm, searchAccess, {
                  limit: SEARCH_CANDIDATES,
                  offset: 0,
                  mediaTypes: videoTypes,
                  fileBackedOnly: true,
              })
            : [];
    // playableOnly drops file-less tracks and albums, as the hints route does.
    const musicHits: Awaited<ReturnType<typeof searchMusic>> =
        musicTypes.length > 0
            ? await searchMusic(sql, searchTerm, SEARCH_CANDIDATES, searchAccess, {
                  offset: 0,
                  mediaTypes: musicTypes,
                  excludeVariousArtists: true,
                  playableOnly: true,
              })
            : [];
    const ids = [...videoHits.map((r) => r.internal_id), ...musicHits.map((r) => r.id)];
    return [...new Set(ids)].filter((id): id is string => typeof id === 'string' && id.length > 0);
}

async function search(
    sql: postgres.Sql,
    q: ItemsQuery,
    searchTerm: string,
    user: UserContext,
    locals: App.Locals,
    access: JellyfinAccessContext,
    opts: ItemsHandlerOptions,
): Promise<Response> {
    // Playlists are matched by name next to the media types, so a Playlist type
    // never hides the others. They have no favourite state (a favourites filter
    // leaves them out) and sit at the root, never under a library.
    const playlists =
        q.mediaTypes.includes('playlist') &&
        q.itemFilters.isFavorite !== true &&
        q.parentId === null
            ? playlistsNamed(await visiblePlaylists(sql, q, user, access), searchTerm)
            : [];
    const mediaIds = await searchMediaIds(sql, q, searchTerm, opts, access);
    if (playlists.length === 0 && mediaIds.length === 0) {
        return json(
            shapeItemsResponse({ Items: [], TotalRecordCount: 0, StartIndex: q.startIndex }, q.dto),
        );
    }

    // One page over the playlists, then the media: playlists fill the start of
    // the page, and the media query starts where the playlists end.
    const playlistPage = playlists.slice(q.startIndex, q.startIndex + q.limit);
    const mediaLimit = q.limit - playlistPage.length;
    let mediaRows: Record<string, unknown>[] = [];
    let mediaTotal = 0;
    if (mediaIds.length > 0) {
        // The ranked ids go through the same browse query as a listing, so
        // ParentId, Genres, Years, the user-data filters and access scoping all
        // apply, paging happens after filtering, and the total is real.
        const page = await browseMediaItems(sql, {
            ...baseBrowse(q, user, access),
            mediaTypes: q.mediaTypes.filter((t) => t !== 'playlist'),
            parentId: q.parentId,
            genres: q.genres,
            years: q.years,
            nameStartsWith: q.nameStartsWith,
            ...browseFilters(q),
            ...(await creditFilters(sql, q)),
            idList: mediaIds,
            orderByIdList: true,
            startIndex: Math.max(0, q.startIndex - playlists.length),
            // A page that is all playlists still needs the media total: fetch one
            // row to get it, and drop the row.
            limit: Math.max(mediaLimit, 1),
        });
        mediaRows = page.rows.slice(0, mediaLimit);
        mediaTotal = page.totalCount;
    }

    const response: JellyfinItemsResponse = {
        Items: [
            ...(await playlistDtos(sql, playlistPage, q, user, access)),
            ...(mediaRows.length > 0
                ? await serializeRows(sql, user, locals, mediaRows, access, q.fields, q.dto)
                : []),
        ],
        TotalRecordCount: playlists.length + mediaTotal,
        StartIndex: q.startIndex,
    };
    return json(shapeItemsResponse(response, q.dto));
}

export async function handleItemsRequest(
    event: RequestEvent,
    opts: ItemsHandlerOptions = {},
): Promise<Response> {
    const { url } = event;
    const locals = event.locals;
    const user = locals.user;
    const sql = getDb();
    if (!sql) return ApiResponses.error('Database unavailable');

    const q = parseItemsQuery(url);

    // Season / series folders (ParentId without an explicit SortBy) are served
    // in episode order regardless of the library sort, like real Jellyfin. The
    // query applies it only when the parent really is a season or series; a
    // library ParentId keeps SortName.
    const forceEpisodeOrder =
        q.parentId !== null &&
        !q.sortByParam &&
        (q.mediaTypes.length === 0 || q.mediaTypes.includes('episode'));

    // One derivation per request: `boundary` feeds the migrated query modules,
    // `deniedGroupIds` / `ageRating` the ones that still take the legacy pair.
    const access = await buildJellyfinAccessContext(sql, user);

    if (q.itemFilters.conflict) return ApiResponses.badRequest('Conflicting filters');

    try {
        // Root views: a bare `/Items` (no parentId, not recursive, no selective
        // filter) is the user's library views in real Jellyfin, not a dump of
        // every item. findroid's getLibraries() maps each result via
        // toFindroidCollection and needs CollectionFolders here. Seerr always
        // passes Recursive=true, so it never lands here.
        const isRootViewsRequest =
            !q.parentId &&
            !q.recursive &&
            q.idList.length === 0 &&
            !q.searchTerm &&
            !q.includeItemTypes &&
            q.artistIds.length === 0 &&
            q.genres.length === 0 &&
            q.genreIds.length === 0 &&
            q.years.length === 0 &&
            !q.filters &&
            q.itemFilters.isFavorite === null &&
            q.itemFilters.isPlayed === null &&
            q.excludeMediaTypes.length === 0 &&
            !q.mediaTypesParam &&
            !q.nameStartsWith &&
            !hasCreditFilter(q) &&
            !hasListFilter(q);
        if (isRootViewsRequest) {
            // ExcludeItemIds applies to the views too.
            const excluded = new Set(q.excludeIds.map((id) => id.replace(/-/g, '')));
            const views = (await buildLibraryViews(sql, user)).filter(
                (v) => !excluded.has(v.Id.replace(/-/g, '').toLowerCase()),
            );
            return json(
                shapeItemsResponse(
                    { Items: views, TotalRecordCount: views.length, StartIndex: 0 },
                    q.dto,
                ),
            );
        }

        // Playlists live in their own table, not media_items. A SearchTerm goes to
        // the search below instead, which matches playlists by name beside the
        // other requested types (this branch used to run first and drop the term).
        if (q.mediaTypes.includes('playlist') && !q.searchTerm) {
            return await listPlaylists(sql, q, user, access);
        }

        const playlistId = q.parentId ? uuidToPlaylistId(q.parentId) : null;
        if (playlistId !== null) {
            return await listPlaylistContents(sql, q, playlistId, user, locals, access, opts);
        }

        if (q.searchTerm) {
            return await search(sql, q, q.searchTerm, user, locals, access, opts);
        }

        const { rows, totalCount } = await browseMediaItems(sql, {
            ...baseBrowse(q, user, access),
            mediaTypes: q.mediaTypes,
            parentId: q.parentId,
            genres: q.genres,
            years: q.years,
            nameStartsWith: q.nameStartsWith,
            ...browseFilters(q),
            idList: q.idList,
            sortBy: q.sortBy,
            sortOrder: q.sortOrder,
            startIndex: q.startIndex,
            forceEpisodeOrder,
            artistIds: q.artistIds.length > 0 ? q.artistIds : undefined,
            ...(await creditFilters(sql, q)),
        });

        const response: JellyfinItemsResponse = {
            Items: await serializeRows(sql, user, locals, rows, access, q.fields, q.dto),
            TotalRecordCount: totalCount,
            StartIndex: q.startIndex,
        };
        return json(shapeItemsResponse(response, q.dto));
    } catch (error) {
        logger.error('Browse items query failed', error as Error);
        return ApiResponses.error('Failed to browse items');
    }
}
