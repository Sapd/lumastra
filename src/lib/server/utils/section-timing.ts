// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { Logger } from '$lib/server/utils/logger';

// 't3-ssr': Tier 3 sections that remain in SSR until lazy endpoints exist.
export type SectionTier = 't1' | 't2' | 't3' | 't3-ssr';

const logger = Logger.for('SectionTiming');

export async function timeSection<T>(
    section: string,
    tier: SectionTier,
    fn: () => Promise<T>,
): Promise<T> {
    const start = performance.now();
    try {
        const value = await fn();
        logger.info('section.timing', {
            section,
            tier,
            duration_ms: Math.round(performance.now() - start),
            ok: true,
        });
        return value;
    } catch (err) {
        logger.warn('section.timing', {
            section,
            tier,
            duration_ms: Math.round(performance.now() - start),
            ok: false,
            error: err instanceof Error ? err.message : String(err),
        });
        throw err;
    }
}
