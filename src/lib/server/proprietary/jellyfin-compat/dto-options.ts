// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: LicenseRef-Lumastra-Proprietary
// Proprietary and source-available — not licensed under AGPL. See LICENSING.md.

/**
 * Jellyfin DtoOptions on `/j` list routes: `Fields`, `EnableImages`,
 * `ImageTypeLimit`, `EnableImageTypes`, `EnableUserData` and
 * `EnableTotalRecordCount` (Jellyfin.Api DtoExtensions.AddAdditionalDtoOptions
 * + DtoService).
 *
 * `Fields` only gates what this branch newly added (CanDelete, Width, Height,
 * IsHD, MediaSourceCount, MediaStreams, Chapters, Trickplay). Every field the
 * routes sent before is kept whatever `Fields` says. Deliberate
 * differences from Jellyfin, all only ever sending MORE:
 *
 *  - Fields that were already sent (Overview, Genres, ProviderIds, Path,
 *    ParentId, DateCreated, …) stay, with or without `Fields`: Lumastra always
 *    sent them, and scanners such as Seerr / closed-source clients (Infuse)
 *    depend on them without requesting them.
 *  - `MediaSources` stays on playable items whatever `Fields` says: Infuse
 *    drops a movie/episode that has no source info, and which `Fields` it
 *    sends is not known (closed source). See media-source-enrichment.ts.
 *
 * Every field the SDK contract requires (`Id`, `Type`, and the required
 * members of nested objects) is never touched; `ImageTags` / `BackdropImageTags`
 * become empty rather than disappearing.
 */

import type { JellyfinBaseItemDto, JellyfinItemsResponse } from './types';
import { getParam } from './utils';
import { addSourceDerivedFields } from './item-details-enrichment';

export interface DtoOptions {
    /** Lower-cased `Fields`; null = not sent (full shape, see above). */
    fields: ReadonlySet<string> | null;
    enableImages: boolean;
    /** Lower-cased `EnableImageTypes`; null = every type. */
    imageTypes: ReadonlySet<string> | null;
    /** `ImageTypeLimit`; null = no limit. */
    imageTypeLimit: number | null;
    enableUserData: boolean;
    enableTotalRecordCount: boolean;
}

function csvSet(value: string | null): Set<string> | null {
    if (value === null || value.trim() === '') return null;
    return new Set(
        value
            .split(',')
            .map((v) => v.trim().toLowerCase())
            .filter(Boolean),
    );
}

function boolParam(url: URL, name: string, fallback: boolean): boolean {
    const v = getParam(url, name)?.trim().toLowerCase();
    return v === 'true' ? true : v === 'false' ? false : fallback;
}

/** What a request with none of the options gets. */
export const DEFAULT_DTO_OPTIONS: DtoOptions = Object.freeze({
    fields: null,
    enableImages: true,
    imageTypes: null,
    imageTypeLimit: null,
    enableUserData: true,
    enableTotalRecordCount: true,
});

export function parseDtoOptions(url: URL): DtoOptions {
    const rawLimit = getParam(url, 'ImageTypeLimit');
    const limit = rawLimit !== null ? parseInt(rawLimit, 10) : NaN;
    return {
        fields: csvSet(getParam(url, 'Fields')),
        enableImages: boolParam(url, 'EnableImages', true),
        imageTypes: csvSet(getParam(url, 'EnableImageTypes')),
        imageTypeLimit: Number.isFinite(limit) && limit >= 0 ? limit : null,
        enableUserData: boolParam(url, 'EnableUserData', true),
        enableTotalRecordCount: boolParam(url, 'EnableTotalRecordCount', true),
    };
}

/**
 * The same options from a JSON body (`POST /LiveTv/Programs`, the SDK's
 * GetProgramsDto): arrays or comma-separated strings, booleans or strings.
 */
export function parseDtoOptionsFromBody(body: unknown): DtoOptions {
    const params = new URLSearchParams();
    if (body !== null && typeof body === 'object' && !Array.isArray(body)) {
        for (const name of [
            'Fields',
            'EnableImages',
            'ImageTypeLimit',
            'EnableImageTypes',
            'EnableUserData',
            'EnableTotalRecordCount',
        ]) {
            const value = (body as Record<string, unknown>)[name];
            if (Array.isArray(value)) params.set(name, value.map(String).join(','));
            else if (value !== undefined && value !== null) params.set(name, String(value));
        }
    }
    return parseDtoOptions(new URL(`http://localhost/?${params.toString()}`));
}

