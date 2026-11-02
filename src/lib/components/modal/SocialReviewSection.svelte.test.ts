// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// @vitest-environment happy-dom

import { cleanup, fireEvent, render } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildPublicAuthor } from '$lib/shared/public-author';
import type { SocialActivity } from '$lib/utils/modal-data';

vi.mock('$lib/api/content', () => ({ createAnnotation: vi.fn(), deleteAnnotation: vi.fn() }));
vi.mock('$lib/paraglide/messages', () => ({
    social_someone: () => 'Someone',
    modal_review_write: () => 'Write a review',
    modal_review_your_review: () => 'Your review',
    modal_review_edit: () => 'Edit review',
    modal_review_delete: () => 'Delete review',
    modal_review_read_more: () => 'Read more',
    modal_review_show_less: () => 'Show less',
    modal_friends_watched: () => 'Friends watched',
}));

import SocialReviewSection from './SocialReviewSection.svelte';

const FIRST_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const SECOND_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

function activity(userId: string, displayName: string | null): SocialActivity {
    return {
        author: buildPublicAuthor(userId, displayName, 'internal'),
        description: `${displayName ?? 'Someone'} reviewed`,
        review: 'A long review with enough text to expand. '.repeat(4),
        reviewId: `review-${userId}`,
    };
}

afterEach(cleanup);

describe('SocialReviewSection public authors', () => {
    it('renders public avatar links and a neutral name when no display name is set', () => {
        const { getByAltText } = render(SocialReviewSection, {
            showSocialActivity: true,
            socialActivities: [activity(FIRST_ID, 'Public Person'), activity(SECOND_ID, null)],
        });
        expect(getByAltText('Public Person').getAttribute('src')).toBe(
            `/api/users/${FIRST_ID}/images/avatar?size=card&v=0&fallback=initials`,
        );
        expect(getByAltText('Someone').getAttribute('src')).toBe(
            `/api/users/${SECOND_ID}/images/avatar?size=card&v=0&fallback=initials`,
        );
    });

    it('identifies the current review by UUID when display names are identical', () => {
        const { queryByText, getAllByText } = render(SocialReviewSection, {
            showSocialActivity: true,
            showReviews: true,
            mediaDbId: 'media-id',
            currentUserId: FIRST_ID.toUpperCase(),
            socialActivities: [activity(FIRST_ID, 'Same Name'), activity(SECOND_ID, 'Same Name')],
        });
        expect(getAllByText('Same Name reviewed')).toHaveLength(2);
        expect(queryByText('Write a review')).toBeNull();
    });

    it('expands reviews independently for authors with identical display names', async () => {
        const { getAllByText, getByText } = render(SocialReviewSection, {
            showSocialActivity: true,
            showReviews: true,
            socialActivities: [activity(FIRST_ID, 'Same Name'), activity(SECOND_ID, 'Same Name')],
        });
        await fireEvent.click(getAllByText('Read more')[0]);
        expect(getAllByText('Read more')).toHaveLength(1);
        expect(getByText('Show less')).toBeTruthy();
    });
});
