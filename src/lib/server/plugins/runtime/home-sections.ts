// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Plugin-contributed rows on the home page.
 *
 * A plugin returns IDS, never items — and that is the whole design. The host
 * resolves them through the same viewer-scoped path everything else uses, so a
 * plugin physically cannot surface media the viewer's library scope or age
 * rating hides. Access control is not something a plugin opts into here; it is
 * something it cannot opt out of.
 *
 * The other consequence of ids-not-items: the host renders these through its
 * own section renderer, so a contributed row looks exactly like a native one
 * and works on every client, with no plugin JavaScript in the page at all.
 */

import type { FeatureDefinition, PluginContext } from '@sapd/lumastra-plugin-sdk';
import { Logger } from '../../utils/logger.js';

const logger = Logger.for('PluginHomeSections');

/**
 * Per-feature budget. Larger than the badge budget because this runs once per
 * page load rather than per rail, but still small enough that a slow plugin
 * cannot make the home page feel broken.
 */
const SECTION_BUDGET_MS = 500;

/** Most rows one plugin may contribute. The home page is not a plugin's page. */
const MAX_SECTIONS_PER_FEATURE = 3;

/** Most items in a contributed row, matching what a carousel actually shows. */
const MAX_ITEMS_PER_SECTION = 30;

export interface ResolvedItem {
    id: string;
    mediaType: string;
    title?: string;
    allowed: boolean;
    [key: string]: unknown;
}

export interface PluginHomeSection {
    id: string;
    title: string;
    items: ResolvedItem[];
}

/**
 * Deps are REQUIRED here, unlike the other plugin runtimes which carry a
 * module-level default. `resolveForViewer` is the access boundary and is
 * inherently request-scoped, so a default would have to invent a viewer — and
 * the one thing this module must never do is guess at who is asking.
 */
export interface HomeSectionDeps {
    listFeatures(): FeatureDefinition[];
    buildCtx(featureId: string): PluginContext;
    /** The host's viewer-scoped resolution. This is the access boundary. */
    resolveForViewer(mediaItemIds: string[]): Promise<ResolvedItem[]>;
}

type SectionsFn = (ctx: PluginContext) => Promise<unknown>;

/** Await `p`, resolving to `null` on rejection or timeout. Never rejects. */
function settleWithin<T>(p: Promise<T>, ms: number): Promise<T | null> {
    return new Promise((resolve) => {
        const timer = setTimeout(() => resolve(null), ms);
        (timer as unknown as { unref?: () => void }).unref?.();
        p.then(
            (v) => {
                clearTimeout(timer);
                resolve(v);
            },
            () => {
                clearTimeout(timer);
                resolve(null);
            },
        );
    });
}

interface RawContribution {
    id: string;
    title: string;
    mediaItemIds: string[];
}

/** Keep only entries the host can actually build a row from. */
function usableContributions(raw: unknown): RawContribution[] {
    if (!Array.isArray(raw)) return [];
    return raw
        .filter((c): c is RawContribution => {
            if (!c || typeof c !== 'object') return false;
            const v = c as Record<string, unknown>;
            return (
                typeof v.id === 'string' &&
                v.id.length > 0 &&
                typeof v.title === 'string' &&
                v.title.length > 0 &&
                Array.isArray(v.mediaItemIds)
            );
        })
        .slice(0, MAX_SECTIONS_PER_FEATURE);
}

/**
 * Collect every plugin's home-page rows, resolved and access-filtered.
 *
 * Never throws. A feature that fails, hangs or returns nonsense contributes
 * nothing while the rest still render.
 */
export async function collectPluginHomeSections(
    deps: HomeSectionDeps,
): Promise<PluginHomeSection[]> {
    let contributors: FeatureDefinition[];
    try {
        contributors = deps
            .listFeatures()
            .filter((f) => typeof (f as { homeSections?: unknown }).homeSections === 'function');
    } catch (err) {
        logger.warn('could not list home-section contributors', {
            error: err instanceof Error ? err.message : String(err),
        });
        return [];
    }
    if (contributors.length === 0) return [];

    const perFeature = await Promise.all(
        contributors.map(async (f): Promise<PluginHomeSection[]> => {
            let raw: unknown;
            try {
                const fn = (f as unknown as { homeSections: SectionsFn }).homeSections;
                raw = await settleWithin(
                    Promise.resolve(fn(deps.buildCtx(f.id))),
                    SECTION_BUDGET_MS,
                );
            } catch (err) {
                logger.warn('home-section contributor threw', {
                    feature: f.id,
                    error: err instanceof Error ? err.message : String(err),
                });
                return [];
            }
            if (raw === null) {
                logger.warn('home-section contributor failed or exceeded its budget', {
                    feature: f.id,
                    budgetMs: SECTION_BUDGET_MS,
                });
                return [];
            }

            const out: PluginHomeSection[] = [];
            for (const c of usableContributions(raw)) {
                const ids = c.mediaItemIds
                    .filter((id): id is string => typeof id === 'string' && id.length > 0)
                    .slice(0, MAX_ITEMS_PER_SECTION);
                if (ids.length === 0) continue;

                let resolved: ResolvedItem[];
                try {
                    resolved = await deps.resolveForViewer(ids);
                } catch (err) {
                    logger.warn('could not resolve a contributed section', {
                        feature: f.id,
                        error: err instanceof Error ? err.message : String(err),
                    });
                    continue;
                }

                // THE access boundary. A plugin never sees this decision and
                // cannot influence it.
                const visible = resolved.filter((r) => r.allowed);
                // An empty rail is worse than no rail — it reads as a broken
                // feature rather than as one with nothing to say today.
                if (visible.length === 0) continue;

                out.push({
                    id: `plugin:${f.id}:${c.id}`,
                    title: c.title,
                    items: visible,
                });
            }
            return out;
        }),
    );

    return perFeature.flat();
}
