// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Live connectivity checks behind the admin "Check" / "Test connection"
 * buttons (POST /api/admin/providers/health).
 */

import { joinUpstreamUrl } from '$lib/shared/upstream-url.js';
import { buildJellyfinAuthHeaders, jellyfinHttpError } from '$lib/server/jellyfin/auth-headers.js';
import { describeJellyfinUnreachable } from '$lib/server/jellyfin/unreachable-message.js';
import { describeConnectionTestError } from '$lib/server/utils/fetch-error-cause.js';
import * as m from '$lib/paraglide/messages';
import { config } from '$lib/server/config.js';
import { getAiConfig } from '$lib/server/config/domains/ai.js';
import { fetchWithTimeout } from '$lib/server/utils/fetch-timeout.js';
import { tmdbApi } from '$lib/server/providers/implementations/tmdb';
import { getDb } from '$lib/server/database/connection.js';
import { resolveAcoustIdApiKey } from '$lib/server/providers/implementations/musicbrainz/acoustid.js';
import { resolveAnidbClient } from '$lib/server/providers/implementations/anidb/config-loader.js';
import { isSecretSentinel } from '$lib/shared/secret-sentinel';
import { PROVIDER_CONNECTION_KEYS } from '$lib/shared/provider-connection-keys';

const HEALTH_TIMEOUT_MS = 10_000;

// AniDB bans clients that poll its HTTP API. Throttle the live probe so rapid
// repeated "Check" presses can never trigger a ban — one probe per window.
const ANIDB_PROBE_MIN_INTERVAL_MS = 60_000;
let lastAnidbProbeAt = 0;

interface HealthCheckResult {
    healthy: boolean;
    latencyMs: number;
    error?: string;
    /** The service answered but is throttling us — reachable, not broken. */
    rateLimited?: boolean;
    serverInfo?: Record<string, unknown>;
}

type CheckOutcome = {
    error?: string;
    rateLimited?: boolean;
    serverInfo?: Record<string, unknown>;
};

function connectionHttpError(status: number): string {
    if (status === 401 || status === 403) return m.admin_connection_auth();
    if (status === 404) return m.admin_connection_address();
    if (status >= 500) return m.admin_connection_server({ status });
    return m.admin_connection_http({ status });
}

/**
 * What a check talks to: the URL it tried and the values its messages must never
 * show. Every thrown error is turned into a message through this target, so the
 * raw exception text (which can quote `user:pass@` or `?api_key=`) never reaches
 * the UI, the API body or the debug report.
 */
interface CheckTarget {
    url: string;
    secrets: readonly string[];
}

/** Secret config values that a check may put in a URL or header but not in its message. */
const EXTRA_SECRET_KEYS: Readonly<Record<string, readonly string[]>> = {
    tmdb: ['TMDB_API_KEY'],
    mdblist: ['MDBLIST_API_KEY'],
    trakt: ['TRAKT_CLIENT_ID'],
};

async function timedCheck(
    fn: (setting: SettingReader, signal?: AbortSignal) => Promise<CheckOutcome>,
    setting: SettingReader,
    target: CheckTarget,
    signal?: AbortSignal,
): Promise<HealthCheckResult> {
    const start = performance.now();
    try {
        const result = await fn(setting, signal);
        const latencyMs = Math.round(performance.now() - start);
        if (result.error) {
            return {
                healthy: false,
                latencyMs,
                error: result.error,
                rateLimited: result.rateLimited,
                serverInfo: result.serverInfo,
            };
        }
        return { healthy: true, latencyMs, serverInfo: result.serverInfo };
    } catch (err) {
        const latencyMs = Math.round(performance.now() - start);
        return {
            healthy: false,
            latencyMs,
            error: signal?.aborted
                ? m.admin_connection_cancelled()
                : describeConnectionTestError(err, target.url, target.secrets),
        };
    }
}

