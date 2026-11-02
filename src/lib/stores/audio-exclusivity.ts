// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * At most one long-form audio player may be playing at a time.
 *
 * ## Why this is new code rather than a reuse
 *
 * `preview-audio.svelte.ts` looks like the mechanism for this and is not. It
 * coordinates *previews* — the hero, hover cards, the trailer overlay — and it
 * arbitrates who may be UNMUTED, which is a different question: every preview
 * keeps playing, one of them is audible. `music-player.store.ts` has zero
 * references to it, so music↔preview exclusion does not exist through that
 * mechanism today and music↔audiobook could not have inherited it.
 *
 * Here the loser must actually stop: two 20-hour books, or a book and an album,
 * both decoding and both reporting positions upstream is not a volume problem.
 *
 * ## Across tabs
 *
 * Ownership itself is module-level state and arbitrates within one tab. Each
 * claim is ALSO broadcast to the other tabs of the origin, and a tab that hears
 * one pauses whatever it is playing — so a book started in one tab silences
 * the music (or another book) playing in a second tab: the last thing the
 * listener started wins, wherever it is. Pause, not stop: that tab keeps its
 * place and resumes with one tap.
 *
 * Music vs music is the exception: `music-tab-sync.ts` coordinates that pair
 * with a position hand-off, so a music claim does not pause music here.
 *
 * BroadcastChannel, not Web Locks: nothing is held, so a crashed tab cannot
 * leave a lock behind that silences the next one.
 */

/** Who a claim belongs to. Extend when a third long-form player appears. */
export type AudioOwner = 'music' | 'audiobook';

interface Participant {
    owner: AudioOwner;
    /**
     * Another tab claimed audio: pause if playing. Must be a no-op when not
     * playing. Omitted → this participant ignores other tabs.
     */
    pauseForOtherTab?: () => void;
    /**
     * Stop this player. Must be synchronous-safe to call from another player's
     * start path, and MUST be idempotent — a participant that is already
     * stopped will still be asked.
     */
    stop: () => void;
}

const participants = new Map<AudioOwner, Participant>();
let currentOwner: AudioOwner | null = null;

export const AUDIO_CLAIM_CHANNEL = 'lumastra:audio-claim';

export interface AudioClaimMessage {
    owner: AudioOwner;
    tabId: string;
}

const tabId =
    typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
        ? crypto.randomUUID()
        : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;

let claimChannel: BroadcastChannel | null = null;

/** Open the channel lazily: only once a player registers, and only in a browser. */
function ensureClaimChannel(): BroadcastChannel | null {
    if (claimChannel || typeof BroadcastChannel === 'undefined') return claimChannel;
    claimChannel = new BroadcastChannel(AUDIO_CLAIM_CHANNEL);
    claimChannel.onmessage = (event: MessageEvent<AudioClaimMessage>) => {
        const claim = event.data;
        if (!claim || claim.tabId === tabId) return;
        for (const participant of participants.values()) {
            // music-tab-sync.ts owns music-vs-music (with a position hand-off).
            if (claim.owner === 'music' && participant.owner === 'music') continue;
            participant.pauseForOtherTab?.();
        }
    };
    return claimChannel;
}

function broadcastClaim(owner: AudioOwner): void {
    try {
        ensureClaimChannel()?.postMessage({ owner, tabId } satisfies AudioClaimMessage);
    } catch {
        /* expected: channel closed during teardown */
    }
}

/**
 * Register a player so it can be stopped when another one claims audio.
 *
 * Returns an unregister function. Re-registering the same owner replaces the
 * previous entry rather than stacking, so a store that re-inits (HMR, a
 * remounted player) does not leave a dead stop handler behind that would
 * silence the live one.
 */
export function registerAudioParticipant(
    owner: AudioOwner,
    stop: () => void,
    options: { pauseForOtherTab?: () => void } = {},
): () => void {
    participants.set(owner, { owner, stop, pauseForOtherTab: options.pauseForOtherTab });
    ensureClaimChannel();
    return () => {
        if (participants.get(owner)?.stop === stop) participants.delete(owner);
        if (currentOwner === owner) currentOwner = null;
    };
}

/**
 * Take exclusive audio for `owner`, stopping whoever held it.
 *
 * Call this immediately BEFORE starting playback, not after: stopping the other
 * player first means the two are never simultaneously decoding, and — more
 * importantly on this integration — never both reporting positions to a
 * last-write-wins upstream.
 */
export function claimAudio(owner: AudioOwner): void {
    // Every claim reaches the other tabs, even when this tab already holds
    // audio for `owner`: resuming a book here must still silence another tab.
    broadcastClaim(owner);
    if (currentOwner === owner) return;

    const previous = currentOwner;
    // Set the new owner BEFORE stopping the old one. The stop handler runs
    // synchronously and may itself call releaseAudio(); with the assignment
    // afterwards, that release would clear the owner we are in the middle of
    // establishing and leave nobody holding audio.
    currentOwner = owner;

    if (previous !== null && previous !== owner) {
        participants.get(previous)?.stop();
    }
}

/** Give up audio iff `owner` currently holds it. */
export function releaseAudio(owner: AudioOwner): void {
    if (currentOwner === owner) currentOwner = null;
}

/** Who holds audio right now, or null. */
export function getAudioOwner(): AudioOwner | null {
    return currentOwner;
}

/** Test seam — resets module state between cases. */
export function resetAudioExclusivity(): void {
    participants.clear();
    currentOwner = null;
    claimChannel?.close();
    claimChannel = null;
}
