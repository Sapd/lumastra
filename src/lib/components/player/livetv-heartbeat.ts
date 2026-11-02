// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * LiveTV Heartbeat Client
 *
 * Sends periodic heartbeats to keep the viewer's stream proxy session alive.
 * Created when starting LiveTV playback, destroyed when stopping.
 *
 * Uses the heartbeat interval returned by the session start response.
 *
 * Uses WorkerTimer so heartbeats keep firing even when Safari throttles
 * background tabs.
 */

import { maintainPlaybackGrant } from '$lib/utils/playback-grant.js';
import type { PlaybackSessionStartResponse } from '$lib/schemas/livetv-playback-sessions.js';
import { WorkerTimer } from '$lib/utils/worker-timer';
import { leaveChannel, sendHeartbeat as apiSendHeartbeat } from '$lib/api/livetv-playback';
import { apiUrl } from '$lib/shared/api-urls.js';
import type { LiveTvFailureInfo } from '$lib/api/livetv-failure-problem.js';

const FAILURE_THRESHOLD = 3;
const TIMER_ID = 'livetv-heartbeat';

export class LiveTvHeartbeat {
    private workerTimer: WorkerTimer | null = null;
    private ended = false;
    private consecutiveFailures = 0;
    private heartbeatLostFired = false;
    private readonly abortController = new AbortController();

    private readonly stopGrantRenewal: () => void;

    constructor(
        private readonly startInfo: PlaybackSessionStartResponse,
        private readonly intervalMs: number = startInfo.reporting.intervalMs,
        private readonly onHeartbeatLost?: () => void,
        private readonly onHeartbeatRestored?: () => void,
        private readonly onKicked?: () => void,
        /**
         * The channel itself failed (410 with reason 'failed'): not a takeover. `failure` is
         * undefined when the body carried no taxonomy code. Without this handler the end is
         * reported through `onHeartbeatLost`.
         */
        private readonly onFailed?: (failure: LiveTvFailureInfo | undefined) => void,
        onRenew?: () => void | Promise<void>,
    ) {
        this.stopGrantRenewal = maintainPlaybackGrant(startInfo, onRenew);
        this.start();
    }

    private start(): void {
        // Send first heartbeat immediately, then on interval via WorkerTimer
        // (WorkerTimer is background-tab-resilient — Safari won't throttle it)
        void this.sendHeartbeat();
        this.workerTimer = new WorkerTimer();
        this.workerTimer.start(TIMER_ID, () => void this.sendHeartbeat(), this.intervalMs);
    }

    private async sendHeartbeat(): Promise<void> {
        try {
            const result = await apiSendHeartbeat(
                this.startInfo.reporting.href,
                this.abortController.signal,
            );
            if (this.abortController.signal.aborted || this.ended) return;
            if (result.status === 410) {
                // Kicked by priority enforcement — stop immediately, no retry
                this.stop();
                this.ended = true;
                if (result.reason === 'evicted') this.onKicked?.();
                else if (result.reason === 'failed' && this.onFailed) this.onFailed(result.failure);
                // superseded / left / expired: the session is over but not by a takeover, so
                // surface it instead of leaving a dead stream behind.
                else this.onHeartbeatLost?.();
                return;
            }
            if (result.status === 404) {
                this.stop();
                this.ended = true;
                this.onHeartbeatLost?.();
                return;
            }
            if (result.error) {
                throw new Error(`Heartbeat failed: ${result.status}`);
            }
            if (this.heartbeatLostFired) {
                this.onHeartbeatRestored?.();
            }
            this.consecutiveFailures = 0;
            this.heartbeatLostFired = false;
        } catch (err) {
            // Ignore aborted fetches — these are intentional cancellations from destroy()
            if (
                this.abortController.signal.aborted ||
                this.ended ||
                (err instanceof Error && err.name === 'AbortError')
            )
                return;
            this.consecutiveFailures++;
            if (
                this.consecutiveFailures >= FAILURE_THRESHOLD &&
                !this.heartbeatLostFired &&
                this.onHeartbeatLost
            ) {
                this.heartbeatLostFired = true;
                this.onHeartbeatLost();
            }
        }
    }

    /**
     * Stop heartbeat timer without sending leave or aborting in-flight requests.
     * Used internally when kicked — the calling component handles cleanup.
     */
    stop(): void {
        this.stopGrantRenewal();
        this.workerTimer?.dispose();
        this.workerTimer = null;
    }

    /**
     * Stop heartbeats and send leave request via fetch.
     * Use this for programmatic cleanup (e.g., player stop).
     */
    async destroy(): Promise<void> {
        if (this.abortController.signal.aborted) return;
        // Abort any in-flight heartbeat fetch before it can complete and
        // trigger server-side auto-rejoin on the old channel.
        this.stopGrantRenewal();
        this.ended = true;
        this.abortController.abort();
        this.workerTimer?.dispose();
        this.workerTimer = null;
        try {
            await leaveChannel(this.startInfo.playbackSessionId);
        } catch {
            // Leave failure is non-fatal — proxy auto-leaves after 30s timeout
        }
    }

    /**
     * Stop heartbeats and send leave via sendBeacon (fire-and-forget).
     * Use this during page unload (beforeunload event) where fetch may be cancelled.
     */
    destroyViaBeacon(): void {
        if (this.abortController.signal.aborted) return;
        this.stopGrantRenewal();
        this.ended = true;
        this.abortController.abort();
        this.workerTimer?.dispose();
        this.workerTimer = null;
        // sendBeacon sends POST (not DELETE), so the leave endpoint also handles POST
        navigator.sendBeacon(
            apiUrl(
                'internal',
                `/livetv/playback-sessions/${encodeURIComponent(this.startInfo.playbackSessionId)}/leave`,
            ),
        );
    }
}
