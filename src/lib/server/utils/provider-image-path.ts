// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/** TMDB CDN paths are one opaque filename; never a URL, directory or query. */
export const PROVIDER_IMAGE_PATH = /^\/[A-Za-z0-9]+\.(jpg|png|webp|svg)$/;

export function isProviderImagePath(path: string): boolean {
    return PROVIDER_IMAGE_PATH.test(path);
}
