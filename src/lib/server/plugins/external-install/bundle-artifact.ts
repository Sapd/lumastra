// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only
import { z } from 'zod';
import { isSafeRelativePath } from './manifest.js';

const SHA256_HEX = z.string().regex(/^[a-f0-9]{64}$/);

export const BundleArtifactSchema = z.object({
    entry: z.string().refine(isSafeRelativePath),
    treeDigest: SHA256_HEX,
    files: z
        .array(
            z.object({
                path: z.string().refine(isSafeRelativePath),
                sha256: SHA256_HEX,
                size: z.number().int().nonnegative(),
            }),
        )
        .min(1),
});
export type BundleArtifact = z.infer<typeof BundleArtifactSchema>;

/** Fail-closed sentinel yielded by mapRow when a stored jsonb blob fails safeParse. */
export interface InvalidBundle {
    invalid: true;
}
export const INVALID_BUNDLE: InvalidBundle = { invalid: true };

export function isInvalidBundle(b: BundleArtifact | InvalidBundle | null): b is InvalidBundle {
    return b !== null && typeof b === 'object' && (b as InvalidBundle).invalid === true;
}
