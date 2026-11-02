// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import type { RequestHandler } from './$types';
import { requireAuth } from '$lib/server/middleware/auth.js';
import { withErrorHandler } from '$lib/server/middleware/error-handler.js';
import { ApiResponses } from '$lib/server/utils/api-responses.js';
import { aiDbService } from '$lib/server/services/database.service.js';
import { Logger } from '$lib/server/utils/logger.js';
import { safeFetch, UrlSafetyError } from '$lib/server/tasks/url-safety.js';
import { leaseRadioStream } from '$lib/server/services/radio-stream-lease.js';
import { getRadioStreamUrl } from '$lib/server/database/queries/radio-stream.queries.js';
import {
    validatePlaybackGrant,
    playbackGrantUserContext,
} from '$lib/server/services/playback-grant.js';
import { getClientIpStrictFromRequest } from '$lib/server/utils/client-ip.js';
import { checkMediaAccess } from '$lib/server/middleware/media-access.js';

const logger = Logger.for('MusicRadioStreamProxy');

/**
 * GET /api/music/radio/[id]/stream
 *
 * Proxies an internet radio stream from external Icecast/Shoutcast URL.
 * Adds CORS headers and strips ICY metadata for browser compatibility.
 */
export const GET: RequestHandler = requireAuth(
    withErrorHandler(async ({ params, locals, request, url, getClientAddress }) => {
        if (!locals.user) return ApiResponses.unauthorized();

        const sql = await aiDbService.getSql();
        if (!sql) return ApiResponses.error('Database unavailable');

        if (!params.id) return ApiResponses.badRequest('Missing station ID');

        const streamUrl = await getRadioStreamUrl(sql, params.id);
        if (!streamUrl) return ApiResponses.notFound('Radio station');
        if (!(await checkMediaAccess(sql, params.id, locals.user))) {
            return ApiResponses.notFound('Radio station');
        }

        // SSRF protection: only allow http(s) schemes
        let parsedUrl: URL;
        try {
            parsedUrl = new URL(streamUrl);
        } catch {
            return ApiResponses.badRequest('Invalid stream URL');
        }
        if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
            return ApiResponses.badRequest('Invalid stream URL scheme');
        }

        // SSRF: safeFetch re-checks every redirect hop and pins each connection
        // to the vetted address in the transport (undici connect.lookup), so a
        // DNS rebind cannot reach a private address. This route streams the body
        // back to the caller, so a rebind would be a READABLE SSRF. Pinning in the
        // transport keeps the hostname in the URL: the upstream sees the right
        // Host header and TLS SNI. (Swapping the hostname for the IP does not
        // work: fetch() drops a caller-set Host, so name-based vhosts such as
        // TechnoBase FM answered for the bare IP and every play failed.)

        logger.debug('Proxying radio stream', {
            stationId: params.id,
            username: locals.user.username,
        });

        let upstream: Response;
        try {
            upstream = await safeFetch(
                parsedUrl.toString(),
                { headers: { 'User-Agent': 'Lumastra/1.0' }, signal: request.signal },
                { maxRedirects: 5 },
            );
        } catch (err) {
            if (request.signal.aborted) throw err;
            const message = err instanceof Error ? err.message : String(err);
            logger.warn('Radio stream upstream failed', { stationId: params.id, error: message });
            // UrlSafetyError also wraps DNS and connection failures and the
            // redirect limit; only a private/loopback target is the caller's 400.
            if (err instanceof UrlSafetyError && /private|loopback/.test(message)) {
                return ApiResponses.badRequest('Stream URL targets a disallowed address');
            }
            return ApiResponses.error('Failed to connect to radio stream', undefined, 502);
        }

        if (!upstream.ok || !upstream.body) {
            logger.warn('Radio stream upstream returned an error', {
                stationId: params.id,
                status: upstream.status,
            });
            void upstream.body?.cancel().catch(() => {});
            return ApiResponses.error('Failed to connect to radio stream', undefined, 502);
        }

        const contentType = upstream.headers.get('content-type') ?? 'audio/mpeg';

        const token = url.searchParams.get('grant');
        const sessionId = locals.streamingSession?.playbackSessionId;
        const clientIp = getClientIpStrictFromRequest(request, getClientAddress);
        const body =
            token && sessionId
                ? leaseRadioStream(upstream.body, request.signal, async () => {
                      const session = await validatePlaybackGrant(token, {
                          clientIp,
                          route: {
                              mediaId: params.id,
                              playbackSessionId: sessionId,
                              kind: 'music',
                          },
                      });
                      if ('reason' in session) return false;
                      const user = await playbackGrantUserContext({
                          username: session.username,
                          user_id: session.userId,
                          minted_by_admin: session.mintedByAdmin,
                      });
                      return !!user && (await checkMediaAccess(sql, params.id!, user));
                  })
                : upstream.body;
        return new Response(body, {
            headers: {
                'Content-Type': contentType,
                'Cache-Control': 'no-cache, no-store',
                'Access-Control-Allow-Origin': '*',
                'Transfer-Encoding': 'chunked',
            },
        });
    }),
);
