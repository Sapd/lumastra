// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { FILE_HEALTH_ISSUE_TYPES } from '$lib/types/pipeline';
import {
    fileHealthIssueLabel,
    fileHealthIssueGuidance,
    fileHealthIssueReason,
    isSevereHealthIssue,
    fileHealthIssueBadgeClass,
} from './file-health-issue';

describe('file health issue presentation', () => {
    it('has a real label for every canonical type', () => {
        // The whole reason this module exists: three surfaces each kept their
        // own type→label chain, and every one of them silently stopped
        // covering the list. Adding a type to FILE_HEALTH_ISSUE_TYPES without
        // a label now fails here instead of in front of an admin.
        for (const type of FILE_HEALTH_ISSUE_TYPES) {
            const label = fileHealthIssueLabel(type);
            expect(label, `no label for ${type}`).not.toBe(type);
            expect(label, `generic label for ${type}`).not.toBe(
                fileHealthIssueLabel('some_future_issue'),
            );
        }
    });

    it('uses a readable fallback for an unknown issue', () => {
        // NOT to a specific issue's label — the old chains ended in an `else`
        // naming duration_mismatch, so anything new read as confidently wrong.
        expect(fileHealthIssueLabel('some_future_issue')).toBe('File check needs attention');
    });

    it('treats playback-breaking issues as severe even when the cause is unknown', () => {
        expect(isSevereHealthIssue('container_unreadable')).toBe(true);
        expect(isSevereHealthIssue('truncated_video')).toBe(false);
        expect(isSevereHealthIssue('truncated_video', 'premature_eof')).toBe(true);
        expect(fileHealthIssueLabel('truncated_video', 'premature_eof')).not.toBe(
            fileHealthIssueLabel('truncated_video', 'duration_comparison'),
        );
        expect(isSevereHealthIssue('no_keyframes')).toBe(true);

        // A short tail or unreadable tags are not worth a red badge.
        expect(isSevereHealthIssue('video_ends_early')).toBe(false);
        expect(isSevereHealthIssue('video_decode_gaps')).toBe(false);
        expect(isSevereHealthIssue('tag_parse_corrupt')).toBe(false);
        expect(isSevereHealthIssue('some_future_issue')).toBe(false);
    });

    it('keeps decoder inability severe while the copy remains cause-uncertain', () => {
        expect(fileHealthIssueBadgeClass('container_unreadable')).toContain('red');
        expect(fileHealthIssueBadgeClass('video_ends_early')).toContain('yellow');
    });

    it('provides conservative codec guidance without replacing recorded evidence', () => {
        const detail = '0x00 at pos 8193 (0x2001) invalid as first byte of an EBML number';
        expect(fileHealthIssueGuidance({ type: 'container_unreadable' })).toContain('H.266/VVC');
        expect(fileHealthIssueReason({ type: 'container_unreadable', detail })).toBe(detail);
        expect(fileHealthIssueGuidance({ type: 'unknown_future_type' })).toBeUndefined();
    });

    describe('reason', () => {
        it('prefers the recorded detail verbatim', () => {
            const detail = '0x00 at pos 8193 (0x2001) invalid as first byte of an EBML number';
            expect(fileHealthIssueReason({ type: 'container_unreadable', detail })).toBe(detail);
        });

        it('ignores a blank detail rather than rendering an empty reason', () => {
            expect(fileHealthIssueReason({ type: 'no_keyframes', detail: '   ' })).toBe(
                'No keyframes (I-frames) detected',
            );
        });

        it('composes one from durations for probe types that predate detail', () => {
            const reason = fileHealthIssueReason({
                type: 'truncated_video',
                expected_duration: 7168.4,
                actual_duration: 5040.2,
            });
            // Rounded — sub-second precision is noise at this scale.
            expect(reason).toContain('5040');
            expect(reason).toContain('7168');
            expect(reason).not.toContain('.4');
        });

        it('shows recorded timing for video_ends_early without a detail', () => {
            expect(
                fileHealthIssueReason({
                    type: 'video_ends_early',
                    actual_duration: 1420,
                    expected_duration: 1503,
                }),
            ).toBe(
                'Duration mismatch needs review: video stops at 1420s; the container reports 1503s',
            );
        });

        it('keeps recorded detail ahead of duration evidence', () => {
            expect(
                fileHealthIssueReason({
                    type: 'video_ends_early',
                    actual_duration: 1420,
                    expected_duration: 1503,
                    detail: 'Recorded decoder evidence',
                }),
            ).toBe('Recorded decoder evidence');
        });

        it.each(['truncated_video', 'video_ends_early'])(
            'does not fabricate timing for %s when either value is absent or invalid',
            (type) => {
                for (const invalid of [undefined, NaN, Infinity, -Infinity, -1]) {
                    expect(
                        fileHealthIssueReason({
                            type,
                            actual_duration: invalid,
                            expected_duration: 1503,
                        }),
                    ).toBeUndefined();
                    expect(
                        fileHealthIssueReason({
                            type,
                            actual_duration: 1420,
                            expected_duration: invalid,
                        }),
                    ).toBeUndefined();
                }
            },
        );

        it('returns nothing when there is genuinely nothing to say', () => {
            expect(fileHealthIssueReason({ type: 'some_future_issue' })).toBeUndefined();
        });
    });
});

it('uses current acceptance for guidance instead of a stale raw imperative', () => {
    const issue = {
        type: 'video_ends_early',
        reviewed: true,
        detail: 'Needs review: inspect this file now',
    };
    expect(fileHealthIssueReason(issue)).toBeUndefined();
    expect(fileHealthIssueGuidance(issue)).toContain('was accepted');
    expect(fileHealthIssueGuidance({ ...issue, reviewed: false })).not.toContain('was accepted');
});
