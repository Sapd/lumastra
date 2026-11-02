// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Stable Live TV channel numbers: the pure planning half (no database).
 *
 * A number belongs to a station CARD: a backup group (all its feeds share it) or
 * an ungrouped channel. Numbers never move on their own: a reorder, a refresh or
 * a re-import keeps them; new cards get the next free number; an admin's own
 * numbers are pinned. Design and edge cases:
 * docs/superpowers/specs/2026-10-16-livetv-channel-numbers-design.md.
 */

/** Highest number a viewer can dial (the channel pad takes four digits). */
export const MAX_CHANNEL_NUMBER = 9999;

/** A card the lineup shows viewers now. */
export interface NumberCard {
    /** The backup group id, else the channel id. */
    key: string;
    backupGroupId: string | null;
    /** The feed viewers get (the channel itself for an ungrouped card). */
    channelId: string;
    categoryId: string | null;
    sortOrder: number;
    name: string;
}

/** A stored number with what its owner looks like now. */
export interface NumberRow {
    number: number;
    backupGroupId: string | null;
    channelId: string | null;
    /** The group `channelId` belongs to now (it may have joined one since). */
    channelGroupId: string | null;
    pinned: boolean;
    /** The channel, or a channel of the group, still exists. */
    ownerAlive: boolean;
}

export interface NumberCategory {
    id: string;
    name: string;
    sortOrder: number;
    numberStart: number | null;
}

export interface NumberInsert {
    number: number;
    backupGroupId: string | null;
    channelId: string | null;
}

export interface NumberPlan {
    /** Numbers to free. */
    deletes: number[];
    /** Rows matched through a feed that must now name their group. */
    claims: { number: number; backupGroupId: string }[];
    inserts: NumberInsert[];
    /** Card key → number, for every visible card that has one. */
    numbers: Map<string, number>;
}

/** The card a stored number belongs to, or null when its owner is gone. */
export function rowKey(row: NumberRow): string | null {
    return row.backupGroupId ?? row.channelGroupId ?? row.channelId;
}

/** Cards in display order: category order, then sort order, then name. */
export function orderCards(cards: NumberCard[], categories: NumberCategory[]): NumberCard[] {
    const rank = categoryRanks(categories);
    const rankOf = (card: NumberCard): number =>
        (card.categoryId ? rank.get(card.categoryId) : undefined) ?? Number.MAX_SAFE_INTEGER;
    return [...cards].sort(
        (a, b) =>
            rankOf(a) - rankOf(b) || a.sortOrder - b.sortOrder || a.name.localeCompare(b.name),
    );
}

function categoryRanks(categories: NumberCategory[]): Map<string, number> {
    const rank = new Map<string, number>();
    [...categories]
        .sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name))
        .forEach((category, index) => rank.set(category.id, index));
    return rank;
}

/**
 * The block of a category with a "Numbers start at": from its start to just
 * before the next higher start of another category (or the maximum).
 */
export function categoryBlock(
    categoryId: string | null,
    categories: NumberCategory[],
): { from: number; to: number } | null {
    const start = categories.find((c) => c.id === categoryId)?.numberStart ?? null;
    if (start === null) return null;
    const higher = categories
        .filter((c) => c.id !== categoryId && c.numberStart !== null && c.numberStart > start)
        .map((c) => c.numberStart as number);
    return { from: start, to: higher.length > 0 ? Math.min(...higher) - 1 : MAX_CHANNEL_NUMBER };
}

/**
 * The next number in [from, to]: after the highest one taken in the range, so
 * a new channel never gets a number another channel had a moment ago; when the
 * top of the range is used up, the lowest free one. Null when the range is full.
 */
