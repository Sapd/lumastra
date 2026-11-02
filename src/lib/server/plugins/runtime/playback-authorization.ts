// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Plugin veto on starting playback.
 *
 * The host already enforces its own stream policy — concurrent limits, IP
 * restriction, play-method rules — inside `enforceStreamPolicy`. This is the
 * extension point beside it: an integration can refuse a stream for a reason
 * the host knows nothing about (a per-library quota, an office-hours rule, a
 * bandwidth budget, a parental schedule).
 *
 * WHERE IT RUNS. Before the session transaction opens, never inside it. The
 * host's own checks hold `SELECT … FOR UPDATE` locks while they count active
 * sessions; calling third-party code under those locks would let one slow
 * plugin stall every other viewer's session start.
 *
 * FAIL-OPEN, deliberately. A gate that throws, hangs or answers nonsense is
 * ignored and playback proceeds. The alternative trades a policy failure for an
 * outage: a limit that stops being enforced is a bad afternoon, a media server
 * that refuses every stream because a plugin is broken is a dead server. A
 * plugin that needs hard enforcement has to be reliable enough to provide it.
 */

import type { IntegrationDefinition, PluginContext } from '@sapd/lumastra-plugin-sdk';
import { registry as taskRegistry } from '$lib/server/tasks/registry.js';
import { buildPluginContext } from '$lib/server/tasks/plugin-context.js';
import { Logger } from '../../utils/logger.js';

const logger = Logger.for('PlaybackAuthorization');

/**
 * Per-gate budget. Short on purpose: this sits in front of the user pressing
 * play, so the whole check has to be imperceptible.
 */
const GATE_TIMEOUT_MS = 2_000;

/** What a gate is asked to judge. */
export interface PlaybackAuthorizationRequest {
    userId: string;
    username: string;
    mediaId: string;
    /** `direct`, `remux`, `transcode` — what the client asked for. */
    playMethod: string;
    deviceId?: string;
    ipAddress?: string;
}

export interface PlaybackVerdict {
    allow: boolean;
    /** Shown to the user when denied. */
    reason?: string;
    /** Which integration refused. Present only on a deny. */
    deniedBy?: string;
}

export interface PlaybackAuthorizationDeps {
    listIntegrations(): IntegrationDefinition[];
    buildCtx(integrationId: string): PluginContext;
}

const defaultDeps: PlaybackAuthorizationDeps = {
    listIntegrations: () => taskRegistry.getAllIntegrations(),
    buildCtx: (id) => buildPluginContext(id),
};

/** Await `p`, resolving to `null` on rejection or timeout. Never rejects. */
function settleWithin<T>(p: Promise<T>, ms: number): Promise<T | null> {
    return new Promise((resolve) => {
        const timer = setTimeout(() => resolve(null), ms);
        (timer as unknown as { unref?: () => void }).unref?.();
        p.then(
            (v) => {
                clearTimeout(timer);
                resolve(v);
            },
            () => {
                clearTimeout(timer);
                resolve(null);
            },
        );
    });
}

/** Only an explicit, well-formed refusal counts as one. */
function isDenial(v: unknown): v is { allow: false; reason?: string } {
    return !!v && typeof v === 'object' && (v as { allow?: unknown }).allow === false;
}

/**
 * Ask every integration that implements `authorizePlayback` whether this stream
 * may start. Any single explicit refusal denies; everything else allows.
 *
 * Gates run sequentially — there are rarely more than one or two, and the first
 * refusal short-circuits the rest, so the common path costs nothing.
 */
export async function authorizePlaybackViaPlugins(
    request: PlaybackAuthorizationRequest,
    deps: PlaybackAuthorizationDeps = defaultDeps,
): Promise<PlaybackVerdict> {
    let gates: IntegrationDefinition[];
    try {
        gates = deps
            .listIntegrations()
            .filter(
                (def) =>
                    typeof (def as { authorizePlayback?: unknown }).authorizePlayback ===
                    'function',
            );
    } catch (err) {
        logger.warn('could not list playback gates — allowing', {
            error: err instanceof Error ? err.message : String(err),
        });
        return { allow: true };
    }
    if (gates.length === 0) return { allow: true };

    for (const def of gates) {
        const authorize = (
            def as unknown as {
                authorizePlayback: (
                    ctx: PluginContext,
                    req: PlaybackAuthorizationRequest,
                ) => Promise<unknown>;
            }
        ).authorizePlayback;

        let verdict: unknown;
        try {
            verdict = await settleWithin(
                Promise.resolve(authorize(deps.buildCtx(def.id), request)),
                GATE_TIMEOUT_MS,
            );
        } catch (err) {
            logger.warn('playback gate threw — allowing', {
                integration: def.id,
                error: err instanceof Error ? err.message : String(err),
            });
            continue;
        }

        if (verdict === null) {
            logger.warn('playback gate failed or timed out — allowing', {
                integration: def.id,
                timeoutMs: GATE_TIMEOUT_MS,
            });
            continue;
        }

        if (isDenial(verdict)) {
            logger.info('playback denied by plugin', {
                integration: def.id,
                userId: request.userId,
                mediaId: request.mediaId,
                reason: verdict.reason,
            });
            return {
                allow: false,
                reason: verdict.reason,
                deniedBy: def.id,
            };
        }
        // Anything that is not an explicit refusal — including a malformed
        // answer — is an allow. Guessing at a plugin's intent is how you get an
        // unexplainable "cannot play" with nothing in the logs.
    }

    return { allow: true };
}
