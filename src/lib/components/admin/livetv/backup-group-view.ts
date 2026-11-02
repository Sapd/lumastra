// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Finding your way through the Backup Groups tab. A large provider has ~1,200
 * groups of 2–8 feeds and ~9,000 ungrouped channels: the tab was one long list.
 * This module holds the filters, the sort and the "problems" a group can have;
 * BackupGroupEditor renders the result a page at a time.
 */

import type { BackupGroupAdmin, BackupGroupMember } from '$lib/schemas/livetv.js';
import { isDegradedFeedName, qualityRank } from './channel-viewer-status.js';

export type GroupProblem =
    /** The primary is hidden while another feed is visible: viewers get that feed. */
    | 'primary-hidden'
    /** No primary at all: viewers get the first visible feed. */
    | 'no-primary'
    /** Feeds of different countries: likely two stations grouped as one. */
    | 'mixed-countries'
    /** Feeds spread over several categories. */
    | 'mixed-categories';

export type GroupSort = 'name' | 'size' | 'category';
export type GroupAirFilter = 'all' | 'on-air' | 'off-air';

export interface GroupFilter {
    query: string;
    /** '' = any category; 'uncategorized' = feeds without one. */
    categoryId: string;
    /** '' = any country. */
    country: string;
    air: GroupAirFilter;
    problemsOnly: boolean;
    sort: GroupSort;
}

export const DEFAULT_GROUP_FILTER: GroupFilter = {
    query: '',
    categoryId: '',
    country: '',
    air: 'all',
    problemsOnly: false,
    sort: 'name',
};

export const UNCATEGORIZED = 'uncategorized';

export interface GroupFacts {
    problems: GroupProblem[];
    /** Distinct country codes of the feeds, sorted. */
    countries: string[];
    /** Name of the first feed's category (the group's "home" for sorting). */
    categoryName: string;
    visibleCount: number;
    /** The feed viewers get (absent: none is visible). */
    shownId?: string;
}

/**
 * The feed viewers get, as the viewer query picks it: the primary when visible,
 * else the best visible feed (normal before transcoded/mobile, then quality, then
 * list order). Category visibility is not part of a group member here.
 */
export function shownFeedId(group: BackupGroupAdmin): string | undefined {
    const visible = group.channels.filter((ch) => ch.isVisible);
    if (visible.length === 0) return undefined;
    if (visible.some((ch) => ch.id === group.primaryChannelId)) return group.primaryChannelId;
    return [...visible].sort(
        (a, b) =>
            Number(isDegradedFeedName(memberName(a))) - Number(isDegradedFeedName(memberName(b))) ||
            qualityRank(a.qualityTier) - qualityRank(b.qualityTier),
    )[0].id;
}

/**
 * The feed "Put on air" shows (setBackupGroupsOnAir in livetv-channels.queries.ts):
 * the primary unless its name marks it degraded, else the best feed — normal
 * before transcoded/mobile, then quality, then list order.
 */
export function onAirFeedId(group: BackupGroupAdmin): string | undefined {
    return [...group.channels].sort(
        (a, b) =>
            Number(isDegradedFeedName(memberName(a))) - Number(isDegradedFeedName(memberName(b))) ||
            Number(b.id === group.primaryChannelId) - Number(a.id === group.primaryChannelId) ||
            qualityRank(a.qualityTier) - qualityRank(b.qualityTier),
    )[0]?.id;
}

function memberName(ch: BackupGroupMember): string {
    return ch.adminDisplayName ?? ch.name;
}

export function groupFacts(group: BackupGroupAdmin): GroupFacts {
    const countries = [
        ...new Set(group.channels.map((ch) => ch.countryCode).filter((c): c is string => !!c)),
    ].sort();
    const categories = new Set(group.channels.map((ch) => ch.categoryId ?? UNCATEGORIZED));
    const primary = group.channels.find((ch) => ch.id === group.primaryChannelId);
    const visibleCount = group.channels.filter((ch) => ch.isVisible).length;

    const problems: GroupProblem[] = [];
    if (!primary) problems.push('no-primary');
    else if (!primary.isVisible && visibleCount > 0) problems.push('primary-hidden');
    if (countries.length > 1) problems.push('mixed-countries');
    if (categories.size > 1) problems.push('mixed-categories');

    return {
        problems,
        countries,
        categoryName: (primary ?? group.channels[0])?.categoryName ?? '',
        visibleCount,
        shownId: shownFeedId(group),
    };
}

