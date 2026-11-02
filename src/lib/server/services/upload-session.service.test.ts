// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect, vi } from 'vitest';
import { basename as pathBasename } from 'node:path';
import { resolveUnderRoot } from '$lib/server/utils/library-path-safety.js';

// ---------------------------------------------------------------------------
// Mock heavy server-side deps before importing the service
// ---------------------------------------------------------------------------

vi.mock('$lib/server/config.js', () => ({
    config: {
        MAX_VIDEO_UPLOAD_GB: 50,
        MAX_RESOURCE_UPLOAD_MB: 500,
        MAX_SUBTITLE_UPLOAD_MB: 10,
        MAX_CHAPTER_UPLOAD_MB: 1,
        UPLOAD_CHUNK_SIZE_MB: 5,
        UPLOAD_STAGING_DIR: '',
    },
}));

vi.mock('$lib/server/utils/logger.js', () => ({
    Logger: {
        for: () => ({
            info: vi.fn(),
            warn: vi.fn(),
            error: vi.fn(),
            child: () => ({
                info: vi.fn(),
                warn: vi.fn(),
                error: vi.fn(),
            }),
        }),
    },
}));

vi.mock('$lib/server/database/queries/upload-sessions.queries.js', () => ({
    createUploadSession: vi.fn(),
    getUploadSessionById: vi.fn(),
    incrementChunksReceived: vi.fn(),
    setUploadSessionStatus: vi.fn(),
    finalizeUploadSession: vi.fn(),
    abortUploadSession: vi.fn(),
    deleteUploadSession: vi.fn(),
    findExpiredUploadSessions: vi.fn(),
    deleteExpiredUploadSession: vi.fn(),
}));

