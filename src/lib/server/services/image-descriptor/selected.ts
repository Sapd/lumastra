// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import type postgres from 'postgres';
import type { ImageCandidateWithLocalContent } from '$lib/server/database/queries/image-descriptor.queries.js';
import type { ImageType } from '../image-proxy/types.js';
import { getImageDescriptorOwners } from '$lib/server/database/queries/image-descriptor.queries.js';
import { getSelectedImageCandidate } from '$lib/server/database/queries/image-candidates.queries.js';
import { resolveImageSpecsForOwner } from './resolver.js';
import { chainFor } from './chains.js';

export interface SelectedImageCandidate extends ImageCandidateWithLocalContent {
    /** Revision from the same DB snapshot as this selected identity. */
    contentRevision?: string;
    /** ABS source version read with the elected identity. */
    absCoverUpdatedAt?: string | null;
}

export async function resolveSelectedImageCandidate(
    sql: postgres.Sql,
    id: string,
    type: ImageType,
    inherit?: 'none',
    index = 0,
): Promise<SelectedImageCandidate | null> {
    const rows = await getImageDescriptorOwners(sql, [id]);
    const own = rows.find((r) => r.id === id);
    if (!own) return null;
    const role = type === 'still' ? 'thumb' : type;
    const chain = chainFor(own.media_type, role);
    const normalizedChain = chain.length
        ? chain
        : role === 'poster'
          ? chainFor(own.media_type, 'primary')
          : role === 'primary'
            ? chainFor(own.media_type, 'poster')
            : chain;
    for (const step of normalizedChain) {
        if (inherit === 'none' && step.owner !== 'self') continue;
        const owner =
            step.owner === 'self'
                ? own
                : rows.find((r) =>
                      step.owner === 'series' ? r.media_type === 'tv' : r.media_type === step.owner,
                  );
        const slot =
            step.role === 'primary' ? 'poster' : step.role === 'still' ? 'thumb' : step.role;
        if (!owner || slot === 'avatar') continue;
        const candidate = owner.selected_candidates?.[slot];
        if (!candidate) continue;
        if (index && role === 'backdrop')
            return getSelectedImageCandidate(sql, owner.id, 'backdrop', index);
        if (index) return null;
        const specs = resolveImageSpecsForOwner(own, new Map(rows.map((row) => [row.id, row])), {
            inherit,
        });
        const spec =
            specs[role] ??
            (role === 'poster' ? specs.primary : role === 'primary' ? specs.poster : undefined);
        return {
            ...candidate,
            absCoverUpdatedAt:
                candidate.provider === 'audiobookshelf' ? owner.abs_cover_updated_at : undefined,
            contentRevision:
                spec?.ownerId === owner.id && spec.urlRole === slot ? spec.revision : undefined,
        };
    }
    return null;
}
