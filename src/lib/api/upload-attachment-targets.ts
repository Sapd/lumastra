// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { apiGet } from './client.js';
import { UploadAttachmentTargetsSchema } from '$lib/schemas/api-upload-responses.js';

export function getUploadAttachmentTargets(libraryPathId: string, uploadId: string) {
    return apiGet(
        `/api/admin/upload/${encodeURIComponent(libraryPathId)}/${encodeURIComponent(uploadId)}`,
        UploadAttachmentTargetsSchema,
    );
}