export function nextFreeNumber(
    taken: Set<number>,
    from: number,
    to: number,
    /** Numbers that set "the highest"; default all taken. Pinned ones are left out
     *  so one admin number at 9999 does not send every new channel into the gaps. */
    anchors: Set<number> = taken,
): number | null {
    let highest = from - 1;
    for (const n of anchors) if (n >= from && n <= to && n > highest) highest = n;
    for (let n = highest + 1; n <= to; n++) if (!taken.has(n)) return n;
    for (let n = from; n <= highest; n++) if (!taken.has(n)) return n;
    return null;
}

/** The number a new card gets: its category's block first, then the whole range. */
function numberForNewCard(
    card: NumberCard,
    categories: NumberCategory[],
    taken: Set<number>,
    anchors: Set<number>,
): number | null {
    const block = categoryBlock(card.categoryId, categories);
    if (block) {
        const inBlock = nextFreeNumber(taken, block.from, block.to, anchors);
        if (inBlock !== null) return inBlock;
    }
    return nextFreeNumber(taken, 1, MAX_CHANNEL_NUMBER, anchors);
}

/** Pinned first, then the lowest number. */
function preferRow(a: NumberRow, b: NumberRow): number {
    return Number(b.pinned) - Number(a.pinned) || a.number - b.number;
}

/**
 * Keeps every number that still has its card, frees the ones that lost it and
 * numbers the cards that have none.
 *
 * - An owner that no longer exists frees its number.
 * - Several numbers for one card (two stations merged into one group): the
 *   pinned one, else the lowest, stays.
 * - A card the lineup does not show (hidden channel, hidden category) keeps its
 *   number when it is pinned or `keepHidden` is set; otherwise it is freed.
 * - New cards are numbered in display order (see numberForNewCard).
 */
export function planChannelNumbers(input: {
    cards: NumberCard[];
    rows: NumberRow[];
    categories: NumberCategory[];
    keepHidden: boolean;
}): NumberPlan {
    const cardsByKey = new Map(input.cards.map((card) => [card.key, card]));
    const deletes: number[] = [];
    const claims: NumberPlan['claims'] = [];
    const numbers = new Map<string, number>();

    const rowsByKey = new Map<string, NumberRow[]>();
    for (const row of input.rows) {
        const key = row.ownerAlive ? rowKey(row) : null;
        if (key === null) {
            deletes.push(row.number);
            continue;
        }
        const list = rowsByKey.get(key) ?? [];
        list.push(row);
        rowsByKey.set(key, list);
    }

    for (const [key, rows] of rowsByKey) {
        const [keep, ...rest] = [...rows].sort(preferRow);
        for (const row of rest) deletes.push(row.number);
        const card = cardsByKey.get(key);
        if (!card) {
            if (!keep.pinned && !input.keepHidden) deletes.push(keep.number);
            continue;
        }
        numbers.set(key, keep.number);
        if (card.backupGroupId && keep.backupGroupId !== card.backupGroupId) {
            claims.push({ number: keep.number, backupGroupId: card.backupGroupId });
        }
    }

    const deleted = new Set(deletes);
    const kept = input.rows.filter((r) => !deleted.has(r.number));
    const taken = new Set(kept.map((r) => r.number));
    const anchors = new Set(kept.filter((r) => !r.pinned).map((r) => r.number));
    const inserts: NumberInsert[] = [];
    for (const card of orderCards(
        input.cards.filter((card) => !numbers.has(card.key)),
        input.categories,
    )) {
        // Range full: the rest stay unnumbered (and are not re-scanned card by card).
        if (taken.size >= MAX_CHANNEL_NUMBER) break;
        const number = numberForNewCard(card, input.categories, taken, anchors);
        if (number === null) continue;
        taken.add(number);
        anchors.add(number);
        numbers.set(card.key, number);
        inserts.push({ number, backupGroupId: card.backupGroupId, channelId: card.channelId });
    }

    return { deletes, claims, inserts, numbers };
}

/**
 * "Renumber in current order": every unpinned number is given up and the cards
 * are numbered again in display order: 1, 2, 3 …, a category with a
 * "Numbers start at" from its start, a category without one after the category
 * before it. Pinned numbers stay and are skipped. Hidden cards lose their
 * (unpinned) number, unless `keepHidden`; they get a new one when shown again.
 */
