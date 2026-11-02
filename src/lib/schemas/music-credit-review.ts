// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only
import { z } from 'zod';
const Name = z
    .string()
    .trim()
    .min(1)
    .max(255)
    .refine(
        (value) =>
            !Array.from(value).some((character) => {
                const code = character.charCodeAt(0);
                return code < 32 || code === 127;
            }),
        'Names must not contain ASCII control characters.',
    );
export const CreditRoleSchema = z.enum(['performer', 'remixer']);
export const ArtistCreditChoiceSchema = z.strictObject({
    artist: z.union([
        z.strictObject({ id: z.uuid(), name: Name }),
        z.strictObject({ newName: Name }),
    ]),
    creditedAs: Name,
    role: CreditRoleSchema,
});
export const ConfirmArtistCreditsSchema = z
    .strictObject({
        snapshot: z.string().regex(/^[a-f0-9]{64}$/),
        credits: z.array(ArtistCreditChoiceSchema).min(1).max(32),
    })
    .superRefine((value, ctx) => {
        if (!value.credits.some((credit) => credit.role === 'performer'))
            ctx.addIssue({ code: 'custom', message: 'At least one performer is required.' });
        const seen = new Set<string>();
        for (const credit of value.credits) {
            const identity =
                'id' in credit.artist
                    ? credit.artist.id
                    : credit.artist.newName.normalize('NFC').toLocaleLowerCase().trim();
            const key = `${credit.role}:${identity}`;
            if (seen.has(key))
                ctx.addIssue({
                    code: 'custom',
                    message: 'An artist may occur only once per role.',
                });
            seen.add(key);
        }
    });
export const ArtistCreditReviewSchema = z.object({
    track: z.object({
        id: z.uuid(),
        title: z.string().nullable(),
        titleSource: z.string().nullable(),
    }),
    album: z.object({ id: z.uuid(), title: z.string().nullable() }).nullable(),
    albumArtist: z.object({ id: z.uuid(), title: z.string().nullable() }).nullable(),
    protection: z.object({
        locked: z.boolean(),
        lockedBy: z.string().nullable(),
        lockedAt: z.string().nullable(),
    }),
    credits: z.array(
        z.object({
            id: z.uuid().nullable(),
            name: z.string().nullable(),
            creditedAs: z.string(),
            role: CreditRoleSchema,
            active: z.boolean(),
        }),
    ),
    rawEvidence: z.record(z.string(), z.unknown()),
    snapshot: z.string(),
});
export const ArtistCreditReviewResponseSchema = z.object({
    locked: z.boolean(),
    lockedBy: z.string().nullable(),
    lockedAt: z.string().nullable(),
    artistCreditReview: ArtistCreditReviewSchema,
});
export type ConfirmArtistCredits = z.infer<typeof ConfirmArtistCreditsSchema>;
export type ArtistCreditChoice = z.infer<typeof ArtistCreditChoiceSchema>;
export type ArtistCreditReview = z.infer<typeof ArtistCreditReviewSchema>;

export const ArtistTracksQuerySchema = z.object({
    q: z.string().max(255).default(''),
    issue: z.enum(['all', 'missing-file', 'missing-lyrics']).default('all'),
    sort: z.enum(['album', 'title']).default('album'),
    page: z.coerce.number().int().min(1).max(100000).default(1),
});
export const ArtistTracksResponseSchema = z.object({
    tracks: z.array(
        z.object({
            id: z.string(),
            title: z.string().nullable(),
            sort_order: z.number().nullable(),
            runtime_seconds: z.number().nullable(),
            custom_metadata: z.record(z.string(), z.unknown()).nullable(),
            has_lyrics: z.boolean(),
            file_path: z.string().nullable(),
            album_id: z.string().nullable(),
            album_title: z.string().nullable(),
        }),
    ),
    total: z.number(),
    catalogTotal: z.number(),
    durationSeconds: z.number(),
    page: z.number(),
    pageSize: z.literal(50),
});
export type ArtistTracksResponse = z.infer<typeof ArtistTracksResponseSchema>;

export const MusicEditReceiptSchema = z.object({
    id: z.uuid().describe('Durable music edit recovery receipt'),
    kind: z
        .enum(['credits', 'collaboration', 'album-artist', 'hierarchy', 'title'])
        .describe('Music details changed by this save'),
    createdAt: z.string().describe('Time the change was saved'),
    undone: z.boolean().describe('Whether this exact change has already been restored'),
});
export const MusicEditHistoryResponseSchema = z.object({ edits: z.array(MusicEditReceiptSchema) });
export type MusicEditReceipt = z.infer<typeof MusicEditReceiptSchema>;
