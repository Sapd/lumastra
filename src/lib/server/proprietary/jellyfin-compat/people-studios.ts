// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Cast, crew and studios on `/j`: `BaseItemDto.People` / `Studios` / `Tags`,
 * Person and Studio items, Jellyfin person types, and the signed person image
 * tag.
 *
 * Ids are person_key() / studio_key() of the name (migration 16.294.0), always
 * computed by Postgres — see jellyfin-people.queries.ts.
 *
 * Person headshots. `/j/Items/{id}/Images/{type}` is public (Jellyfin clients
 * load artwork without credentials), and a person id is a hash of a NAME, so
 * anyone can compute it. Looking the person up there would tell an anonymous
 * caller whether the library credits a given person. The image tag is the
 * capability instead, like library tiles (library-image-tag.ts): the tag
 * carries the TMDB person id and an HMAC over (person id, TMDB id), minted
 * only on authenticated, access-scoped responses. The image route serves the
 * headshot when the tag verifies for that id and never touches the database;
 * any other request gets the anonymous placeholder.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';
import type postgres from 'postgres';
import { config } from '$lib/server/config';
import {
    getItemCredits,
    getItemStudiosAndTags,
    type CreditRole,
    type VisiblePersonRow,
    type VisibleStudioRow,
} from '$lib/server/database/queries/jellyfin-people.queries';
import type { PersonBio } from '$lib/server/services/person.service';
import { Logger } from '$lib/server/utils/logger';
import { JELLYFIN_SERVER_ID } from './constants';
import type { JellyfinBaseItemDto, JellyfinPersonInfo } from './types';

const logger = Logger.for('JellyfinCompat:PeopleStudios');

/** Stored credit role → Jellyfin `PersonKind`. */
const ROLE_TO_TYPE: Record<CreditRole, string> = {
    actor: 'Actor',
    director: 'Director',
    writer: 'Writer',
    producer: 'Producer',
};

const TYPE_TO_ROLE: Record<string, CreditRole> = {
    actor: 'actor',
    director: 'director',
    writer: 'writer',
    producer: 'producer',
};

function csv(value: string | null | undefined): string[] {
    return (value ?? '')
        .split(/[,|]/)
        .map((v) => v.trim())
        .filter(Boolean);
}

/**
 * Jellyfin `personTypes` / `excludePersonTypes` → the credit roles to match.
 * A type Lumastra keeps no credits for (GuestStar, Composer, …) matches
 * nothing; asking only for such types yields no roles, i.e. no results.
 */
export function parsePersonTypes(
    personTypes: string | null | undefined,
    excludePersonTypes?: string | null,
): CreditRole[] {
    const include = csv(personTypes).map((t) => t.toLowerCase());
    const exclude = new Set(
        csv(excludePersonTypes)
            .map((t) => TYPE_TO_ROLE[t.toLowerCase()])
            .filter(Boolean),
    );
    const base: CreditRole[] =
        include.length === 0
            ? (Object.keys(ROLE_TO_TYPE) as CreditRole[])
            : [...new Set(include.map((t) => TYPE_TO_ROLE[t]).filter((r): r is CreditRole => !!r))];
    return base.filter((r) => !exclude.has(r));
}

// ---------------------------------------------------------------------------
// Person image tag
// ---------------------------------------------------------------------------

const PURPOSE = 'jf-person-image:v1';
const TAG_PATTERN = /^[0-9a-f]{40}$/;

function canonicalId(id: string): string {
    return id.replace(/-/g, '').toLowerCase();
}

function signature(secret: string, personId: string, tmdbId: number): string {
    return createHmac('sha256', secret)
        .update(`${PURPOSE}:${canonicalId(personId)}:${tmdbId}`)
        .digest('hex')
        .slice(0, 32);
}

/**
 * The PrimaryImageTag for a person with a TMDB headshot: 8 hex chars of the
 * TMDB person id + 32 hex chars of HMAC. Undefined without a signing secret
 * or a usable TMDB id.
 */
export function personImageTag(personId: string, tmdbId: string | number): string | undefined {
    const secret = config.JWT_SECRET;
    const numeric = typeof tmdbId === 'number' ? tmdbId : Number.parseInt(tmdbId, 10);
    if (!secret || !Number.isInteger(numeric) || numeric <= 0 || numeric > 0xffffffff) {
        return undefined;
    }
    return numeric.toString(16).padStart(8, '0') + signature(secret, personId, numeric);
}

