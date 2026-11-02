// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * HDHomeRun device discovery, validation, and M3U generation.
 *
 * Translates an HDHomeRun device IP into M3U channel data for the import pipeline.
 * The device exposes a simple unauthenticated HTTP API on the local network:
 *   - GET /discover.json  → device info (name, model, tuner count, DeviceAuth)
 *   - GET /lineup.json    → channel list with direct MPEG-TS stream URLs
 *
 * EPG is optionally fetched from the SiliconDust cloud API using the DeviceAuth
 * token returned by /discover.json.
 */

import { validateUrl } from '$lib/server/utils/url-validator.js';
import { config } from '$lib/server/config.js';
import { isRecord, toString } from '$lib/utils/data-extraction.js';
import { Logger } from '$lib/server/utils/logger.js';
import { pinnedFetch } from '$lib/server/utils/ssrf-guard.js';
import {
    readBoundedResponseJson,
    readBoundedResponseText,
} from '$lib/server/utils/bounded-response.js';

const logger = Logger.for('HdHomeRunClient');

/** discover.json is a few hundred bytes. */
const MAX_DISCOVER_BYTES = 256 * 1024;
/** A lineup of a few hundred channels is well under 1 MiB; this is generous. */
const MAX_LINEUP_BYTES = 8 * 1024 * 1024;
/** Only the start of an error body is logged. */
const MAX_ERROR_BODY_BYTES = 8 * 1024;

// ── Redirect-safe fetch ──────────────────────────────────────────────────────

/** Redirect hops followed before giving up. A 6th redirect is rejected. */
const MAX_REDIRECT_HOPS = 5;

/** A hop (the first or a redirect target) failed SSRF validation. */
class HdHomeRunSsrfBlockedError extends Error {
    constructor(reason: string) {
        super(reason);
        this.name = 'HdHomeRunSsrfBlockedError';
    }
}

/** A redirect hop was refused: too many hops, or the target failed/errored. */
class HdHomeRunRedirectRejectedError extends Error {
    constructor(reason: string) {
        super(reason);
        this.name = 'HdHomeRunRedirectRejectedError';
    }
}

/**
 * SSRF-validate and fetch an HDHomeRun URL, following redirects MANUALLY and
 * re-validating every hop under the same policy — including the
 * `LIVETV_ALLOW_PRIVATE_URLS` opt-out a LAN tuner depends on (security review
 * 2026-09-12, C6). A bare `fetch` followed up to 20 redirects with no further
 * checks, so anything answering on the device IP could bounce the request at
 * another internal address and use the echoed HTTP status as a port oracle.
 *
 * Returns the final response plus whether any redirect was followed, so callers
 * can report a redirected failure generically instead of echoing its status.
 */
async function fetchFollowingRedirects(
    initialUrl: string,
    timeoutMs: number,
): Promise<{ response: Response; redirected: boolean }> {
    // One deadline for the whole chain, so redirects can't multiply the budget.
    const signal = AbortSignal.timeout(timeoutMs);
    let currentUrl = initialUrl;

    for (let hop = 0; ; hop++) {
        const redirected = hop > 0;
        const ssrfResult = await validateUrl(currentUrl, {
            allowPrivateIps: config.LIVETV_ALLOW_PRIVATE_URLS,
        });
        if (!ssrfResult.valid) {
            throw new HdHomeRunSsrfBlockedError(ssrfResult.reason);
        }

        let response: Response;
        try {
            // Pin the connection to the address validateUrl vetted, so a
            // hostname can't re-resolve somewhere else between check and
            // connect. Never let fetch follow a redirect itself — it would
            // skip the per-hop validateUrl above.
            response = await pinnedFetch(
                { url: new URL(currentUrl), resolvedIp: ssrfResult.resolvedIp },
                { redirect: 'manual', signal },
            );
        } catch (err) {
            // A connect failure against the operator-supplied device IP is
            // worth reporting verbatim; against a redirect target the device
            // chose it is a port oracle, so it collapses to one message.
            if (redirected) {
                throw new HdHomeRunRedirectRejectedError(
                    'the redirect target could not be reached',
                );
            }
            throw err;
        }

        const isRedirect = response.status >= 300 && response.status < 400;
        if (!isRedirect) return { response, redirected };

        const location = response.headers.get('location');
        if (!location) return { response, redirected };
        if (hop >= MAX_REDIRECT_HOPS) {
            throw new HdHomeRunRedirectRejectedError(`too many redirects (>${MAX_REDIRECT_HOPS})`);
        }
        currentUrl = new URL(location, currentUrl).toString();
    }
}

// ── Types ────────────────────────────────────────────────────────────────────

export interface HdHomeRunDeviceInfo {
    /** Human-readable name (e.g. "HDHomeRun FLEX 4K") */
    friendlyName: string;
    /** Hardware model (e.g. "HDHR5-4US") */
    modelNumber: string | undefined;
    /** Unique hex device ID (e.g. "10521B34") */
    deviceId: string;
    /** Number of tuners available */
    tunerCount: number;
    /** Base URL reported by the device */
    baseUrl: string;
    /** Auth token for SiliconDust cloud EPG (may be undefined on older devices) */
    deviceAuth: string | undefined;
}

