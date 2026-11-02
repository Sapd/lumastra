// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Image Validation Utilities
 *
 * Centralized validation for image-related parameters across all image endpoints.
 * Prevents duplication of validation logic in 5+ image proxy routes.
 */

/**
 * Valid image types supported by the image proxy system
 */
export const VALID_IMAGE_TYPES = [
    'poster',
    'backdrop',
    'logo',
    'still',
    'primary', // Jellyfin primary image
    'banner', // For Sonarr/Radarr
    'thumb', // Thumbnail images
] as const;

/**
 * Type guard for valid image types
 */
export type ValidImageType = (typeof VALID_IMAGE_TYPES)[number];

/**
 * Check if a string is a valid image type
 *
 * @param type - Image type string to validate
 * @returns True if type is valid
 *
 * @example
 * if (isValidImageType(params.type)) {
 *     // TypeScript knows type is ValidImageType
 *     const result = await getImage(id, params.type);
 * }
 */
export function isValidImageType(type: string): type is ValidImageType {
    return VALID_IMAGE_TYPES.includes(type as ValidImageType);
}

/**
 * Normalize image type from various formats
 *
 * @param type - Image type string (may be case-insensitive)
 * @returns Normalized ValidImageType or null if invalid
 *
 * @example
 * const type = normalizeImageType('POSTER'); // 'poster'
 * const type = normalizeImageType('Primary'); // 'primary'
 */
export function normalizeImageType(type: string): ValidImageType | null {
    const normalized = type.toLowerCase();
    return isValidImageType(normalized) ? normalized : null;
}