/** The TMDB person id a valid tag for `personId` carries, else null. */
export function verifyPersonImageTag(
    personId: string,
    tag: string | null | undefined,
): number | null {
    if (!tag) return null;
    const normalized = tag.trim().toLowerCase();
    if (!TAG_PATTERN.test(normalized)) return null;
    const secret = config.JWT_SECRET;
    if (!secret) return null;
    const tmdbId = Number.parseInt(normalized.slice(0, 8), 16);
    if (tmdbId <= 0) return null;
    const expected = Buffer.from(signature(secret, personId, tmdbId));
    const given = Buffer.from(normalized.slice(8));
    return expected.length === given.length && timingSafeEqual(expected, given) ? tmdbId : null;
}

function imageTagFor(
    personId: string,
    tmdbId: string | null,
    hasProfile: boolean | null,
): string | undefined {
    // has_profile === null: written before ingest recorded it; the headshot
    // usually exists, and a miss costs one placeholder image.
    if (!tmdbId || hasProfile === false) return undefined;
    return personImageTag(personId, tmdbId);
}

// ---------------------------------------------------------------------------
// BaseItemDto People / Studios / Tags
// ---------------------------------------------------------------------------

export interface CreditFields {
    people: boolean;
    studios: boolean;
    tags: boolean;
}

export const ALL_CREDIT_FIELDS: CreditFields = { people: true, studios: true, tags: true };

/** Which of People / Studios / Tags a list request's `Fields` asks for. */
export function parseCreditFields(fields: string | null | undefined): CreditFields {
    const set = new Set(csv(fields).map((f) => f.toLowerCase()));
    return { people: set.has('people'), studios: set.has('studios'), tags: set.has('tags') };
}

/** Item types with cast and crew (an episode shows its series' credits). */
const PEOPLE_TYPES = new Set(['Movie', 'Series', 'Season', 'Episode']);
/** Item types with studios and tags of their own. */
const STUDIO_TYPES = new Set(['Movie', 'Series']);

/**
 * Set `People`, `Studios` and `Tags` on the given items (the ones `fields`
 * asks for). Items are ones the caller was already allowed to see. Failures
 * leave the fields off rather than failing the response.
 */
export async function enrichItemsWithCredits(
    sql: postgres.Sql,
    items: JellyfinBaseItemDto[],
    fields: CreditFields,
): Promise<void> {
    const wantPeople = fields.people ? items.filter((i) => PEOPLE_TYPES.has(i.Type)) : [];
    const wantStudios =
        fields.studios || fields.tags ? items.filter((i) => STUDIO_TYPES.has(i.Type)) : [];
    if (wantPeople.length === 0 && wantStudios.length === 0) return;
    try {
        await applyCredits(sql, wantPeople, wantStudios, fields);
    } catch (error) {
        logger.warn('People/Studios enrichment failed; fields left off', {
            error: String(error),
        });
    }
}

