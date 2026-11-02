// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Stable Live TV channel numbers: database orchestration. Every write runs
 * under one advisory lock (lockChannelNumbers), so lineup reads on several
 * replicas, admin edits and a renumber never interleave. The rules are in
 * channel-number-plan.ts; the design in
 * docs/superpowers/specs/2026-10-16-livetv-channel-numbers-design.md.
 */

import type postgres from 'postgres';
import { config } from '$lib/server/config.js';
import { withTx } from '$lib/server/database/with-tx.js';
import {
    getAllVisibleChannels,
    getChannelsForRefresh,
    type ChannelRow,
} from '$lib/server/database/queries/livetv-channels.queries.js';
import {
    claimChannelNumbers,
    deleteChannelNumbers,
    getChannelCard,
    getChannelNumberHolderName,
    getChannelNumberRows,
    getNumberCategories,
    getProviderChannelTitles,
    insertChannelNumbers,
    lockChannelNumbers,
    setChannelNumberPinned,
    setChannelNumberRow,
} from '$lib/server/database/queries/livetv-channel-numbers.queries.js';
import {
    MAX_CHANNEL_NUMBER,
    nextFreeNumber,
    overflowingCategories,
    planChannelNumbers,
    planRenumber,
    rowKey,
    type NumberCard,
    type NumberCategory,
    type NumberPlan,
    type NumberRow,
} from './channel-number-plan.js';
import { matchChannels, type ExistingChannel } from './channel-matcher.js';
import type { ProcessedChannel } from './auto-processor.js';

/** The card a lineup row stands for: its backup group, else the channel. */
export function channelNumberKey(row: { id: string; backup_group_id: string | null }): string {
    return row.backup_group_id ?? row.id;
}

/** Cards of the lineup rows, one per key (getAllVisibleChannels yields one row per card). */
function toCards(rows: ChannelRow[]): NumberCard[] {
    return [...new Map(rows.map((row) => [channelNumberKey(row), toCard(row)])).values()];
}

function toCard(row: ChannelRow): NumberCard {
    return {
        key: channelNumberKey(row),
        backupGroupId: row.backup_group_id,
        channelId: row.id,
        categoryId: row.category_id,
        sortOrder: row.sort_order,
        name: row.name,
    };
}

function hasWrites(plan: NumberPlan): boolean {
    return plan.deletes.length > 0 || plan.claims.length > 0 || plan.inserts.length > 0;
}

async function applyPlan(sql: postgres.Sql, plan: NumberPlan): Promise<void> {
    await deleteChannelNumbers(sql, plan.deletes);
    await claimChannelNumbers(sql, plan.claims);
    await insertChannelNumbers(sql, plan.inserts);
}

export interface ChannelNumberState {
    /** Card key (see channelNumberKey) → number, for every visible card that has one. */
    numbers: Map<string, number>;
    /** Category id → cards that did not fit into its "Numbers start at" block. */
    overflow: Map<string, number>;
}

function stateOf(
    cards: NumberCard[],
    numbers: Map<string, number>,
    categories: NumberCategory[],
): ChannelNumberState {
    return { numbers, overflow: overflowingCategories(cards, numbers, categories) };
}

/**
 * The numbers of the visible lineup, numbering new cards and freeing lost ones
 * first. Reads only when nothing changed; otherwise takes the lock, reads again
 * and writes. `visibleRows` = getAllVisibleChannels when the caller has it.
 */
export async function ensureChannelNumbers(
    sql: postgres.Sql,
    visibleRows?: ChannelRow[],
): Promise<ChannelNumberState> {
    const keepHidden = config.LIVETV_KEEP_HIDDEN_CHANNEL_NUMBERS;
    const [rows, numberRows, categories] = await Promise.all([
        visibleRows ?? getAllVisibleChannels(sql),
        getChannelNumberRows(sql),
        getNumberCategories(sql),
    ]);
    const cards = toCards(rows);
    const plan = planChannelNumbers({ cards, rows: numberRows, categories, keepHidden });
    if (!hasWrites(plan)) return stateOf(cards, plan.numbers, categories);

    return withTx(sql, async (txRaw) => {
        const tx = txRaw as unknown as postgres.Sql;
        await lockChannelNumbers(tx);
        const [freshRows, freshNumbers, freshCategories] = await Promise.all([
            getAllVisibleChannels(tx),
            getChannelNumberRows(tx),
            getNumberCategories(tx),
        ]);
        const freshCards = toCards(freshRows);
        const freshPlan = planChannelNumbers({
            cards: freshCards,
            rows: freshNumbers,
            categories: freshCategories,
            keepHidden,
        });
        await applyPlan(tx, freshPlan);
        return stateOf(freshCards, freshPlan.numbers, freshCategories);
    });
}

