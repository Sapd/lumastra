// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: LicenseRef-Lumastra-Proprietary
// Proprietary and source-available — not licensed under AGPL. See LICENSING.md.

// Unit tests for the /j/Auth/Keys plaintext stash helpers.

import { describe, it, expect, vi, beforeEach } from 'vitest';

interface BatchSetCall {
    key: string;
    value: string;
    options?: { expiry?: { type: unknown; count: number } };
}

const { batchSetCalls, lastBatchInstance, BatchCtor, getValkeyClient, mockClient } = vi.hoisted(
    () => {
        const batchSetCalls: BatchSetCall[] = [];
        // Track the most recently constructed batch so tests can assert
        // that exec() was called with the same instance.
        const lastBatchInstance: { current: object | null } = { current: null };

        function BatchCtor(this: { isAtomic: boolean }, isAtomic: boolean) {
            this.isAtomic = isAtomic;
            const self = this as unknown as {
                isAtomic: boolean;
                set: (
                    key: string,
                    value: string,
                    options?: { expiry?: { type: unknown; count: number } },
                ) => unknown;
            };
            self.set = (
                key: string,
                value: string,
                options?: { expiry?: { type: unknown; count: number } },
            ) => {
                batchSetCalls.push({ key, value, options });
                return self;
            };
            lastBatchInstance.current = self;
        }

        const mockClient = {
            exec: vi.fn(),
            getdel: vi.fn(),
        };
        const getValkeyClient = vi.fn(() => mockClient);
        return {
            batchSetCalls,
            lastBatchInstance,
            BatchCtor,
            getValkeyClient,
            mockClient,
        };
    },
);

vi.mock('@valkey/valkey-glide', () => ({
    Batch: BatchCtor,
    TimeUnit: { Seconds: 'sec' },
}));

vi.mock('$lib/server/cache/valkey', () => ({
    getValkeyClient,
    // Production now reaches the stash through the coordination client; alias to
    // the same mock so existing mockReturnValue(Once) setups still drive it.
    getCoordinationClient: getValkeyClient,
}));

import { stashAuthKey, consumeAuthKey } from './auth-keys-stash';

describe('stashAuthKey', () => {
    beforeEach(() => {
        batchSetCalls.length = 0;
        lastBatchInstance.current = null;
        mockClient.exec.mockReset();
        mockClient.getdel.mockReset();
        getValkeyClient.mockReturnValue(mockClient);
        mockClient.exec.mockResolvedValue(['OK', 'OK']);
    });

    it('writes plaintext-by-nonce and nonce-by-pat-id with TTL via atomic Batch', async () => {
        await stashAuthKey('123', 'plaintext-token');

        // atomic transaction
        expect((lastBatchInstance.current as { isAtomic: boolean }).isAtomic).toBe(true);
        expect(batchSetCalls).toHaveLength(2);

        const [first, second] = batchSetCalls;
        expect(first.key).toMatch(/^jfcompat:auth_key_plaintext:/);
        expect(first.value).toBe('plaintext-token');
        expect(first.options?.expiry).toEqual({ type: 'sec', count: 600 });

        expect(second.key).toBe('jfcompat:auth_key_nonce_for_pat:123');
        // The nonce stored in the reverse pointer must match the suffix of the plaintext key.
        const nonceFromPlaintextKey = first.key.split(':').pop();
        expect(second.value).toBe(nonceFromPlaintextKey);
        expect(second.options?.expiry).toEqual({ type: 'sec', count: 600 });

        expect(mockClient.exec).toHaveBeenCalledTimes(1);
        expect(mockClient.exec).toHaveBeenCalledWith(lastBatchInstance.current, true);
    });

    it('uses a unique nonce per call', async () => {
        await stashAuthKey('1', 'a');
        await stashAuthKey('2', 'b');

        const nonce1 = batchSetCalls[0].key.split(':').pop();
        const nonce2 = batchSetCalls[2].key.split(':').pop();
        expect(nonce1).toBeTruthy();
        expect(nonce2).toBeTruthy();
        expect(nonce1).not.toBe(nonce2);
    });

    it('throws when Valkey client is unavailable', async () => {
        getValkeyClient.mockReturnValueOnce(null as unknown as typeof mockClient);
        await expect(stashAuthKey('1', 'tok')).rejects.toThrow(/Valkey unavailable/);
    });

    it('throws when the transaction returns null (WATCH conflict shape)', async () => {
        mockClient.exec.mockResolvedValueOnce(null);
        await expect(stashAuthKey('1', 'tok')).rejects.toThrow(/transaction returned null/);
    });

    it('accepts numeric pat ids', async () => {
        await stashAuthKey(42, 'tok');
        expect(batchSetCalls[1].key).toBe('jfcompat:auth_key_nonce_for_pat:42');
    });
});

describe('consumeAuthKey', () => {
    beforeEach(() => {
        batchSetCalls.length = 0;
        lastBatchInstance.current = null;
        mockClient.exec.mockReset();
        mockClient.getdel.mockReset();
        getValkeyClient.mockReturnValue(mockClient);
    });

    it('returns null when no nonce stash exists', async () => {
        mockClient.getdel.mockResolvedValueOnce(null);

        const result = await consumeAuthKey('123');

        expect(result).toBeNull();
        expect(mockClient.getdel).toHaveBeenCalledTimes(1);
        expect(mockClient.getdel).toHaveBeenCalledWith('jfcompat:auth_key_nonce_for_pat:123');
    });

    it('atomically getdels nonce then plaintext', async () => {
        mockClient.getdel
            .mockResolvedValueOnce('the-nonce')
            .mockResolvedValueOnce('plaintext-token');

        const result = await consumeAuthKey('123');

        expect(result).toBe('plaintext-token');
        expect(mockClient.getdel).toHaveBeenNthCalledWith(1, 'jfcompat:auth_key_nonce_for_pat:123');
        expect(mockClient.getdel).toHaveBeenNthCalledWith(
            2,
            'jfcompat:auth_key_plaintext:the-nonce',
        );
    });

    it('returns null when nonce is found but plaintext stash already expired', async () => {
        mockClient.getdel.mockResolvedValueOnce('the-nonce').mockResolvedValueOnce(null);

        const result = await consumeAuthKey('123');

        expect(result).toBeNull();
    });

    it('decodes Buffer-shaped GlideString return values', async () => {
        mockClient.getdel
            .mockResolvedValueOnce(Buffer.from('the-nonce', 'utf-8'))
            .mockResolvedValueOnce(Buffer.from('plaintext', 'utf-8'));

        const result = await consumeAuthKey(7);

        expect(result).toBe('plaintext');
    });

    it('returns null when Valkey client is unavailable', async () => {
        getValkeyClient.mockReturnValueOnce(null as unknown as typeof mockClient);

        const result = await consumeAuthKey('123');

        expect(result).toBeNull();
        expect(mockClient.getdel).not.toHaveBeenCalled();
    });
});
