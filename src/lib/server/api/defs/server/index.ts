// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { CLIENT_VERSION_PATTERN } from '$lib/shared/client-version.js';
import { Logger } from '$lib/server/utils/logger.js';
import { createHash } from 'node:crypto';
import { problem } from '$lib/server/api/problem.js';
import { defineEndpoint } from '$lib/server/api/define.js';
import { typedJson } from '$lib/server/utils/typed-response.js';
import { ServerInfoSchema, callerPermissions, type ServerInfo } from '$lib/schemas/server-info.js';
import { config } from '$lib/server/config.js';
import { getServerId } from '$lib/server/config/server-id.js';
import { appPath, apiUrl } from '$lib/shared/api-urls.js';
import { getServerBranding } from '$lib/server/server-branding.js';
import { buildServerCapabilities } from './capabilities.js';
import type { RequestEvent } from '@sveltejs/kit';

const logger = Logger.for('Server:Discovery');
const clientVersionPattern = new RegExp(CLIENT_VERSION_PATTERN);

/** Only release numbers cross the anonymous boundary; git-only builds disclose nothing. */
export function sanitizeRelease(build: string): string {
    return (
        /^v?(\d+\.\d+\.\d+(?:-(?:alpha|beta|rc)(?:[.-]\d+)?)?)(?=$|[-+])/.exec(build)?.[1] ??
        'unknown'
    );
}

class ServerIdUnavailable extends Error {}

/** If-None-Match uses weak comparison for GET and its implicit HEAD. */
export function matchesServerInfoEtag(value: string | null, etag: string): boolean {
    return (
        value?.split(',').some((part) => {
            const validator = part.trim();
            return validator === '*' || validator.replace(/^W\//, '') === etag;
        }) ?? false
    );
}

export function serverInfoEtag(body: ServerInfo): string {
    const tier = body.caller ? 'authenticated' : 'anonymous';
    const digest = createHash('sha256').update(JSON.stringify(body)).digest('hex');
    return `"lumastra-server-v1:${tier}:${digest}"`;
}

export async function buildServerInfo(
    event: RequestEvent,
    surface: 'internal' | 'v1',
): Promise<ServerInfo> {
    const id = await getServerId();
    if (!id) throw new ServerIdUnavailable();
    const branding = await getServerBranding();
    const minimums = Object.fromEntries(
        Object.entries({
            ios: config.MIN_CLIENT_VERSION_IOS,
            tvos: config.MIN_CLIENT_VERSION_TVOS,
            web: config.MIN_CLIENT_VERSION_WEB,
            other: config.MIN_CLIENT_VERSION_OTHER,
        }).filter(([platform, version]) => {
            if (!version) return false;
            // Validate at the wire boundary too: legacy env/DB settings can
            // bypass save-time validation. Require a full match (including EOF).
            if (typeof version === 'string' && clientVersionPattern.exec(version)?.[0] === version)
                return true;
            logger.warn('Ignoring invalid minimum client version', {
                key: `MIN_CLIENT_VERSION_${platform.toUpperCase()}`,
            });
            return false;
        }),
    );
    const common = {
        id,
        name: branding.appName,
        release: sanitizeRelease(config.buildInfo.version),
        apiVersions: ['v1'] as 'v1'[],
        minClientVersion: Object.keys(minimums).length ? minimums : null,
        branding: {
            appName: branding.appName,
            appDescription: branding.appDescription,
        },
        auth: {
            deviceFlow: {
                enabled: config.FEATURE_DEVICE_AUTH,
                deviceAuthorizationHref: appPath('/oauth/device'),
                tokenHref: appPath('/oauth/token'),
            },
            passwordLogin: { enabled: config.AUTH_NATIVE_LOGIN_ENABLED },
        },
    };
    const principal = event.locals.principal;
    if (!principal || !['pat', 'bearer', 'session', 'forward_auth'].includes(principal.kind)) {
        return { ...common, links: { self: apiUrl(surface, '/server') }, caller: null };
    }
    // Principal scopes do not encode these group/pin-based permission flags.
    // Without the resolved UserContext there is no safe equivalent to advertise.
    const user = event.locals.user;
    const capabilities = await buildServerCapabilities(surface, principal.isAdmin);
    return {
        ...common,
        build: config.buildInfo.version,
        capabilities: {
            ...capabilities,
            liveTv: {
                ...capabilities.liveTv,
                available: capabilities.liveTv.available && user?.hasLiveTvPermission === true,
            },
        },
        links: {
            self: apiUrl(surface, '/server'),
            me: apiUrl(surface, '/me'),
            events: apiUrl(surface, '/events'),
            notice: apiUrl(surface, '/server/notice'),
        },
        caller: {
            id: principal.userId,
            isAdmin: principal.isAdmin,
            permissions: callerPermissions(user),
        },
    };
}

export const def = defineEndpoint({
    docs: {
        GET: {
            tags: ['Server'],
            summary: 'Discover this server and caller capabilities',
            stability: 'stable',
            auth: 'none',
            description:
                'GET and HEAD discovery. A valid user bearer token adds capabilities, build and caller ' +
                'on v1; the internal mirror uses normal cookie/forward-auth authentication. ' +
                'Invalid credentials receive the anonymous tier on v1.',
            responses: {
                200: {
                    schema: ServerInfoSchema,
                    description:
                        'Server bootstrap, with authenticated fields only for a valid user credential',
                },
                304: {
                    description: 'Not modified (If-None-Match matched this tier and caller)',
                    headers: {
                        ETag: { description: 'Echoes the validator that matched.' },
                    },
                },
                429: 'Rate limit exceeded',
                503: 'Persistent server identity unavailable; retry after Retry-After',
                500: 'Internal server error',
            },
        },
    },
    auth: { kind: 'public' },
    handlers: {
        GET: async (event, ctx) => {
            let body: ServerInfo;
            try {
                body = await buildServerInfo(event, ctx.surface);
            } catch (error) {
                if (error instanceof ServerIdUnavailable) {
                    return problem('server_id_unavailable', { retryAfter: 5 });
                }
                throw error;
            }
            const headers = {
                'Cache-Control': 'private, no-cache',
                Vary: 'Authorization, Cookie',
                ETag: serverInfoEtag(body),
            };
            if (matchesServerInfoEtag(event.request.headers.get('if-none-match'), headers.ETag)) {
                return new Response(null, { status: 304, headers });
            }
            return typedJson(ServerInfoSchema, body, { headers });
        },
    },
});