export interface HdHomeRunChannel {
    /** Channel number (e.g. "5.1") */
    guideNumber: string;
    /** Channel name (e.g. "KVL") */
    guideName: string;
    /** Direct MPEG-TS stream URL */
    url: string;
    /** Whether the channel is HD */
    hd: boolean;
    /** Whether the channel is DRM-protected (cannot be streamed via HTTP) */
    drm: boolean;
}

export interface HdHomeRunUrls {
    /** Synthetic M3U content generated from the lineup */
    m3uContent: string;
    /** Cloud EPG XMLTV URL (if DeviceAuth is available), otherwise undefined */
    xmltvUrl: string | undefined;
}

export type HdHomeRunValidationResult =
    | {
          valid: true;
          deviceInfo: HdHomeRunDeviceInfo;
      }
    | {
          valid: false;
          reason: string;
          errorType:
              'unreachable' | 'invalid_response' | 'ssrf_blocked' | 'timeout' | 'no_channels';
      };

// ── Device Discovery ─────────────────────────────────────────────────────────

/**
 * Validate an HDHomeRun device by hitting its /discover.json endpoint.
 * Returns device info on success, error details on failure. Never throws.
 */
export async function validateHdHomeRunDevice(
    deviceIp: string,
): Promise<HdHomeRunValidationResult> {
    // Basic format check — reject anything that isn't an IPv4/IPv6 address
    // (prevents path injection via slashes, ports, or hostnames)
    if (!/^[\d.]+$/.test(deviceIp) && !/^[\da-fA-F:]+$/.test(deviceIp)) {
        return {
            valid: false,
            reason: 'Invalid IP address format',
            errorType: 'invalid_response',
        };
    }

    const baseUrl = `http://${deviceIp}`;
    const discoverUrl = `${baseUrl}/discover.json`;

    // SSRF validation, re-applied to every redirect hop.
    let response: Response;
    let redirected: boolean;
    try {
        const outcome = await fetchFollowingRedirects(discoverUrl, 5_000);
        response = outcome.response;
        redirected = outcome.redirected;
    } catch (err: unknown) {
        if (err instanceof HdHomeRunSsrfBlockedError) {
            logger.warn('HDHomeRun SSRF blocked', { deviceIp });
            return {
                valid: false,
                reason: err.message,
                errorType: 'ssrf_blocked',
            };
        }
        if (err instanceof HdHomeRunRedirectRejectedError) {
            logger.warn('HDHomeRun discover redirect rejected', {
                deviceIp,
                reason: err.message,
            });
            return {
                valid: false,
                reason: `Device redirect rejected: ${err.message}`,
                errorType: 'invalid_response',
            };
        }
        if (
            (err instanceof DOMException && err.name === 'AbortError') ||
            (err instanceof Error && err.name === 'TimeoutError')
        ) {
            logger.warn('HDHomeRun discover timeout', { deviceIp });
            return {
                valid: false,
                reason: 'Device did not respond within 5 seconds',
                errorType: 'timeout',
            };
        }
        const message = err instanceof Error ? err.message : String(err);
        logger.warn('HDHomeRun discover failed', { deviceIp, error: message });
        return {
            valid: false,
            reason: `Device unreachable: ${message}`,
            errorType: 'unreachable',
        };
    }

    if (!response.ok) {
        let responseBody: string | undefined;
        try {
            responseBody = await readBoundedResponseText(response, MAX_ERROR_BODY_BYTES);
        } catch {
            /* ignore */
        }
        logger.warn('HDHomeRun discover HTTP error', {
            deviceIp,
            status: response.status,
            body: responseBody?.slice(0, 500),
            redirected,
        });
        return {
            valid: false,
            // A redirect target was chosen by the device, not the operator:
            // its status must not reach the caller as a port oracle.
            reason: redirected
                ? 'The device redirected to a target that returned an error'
                : `Device returned HTTP ${response.status}`,
            errorType: 'invalid_response',
        };
    }

    let body: unknown;
    try {
        body = await readBoundedResponseJson(response, MAX_DISCOVER_BYTES);
    } catch {
        logger.warn('HDHomeRun discover non-JSON response', { deviceIp });
        return {
            valid: false,
            reason: 'Device returned invalid JSON',
            errorType: 'invalid_response',
        };
    }

    if (!isRecord(body)) {
        logger.warn('HDHomeRun discover unexpected format', {
            deviceIp,
            bodyType: typeof body,
        });
        return {
            valid: false,
            reason: 'Unexpected response format',
            errorType: 'invalid_response',
        };
    }

    const deviceId = toString(body.DeviceID);
    const friendlyName = toString(body.FriendlyName);
    if (!deviceId || !friendlyName) {
        logger.warn('HDHomeRun discover missing fields', {
            deviceIp,
            hasDeviceID: !!deviceId,
            hasFriendlyName: !!friendlyName,
            keys: Object.keys(body).join(', '),
        });
        return {
            valid: false,
            reason: 'Response missing DeviceID or FriendlyName — is this an HDHomeRun?',
            errorType: 'invalid_response',
        };
    }

    const tunerCount =
        typeof body.TunerCount === 'number' && body.TunerCount > 0 ? body.TunerCount : 1;

    const deviceInfo: HdHomeRunDeviceInfo = {
        friendlyName,
        modelNumber: toString(body.ModelNumber) || undefined,
        deviceId,
        tunerCount,
        baseUrl: toString(body.BaseURL) || baseUrl,
        deviceAuth: toString(body.DeviceAuth) || undefined,
    };

    logger.info('HDHomeRun device discovered', {
        deviceIp,
        deviceId,
        friendlyName,
        tunerCount,
    });

    return { valid: true, deviceInfo };
}

