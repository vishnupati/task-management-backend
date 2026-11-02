// Response bodies of the OAuth provider APIs called from integrations/, limited to the fields the code reads.

export interface GithubTokenResponse {
    access_token?: string;
}

export interface GithubUser {
    id: number;
    login: string;
    name: string | null;
    email: string | null;
}

export interface GithubEmail {
    email: string;
    primary: boolean;
    verified: boolean;
}

export interface FacebookUser {
    id?: string;
    name?: string;
    email?: string;
}

export interface TwitterUserResponse {
    data?: {
        id?: string;
        name?: string;
        username?: string;
        email?: string;
    };
}
