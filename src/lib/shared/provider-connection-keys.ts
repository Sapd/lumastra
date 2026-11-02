// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The config keys behind each service's "Test Connection" button. The button
 * sits on the URL field but the check also needs the API key, so the settings
 * form sends both current (possibly unsaved) values. The health endpoint uses
 * the same table as its allow-list: a check only ever takes the keys it owns
 * from the request.
 */
export const PROVIDER_CONNECTION_KEYS: Readonly<
    Record<string, { readonly url: string; readonly apiKey: string }>
> = {
    jellyfin: { url: 'JELLYFINURL', apiKey: 'JELLYFINAPIKEY' },
    jellyseerr: { url: 'SEERRURL', apiKey: 'SEERRAPIKEY' },
    sonarr: { url: 'SONARRURL', apiKey: 'SONARRAPIKEY' },
    radarr: { url: 'RADARRURL', apiKey: 'RADARRAPIKEY' },
    kavita: { url: 'KAVITAURL', apiKey: 'KAVITAAPIKEY' },
    audiobookshelf: { url: 'AUDIOURL', apiKey: 'AUDIOAPIKEY' },
};
