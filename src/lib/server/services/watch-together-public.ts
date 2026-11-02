// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import type { ImageSet } from '$lib/schemas/api-image-descriptor';
import type { PublicAuthor } from '$lib/schemas/public-author';
import type { WatchTogetherParty, WatchTogetherFrame } from '$lib/schemas/watch-together';
import { userAvatarSet } from '$lib/shared/image-descriptor';
import { buildPublicAuthor } from '$lib/shared/public-author';
import type { ApiSurface } from '$lib/shared/api-urls';
import { getDb } from '$lib/server/database/connection.js';
import { userImageSets } from '$lib/server/services/image-descriptor/avatars.js';
import { getUserDisplayInfoByIds } from '$lib/server/database/queries/users.queries.js';
import { Logger } from '$lib/server/utils/logger';
import type { StoredSession, StoredFrame } from './watch-together.service';

export async function publicAuthors(
    ids: string[],
    surface: ApiSurface,
): Promise<Map<string, PublicAuthor>> {
    const unique = [...new Set(ids)];
    const sql = getDb();
    const rows = sql
        ? await getUserDisplayInfoByIds(sql, unique).catch((error: unknown) => {
              Logger.for('WatchTogether').warn(
                  'Public author lookup failed; using null display names',
                  {},
                  error instanceof Error ? error : new Error(String(error)),
              );
              return [];
          })
        : [];
    const names = new Map(rows.map((row) => [row.id, row.display_name]));
    const sets =
        sql && rows.length > 0
            ? await userImageSets(sql, surface, unique, { external: false }).catch((error: unknown) => {
                  Logger.for('WatchTogether').warn(
                      'Public author avatar lookup failed; using generated avatars',
                      {},
                      error instanceof Error ? error : new Error(String(error)),
                  );
                  return new Map<string, ImageSet>();
              })
            : new Map<string, ImageSet>();
    return new Map(
        unique.map((id) => [
            id,
            buildPublicAuthor(id, names.get(id) ?? null, surface, sets.get(id)),
        ]),
    );
}

export async function toPublicParties(
    sessions: StoredSession[],
    surface: ApiSurface,
): Promise<WatchTogetherParty[]> {
    const authors = await publicAuthors(
        sessions.flatMap((s) => [s.hostUserId, ...s.participants.map((p) => p.userId)]),
        surface,
    );
    return sessions.map(({ hostUserId, hostDisplayName: _storedName, participants, ...party }) => ({
        ...party,
        host: authors.get(hostUserId)!,
        participants: participants.map(({ userId, joinedAt, clientId }) => ({
            ...authors.get(userId)!,
            joinedAt,
            clientId,
        })),
    }));
}

export async function toPublicParty(
    session: StoredSession,
    surface: ApiSurface,
): Promise<WatchTogetherParty> {
    return (await toPublicParties([session], surface))[0];
}

/** Resolve names before durable replay/publication; never expose the stored login-era name. */
export async function toPublicFrame(event: StoredFrame): Promise<WatchTogetherFrame> {
    if ('userId' in event) {
        const { userId, displayName: _storedName, ...frame } = event;
        const authors = await publicAuthors([userId], 'v1');
        return { ...frame, author: authors.get(userId)! };
    }
    if (event.type === 'participant_joined') {
        const { userId, joinedAt, clientId } = event.participant;
        const authors = await publicAuthors([userId], 'v1');
        return { type: event.type, participant: { ...authors.get(userId)!, joinedAt, clientId } };
    }
    if (event.type === 'host_changed') {
        const authors = await publicAuthors([event.newHostUserId], 'v1');
        return {
            type: event.type,
            newHost: authors.get(event.newHostUserId)!,
            newHostClientId: event.newHostClientId,
        };
    }
    if (event.type === 'session_ended') {
        const authors = await publicAuthors([event.hostUserId], 'v1');
        return { type: event.type, host: authors.get(event.hostUserId)! };
    }
    return event;
}

/** Replay and live frames use the surface of the receiving SSE connection. */
export function toPublicFramesForSurface(
    frame: WatchTogetherFrame,
    surface: ApiSurface,
): WatchTogetherFrame {
    // Same revision and source, hrefs rebuilt for the receiving connection's surface.
    const author = (a: PublicAuthor): PublicAuthor =>
        buildPublicAuthor(
            a.userId,
            a.displayName,
            surface,
            userAvatarSet(surface, {
                userId: a.userId,
                version: a.images.primary.revision,
                generated: a.images.primary.source === 'generated',
            }),
        );
    if ('author' in frame) return { ...frame, author: author(frame.author) };
    if (frame.type === 'participant_joined')
        return { ...frame, participant: { ...frame.participant, ...author(frame.participant) } };
    if (frame.type === 'host_changed') return { ...frame, newHost: author(frame.newHost) };
    if (frame.type === 'session_ended') return { ...frame, host: author(frame.host) };
    return frame;
}