async function applyCredits(
    sql: postgres.Sql,
    wantPeople: JellyfinBaseItemDto[],
    wantStudios: JellyfinBaseItemDto[],
    fields: CreditFields,
): Promise<void> {
    const [credits, studiosTags] = await Promise.all([
        wantPeople.length > 0
            ? getItemCredits(
                  sql,
                  wantPeople.map((i) => i.Id),
              )
            : Promise.resolve([]),
        wantStudios.length > 0
            ? getItemStudiosAndTags(
                  sql,
                  wantStudios.map((i) => i.Id),
              )
            : Promise.resolve([]),
    ]);

    const peopleByItem = new Map<string, JellyfinPersonInfo[]>();
    const seen = new Set<string>();
    for (const c of credits) {
        const key = `${c.media_id}|${c.person_id}|${c.role}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const person: JellyfinPersonInfo = {
            Name: c.name,
            Id: c.person_id,
            Type: ROLE_TO_TYPE[c.role],
        };
        // Jellyfin leaves Role empty for crew; Type carries Director/Writer/...
        if (c.role === 'actor' && c.character) person.Role = c.character;
        const tag = imageTagFor(c.person_id, c.tmdb_id, c.has_profile);
        if (tag) person.PrimaryImageTag = tag;
        const list = peopleByItem.get(c.media_id) ?? [];
        list.push(person);
        peopleByItem.set(c.media_id, list);
    }
    for (const item of wantPeople) {
        item.People = peopleByItem.get(canonicalUuid(item.Id)) ?? [];
    }

    const byItem = new Map(studiosTags.map((r) => [r.media_id, r]));
    for (const item of wantStudios) {
        const row = byItem.get(canonicalUuid(item.Id));
        if (fields.studios) {
            item.Studios = (row?.studios ?? []).map((s) => ({ Name: s.name, Id: s.id }));
        }
        if (fields.tags) item.Tags = row?.tags ?? [];
    }
}

function canonicalUuid(id: string): string {
    const hex = canonicalId(id);
    return hex.length === 32
        ? `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
        : id.toLowerCase();
}

// ---------------------------------------------------------------------------
// Person and Studio items
// ---------------------------------------------------------------------------

const BIO_TIMEOUT_MS = 3000;

/** A person's biography from the metadata provider, or null (slow, absent, failed). */
export async function loadPersonBio(tmdbId: string | null): Promise<PersonBio | null> {
    const numeric = tmdbId ? Number.parseInt(tmdbId, 10) : NaN;
    if (!Number.isInteger(numeric) || numeric <= 0) return null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
        // Lazy: person.service pulls in the provider/task registry, which only
        // the single-person routes need.
        const { fetchPersonBio } = await import('$lib/server/services/person.service');
        return await Promise.race([
            fetchPersonBio(numeric),
            new Promise<null>((resolve) => {
                timer = setTimeout(() => resolve(null), BIO_TIMEOUT_MS);
            }),
        ]);
    } finally {
        if (timer) clearTimeout(timer);
    }
}

/** Jellyfin dates are ISO instants; TMDB gives `YYYY-MM-DD`. */
function isoDate(value: string | undefined): string | undefined {
    if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return undefined;
    return `${value}T00:00:00.0000000Z`;
}

function emptyUserData(id: string): JellyfinBaseItemDto['UserData'] {
    return {
        PlaybackPositionTicks: 0,
        PlayedPercentage: 0,
        PlayCount: 0,
        IsFavorite: false,
        Played: false,
        Key: id,
        ItemId: id,
    };
}

/** A Person `BaseItemDto` (PersonsController / `/Items/{personId}`). */
export function serializePersonItem(
    row: VisiblePersonRow,
    bio?: PersonBio | null,
): JellyfinBaseItemDto {
    const tag = imageTagFor(row.id, row.tmdb_id, row.has_profile);
    const item: JellyfinBaseItemDto = {
        Name: row.name,
        Id: row.id,
        ServerId: JELLYFIN_SERVER_ID,
        Type: 'Person',
        MediaType: 'Unknown',
        IsFolder: false,
        LocationType: 'FileSystem',
        ImageTags: tag ? { Primary: tag } : {},
        BackdropImageTags: [],
        MovieCount: row.movie_count,
        SeriesCount: row.series_count,
        UserData: emptyUserData(row.id),
    };
    if (row.tmdb_id) item.ProviderIds = { Tmdb: row.tmdb_id };
    if (bio?.biography) item.Overview = bio.biography;
    const born = isoDate(bio?.birthday);
    if (born) {
        item.PremiereDate = born;
        item.ProductionYear = Number.parseInt(born.slice(0, 4), 10);
    }
    const died = isoDate(bio?.deathday);
    if (died) item.EndDate = died;
    if (bio?.placeOfBirth) item.ProductionLocations = [bio.placeOfBirth];
    return item;
}

/** A Studio `BaseItemDto` (StudiosController / `/Items/{studioId}`). Lumastra keeps no studio logos. */
export function serializeStudioItem(row: VisibleStudioRow): JellyfinBaseItemDto {
    return {
        Name: row.name,
        Id: row.id,
        ServerId: JELLYFIN_SERVER_ID,
        Type: 'Studio',
        MediaType: 'Unknown',
        IsFolder: false,
        LocationType: 'FileSystem',
        ImageTags: {},
        BackdropImageTags: [],
        MovieCount: row.movie_count,
        SeriesCount: row.series_count,
        UserData: emptyUserData(row.id),
    };
}
