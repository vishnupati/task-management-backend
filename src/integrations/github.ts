import axios from 'axios';
import { config } from '../config';
import type { GithubEmail, GithubTokenResponse, GithubUser, OAuthIdentity } from '../types';

// The code from GitHub's OAuth redirect, passed through as received. GitHub answers a bad code without an
// access_token, which the login then rejects. Errors from here carry the request, client secret included,
// so callers must not log them whole.
export const exchangeGithubCode = async (code: unknown): Promise<string | undefined> => {
    const response = await axios.post<GithubTokenResponse>(
        'https://github.com/login/oauth/access_token',
        {
            client_id: config.auth.githubClientId,
            client_secret: config.auth.githubClientSecret,
            code,
        },
        {
            headers: { Accept: 'application/json' },
        }
    );

    return response.data.access_token;
};

export const verifyGithubIdentity = async (accessToken: string): Promise<OAuthIdentity> => {
    const headers = {
        Authorization: `Bearer ${accessToken}`,
        Accept: 'application/vnd.github+json',
        'User-Agent': 'task-management-backend',
    };

    const userResponse = await axios.get<GithubUser>('https://api.github.com/user', { headers });
    const githubUser = userResponse.data;

    let email = githubUser.email;
    if (!email) {
        const emailsResponse = await axios.get<GithubEmail[] | null>('https://api.github.com/user/emails', { headers });
        const primaryVerified = (emailsResponse.data || []).find((item) => item.primary && item.verified);
        email = primaryVerified ? primaryVerified.email : null;
    }

    if (!email) {
        throw new Error('GitHub account has no verified email');
    }

    return {
        email: email.toLowerCase(),
        // GitHub only accepts a verified address as the public profile email, and the fallback picks a verified one.
        emailVerified: true,
        name: githubUser.name || githubUser.login || email,
        providerId: String(githubUser.id),
    };
};