/**
 * Reads a connection setting for a check. Defaults to the saved config; the
 * Test Connection button passes the operator's UNSAVED form values instead, so
 * "type a URL, test it, then save" tests what was typed rather than the old
 * value (or "Not configured").
 */
type SettingReader = (key: string) => string;

const HEALTH_CHECKS: Record<
    string,
    (setting: SettingReader, signal?: AbortSignal) => Promise<CheckOutcome>
> = {
    tmdb: async () => {
        if (!config.TMDB_API_KEY) return { error: 'Not configured' };
        // Errors propagate to timedCheck, which words and scrubs them.
        await tmdbApi.getMovieGenres();
        return {};
    },

    mdblist: async (_setting, signal) => {
        if (!config.MDBLIST_API_KEY) return { error: 'Not configured' };
        const resp = await fetchWithTimeout(
            `https://mdblist.com/api/?apikey=${config.MDBLIST_API_KEY}&s=test`,
            { signal },
            HEALTH_TIMEOUT_MS,
        );
        if (!resp.ok) return { error: `HTTP ${resp.status}` };
        return {};
    },

    jellyfin: async (setting, signal) => {
        // Only ever run for an explicit admin "Test connection" (see
        // runProviderHealthCheck), so it works while Jellyfin sync is still off:
        // the admin tests the server before turning sync on. Background callers
        // gate on features.jellyfinSync / canCallJellyfin() themselves.
        if (!setting('JELLYFINURL') || !setting('JELLYFINAPIKEY'))
            return { error: 'Not configured' };
        const url = setting('JELLYFINURL');
        const apiKey = setting('JELLYFINAPIKEY');
        let resp: Response;
        try {
            resp = await fetchWithTimeout(
                joinUpstreamUrl(url, `/System/Info`),
                { signal, headers: buildJellyfinAuthHeaders({ token: apiKey }) },
                HEALTH_TIMEOUT_MS,
            );
        } catch (err) {
            if (signal?.aborted) throw err;
            // The setup wizard's own Jellyfin wording: credentials, DNS, TLS, HTTPS-on-HTTP.
            return { error: describeJellyfinUnreachable(url, err, [apiKey]) };
        }
        if (!resp.ok) return { error: jellyfinHttpError(resp.status) };
        const info = (await resp.json()) as Record<string, unknown>;
        return { serverInfo: { serverName: info.ServerName, version: info.Version } };
    },

    jellyseerr: async (setting, signal) => {
        if (!setting('SEERRURL') || !setting('SEERRAPIKEY')) return { error: 'Not configured' };
        const resp = await fetchWithTimeout(
            `${setting('SEERRURL').replace(/\/+$/, '')}/api/v1/status`,
            { signal, headers: { 'X-Api-Key': setting('SEERRAPIKEY') } },
            HEALTH_TIMEOUT_MS,
        );
        if (!resp.ok) return { error: connectionHttpError(resp.status) };
        const info = (await resp.json()) as Record<string, unknown>;
        return { serverInfo: { version: info.version } };
    },

    sonarr: async (setting, signal) => {
        if (!setting('SONARRURL') || !setting('SONARRAPIKEY')) return { error: 'Not configured' };
        const resp = await fetchWithTimeout(
            `${setting('SONARRURL').replace(/\/+$/, '')}/api/v3/system/status`,
            { signal, headers: { 'X-Api-Key': setting('SONARRAPIKEY') } },
            HEALTH_TIMEOUT_MS,
        );
        if (!resp.ok) return { error: connectionHttpError(resp.status) };
        const info = (await resp.json()) as Record<string, unknown>;
        return { serverInfo: { version: info.version } };
    },

    radarr: async (setting, signal) => {
        if (!setting('RADARRURL') || !setting('RADARRAPIKEY')) return { error: 'Not configured' };
        const resp = await fetchWithTimeout(
            `${setting('RADARRURL').replace(/\/+$/, '')}/api/v3/system/status`,
            { signal, headers: { 'X-Api-Key': setting('RADARRAPIKEY') } },
            HEALTH_TIMEOUT_MS,
        );
        if (!resp.ok) return { error: connectionHttpError(resp.status) };
        const info = (await resp.json()) as Record<string, unknown>;
        return { serverInfo: { version: info.version } };
    },

    kavita: async (setting, signal) => {
        if (!setting('KAVITAURL') || !setting('KAVITAAPIKEY')) return { error: 'Not configured' };
        const baseUrl = setting('KAVITAURL').replace(/\/$/, '');
        const authResp = await fetchWithTimeout(
            `${baseUrl}/api/Plugin/authenticate?apiKey=${setting('KAVITAAPIKEY')}&pluginName=Lumastra`,
            { signal, method: 'POST', headers: { 'Content-Type': 'application/json' } },
            HEALTH_TIMEOUT_MS,
        );
        if (!authResp.ok) return { error: `HTTP ${authResp.status}` };
        const authData = (await authResp.json()) as { token?: string };
        if (!authData.token) return { error: 'No token received' };
        try {
            const infoResp = await fetchWithTimeout(
                `${baseUrl}/api/Server/server-info`,
                { signal, headers: { Authorization: `Bearer ${authData.token}` } },
                HEALTH_TIMEOUT_MS,
            );
            if (infoResp.ok) {
                const info = (await infoResp.json()) as Record<string, unknown>;
                return {
                    serverInfo: { ...(info.kavitaVersion ? { version: info.kavitaVersion } : {}) },
                };
            }
        } catch {
            // server-info is optional; auth succeeded
        }
        return {};
    },

    audiobookshelf: async (setting, signal) => {
        if (!setting('AUDIOURL') || !setting('AUDIOAPIKEY')) return { error: 'Not configured' };
        const resp = await fetchWithTimeout(
            joinUpstreamUrl(setting('AUDIOURL'), `/api/authorize`),
            {
                signal,
                method: 'POST',
                headers: { Authorization: `Bearer ${setting('AUDIOAPIKEY')}` },
            },
            HEALTH_TIMEOUT_MS,
        );
        if (resp.status === 401 || resp.status === 403) return { error: m.setup_abs_error_auth() };
        if (!resp.ok) return { error: `HTTP ${resp.status}` };
        const info = (await resp.json()) as Record<string, unknown>;
        const user = info.user as Record<string, unknown> | undefined;
        return { serverInfo: { ...(user?.username ? { username: user.username } : {}) } };
    },

    openai: async (_setting, signal) => {
        const ai = getAiConfig();
        if (!ai.openaiApiKey) return { error: 'Not configured' };
        const baseUrl = ai.openaiBaseUrl || 'https://api.openai.com/v1';
        const resp = await fetchWithTimeout(
            `${baseUrl}/models`,
            { signal, headers: { Authorization: `Bearer ${ai.openaiApiKey}` } },
            HEALTH_TIMEOUT_MS,
        );
        if (!resp.ok) return { error: `HTTP ${resp.status}` };
        return {};
    },

    voyage: async () => {
        if (!getAiConfig().voyageApiKey) return { error: 'Not configured' };
        return {};
    },

    trakt: async (_setting, signal) => {
        if (!config.TRAKT_CLIENT_ID) return { error: 'Not configured' };
        const resp = await fetchWithTimeout(
            'https://api.trakt.tv/calendars/all/movies/today/1',
            {
                signal,
                headers: {
                    'Content-Type': 'application/json',
                    'trakt-api-version': '2',
                    'trakt-api-key': config.TRAKT_CLIENT_ID,
                },
            },
            HEALTH_TIMEOUT_MS,
        );
        if (!resp.ok) return { error: `HTTP ${resp.status}` };
        return {};
    },

    musicbrainz: async (_setting, signal) => {
        // MusicBrainz itself needs no key. Verify the API is reachable, then —
        // if an AcoustID key is configured — validate it against the AcoustID API.
        const mbResp = await fetchWithTimeout(
            'https://musicbrainz.org/ws/2/artist/?query=test&fmt=json&limit=1',
            {
                signal,
                headers: { 'User-Agent': 'Lumastra-HealthCheck/1.0 ( https://lumastra.org )' },
            },
            HEALTH_TIMEOUT_MS,
        );
        // MusicBrainz answers 503 when a client exceeds its 1 request/second
        // budget — the background music tasks share that budget, so a manual
        // check during a sync routinely lands here. That is throttling, not an
        // outage.
        if (mbResp.status === 503) {
            return {
                error: 'MusicBrainz is rate-limiting requests (HTTP 503) — try again in a minute',
                rateLimited: true,
            };
        }
        if (!mbResp.ok) return { error: `MusicBrainz HTTP ${mbResp.status}` };

        const acoustIdKey = await resolveAcoustIdApiKey(getDb() ?? undefined);
        if (!acoustIdKey) {
            return { serverInfo: { musicbrainz: 'reachable', acoustid: 'no key (optional)' } };
        }

        // AcoustID has no key-only endpoint. Send a syntactically-bogus lookup:
        // the client (key) is authenticated BEFORE the fingerprint is parsed.
        // AcoustID returns HTTP 400 for BOTH an invalid key AND an invalid
        // fingerprint, discriminated only by the JSON body's error code:
        //   code 4 → "invalid API key"    → key rejected
        //   code 3 → "invalid fingerprint" → key accepted (auth passed)
        // So we must parse the body regardless of HTTP status.
        const params = new URLSearchParams({
            client: acoustIdKey,
            duration: '10',
            fingerprint: 'AQAAAA',
            meta: 'recordings',
        });
        const acoustResp = await fetchWithTimeout(
            `https://api.acoustid.org/v2/lookup?${params.toString()}`,
            { signal },
            HEALTH_TIMEOUT_MS,
        );
        interface AcoustIdLookupResponse {
            status?: string;
            error?: { code?: number; message?: string };
        }
        let data: AcoustIdLookupResponse | null = null;
        try {
            data = (await acoustResp.json()) as AcoustIdLookupResponse;
        } catch {
            /* non-JSON body (e.g. an HTML 5xx) — handled below */
        }
        if (data?.status === 'ok') {
            return { serverInfo: { musicbrainz: 'reachable', acoustid: 'key valid' } };
        }
        if (data?.error) {
            const msg = data.error.message ?? 'unknown error';
            if (data.error.code === 4 || /api key|client/i.test(msg)) {
                return { error: `AcoustID key rejected: ${msg}` };
            }
            // Any other app-level error (invalid fingerprint, etc.) proves the
            // key itself authenticated — that is what we are validating.
            return { serverInfo: { musicbrainz: 'reachable', acoustid: 'key valid' } };
        }
        // No parseable error body: only a genuine transport/server failure.
        if (!acoustResp.ok) return { error: `AcoustID HTTP ${acoustResp.status}` };
        return { serverInfo: { musicbrainz: 'reachable', acoustid: 'key valid' } };
    },

    anidb: async (_setting, signal) => {
        const { clientName, clientVer } = await resolveAnidbClient(getDb() ?? undefined);
        if (!clientName) return { error: 'Not configured' };

        const sinceLast = Date.now() - lastAnidbProbeAt;
        if (sinceLast < ANIDB_PROBE_MIN_INTERVAL_MS) {
            const waitS = Math.ceil((ANIDB_PROBE_MIN_INTERVAL_MS - sinceLast) / 1000);
            return {
                error: `Rate-limited — wait ${waitS}s before re-checking (AniDB ban protection)`,
            };
        }
        lastAnidbProbeAt = Date.now();

        // One httpapi request validates the registered client. A registered,
        // unbanned client returns anime XML; anything wrong returns <error>.
        const url =
            `http://api.anidb.net:9001/httpapi?request=anime` +
            `&client=${encodeURIComponent(clientName)}` +
            `&clientver=${encodeURIComponent(clientVer)}` +
            `&protover=1&aid=1`;
        const resp = await fetchWithTimeout(url, { signal }, HEALTH_TIMEOUT_MS);
        if (!resp.ok) return { error: `HTTP ${resp.status}` };
        const text = await resp.text();
        if (/<error/i.test(text)) {
            const m = text.match(/<error[^>]*>\s*([^<]*)/i);
            return { error: `AniDB: ${m?.[1]?.trim() || 'client rejected'}` };
        }
        if (/<anime/i.test(text)) {
            return { serverInfo: { client: clientName, anidb: 'client valid' } };
        }
        return { serverInfo: { client: clientName, anidb: 'reachable' } };
    },
};