// ── Lineup Fetch ─────────────────────────────────────────────────────────────

/**
 * Fetch the channel lineup from an HDHomeRun device.
 */
export async function fetchHdHomeRunLineup(deviceIp: string): Promise<HdHomeRunChannel[]> {
    const url = `http://${deviceIp}/lineup.json`;

    // SSRF validation (this function is public — guard even if callers
    // validated), re-applied to every redirect hop.
    let response: Response;
    let redirected: boolean;
    try {
        const outcome = await fetchFollowingRedirects(url, 10_000);
        response = outcome.response;
        redirected = outcome.redirected;
    } catch (err) {
        if (err instanceof HdHomeRunSsrfBlockedError) {
            throw new Error(`SSRF blocked: ${err.message}`, { cause: err });
        }
        throw err;
    }

    if (!response.ok) {
        let responseBody: string | undefined;
        try {
            responseBody = await readBoundedResponseText(response, MAX_ERROR_BODY_BYTES);
        } catch {
            /* ignore */
        }
        logger.warn('HDHomeRun lineup HTTP error', {
            deviceIp,
            status: response.status,
            body: responseBody?.slice(0, 500),
            redirected,
        });
        // A redirect target was chosen by the device, not the operator: its
        // status must not reach the task error as a port oracle.
        throw new Error(
            redirected
                ? 'Lineup fetch failed: the device redirected to a target that returned an error'
                : `Lineup fetch failed: HTTP ${response.status}`,
        );
    }

    const body: unknown = await readBoundedResponseJson(response, MAX_LINEUP_BYTES);
    if (!Array.isArray(body)) {
        throw new Error('Lineup response is not an array');
    }

    const channels: HdHomeRunChannel[] = [];
    for (const entry of body) {
        if (!isRecord(entry)) continue;
        const guideNumber = toString(entry.GuideNumber);
        const guideName = toString(entry.GuideName);
        const streamUrl = toString(entry.URL);
        if (!guideNumber || !guideName || !streamUrl) continue;

        channels.push({
            guideNumber,
            guideName,
            url: streamUrl,
            hd: entry.HD === 1,
            drm: entry.DRM === 1,
        });
    }

    return channels;
}

// ── M3U Generation ───────────────────────────────────────────────────────────

/**
 * One value written into a synthetic M3U line. The lineup comes from a device (or
 * whoever sits between us and it), and the result is re-parsed line by line: a
 * CR/LF in a field would start a new `#EXTINF` or URL line, and a quote would end
 * an attribute early.
 */
function m3uField(value: string): string {
    return value.replace(/[\r\n\u2028\u2029"]/g, '');
}

/**
 * Convert an HDHomeRun lineup into M3U Plus format content.
 * DRM-protected channels are skipped (they can't be streamed over HTTP).
 */
export function lineupToM3u(channels: HdHomeRunChannel[], deviceInfo: HdHomeRunDeviceInfo): string {
    const lines: string[] = ['#EXTM3U'];

    for (const ch of channels) {
        if (ch.drm) continue;

        const safeName = m3uField(ch.guideName);
        const safeNumber = m3uField(ch.guideNumber);
        const safeDeviceName = m3uField(deviceInfo.friendlyName);

        const attrs = [
            `tvg-id="${safeNumber}"`,
            `tvg-name="${safeName}"`,
            `tvg-chno="${safeNumber}"`,
            ch.hd ? 'tvg-quality="HD"' : '',
        ]
            .filter(Boolean)
            .join(' ');

        const groupTitle = `group-title="${safeDeviceName}"`;
        lines.push(`#EXTINF:-1 ${attrs} ${groupTitle},${safeName}`);
        // A URL cannot carry a line break; one that does is not a lineup entry.
        lines.push(ch.url.replace(/[\r\n\u2028\u2029]/g, ''));
    }

    return lines.join('\n');
}

/**
 * Build the cloud EPG XMLTV URL if DeviceAuth is available.
 */
export function buildEpgUrl(deviceAuth: string | undefined): string | undefined {
    if (!deviceAuth) return undefined;
    return `http://my.hdhomerun.com/api/xmltv?DeviceAuth=${encodeURIComponent(deviceAuth)}`;
}