/** The stored number row of a card: the pinned one, else the lowest. */
function rowOfCard(rows: NumberRow[], key: string): NumberRow | undefined {
    return rows
        .filter((row) => row.ownerAlive && rowKey(row) === key)
        .sort((a, b) => Number(b.pinned) - Number(a.pinned) || a.number - b.number)[0];
}

export type SetChannelNumberResult =
    | { status: 'ok'; number: number }
    | { status: 'not_found' }
    | { status: 'invalid' }
    | { status: 'conflict'; holderName: string | null };

/**
 * An admin gives a channel (its station card) a number; the number is pinned.
 * A number another card holds is a conflict unless `swap`: then that card gets
 * this card's old number (pinned too), or a new one later when this card had none.
 */
export async function setChannelNumber(
    sql: postgres.Sql,
    channelId: string,
    number: number,
    options: { swap: boolean },
): Promise<SetChannelNumberResult> {
    if (!Number.isInteger(number) || number < 1 || number > MAX_CHANNEL_NUMBER) {
        return { status: 'invalid' };
    }
    return withTx(sql, async (txRaw) => {
        const tx = txRaw as unknown as postgres.Sql;
        await lockChannelNumbers(tx);
        const card = await getChannelCard(tx, channelId);
        if (!card) return { status: 'not_found' } as const;
        const key = card.backupGroupId ?? card.channelId;
        const rows = await getChannelNumberRows(tx);
        const own = rowOfCard(rows, key);
        const holder = rows.find((row) => row.number === number);

        // The card already holds this number (possibly in a duplicate row the
        // next ensure would drop): keep that row, pinned, and free the others.
        if (holder && holder.ownerAlive && rowKey(holder) === key) {
            const others = rows
                .filter((row) => row !== holder && row.ownerAlive && rowKey(row) === key)
                .map((row) => row.number);
            await deleteChannelNumbers(tx, others);
            await setChannelNumberPinned(tx, number, true);
            return { status: 'ok', number } as const;
        }
        if (holder) {
            const holderKey = holder.ownerAlive ? rowKey(holder) : null;
            if (holderKey !== null && !options.swap) {
                return {
                    status: 'conflict',
                    holderName: await getChannelNumberHolderName(tx, number),
                } as const;
            }
            // An orphan is just freed. A swapped card moves to this card's old
            // number; when this card had none, to the next free one (keeping
            // its pin), so a pinned number is never dropped by a swap.
            await deleteChannelNumbers(tx, [number]);
            if (holderKey !== null) {
                const taken = new Set(rows.map((row) => row.number));
                taken.add(number);
                const target = own?.number ?? nextFreeNumber(taken, 1, MAX_CHANNEL_NUMBER);
                if (own) await setChannelNumberRow(tx, own.number, number, true);
                else {
                    await insertChannelNumbers(tx, [
                        {
                            number,
                            backupGroupId: card.backupGroupId,
                            channelId: card.channelId,
                            pinned: true,
                        },
                    ]);
                }
                if (target !== null) {
                    await insertChannelNumbers(tx, [
                        {
                            number: target,
                            backupGroupId: holder.backupGroupId ?? holder.channelGroupId,
                            channelId: holder.channelId,
                            pinned: own ? true : holder.pinned,
                        },
                    ]);
                }
                return { status: 'ok', number } as const;
            }
        }
        if (own) {
            await setChannelNumberRow(tx, own.number, number, true);
        } else {
            await insertChannelNumbers(tx, [
                {
                    number,
                    backupGroupId: card.backupGroupId,
                    channelId: card.channelId,
                    pinned: true,
                },
            ]);
        }
        return { status: 'ok', number } as const;
    });
}

/** Hands a card's number back to automatic numbering (it stays where it is). */
export async function unpinChannelNumber(sql: postgres.Sql, channelId: string): Promise<boolean> {
    return withTx(sql, async (txRaw) => {
        const tx = txRaw as unknown as postgres.Sql;
        await lockChannelNumbers(tx);
        const card = await getChannelCard(tx, channelId);
        if (!card) return false;
        const own = rowOfCard(await getChannelNumberRows(tx), card.backupGroupId ?? card.channelId);
        if (own) await setChannelNumberPinned(tx, own.number, false);
        return true;
    });
}

/** "Renumber in current order" (see planRenumber). Returns how many cards have a number. */
export async function renumberChannels(sql: postgres.Sql): Promise<number> {
    return withTx(sql, async (txRaw) => {
        const tx = txRaw as unknown as postgres.Sql;
        await lockChannelNumbers(tx);
        const [rows, numberRows, categories] = await Promise.all([
            getAllVisibleChannels(tx),
            getChannelNumberRows(tx),
            getNumberCategories(tx),
        ]);
        const plan = planRenumber({
            cards: toCards(rows),
            rows: numberRows,
            categories,
            keepHidden: config.LIVETV_KEEP_HIDDEN_CHANNEL_NUMBERS,
        });
        await applyPlan(tx, plan);
        return plan.numbers.size;
    });
}

