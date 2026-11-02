// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/** Identity of the provider whose selected value is actually used. */
export interface MusicFieldSource {
    provider: 'theaudiodb' | 'discogs' | 'deezer' | 'coverartarchive';
    url?: string;
}
export interface StoredMusicFieldSource extends MusicFieldSource {
    value: string;
}
export type MusicProvenance = Record<string, StoredMusicFieldSource>;

export function discogsCatalogueUrl(kind: 'artist' | 'release', id: unknown): string | null {
    const numeric =
        typeof id === 'number'
            ? id
            : typeof id === 'string' && /^[1-9]\d*$/.test(id)
              ? Number(id)
              : NaN;
    return Number.isSafeInteger(numeric) && numeric > 0
        ? `https://www.discogs.com/${kind}/${numeric}`
        : null;
}

export function validDiscogsCatalogueUrl(value: unknown): value is string {
    return (
        typeof value === 'string' &&
        /^https:\/\/www\.discogs\.com\/(artist|release)\/[1-9]\d*$/.test(value) &&
        discogsCatalogueUrl(
            value.includes('/artist/') ? 'artist' : 'release',
            value.split('/').at(-1),
        ) === value
    );
}

/** Only explicitly displayed fields qualify. Equality also suppresses stale artwork credits. */
export function discogsCredits(
    metadata: unknown,
    namespace: string,
    displayed: Record<string, unknown>,
): string[] {
    if (!metadata || typeof metadata !== 'object') return [];
    const enrichment = (metadata as Record<string, unknown>)[namespace];
    if (!enrichment || typeof enrichment !== 'object') return [];
    const provenance = (enrichment as Record<string, unknown>).provenance;
    if (!provenance || typeof provenance !== 'object') return [];
    const urls = new Set<string>();
    for (const [field, value] of Object.entries(displayed)) {
        const entry = (provenance as Record<string, unknown>)[field];
        if (!value || !entry || typeof entry !== 'object') continue;
        const source = entry as Record<string, unknown>;
        if (
            source.provider === 'discogs' &&
            source.value === value &&
            validDiscogsCatalogueUrl(source.url)
        )
            urls.add(source.url);
    }
    return [...urls];
}

/** The same precedence is used in artist pages and modals. Never credit a curated override. */
export function artistEnrichmentDisplay(
    metadata: Record<string, unknown>,
    overview: string | null,
): {
    biography: string | null;
    genres: string[];
    creditedGenre: string | null;
    creditedBiography: string | null;
} {
    const namespace = metadata.artist_enrichment;
    const enrichment =
        namespace && typeof namespace === 'object' ? (namespace as Record<string, unknown>) : {};
    const nonempty = (value: unknown): value is string =>
        typeof value === 'string' && value.trim().length > 0;
    const curatedBiography = nonempty(overview)
        ? overview
        : nonempty(metadata.biography)
          ? metadata.biography
          : null;
    const creditedBiography = curatedBiography
        ? null
        : nonempty(enrichment.biography)
          ? enrichment.biography
          : null;
    const curatedGenre = metadata.genre;
    const selectedCuratedGenres = nonempty(curatedGenre)
        ? [curatedGenre]
        : Array.isArray(curatedGenre)
          ? curatedGenre.filter(nonempty)
          : Array.isArray(metadata.genres)
            ? metadata.genres.filter(nonempty)
            : null;
    const creditedGenre =
        selectedCuratedGenres === null && nonempty(enrichment.genre) ? enrichment.genre : null;
    return {
        biography: curatedBiography ?? creditedBiography,
        genres: selectedCuratedGenres ?? (creditedGenre ? [creditedGenre] : []),
        creditedGenre,
        creditedBiography,
    };
}

/** Catalogue links for selected values only; raw enrichment metadata stays server-side. */
export function projectDiscogsAttribution(
    metadata: unknown,
    namespace: 'artist_enrichment' | 'album_enrichment',
    displayed: Record<string, unknown>,
): Record<string, string> | undefined {
    const links: Record<string, string> = {};
    for (const [field, value] of Object.entries(displayed)) {
        const [url] = discogsCredits(metadata, namespace, { [field]: value });
        if (url) links[field] = url;
    }
    return Object.keys(links).length ? links : undefined;
}
