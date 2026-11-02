// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Deterministic SVG Avatar Generation
 *
 * Generates colored SVG avatars from usernames using a deterministic hash.
 * Each username always produces the same color, providing visual distinction
 * between users when no profile image is available.
 */

/**
 * Generate a deterministic SVG avatar from a username.
 * Produces a colored circle with initials, colors derived from username hash.
 */
export function generateAvatarSvg(username: string, size = 200, initials?: string): string {
    const hash = simpleHash(username);

    // Pick hue from hash (0-360), keep saturation/lightness pleasant
    const hue = hash % 360;
    const saturation = 45 + (hash % 20); // 45-65%
    const lightness = 35 + (hash % 15); // 35-50% (dark enough for white text)

    const label = escapeXml(initials ?? getInitials(username));

    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}">
	<rect width="${size}" height="${size}" rx="${size / 2}" fill="hsl(${hue}, ${saturation}%, ${lightness}%)"/>
	<text x="50%" y="50%" dy="0.35em" text-anchor="middle"
		fill="white" font-family="system-ui, sans-serif"
		font-size="${size * 0.4}" font-weight="600">
		${label}
	</text>
</svg>`;
}

function escapeXml(str: string): string {
    return str
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&apos;');
}

function getInitials(username: string): string {
    return username.slice(0, 2).toUpperCase();
}

/** Simple deterministic hash (djb2) */
function simpleHash(str: string): number {
    let hash = 5381;
    for (let i = 0; i < str.length; i++) {
        hash = ((hash << 5) + hash + str.charCodeAt(i)) >>> 0;
    }
    return hash;
}

/** Generate a data URI for inline use (safe for non-ASCII usernames) */
export function generateAvatarDataUri(username: string, size = 200): string {
    const svg = generateAvatarSvg(username, size);
    return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}
