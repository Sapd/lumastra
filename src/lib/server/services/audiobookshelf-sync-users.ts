// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import type postgres from 'postgres';
import { AudiobookshelfUserAuthError } from '$lib/server/audiobookshelf.js';
import {
    AUDIOBOOKSHELF_PLUGIN_ID,
    API_KEY_SECRET,
    PULL_DISABLED_SECRET,
    foldUsername,
    matchAbsUser,
    type AbsUserSummary,
} from './audiobookshelf-credentials.service.js';

export interface AudiobookshelfSyncAudienceOptions {
    direction?: 'pull' | 'push';
    onlyUserIds?: readonly string[];
    knownUsernames?: ReadonlySet<string>;
}

interface Listener {
    userId: string;
    username: string;
    pullDisabled?: boolean;
}

export interface AudiobookshelfSyncReader<T> {
    readKey(user: Listener): Promise<string | null>;
    readLinked(key: string): Promise<T>;
    listUsers(): Promise<AbsUserSummary[]>;
}

export type AudiobookshelfSyncResolution<T> =
    | { kind: 'linked'; account: T }
    | { kind: 'name'; account: AbsUserSummary }
    | { kind: 'rejected'; error: AudiobookshelfUserAuthError }
    | { kind: 'missing' | 'ambiguous' };

export interface AudiobookshelfSyncUser extends Listener {
    linked: boolean;
    resolve<T>(reader: AudiobookshelfSyncReader<T>): Promise<AudiobookshelfSyncResolution<T>>;
}

export interface AudiobookshelfSyncAudience {
    users: AudiobookshelfSyncUser[];
    skippedUsernames: string[];
}

export async function selectAudiobookshelfSyncUsers(
    sql: postgres.Sql,
    options: AudiobookshelfSyncAudienceOptions = {},
): Promise<AudiobookshelfSyncAudience> {
    const linked = await sql<Listener[]>`
        SELECT puc.user_id AS "userId", u.username AS "username"
          FROM plugin_user_credentials puc
          JOIN users u ON u.id = puc.user_id
         WHERE puc.plugin_id = ${AUDIOBOOKSHELF_PLUGIN_ID}
           AND puc.key = ${API_KEY_SECRET}
    `;
    const linkedIds = new Set(linked.map((user) => user.userId));
    let users: Listener[] =
        options.direction === 'push'
            ? linked
            : await sql<Listener[]>`
        SELECT u.id AS "userId", u.username,
               EXISTS (
                   SELECT 1 FROM plugin_user_credentials puc
                    WHERE puc.user_id = u.id
                      AND puc.plugin_id = ${AUDIOBOOKSHELF_PLUGIN_ID}
                      AND puc.key = ${PULL_DISABLED_SECRET}
               ) AS "pullDisabled"
          FROM users u
         WHERE u.disabled_at IS NULL
           AND u.deleted_at IS NULL
    `;
    const allUsers = users;
    if (options.direction !== 'push') {
        const only = options.onlyUserIds ? new Set(options.onlyUserIds) : null;
        users = users.filter(
            (user) =>
                !user.pullDisabled &&
                (!only || only.has(user.userId)) &&
                (!options.knownUsernames ||
                    options.knownUsernames.has(foldUsername(user.username))),
        );
    }
    let upstream: Promise<AbsUserSummary[]> | undefined;
    const selectedIds = new Set(users.map((user) => user.userId));
    return {
        skippedUsernames: allUsers
            .filter((user) => !selectedIds.has(user.userId))
            .map((user) => user.username),
        users: users.map((user) => ({
            ...user,
            linked: linkedIds.has(user.userId),
            async resolve<T>(
                reader: AudiobookshelfSyncReader<T>,
            ): Promise<AudiobookshelfSyncResolution<T>> {
                if (linkedIds.has(user.userId)) {
                    try {
                        const key = await reader.readKey(user);
                        if (!key)
                            return {
                                kind: 'rejected',
                                error: new AudiobookshelfUserAuthError(401),
                            };
                        return { kind: 'linked', account: await reader.readLinked(key) };
                    } catch (error) {
                        if (
                            error instanceof AudiobookshelfUserAuthError &&
                            error.credentialRejected
                        ) {
                            return { kind: 'rejected', error };
                        }
                        throw error;
                    }
                }
                upstream ??= reader.listUsers();
                const absUsers = await upstream;
                const account = matchAbsUser(absUsers, user.username);
                if (account) return { kind: 'name', account };
                const key = foldUsername(user.username);
                return {
                    kind: absUsers.some((candidate) => foldUsername(candidate.username) === key)
                        ? 'ambiguous'
                        : 'missing',
                };
            },
        })),
    };
}
