// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The applied instance profile as the admin editor and
 * POST /api/admin/instance-profile both see it: which profile produced today's
 * configuration (the base for a three-way re-apply) and the revision a stale
 * form is checked against. One reading for both, so the page never offers a
 * revision the endpoint would refuse.
 */

import { config } from '$lib/server/config.js';
import { isEnvOverridden } from './config.service.js';
import { savedUseCases } from '$lib/config/setup-preferences.js';
import {
    parseAppliedProfile,
    type AppliedProfile,
    type PreviousProfile,
    type UseCaseId,
} from '$lib/config/use-case-presets.js';

export interface InstanceProfileState {
    /** Use cases in force (INSTANCE_USE_CASES, saved or from the environment), known ids only. */
    useCases: UseCaseId[];
    /** The recorded last apply, when it still describes the use cases in force. */
    applied: AppliedProfile | null;
    /** Base for the next re-apply; null = no usable base (first, full projection). */
    previous: PreviousProfile | null;
    /**
     * `at` of the stored record (null: none). The form sends it back and the
     * apply is a compare-and-swap on it, so it names the record whether or not
     * that record is still trusted as a base.
     */
    revision: string | null;
}

function sameSet(a: readonly string[], b: readonly string[]): boolean {
    return a.length === b.length && [...a].sort().join('\u0000') === [...b].sort().join('\u0000');
}

/** The `at` of a stored INSTANCE_PROFILE_APPLIED value; null when absent or unreadable. */
export function appliedProfileRevision(raw: unknown): string | null {
    return parseAppliedProfile(raw)?.at ?? null;
}

export function readInstanceProfileState(): InstanceProfileState {
    const useCases = savedUseCases(config.INSTANCE_USE_CASES);
    const recorded = parseAppliedProfile(config.INSTANCE_PROFILE_APPLIED);
    // A record whose use cases are not the ones in force was overtaken by a
    // write that did not go through the profile (an older build, a hand edit,
    // an environment variable changed since): not a trustworthy base.
    const applied = recorded !== null && sameSet(recorded.useCases, useCases) ? recorded : null;
    // Use cases an environment variable dictates say nothing about what was
    // ever projected; only a matching record does.
    const previous: PreviousProfile | null = applied
        ? { useCases: applied.useCases, values: applied.values }
        : !isEnvOverridden('INSTANCE_USE_CASES') && useCases.length > 0
          ? { useCases }
          : null;
    return { useCases, applied, previous, revision: recorded?.at ?? null };
}
