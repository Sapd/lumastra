// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// OpenSubsonic Compatibility Layer — User Handlers
// getUser, getUsers.

import type { RequestEvent } from '@sveltejs/kit';
import type postgres from 'postgres';
import { subsonicError, subsonicOk } from '$lib/server/subsonic-compat/serializers/response.js';
import type { SubsonicAuthContext, SubsonicHandler } from '$lib/server/subsonic-compat/types.js';
import { getParam } from '$lib/server/subsonic-compat/helpers.js';
import { getUserAdminStatus } from '$lib/server/database/queries/users.queries.js';

export const handleGetUser: SubsonicHandler = async (
    event: RequestEvent,
    auth: SubsonicAuthContext,
    sql: postgres.Sql,
): Promise<Response> => {
    const username = getParam(event, 'username');
    if (!username) {
        return subsonicError(10, 'Required parameter "username" is missing.', auth.format);
    }
    if (!auth.ownerIsAdmin && username.toLowerCase() !== auth.username.toLowerCase()) {
        return subsonicError(50, 'User is not authorized for the given operation.', auth.format);
    }

    const isTargetAdmin = await getUserAdminStatus(sql, username);
    if (isTargetAdmin === null) {
        return subsonicError(70, 'User not found.', auth.format);
    }

    return subsonicOk(
        {
            user: {
                username,
                scrobblingEnabled: true,
                adminRole: isTargetAdmin,
                settingsRole: isTargetAdmin,
                downloadRole: true,
                uploadRole: false,
                playlistRole: true,
                coverArtRole: true,
                commentRole: false,
                podcastRole: false,
                streamRole: true,
                jukeboxRole: false,
                shareRole: false,
                videoConversionRole: false,
                folder: [1],
            },
        },
        auth.format,
    );
};

// getUsers — return just the authenticated user (external auth prevents enumeration).
export const handleGetUsers: SubsonicHandler = async (
    _event: RequestEvent,
    auth: SubsonicAuthContext,
    sql: postgres.Sql,
): Promise<Response> => {
    const isAdmin = (await getUserAdminStatus(sql, auth.username)) ?? auth.ownerIsAdmin;

    return subsonicOk(
        {
            users: {
                user: [
                    {
                        username: auth.username,
                        scrobblingEnabled: true,
                        adminRole: isAdmin,
                        settingsRole: isAdmin,
                        downloadRole: true,
                        uploadRole: false,
                        playlistRole: true,
                        coverArtRole: true,
                        commentRole: false,
                        podcastRole: false,
                        streamRole: true,
                        jukeboxRole: false,
                        shareRole: false,
                        videoConversionRole: false,
                        folder: [1],
                    },
                ],
            },
        },
        auth.format,
    );
};
