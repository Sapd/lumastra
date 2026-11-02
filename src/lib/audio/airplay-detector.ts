// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Per-element AirPlay state detector.
 *
 * Listens to wireless-playback signals on one or more <audio> elements:
 * - `webkitcurrentplaybacktargetiswirelesschanged` (Safari macOS, the reliable signal)
 * - Remote Playback API events (`connect`/`disconnect` on `audio.remote`)
 *
 * Also tracks receiver availability via `webkitplaybacktargetavailabilitychanged`:
 * - Fires automatically after attaching the listener
 * - `availability === 'available'` means at least one receiver is on the network
 *
 * After attaching listeners, fires onChange synchronously with the current
 * aggregate state read directly from the elements. This handles the case
 * where AirPlay is already active when the music player initializes — the
 * change event only fires on transitions and would otherwise leave us blind.
 *
 * Aggregates: active = any element is currently routing wireless.
 *             available = any element reports a reachable receiver.
 *
 * Debounces rapid flips within 200 ms because Safari can fire the change
 * event twice in quick succession on disconnect.
 *
 * Graceful in browsers / environments without the AirPlay APIs: returns
 * false and never emits true.
 */

const DEBOUNCE_MS = 200;

export interface AirPlayDetector {
    /** Attach listeners to each element and fire onChange once with the seed state. */
    start(elements: HTMLAudioElement[]): void;
    /** Remove listeners; subsequent transitions are ignored. */
    stop(): void;
    /** Current aggregate state. */
    isActive(): boolean;
    /** True when at least one AirPlay receiver is reachable on the network. */
    isAvailable(): boolean;
}

/** Narrower view of an audio element used only within this module. */
interface AirPlayAudioHints {
    webkitCurrentPlaybackTargetIsWireless?: boolean;
    remote?: {
        state?: string;
        addEventListener?: (type: string, listener: EventListener) => void;
        removeEventListener?: (type: string, listener: EventListener) => void;
    };
}

/** Cast an HTMLAudioElement to our narrower hint type for reading AirPlay state. */
function asHints(el: HTMLAudioElement): AirPlayAudioHints {
    return el as unknown as AirPlayAudioHints;
}

function readWireless(el: HTMLAudioElement): boolean {
    try {
        const hints = asHints(el);
        if (hints.webkitCurrentPlaybackTargetIsWireless === true) return true;
        if (hints.remote?.state === 'connected') return true;
    } catch {
        /* getter threw — treat as not active */
    }
    return false;
}

export function createAirPlayDetector(
    onActiveChange: (active: boolean) => void,
    onAvailableChange?: (available: boolean) => void,
): AirPlayDetector {
    let watched: HTMLAudioElement[] = [];
    let listeners: Array<{
        el: HTMLAudioElement;
        type: string;
        target: EventTarget;
        handler: EventListener;
    }> = [];
    let lastEmitted: boolean | null = null;
    let debounceTimer: ReturnType<typeof setTimeout> | null = null;
    let stopped = false;

    // Availability tracking
    let lastAvailableEmitted: boolean | null = null;
    let availabilityDebounceTimer: ReturnType<typeof setTimeout> | null = null;
    const availabilityState: WeakMap<HTMLAudioElement, boolean> = new WeakMap();

    function aggregate(): boolean {
        for (const el of watched) {
            if (readWireless(el)) return true;
        }
        return false;
    }

    function aggregateAvailability(): boolean {
        for (const el of watched) {
            if (availabilityState.get(el) === true) return true;
        }
        return false;
    }

    function maybeEmit(): void {
        if (stopped) return;
        const active = aggregate();
        if (active === lastEmitted) return;
        lastEmitted = active;
        onActiveChange(active);
    }

    function maybeEmitAvailability(): void {
        if (stopped) return;
        const available = aggregateAvailability();
        if (available === lastAvailableEmitted) return;
        lastAvailableEmitted = available;
        onAvailableChange?.(available);
    }

    function onChangeEvent(): void {
        if (debounceTimer !== null) clearTimeout(debounceTimer);
        debounceTimer = setTimeout(() => {
            debounceTimer = null;
            maybeEmit();
        }, DEBOUNCE_MS);
    }

    function onAvailabilityEvent(el: HTMLAudioElement, available: boolean): void {
        availabilityState.set(el, available);
        if (availabilityDebounceTimer !== null) clearTimeout(availabilityDebounceTimer);
        availabilityDebounceTimer = setTimeout(() => {
            availabilityDebounceTimer = null;
            maybeEmitAvailability();
        }, DEBOUNCE_MS);
    }

    function attach(el: HTMLAudioElement): void {
        // Safari WebKit-prefixed event fires on the audio element itself.
        const handler: EventListener = () => onChangeEvent();
        try {
            el.addEventListener('webkitcurrentplaybacktargetiswirelesschanged', handler);
            listeners.push({
                el,
                type: 'webkitcurrentplaybacktargetiswirelesschanged',
                target: el,
                handler,
            });
        } catch {
            /* element may not support addEventListener for this type */
        }

        // Standard Remote Playback API: connect / disconnect on audio.remote.
        const hints = asHints(el);
        const remote = hints.remote;
        if (remote && typeof remote.addEventListener === 'function') {
            const remoteHandler: EventListener = () => onChangeEvent();
            try {
                remote.addEventListener('connect', remoteHandler);
                remote.addEventListener('disconnect', remoteHandler);
                listeners.push({
                    el,
                    type: 'connect',
                    target: remote as unknown as EventTarget,
                    handler: remoteHandler,
                });
                listeners.push({
                    el,
                    type: 'disconnect',
                    target: remote as unknown as EventTarget,
                    handler: remoteHandler,
                });
            } catch {
                /* remote may not implement addEventListener */
            }
        }

        // Receiver availability: Safari fires this automatically after addEventListener.
        const availHandler: EventListener = (ev: Event) => {
            const e = ev as Event & { availability?: string };
            onAvailabilityEvent(el, e.availability === 'available');
        };
        try {
            el.addEventListener('webkitplaybacktargetavailabilitychanged', availHandler);
            listeners.push({
                el,
                type: 'webkitplaybacktargetavailabilitychanged',
                target: el,
                handler: availHandler,
            });
        } catch {
            /* element may not support this event */
        }
    }

    return {
        start(elements) {
            stopped = false;
            watched = (elements as HTMLAudioElement[]).filter(Boolean);
            for (const el of watched) attach(el);
            // Synchronous initial emission. lastEmitted is null on first start
            // so this always fires once regardless of value.
            // NOTE: In SSR contexts no elements are passed, so aggregate() returns
            // false and we emit once with false — which is the correct initial state.
            const active = aggregate();
            lastEmitted = active;
            onActiveChange(active);
            // Seed availability as false synchronously. The actual state will
            // arrive shortly via the auto-dispatched webkitplaybacktargetavailabilitychanged
            // event that Safari fires after addEventListener.
            lastAvailableEmitted = false;
            onAvailableChange?.(false);
        },
        stop() {
            stopped = true;
            if (debounceTimer !== null) {
                clearTimeout(debounceTimer);
                debounceTimer = null;
            }
            if (availabilityDebounceTimer !== null) {
                clearTimeout(availabilityDebounceTimer);
                availabilityDebounceTimer = null;
            }
            for (const { type, target, handler } of listeners) {
                try {
                    target.removeEventListener(type, handler);
                } catch {
                    /* ignore */
                }
            }
            listeners = [];
            watched = [];
            lastEmitted = null;
            lastAvailableEmitted = null;
        },
        isActive() {
            return aggregate();
        },
        isAvailable() {
            return aggregateAvailability();
        },
    };
}
