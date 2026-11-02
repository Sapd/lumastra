// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect, vi, afterEach } from 'vitest';
import fs from 'node:fs';
import {
    readDeviceNodeVendorId,
    readGpuIdentities,
    resetDeviceNodeVendorCache,
} from './gpu-identity.js';

/** Stub a `/sys/class/drm` layout: card → { vendor, device } (omit a file to fail its read). */
function mockSysfs(cards: Record<string, { vendor?: string; device?: string }>): void {
    vi.spyOn(fs, 'readdirSync').mockReturnValue(
        Object.keys(cards) as unknown as ReturnType<typeof fs.readdirSync>,
    );
    vi.spyOn(fs, 'readFileSync').mockImplementation(((p: string) => {
        const m = /\/sys\/class\/drm\/([^/]+)\/device\/(vendor|device)$/.exec(String(p));
        const value = m ? cards[m[1]]?.[m[2] as 'vendor' | 'device'] : undefined;
        if (value === undefined) throw new Error('ENOENT');
        return value;
    }) as unknown as typeof fs.readFileSync);
}

afterEach(() => {
    vi.restoreAllMocks();
    resetDeviceNodeVendorCache();
});

describe('readGpuIdentities', () => {
    // Verified against the real prod host: card0 = 0x8086/0x56a5 → "Intel Arc A380".
    it('resolves an Intel PCI device id to its marketing name', () => {
        mockSysfs({ card0: { vendor: '0x8086', device: '0x56a5' } });

        expect(readGpuIdentities()).toEqual([
            { name: 'Intel Arc A380', vendorId: '0x8086', deviceId: '0x56a5', card: 'card0' },
        ]);
    });

    // The map only covers Intel Arc. Every other GPU must still be identified by
    // VENDOR — "AMD GPU (0x164e)" is enough to triage a report; "unknown" is not.
    it('falls back to a vendor-qualified name for an unmapped device', () => {
        mockSysfs({ card0: { vendor: '0x1002', device: '0x164e' } });

        expect(readGpuIdentities()[0].name).toBe('AMD GPU (0x164e)');
    });

    it('names the vendor id itself when the vendor is unrecognised', () => {
        mockSysfs({ card0: { vendor: '0xffff', device: '0x1' } });

        expect(readGpuIdentities()[0].name).toContain('0xffff');
    });

    // Connector nodes (card0-DP-1) sit alongside the card and have no device/vendor.
    it('ignores DRM connector nodes and cards with no vendor', () => {
        mockSysfs({
            card0: { vendor: '0x8086', device: '0x56a5' },
            'card0-DP-1': { vendor: '0x8086' },
            card1: {},
        });

        const out = readGpuIdentities();
        expect(out).toHaveLength(1);
        expect(out[0].card).toBe('card0');
    });

    it('reports every GPU when a host exposes more than one', () => {
        mockSysfs({
            card0: { vendor: '0x8086', device: '0x56a5' },
            card1: { vendor: '0x10de', device: '0x2204' },
        });

        expect(readGpuIdentities().map((g) => g.name)).toEqual([
            'Intel Arc A380',
            'NVIDIA GPU (0x2204)',
        ]);
    });

    // This runs on the FFmpeg exit path, where the failure record is being built.
    // Throwing would discard that record — so an absent /sys (macOS, no /dev/dri
    // passed through) must degrade to an empty list, never an exception.
    it('returns an empty list instead of throwing when sysfs is absent', () => {
        vi.spyOn(fs, 'readdirSync').mockImplementation(() => {
            throw new Error('ENOENT: no such file or directory');
        });

        expect(() => readGpuIdentities()).not.toThrow();
        expect(readGpuIdentities()).toEqual([]);
    });
});

describe('readDeviceNodeVendorId', () => {
    // VAAPI_DEVICE may be a by-path symlink; sysfs is keyed by the node name.
    it('resolves the device node (and symlinks) to its sysfs vendor', () => {
        vi.spyOn(fs, 'realpathSync').mockReturnValue('/dev/dri/renderD129');
        const read = vi
            .spyOn(fs, 'readFileSync')
            .mockReturnValue('0x1002\n' as unknown as ReturnType<typeof fs.readFileSync>);

        expect(readDeviceNodeVendorId('/dev/dri/by-path/pci-0000:65:00.0-render')).toBe('0x1002');
        expect(read).toHaveBeenCalledWith('/sys/class/drm/renderD129/device/vendor', 'utf-8');
    });

    // Feeds a build-time filter decision: unknown must mean "not AMD", never a throw.
    it("returns '' instead of throwing when the node or sysfs is missing", () => {
        vi.spyOn(fs, 'realpathSync').mockImplementation(() => {
            throw new Error('ENOENT');
        });

        expect(readDeviceNodeVendorId('/dev/dri/renderD128')).toBe('');
    });

    // Read once per node: build() asks on every transcode start and seek restart.
    it('caches a successful read, but retries after a failed one', () => {
        vi.spyOn(fs, 'realpathSync').mockReturnValue('/dev/dri/renderD128');
        const read = vi
            .spyOn(fs, 'readFileSync')
            .mockImplementationOnce(() => {
                throw new Error('ENOENT');
            })
            .mockReturnValue('0x1002' as unknown as ReturnType<typeof fs.readFileSync>);

        expect(readDeviceNodeVendorId('/dev/dri/renderD128')).toBe('');
        expect(readDeviceNodeVendorId('/dev/dri/renderD128')).toBe('0x1002');
        expect(readDeviceNodeVendorId('/dev/dri/renderD128')).toBe('0x1002');
        expect(read).toHaveBeenCalledTimes(2);
    });
});
