// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/** Requested dialogs stay immediate; only unrequested watch-page work waits. */
export function shouldBootstrapWatchModals(
    isWatch: boolean,
    frameReady: boolean,
    hasOpenModal: boolean,
    params: URLSearchParams,
): boolean {
    return (
        !isWatch ||
        frameReady ||
        hasOpenModal ||
        ['modal', 'actor', 'artist', 'album'].some((key) => params.has(key))
    );
}

/** Release background work after a decoded frame, or a bounded startup failure. */
export function afterFirstVideoFrame(
    doc: Document,
    ready: () => void,
    timeoutMs = 15_000,
): () => void {
    let finished = false;
    let frameVideo: HTMLVideoElement | null = null;
    let frame: number | null = null;
    let animationFrame: number | null = null;
    const timeout = window.setTimeout(finish, timeoutMs);

    function cleanup(): void {
        doc.removeEventListener('playing', onPlaying, true);
        window.clearTimeout(timeout);
        if (frame !== null) frameVideo?.cancelVideoFrameCallback?.(frame);
        if (animationFrame !== null) window.cancelAnimationFrame(animationFrame);
    }
    function finish(): void {
        if (finished) return;
        finished = true;
        cleanup();
        ready();
    }
    function schedule(video: HTMLVideoElement): void {
        if (finished || (frameVideo === video && (frame !== null || animationFrame !== null)))
            return;
        if (frame !== null) frameVideo?.cancelVideoFrameCallback?.(frame);
        if (animationFrame !== null) window.cancelAnimationFrame(animationFrame);
        frameVideo = video;
        if (typeof video.requestVideoFrameCallback === 'function') {
            frame = video.requestVideoFrameCallback(finish);
        } else {
            animationFrame = window.requestAnimationFrame(finish);
        }
    }
    function onPlaying(event: Event): void {
        if (event.target instanceof HTMLVideoElement) schedule(event.target);
    }
    doc.addEventListener('playing', onPlaying, true);
    const playing = [...doc.querySelectorAll('video')].find(
        (video) => !video.paused && video.readyState >= 2,
    );
    if (playing) schedule(playing);
    return () => {
        finished = true;
        cleanup();
    };
}
