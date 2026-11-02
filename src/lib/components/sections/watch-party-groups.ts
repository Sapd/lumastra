// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Folding Active Streams rows into watch-party cards — pure, no Svelte.
 *
 * The server tags each stream row that belongs to a visible party with
 * `watchParty` (see server/services/watch-party-stream-overlay.ts). Rows that
 * share a `groupId` are one party and render as ONE card, whose representative
 * row (the host's, when the host is streaming) supplies the artwork/title.
 */

import * as m from '$lib/paraglide/messages';
import type { StreamSession as ApiStreamSession } from '$lib/schemas/api-playback-responses';

export type WatchPartyTag = NonNullable<ApiStreamSession['watchParty']>;
export type WatchPartySyncState = WatchPartyTag['syncState'];

/** The fields grouping needs; the widget's own row type is a superset. */
export interface PartyGroupableRow {
    username: string;
    userId?: string;
    clientApp?: string;
    clientPlayerName?: string;
    clientname?: string;
    browsername?: string;
    playIsPlaying?: boolean;
    watchParty?: WatchPartyTag;
}

export interface WatchPartyMember {
    key: string;
    displayName: string;
    userId?: string;
    isHost: boolean;
    isStalled: boolean;
    driftSeconds?: number;
    device?: string;
}

export interface StreamGroup<T extends PartyGroupableRow> {
    key: string;
    /** Row the card renders (host's row when the host is streaming). */
    session: T;
    /** Every row folded into this card — length 1 for an ordinary stream. */
    rows: T[];
    /** Present only for a watch-party card. */
    party?: {
        tag: WatchPartyTag;
        members: WatchPartyMember[];
    };
}

function deviceLabel(row: PartyGroupableRow): string | undefined {
    return row.clientApp || row.clientPlayerName || row.clientname || row.browsername || undefined;
}

function toMember(row: PartyGroupableRow, key: string): WatchPartyMember {
    const tag = row.watchParty;
    return {
        key,
        displayName: row.username,
        userId: row.userId,
        isHost: tag?.isHost ?? false,
        isStalled: tag?.isStalled ?? false,
        driftSeconds: tag?.driftSeconds,
        device: deviceLabel(row),
    };
}

/**
 * Fold per-row groups (already keyed + ordered by the widget) into party
 * cards. A party card takes the position of its first row, so the widget's
 * playing-first ordering still holds.
 */
export function foldWatchParties<T extends PartyGroupableRow>(
    groups: ReadonlyArray<{ key: string; session: T }>,
): StreamGroup<T>[] {
    const out: StreamGroup<T>[] = [];
    const partyIndex = new Map<string, number>();

    for (const g of groups) {
        const tag = g.session.watchParty;
        if (!tag) {
            out.push({ key: g.key, session: g.session, rows: [g.session] });
            continue;
        }
        const existing = partyIndex.get(tag.groupId);
        if (existing === undefined) {
            partyIndex.set(tag.groupId, out.length);
            out.push({
                key: `party::${tag.groupId}`,
                session: g.session,
                rows: [g.session],
                party: { tag, members: [toMember(g.session, g.key)] },
            });
            continue;
        }
        const card = out[existing];
        card.rows.push(g.session);
        card.party?.members.push(toMember(g.session, g.key));
        // The host's row represents the party; the tag (code, counts, sync
        // state) is identical across rows except the per-row fields.
        if (tag.isHost && !card.session.watchParty?.isHost) card.session = g.session;
    }

    for (const card of out) {
        if (!card.party) continue;
        card.party.tag = card.session.watchParty ?? card.party.tag;
        // Host first, then by name — stable faces across polls.
        card.party.members.sort((a, b) =>
            a.isHost !== b.isHost
                ? a.isHost
                    ? -1
                    : 1
                : a.displayName.localeCompare(b.displayName, undefined, { sensitivity: 'base' }),
        );
    }
    return out;
}

/** "+0.4s" / "−1.2s" / "±0.0s"; "—" when not measurable. */
export function formatPartyDrift(drift: number | undefined): string {
    if (drift === undefined || !Number.isFinite(drift)) return '—';
    const abs = Math.abs(drift).toFixed(1);
    if (abs === '0.0') return '±0.0s';
    return `${drift > 0 ? '+' : '−'}${abs}s`;
}

export function partySyncLabel(state: WatchPartySyncState, stalledName?: string): string {
    switch (state) {
        case 'synced':
            return m.session_party_sync_synced();
        case 'drifting':
            return m.session_party_sync_drifting();
        case 'buffering':
            return stalledName
                ? m.session_party_sync_waiting_for({ name: stalledName })
                : m.session_party_sync_buffering();
        case 'paused':
            return m.session_party_sync_paused();
        default:
            return m.session_party_sync_unknown();
    }
}
