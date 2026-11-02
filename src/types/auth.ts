import type { Types } from 'mongoose';
import type { IUser } from '../models';

// The authenticated caller, set on req.user by the authenticate middleware.
export interface AuthUser {
    id: string;
    email?: string;
}

export type AuthErrorReason = 'user_exists' | 'invalid_credentials' | 'device_quota';

// The user as returned to clients.
export interface SessionUser {
    id: string;
    name: string;
    email: string;
    authProvider: string;
}

export interface TokenPair {
    accessToken: string;
    refreshToken: string;
}

export interface AuthSession {
    user: SessionUser;
    tokens: TokenPair;
}

export interface SsoPayload {
    provider: string;
    idToken?: string;
    accessToken?: string;
}

// An OAuth provider account, normalized by integrations/.
export interface OAuthIdentity {
    email: string;
    name: string;
    providerId: string;
}

// What tokens and sessions are built from; satisfied by both user documents and lean query results.
export type TokenUser = Pick<IUser, 'name' | 'email' | 'authProvider'> & { _id: Types.ObjectId };

export interface IssuedTokens extends TokenPair {
    refreshJti: string;
}

// OAuth2-style body of every successful login and refresh.
export interface AuthResponse {
    access_token: string;
    refresh_token: string;
    token_type: 'Bearer';
    expires_in: number;
    token: string;
    user: SessionUser;
}
