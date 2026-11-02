// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import type postgres from 'postgres';
import { z } from 'zod';
import { joinUpstreamUrl } from '$lib/shared/upstream-url.js';
import { fetchWithTimeout } from '$lib/server/utils/fetch-timeout.js';
import { config } from '$lib/server/config.js';
import { AudiobookshelfUserAuthError } from '$lib/server/audiobookshelf.js';
import { PluginSecrets } from '../tasks/secrets.js';
import {
    selectAudiobookshelfSyncUsers,
    type AudiobookshelfSyncAudienceOptions,
} from './audiobookshelf-sync-users.js';
import {
    AUDIOBOOKSHELF_PLUGIN_ID,
    API_KEY_SECRET,
    foldUsername,
} from './audiobookshelf-credentials.service.js';

const UsersSchema = z.object({
    users: z.array(
        z.object({
            id: z.string(),
            username: z.string(),
            type: z.string().optional(),
            isActive: z.boolean().optional(),
        }),
    ),
});

export interface AudiobookshelfUserMatches {
    userMatchStatus: 'ok';
    adminUsername: string;
    adminMatched: boolean;
    matchedName: string | null;
    matchedUsernames: string[];
    unmatchedUsernames: string[];
    pendingUsernames: string[];
}

export async function checkAudiobookshelfUserMatches(
    sql: postgres.Sql,
    url: string,
    apiKey: string,
    adminUsername = '',
    options: AudiobookshelfSyncAudienceOptions = {},
): Promise<AudiobookshelfUserMatches> {
    let absUsers: z.infer<typeof UsersSchema>['users'];
    try {
        const response = await fetchWithTimeout(
            joinUpstreamUrl(url, '/api/users'),
            { headers: { Authorization: `Bearer ${apiKey}` } },
            10_000,
        );
        if (!response.ok) throw new Error('User enumeration failed');
        absUsers = UsersSchema.parse(await response.json()).users;
    } catch {
        throw new Error('Audiobookshelf user check unavailable');
    }
    const { users, skippedUsernames } = await selectAudiobookshelfSyncUsers(sql, options);
    const secrets = new PluginSecrets(sql);
    const matchedUsernames: string[] = [];
    const unmatchedUsernames: string[] = [];
    const pendingUsernames: string[] = [];
    // A stored key may link accounts whose names differ. Track upstream IDs
    // as well as local/skipped names so neither becomes a false orphan.
    const representedIds = new Set<string>();
    // Disabled/deleted users still own their names; their ABS accounts are
    // deliberately outside the sync audience, rather than orphaned.
    const localUsers = await sql<{ username: string }[]>`SELECT username FROM users`;
    const localNames = new Set(
        [
            ...localUsers.map((user) => user.username),
            ...users.map((user) => user.username),
            ...skippedUsernames,
        ].map(foldUsername),
    );
    let matchedName: string | null = null;
    for (const user of users) {
        try {
            const resolution = await user.resolve({
                listUsers: async () => absUsers,
                readKey: (listener) =>
                    secrets.getUserRaw(AUDIOBOOKSHELF_PLUGIN_ID, listener.userId, API_KEY_SECRET),
                readLinked: async (key) => {
                    const response = await fetchWithTimeout(
                        joinUpstreamUrl(url, '/api/me'),
                        {
                            headers: { Authorization: `Bearer ${key}` },
                        },
                        10_000,
                    );
                    if (!response.ok) throw new AudiobookshelfUserAuthError(response.status);
                    return UsersSchema.shape.users.element.parse(await response.json());
                },
            });
            if (resolution.kind === 'linked' || resolution.kind === 'name') {
                representedIds.add(resolution.account.id);
                matchedUsernames.push(user.username);
                if (foldUsername(user.username) === foldUsername(adminUsername))
                    matchedName = resolution.account.username;
            } else if (
                resolution.kind === 'missing' &&
                config.AUDIOBOOK_AUTO_CREATE_USERS !== false
            ) {
                pendingUsernames.push(user.username);
            } else {
                unmatchedUsernames.push(user.username);
            }
        } catch {
            throw new Error('Audiobookshelf user check unavailable');
        }
    }
    for (const account of absUsers) {
        if (account.type === 'root' || account.type === 'guest' || account.isActive === false)
            continue;
        if (!representedIds.has(account.id) && !localNames.has(foldUsername(account.username))) {
            unmatchedUsernames.push(account.username);
        }
    }
    return {
        userMatchStatus: 'ok',
        adminUsername,
        adminMatched:
            matchedName !== null &&
            ![...unmatchedUsernames, ...pendingUsernames, ...skippedUsernames].some(
                (name) => foldUsername(name) === foldUsername(adminUsername),
            ),
        matchedName,
        matchedUsernames: matchedUsernames.sort(),
        unmatchedUsernames: [
            ...new Map(unmatchedUsernames.map((name) => [foldUsername(name), name])).values(),
        ].sort(),
        pendingUsernames: pendingUsernames.sort(),
    };
}
