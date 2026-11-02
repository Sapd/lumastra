// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Health Check API Endpoint
 *
 * GET /api/health — liveness probe, 200 always while process is up.
 * No backend dependencies — Docker rolling-deploy semantics require this.
 * Content-Type: application/health+json.
 *
 * GET /api/health?detail=true — same liveness body plus a `detail` block
 * (config-derived, no I/O) surfacing FFmpeg and auth feature-flag
 * misconfigurations for the admin System Status widget. Admin-gated — no
 * config topology leak to unauthenticated liveness probes.
 *
 * For readiness (orchestrator + DB + Valkey; leadership is NOT gated) use
 * GET /api/health/ready — that is the endpoint a load balancer or a Kubernetes
 * readinessProbe wants, precisely because this one ignores dependencies.
 * For per-component (DB/Valkey/orchestrator/…) detail use GET /api/health/components.
 */

import type { RequestHandler } from './$types';
import { config, features } from '$lib/server/config.js';
import { enforce } from '$lib/server/api/mount.js';
import { buildComponentHealth } from '$lib/server/health/component-health.js';
import { localsIsAdmin } from '$lib/server/auth/locals-admin.js';

// authz: public — liveness probe, must be reachable by orchestrators pre-auth (Docker, K8s)
const LIVENESS_BODY = JSON.stringify({ status: 'pass' });

interface HealthDetail {
    lumastra: {
        ffmpegPath: string | null;
        transcodeDir: string | null;
        ok: boolean;
        issues: string[];
    };
    auth: {
        deviceAuth: boolean;
        userPats: boolean;
        jwtConfigured: boolean;
        ok: boolean;
        issues: string[];
    };
}

/** Config-only (no I/O) snapshot of the FFmpeg + auth feature-flag checks. */
function buildHealthDetail(): HealthDetail {
    const lumastraIssues: string[] = [];
    if (!config.FFMPEG_PATH) {
        lumastraIssues.push('FFMPEG_PATH not set — local file playback will be broken');
    }

    const authIssues: string[] = [];
    if (config.FEATURE_DEVICE_AUTH && !features.deviceAuth) {
        authIssues.push('FEATURE_DEVICE_AUTH=true requires JWT_SECRET to be set');
    }
    if (config.FEATURE_USER_PATS && !features.userPats) {
        authIssues.push('FEATURE_USER_PATS=true requires JWT_SECRET to be set');
    }

    return {
        lumastra: {
            ffmpegPath: config.FFMPEG_PATH || null,
            transcodeDir: config.FFMPEG_TRANSCODE_DIR || null,
            ok: lumastraIssues.length === 0,
            issues: lumastraIssues,
        },
        auth: {
            deviceAuth: features.deviceAuth,
            userPats: features.userPats,
            jwtConfigured: !!config.JWT_SECRET,
            ok: authIssues.length === 0,
            issues: authIssues,
        },
    };
}

export const GET: RequestHandler = async (event) => {
    // Liveness must never depend on a well-formed event — probes may call this
    // with a minimal/empty context. Guard the url access so the no-detail path
    // always returns 200.
    const showDetail = event?.url?.searchParams.get('detail') === 'true';
    if (!showDetail) {
        return new Response(LIVENESS_BODY, {
            status: 200,
            headers: { 'Content-Type': 'application/health+json' },
        });
    }

    // Detail leaks config topology — admin session or metrics:read scope only.
    // Same gating pattern as /api/health/ready and /api/health/components.
    const isAdmin = localsIsAdmin(event.locals);
    if (!isAdmin) {
        const scopeResult = await enforce({ kind: 'scope', anyOf: ['metrics:read'] }, event);
        if (scopeResult !== null) {
            return new Response(LIVENESS_BODY, {
                status: 200,
                headers: { 'Content-Type': 'application/health+json' },
            });
        }
    }

    const components = await buildComponentHealth();
    const postgres = components.database as { status: string } | undefined;
    const valkey = components.valkey as { status: string } | undefined;
    const degraded = postgres?.status !== 'pass' || valkey?.status !== 'pass';

    return new Response(
        JSON.stringify({
            status: 'pass',
            healthy: !degraded,
            degraded,
            setupMode: false,
            services: {
                jellyfin: features.jellyfin ? 'pass' : 'n/a',
                postgres: postgres?.status ?? 'fail',
                valkey: valkey?.status ?? 'fail',
            },
            timestamp: new Date().toISOString(),
            uptime: process.uptime(),
            detail: buildHealthDetail(),
        }),
        {
            status: 200,
            headers: { 'Content-Type': 'application/health+json' },
        },
    );
};
