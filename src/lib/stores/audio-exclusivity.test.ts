// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
    AUDIO_CLAIM_CHANNEL,
    type AudioClaimMessage,
    claimAudio,
    getAudioOwner,
    registerAudioParticipant,
    releaseAudio,
    resetAudioExclusivity,
} from './audio-exclusivity';

describe('audio exclusivity', () => {
    beforeEach(() => resetAudioExclusivity());

    it('stops the previous owner when another player claims audio', () => {
        const stopMusic = vi.fn();
        const stopBook = vi.fn();
        registerAudioParticipant('music', stopMusic);
        registerAudioParticipant('audiobook', stopBook);

        claimAudio('music');
        expect(stopMusic).not.toHaveBeenCalled();

        claimAudio('audiobook');
        expect(stopMusic).toHaveBeenCalledTimes(1);
        expect(stopBook).not.toHaveBeenCalled();
        expect(getAudioOwner()).toBe('audiobook');
    });

    it('does not stop a player that re-claims audio it already holds', () => {
        const stopBook = vi.fn();
        registerAudioParticipant('audiobook', stopBook);
        claimAudio('audiobook');
        claimAudio('audiobook');
        expect(stopBook).not.toHaveBeenCalled();
    });

    it('survives a stop handler that releases audio synchronously', () => {
        // The realistic shape: music's stop() calls releaseAudio('music'). With
        // the owner assigned after the stop instead of before, that release
        // would clear the owner being established and leave nobody holding it.
        registerAudioParticipant('music', () => releaseAudio('music'));
        registerAudioParticipant('audiobook', vi.fn());

        claimAudio('music');
        claimAudio('audiobook');

        expect(getAudioOwner()).toBe('audiobook');
    });

    it('releases only when the caller is the current owner', () => {
        registerAudioParticipant('music', vi.fn());
        registerAudioParticipant('audiobook', vi.fn());
        claimAudio('audiobook');

        releaseAudio('music');
        expect(getAudioOwner()).toBe('audiobook');

        releaseAudio('audiobook');
        expect(getAudioOwner()).toBeNull();
    });

    it('re-registering an owner replaces rather than stacks its stop handler', () => {
        const dead = vi.fn();
        const live = vi.fn();
        registerAudioParticipant('music', dead);
        registerAudioParticipant('music', live);
        registerAudioParticipant('audiobook', vi.fn());

        claimAudio('music');
        claimAudio('audiobook');

        // A remount that stacked handlers would call the stale one, which holds
        // a reference to a destroyed backend.
        expect(dead).not.toHaveBeenCalled();
        expect(live).toHaveBeenCalledTimes(1);
    });

    it('unregistering an owner leaves nothing to stop', () => {
        const stopBook = vi.fn();
        const off = registerAudioParticipant('audiobook', stopBook);
        registerAudioParticipant('music', vi.fn());

        claimAudio('audiobook');
        off();
        claimAudio('music');

        expect(stopBook).not.toHaveBeenCalled();
        expect(getAudioOwner()).toBe('music');
    });

    it('an unregister from a superseded registration does not remove the live one', () => {
        const stale = vi.fn();
        const live = vi.fn();
        const offStale = registerAudioParticipant('music', stale);
        registerAudioParticipant('music', live);
        registerAudioParticipant('audiobook', vi.fn());

        offStale();
        claimAudio('music');
        claimAudio('audiobook');

        expect(live).toHaveBeenCalledTimes(1);
    });
});

describe('audio exclusivity — across tabs', () => {
    const deliver = async (): Promise<void> => {
        for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve));
    };
    let otherTab: BroadcastChannel;
    let heard: AudioClaimMessage[];

    beforeEach(() => {
        resetAudioExclusivity();
        heard = [];
        otherTab = new BroadcastChannel(AUDIO_CLAIM_CHANNEL);
        otherTab.onmessage = (e: MessageEvent<AudioClaimMessage>) => heard.push(e.data);
    });
    afterEach(() => {
        otherTab.close();
        resetAudioExclusivity();
    });

    it('a book started in another tab pauses the music here', async () => {
        const pauseMusic = vi.fn();
        const stopMusic = vi.fn();
        registerAudioParticipant('music', stopMusic, { pauseForOtherTab: pauseMusic });
        claimAudio('music');

        otherTab.postMessage({ owner: 'audiobook', tabId: 'other' } satisfies AudioClaimMessage);
        await deliver();

        expect(pauseMusic).toHaveBeenCalledTimes(1);
        // Paused, not stopped: the tab keeps its place.
        expect(stopMusic).not.toHaveBeenCalled();
    });

    it('music started in another tab pauses the book here', async () => {
        const pauseBook = vi.fn();
        registerAudioParticipant('audiobook', vi.fn(), { pauseForOtherTab: pauseBook });

        otherTab.postMessage({ owner: 'music', tabId: 'other' } satisfies AudioClaimMessage);
        await deliver();

        expect(pauseBook).toHaveBeenCalledTimes(1);
    });

    it('another book pauses the book here', async () => {
        const pauseBook = vi.fn();
        registerAudioParticipant('audiobook', vi.fn(), { pauseForOtherTab: pauseBook });

        otherTab.postMessage({ owner: 'audiobook', tabId: 'other' } satisfies AudioClaimMessage);
        await deliver();

        expect(pauseBook).toHaveBeenCalledTimes(1);
    });

    it('music vs music is left to the music tab coordinator', async () => {
        const pauseMusic = vi.fn();
        registerAudioParticipant('music', vi.fn(), { pauseForOtherTab: pauseMusic });

        otherTab.postMessage({ owner: 'music', tabId: 'other' } satisfies AudioClaimMessage);
        await deliver();

        expect(pauseMusic).not.toHaveBeenCalled();
    });

    it('every claim is broadcast, even when this tab already holds audio', async () => {
        registerAudioParticipant('audiobook', vi.fn());
        claimAudio('audiobook');
        claimAudio('audiobook'); // e.g. resume after pause
        await deliver();

        expect(heard.map((m) => m.owner)).toEqual(['audiobook', 'audiobook']);
    });
});
