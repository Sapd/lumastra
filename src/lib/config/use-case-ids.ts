// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The home-videos / training onboarding use case.
 *
 * The string value is persisted (INSTANCE_USE_CASES and INSTANCE_PRIMARY_MODE rows in existing
 * instances) and travels in the instance-profile API, so it cannot change without a data
 * migration. Reference it through this constant and the types below, never as a literal.
 */
export const TRAINING_USE_CASE = 'enterprise' as const;

/** Onboarding use-case ids (INSTANCE_USE_CASES). */
export type UseCaseId = 'vod' | 'music' | typeof TRAINING_USE_CASE | 'showcase';

/** Values of INSTANCE_PRIMARY_MODE. */
export type PrimaryMode = 'vod' | 'music' | 'mixed' | typeof TRAINING_USE_CASE | 'showcase';

export const USE_CASE_IDS: readonly UseCaseId[] = ['vod', 'music', TRAINING_USE_CASE, 'showcase'];
export const PRIMARY_MODES: readonly PrimaryMode[] = [
    'vod',
    'music',
    'mixed',
    TRAINING_USE_CASE,
    'showcase',
];
