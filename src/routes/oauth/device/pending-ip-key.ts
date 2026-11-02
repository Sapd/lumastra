// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { isIP } from 'node:net';

/** Share a pending-code budget across IPv6 privacy addresses in one /64. */
export function pendingIpKey(ip: string): string {
    const address = ip.split('%')[0];
    if (isIP(address) !== 6) return ip;
    // URL canonicalization handles case, embedded IPv4 and compressed zeros.
    const canonical = new URL(`http://[${address}]/`).hostname.slice(1, -1);
    const [left, right] = canonical.split('::');
    const start = left ? left.split(':') : [];
    const end = right ? right.split(':') : [];
    const words =
        right === undefined
            ? start
            : [...start, ...Array<string>(8 - start.length - end.length).fill('0'), ...end];
    // Mapped IPv4 clients retain independent IPv4 budgets.
    if (words.slice(0, 5).every((word) => Number.parseInt(word, 16) === 0) && words[5] === 'ffff') {
        const high = Number.parseInt(words[6], 16);
        const low = Number.parseInt(words[7], 16);
        return `${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`;
    }
    return `${words
        .slice(0, 4)
        .map((word) => word.padStart(4, '0'))
        .join(':')}::/64`;
}
