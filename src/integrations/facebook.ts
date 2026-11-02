import axios from 'axios';
import type { FacebookUser, OAuthIdentity } from '../types';

export const verifyFacebookIdentity = async (accessToken: string): Promise<OAuthIdentity> => {
    const response = await axios.get<FacebookUser | null>('https://graph.facebook.com/me', {
        params: {
            fields: 'id,name,email',
            access_token: accessToken,
        },
    });

    const facebookUser = response.data;

    if (!facebookUser || !facebookUser.id) {
        throw new Error('Invalid Facebook token');
    }

    const resolvedEmail = (facebookUser.email || `${facebookUser.id}@facebook.local`).toLowerCase();

    return {
        email: resolvedEmail,
        name: facebookUser.name || resolvedEmail,
        providerId: String(facebookUser.id),
    };
};
