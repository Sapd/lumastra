// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { z } from 'zod';
import { AuthorityError, TASK_AUTHORITY_PARTITION, type AuthorityToken } from './store.js';

const originSchema = z
    .object({
        partition: z.literal(TASK_AUTHORITY_PARTITION),
        generation: z
            .string()
            .regex(/^[1-9][0-9]{0,18}$/)
            .refine(
                (value) =>
                    /^[1-9][0-9]{0,18}$/.test(value) && BigInt(value) <= 9223372036854775807n,
            ),
        ownerId: z.string().uuid(),
    })
    .strict();
const marker = '~task-owner-v1~';

export function sameTaskAuthority(
    left: AuthorityToken | undefined,
    right: AuthorityToken | undefined,
): boolean {
    return left === undefined
        ? right === undefined
        : right !== undefined &&
              left.partition === right.partition &&
              left.generation === right.generation &&
              left.ownerId === right.ownerId;
}

/** Keep #runId as the final suffix used by existing readers, including reaped
 * jobs. Base64url introduces none of BullMQ's reserved colon separators. */
export function taskJobId(jobId: string, authority: AuthorityToken | undefined): string {
    if (!authority) return jobId;
    const token = originSchema.parse(authority);
    const at = jobId.lastIndexOf('#');
    if (at < 1) throw new AuthorityError('invalid');
    return `${jobId.slice(0, at)}#${marker}${Buffer.from(JSON.stringify(token)).toString('base64url')}${jobId.slice(at)}`;
}

export function taskJobOrigin(jobId: string | undefined): AuthorityToken | undefined {
    if (!jobId) return undefined;
    const end = jobId.lastIndexOf('#');
    const at = jobId.lastIndexOf('#', end - 1);
    // Canonical task/formula identities reserve #. A literal marker within a
    // valid unmanaged formula is ordinary input, never an ownership envelope.
    if (at < 0 || !jobId.slice(at + 1, end).startsWith(marker)) return undefined;
    try {
        return Object.freeze(
            originSchema.parse(
                JSON.parse(
                    Buffer.from(jobId.slice(at + 1 + marker.length, end), 'base64url').toString(
                        'utf8',
                    ),
                ),
            ),
        );
    } catch {
        throw new AuthorityError('invalid');
    }
}

export function assertTaskJobOrigin(
    local: AuthorityToken | undefined,
    dataOrigin: unknown,
    jobId: string | undefined,
): void {
    let data: AuthorityToken | undefined;
    if (dataOrigin !== undefined) {
        const parsed = originSchema.safeParse(dataOrigin);
        if (!parsed.success) throw new AuthorityError('invalid');
        data = parsed.data;
    }
    const origin = taskJobOrigin(jobId);
    if (!sameTaskAuthority(data, origin) || !sameTaskAuthority(local, origin))
        throw new AuthorityError('stale_authority');
}

/** Remove only the managed envelope, retaining the conventional #runId suffix. */
export function unmanagedTaskJobId(jobId: string): string {
    if (!taskJobOrigin(jobId)) return jobId;
    const end = jobId.lastIndexOf('#');
    const at = jobId.lastIndexOf('#', end - 1);
    return `${jobId.slice(0, at)}${jobId.slice(end)}`;
}
