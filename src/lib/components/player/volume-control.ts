// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Volume Control Utilities
 *
 * Extracted from VideoPlayer.svelte to provide reusable volume control logic
 * including wheel delta normalization for touchpads vs mouse wheels.
 */

/**
 * Volume control configuration constants
 */
export const VOLUME_CONTROL = {
    /** Volume step for large wheel movements */
    WHEEL_LARGE_STEP: 0.05,
    /** Multiplier for small wheel movements (touchpads) */
    WHEEL_STEP_MULTIPLIER: 0.002,
    /** Delta above which to use large step (distinguishes mouse wheel from touchpad) */
    WHEEL_DELTA_THRESHOLD: 50,
} as const;

export interface VolumeControlConfig {
    /** Current volume (0-1) */
    currentVolume: number;
    /** Minimum volume (default 0) */
    minVolume?: number;
    /** Maximum volume (default 1) */
    maxVolume?: number;
}

export interface WheelVolumeDelta {
    /** The calculated volume delta (positive = up, negative = down) */
    delta: number;
    /** The step size used for this calculation */
    step: number;
}

/**
 * Calculate volume delta from a wheel event, normalizing for touchpads vs mouse wheels.
 *
 * Mouse wheels typically produce deltaY of ~100, while touchpads have smaller values.
 * This function adapts the step size accordingly for smoother control.
 *
 * @param deltaY - The wheel event's deltaY value
 * @returns Object with delta (direction-adjusted) and step (magnitude used)
 */
export function calculateWheelVolumeDelta(deltaY: number): WheelVolumeDelta {
    const absDelta = Math.abs(deltaY);

    // Use large step for mouse wheels (high delta), proportional step for touchpads
    const step =
        absDelta > VOLUME_CONTROL.WHEEL_DELTA_THRESHOLD
            ? VOLUME_CONTROL.WHEEL_LARGE_STEP
            : Math.min(
                  VOLUME_CONTROL.WHEEL_LARGE_STEP,
                  absDelta * VOLUME_CONTROL.WHEEL_STEP_MULTIPLIER,
              );

    // Scroll up = volume up (deltaY is negative when scrolling up)
    const delta = deltaY < 0 ? step : -step;

    return { delta, step };
}

/**
 * Calculate new volume after applying a delta, clamping to valid range.
 *
 * @param currentVolume - Current volume (0-1)
 * @param delta - Volume change to apply (positive or negative)
 * @param minVolume - Minimum volume (default 0)
 * @param maxVolume - Maximum volume (default 1)
 * @returns New volume clamped to [minVolume, maxVolume]
 */
export function clampVolume(
    currentVolume: number,
    delta: number,
    minVolume = 0,
    maxVolume = 1,
): number {
    return Math.max(minVolume, Math.min(maxVolume, currentVolume + delta));
}

/**
 * Create a volume controller with bound configuration.
 *
 * @param config - Volume control configuration
 * @returns Object with methods for handling wheel events
 */
export function createVolumeController(config: VolumeControlConfig) {
    const minVolume = config.minVolume ?? 0;
    const maxVolume = config.maxVolume ?? 1;

    return {
        /**
         * Calculate new volume from wheel event deltaY
         */
        handleWheel(deltaY: number): number {
            const { delta } = calculateWheelVolumeDelta(deltaY);
            return clampVolume(config.currentVolume, delta, minVolume, maxVolume);
        },

        /**
         * Calculate new volume from direct delta
         */
        adjustVolume(delta: number): number {
            return clampVolume(config.currentVolume, delta, minVolume, maxVolume);
        },
    };
}

/**
 * Volume curve types for logarithmic scaling
 */
export type VolumeCurve = 'linear' | 'quadratic' | 'quartic';

/**
 * Type guard to check if a value is a valid VolumeCurve
 */
export function isVolumeCurve(value: unknown): value is VolumeCurve {
    return value === 'linear' || value === 'quadratic' || value === 'quartic';
}

/**
 * Apply volume curve transformation to match human hearing perception.
 *
 * Human ears perceive loudness logarithmically. This function transforms
 * a linear slider position to the actual volume that should be applied.
 *
 * @param sliderValue - Linear slider position (0-1)
 * @param curve - Volume curve type
 * @returns Actual volume to apply (0-1)
 *
 * @example
 * // With quadratic curve, 50% slider = 25% volume
 * applyVolumeCurve(0.5, 'quadratic') // returns 0.25
 */
export function applyVolumeCurve(sliderValue: number, curve: VolumeCurve): number {
    // Clamp input to valid range [0, 1]
    const clamped = Math.max(0, Math.min(1, sliderValue));

    switch (curve) {
        case 'quadratic':
            return clamped * clamped; // x²
        case 'quartic':
            return clamped ** 4; // x⁴
        case 'linear':
        default:
            return clamped;
    }
}

/**
 * Inverse transformation: convert actual volume back to slider position.
 *
 * Used when reading the current volume from the video element to determine
 * where the slider should be positioned.
 *
 * @param actualVolume - Actual volume (0-1)
 * @param curve - Volume curve type
 * @returns Slider position (0-1)
 *
 * @example
 * // With quadratic curve, 25% volume = 50% slider position
 * inverseVolumeCurve(0.25, 'quadratic') // returns 0.5
 */
export function inverseVolumeCurve(actualVolume: number, curve: VolumeCurve): number {
    // Clamp input to valid range [0, 1]
    const clamped = Math.max(0, Math.min(1, actualVolume));

    switch (curve) {
        case 'quadratic':
            return Math.sqrt(clamped); // √x
        case 'quartic':
            return Math.pow(clamped, 0.25); // ⁴√x
        case 'linear':
        default:
            return clamped;
    }
}
