// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Favicon Controller
 *
 * Manages dynamic favicon changes based on video playback state.
 * Creates a pulsing animation effect when video is playing.
 */

// Animation configuration
const PULSE_INTERVAL_MS = 2500; // Full cycle duration (2.5 seconds for calm breathing)
const PULSE_FRAMES = 10; // Number of frames in the pulse animation
const MIN_OPACITY = 0.5;
const MAX_OPACITY = 1.0;

// State
let originalFaviconUrl: string | null = null;
let animationInterval: ReturnType<typeof setInterval> | null = null;
let currentFrame = 0;
let animatedFrames: string[] = [];
let linkElement: HTMLLinkElement | null = null;
let isInitialized = false;

/**
 * Initialize the favicon controller by capturing the original favicon
 */
export function initFaviconController(): void {
    if (typeof document === 'undefined' || isInitialized) return;

    linkElement = document.querySelector('link[rel="icon"]');
    if (linkElement) {
        originalFaviconUrl = linkElement.href;
        isInitialized = true;
    }
}

/**
 * Generate animated frames from the original favicon
 */
async function generateAnimatedFrames(): Promise<void> {
    if (!originalFaviconUrl || animatedFrames.length > 0) return;

    // Capture URL to satisfy TypeScript (narrowing doesn't work inside Promise callback)
    const faviconUrl = originalFaviconUrl;

    return new Promise((resolve) => {
        const img = new Image();
        img.crossOrigin = 'anonymous';
        img.onload = () => {
            const canvas = document.createElement('canvas');
            const ctx = canvas.getContext('2d');
            if (!ctx) {
                resolve();
                return;
            }

            // Use 32x32 for favicon (standard size)
            const size = 32;
            canvas.width = size;
            canvas.height = size;

            // Generate frames with varying opacity for pulse effect
            for (let i = 0; i < PULSE_FRAMES; i++) {
                ctx.clearRect(0, 0, size, size);

                // Calculate opacity using sine wave for smooth pulsing
                const progress = i / PULSE_FRAMES;
                const opacity =
                    MIN_OPACITY +
                    (MAX_OPACITY - MIN_OPACITY) * (0.5 + 0.5 * Math.sin(progress * Math.PI * 2));

                ctx.globalAlpha = opacity;
                ctx.drawImage(img, 0, 0, size, size);

                animatedFrames.push(canvas.toDataURL('image/png'));
            }

            resolve();
        };
        img.onerror = () => resolve();
        img.src = faviconUrl;
    });
}

/**
 * Start the pulsing animation (call when video starts playing)
 */
export async function startPlayingAnimation(): Promise<void> {
    if (typeof document === 'undefined') return;

    // Initialize if not already done
    if (!isInitialized) {
        initFaviconController();
    }

    // Generate frames if needed
    if (animatedFrames.length === 0) {
        await generateAnimatedFrames();
    }

    // Don't start if already animating or no frames
    if (animationInterval || animatedFrames.length === 0) return;

    // Ensure we have the link element
    if (!linkElement) {
        linkElement = document.querySelector('link[rel="icon"]');
    }
    if (!linkElement) return;

    currentFrame = 0;

    animationInterval = setInterval(() => {
        if (!linkElement || animatedFrames.length === 0) return;

        linkElement.href = animatedFrames[currentFrame];
        currentFrame = (currentFrame + 1) % PULSE_FRAMES;
    }, PULSE_INTERVAL_MS / PULSE_FRAMES);
}

/**
 * Stop the animation and restore original favicon (call when video pauses/stops)
 */
export function stopPlayingAnimation(): void {
    if (animationInterval) {
        clearInterval(animationInterval);
        animationInterval = null;
    }

    // Restore original favicon
    if (linkElement && originalFaviconUrl) {
        linkElement.href = originalFaviconUrl;
    }
}

/**
 * Clean up and restore original state (call when leaving player)
 */
export function cleanupFaviconController(): void {
    stopPlayingAnimation();
    // Keep the original URL cached for potential re-use
}

/**
 * Update the document title with playback state indicator
 */
export function updateTitlePlaybackState(isPlaying: boolean, mediaTitle?: string): void {
    if (typeof document === 'undefined') return;

    // Remove any existing playback indicator
    let title = document.title.replace(/^[▶⏸]\s*/, '');

    // If we have a media title, use it
    if (mediaTitle) {
        title = mediaTitle;
    }

    // Add playback indicator
    const indicator = isPlaying ? '▶' : '⏸';
    document.title = `${indicator} ${title}`;
}

/**
 * Restore the original document title (call when leaving player)
 */
export function restoreOriginalTitle(originalTitle: string): void {
    if (typeof document === 'undefined') return;
    document.title = originalTitle;
}

/**
 * Combined function to update both favicon and title based on playback state
 */
export async function setPlaybackState(isPlaying: boolean, mediaTitle?: string): Promise<void> {
    if (isPlaying) {
        await startPlayingAnimation();
    } else {
        stopPlayingAnimation();
    }

    if (mediaTitle !== undefined) {
        updateTitlePlaybackState(isPlaying, mediaTitle);
    }
}
