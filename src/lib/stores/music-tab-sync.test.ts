// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Coordinators in one process stand in for tabs: BroadcastChannel delivers
 * between distinct instances of the same name, never to the sender.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import {
    createMusicTabSync,
    compareClaims,
    HEARTBEAT_EXPIRY_MS,
    EXPIRY_PROBE_MS,
    HEARTBEAT_INTERVAL_MS,
    MUSIC_TAB_CHANNEL,
    type MusicTabMessage,
    type MusicTabSync,
} from './music-tab-sync';

/** Let queued BroadcastChannel messages deliver (not a timer: safe under fake timers). */
const deliver = async (): Promise<void> => {
    for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve));
};

interface FakeTab {
    sync: MusicTabSync;
    state: { playing: boolean; positionMs: number };
    onOther: ReturnType<typeof vi.fn>;
    onIdle: ReturnType<typeof vi.fn>;
}

const created: MusicTabSync[] = [];
const channels: BroadcastChannel[] = [];

function tab(playing = false, positionMs = 0): FakeTab {
    const state = { playing, positionMs };
    const onOther = vi.fn(() => {
        state.playing = false;
    });
    const onIdle = vi.fn();
    const sync = createMusicTabSync({
        getState: () => ({ isPlaying: state.playing, trackId: 't1', positionMs: state.positionMs }),
        onOtherTabPlaying: onOther,
        onOtherTabIdle: onIdle,
    });
    created.push(sync);
    return { sync, state, onOther, onIdle };
}

/** A raw channel: to inject hand-made messages. */
function rawChannel(): BroadcastChannel {
    const channel = new BroadcastChannel(MUSIC_TAB_CHANNEL);
    channels.push(channel);
    return channel;
}

afterEach(() => {
    vi.useRealTimers();
    for (const sync of created.splice(0)) sync.destroy();
    for (const channel of channels.splice(0)) channel.close();
});