// =============================================================================
// Re-import: a re-import replaces every channel (new ids); the numbers follow
// the old channels to their new rows through the refresh matcher.
// =============================================================================

/** Provider identities shared by channel-number and favourite carry-over. */
export async function snapshotSourceChannelIdentities(
    sql: postgres.Sql,
    sourceId: string,
): Promise<ExistingChannel[]> {
    const channels = await getChannelsForRefresh(sql, sourceId);
    const providerTitles = await getProviderChannelTitles(sql, sourceId);
    return channels.map((ch) => ({
        id: ch.id,
        name: providerTitles.get(ch.id) ?? ch.name,
        streamUrl: ch.stream_url,
        epgChannelId: ch.epg_channel_id ?? undefined,
        qualityTier: ch.quality_tier ?? undefined,
        categoryId: ch.category_id ?? undefined,
        categoryName: ch.category_name ?? undefined,
        backupGroupId: ch.backup_group_id ?? undefined,
        sortOrder: ch.sort_order,
        isVisible: ch.is_visible,
        adminDisplayName: undefined,
        countryCode: ch.country_code ?? undefined,
        consecutiveAbsences: ch.consecutive_absences,
    }));
}

export interface ChannelNumberSnapshot {
    existing: ExistingChannel[];
    numberOf: Map<string, { number: number; pinned: boolean }>;
}

/** The numbers of a source's channels, taken before a re-import deletes them. */
export async function snapshotSourceNumbers(
    sql: postgres.Sql,
    sourceId: string,
): Promise<ChannelNumberSnapshot | null> {
    const numberRows = await getChannelNumberRows(sql);
    if (numberRows.length === 0) return null;
    const channels = await snapshotSourceChannelIdentities(sql, sourceId);
    const numberOf = new Map<string, { number: number; pinned: boolean }>();
    for (const channel of channels) {
        const row = rowOfCard(numberRows, channel.backupGroupId ?? channel.id);
        if (row) numberOf.set(channel.id, { number: row.number, pinned: row.pinned });
    }
    if (numberOf.size === 0) return null;
    // Match on the provider's name: an admin rename is not in the new playlist
    // and would drop a URL-only match below the matcher's threshold.
    const existing = channels.filter((ch) => numberOf.has(ch.id));
    return { existing, numberOf };
}

export interface ImportedChannel {
    processed: ProcessedChannel;
    id: string;
    backupGroupId: string | null;
}

/**
 * Gives the re-imported channels the numbers their old rows had. Several old
 * channels landing in one new card: the pinned number, else the lowest. Old
 * numbers nobody matched become orphans and are freed by the next
 * ensureChannelNumbers. Run inside the re-import transaction. Returns how many
 * numbers moved over.
 */
export async function carryOverChannelNumbers(
    sql: postgres.Sql,
    snapshot: ChannelNumberSnapshot,
    imported: ImportedChannel[],
): Promise<number> {
    await lockChannelNumbers(sql); // re-entrant: the import took it before the snapshot
    const byProcessed = new Map(imported.map((ch) => [ch.processed, ch]));
    const result = matchChannels(
        snapshot.existing,
        imported.map((ch) => ch.processed),
    );
    const best = new Map<
        string,
        { number: number; pinned: boolean; channelId: string; backupGroupId: string | null }
    >();
    for (const match of result.matched) {
        const old = snapshot.numberOf.get(match.existingChannel.id);
        const fresh = byProcessed.get(match.newChannel);
        if (!old || !fresh) continue;
        const key = fresh.backupGroupId ?? fresh.id;
        const current = best.get(key);
        const better =
            !current ||
            Number(old.pinned) > Number(current.pinned) ||
            (old.pinned === current.pinned && old.number < current.number);
        if (better) {
            best.set(key, { ...old, channelId: fresh.id, backupGroupId: fresh.backupGroupId });
        }
    }
    // A number whose owner survived the delete stays with it: a backup group
    // that also holds another source's feed is still that station.
    const stillOwned = new Set(
        (await getChannelNumberRows(sql))
            .filter((row) => row.ownerAlive && rowKey(row) !== null)
            .map((row) => row.number),
    );
    // One number can reach two new cards when the matcher pairs one old
    // channel twice; the first card in number order keeps it.
    const seen = new Set<number>(stillOwned);
    const inserts = [...best.values()]
        .sort((a, b) => a.number - b.number)
        .filter((entry) => !seen.has(entry.number) && seen.add(entry.number));
    await deleteChannelNumbers(
        sql,
        inserts.map((entry) => entry.number),
    );
    await insertChannelNumbers(sql, inserts);
    return inserts.length;
}
