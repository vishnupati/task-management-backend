// Runs against a real MongoDB: MONGO_TEST_URL=mongodb://localhost:27017/task-management-test npm test
// Users and refresh tokens in that database are deleted, so it must be a throwaway one.
import { test, before, after, beforeEach, mock, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import type { OAuthIdentity, PublishOptions } from '../src/types';

const MONGO_TEST_URL = process.env.MONGO_TEST_URL;
const skip = !MONGO_TEST_URL && 'set MONGO_TEST_URL to run MongoDB integration tests';

type Provider = 'google' | 'github' | 'facebook' | 'twitter';

// Required in before(): src/config reads the environment once, when they load.
let mongoose: typeof import('mongoose');
let auth: typeof import('../src/services/auth');
let models: typeof import('../src/models');
let google: typeof import('../src/integrations/google');
let github: typeof import('../src/integrations/github');
let facebook: typeof import('../src/integrations/facebook');
let twitter: typeof import('../src/integrations/twitter');

before(async () => {
    if (!MONGO_TEST_URL) return;
    if (!/test/i.test(new URL(MONGO_TEST_URL).pathname)) {
        throw new Error('MONGO_TEST_URL must name a throwaway database, with "test" in its name');
    }
    delete process.env.REDIS_URL;

    mongoose = require('mongoose');
    const kafka: typeof import('../src/lib/kafka') = require('../src/lib/kafka');
    // Logins publish auth events; keep them away from any real broker.
    mock.method(kafka, 'publish', async (_options: PublishOptions) => {});
    auth = require('../src/services/auth');
    models = require('../src/models');
    google = require('../src/integrations/google');
    github = require('../src/integrations/github');
    facebook = require('../src/integrations/facebook');
    twitter = require('../src/integrations/twitter');

    await mongoose.connect(MONGO_TEST_URL);
    await models.User.init(); // unique indexes (email, identities) must exist for these tests
});

after(async () => {
    if (skip) return;
    await mongoose.disconnect();
});

beforeEach(async () => {
    if (skip) return;
    await Promise.all([models.User.deleteMany({}), models.RefreshToken.deleteMany({})]);
});

const identity = (fields: Partial<OAuthIdentity>): OAuthIdentity => ({
    email: 'same@example.com',
    emailVerified: true,
    name: 'Test User',
    providerId: 'id-1',
    ...fields,
});

// Logs in through the real service, with each provider API's answer stubbed.
const stubProviders = (t: TestContext) => {
    const answers = new Map<Provider, OAuthIdentity>();
    const answer = (provider: Provider) => async () => {
        const value = answers.get(provider);
        if (!value) throw new Error(`no ${provider} answer set`);
        return value;
    };
    t.mock.method(google, 'verifyGoogleIdentity', answer('google'));
    t.mock.method(github, 'verifyGithubIdentity', answer('github'));
    t.mock.method(facebook, 'verifyFacebookIdentity', answer('facebook'));
    t.mock.method(twitter, 'verifyTwitterIdentity', answer('twitter'));

    return (provider: Provider, providerAnswer: OAuthIdentity) => {
        answers.set(provider, providerAnswer);
        return auth.loginWithSso({ provider, idToken: 'token', accessToken: 'token' });
    };
};

const identitiesOf = async (userId: string) =>
    ((await models.User.findById(userId).lean())?.identities ?? []).map(({ provider, providerId }) => `${provider}:${providerId}`);

const isEmailInUse = (error: unknown) => error instanceof auth.AuthError && error.reason === 'email_in_use';

test('Google then GitHub with the same verified email log into one account that remembers both', { skip }, async (t) => {
    const login = stubProviders(t);

    const viaGoogle = await login('google', identity({ providerId: 'google-1' }));
    const viaGithub = await login('github', identity({ providerId: 'github-1' }));
    const googleAgain = await login('google', identity({ providerId: 'google-1' }));

    assert.equal(viaGithub.user.id, viaGoogle.user.id);
    assert.equal(googleAgain.user.id, viaGoogle.user.id);
    assert.deepEqual(await identitiesOf(viaGoogle.user.id), ['google:google-1', 'github:github-1']);
});

test('an account from before identities is found by its last provider id and gets the identity recorded', { skip }, async (t) => {
    const login = stubProviders(t);
    const legacy = await models.User.create({ name: 'Old', email: 'old@example.com', authProvider: 'github', providerId: 'github-legacy' });

    // The GitHub email has changed since, so only the provider id can find the account.
    const session = await login('github', identity({ email: 'new-address@example.com', providerId: 'github-legacy' }));

    assert.equal(session.user.id, legacy._id.toString());
    assert.deepEqual(await identitiesOf(session.user.id), ['github:github-legacy']);
});

test('a legacy account keeps its previous provider when another is linked, even after that provider\'s email changes', { skip }, async (t) => {
    const login = stubProviders(t);
    const legacy = await models.User.create({ name: 'Old', email: 'same@example.com', authProvider: 'google', providerId: 'google-legacy' });

    await login('github', identity({ providerId: 'github-1' })); // same verified email: linked
    // The Google address has changed since, so only a migrated Google identity can still find the account.
    const googleAgain = await login('google', identity({ email: 'changed@example.com', providerId: 'google-legacy' }));

    assert.equal(googleAgain.user.id, legacy._id.toString());
    assert.deepEqual(await identitiesOf(googleAgain.user.id), ['google:google-legacy', 'github:github-1']);
    assert.equal((await models.User.findById(legacy._id).lean())?.providerId, null);
});

test('an unverified email is never linked:a Facebook login with an existing account\'s email is refused', { skip }, async (t) => {
    const login = stubProviders(t);
    const owner = await login('google', identity({ email: 'owner@example.com', providerId: 'google-1' }));

    await assert.rejects(login('facebook', identity({ email: 'owner@example.com', emailVerified: false, providerId: 'facebook-1' })), isEmailInUse);

    assert.deepEqual(await identitiesOf(owner.user.id), ['google:google-1']);
});

test('a second Twitter account with the same made-up email cannot take over the first (username reuse)', { skip }, async (t) => {
    const login = stubProviders(t);
    // Accounts created before the fix got "<username>@twitter.local", and a username can later belong to someone else.
    const alice = await login('twitter', identity({ email: 'alice@twitter.local', emailVerified: false, providerId: 'twitter-1' }));

    await assert.rejects(login('twitter', identity({ email: 'alice@twitter.local', emailVerified: false, providerId: 'twitter-2' })), isEmailInUse);

    assert.deepEqual(await identitiesOf(alice.user.id), ['twitter:twitter-1']);
});

test('a password account is never linked by email, so a pre-registered address cannot capture its owner\'s SSO login', { skip }, async (t) => {
    const login = stubProviders(t);
    const preRegistered = await auth.registerUser({ name: 'Attacker', email: 'victim@example.com', password: 'secret123' });

    await assert.rejects(login('google', identity({ email: 'victim@example.com', providerId: 'google-1' })), isEmailInUse);

    assert.deepEqual(await identitiesOf(preRegistered.user.id), []);
});

test('accounts without identities don\'t collide on the unique identity index', { skip }, async () => {
    await auth.registerUser({ name: 'A', email: 'a@example.com', password: 'secret123' });

    await assert.doesNotReject(auth.registerUser({ name: 'B', email: 'b@example.com', password: 'secret123' }));
});

test('two simultaneous first logins with one identity end up in a single account', { skip }, async (t) => {
    const login = stubProviders(t);
    const answer = identity({ providerId: 'google-1' });

    const [first, second] = await Promise.all([login('google', answer), login('google', answer)]);

    assert.equal(first.user.id, second.user.id);
    assert.equal(await models.User.countDocuments(), 1);
    assert.deepEqual(await identitiesOf(first.user.id), ['google:google-1']);
});
