// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { randomUUID } from 'node:crypto';
import { afterAll, describe, it, expect } from 'vitest';
import { getTestDb, closeTestDb } from '../../../../../tests/integration/setup/test-database.js';
import { resolveUploadAttachmentTargets } from './upload-attachment-targets.queries.js';
import {
    createUploadSession,
    finalizeUploadSession,
    getUploadSessionById,
} from './upload-sessions.queries.js';

afterAll(closeTestDb);
describe('upload attachment target resolution', () => {
    it('uses the exact finalized path and library, asks for a real ambiguous choice, and preserves an explicit target', async () => {
        const sql = getTestDb();
        const group = randomUUID();
        const pathId = randomUUID();
        const first = randomUUID();
        const second = randomUUID();
        const fileId = randomUUID();
        let uploadId: string | undefined;
        try {
            await sql`INSERT INTO library_groups (id,name) VALUES (${group},${`Upload ${group}`})`;
            await sql`INSERT INTO library_paths (id,path,media_type,library_group_id) VALUES (${pathId},'/uploads/visible-link','home_video',${group})`;
            const session = await createUploadSession(sql, {
                library_path_id: pathId,
                uploader_user: 'attachment-test-admin',
                filename: 'Lantern Film.mp4',
                mime_type: 'video/mp4',
                total_size: 10,
                total_chunks: 1,
                destination_folder: '',
                staging_dir: '/tmp/attachment-test',
            });
            uploadId = session.id;
            expect(
                await resolveUploadAttachmentTargets(sql, session, '/uploads/visible-link'),
            ).toEqual({ status: 'pending', targets: [] });
            // Finalization resolves symlinks: the stored final path is authoritative.
            await finalizeUploadSession(
                sql,
                session.id,
                null,
                null,
                '/uploads/resolved/Lantern Film.mp4',
            );
            const queued = (await getUploadSessionById(sql, session.id))!;
            expect(
                await resolveUploadAttachmentTargets(sql, queued, '/uploads/visible-link'),
            ).toMatchObject({ status: 'pending', targets: [] });
            await sql`INSERT INTO media_items (id,title,media_type) VALUES (${first},'Lantern Film — Arrival','movie'),(${second},'Lantern Film — Departure','movie')`;
            await sql`INSERT INTO media_files (id,file_path,library_group_id) VALUES (${fileId},'/uploads/resolved/Lantern Film.mp4',${group})`;
            await sql`INSERT INTO media_file_items (file_id,media_item_id,is_default) VALUES (${fileId},${first},true)`;
            expect(
                await resolveUploadAttachmentTargets(sql, queued, '/uploads/visible-link'),
            ).toMatchObject({
                status: 'ready',
                targetId: first,
                targets: [{ id: first, title: 'Lantern Film — Arrival' }],
            });
            expect(
                await resolveUploadAttachmentTargets(
                    sql,
                    { ...queued, media_item_id: second },
                    '/uploads/visible-link',
                ),
            ).toMatchObject({ status: 'ambiguous', targetId: undefined });
            await sql`INSERT INTO media_file_items (file_id,media_item_id,is_default) VALUES (${fileId},${second},true)`;
            const ambiguous = await resolveUploadAttachmentTargets(
                sql,
                queued,
                '/uploads/visible-link',
            );
            expect(ambiguous.status).toBe('ambiguous');
            expect(ambiguous.targetId).toBeUndefined();
            expect(ambiguous.targets).toHaveLength(2);
            await finalizeUploadSession(sql, session.id, null, second);
            expect(
                await resolveUploadAttachmentTargets(
                    sql,
                    (await getUploadSessionById(sql, session.id))!,
                    '/uploads/visible-link',
                ),
            ).toMatchObject({ status: 'ready', targetId: second });
            await sql`UPDATE media_files SET is_missing=true WHERE id=${fileId}`;
            expect(
                await resolveUploadAttachmentTargets(sql, queued, '/uploads/visible-link'),
            ).toMatchObject({ status: 'pending', targets: [] });
        } finally {
            if (uploadId) await sql`DELETE FROM upload_sessions WHERE id=${uploadId}`;
            await sql`DELETE FROM media_items WHERE id IN (${first},${second})`;
            await sql`DELETE FROM media_files WHERE id=${fileId}`;
            await sql`DELETE FROM library_paths WHERE id=${pathId}`;
            await sql`DELETE FROM library_groups WHERE id=${group}`;
        }
    });
});