export function planRenumber(input: {
    cards: NumberCard[];
    rows: NumberRow[];
    categories: NumberCategory[];
    /** "Keep numbers of hidden channels": hidden cards keep their number too. */
    keepHidden?: boolean;
}): NumberPlan {
    const visible = new Set(input.cards.map((card) => card.key));
    // One pinned number per card (the lowest), and only while its owner exists.
    const pinByKey = new Map<string, NumberRow>();
    for (const row of [...input.rows].sort((a, b) => a.number - b.number)) {
        const key = row.pinned && row.ownerAlive ? rowKey(row) : null;
        if (key !== null && !pinByKey.has(key)) pinByKey.set(key, row);
    }
    const pinnedKept = new Set([...pinByKey.values()].map((row) => row.number));
    // With keepHidden, a hidden card's (unpinned) number stays reserved as well.
    if (input.keepHidden) {
        const hiddenKept = new Set<string>();
        for (const row of [...input.rows].sort((a, b) => a.number - b.number)) {
            const key = row.ownerAlive ? rowKey(row) : null;
            if (key === null || visible.has(key) || pinByKey.has(key) || hiddenKept.has(key)) {
                continue;
            }
            hiddenKept.add(key);
            pinnedKept.add(row.number);
        }
    }
    const numbers = new Map<string, number>();
    const claims: NumberPlan['claims'] = [];
    for (const card of input.cards) {
        const row = pinByKey.get(card.key);
        if (!row) continue;
        numbers.set(card.key, row.number);
        if (card.backupGroupId && row.backupGroupId !== card.backupGroupId) {
            claims.push({ number: row.number, backupGroupId: card.backupGroupId });
        }
    }

    const deletes = input.rows.filter((r) => !pinnedKept.has(r.number)).map((r) => r.number);
    const taken = new Set(pinnedKept);
    const inserts: NumberInsert[] = [];
    const rank = categoryRanks(input.categories);
    const startOf = new Map(input.categories.map((c) => [c.id, c.numberStart]));

    let cursor = 1;
    let currentCategory: string | null | undefined;
    for (const card of orderCards(input.cards, input.categories)) {
        const categoryKey = card.categoryId && rank.has(card.categoryId) ? card.categoryId : null;
        if (categoryKey !== currentCategory) {
            currentCategory = categoryKey;
            const start = categoryKey ? (startOf.get(categoryKey) ?? null) : null;
            if (start !== null) cursor = start;
        }
        if (numbers.has(card.key)) continue;
        if (taken.size >= MAX_CHANNEL_NUMBER) break;
        while (cursor <= MAX_CHANNEL_NUMBER && taken.has(cursor)) cursor++;
        const number =
            cursor <= MAX_CHANNEL_NUMBER ? cursor : nextFreeNumber(taken, 1, MAX_CHANNEL_NUMBER);
        if (number === null) continue;
        if (number === cursor) cursor++;
        taken.add(number);
        numbers.set(card.key, number);
        inserts.push({ number, backupGroupId: card.backupGroupId, channelId: card.channelId });
    }

    return { deletes, claims, inserts, numbers };
}

/**
 * The cards that cannot be numbered in their category's block (it is full):
 * category id → how many of its cards sit outside the block. For the admin's
 * "doesn't fit" warning.
 */
export function overflowingCategories(
    cards: NumberCard[],
    numbers: Map<string, number>,
    categories: NumberCategory[],
): Map<string, number> {
    const overflow = new Map<string, number>();
    for (const card of cards) {
        const block = categoryBlock(card.categoryId, categories);
        const number = numbers.get(card.key);
        if (!block || number === undefined || !card.categoryId) continue;
        if (number < block.from || number > block.to) {
            overflow.set(card.categoryId, (overflow.get(card.categoryId) ?? 0) + 1);
        }
    }
    return overflow;
}
