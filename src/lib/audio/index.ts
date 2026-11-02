// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

export type {
    AudioBackend,
    AudioBackendCallbacks,
    BackendInitOptions,
    MediaSessionActions,
    TrackMetadata,
    TimeUpdateInfo,
    CrossfadeProgressInfo,
    CrossfadeDebugInfo,
    CrossfadeOptions,
    GaplessAdvanceCommittedInfo,
    GaplessAdvanceRequest,
    PlaybackRateOptions,
    PlayOptions,
    PlatformType,
    ReloadSrcOptions,
} from './types';

export { DEFAULT_GAPLESS_LEAD_MS, DEFAULT_GAPLESS_PREWARM_MS } from './types';

export { MediaPlaybackError } from './audio-element-helpers';

export { detectPlatform } from './detect-platform';

import type { AudioBackend, PlatformType } from './types';
import { detectPlatform } from './detect-platform';
import { isSafariDesktop } from './detect-platform';

/**
 * Create the appropriate audio backend for the current platform.
 *
 * Platform routing:
 * - Safari desktop → SafariAudioBackend (two <audio> elements, .volume crossfade)
 *     Safari's MediaElementAudioSourceNode has unfixed bugs that permanently corrupt audio.
 * - iOS → PlainAudioBackend (single <audio>, no crossfade)
 * - Desktop (Chrome/Firefox/Edge) → WebAudioBackend (A/B deck, Web Audio API crossfade)
 * - Android → WebAudioBackend with shadow audio (for background playback)
 *
 * @param override - Force a specific platform (for testing or user preference).
 */
export async function createAudioBackend(override?: PlatformType): Promise<AudioBackend> {
    const platform = override ?? detectPlatform();

    if (platform === 'ios') {
        const { PlainAudioBackend } = await import('./plain-audio-backend');
        return new PlainAudioBackend();
    }

    // Safari desktop: avoid Web Audio API entirely
    if (!override && isSafariDesktop()) {
        const { SafariAudioBackend } = await import('./safari-audio-backend');
        return new SafariAudioBackend();
    }

    // Desktop (Chrome/Firefox/Edge) and Android use Web Audio backend.
    const { WebAudioBackend } = await import('./web-audio-backend');
    return new WebAudioBackend({ useShadowAudio: platform === 'android' });
}

/**
 * Create the audio backend for the AUDIOBOOK player.
 *
 * Differs from {@link createAudioBackend} in exactly one place, and that place
 * is the decision prototype 4a forced.
 *
 * Desktop and Android already have two decks and a way to silence one, so they
 * reach a 0 ms file-boundary join through the same backends music uses. iOS
 * does not: `PlainAudioBackend` is a single bare `<audio>` element, and the
 * obvious second lever — `element.volume` — is a documented hardware-only no-op
 * there. A `GainNode` is not; the constraint is on the element property, not on
 * Web Audio. So iOS was given the same backend with a minimal two-deck gain
 * graph switched on, rather than being promoted to `WebAudioBackend`.
 *
 * ## That graph is now OFF, and this is the human answer 4a was waiting for
 *
 * Measured on a real device 2026-08-04: with the graph on, sending the app to
 * the iOS home screen stops playback. That is the failure the plain path exists
 * to avoid, and the reason was written down before it was observed — a single
 * bare `<audio>` element is *why* iOS background playback is reliable here, and
 * `createMediaElementSource` captures it, routing every sample through an
 * `AudioContext` that iOS suspends on background. `resume()` cannot save it:
 * WebKit will not resume a context without a user gesture, and there is no
 * gesture available to a backgrounded app.
 *
 * The trade this reverses was a 21 ms+ seam at each file boundary (~9 minutes
 * apart, 87% of books are multi-file) against background playback working at
 * all. Background playback wins: a seam is a blemish on a feature that works,
 * and a book that stops when you lock your phone is not a usable audiobook
 * player. iOS now takes the cold-start boundary, exactly as
 * {@link PlainAudioBackend} degrades when the context cannot be constructed.
 *
 * Do not re-enable this without a real-device background test. Nothing in the
 * unit suite can catch the regression — `AudioContext` in jsdom/happy-dom never
 * gets suspended by an OS that isn't there.
 */
export async function createAudiobookBackend(override?: PlatformType): Promise<AudioBackend> {
    const platform = override ?? detectPlatform();

    if (platform === 'ios') {
        const { PlainAudioBackend } = await import('./plain-audio-backend');
        return new PlainAudioBackend();
    }

    return createAudioBackend(override);
}
