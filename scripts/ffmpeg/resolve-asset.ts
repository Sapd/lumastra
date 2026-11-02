// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

export interface FfmpegAsset {
    filename: string;
    url: string;
    sha256: string;
}

type PortableArch = 'linux64' | 'linuxarm64';

/**
 * Pinned jellyfin-ffmpeg portable builds. The SHA256 digests are the
 * supply-chain root of trust: verifying a downloaded tarball against a digest
 * baked into our own source is stronger than fetching the hash from the same
 * server that serves the binary.
 *
 * To bump the version:
 *   1. Pick a new tag from https://github.com/jellyfin/jellyfin-ffmpeg/releases
 *   2. Read each portable asset's "digest" field from
 *      https://api.github.com/repos/jellyfin/jellyfin-ffmpeg/releases/tags/<tag>
 *   3. Add an entry below, then bump FFMPEG_VERSION in the Dockerfile.
 */
const RELEASES: Record<string, Record<PortableArch, string>> = {
    'v7.1.4-3': {
        linux64: 'cab9ff40a47e4232d231e4eb7e4e85fabfeec56c6905266bc94291fc0881f83f',
        linuxarm64: '77e4b5d044ab73e1f26c9aadaa5d6014d1782500bf2c29afb3ab81f5bea98b1f',
    },
};

export function mapArch(unameArch: string): PortableArch {
    switch (unameArch) {
        case 'x86_64':
        case 'amd64':
            return 'linux64';
        case 'aarch64':
        case 'arm64':
            return 'linuxarm64';
        default:
            throw new Error(
                `Unsupported architecture '${unameArch}': jellyfin-ffmpeg portable builds ` +
                    'exist only for x86_64 (linux64) and aarch64 (linuxarm64).',
            );
    }
}

export function resolveFfmpegAsset(version: string, unameArch: string): FfmpegAsset {
    const arch = mapArch(unameArch);
    const byArch = RELEASES[version];
    if (!byArch) {
        throw new Error(
            `Unknown jellyfin-ffmpeg version '${version}': add its per-arch SHA256 ` +
                'digests to RELEASES in scripts/ffmpeg/resolve-asset.ts.',
        );
    }
    const sha256 = byArch[arch];
    const bareVersion = version.replace(/^v/, '');
    const filename = `jellyfin-ffmpeg_${bareVersion}_portable_${arch}-gpl.tar.xz`;
    const url = `https://github.com/jellyfin/jellyfin-ffmpeg/releases/download/${version}/${filename}`;
    return { filename, url, sha256 };
}

// CLI: `tsx resolve-asset.ts <unameArch> [version]` → stdout "url\tsha256".
// Guarded so importing the module (vitest) does not execute the CLI.
if (import.meta.url === `file://${process.argv[1]}`) {
    const unameArch = process.argv[2];
    const version = process.argv[3] ?? process.env.FFMPEG_VERSION ?? 'v7.1.4-3';
    if (!unameArch) {
        console.error('usage: resolve-asset.ts <unameArch> [version]');
        process.exit(2);
    }
    try {
        const asset = resolveFfmpegAsset(version, unameArch);
        process.stdout.write(`${asset.url}\t${asset.sha256}\n`);
    } catch (err) {
        console.error(err instanceof Error ? err.message : String(err));
        process.exit(1);
    }
}
