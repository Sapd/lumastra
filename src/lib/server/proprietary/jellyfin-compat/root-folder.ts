// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: LicenseRef-Lumastra-Proprietary
// Proprietary and source-available — not licensed under AGPL. See LICENSING.md.

/**
 * `GET /Items/Root` (UserLibraryController.GetRootFolder): the user's root
 * folder as a BaseItemDto. Its children are the library views, so ChildCount
 * is the number of libraries this user can see.
 */

import type postgres from 'postgres';
import { JELLYFIN_SERVER_ID, USER_ROOT_FOLDER_ID } from './constants';
import { buildLibraryViews, type LibraryViewUser } from './library-views-utils';
import type { JellyfinBaseItemDto } from './types';

export async function buildUserRootFolder(
    sql: postgres.Sql,
    user: LibraryViewUser,
): Promise<JellyfinBaseItemDto> {
    const views = await buildLibraryViews(sql, user);
    return {
        Name: 'Media Folders',
        Id: USER_ROOT_FOLDER_ID,
        ServerId: JELLYFIN_SERVER_ID,
        Etag: USER_ROOT_FOLDER_ID,
        Type: 'UserRootFolder',
        IsFolder: true,
        MediaType: 'Unknown',
        LocationType: 'FileSystem',
        SortName: 'media folders',
        ChildCount: views.length,
        LocalTrailerCount: 0,
        SpecialFeatureCount: 0,
        PlayAccess: 'Full',
        UserData: {
            PlaybackPositionTicks: 0,
            PlayedPercentage: 0,
            PlayCount: 0,
            IsFavorite: false,
            Played: false,
            Key: USER_ROOT_FOLDER_ID,
            ItemId: USER_ROOT_FOLDER_ID,
        },
        ImageTags: {},
        BackdropImageTags: [],
    };
}
