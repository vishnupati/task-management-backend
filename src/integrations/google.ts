import { OAuth2Client } from 'google-auth-library';
import { config } from '../config';
import type { OAuthIdentity } from '../types';

const googleClient = config.auth.googleClientId ? new OAuth2Client(config.auth.googleClientId) : null;

export const verifyGoogleIdentity = async (idToken: string): Promise<OAuthIdentity> => {
    if (!googleClient) {
        throw new Error('GOOGLE_CLIENT_ID is not configured');
    }

    const ticket = await googleClient.verifyIdToken({
        idToken,
        audience: config.auth.googleClientId,
    });

    const payload = ticket.getPayload();

    if (!payload || !payload.email || !payload.email_verified) {
        throw new Error('Invalid Google token');
    }

    return {
        email: payload.email.toLowerCase(),
        emailVerified: true,
        name: payload.name || payload.email,
        providerId: payload.sub,
    };
};
