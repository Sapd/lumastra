// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import type postgres from 'postgres';
import type { CategoryUpdateResponse, UpdateCategoryRequest } from '$lib/schemas/livetv.js';
import { withTx } from '$lib/server/database/with-tx.js';
import {
    renameCategory,
    updateCategoryVisibility,
    updateVisibleCategoryChannels,
} from '$lib/server/database/queries/livetv-channels.queries.js';
import {
    lockChannelNumbers,
    setCategoryNumberStart,
} from '$lib/server/database/queries/livetv-channel-numbers.queries.js';
import { renumberCategoryInTx } from './channel-numbers.service.js';

/** Apply category edits and their effect on channel numbers in the same transaction. */
export async function updateLiveTvCategory(
    sql: postgres.Sql,
    categoryId: string,
    update: UpdateCategoryRequest,
): Promise<CategoryUpdateResponse | null> {
    const { name, isVisible, channelVisibility, numberStart } = update;
    return withTx(sql, async (tx): Promise<CategoryUpdateResponse | null> => {
        // Imports take this lock before updating categories, too.
        if (numberStart !== undefined) await lockChannelNumbers(tx);

        if (name !== undefined && !(await renameCategory(tx, categoryId, name))) return null;
        const updatedCount =
            isVisible === undefined ? 0 : await updateCategoryVisibility(tx, categoryId, isVisible);

        let updatedChannelIds: string[] | undefined;
        if (channelVisibility !== undefined) {
            const showIds = channelVisibility === 'hide' ? null : channelVisibility.showIds;
            const ids = await updateVisibleCategoryChannels(tx, categoryId, showIds);
            if (!ids) return null;
            updatedChannelIds = ids;
        }

        let renumbered: number | undefined;
        if (numberStart !== undefined) {
            const result = await setCategoryNumberStart(
                tx,
                categoryId,
                numberStart === 0 ? null : numberStart,
            );
            if (!result) return null;
            if (numberStart !== 0 && result.changed) {
                renumbered = await renumberCategoryInTx(tx, categoryId);
            }
        }

        return {
            success: true,
            updatedCount: updatedChannelIds?.length ?? updatedCount,
            renumbered,
            updatedChannelIds,
        };
    });
}
