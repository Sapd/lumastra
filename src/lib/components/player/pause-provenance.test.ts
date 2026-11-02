// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import {
    adoptsPauseAsUserIntent,
    buildTransportDetail,
    classifyPause,
} from './pause-provenance.js';

describe('classifyPause', () => {
    it('attributes a pause inside the restart window to teardown', () => {
        // tryStartRestart()..finishRestart() detaches the element, which fires a
        // native `pause`. Benign, and the reason a raw `pause` in a timeline
        // cannot be read as evidence of a wedge.
        expect(classifyPause({ restarting: true, pausedByUser: false, ended: false })).toBe(
            'restart-teardown',
        );
    });

    it('prefers teardown over every other reading while restarting', () => {
        expect(classifyPause({ restarting: true, pausedByUser: true, ended: true })).toBe(
            'restart-teardown',
        );
    });

    it('attributes a pause at end of media to ended', () => {
        expect(classifyPause({ restarting: false, pausedByUser: false, ended: true })).toBe(
            'ended',
        );
    });

    it('attributes a user-initiated pause to the user', () => {
        expect(classifyPause({ restarting: false, pausedByUser: true, ended: false })).toBe('user');
    });

    it('flags a pause nobody asked for as involuntary', () => {
        // THE case worth catching: outside a restart, not the user, not the end.
        // updatePlaybackIntent() derives intent from pausedByUser, so intent
        // stays "playing" here — the stall dead-man then arms against an element
        // that is simply paused and burns the whole rebuild ladder to terminal.
        expect(classifyPause({ restarting: false, pausedByUser: false, ended: false })).toBe(
            'involuntary',
        );
    });
});

describe('classifyPause: our own source reload', () => {
    it('attributes a pause from a seek-reset source reload to the reload', () => {
        // PlaybackManager.resetForSeek() pauses the element itself and resumes
        // it on loadedmetadata. Not the user, and not a mystery either.
        expect(
            classifyPause({
                restarting: false,
                pausedByUser: false,
                ended: false,
                sourceReload: true,
            }),
        ).toBe('source-reload');
    });
});

describe('adoptsPauseAsUserIntent', () => {
    const base = {
        restarting: false,
        pausedByUser: false,
        ended: false,
        sourceReload: false,
        inWatchParty: false,
    };

    it('adopts a pause from outside the player UI as the user pausing', () => {
        // iPad Safari, 2026-10-15: the native fullscreen controls (and the OS)
        // pause the element without going through togglePlayPause. Intent stayed
        // "playing", the 6 s stall dead-man fired against the paused element and
        // the recovery nudge called play() — the video resumed by itself.
        expect(adoptsPauseAsUserIntent(base)).toBe(true);
    });

    it('leaves a pause the player UI already recorded alone', () => {
        expect(adoptsPauseAsUserIntent({ ...base, pausedByUser: true })).toBe(false);
    });

    it('does not adopt restart teardown, end of media or our own source reload', () => {
        expect(adoptsPauseAsUserIntent({ ...base, restarting: true })).toBe(false);
        expect(adoptsPauseAsUserIntent({ ...base, ended: true })).toBe(false);
        // The seek reset resumes on its own, and a dead stream behind it still
        // needs the seek watchdog, which only runs while intent is "playing".
        expect(adoptsPauseAsUserIntent({ ...base, sourceReload: true })).toBe(false);
    });

    it('does not adopt a pause in a watch party, where the sync owns play/pause', () => {
        expect(adoptsPauseAsUserIntent({ ...base, inWatchParty: true })).toBe(false);
    });
});

describe('buildTransportDetail', () => {
    it('carries provenance alongside the element state that corroborates it', () => {
        expect(
            buildTransportDetail({
                restarting: false,
                pausedByUser: false,
                ended: false,
                paused: true,
                readyState: 4,
            }),
        ).toEqual({ provenance: 'involuntary', paused: true, readyState: 4 });
    });

    it('omits element fields that are unavailable rather than sending undefined', () => {
        // The media element can be gone by the time a teardown pause lands; an
        // explicit undefined would serialize as a null field and read as "we
        // measured this and it was empty".
        expect(
            buildTransportDetail({
                restarting: true,
                pausedByUser: false,
                ended: false,
                paused: undefined,
                readyState: undefined,
            }),
        ).toEqual({ provenance: 'restart-teardown' });
    });
});