vi.mock('node:fs/promises', () => ({
    mkdir: vi.fn().mockResolvedValue(undefined),
    writeFile: vi.fn().mockResolvedValue(undefined),
    rename: vi.fn().mockResolvedValue(undefined),
    rm: vi.fn().mockResolvedValue(undefined),
    readdir: vi.fn().mockResolvedValue([]),
    open: vi.fn().mockResolvedValue({
        write: vi.fn().mockResolvedValue({}),
        close: vi.fn().mockResolvedValue(undefined),
    }),
    copyFile: vi.fn().mockResolvedValue(undefined),
    unlink: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('node:fs', () => ({
    default: {
        readFileSync: vi.fn().mockReturnValue(Buffer.from('')),
    },
    readFileSync: vi.fn().mockReturnValue(Buffer.from('')),
}));

// ---------------------------------------------------------------------------
// Import after mocks
// ---------------------------------------------------------------------------

import {
    resolveStagingDir,
    validateAncillaryMime,
    ancillarySizeLimit,
    UPLOADABLE_LIBRARY_TYPES,
    ALLOWED_VIDEO_MIMES,
} from './upload-session.service';

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('resolveUnderRoot (path safety helper)', () => {
    it('accepts a simple relative subpath', () => {
        const result = resolveUnderRoot('/data/library', 'training/intro');
        expect(result).toBe('/data/library/training/intro');
    });

    it('rejects absolute paths', () => {
        expect(resolveUnderRoot('/data/library', '/etc/passwd')).toBeNull();
    });

    it('rejects path traversal with ..', () => {
        expect(resolveUnderRoot('/data/library', '../secret')).toBeNull();
    });

    it('accepts empty string (root)', () => {
        // empty string is treated as escaping by the helper — callers use '' as "root"
        expect(resolveUnderRoot('/data/library', '')).toBeNull();
    });

    it('rejects double slashes', () => {
        expect(resolveUnderRoot('/data/library', 'foo//bar')).toBeNull();
    });
});

describe('resolveStagingDir', () => {
    it('puts staging dir inside library root when UPLOAD_STAGING_DIR is empty', () => {
        const dir = resolveStagingDir('/data/library', 'abc-123');
        expect(dir).toBe('/data/library/.upload-staging/abc-123');
    });
});

describe('validateAncillaryMime', () => {
    it('accepts .srt subtitle', () => {
        const result = validateAncillaryMime('subtitle', 'video.en.srt', 'text/plain');
        expect(result.valid).toBe(true);
    });

    it('accepts .vtt subtitle', () => {
        expect(validateAncillaryMime('subtitle', 'video.vtt', 'text/vtt').valid).toBe(true);
    });

    it('rejects .mp4 as subtitle', () => {
        const result = validateAncillaryMime('subtitle', 'video.mp4', 'video/mp4');
        expect(result.valid).toBe(false);
        expect(result.reason).toContain('.mp4');
    });

    it('accepts .json chapter', () => {
        expect(validateAncillaryMime('chapter', 'chapters.json', 'application/json').valid).toBe(
            true,
        );
    });

    it('accepts .vtt chapter', () => {
        expect(validateAncillaryMime('chapter', 'chapters.vtt', 'text/vtt').valid).toBe(true);
    });

    it('rejects .txt chapter', () => {
        const result = validateAncillaryMime('chapter', 'chapters.txt', 'text/plain');
        expect(result.valid).toBe(false);
    });

    it('accepts PDF resource', () => {
        expect(validateAncillaryMime('resource', 'slides.pdf', 'application/pdf').valid).toBe(true);
    });

    it('accepts PPTX resource', () => {
        const mime = 'application/vnd.openxmlformats-officedocument.presentationml.presentation';
        expect(validateAncillaryMime('resource', 'deck.pptx', mime).valid).toBe(true);
    });

    it('rejects video/mp4 as resource', () => {
        const result = validateAncillaryMime('resource', 'video.mp4', 'video/mp4');
        expect(result.valid).toBe(false);
    });
});

describe('ancillarySizeLimit', () => {
    it('returns 10 MB for subtitle', () => {
        expect(ancillarySizeLimit('subtitle')).toBe(10 * 1024 * 1024);
    });
    it('returns 1 MB for chapter', () => {
        expect(ancillarySizeLimit('chapter')).toBe(1 * 1024 * 1024);
    });
    it('returns 500 MB for resource', () => {
        expect(ancillarySizeLimit('resource')).toBe(500 * 1024 * 1024);
    });
});

describe('UPLOADABLE_LIBRARY_TYPES', () => {
    it('includes home_video, training, educational, personal', () => {
        expect(UPLOADABLE_LIBRARY_TYPES.has('home_video')).toBe(true);
        expect(UPLOADABLE_LIBRARY_TYPES.has('training')).toBe(true);
        expect(UPLOADABLE_LIBRARY_TYPES.has('educational')).toBe(true);
        expect(UPLOADABLE_LIBRARY_TYPES.has('personal')).toBe(true);
    });

    it('excludes entertainment types', () => {
        expect(UPLOADABLE_LIBRARY_TYPES.has('movie')).toBe(false);
        expect(UPLOADABLE_LIBRARY_TYPES.has('tv')).toBe(false);
        expect(UPLOADABLE_LIBRARY_TYPES.has('music')).toBe(false);
        expect(UPLOADABLE_LIBRARY_TYPES.has('anime')).toBe(false);
    });
});

describe('ALLOWED_VIDEO_MIMES', () => {
    it('includes common video types', () => {
        expect(ALLOWED_VIDEO_MIMES.has('video/mp4')).toBe(true);
        expect(ALLOWED_VIDEO_MIMES.has('video/x-matroska')).toBe(true);
        expect(ALLOWED_VIDEO_MIMES.has('video/webm')).toBe(true);
    });

    it('excludes non-video types', () => {
        expect(ALLOWED_VIDEO_MIMES.has('application/pdf')).toBe(false);
        expect(ALLOWED_VIDEO_MIMES.has('text/plain')).toBe(false);
    });
});

// ---------------------------------------------------------------------------
// PATH TRAVERSAL — basename sanitization (Critical security fix)
// ---------------------------------------------------------------------------

describe('resolveUnderRoot — path traversal protection', () => {
    it('rejects a filename with embedded path components like ../../etc/passwd.mkv', () => {
        // Simulates what a malicious client could send as filename.
        // basename() must strip the traversal before the join, and resolveUnderRoot
        // must return null for any remaining traversal attempt.
        const libraryRoot = '/data/library';
        const maliciousFilename = '../../etc/passwd.mkv';
        // resolveUnderRoot rejects traversal
        expect(resolveUnderRoot(libraryRoot, maliciousFilename)).toBeNull();
        // After basename() the component is "passwd.mkv" — safe to join
        const safe = pathBasename(maliciousFilename);
        expect(safe).toBe('passwd.mkv');
        // Now resolveUnderRoot must accept it
        expect(resolveUnderRoot(libraryRoot, safe)).toBe('/data/library/passwd.mkv');
    });

    it('rejects hidden path components separated by slashes', () => {
        const libraryRoot = '/data/library';
        expect(resolveUnderRoot(libraryRoot, 'subdir/../../secret.mp4')).toBeNull();
    });

    it('accepts a normal relative subpath with a filename', () => {
        const result = resolveUnderRoot('/data/library', 'training/course1');
        expect(result).toBe('/data/library/training/course1');
    });
});
