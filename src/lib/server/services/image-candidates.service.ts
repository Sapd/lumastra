// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import type { AuditActor } from '$lib/server/utils/audit-log.js';
import { isUuid, normalizeUuid } from '$lib/server/utils/media-key-parser.js';
import { createHash } from 'node:crypto';
import type postgres from 'postgres';
import type { z } from 'zod';
import type { CandidateMutationSchema, ImageCandidate } from '$lib/schemas/image-candidates.js';
import { withTx } from '$lib/server/database/with-tx.js';
import { captureArtworkChoice } from '$lib/server/database/queries/artwork-choice.queries.js';
import { recordMediaChange } from '$lib/server/database/queries/admin-media-change.queries.js';
import { lockArtworkChoice, undoArtworkChoice } from './artwork-choice.service.js';
import {
    listImageCandidates,
    selectImageCandidate,
    suppressProviderImageCandidates,
    updateImageSelectionPolicy,
} from '$lib/server/database/queries/image-candidates.queries.js';
import { insertAdminAuditEvent } from '$lib/server/database/queries/admin-audit.queries.js';
import { getImageProxyService } from './image-proxy/index.js';
import { config } from '$lib/server/config.js';

export class ImageCandidateConflict extends Error {}
export function imageCandidatesFingerprint(
    owner: string,
    provider: string,
    role: string | undefined,
    candidates: ImageCandidate[],
): string {
    return createHash('sha256')
        .update(JSON.stringify({ owner, provider, role: role ?? null, candidates }))
        .digest('hex');
}
export async function syncImageSelectionPolicy(sql: postgres.Sql): Promise<void> {
    await updateImageSelectionPolicy(
        sql,
        config.IMAGE_CANDIDATE_PROVIDER_ORDER,
        config.EPISODE_THUMBNAIL_PREFERENCE,
    );
}
export async function mutateImageCandidates(
    sql: postgres.Sql,
    ownerId: string,
    input: z.infer<typeof CandidateMutationSchema>,
    actor: string | AuditActor,
): Promise<{
    candidates: ImageCandidate[];
    fingerprint?: string;
    applied: boolean;
    deleted?: number;
    hidden?: number;
    undoId?: string;
}> {
    const id = isUuid(ownerId) ? normalizeUuid(ownerId) : ownerId;
    const audit: AuditActor = typeof actor === 'string' ? { username: actor } : actor;
    const result = await withTx(sql, async (tx) => {
        await lockArtworkChoice(tx, id);
        if (input.action === 'undo') {
            await undoArtworkChoice(tx, id, input.receiptId);
            return { candidates: await listImageCandidates(tx, id), applied: true };
        }
        const beforeState = await captureArtworkChoice(tx, id);
        const before = await listImageCandidates(tx, id);
        if (input.action === 'delete-provider' || input.action === 'suppress-provider') {
            const fingerprint = imageCandidatesFingerprint(
                id,
                input.provider,
                'role' in input ? input.role : undefined,
                before,
            );
            const affected = before.filter(
                (c) =>
                    c.provider === input.provider &&
                    (!('role' in input ? input.role : undefined) ||
                        c.artwork_type === ('role' in input ? input.role : undefined)),
            );
            if (input.action === 'delete-provider' && input.mode === 'preview')
                return { candidates: affected, fingerprint, applied: false };
            if (input.action === 'delete-provider' && input.fingerprint !== fingerprint)
                throw new ImageCandidateConflict(
                    'Image candidates changed. Preview again before applying.',
                );
            const hidden = await suppressProviderImageCandidates(
                tx,
                id,
                input.provider,
                'role' in input ? input.role : undefined,
            );
            await insertAdminAuditEvent(tx, {
                instanceId: config.INSTANCE_ID,
                actor: audit.username ?? 'system',
                principalKind: audit.kind,
                credentialId: audit.credentialId,
                action: 'media.images.suppress-provider',
                target: id,
                outcome: 'ok',
                detail: {
                    provider: input.provider,
                    role: 'role' in input ? input.role : undefined,
                    candidates: affected.map((c) => c.id),
                    hidden,
                    retained: true,
                },
            });
            const undoId = await recordMediaChange(
                tx,
                id,
                'artwork',
                beforeState,
                await captureArtworkChoice(tx, id),
                audit.username ?? 'system',
            );
            return {
                candidates: await listImageCandidates(tx, id),
                applied: true,
                deleted: 0,
                hidden,
                undoId,
            };
        }
        if (input.action === 'automatic') {
            await tx`DELETE FROM image_provider_suppressions WHERE owner=${id} AND provider='*' AND role=${input.role}`;
            if (isUuid(id))
                await tx`DELETE FROM media_artwork_suppressions WHERE media_item_id=${id} AND artwork_type=${input.role}`;
            await tx`UPDATE image_candidates SET locked=false,chosen_by='auto',suppressed=false
                WHERE (media_item_id=${isUuid(id) ? id : null}::uuid OR person_ref=${isUuid(id) ? null : id})
                    AND artwork_type=${input.role}`;
            if (isUuid(id)) await tx`SELECT reselect_image_candidates(${id}::uuid,${input.role})`;
            else await tx`SELECT reselect_person_images(${id})`;
        } else if (input.action === 'hide') {
            const [candidate] = await tx<{ artwork_type: string }[]>`
                SELECT artwork_type FROM image_candidates WHERE id=${input.candidateId} AND
                (media_item_id=${isUuid(id) ? id : null}::uuid OR person_ref=${isUuid(id) ? null : id})`;
            if (!candidate)
                throw new ImageCandidateConflict('Candidate does not belong to this media item.');
            // Archive this image only; other sources remain eligible for the slot.
            if (isUuid(id))
                await tx`INSERT INTO media_artwork_suppressions (media_item_id,artwork_type,file_path)
                SELECT media_item_id,artwork_type,file_path FROM image_candidates
                WHERE id=${input.candidateId} AND file_path IS NOT NULL ON CONFLICT DO NOTHING`;
            await tx`UPDATE image_candidates SET suppressed=true,selected=false,locked=false
                WHERE id=${input.candidateId}`;
        } else if (
            !(await selectImageCandidate(
                tx,
                id,
                input.candidateId,
                input.locked,
                input.action === 'select',
            ))
        ) {
            throw new ImageCandidateConflict(
                'Candidate does not belong to this media item or is hidden.',
            );
        }
        await insertAdminAuditEvent(tx, {
            instanceId: config.INSTANCE_ID,
            actor: audit.username ?? 'system',
            principalKind: audit.kind,
            credentialId: audit.credentialId,
            action: `media.images.${input.action}`,
            target: id,
            outcome: 'ok',
            detail: { action: input.action },
        });
        const undoId = await recordMediaChange(
            tx,
            id,
            'artwork',
            beforeState,
            await captureArtworkChoice(tx, id),
            audit.username ?? 'system',
        );
        return { candidates: await listImageCandidates(tx, id), applied: true, undoId };
    });
    if (result.applied && isUuid(id)) getImageProxyService(sql).invalidateCatalogImage(id);
    return result;
}
