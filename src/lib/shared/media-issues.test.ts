// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import {
    attentionKinds,
    deriveMediaIssues,
    ISSUE_VIEW,
    MEDIA_BROWSER_VIEWS,
    noteIssues,
    parseMediaBrowserView,
    problemIssues,
    VIEW_ISSUE,
    viewsForScope,
    type MediaIssueInput,
} from './media-issues.js';

const healthy: MediaIssueInput = {
    mediaType: 'movie',
    filesLost: false,
    hasTmdb: true,
    hasPoster: true,
    hasOverview: true,
    hasFiles: true,
    jellyfinLinked: true,
    isDuplicate: false,
};

describe('deriveMediaIssues', () => {
    it('returns nothing for a healthy row', () => {
        expect(deriveMediaIssues(healthy, { jellyfinEnabled: true })).toEqual([]);
    });

    it('orders errors before warnings before info', () => {
        const issues = deriveMediaIssues(
            {
                ...healthy,
                hasPoster: false,
                jellyfinLinked: false,
                fileIssues: { health: ['truncated_video'], integrity: [] },
            },
            { jellyfinEnabled: true },
        );
        expect(issues.map((i) => i.kind)).toEqual(['file_problem', 'no_poster', 'not_in_jellyfin']);
        expect(issues[0]).toMatchObject({ severity: 'error', subtype: 'truncated_video' });
    });

    /**
     * The per-type guard is the whole reason the vocabulary is a table: on
     * prod 50k episodes have no poster and every track has no TMDB id, and
     * none of that is a defect.
     */
    it('does not flag gaps that are normal for the media type', () => {
        const episode = deriveMediaIssues(
            { ...healthy, mediaType: 'episode', hasPoster: false, hasTmdb: false },
            { jellyfinEnabled: true },
        );
        expect(episode).toEqual([]);
        const track = deriveMediaIssues(
            {
                ...healthy,
                mediaType: 'track',
                hasPoster: false,
                hasTmdb: false,
                hasOverview: false,
                jellyfinLinked: false,
            },
            { jellyfinEnabled: true },
        );
        expect(track).toEqual([]);
    });

    it('never reports Not in Jellyfin while sync is off', () => {
        const issues = deriveMediaIssues(
            { ...healthy, jellyfinLinked: false },
            { jellyfinEnabled: false },
        );
        expect(issues).toEqual([]);
    });

    /**
     * Prod, .harbor: every flagged episode was a TMDB catalog episode (Specials,
     * Season 3) with no local file; every episode on disk was linked.
     */
    it('never reports Not in Jellyfin for an item without a local file', () => {
        const issues = deriveMediaIssues(
            { ...healthy, mediaType: 'episode', hasFiles: false, jellyfinLinked: false },
            { jellyfinEnabled: true },
        );
        expect(issues).toEqual([]);
    });

    it('splits info notes from problems', () => {
        const issues = deriveMediaIssues(
            { ...healthy, hasPoster: false, jellyfinLinked: false },
            { jellyfinEnabled: true },
        );
        expect(problemIssues(issues).map((i) => i.kind)).toEqual(['no_poster']);
        expect(noteIssues(issues).map((i) => i.kind)).toEqual(['not_in_jellyfin']);
    });

    it('carries the file health detail and path into the hover text', () => {
        const [issue] = deriveMediaIssues(
            {
                ...healthy,
                fileIssues: {
                    health: ['no_keyframes'],
                    healthDetails: [
                        {
                            type: 'no_keyframes',
                            detail: 'no keyframes found',
                            filePath: '/a/b.mkv',
                        },
                    ],
                    integrity: [],
                },
            },
            { jellyfinEnabled: false },
        );
        expect(issue?.detail).toBe('no keyframes found — /a/b.mkv');
    });

    it('rolls episode file problems up onto the series row', () => {
        const [issue] = deriveMediaIssues(
            { ...healthy, mediaType: 'tv', episodeProblems: 3 },
            { jellyfinEnabled: false },
        );
        expect(issue).toMatchObject({ kind: 'file_problem', subtype: 'episodes', count: 3 });
    });

    it('reports an open integrity violation as a file problem', () => {
        const [issue] = deriveMediaIssues(
            { ...healthy, fileIssues: { health: [], integrity: [{ rule: 'x', message: 'bad' }] } },
            { jellyfinEnabled: false },
        );
        expect(issue).toMatchObject({ kind: 'file_problem', subtype: 'integrity', detail: 'bad' });
    });
});

describe('views', () => {
    it('maps every issue to a view that lists it, and back', () => {
        for (const [kind, view] of Object.entries(ISSUE_VIEW)) {
            expect(VIEW_ISSUE[view]).toBe(kind);
        }
    });

    it('parses unknown or missing values as All', () => {
        expect(parseMediaBrowserView(null)).toBe('all');
        expect(parseMediaBrowserView('nope')).toBe('all');
        for (const v of MEDIA_BROWSER_VIEWS) expect(parseMediaBrowserView(v)).toBe(v);
    });

    it('hides views whose issue cannot occur in the scope', () => {
        const music = viewsForScope({ types: ['artist', 'album', 'track'], jellyfinEnabled: true });
        expect(music).not.toContain('unidentified');
        expect(music).not.toContain('duplicates');
        expect(music).not.toContain('jellyfin');
        expect(music).toContain('artwork');

        const video = viewsForScope({ types: ['movie', 'tv'], jellyfinEnabled: false });
        expect(video).not.toContain('jellyfin');
        expect(video).toContain('unidentified');
    });

    it('excludes info-severity issues from Needs attention', () => {
        const kinds = attentionKinds({ types: ['movie', 'tv'], jellyfinEnabled: true });
        expect(kinds).not.toContain('not_in_jellyfin');
        expect(kinds).toContain('files_lost');
    });
});