/** Does the response carry `field` (a Jellyfin ItemFields name)? */
export function wantsField(opts: DtoOptions, field: string): boolean {
    return opts.fields === null || opts.fields.has(field.toLowerCase());
}

/** How many images of `type` the response may carry (Jellyfin GetImageLimit). */
export function imageLimit(opts: DtoOptions, type: string): number {
    if (!opts.enableImages) return 0;
    if (opts.imageTypes && !opts.imageTypes.has(type.toLowerCase())) return 0;
    return opts.imageTypeLimit ?? Number.MAX_SAFE_INTEGER;
}

/**
 * The BaseItemDto properties THIS branch added to list responses and that
 * Jellyfin only fills when `Fields` asks for them. Only these are dropped when
 * `Fields` is sent without them.
 *
 * Everything the `/j` routes already sent before (Overview, Genres,
 * ProviderIds, Path, ParentId, SortName, DateCreated, Etag, PrimaryImageAspectRatio,
 * CanDownload, …) is never dropped by `Fields`: closed-source clients (Infuse)
 * may depend on fields they do not request. `Chapters` / `Trickplay` / People /
 * Studios / Tags are only ever produced when `Fields` names them, so there is
 * nothing to drop.
 */
const GATED_FIELDS: Readonly<Record<string, readonly (keyof JellyfinBaseItemDto)[]>> = {
    CanDelete: ['CanDelete'],
    MediaStreams: ['MediaStreams'],
    Width: ['Width'],
    Height: ['Height'],
    IsHD: ['IsHD'],
    MediaSourceCount: ['MediaSourceCount'],
};

/** Parent-image references, by the image type they point at. */
const PARENT_IMAGE_FIELDS: Readonly<Record<string, readonly (keyof JellyfinBaseItemDto)[]>> = {
    primary: ['ParentPrimaryImageItemId', 'ParentPrimaryImageTag'],
    backdrop: ['ParentBackdropItemId', 'ParentBackdropImageTags'],
    logo: ['ParentLogoItemId', 'ParentLogoImageTag'],
    thumb: ['ParentThumbItemId', 'ParentThumbImageTag', 'SeriesThumbImageTag'],
};

function shapeImages(item: JellyfinBaseItemDto, opts: DtoOptions): void {
    if (opts.enableImages && opts.imageTypes === null && opts.imageTypeLimit === null) return;
    if (item.ImageTags) {
        const kept: Record<string, string> = {};
        for (const [type, tag] of Object.entries(item.ImageTags)) {
            if (imageLimit(opts, type) > 0) kept[type] = tag;
        }
        item.ImageTags = kept;
    }
    if (item.BackdropImageTags) {
        item.BackdropImageTags = item.BackdropImageTags.slice(0, imageLimit(opts, 'Backdrop'));
    }
    for (const [type, keys] of Object.entries(PARENT_IMAGE_FIELDS)) {
        if (imageLimit(opts, type) > 0) continue;
        for (const key of keys) delete item[key];
    }
    if (!opts.enableImages) {
        item.ImageBlurHashes = {};
    } else if (item.ImageBlurHashes) {
        for (const type of Object.keys(item.ImageBlurHashes)) {
            if (imageLimit(opts, type) === 0) delete item.ImageBlurHashes[type];
        }
    }
}

/**
 * Apply `opts` to serialized items, in place. Takes any item object: the Live
 * TV serializers build loose records with the same property names.
 */
export function shapeItems(items: readonly object[], opts: DtoOptions): void {
    // Width / Height / IsHD / MediaSourceCount (and MediaStreams when asked
    // for) come from the sources already on the item; gated below like the rest.
    addSourceDerivedFields(items as JellyfinBaseItemDto[], {
        mediaStreams: opts.fields?.has('mediastreams') ?? false,
    });
    for (const item of items as JellyfinBaseItemDto[]) {
        if (opts.fields !== null) {
            for (const [field, keys] of Object.entries(GATED_FIELDS)) {
                if (opts.fields.has(field.toLowerCase())) continue;
                for (const key of keys) delete item[key];
            }
        }
        shapeImages(item, opts);
        if (!opts.enableUserData) delete item.UserData;
    }
}

/**
 * Apply `opts` to a list response: its items, and `EnableTotalRecordCount=false`
 * (Jellyfin then reports the number of items returned).
 */
export function shapeItemsResponse<
    T extends Omit<JellyfinItemsResponse, 'Items'> & { Items: object[] },
>(response: T, opts: DtoOptions): T {
    shapeItems(response.Items, opts);
    if (!opts.enableTotalRecordCount) response.TotalRecordCount = response.Items.length;
    return response;
}