function sameOrigin(a: string, b: string): boolean {
    try {
        return new URL(a).origin === new URL(b).origin;
    } catch {
        return false;
    }
}

/** Normalise a registry id (`mdblist-metadata-provider`) to its check key (`mdblist`). */
export function healthCheckKey(provider: string): string {
    return provider.replace(/-metadata-provider$/, '');
}

/** Whether a live check exists for this provider id — the UI hides "Check" otherwise. */
export function hasHealthCheck(provider: string): boolean {
    return healthCheckKey(provider) in HEALTH_CHECKS;
}

export interface ProviderHealthOutcome extends HealthCheckResult {
    checkable: boolean;
}

/**
 * Run a provider's check for the admin UI or the cached debug-report probes.
 * `overrides` are unsaved settings-form values keyed by config key; only the keys that provider's check owns are honoured, and an
 * empty value or the stored-secret sentinel falls back to the saved setting —
 * except that the saved key is never sent to a URL of another origin. The optional
 * signal cancels direct fetches; callers still bound checks using higher-level clients.
 */
export async function runProviderHealthCheck(
    provider: string,
    overrides?: Record<string, string>,
    signal?: AbortSignal,
): Promise<ProviderHealthOutcome> {
    const checkKey = healthCheckKey(provider);
    const checkFn = HEALTH_CHECKS[checkKey];
    if (!checkFn) {
        return {
            healthy: false,
            checkable: false,
            latencyMs: 0,
            error: 'No health check available for this provider',
        };
    }
    const keys = PROVIDER_CONNECTION_KEYS[checkKey];
    const allowed = new Set(keys ? [keys.url, keys.apiKey] : []);
    if (keys) {
        const url = overrides?.[keys.url]?.trim();
        if (url && !/^https?:\/\/\S+$/i.test(url)) {
            return {
                healthy: false,
                checkable: true,
                latencyMs: 0,
                error: m.admin_connection_url_invalid(),
            };
        }
        // Never pair the SAVED key with an unsaved server: the key is write-only
        // in the UI, and sending it to whatever host the form names let anyone
        // with the form read it out. A different origin needs the key typed.
        const key = overrides?.[keys.apiKey]?.trim();
        const savedUrl = (config as unknown as Record<string, unknown>)[keys.url];
        if (
            url &&
            !sameOrigin(url, typeof savedUrl === 'string' ? savedUrl : '') &&
            (!key || isSecretSentinel(key))
        ) {
            return {
                healthy: false,
                checkable: true,
                latencyMs: 0,
                error: m.admin_connection_key_required(),
            };
        }
    }
    const savedValue = (key: string): string => {
        const saved = (config as unknown as Record<string, unknown>)[key];
        return typeof saved === 'string' ? saved : '';
    };
    const setting: SettingReader = (key) => {
        const override = overrides?.[key]?.trim();
        if (allowed.has(key) && override && !isSecretSentinel(override)) return override;
        return savedValue(key);
    };
    const target: CheckTarget = {
        url: keys ? setting(keys.url) : '',
        secrets: [
            ...(keys ? [setting(keys.apiKey)] : []),
            ...(EXTRA_SECRET_KEYS[checkKey] ?? []).map(savedValue),
        ].filter((value) => value !== ''),
    };
    return {
        ...(await timedCheck(checkFn, setting, target, signal)),
        checkable: true,
    };
}
