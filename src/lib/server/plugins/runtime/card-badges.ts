// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Plugin-contributed badges on media cards.
 *
 * Deliberately a DATA hook, not a UI mount point. A browse grid renders
 * hundreds of cards; per-card third-party JavaScript would be a performance
 * disaster and could never look native. Merging badges server-side instead
 * means the contribution reaches every client — the web app, iOS, tvOS, and
 * anything on `/api/v1` — with no browser code at all, and leaves access
 * control entirely host-side.
 *
 * This runs on the hottest read path in the app, so every rule below exists to
 * bound what a plugin can cost or corrupt:
 *
 *   - a hard per-feature time budget, and an overrun simply contributes nothing;
 *   - full fault isolation, so one broken plugin costs its own badges, never
 *     the row;
 *   - output validated against the host's own badge shape and capped per item,
 *     because a plugin that returns 200 badges would otherwise wreck the card
 *     layout for every viewer.
 */

import type { FeatureDefinition, PluginContext } from '@sapd/lumastra-plugin-sdk';
import { registry as taskRegistry } from '$lib/server/tasks/registry.js';
import { buildPluginContext } from '$lib/server/tasks/plugin-context.js';
import { BadgeSchema } from '$lib/schemas/api-responses.js';
import type { Badge } from '$lib/types/server-driven-ui.js';
import { Logger } from '../../utils/logger.js';

const logger = Logger.for('PluginCardBadges');

/**
 * Per-feature budget. Matched to the home page's SSR overlay budget: this sits
 * in front of rendering a rail, so the entire pass has to be invisible.
 */
const BADGE_BUDGET_MS = 50;

/**
 * Most badges one item may collect, across all plugins. Cards have room for a
 * couple; beyond that a plugin is not decorating a card, it is taking it over.
 */
export const MAX_BADGES_PER_ITEM = 3;

export interface CardBadgeRef {
    mediaItemId: string;
    mediaType: string;
}

export interface CardBadgeDeps {
    listFeatures(): FeatureDefinition[];
    buildCtx(featureId: string): PluginContext;
}

const defaultDeps: CardBadgeDeps = {
    listFeatures: () => taskRegistry.getAllFeatures(),
    buildCtx: (id) => buildPluginContext(id),
};

type DecorateFn = (ctx: PluginContext, refs: CardBadgeRef[]) => Promise<unknown>;

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

/**
 * Normalise one plugin's answer into `id → badges`, dropping anything the host
 * cannot render. Accepts a plain object or a Map — authors reach for either,
 * and refusing one of them would be a pointless contract trap.
 */
function readBadgeMap(raw: unknown, wanted: Set<string>): Map<string, Badge[]> {
    const out = new Map<string, Badge[]>();
    const entries: Iterable<[string, unknown]> =
        raw instanceof Map
            ? raw.entries()
            : raw && typeof raw === 'object'
              ? Object.entries(raw as Record<string, unknown>)
              : [];

    for (const [id, value] of entries) {
        // Only ids the host actually asked about. A plugin answering for items
        // that are not on screen is confused at best.
        if (!wanted.has(id) || !Array.isArray(value)) continue;
        const valid: Badge[] = [];
        for (const candidate of value) {
            const parsed = BadgeSchema.safeParse(candidate);
            if (parsed.success) valid.push(parsed.data as Badge);
        }
        if (valid.length > 0) out.set(id, valid);
    }
    return out;
}

/**
 * Ask every feature implementing `decorateCards` for badges on these items.
 *
 * Returns `id → badges`, already validated and capped. Never throws. An empty
 * ref list short-circuits without touching a plugin, so pages with no cards
 * cost nothing.
 */
export async function collectPluginBadges(
    refs: CardBadgeRef[],
    deps: CardBadgeDeps = defaultDeps,
): Promise<Map<string, Badge[]>> {
    const merged = new Map<string, Badge[]>();
    if (refs.length === 0) return merged;

    let decorators: FeatureDefinition[];
    try {
        decorators = deps
            .listFeatures()
            .filter((f) => typeof (f as { decorateCards?: unknown }).decorateCards === 'function');
    } catch (err) {
        logger.warn('could not list card decorators', {
            error: err instanceof Error ? err.message : String(err),
        });
        return merged;
    }
    if (decorators.length === 0) return merged;

    const wanted = new Set(refs.map((r) => r.mediaItemId));

    // Concurrent: the budget is wall-clock, so running them in series would
    // make the worst case the SUM of every plugin's latency.
    const results = await Promise.all(
        decorators.map(async (f) => {
            try {
                const decorate = (f as unknown as { decorateCards: DecorateFn }).decorateCards;
                const raw = await settleWithin(
                    Promise.resolve(decorate(deps.buildCtx(f.id), refs)),
                    BADGE_BUDGET_MS,
                );
                if (raw === null) {
                    logger.warn('card decorator failed or exceeded its budget', {
                        feature: f.id,
                        budgetMs: BADGE_BUDGET_MS,
                    });
                    return new Map<string, Badge[]>();
                }
                return readBadgeMap(raw, wanted);
            } catch (err) {
                logger.warn('card decorator threw', {
                    feature: f.id,
                    error: err instanceof Error ? err.message : String(err),
                });
                return new Map<string, Badge[]>();
            }
        }),
    );

    for (const perFeature of results) {
        for (const [id, badges] of perFeature) {
            const existing = merged.get(id) ?? [];
            if (existing.length >= MAX_BADGES_PER_ITEM) continue;
            merged.set(id, [...existing, ...badges].slice(0, MAX_BADGES_PER_ITEM));
        }
    }
    return merged;
}
