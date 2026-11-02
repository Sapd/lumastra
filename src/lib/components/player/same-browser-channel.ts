// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// src/lib/components/player/same-browser-channel.ts
//
// Same-browser tab coordination via BroadcastChannel. Used by the player to
// detect "this media is already playing in another tab in this browser"
// before calling `startPlaySession`, so we can negotiate up-front instead of
// learning about it after-the-fact via the server-side supersede.
//
// Round-trip latency on BroadcastChannel is sub-millisecond, so a 200ms
// collection window is generous. There is NO passive heartbeat — request /
// response is the only correct primitive (a tab probing 1s after a passive
// tick would miss the next one).
//
// Cross-replica coordination is out of scope: BroadcastChannel is browser-
// local. Tabs across two browser windows of the same browser ARE covered
// (BroadcastChannel reaches all same-origin contexts in the browser).
//
// Browsers that lack BroadcastChannel (mostly older Safari) get a no-op
// shim — `probe()` resolves immediately with no responses, the player
// proceeds, and the server-side supersede + heartbeat backstop still cover
// the gap. Phase 3 is enhancement-only, not load-bearing.

const CHANNEL_NAME = 'lumastra-playback';
const PROBE_TIMEOUT_MS = 200;

interface ProbeMessage {
    type: 'probe';
    probeId: string;
    mediaId: string;
}

interface ProbeAckMessage {
    type: 'probe_ack';
    probeId: string;
    mediaId: string;
    sessionId: string;
    deviceId: string;
    /** Best-effort label so the conflict modal can name the other tab. */
    tabName?: string;
}

type ChannelMessage = ProbeMessage | ProbeAckMessage;

export interface ProbeResult {
    sessionId: string;
    deviceId: string;
    tabName?: string;
}

/**
 * Active state owned by the SameBrowserChannel — what this tab is currently
 * playing, if anything. Set via `setActive()`. While set, this tab will
 * respond to probes for the same media with a `probe_ack`.
 */
interface ActiveState {
    mediaId: string;
    sessionId: string;
    deviceId: string;
    tabName?: string;
}

export class SameBrowserChannel {
    private channel: BroadcastChannel | null = null;
    private active: ActiveState | null = null;
    /**
     * In-flight probes waiting for acks. Keyed by probeId so concurrent
     * probes (rare — only on rapid open/close) don't cross-pollinate acks.
     */
    private pendingProbes = new Map<string, ProbeAckMessage[]>();

    constructor() {
        if (typeof BroadcastChannel === 'undefined') return;
        this.channel = new BroadcastChannel(CHANNEL_NAME);
        this.channel.onmessage = (e: MessageEvent<ChannelMessage>) => {
            this.handleMessage(e.data);
        };
    }

    private handleMessage(msg: ChannelMessage): void {
        if (msg.type === 'probe') {
            // Only respond if THIS tab is currently playing the same media.
            // Different episode → not a conflict; ignore so the new tab
            // doesn't get a false-positive ack.
            if (!this.active) return;
            if (this.active.mediaId !== msg.mediaId) return;
            const ack: ProbeAckMessage = {
                type: 'probe_ack',
                probeId: msg.probeId,
                mediaId: this.active.mediaId,
                sessionId: this.active.sessionId,
                deviceId: this.active.deviceId,
                ...(this.active.tabName ? { tabName: this.active.tabName } : {}),
            };
            // postMessage can throw InvalidStateError on a channel closed
            // mid-handler (close() racing with a freshly-arrived probe).
            // The ack is best-effort; swallow.
            try {
                this.channel?.postMessage(ack);
            } catch {
                /* peer closed mid-handler */
            }
            return;
        }
        if (msg.type === 'probe_ack') {
            const bucket = this.pendingProbes.get(msg.probeId);
            if (!bucket) return;
            bucket.push(msg);
        }
    }

    /**
     * Mark this tab as the active player for `mediaId`. Other tabs probing
     * for the same media will receive a `probe_ack` from this tab. Call
     * once the player has a live session (after `startPlaySession`).
     */
    setActive(state: ActiveState): void {
        this.active = state;
    }

    /** Clear the active state — call on player teardown / cleanup. */
    clearActive(): void {
        this.active = null;
    }

    /**
     * Broadcast a probe and collect responses for `PROBE_TIMEOUT_MS`. Returns
     * the list of acks received from other tabs that are playing the same
     * media. Empty array = no conflict (or BroadcastChannel unsupported).
     *
     * Resolves only after the timeout window — this is intentional. We can't
     * resolve early on first-ack because in-flight messages from later tabs
     * could still arrive within the same event loop cycle.
     */
    async probe(mediaId: string): Promise<ProbeResult[]> {
        if (!this.channel) return [];

        const probeId =
            typeof crypto !== 'undefined' && crypto.randomUUID
                ? crypto.randomUUID()
                : String(Math.random()).slice(2);
        this.pendingProbes.set(probeId, []);

        const probe: ProbeMessage = { type: 'probe', mediaId, probeId };
        try {
            this.channel.postMessage(probe);
        } catch {
            // Channel closed/throwing — degrade to "no conflict found",
            // server supersede + heartbeat backstop are the safety net.
            this.pendingProbes.delete(probeId);
            return [];
        }

        await new Promise((resolve) => setTimeout(resolve, PROBE_TIMEOUT_MS));

        const acks = this.pendingProbes.get(probeId) ?? [];
        this.pendingProbes.delete(probeId);
        return acks.map(({ sessionId, deviceId, tabName }) => ({
            sessionId,
            deviceId,
            ...(tabName ? { tabName } : {}),
        }));
    }

    close(): void {
        this.channel?.close();
        this.channel = null;
        this.active = null;
        this.pendingProbes.clear();
    }
}
