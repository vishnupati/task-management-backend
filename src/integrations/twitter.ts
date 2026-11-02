import axios from 'axios';
import type { OAuthIdentity, TwitterUserResponse } from '../types';

export const verifyTwitterIdentity = async (accessToken: string): Promise<OAuthIdentity> => {
    const response = await axios.get<TwitterUserResponse | null>('https://api.twitter.com/2/users/me', {
        headers: {
            Authorization: `Bearer ${accessToken}`,
        },
        params: {
            'user.fields': 'id,name,username',
        },
    });

    const twitterUser = response.data && response.data.data;

    if (!twitterUser || !twitterUser.id) {
        throw new Error('Invalid Twitter token');
    }

    // No email is requested, so one is made up from the id: a username can be changed and then taken by someone else.
    const resolvedEmail = (twitterUser.email || `${twitterUser.id}@twitter.local`).toLowerCase();

    return {
        email: resolvedEmail,
        emailVerified: false,
        name: twitterUser.name || twitterUser.username || resolvedEmail,
        providerId: String(twitterUser.id),
    };
};
