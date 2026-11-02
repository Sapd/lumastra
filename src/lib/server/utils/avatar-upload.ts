// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Reading the multipart body of an avatar upload, shared by
 * PUT /api/image/user/{username}/avatar and PUT /api/v1/users/{id}/images/avatar.
 *
 * Two layers can refuse a large avatar, and both must come back as "too large"
 * (a 413), never a 500:
 *  - this module's own 2 MiB cap, the limit the UI states;
 *  - adapter-node's BODY_SIZE_LIMIT, which rejects inside `request.formData()`
 *    with a SvelteKitError that carries `status` 413 (not `statusCode`). The
 *    image sets it to 50M; unset, adapter-node defaults to 512K.
 */

import { isPayloadTooLargeError } from './bounded-body-reader';

/** Largest avatar file accepted, before re-encoding. */
export const AVATAR_MAX_UPLOAD_BYTES = 2 * 1024 * 1024;

/** Readable cap for error messages ("2 MB"), matching the UI's wording. */
export const AVATAR_MAX_UPLOAD_LABEL = `${AVATAR_MAX_UPLOAD_BYTES / 1024 / 1024} MB`;

/** Room for the multipart boundaries and part headers around the file. */
const MULTIPART_OVERHEAD_BYTES = 64 * 1024;

export type AvatarUploadRead =
    { kind: 'file'; file: File } | { kind: 'too_large' } | { kind: 'missing' };

/**
 * Read the `avatar` field of a multipart upload. An honestly declared
 * over-cap body is refused before it is buffered.
 */
export async function readAvatarUpload(request: Request): Promise<AvatarUploadRead> {
    const declared = Number(request.headers.get('content-length'));
    if (
        Number.isFinite(declared) &&
        declared > AVATAR_MAX_UPLOAD_BYTES + MULTIPART_OVERHEAD_BYTES
    ) {
        return { kind: 'too_large' };
    }

    let form: FormData;
    try {
        form = await request.formData();
    } catch (err) {
        if (isPayloadTooLargeError(err)) return { kind: 'too_large' };
        // Not multipart, or a malformed body: there is no avatar to read.
        return { kind: 'missing' };
    }

    const file = form.get('avatar');
    if (!(file instanceof File)) return { kind: 'missing' };
    if (file.size > AVATAR_MAX_UPLOAD_BYTES) return { kind: 'too_large' };
    return { kind: 'file', file };
}
