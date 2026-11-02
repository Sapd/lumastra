// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Safari Video Element Type Extensions
 *
 * Provides proper typing for Safari/WebKit-only video APIs.
 * These types avoid using `as any` throughout the codebase.
 */

/**
 * Safari audio track interface
 */
export interface SafariAudioTrack {
    language: string;
    label: string;
    enabled: boolean;
}

/**
 * Safari audio track list interface
 */
export interface SafariAudioTrackList {
    readonly length: number;
    [index: number]: SafariAudioTrack;
    addEventListener(type: 'addtrack' | 'removetrack' | 'change', listener: () => void): void;
    removeEventListener(type: 'addtrack' | 'removetrack' | 'change', listener: () => void): void;
}

/**
 * Safari-specific video element extensions
 */
export interface SafariVideoElement extends HTMLVideoElement {
    // Audio track management (Safari native HLS)
    readonly audioTracks?: SafariAudioTrackList;

    // Picture-in-Picture (Safari webkit API)
    webkitSupportsPresentationMode?: (
        mode: 'picture-in-picture' | 'inline' | 'fullscreen',
    ) => boolean;
    webkitSetPresentationMode?: (mode: 'picture-in-picture' | 'inline' | 'fullscreen') => void;
    readonly webkitPresentationMode?: 'picture-in-picture' | 'inline' | 'fullscreen';

    // AirPlay
    webkitShowPlaybackTargetPicker?: () => void;
    readonly webkitCurrentPlaybackTargetIsWireless?: boolean;

    // iOS Safari fullscreen
    webkitEnterFullscreen?: () => void;
}

/**
 * Type guard to cast video element to Safari type
 */
export function asSafariVideo(video: HTMLVideoElement | null): SafariVideoElement | null {
    return video as SafariVideoElement | null;
}

/**
 * Check if video element supports AirPlay
 */
export function supportsAirPlay(video: HTMLVideoElement | null): boolean {
    const safariVideo = asSafariVideo(video);
    return !!safariVideo?.webkitShowPlaybackTargetPicker;
}

/**
 * Check if AirPlay is currently active
 */
export function isAirPlayActive(video: HTMLVideoElement | null): boolean {
    const safariVideo = asSafariVideo(video);
    return safariVideo?.webkitCurrentPlaybackTargetIsWireless ?? false;
}

/**
 * Show AirPlay picker if supported
 */
export function showAirPlayPicker(video: HTMLVideoElement | null): boolean {
    const safariVideo = asSafariVideo(video);
    if (safariVideo?.webkitShowPlaybackTargetPicker) {
        safariVideo.webkitShowPlaybackTargetPicker();
        return true;
    }
    return false;
}

/**
 * Check if video supports Safari Picture-in-Picture
 */
export function supportsSafariPiP(video: HTMLVideoElement | null): boolean {
    const safariVideo = asSafariVideo(video);
    return !!safariVideo?.webkitSupportsPresentationMode?.('picture-in-picture');
}

/**
 * Enter Safari Picture-in-Picture mode
 */
export function enterSafariPiP(video: HTMLVideoElement | null): boolean {
    const safariVideo = asSafariVideo(video);
    if (safariVideo?.webkitSetPresentationMode) {
        safariVideo.webkitSetPresentationMode('picture-in-picture');
        return true;
    }
    return false;
}

/**
 * Exit Safari Picture-in-Picture mode
 */
export function exitSafariPiP(video: HTMLVideoElement | null): boolean {
    const safariVideo = asSafariVideo(video);
    if (safariVideo?.webkitSetPresentationMode) {
        safariVideo.webkitSetPresentationMode('inline');
        return true;
    }
    return false;
}

/**
 * Get Safari Picture-in-Picture state
 */
export function getSafariPiPState(
    video: HTMLVideoElement | null,
): 'picture-in-picture' | 'inline' | 'fullscreen' | null {
    const safariVideo = asSafariVideo(video);
    return safariVideo?.webkitPresentationMode ?? null;
}

/**
 * Check if iOS Safari fullscreen is supported
 */
export function supportsIOSFullscreen(video: HTMLVideoElement | null): boolean {
    const safariVideo = asSafariVideo(video);
    return !!safariVideo?.webkitEnterFullscreen;
}

/**
 * Enter iOS Safari fullscreen
 */
export function enterIOSFullscreen(video: HTMLVideoElement | null): boolean {
    const safariVideo = asSafariVideo(video);
    if (safariVideo?.webkitEnterFullscreen) {
        safariVideo.webkitEnterFullscreen();
        return true;
    }
    return false;
}

/**
 * Get Safari audio tracks
 */
export function getSafariAudioTracks(video: HTMLVideoElement | null): SafariAudioTrack[] {
    const safariVideo = asSafariVideo(video);
    if (!safariVideo?.audioTracks) return [];

    const tracks: SafariAudioTrack[] = [];
    for (let i = 0; i < safariVideo.audioTracks.length; i++) {
        tracks.push(safariVideo.audioTracks[i]);
    }
    return tracks;
}

/**
 * Set enabled audio track by index
 */
export function setSafariAudioTrack(video: HTMLVideoElement | null, index: number): boolean {
    const safariVideo = asSafariVideo(video);
    if (!safariVideo?.audioTracks) return false;

    for (let i = 0; i < safariVideo.audioTracks.length; i++) {
        safariVideo.audioTracks[i].enabled = i === index;
    }
    return true;
}
