// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { mapArch, resolveFfmpegAsset } from './resolve-asset';

describe('mapArch', () => {
    it('maps x86_64 to linux64', () => expect(mapArch('x86_64')).toBe('linux64'));
    it('maps amd64 to linux64', () => expect(mapArch('amd64')).toBe('linux64'));
    it('maps aarch64 to linuxarm64', () => expect(mapArch('aarch64')).toBe('linuxarm64'));
    it('maps arm64 to linuxarm64', () => expect(mapArch('arm64')).toBe('linuxarm64'));
    it('throws on an unsupported arch', () =>
        expect(() => mapArch('riscv64')).toThrow(/Unsupported architecture/));
});

describe('resolveFfmpegAsset', () => {
    it('resolves the amd64 filename, url and pinned digest', () => {
        const a = resolveFfmpegAsset('v7.1.4-3', 'x86_64');
        expect(a.filename).toBe('jellyfin-ffmpeg_7.1.4-3_portable_linux64-gpl.tar.xz');
        expect(a.url).toBe(
            'https://github.com/jellyfin/jellyfin-ffmpeg/releases/download/v7.1.4-3/jellyfin-ffmpeg_7.1.4-3_portable_linux64-gpl.tar.xz',
        );
        expect(a.sha256).toBe('cab9ff40a47e4232d231e4eb7e4e85fabfeec56c6905266bc94291fc0881f83f');
    });

    it('resolves the arm64 filename, url and pinned digest', () => {
        const a = resolveFfmpegAsset('v7.1.4-3', 'aarch64');
        expect(a.filename).toBe('jellyfin-ffmpeg_7.1.4-3_portable_linuxarm64-gpl.tar.xz');
        expect(a.url).toBe(
            'https://github.com/jellyfin/jellyfin-ffmpeg/releases/download/v7.1.4-3/jellyfin-ffmpeg_7.1.4-3_portable_linuxarm64-gpl.tar.xz',
        );
        expect(a.sha256).toBe('77e4b5d044ab73e1f26c9aadaa5d6014d1782500bf2c29afb3ab81f5bea98b1f');
    });

    it('throws on an unknown version', () =>
        expect(() => resolveFfmpegAsset('v9.9.9', 'x86_64')).toThrow(
            /Unknown jellyfin-ffmpeg version/,
        ));

    it('throws on an unsupported arch for a known version', () =>
        expect(() => resolveFfmpegAsset('v7.1.4-3', 'riscv64')).toThrow(
            /Unsupported architecture/,
        ));
});