describe('music tab sync', () => {
    it('orders claims by time, then tab id', () => {
        expect(compareClaims({ ts: 2, tabId: 'a' }, { ts: 1, tabId: 'z' })).toBeGreaterThan(0);
        expect(compareClaims({ ts: 1, tabId: 'b' }, { ts: 1, tabId: 'a' })).toBeGreaterThan(0);
        expect(compareClaims({ ts: 1, tabId: 'a' }, { ts: 1, tabId: 'a' })).toBe(0);
    });

    it('a lone tab owns the snapshot and finds no owner', async () => {
        const a = tab();
        await deliver();
        expect(a.sync.ownsSnapshot()).toBe(true);
        await expect(a.sync.queryOwner(50)).resolves.toBeNull();
        expect(a.sync.ownsSnapshot()).toBe(true);
    });

    it('a claim stops the other tab and moves ownership', async () => {
        const a = tab(true);
        a.sync.announcePlaying();
        const b = tab();
        await deliver();
        b.state.playing = true;
        b.sync.announcePlaying();
        await deliver();

        expect(a.onOther).toHaveBeenCalledTimes(1);
        expect(a.sync.ownsSnapshot()).toBe(false);
        expect(b.sync.ownsSnapshot()).toBe(true);
        // The claimant is never told about its own message.
        expect(b.onOther).not.toHaveBeenCalled();
    });

    it('crossed claims end with exactly one tab playing', async () => {
        const a = tab(true);
        const b = tab(true);
        await deliver();
        // Both claim before either hears the other.
        a.sync.announcePlaying();
        b.sync.announcePlaying();
        await deliver();

        // B's claim is the newer one (later, or same ms and larger id) — or
        // A's; either way exactly one side yields.
        expect(a.onOther.mock.calls.length + b.onOther.mock.calls.length).toBe(1);
        expect([a.sync.ownsSnapshot(), b.sync.ownsSnapshot()].filter(Boolean)).toHaveLength(1);
    });

    it('an older claim arriving late is ignored', async () => {
        const a = tab(true);
        a.sync.announcePlaying();
        rawChannel().postMessage({
            type: 'playing',
            tabId: 'stale-tab',
            claim: { ts: 1, tabId: 'stale-tab' },
        } satisfies MusicTabMessage);
        await deliver();
        expect(a.onOther).not.toHaveBeenCalled();
        expect(a.sync.ownsSnapshot()).toBe(true);
    });

    it('the owner answers with its live state; the asker stops owning', async () => {
        const a = tab(true, 61_500);
        a.sync.announcePlaying();
        const b = tab();
        await expect(b.sync.queryOwner()).resolves.toEqual({
            isPlaying: true,
            trackId: 't1',
            positionMs: 61_500,
        });
        expect(b.sync.ownsSnapshot()).toBe(false);
    });

    it('a paused owner still answers — it holds the live position', async () => {
        const a = tab(true, 5_000);
        a.sync.announcePlaying();
        a.state.playing = false;
        a.sync.announceIdle();
        const b = tab();
        await expect(b.sync.queryOwner()).resolves.toMatchObject({
            isPlaying: false,
            positionMs: 5_000,
        });
    });

    it('a tab that never played does not answer, and learns the owner on startup', async () => {
        const a = tab(true);
        a.sync.announcePlaying();
        const idle = tab();
        await deliver();
        // Learned from its startup query: not the owner, so it must not write.
        expect(idle.sync.ownsSnapshot()).toBe(false);

        a.sync.destroy(); // the owner goes away
        const c = tab();
        // The idle tab has no claim of its own, so it does not pose as owner.
        await expect(c.sync.queryOwner(80)).resolves.toBeNull();
    });

    it('idle reaches the others only from the tab that holds the claim', async () => {
        const a = tab();
        const b = tab();
        await deliver();
        a.sync.announceIdle(); // never claimed: nothing to retract
        await deliver();
        expect(b.onIdle).not.toHaveBeenCalled();

        a.sync.announcePlaying();
        await deliver();
        a.sync.announceIdle();
        await deliver();
        expect(b.onIdle).toHaveBeenCalledTimes(1);
    });

    it('closing a playing tab retracts its claim', async () => {
        const a = tab(true);
        const b = tab();
        await deliver();
        a.sync.announcePlaying();
        await deliver();
        a.sync.destroy();
        await deliver();
        expect(b.onIdle).toHaveBeenCalledTimes(1);
    });

    it('a silent owner (crashed, discarded) stops showing as playing elsewhere', async () => {
        vi.useFakeTimers({
            toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'],
        });
        const b = tab();
        const owner = rawChannel();
        const claim = { ts: Date.now() + 1_000_000, tabId: 'owner' };
        owner.postMessage({ type: 'playing', tabId: 'owner', claim } satisfies MusicTabMessage);
        await deliver();
        expect(b.onOther).toHaveBeenCalledTimes(1);

        // Heartbeats keep the hint up past the expiry window.
        vi.advanceTimersByTime(HEARTBEAT_EXPIRY_MS - 5_000);
        owner.postMessage({ type: 'heartbeat', tabId: 'owner', claim } satisfies MusicTabMessage);
        await deliver();
        vi.advanceTimersByTime(HEARTBEAT_EXPIRY_MS - 5_000);
        expect(b.onIdle).not.toHaveBeenCalled();

        // Then silence: no idle message ever comes, and the probe goes
        // unanswered.
        vi.advanceTimersByTime(5_000);
        await deliver();
        vi.advanceTimersByTime(EXPIRY_PROBE_MS + 1);
        expect(b.onIdle).toHaveBeenCalledTimes(1);
    });

    it('the claiming tab heartbeats while it plays', async () => {
        vi.useFakeTimers({
            toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'],
        });
        const a = tab(true);
        const seen: MusicTabMessage[] = [];
        rawChannel().onmessage = (e: MessageEvent<MusicTabMessage>) => seen.push(e.data);
        a.sync.announcePlaying();
        vi.advanceTimersByTime(HEARTBEAT_INTERVAL_MS);
        await deliver();
        expect(seen.map((m) => m.type)).toEqual(['playing', 'heartbeat']);

        a.sync.announceIdle();
        vi.advanceTimersByTime(HEARTBEAT_INTERVAL_MS * 2);
        await deliver();
        expect(seen.map((m) => m.type)).toEqual(['playing', 'heartbeat', 'idle']);
    });

    it('live state reaches the other tabs only from the current owner', async () => {
        const received: unknown[] = [];
        const owner = tab(true);
        const other = createMusicTabSync<{ pos: number }>({
            getState: () => ({ isPlaying: false, trackId: null, positionMs: 0 }),
            onOtherTabPlaying: () => {},
            onOtherTabIdle: () => {},
            onOwnerState: (state) => received.push(state),
        });
        created.push(other as unknown as MusicTabSync);
        await deliver();

        // Not claimed yet: nothing is sent.
        (owner.sync as MusicTabSync<{ pos: number }>).broadcastState({ pos: 1 });
        await deliver();
        expect(received).toEqual([]);

        owner.sync.announcePlaying();
        (owner.sync as MusicTabSync<{ pos: number }>).broadcastState({ pos: 2 });
        await deliver();
        expect(received).toEqual([{ pos: 2 }]);

        // A stale claim's state is ignored once a newer tab owns playback.
        rawChannel().postMessage({
            type: 'playing',
            tabId: 'newer',
            claim: { ts: Date.now() + 1_000_000, tabId: 'newer' },
        } satisfies MusicTabMessage);
        await deliver();
        (owner.sync as MusicTabSync<{ pos: number }>).broadcastState({ pos: 3 });
        await deliver();
        expect(received).toEqual([{ pos: 2 }]);
    });

    it('the owner is told when a tab asks, so it can send its state at once', async () => {
        const onQueried = vi.fn();
        const owner = createMusicTabSync({
            getState: () => ({ isPlaying: true, trackId: 't1', positionMs: 0 }),
            onOtherTabPlaying: () => {},
            onOtherTabIdle: () => {},
            onQueried,
        });
        created.push(owner);
        owner.announcePlaying();
        const asker = tab();
        await asker.sync.queryOwner();
        expect(onQueried).toHaveBeenCalled();
    });

    it('a command from a mirroring tab reaches only the tab holding the claim', async () => {
        const onCommand = vi.fn();
        const owner = createMusicTabSync({
            getState: () => ({ isPlaying: true, trackId: 't1', positionMs: 0 }),
            onOtherTabPlaying: () => {},
            onOtherTabIdle: () => {},
            onCommand,
        });
        created.push(owner);
        const bystanderCommand = vi.fn();
        const bystander = createMusicTabSync({
            getState: () => ({ isPlaying: false, trackId: null, positionMs: 0 }),
            onOtherTabPlaying: () => {},
            onOtherTabIdle: () => {},
            onCommand: bystanderCommand,
        });
        created.push(bystander);
        const mirror = tab();
        await deliver();
        owner.announcePlaying();
        await deliver();

        expect(mirror.sync.sendCommand({ type: 'seek', trackId: 't1', positionMs: 42_000 })).toBe(
            true,
        );
        await deliver();
        expect(onCommand).toHaveBeenCalledWith({ type: 'seek', trackId: 't1', positionMs: 42_000 });
        expect(bystanderCommand).not.toHaveBeenCalled();
        // The owner itself has nobody to command.
        expect(owner.sendCommand({ type: 'seek', trackId: 't1', positionMs: 1 })).toBe(false);
    });

    it('a command aimed at a claim the owner has since lost is dropped', async () => {
        const onCommand = vi.fn();
        const oldOwner = createMusicTabSync({
            getState: () => ({ isPlaying: true, trackId: 't1', positionMs: 0 }),
            onOtherTabPlaying: () => {},
            onOtherTabIdle: () => {},
            onCommand,
        });
        created.push(oldOwner);
        oldOwner.announcePlaying();
        await deliver();
        const staleClaim = { ts: 1, tabId: 'whoever' };
        rawChannel().postMessage({
            type: 'command',
            tabId: 'mirror',
            claim: staleClaim,
            command: { type: 'seek', trackId: 't1', positionMs: 5 },
        } satisfies MusicTabMessage);
        await deliver();
        expect(onCommand).not.toHaveBeenCalled();
    });

    it('a closing owner releases its claim: the others own again and command nobody', async () => {
        const owner = tab(true);
        const other = tab();
        await deliver();
        owner.sync.announcePlaying();
        await deliver();
        expect(other.sync.ownsSnapshot()).toBe(false);

        owner.sync.announceClosed();
        await deliver();

        expect(other.onIdle).toHaveBeenCalled();
        expect(other.sync.ownsSnapshot()).toBe(true);
        expect(other.sync.sendCommand({ type: 'pause' })).toBe(false);
    });

    it('an owner silent past the expiry is treated as gone', async () => {
        vi.useFakeTimers({
            toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'],
        });
        const b = tab();
        rawChannel().postMessage({
            type: 'playing',
            tabId: 'owner',
            claim: { ts: Date.now() + 1_000_000, tabId: 'owner' },
        } satisfies MusicTabMessage);
        await deliver();
        expect(b.sync.ownsSnapshot()).toBe(false);

        vi.advanceTimersByTime(HEARTBEAT_EXPIRY_MS + 1);
        await deliver();
        vi.advanceTimersByTime(EXPIRY_PROBE_MS + 1);
        expect(b.sync.ownsSnapshot()).toBe(true);
        expect(b.sync.sendCommand({ type: 'pause' })).toBe(false);
    });

    it("a playing owner's states keep it alive; silence past the expiry is reported as 'expired'", async () => {
        vi.useFakeTimers({
            toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'],
        });
        const b = tab();
        const owner = rawChannel();
        const claim = { ts: Date.now() + 1_000_000, tabId: 'owner' };
        owner.postMessage({ type: 'playing', tabId: 'owner', claim } satisfies MusicTabMessage);
        await deliver();
        for (let i = 0; i < 4; i++) {
            vi.advanceTimersByTime(HEARTBEAT_EXPIRY_MS - 2_000);
            owner.postMessage({
                type: 'state',
                tabId: 'owner',
                claim,
                state: {},
                playing: true,
            } satisfies MusicTabMessage);
            await deliver();
        }
        expect(b.onIdle).not.toHaveBeenCalled();

        vi.advanceTimersByTime(HEARTBEAT_EXPIRY_MS + 1);
        await deliver();
        vi.advanceTimersByTime(EXPIRY_PROBE_MS + 1);
        expect(b.onIdle).toHaveBeenCalledWith('expired');
    });

    it("a clean close is reported as 'closed', a pause as 'idle'", async () => {
        const a = tab(true);
        const b = tab();
        await deliver();
        a.sync.announcePlaying();
        await deliver();
        a.sync.announceIdle();
        await deliver();
        expect(b.onIdle).toHaveBeenLastCalledWith('idle');
        a.sync.announcePlaying();
        await deliver();
        a.sync.announceClosed();
        await deliver();
        expect(b.onIdle).toHaveBeenLastCalledWith('closed');
    });

    it('an owner that went quiet but answers the probe is kept (sleep/wake, a stalled thread)', async () => {
        vi.useFakeTimers({
            toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'],
        });
        const b = tab();
        const owner = rawChannel();
        const claim = { ts: Date.now() + 1_000_000, tabId: 'owner' };
        owner.onmessage = (e: MessageEvent<MusicTabMessage>) => {
            if (e.data.type === 'who-owns') {
                owner.postMessage({
                    type: 'owner-state',
                    tabId: 'owner',
                    queryId: e.data.queryId,
                    claim,
                    isPlaying: true,
                    trackId: 't1',
                    positionMs: 0,
                } satisfies MusicTabMessage);
            }
        };
        owner.postMessage({ type: 'playing', tabId: 'owner', claim } satisfies MusicTabMessage);
        await deliver();

        vi.advanceTimersByTime(HEARTBEAT_EXPIRY_MS + 1); // expiry → probe
        await deliver(); // probe answered
        vi.advanceTimersByTime(EXPIRY_PROBE_MS + 1);

        expect(b.onIdle).not.toHaveBeenCalled();
        expect(b.sync.ownsSnapshot()).toBe(false);
        expect(b.sync.ownerTabId()).toBe('owner');
    });

    it('a closing tab drops its own claim too (a bfcache restore claims anew)', async () => {
        const a = tab(true);
        const b = tab();
        await deliver();
        a.sync.announcePlaying();
        a.sync.announceClosed();
        await deliver();
        const heard: unknown[] = [];
        const listener = rawChannel();
        listener.onmessage = (e) => heard.push(e.data);
        (a.sync as MusicTabSync<{ x: number }>).broadcastState({ x: 1 });
        await deliver();
        expect(heard).toEqual([]);
        expect(b.sync.ownsSnapshot()).toBe(true);
    });

    it('a closed tab no longer reacts', async () => {
        const a = tab(true);
        const b = tab();
        await deliver();
        a.sync.destroy();
        b.sync.announcePlaying();
        await deliver();
        expect(a.onOther).not.toHaveBeenCalled();
    });
});
