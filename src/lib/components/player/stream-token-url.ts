// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/** Delivery URLs are complete credentials; callers must use them verbatim. */
export function applyStreamTokenToPlaybackUrl(path: string, _unused?: string): string {
    return path;
}
