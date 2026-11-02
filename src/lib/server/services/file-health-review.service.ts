// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only
import { createHash } from 'node:crypto';
import { basename } from 'node:path';
import type postgres from 'postgres';
import {
    AudioTailAssessmentSchema,
    type AudioTailAssessment,
} from '$lib/schemas/audio-tail-assessment.js';
import {
    ReviewableDurationIssueSchema,
    type FileHealthReviewPreview,
    type FileHealthReviewRequest,
} from '$lib/schemas/file-health-review.js';
import { healthPhysicalIdentity } from '$lib/server/utils/health-file-identity.js';
import { withTx } from '$lib/server/database/with-tx.js';
import { lockFileHealthIssues } from '$lib/server/database/queries/media-files.queries.js';
import {
    getHealthReviewSource,
    getReviewFindingKeys,
    listHealthReviewHistory,
    insertHealthReview,
    revokeHealthReview,
} from '$lib/server/database/queries/file-health-review.queries.js';
import { insertAdminAuditEvent } from '$lib/server/database/queries/admin-audit.queries.js';
import { config } from '$lib/server/config.js';

export class FileHealthReviewError extends Error {
    constructor(
        readonly kind: 'missing' | 'conflict' | 'invalid',
        message: string,
    ) {
        super(message);
    }
}
async function physicalIdentity(path: string): Promise<string | null> {
    try {
        return await healthPhysicalIdentity(path);
    } catch {
        return null;
    }
}
/** Positive technical eligibility is separate from accepting a warning. Silence never proves completeness. */
export function durationReviewTechnicalBlock(
    assessment: AudioTailAssessment | undefined,
): FileHealthReviewPreview['blockedReason'] | undefined {
    if (!assessment?.packetTail) return 'needs-recheck';
    if (
        assessment.scope === 'inconclusive' ||
        (assessment.requested && assessment.scope !== 'measured')
    )
        return 'unsupported-evidence';
    const tail = assessment.packetTail;
    if (
        !tail.success ||
        tail.endedPrematurely ||
        !(tail.videoEnd && tail.videoEnd > 0) ||
        (tail.hasAudio && !(tail.audioEnd && tail.audioEnd > 0))
    )
        return 'technical-failure';
    if (
        assessment.reasons.some((reason) => reason !== 'no_measurable_post_video_interval') ||
        assessment.streams.some(
            (stream) =>
                stream.reasons.length > 0 || !stream.continuous || stream.packetEof !== true,
        )
    )
        return 'unsupported-evidence';
    return undefined;
}
async function buildPreview(sql: postgres.Sql, fileId: string) {
    const source = await getHealthReviewSource(sql, fileId);
    if (!source) throw new FileHealthReviewError('missing', 'File not found');
    const [keys, history, physical] = await Promise.all([
        getReviewFindingKeys(sql, fileId),
        listHealthReviewHistory(sql, fileId),
        physicalIdentity(source.file_path),
    ]);
    const uniqueKeys = [...new Map(keys.map((row) => [row.issue_key, row])).values()];
    const parsed = AudioTailAssessmentSchema.safeParse(source.health_tail_assessment);
    const assessment = parsed.success ? parsed.data : undefined;
    const raw = source.health_issues;
    const records: Record<string, unknown>[] = Array.isArray(raw)
        ? raw.filter(
              (issue: unknown): issue is Record<string, unknown> =>
                  typeof issue === 'object' && issue !== null && !Array.isArray(issue),
          )
        : [];
    let blockedReason: FileHealthReviewPreview['blockedReason'];
    if (source.is_missing || !physical) blockedReason = 'file-missing';
    else if (!Array.isArray(raw) || raw.length > 20 || records.length !== raw.length)
        blockedReason = 'unsupported-evidence';
    else if (
        records.some(
            (issue) =>
                ReviewableDurationIssueSchema.safeParse(issue.type).success &&
                ((issue.basis !== undefined &&
                    issue.basis !== 'duration_comparison' &&
                    issue.basis !== 'premature_eof') ||
                    typeof issue.expected_duration !== 'number' ||
                    !Number.isFinite(issue.expected_duration) ||
                    issue.expected_duration <= 0 ||
                    typeof issue.actual_duration !== 'number' ||
                    !Number.isFinite(issue.actual_duration) ||
                    issue.actual_duration < 0),
        )
    )
        blockedReason = 'unsupported-evidence';
    else if (
        records.some(
            (issue) =>
                issue.basis === 'premature_eof' ||
                (typeof issue.type === 'string' &&
                    ['container_unreadable', 'no_keyframes', 'video_decode_gaps'].includes(
                        issue.type,
                    )),
        )
    )
        blockedReason = 'technical-failure';
    else if (
        assessment &&
        (assessment.source.generation !== source.generation ||
            assessment.source.streams !== source.streams ||
            assessment.source.physical !== physical)
    )
        blockedReason = 'source-changed';
    else blockedReason = durationReviewTechnicalBlock(assessment);
    const findings: FileHealthReviewPreview['findings'] = uniqueKeys.flatMap(
        ({ issue_key, raw_issue }) => {
            const type = ReviewableDurationIssueSchema.safeParse(raw_issue.type);
            if (!type.success) return [];
            const review = history.find((row) => row.current && row.issue_key === issue_key);
            const expected = raw_issue.expected_duration,
                actual = raw_issue.actual_duration;
            return [
                {
                    key: issue_key,
                    type: type.data,
                    ...(typeof expected === 'number' && Number.isFinite(expected) && expected > 0
                        ? { expectedDuration: expected }
                        : {}),
                    ...(typeof actual === 'number' && Number.isFinite(actual) && actual >= 0
                        ? { actualDuration: actual }
                        : {}),
                    ...(typeof raw_issue.detail === 'string'
                        ? { detail: raw_issue.detail.slice(0, 2048) }
                        : {}),
                    state: blockedReason
                        ? ('blocked' as const)
                        : review
                          ? ('reviewed' as const)
                          : ('needs-review' as const),
                    ...(review ? { reviewId: review.id } : {}),
                },
            ];
        },
    );
    const snapshot = createHash('sha256')
        .update(
            JSON.stringify([
                source.generation,
                source.streams,
                source.assessment_signature,
                physical,
                source.review_version,
                keys.map((row) => row.issue_key).sort(),
                blockedReason,
            ]),
        )
        .digest('hex');
    const preview: FileHealthReviewPreview = {
        fileId,
        fileName: basename(source.file_path),
        filePath: source.file_path,
        ...(source.file_mtime ? { fileModifiedAt: new Date(source.file_mtime).toISOString() } : {}),
        ...(source.file_size_bytes ? { fileSizeBytes: source.file_size_bytes } : {}),
        assessment,
        snapshot,
        eligible: !blockedReason && findings.some((issue) => issue.state === 'needs-review'),
        blockedReason,
        findings,
        history: history.map((row) => ({
            id: row.id,
            issueKey: row.issue_key,
            issueType: row.issue_type,
            reason: row.reason,
            evidence: row.evidence,
            decidedBy: row.decided_by,
            decidedAt: new Date(row.decided_at).toISOString(),
            state: row.revoked_at
                ? 'revoked'
                : row.current && physical === assessment?.source.physical
                  ? 'current'
                  : 'outdated',
            ...(row.revoked_at ? { revokedAt: new Date(row.revoked_at).toISOString() } : {}),
        })),
    };
    return { preview, source, physical, keys };
}
export async function previewFileHealthReview(
    sql: postgres.Sql,
    fileId: string,
): Promise<FileHealthReviewPreview> {
    return withTx(sql, async (tx) => {
        await lockFileHealthIssues(tx, fileId);
        return (await buildPreview(tx, fileId)).preview;
    });
}
export async function writeFileHealthReview(
    sql: postgres.Sql,
    request: Exclude<FileHealthReviewRequest, { action: 'preview' }>,
    actor: string,
    identity?: { userId?: string; kind?: string; credentialId?: string },
): Promise<number | boolean> {
    return withTx(sql, async (tx) => {
        await lockFileHealthIssues(tx, request.fileId);
        await tx`SELECT id FROM media_files WHERE id=${request.fileId}::uuid FOR UPDATE`;
        if (request.action === 'revoke') {
            const revoked = await revokeHealthReview(
                tx,
                request.fileId,
                request.reviewId,
                actor,
                identity,
            );
            if (revoked)
                await insertAdminAuditEvent(tx, {
                    instanceId: config.INSTANCE_ID,
                    actor,
                    principalKind: identity?.kind,
                    credentialId: identity?.credentialId,
                    action: 'file-health.review.revoke',
                    target: request.fileId,
                    outcome: 'ok',
                    detail: { reviewId: request.reviewId, principalId: identity?.userId },
                });
            return revoked;
        }
        await tx`SELECT id FROM media_streams WHERE file_id=${request.fileId}::uuid FOR SHARE`;
        const before = await buildPreview(tx, request.fileId);
        if (before.preview.snapshot !== request.snapshot)
            throw new FileHealthReviewError(
                'conflict',
                'File evidence or review history changed. Refresh the review.',
            );
        if (!before.preview.eligible || !before.source.assessment_signature)
            throw new FileHealthReviewError(
                'invalid',
                'A current clean technical recheck is required before accepting a duration warning.',
            );
        const selected = new Set(request.issueKeys);
        if (
            selected.size !== request.issueKeys.length ||
            request.issueKeys.some(
                (key) =>
                    !before.preview.findings.some(
                        (issue) => issue.key === key && issue.state === 'needs-review',
                    ),
            )
        )
            throw new FileHealthReviewError(
                'conflict',
                'Selected findings are no longer reviewable. Refresh the review.',
            );
        // Acceptance records a preference, never a claim that the operator inspected content.
        const note = request.reason?.trim();
        const evidenceNote = request.evidence?.trim();
        const reason =
            note && note.length >= 10
                ? note
                : `Keep this file and hide this duration warning.${note ? ` Note: ${note}` : ''}`;
        const evidence =
            evidenceNote && evidenceNote.length >= 20
                ? evidenceNote
                : `Accepted using the current file, stream and assessment snapshot; content completeness remains unverified.${evidenceNote ? ` Note: ${evidenceNote}` : ''}`;
        for (const key of selected) {
            const rawIssue = before.keys.find((row) => row.issue_key === key)!.raw_issue;
            const id = await insertHealthReview(tx, {
                fileId: request.fileId,
                issueType: String(rawIssue.type),
                issueKey: key,
                generation: before.source.generation,
                streams: before.source.streams,
                assessmentSignature: before.source.assessment_signature,
                sourceSnapshot: {
                    generation: before.source.generation,
                    streams: before.source.streams,
                    physical: before.physical,
                    path: before.source.file_path,
                    actorIdentity: identity ?? {},
                    acceptanceAction: 'keep-file',
                    contentInspectionClaimed: false,
                },
                rawIssue,
                assessment: before.source.health_tail_assessment as Record<string, unknown>,
                reason,
                evidence,
                actor,
            });
            if (!id)
                throw new FileHealthReviewError(
                    'conflict',
                    'This finding was already reviewed. Refresh the review.',
                );
        }
        // A concurrent stream/source writer need not use the health lock. Re-read before committing.
        const after = await getHealthReviewSource(tx, request.fileId);
        if (
            !after ||
            after.generation !== before.source.generation ||
            after.streams !== before.source.streams ||
            after.assessment_signature !== before.source.assessment_signature ||
            (await physicalIdentity(before.source.file_path)) !== before.physical
        )
            throw new FileHealthReviewError(
                'conflict',
                'File evidence changed during the review. No decision was saved.',
            );
        await insertAdminAuditEvent(tx, {
            instanceId: config.INSTANCE_ID,
            actor,
            principalKind: identity?.kind,
            credentialId: identity?.credentialId,
            action: 'file-health.review.confirm',
            target: request.fileId,
            outcome: 'ok',
            detail: {
                issueKeys: request.issueKeys,
                reason,
                evidence,
            },
        });
        return selected.size;
    });
}