function matchesQuery(group: BackupGroupAdmin, query: string): boolean {
    if (!query) return true;
    if (group.name.toLowerCase().includes(query)) return true;
    return group.channels.some((ch) => memberName(ch).toLowerCase().includes(query));
}

/** Does a channel pass the category/country/search part of the filter? */
export function memberMatches(ch: BackupGroupMember, filter: GroupFilter): boolean {
    const query = filter.query.trim().toLowerCase();
    if (query && !memberName(ch).toLowerCase().includes(query)) return false;
    if (filter.categoryId && (ch.categoryId ?? UNCATEGORIZED) !== filter.categoryId) return false;
    if (filter.country && ch.countryCode !== filter.country) return false;
    return true;
}

/** The groups to list, filtered and sorted. `facts` is computed once per load. */
export function filterGroups(
    groups: readonly BackupGroupAdmin[],
    facts: ReadonlyMap<string, GroupFacts>,
    filter: GroupFilter,
): BackupGroupAdmin[] {
    const query = filter.query.trim().toLowerCase();
    const result = groups.filter((group) => {
        const f = facts.get(group.id) ?? groupFacts(group);
        if (filter.problemsOnly && f.problems.length === 0) return false;
        if (filter.air === 'on-air' && f.visibleCount === 0) return false;
        if (filter.air === 'off-air' && f.visibleCount > 0) return false;
        if (filter.country && !f.countries.includes(filter.country)) return false;
        if (
            filter.categoryId &&
            !group.channels.some((ch) => (ch.categoryId ?? UNCATEGORIZED) === filter.categoryId)
        )
            return false;
        return matchesQuery(group, query);
    });

    const byName = (a: BackupGroupAdmin, b: BackupGroupAdmin): number =>
        a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });
    switch (filter.sort) {
        case 'size':
            return result.sort((a, b) => b.channels.length - a.channels.length || byName(a, b));
        case 'category':
            return result.sort(
                (a, b) =>
                    (facts.get(a.id)?.categoryName ?? '').localeCompare(
                        facts.get(b.id)?.categoryName ?? '',
                    ) || byName(a, b),
            );
        case 'name':
            return result.sort(byName);
    }
}

export interface FilterOption {
    value: string;
    label: string;
    count: number;
}

/** Categories and countries that occur, with how many feeds each, for the filter lists. */
export function filterOptions(
    groups: readonly BackupGroupAdmin[],
    ungrouped: readonly BackupGroupMember[],
    uncategorizedLabel: string,
): { categories: FilterOption[]; countries: FilterOption[] } {
    const categories = new Map<string, FilterOption>();
    const countries = new Map<string, FilterOption>();
    const add = (ch: BackupGroupMember): void => {
        const catId = ch.categoryId ?? UNCATEGORIZED;
        const cat = categories.get(catId);
        if (cat) cat.count++;
        else
            categories.set(catId, {
                value: catId,
                label: ch.categoryName ?? uncategorizedLabel,
                count: 1,
            });
        if (ch.countryCode) {
            const c = countries.get(ch.countryCode);
            if (c) c.count++;
            else
                countries.set(ch.countryCode, {
                    value: ch.countryCode,
                    label: ch.countryCode,
                    count: 1,
                });
        }
    };
    for (const g of groups) for (const ch of g.channels) add(ch);
    for (const ch of ungrouped) add(ch);
    const byLabel = (a: FilterOption, b: FilterOption): number => a.label.localeCompare(b.label);
    return {
        categories: [...categories.values()].sort(byLabel),
        countries: [...countries.values()].sort(byLabel),
    };
}
