// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Re-export shim — the implementation moved to `$lib/shared/music-title-normalize`
 * so the pure title-normalization helpers can also be used client-side (the
 * /music search groups alternate versions with them). Server callers keep
 * importing from this path unchanged.
 *
 * @module queries/music-title-normalize
 */

export * from '$lib/shared/music-title-normalize';
