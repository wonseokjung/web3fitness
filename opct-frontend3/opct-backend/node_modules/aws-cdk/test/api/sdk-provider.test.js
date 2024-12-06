"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const os = require("os");
const cdk_build_tools_1 = require("@aws-cdk/cdk-build-tools");
const cxapi = require("@aws-cdk/cx-api");
const client_sts_1 = require("@aws-sdk/client-sts");
const promptly = require("promptly");
const uuid = require("uuid");
const fake_sts_1 = require("./fake-sts");
const aws_auth_1 = require("../../lib/api/aws-auth");
const awscli_compatible_1 = require("../../lib/api/aws-auth/awscli-compatible");
const user_agent_1 = require("../../lib/api/aws-auth/user-agent");
const plugin_1 = require("../../lib/api/plugin");
const logging = require("../../lib/logging");
const util_1 = require("../util");
const mock_sdk_1 = require("../util/mock-sdk");
let mockFetchMetadataToken = jest.fn();
let mockRequest = jest.fn();
jest.mock('@aws-sdk/ec2-metadata-service', () => {
    return {
        MetadataService: jest.fn().mockImplementation(() => {
            return {
                fetchMetadataToken: mockFetchMetadataToken,
                request: mockRequest,
            };
        }),
    };
});
jest.mock('promptly', () => ({
    prompt: jest.fn().mockResolvedValue('1234'),
}));
let uid;
let pluginQueried = false;
beforeEach(() => {
    // Cache busters!
    // We prefix everything with UUIDs because:
    //
    // - We have a cache from account# -> credentials
    // - We have a cache from access key -> account
    uid = `(${uuid.v4()})`;
    logging.setLogLevel(logging.LogLevel.TRACE);
    plugin_1.PluginHost.instance.credentialProviderSources.splice(0);
    plugin_1.PluginHost.instance.credentialProviderSources.push({
        isAvailable() {
            return Promise.resolve(true);
        },
        canProvideCredentials(account) {
            return Promise.resolve(account === uniq('99999'));
        },
        getProvider() {
            pluginQueried = true;
            return Promise.resolve({
                accessKeyId: `${uid}plugin_key`,
                secretAccessKey: 'plugin_secret',
                sessionToken: 'plugin_token',
            });
        },
        name: 'test plugin',
    });
    // Make sure these point to nonexistant files to start, if we don't call
    // prepare() then we don't accidentally want to fall back to system config.
    process.env.AWS_CONFIG_FILE = '/dev/null';
    process.env.AWS_SHARED_CREDENTIALS_FILE = '/dev/null';
    (0, mock_sdk_1.restoreSdkMocksToDefault)();
});
afterEach(() => {
    cdk_build_tools_1.bockfs.restore();
    jest.restoreAllMocks();
});
function uniq(account) {
    return `${uid}${account}`;
}
function env(account) {
    return cxapi.EnvironmentUtils.make(account, 'def');
}
describe('with intercepted network calls', () => {
    // Most tests will use intercepted network calls, except one test that tests
    // that the right HTTP `Agent` is used.
    let fakeSts;
    beforeEach(() => {
        fakeSts = new fake_sts_1.FakeSts();
        fakeSts.begin();
        // Make sure the KeyID returned by the plugin is recognized
        fakeSts.registerUser(uniq('99999'), uniq('plugin_key'));
        mockRequest = jest.fn().mockResolvedValue(JSON.stringify({ region: undefined }));
    });
    afterEach(() => {
        fakeSts.restore();
    });
    // Set of tests where the CDK will not trigger assume-role
    // (the INI file might still do assume-role)
    describe('when CDK does not AssumeRole', () => {
        test('uses default credentials by default', async () => {
            // WHEN
            const account = uniq('11111');
            mock_sdk_1.mockSTSClient.on(client_sts_1.GetCallerIdentityCommand).resolves({
                Account: account,
                Arn: 'arn:aws-here',
            });
            prepareCreds({
                credentials: {
                    default: { aws_access_key_id: 'access', $account: '11111', $fakeStsOptions: { partition: 'aws-here' } },
                },
                config: {
                    default: { region: 'eu-bla-5' },
                },
            });
            const provider = await providerFromProfile(undefined);
            // THEN
            expect(provider.defaultRegion).toEqual('eu-bla-5');
            await expect(provider.defaultAccount()).resolves.toEqual({ accountId: account, partition: 'aws-here' });
            // Ask for a different region
            const sdk = (await provider.forEnvironment({ ...env(account), region: 'rgn' }, plugin_1.Mode.ForReading)).sdk;
            expect(sdkConfig(sdk).credentials.accessKeyId).toEqual(uniq('access'));
            expect(sdk.currentRegion).toEqual('rgn');
        });
        test('throws if no credentials could be found', async () => {
            const account = uniq('11111');
            const provider = await providerFromProfile(undefined);
            await expect((provider.forEnvironment({ ...env(account), region: 'rgn' }, plugin_1.Mode.ForReading)))
                .rejects
                .toThrow(/Need to perform AWS calls for account .*, but no credentials have been configured, and none of these plugins found any/);
        });
        test('no base credentials partition if token is expired', async () => {
            const account = uniq('11111');
            const error = new Error('Expired Token');
            error.name = 'ExpiredToken';
            const identityProvider = () => Promise.reject(error);
            const provider = new aws_auth_1.SdkProvider(identityProvider, 'rgn');
            const creds = await provider.baseCredentialsPartition({ ...env(account), region: 'rgn' }, plugin_1.Mode.ForReading);
            expect(creds).toBeUndefined();
        });
        test('throws if profile credentials are not for the right account', async () => {
            // WHEN
            jest.spyOn(awscli_compatible_1.AwsCliCompatible, 'region').mockResolvedValue('us-east-123');
            prepareCreds({
                fakeSts,
                config: {
                    'profile boo': { aws_access_key_id: 'access', $account: '11111' },
                },
            });
            const provider = await providerFromProfile('boo');
            await expect(provider.forEnvironment(env(uniq('some_account_#')), plugin_1.Mode.ForReading)).rejects.toThrow('Need to perform AWS calls');
        });
        test('use profile acct/region if agnostic env requested', async () => {
            // WHEN
            prepareCreds({
                fakeSts,
                credentials: {
                    default: { aws_access_key_id: 'access', $account: '11111' },
                },
                config: {
                    default: { region: 'eu-bla-5' },
                },
            });
            const provider = await providerFromProfile(undefined);
            // THEN
            const sdk = (await provider.forEnvironment(cxapi.EnvironmentUtils.make(cxapi.UNKNOWN_ACCOUNT, cxapi.UNKNOWN_REGION), plugin_1.Mode.ForReading)).sdk;
            expect(sdkConfig(sdk).credentials.accessKeyId).toEqual(uniq('access'));
            expect((await sdk.currentAccount()).accountId).toEqual(uniq('11111'));
            expect(sdk.currentRegion).toEqual('eu-bla-5');
        });
        test('passing profile skips EnvironmentCredentials', async () => {
            // GIVEN
            const calls = jest.spyOn(console, 'debug');
            prepareCreds({
                fakeSts,
                credentials: {
                    foo: { aws_access_key_id: 'access', $account: '11111' },
                },
            });
            const provider = await providerFromProfile('foo');
            await provider.defaultAccount();
            // Only credential-provider-ini is used.
            expect(calls).toHaveBeenCalledTimes(2);
            expect(calls.mock.calls[0]).toEqual(['@aws-sdk/credential-provider-ini - fromIni']);
            expect(calls.mock.calls[1]).toEqual(['@aws-sdk/credential-provider-ini - resolveStaticCredentials']);
        });
        test('supports profile spread over config_file and credentials_file', async () => {
            // WHEN
            prepareCreds({
                fakeSts,
                credentials: {
                    foo: { aws_access_key_id: 'fooccess', $account: '22222' },
                },
                config: {
                    'default': { region: 'eu-bla-5' },
                    'profile foo': { region: 'eu-west-1' },
                },
            });
            const provider = await providerFromProfile('foo');
            // THEN
            expect(provider.defaultRegion).toEqual('eu-west-1');
            await expect(provider.defaultAccount()).resolves.toEqual({ accountId: uniq('22222'), partition: 'aws' });
            const sdk = (await provider.forEnvironment(env(uniq('22222')), plugin_1.Mode.ForReading)).sdk;
            expect(sdkConfig(sdk).credentials.accessKeyId).toEqual(uniq('fooccess'));
        });
        test('supports profile only in config_file', async () => {
            // WHEN
            prepareCreds({
                fakeSts,
                config: {
                    'default': { region: 'eu-bla-5' },
                    'profile foo': { aws_access_key_id: 'fooccess', $account: '22222' },
                },
            });
            const provider = await providerFromProfile('foo');
            // THEN
            expect(provider.defaultRegion).toEqual('eu-bla-5'); // Fall back to default config
            await expect(provider.defaultAccount()).resolves.toEqual({ accountId: uniq('22222'), partition: 'aws' });
            const sdk = (await provider.forEnvironment(env(uniq('22222')), plugin_1.Mode.ForReading)).sdk;
            expect(sdkConfig(sdk).credentials.accessKeyId).toEqual(uniq('fooccess'));
        });
        test('can assume-role configured in config', async () => {
            // GIVEN
            jest.spyOn(console, 'debug');
            prepareCreds({
                fakeSts,
                credentials: {
                    assumer: { aws_access_key_id: 'assumer', $account: '11111' },
                },
                config: {
                    'default': { region: 'eu-bla-5' },
                    'profile assumer': { region: 'us-east-2' },
                    'profile assumable': {
                        role_arn: 'arn:aws:iam::66666:role/Assumable',
                        source_profile: 'assumer',
                        $account: '66666',
                        $fakeStsOptions: { allowedAccounts: ['11111'] },
                    },
                },
            });
            const provider = await providerFromProfile('assumable');
            // WHEN
            const sdk = (await provider.forEnvironment(env(uniq('66666')), plugin_1.Mode.ForReading)).sdk;
            // THEN
            expect((await sdk.currentAccount()).accountId).toEqual(uniq('66666'));
        });
        test('can assume role even if [default] profile is missing', async () => {
            // GIVEN
            prepareCreds({
                fakeSts,
                credentials: {
                    assumer: { aws_access_key_id: 'assumer', $account: '22222' },
                    assumable: {
                        role_arn: 'arn:aws:iam::12356789012:role/Assumable',
                        source_profile: 'assumer',
                        $account: '22222',
                    },
                },
                config: {
                    'profile assumable': { region: 'eu-bla-5' },
                },
            });
            // WHEN
            const provider = await providerFromProfile('assumable');
            // THEN
            expect((await provider.defaultAccount())?.accountId).toEqual(uniq('22222'));
        });
        test('mfa_serial in profile will ask user for token', async () => {
            // GIVEN
            prepareCreds({
                fakeSts,
                credentials: {
                    assumer: { aws_access_key_id: 'assumer', $account: '66666' },
                },
                config: {
                    'default': { region: 'eu-bla-5' },
                    'profile assumer': { region: 'us-east-2' },
                    'profile mfa-role': {
                        role_arn: 'arn:aws:iam::66666:role/Assumable',
                        source_profile: 'assumer',
                        mfa_serial: 'arn:aws:iam::account:mfa/user',
                        $account: '66666',
                    },
                },
            });
            const provider = await providerFromProfile('mfa-role');
            const promptlyMockCalls = promptly.prompt.mock.calls.length;
            // THEN
            const sdk = (await provider.forEnvironment(env(uniq('66666')), plugin_1.Mode.ForReading)).sdk;
            expect((await sdk.currentAccount()).accountId).toEqual(uniq('66666'));
            expect(mock_sdk_1.mockSTSClient).toHaveReceivedCommandWith(client_sts_1.AssumeRoleCommand, {
                RoleArn: 'arn:aws:iam::66666:role/Assumable',
                SerialNumber: 'arn:aws:iam::account:mfa/user',
                TokenCode: '1234',
                RoleSessionName: expect.anything(),
            });
            // Mock response was set to fail to make sure we don't call STS
            // Make sure the MFA mock was called during this test
            expect(promptly.prompt.mock.calls.length).toBe(promptlyMockCalls + 1);
        });
    });
    // For DefaultSynthesis we will do an assume-role after having gotten base credentials
    describe('when CDK AssumeRoles', () => {
        beforeEach(() => {
            // All these tests share that 'arn:aws:role' is a role into account 88888 which can be assumed from 11111
            fakeSts.registerRole(uniq('88888'), 'arn:aws:role', { allowedAccounts: [uniq('11111')] });
        });
        test('error we get from assuming a role is useful', async () => {
            // GIVEN
            prepareCreds({
                fakeSts,
                config: {
                    default: { aws_access_key_id: 'foo' },
                },
            });
            mock_sdk_1.mockSTSClient.on(client_sts_1.AssumeRoleCommand).rejectsOnce('doesnotexist.role.arn');
            const provider = await providerFromProfile(undefined);
            // WHEN
            const promise = provider.forEnvironment(env(uniq('88888')), plugin_1.Mode.ForReading, {
                assumeRoleArn: 'doesnotexist.role.arn',
            });
            // THEN - error message contains both a helpful hint and the underlying AssumeRole message
            await expect(promise).rejects.toThrow('(re)-bootstrap the environment');
            await expect(promise).rejects.toThrow('doesnotexist.role.arn');
        });
        test('assuming a role sanitizes the username into the session name', async () => {
            // GIVEN
            prepareCreds({
                // fakeSts,
                config: {
                    default: { aws_access_key_id: 'foo', $account: '11111' },
                },
            });
            await (0, util_1.withMocked)(os, 'userInfo', async (userInfo) => {
                userInfo.mockReturnValue({ username: 'skål', uid: 1, gid: 1, homedir: '/here', shell: '/bin/sh' });
                // WHEN
                const provider = await providerFromProfile(undefined);
                const sdk = (await provider.forEnvironment(env(uniq('88888')), plugin_1.Mode.ForReading, { assumeRoleArn: 'arn:aws:role' })).sdk;
                await sdk.currentAccount();
                // THEN
                expect(mock_sdk_1.mockSTSClient).toHaveReceivedCommandWith(client_sts_1.AssumeRoleCommand, {
                    RoleArn: 'arn:aws:role',
                    RoleSessionName: 'aws-cdk-sk@l',
                });
            });
        });
        test('session tags can be passed when assuming a role', async () => {
            // GIVEN
            prepareCreds({
                fakeSts,
                config: {
                    default: { aws_access_key_id: 'foo', $account: '11111' },
                },
            });
            await (0, util_1.withMocked)(os, 'userInfo', async (userInfo) => {
                userInfo.mockReturnValue({ username: 'skål', uid: 1, gid: 1, homedir: '/here', shell: '/bin/sh' });
                // WHEN
                const provider = await providerFromProfile(undefined);
                const sdk = (await provider.forEnvironment(env(uniq('88888')), plugin_1.Mode.ForReading, {
                    assumeRoleArn: 'arn:aws:role',
                    assumeRoleExternalId: 'bruh',
                    assumeRoleAdditionalOptions: {
                        Tags: [{ Key: 'Department', Value: 'Engineering' }],
                    },
                })).sdk;
                await sdk.currentAccount();
                // THEN
                expect(mock_sdk_1.mockSTSClient).toHaveReceivedCommandWith(client_sts_1.AssumeRoleCommand, {
                    Tags: [{ Key: 'Department', Value: 'Engineering' }],
                    TransitiveTagKeys: ['Department'],
                    RoleArn: 'arn:aws:role',
                    ExternalId: 'bruh',
                    RoleSessionName: 'aws-cdk-sk@l',
                });
            });
        });
        test('assuming a role does not fail when OS username cannot be read', async () => {
            // GIVEN
            prepareCreds({
                // fakeSts,
                config: {
                    default: { aws_access_key_id: 'foo', $account: '11111' },
                },
            });
            await (0, util_1.withMocked)(os, 'userInfo', async (userInfo) => {
                userInfo.mockImplementation(() => {
                    // SystemError thrown as documented: https://nodejs.org/docs/latest-v16.x/api/os.html#osuserinfooptions
                    throw new Error('SystemError on Linux: uv_os_get_passwd returned ENOENT. See #19401 issue.');
                });
                // WHEN
                const provider = await providerFromProfile(undefined);
                const sdk = (await provider.forEnvironment(env(uniq('88888')), plugin_1.Mode.ForReading, { assumeRoleArn: 'arn:aws:role' })).sdk;
                await sdk.currentAccount();
                // THEN
                expect(mock_sdk_1.mockSTSClient).toHaveReceivedCommandWith(client_sts_1.AssumeRoleCommand, {
                    RoleArn: 'arn:aws:role',
                    RoleSessionName: 'aws-cdk-noname',
                });
            });
        });
        test('even if current credentials are for the wrong account, we will still use them to AssumeRole', async () => {
            // GIVEN
            prepareCreds({
                // fakeSts,
                config: {
                    default: { aws_access_key_id: 'foo', $account: '11111' },
                },
            });
            const provider = await providerFromProfile(undefined);
            // WHEN
            const sdk = (await provider.forEnvironment(env(uniq('88888')), plugin_1.Mode.ForReading, { assumeRoleArn: 'arn:aws:role' })).sdk;
            // THEN
            expect((await sdk.currentAccount()).accountId).toEqual(uniq('88888'));
        });
        test('if AssumeRole fails but current credentials are for the right account, we will still use them', async () => {
            // GIVEN
            prepareCreds({
                // fakeSts,
                config: {
                    default: { aws_access_key_id: 'foo', $account: '88888' },
                },
            });
            const provider = await providerFromProfile(undefined);
            // WHEN - assumeRole fails because the role can only be assumed from account 11111
            const sdk = (await provider.forEnvironment(env(uniq('88888')), plugin_1.Mode.ForReading, { assumeRoleArn: 'arn:aws:role' })).sdk;
            // THEN
            expect((await sdk.currentAccount()).accountId).toEqual(uniq('88888'));
        });
        test('if AssumeRole fails because of ExpiredToken, then fail completely', async () => {
            // GIVEN
            prepareCreds({
                // fakeSts,
                config: {
                    default: { aws_access_key_id: 'foo', $account: '88888' },
                },
            });
            const error = new Error('Too late');
            error.name = 'ExpiredToken';
            mock_sdk_1.mockSTSClient.on(client_sts_1.AssumeRoleCommand).rejectsOnce(error);
            const provider = await providerFromProfile(undefined);
            // WHEN - assumeRole fails with a specific error
            await expect(async () => {
                await provider.forEnvironment(env(uniq('88888')), plugin_1.Mode.ForReading, { assumeRoleArn: '<FAIL:ExpiredToken>' });
            }).rejects.toThrow(error);
        });
    });
    describe('Plugins', () => {
        test('does not use plugins if current credentials are for expected account', async () => {
            prepareCreds({
                fakeSts,
                config: {
                    default: { aws_access_key_id: 'foo', $account: '11111' },
                },
            });
            const provider = await providerFromProfile(undefined);
            await provider.forEnvironment(env(uniq('11111')), plugin_1.Mode.ForReading);
            expect(pluginQueried).toEqual(false);
        });
        test('uses plugin for account 99999', async () => {
            const provider = await providerFromProfile(undefined);
            await provider.forEnvironment(env(uniq('99999')), plugin_1.Mode.ForReading);
            expect(pluginQueried).toEqual(true);
        });
        test('can assume role with credentials from plugin', async () => {
            fakeSts.registerRole(uniq('99999'), 'arn:aws:iam::99999:role/Assumable');
            const provider = await providerFromProfile(undefined);
            await provider.forEnvironment(env(uniq('99999')), plugin_1.Mode.ForReading, {
                assumeRoleArn: 'arn:aws:iam::99999:role/Assumable',
            });
            expect(mock_sdk_1.mockSTSClient).toHaveReceivedCommandWith(client_sts_1.AssumeRoleCommand, {
                RoleArn: 'arn:aws:iam::99999:role/Assumable',
                RoleSessionName: expect.anything(),
            });
            expect(pluginQueried).toEqual(true);
        });
        test('even if AssumeRole fails but current credentials are from a plugin, we will still use them', async () => {
            const provider = await providerFromProfile(undefined);
            const sdk = (await provider.forEnvironment(env(uniq('99999')), plugin_1.Mode.ForReading, { assumeRoleArn: 'does:not:exist' })).sdk;
            // THEN
            expect((await sdk.currentAccount()).accountId).toEqual(uniq('99999'));
        });
        test('plugins are still queried even if current credentials are expired (or otherwise invalid)', async () => {
            // GIVEN
            process.env.AWS_ACCESS_KEY_ID = `${uid}akid`;
            process.env.AWS_SECRET_ACCESS_KEY = 'sekrit';
            const provider = await providerFromProfile(undefined);
            // WHEN
            await provider.forEnvironment(env(uniq('99999')), plugin_1.Mode.ForReading);
            // THEN
            expect(pluginQueried).toEqual(true);
        });
    });
    describe('support for credential_source', () => {
        test('can assume role with ecs credentials', async () => {
            // GIVEN
            const calls = jest.spyOn(console, 'debug');
            prepareCreds({
                config: {
                    'profile ecs': {
                        role_arn: 'arn:aws:iam::12356789012:role/Assumable',
                        credential_source: 'EcsContainer',
                        $account: '22222',
                    },
                },
            });
            // WHEN
            const provider = await providerFromProfile('ecs');
            await provider.defaultAccount();
            // THEN
            expect(calls.mock.calls).toContainEqual([
                '@aws-sdk/credential-provider-ini - finding credential resolver using profile=[ecs]',
            ]);
            expect(calls.mock.calls).toContainEqual(['@aws-sdk/credential-provider-ini - credential_source is EcsContainer']);
        });
        test('can assume role with ec2 credentials', async () => {
            // GIVEN
            const calls = jest.spyOn(console, 'debug');
            prepareCreds({
                config: {
                    'profile ecs': {
                        role_arn: 'arn:aws:iam::12356789012:role/Assumable',
                        credential_source: 'Ec2InstanceMetadata',
                        $account: '22222',
                    },
                },
            });
            // WHEN
            const provider = await providerFromProfile('ecs');
            await provider.defaultAccount();
            // THEN
            expect(calls.mock.calls).toContainEqual([
                '@aws-sdk/credential-provider-ini - finding credential resolver using profile=[ecs]',
            ]);
            expect(calls.mock.calls).toContainEqual([
                '@aws-sdk/credential-provider-ini - credential_source is Ec2InstanceMetadata',
            ]);
        });
        test('can assume role with env credentials', async () => {
            // GIVEN
            const calls = jest.spyOn(console, 'debug');
            prepareCreds({
                config: {
                    'profile ecs': {
                        role_arn: 'arn:aws:iam::12356789012:role/Assumable',
                        credential_source: 'Environment',
                        $account: '22222',
                    },
                },
            });
            // WHEN
            const provider = await providerFromProfile('ecs');
            await provider.defaultAccount();
            // THEN
            expect(calls.mock.calls).toContainEqual([
                '@aws-sdk/credential-provider-ini - finding credential resolver using profile=[ecs]',
            ]);
            expect(calls.mock.calls).toContainEqual(['@aws-sdk/credential-provider-ini - credential_source is Environment']);
        });
        test('assume fails with unsupported credential_source', async () => {
            // GIVEN
            prepareCreds({
                config: {
                    'profile ecs': {
                        role_arn: 'arn:aws:iam::12356789012:role/Assumable',
                        credential_source: 'unsupported',
                        $account: '22222',
                    },
                },
            });
            const provider = await providerFromProfile('ecs');
            // WHEN
            const account = await provider.defaultAccount();
            // THEN
            expect(account?.accountId).toEqual(undefined);
        });
    });
    test('defaultAccount returns undefined if STS call fails', async () => {
        // GIVEN
        mock_sdk_1.mockSTSClient.on(client_sts_1.AssumeRoleCommand).rejectsOnce('Oops, bad sekrit');
        // WHEN
        const provider = await providerFromProfile(undefined);
        // THEN
        await expect(provider.defaultAccount()).resolves.toBe(undefined);
    });
    test('defaultAccount returns undefined, event if STS call fails with ExpiredToken', async () => {
        // GIVEN
        const error = new Error('Too late');
        error.name = 'ExpiredToken';
        mock_sdk_1.mockSTSClient.on(client_sts_1.AssumeRoleCommand).rejectsOnce(error);
        // WHEN
        const provider = await providerFromProfile(undefined);
        // THEN
        await expect(provider.defaultAccount()).resolves.toBe(undefined);
    });
});
test('default useragent is reasonable', () => {
    expect((0, user_agent_1.defaultCliUserAgent)()).toContain('aws-cdk/');
});
/**
 * Use object hackery to get the credentials out of the SDK object
 */
function sdkConfig(sdk) {
    return sdk.config;
}
/**
 * Fixture for SDK auth for this test suite
 *
 * Has knowledge of the cache buster, will write proper fake config files and
 * register users and roles in FakeSts at the same time.
 */
function prepareCreds(options) {
    function convertSections(sections) {
        const ret = [];
        for (const [profile, user] of Object.entries(sections ?? {})) {
            ret.push(`[${profile}]`);
            if (isProfileRole(user)) {
                ret.push(`role_arn=${user.role_arn}`);
                if ('source_profile' in user) {
                    ret.push(`source_profile=${user.source_profile}`);
                }
                if ('credential_source' in user) {
                    ret.push(`credential_source=${user.credential_source}`);
                }
                if (user.mfa_serial) {
                    ret.push(`mfa_serial=${user.mfa_serial}`);
                }
                options.fakeSts?.registerRole(uniq(user.$account ?? '00000'), user.role_arn, {
                    ...user.$fakeStsOptions,
                    allowedAccounts: user.$fakeStsOptions?.allowedAccounts?.map(uniq),
                });
            }
            else {
                if (user.aws_access_key_id) {
                    ret.push(`aws_access_key_id=${uniq(user.aws_access_key_id)}`);
                    ret.push('aws_secret_access_key=secret');
                    options.fakeSts?.registerUser(uniq(user.$account ?? '00000'), uniq(user.aws_access_key_id), user.$fakeStsOptions);
                }
            }
            if (user.region) {
                ret.push(`region=${user.region}`);
            }
        }
        return ret.join('\n');
    }
    (0, cdk_build_tools_1.bockfs)({
        '/home/me/.bxt/credentials': convertSections(options.credentials),
        '/home/me/.bxt/config': convertSections(options.config),
    });
    // Set environment variables that we want
    process.env.AWS_CONFIG_FILE = cdk_build_tools_1.bockfs.path('/home/me/.bxt/config');
    process.env.AWS_SHARED_CREDENTIALS_FILE = cdk_build_tools_1.bockfs.path('/home/me/.bxt/credentials');
}
function isProfileRole(x) {
    return 'role_arn' in x;
}
async function providerFromProfile(profile) {
    return aws_auth_1.SdkProvider.withAwsCliCompatibleDefaults({ profile, logger: console });
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoic2RrLXByb3ZpZGVyLnRlc3QuanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyJzZGstcHJvdmlkZXIudGVzdC50cyJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiOztBQUFBLHlCQUF5QjtBQUN6Qiw4REFBa0Q7QUFDbEQseUNBQXlDO0FBQ3pDLG9EQUFrRjtBQUNsRixxQ0FBcUM7QUFDckMsNkJBQTZCO0FBQzdCLHlDQUErRTtBQUMvRSxxREFBZ0Y7QUFDaEYsZ0ZBQTRFO0FBQzVFLGtFQUF3RTtBQUN4RSxpREFBd0Q7QUFDeEQsNkNBQTZDO0FBQzdDLGtDQUFxQztBQUNyQywrQ0FBMkU7QUFFM0UsSUFBSSxzQkFBc0IsR0FBRyxJQUFJLENBQUMsRUFBRSxFQUFFLENBQUM7QUFDdkMsSUFBSSxXQUFXLEdBQUcsSUFBSSxDQUFDLEVBQUUsRUFBRSxDQUFDO0FBRTVCLElBQUksQ0FBQyxJQUFJLENBQUMsK0JBQStCLEVBQUUsR0FBRyxFQUFFO0lBQzlDLE9BQU87UUFDTCxlQUFlLEVBQUUsSUFBSSxDQUFDLEVBQUUsRUFBRSxDQUFDLGtCQUFrQixDQUFDLEdBQUcsRUFBRTtZQUNqRCxPQUFPO2dCQUNMLGtCQUFrQixFQUFFLHNCQUFzQjtnQkFDMUMsT0FBTyxFQUFFLFdBQVc7YUFDckIsQ0FBQztRQUNKLENBQUMsQ0FBQztLQUNILENBQUM7QUFDSixDQUFDLENBQUMsQ0FBQztBQUVILElBQUksQ0FBQyxJQUFJLENBQUMsVUFBVSxFQUFFLEdBQUcsRUFBRSxDQUFDLENBQUM7SUFDM0IsTUFBTSxFQUFFLElBQUksQ0FBQyxFQUFFLEVBQUUsQ0FBQyxpQkFBaUIsQ0FBQyxNQUFNLENBQUM7Q0FDNUMsQ0FBQyxDQUFDLENBQUM7QUFFSixJQUFJLEdBQVcsQ0FBQztBQUNoQixJQUFJLGFBQWEsR0FBRyxLQUFLLENBQUM7QUFFMUIsVUFBVSxDQUFDLEdBQUcsRUFBRTtJQUNkLGlCQUFpQjtJQUNqQiwyQ0FBMkM7SUFDM0MsRUFBRTtJQUNGLGlEQUFpRDtJQUNqRCwr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QUMsMkJBQTJCLENBQUMsQ0FBQztBQUNyRixDQUFDO0FBa0NELFNBQVMsYUFBYSxDQUFDLENBQTRCO0lBQ2pELE9BQU8sVUFBVSxJQUFJLENBQUMsQ0FBQztBQUN6QixDQUFDO0FBRUQsS0FBSyxVQUFVLG1CQUFtQixDQUFDLE9BQTJCO0lBQzVELE9BQU8sc0JBQVcsQ0FBQyw0QkFBNEIsQ0FBQyxFQUFFLE9BQU8sRUFBRSxNQUFNLEVBQUUsT0FBTyxFQUFFLENBQUMsQ0FBQztBQUNoRixDQUFDIiwic291cmNlc0NvbnRlbnQiOlsiaW1wb3J0ICogYXMgb3MgZnJvbSAnb3MnO1xuaW1wb3J0IHsgYm9ja2ZzIH0gZnJvbSAnQGF3cy1jZGsvY2RrLWJ1aWxkLXRvb2xzJztcbmltcG9ydCAqIGFzIGN4YXBpIGZyb20gJ0Bhd3MtY2RrL2N4LWFwaSc7XG5pbXBvcnQgeyBBc3N1bWVSb2xlQ29tbWFuZCwgR2V0Q2FsbGVySWRlbnRpdHlDb21tYW5kIH0gZnJvbSAnQGF3cy1zZGsvY2xpZW50LXN0cyc7XG5pbXBvcnQgKiBhcyBwcm9tcHRseSBmcm9tICdwcm9tcHRseSc7XG5pbXBvcnQgKiBhcyB1dWlkIGZyb20gJ3V1aWQnO1xuaW1wb3J0IHsgRmFrZVN0cywgUmVnaXN0ZXJSb2xlT3B0aW9ucywgUmVnaXN0ZXJVc2VyT3B0aW9ucyB9IGZyb20gJy4vZmFrZS1zdHMnO1xuaW1wb3J0IHsgQ29uZmlndXJhdGlvbk9wdGlvbnMsIFNESywgU2RrUHJvdmlkZXIgfSBmcm9tICcuLi8uLi9saWIvYXBpL2F3cy1hdXRoJztcbmltcG9ydCB7IEF3c0NsaUNvbXBhdGlibGUgfSBmcm9tICcuLi8uLi9saWIvYXBpL2F3cy1hdXRoL2F3c2NsaS1jb21wYXRpYmxlJztcbmltcG9ydCB7IGRlZmF1bHRDbGlVc2VyQWdlbnQgfSBmcm9tICcuLi8uLi9saWIvYXBpL2F3cy1hdXRoL3VzZXItYWdlbnQnO1xuaW1wb3J0IHsgTW9kZSwgUGx1Z2luSG9zdCB9IGZyb20gJy4uLy4uL2xpYi9hcGkvcGx1Z2luJztcbmltcG9ydCAqIGFzIGxvZ2dpbmcgZnJvbSAnLi4vLi4vbGliL2xvZ2dpbmcnO1xuaW1wb3J0IHsgd2l0aE1vY2tlZCB9IGZyb20gJy4uL3V0aWwnO1xuaW1wb3J0IHsgbW9ja1NUU0NsaWVudCwgcmVzdG9yZVNka01vY2tzVG9EZWZhdWx0IH0gZnJvbSAnLi4vdXRpbC9tb2NrLXNkayc7XG5cbmxldCBtb2NrRmV0Y2hNZXRhZGF0YVRva2VuID0gamVzdC5mbigpO1xubGV0IG1vY2tSZXF1ZXN0ID0gamVzdC5mbigpO1xuXG5qZXN0Lm1vY2soJ0Bhd3Mtc2RrL2VjMi1tZXRhZGF0YS1zZXJ2aWNlJywgKCkgPT4ge1xuICByZXR1cm4ge1xuICAgIE1ldGFkYXRhU2VydmljZTogamVzdC5mbigpLm1vY2tJbXBsZW1lbnRhdGlvbigoKSA9PiB7XG4gICAgICByZXR1cm4ge1xuICAgICAgICBmZXRjaE1ldGFkYXRhVG9rZW46IG1vY2tGZXRjaE1ldGFkYXRhVG9rZW4sXG4gICAgICAgIHJlcXVlc3Q6IG1vY2tSZXF1ZXN0LFxuICAgICAgfTtcbiAgICB9KSxcbiAgfTtcbn0pO1xuXG5qZXN0Lm1vY2soJ3Byb21wdGx5JywgKCkgPT4gKHtcbiAgcHJvbXB0OiBqZXN0LmZuKCkubW9ja1Jlc29sdmVkVmFsdWUoJzEyMzQnKSxcbn0pKTtcblxubGV0IHVpZDogc3RyaW5nO1xubGV0IHBsdWdpblF1ZXJpZWQgPSBmYWxzZTtcblxuYmVmb3JlRWFjaCgoKSA9PiB7XG4gIC8vIENhY2hlIGJ1c3RlcnMhXG4gIC8vIFdlIHByZWZpeCBldmVyeXRoaW5nIHdpdGggVVVJRHMgYmVjYXVzZTpcbiAgLy9cbiAgLy8gLSBXZSBoYXZlIGEgY2FjaGUgZnJvbSBhY2NvdW50IyAtPiBjcmVkZW50aWFsc1xuICAvLyAtIFdlIGhhdmUgYSBjYWNoZSBmcm9tIGFjY2VzcyBrZXkgLT4gYWNjb3VudFxuICB1aWQgPSBgKCR7dXVpZC52NCgpfSlgO1xuXG4gIGxvZ2dpbmcuc2V0TG9nTGV2ZWwobG9nZ2luZy5Mb2dMZXZlbC5UUkFDRSk7XG5cbiAgUGx1Z2luSG9zdC5pbnN0YW5jZS5jcmVkZW50aWFsUHJvdmlkZXJTb3VyY2VzLnNwbGljZSgwKTtcbiAgUGx1Z2luSG9zdC5pbnN0YW5jZS5jcmVkZW50aWFsUHJvdmlkZXJTb3VyY2VzLnB1c2goe1xuICAgIGlzQXZhaWxhYmxlKCkge1xuICAgICAgcmV0dXJuIFByb21pc2UucmVzb2x2ZSh0cnVlKTtcbiAgICB9LFxuICAgIGNhblByb3ZpZGVDcmVkZW50aWFscyhhY2NvdW50KSB7XG4gICAgICByZXR1cm4gUHJvbWlzZS5yZXNvbHZlKGFjY291bnQgPT09IHVuaXEoJzk5OTk5JykpO1xuICAgIH0sXG4gICAgZ2V0UHJvdmlkZXIoKSB7XG4gICAgICBwbHVnaW5RdWVyaWVkID0gdHJ1ZTtcbiAgICAgIHJldHVybiBQcm9taXNlLnJlc29sdmUoe1xuICAgICAgICBhY2Nlc3NLZXlJZDogYCR7dWlkfXBsdWdpbl9rZXlgLFxuICAgICAgICBzZWNyZXRBY2Nlc3NLZXk6ICdwbHVnaW5fc2VjcmV0JyxcbiAgICAgICAgc2Vzc2lvblRva2VuOiAncGx1Z2luX3Rva2VuJyxcbiAgICAgIH0pO1xuICAgIH0sXG4gICAgbmFtZTogJ3Rlc3QgcGx1Z2luJyxcbiAgfSk7XG5cbiAgLy8gTWFrZSBzdXJlIHRoZXNlIHBvaW50IHRvIG5vbmV4aXN0YW50IGZpbGVzIHRvIHN0YXJ0LCBpZiB3ZSBkb24ndCBjYWxsXG4gIC8vIHByZXBhcmUoKSB0aGVuIHdlIGRvbid0IGFjY2lkZW50YWxseSB3YW50IHRvIGZhbGwgYmFjayB0byBzeXN0ZW0gY29uZmlnLlxuICBwcm9jZXNzLmVudi5BV1NfQ09ORklHX0ZJTEUgPSAnL2Rldi9udWxsJztcbiAgcHJvY2Vzcy5lbnYuQVdTX1NIQVJFRF9DUkVERU5USUFMU19GSUxFID0gJy9kZXYvbnVsbCc7XG5cbiAgcmVzdG9yZVNka01vY2tzVG9EZWZhdWx0KCk7XG59KTtcblxuYWZ0ZXJFYWNoKCgpID0+IHtcbiAgYm9ja2ZzLnJlc3RvcmUoKTtcbiAgamVzdC5yZXN0b3JlQWxsTW9ja3MoKTtcbn0pO1xuXG5mdW5jdGlvbiB1bmlxKGFjY291bnQ6IHN0cmluZykge1xuICByZXR1cm4gYCR7dWlkfSR7YWNjb3VudH1gO1xufVxuXG5mdW5jdGlvbiBlbnYoYWNjb3VudDogc3RyaW5nKSB7XG4gIHJldHVybiBjeGFwaS5FbnZpcm9ubWVudFV0aWxzLm1ha2UoYWNjb3VudCwgJ2RlZicpO1xufVxuXG5kZXNjcmliZSgnd2l0aCBpbnRlcmNlcHRlZCBuZXR3b3JrIGNhbGxzJywgKCkgPT4ge1xuICAvLyBNb3N0IHRlc3RzIHdpbGwgdXNlIGludGVyY2VwdGVkIG5ldHdvcmsgY2FsbHMsIGV4Y2VwdCBvbmUgdGVzdCB0aGF0IHRlc3RzXG4gIC8vIHRoYXQgdGhlIHJpZ2h0IEhUVFAgYEFnZW50YCBpcyB1c2VkLlxuXG4gIGxldCBmYWtlU3RzOiBGYWtlU3RzO1xuICBiZWZvcmVFYWNoKCgpID0+IHtcbiAgICBmYWtlU3RzID0gbmV3IEZha2VTdHMoKTtcbiAgICBmYWtlU3RzLmJlZ2luKCk7XG5cbiAgICAvLyBNYWtlIHN1cmUgdGhlIEtleUlEIHJldHVybmVkIGJ5IHRoZSBwbHVnaW4gaXMgcmVjb2duaXplZFxuICAgIGZha2VTdHMucmVnaXN0ZXJVc2VyKHVuaXEoJzk5OTk5JyksIHVuaXEoJ3BsdWdpbl9rZXknKSk7XG4gICAgbW9ja1JlcXVlc3QgPSBqZXN0LmZuKCkubW9ja1Jlc29sdmVkVmFsdWUoSlNPTi5zdHJpbmdpZnkoeyByZWdpb246IHVuZGVmaW5lZCB9KSk7XG4gIH0pO1xuXG4gIGFmdGVyRWFjaCgoKSA9PiB7XG4gICAgZmFrZVN0cy5yZXN0b3JlKCk7XG4gIH0pO1xuXG4gIC8vIFNldCBvZiB0ZXN0cyB3aGVyZSB0aGUgQ0RLIHdpbGwgbm90IHRyaWdnZXIgYXNzdW1lLXJvbGVcbiAgLy8gKHRoZSBJTkkgZmlsZSBtaWdodCBzdGlsbCBkbyBhc3N1bWUtcm9sZSlcbiAgZGVzY3JpYmUoJ3doZW4gQ0RLIGRvZXMgbm90IEFzc3VtZVJvbGUnLCAoKSA9PiB7XG4gICAgdGVzdCgndXNlcyBkZWZhdWx0IGNyZWRlbnRpYWxzIGJ5IGRlZmF1bHQnLCBhc3luYyAoKSA9PiB7XG4gICAgICAvLyBXSEVOXG4gICAgICBjb25zdCBhY2NvdW50ID0gdW5pcSgnMTExMTEnKTtcbiAgICAgIG1vY2tTVFNDbGllbnQub24oR2V0Q2FsbGVySWRlbnRpdHlDb21tYW5kKS5yZXNvbHZlcyh7XG4gICAgICAgIEFjY291bnQ6IGFjY291bnQsXG4gICAgICAgIEFybjogJ2Fybjphd3MtaGVyZScsXG4gICAgICB9KTtcbiAgICAgIHByZXBhcmVDcmVkcyh7XG4gICAgICAgIGNyZWRlbnRpYWxzOiB7XG4gICAgICAgICAgZGVmYXVsdDogeyBhd3NfYWNjZXNzX2tleV9pZDogJ2FjY2VzcycsICRhY2NvdW50OiAnMTExMTEnLCAkZmFrZVN0c09wdGlvbnM6IHsgcGFydGl0aW9uOiAnYXdzLWhlcmUnIH0gfSxcbiAgICAgICAgfSxcbiAgICAgICAgY29uZmlnOiB7XG4gICAgICAgICAgZGVmYXVsdDogeyByZWdpb246ICdldS1ibGEtNScgfSxcbiAgICAgICAgfSxcbiAgICAgIH0pO1xuICAgICAgY29uc3QgcHJvdmlkZXIgPSBhd2FpdCBwcm92aWRlckZyb21Qcm9maWxlKHVuZGVmaW5lZCk7XG5cbiAgICAgIC8vIFRIRU5cbiAgICAgIGV4cGVjdChwcm92aWRlci5kZWZhdWx0UmVnaW9uKS50b0VxdWFsKCdldS1ibGEtNScpO1xuICAgICAgYXdhaXQgZXhwZWN0KHByb3ZpZGVyLmRlZmF1bHRBY2NvdW50KCkpLnJlc29sdmVzLnRvRXF1YWwoeyBhY2NvdW50SWQ6IGFjY291bnQsIHBhcnRpdGlvbjogJ2F3cy1oZXJlJyB9KTtcblxuICAgICAgLy8gQXNrIGZvciBhIGRpZmZlcmVudCByZWdpb25cbiAgICAgIGNvbnN0IHNkayA9IChhd2FpdCBwcm92aWRlci5mb3JFbnZpcm9ubWVudCh7IC4uLmVudihhY2NvdW50KSwgcmVnaW9uOiAncmduJyB9LCBNb2RlLkZvclJlYWRpbmcpKS5zZGs7XG4gICAgICBleHBlY3Qoc2RrQ29uZmlnKHNkaykuY3JlZGVudGlhbHMhLmFjY2Vzc0tleUlkKS50b0VxdWFsKHVuaXEoJ2FjY2VzcycpKTtcbiAgICAgIGV4cGVjdChzZGsuY3VycmVudFJlZ2lvbikudG9FcXVhbCgncmduJyk7XG4gICAgfSk7XG5cbiAgICB0ZXN0KCd0aHJvd3MgaWYgbm8gY3JlZGVudGlhbHMgY291bGQgYmUgZm91bmQnLCBhc3luYyAoKSA9PiB7XG4gICAgICBjb25zdCBhY2NvdW50ID0gdW5pcSgnMTExMTEnKTtcbiAgICAgIGNvbnN0IHByb3ZpZGVyID0gYXdhaXQgcHJvdmlkZXJGcm9tUHJvZmlsZSh1bmRlZmluZWQpO1xuICAgICAgYXdhaXQgZXhwZWN0KChwcm92aWRlci5mb3JFbnZpcm9ubWVudCh7IC4uLmVudihhY2NvdW50KSwgcmVnaW9uOiAncmduJyB9LCBNb2RlLkZvclJlYWRpbmcpKSlcbiAgICAgICAgLnJlamVjdHNcbiAgICAgICAgLnRvVGhyb3coL05lZWQgdG8gcGVyZm9ybSBBV1MgY2FsbHMgZm9yIGFjY291bnQgLiosIGJ1dCBubyBjcmVkZW50aWFscyBoYXZlIGJlZW4gY29uZmlndXJlZCwgYW5kIG5vbmUgb2YgdGhlc2UgcGx1Z2lucyBmb3VuZCBhbnkvKTtcbiAgICB9KTtcblxuICAgIHRlc3QoJ25vIGJhc2UgY3JlZGVudGlhbHMgcGFydGl0aW9uIGlmIHRva2VuIGlzIGV4cGlyZWQnLCBhc3luYyAoKSA9PiB7XG4gICAgICBjb25zdCBhY2NvdW50ID0gdW5pcSgnMTExMTEnKTtcbiAgICAgIGNvbnN0IGVycm9yID0gbmV3IEVycm9yKCdFeHBpcmVkIFRva2VuJyk7XG4gICAgICBlcnJvci5uYW1lID0gJ0V4cGlyZWRUb2tlbic7XG4gICAgICBjb25zdCBpZGVudGl0eVByb3ZpZGVyID0gKCkgPT4gUHJvbWlzZS5yZWplY3QoZXJyb3IpO1xuICAgICAgY29uc3QgcHJvdmlkZXIgPSBuZXcgU2RrUHJvdmlkZXIoaWRlbnRpdHlQcm92aWRlciwgJ3JnbicpO1xuICAgICAgY29uc3QgY3JlZHMgPSBhd2FpdCBwcm92aWRlci5iYXNlQ3JlZGVudGlhbHNQYXJ0aXRpb24oeyAuLi5lbnYoYWNjb3VudCksIHJlZ2lvbjogJ3JnbicgfSwgTW9kZS5Gb3JSZWFkaW5nKTtcblxuICAgICAgZXhwZWN0KGNyZWRzKS50b0JlVW5kZWZpbmVkKCk7XG4gICAgfSk7XG5cbiAgICB0ZXN0KCd0aHJvd3MgaWYgcHJvZmlsZSBjcmVkZW50aWFscyBhcmUgbm90IGZvciB0aGUgcmlnaHQgYWNjb3VudCcsIGFzeW5jICgpID0+IHtcbiAgICAgIC8vIFdIRU5cbiAgICAgIGplc3Quc3B5T24oQXdzQ2xpQ29tcGF0aWJsZSwgJ3JlZ2lvbicpLm1vY2tSZXNvbHZlZFZhbHVlKCd1cy1lYXN0LTEyMycpO1xuICAgICAgcHJlcGFyZUNyZWRzKHtcbiAgICAgICAgZmFrZVN0cyxcbiAgICAgICAgY29uZmlnOiB7XG4gICAgICAgICAgJ3Byb2ZpbGUgYm9vJzogeyBhd3NfYWNjZXNzX2tleV9pZDogJ2FjY2VzcycsICRhY2NvdW50OiAnMTExMTEnIH0sXG4gICAgICAgIH0sXG4gICAgICB9KTtcbiAgICAgIGNvbnN0IHByb3ZpZGVyID0gYXdhaXQgcHJvdmlkZXJGcm9tUHJvZmlsZSgnYm9vJyk7XG5cbiAgICAgIGF3YWl0IGV4cGVjdChwcm92aWRlci5mb3JFbnZpcm9ubWVudChlbnYodW5pcSgnc29tZV9hY2NvdW50XyMnKSksIE1vZGUuRm9yUmVhZGluZykpLnJlamVjdHMudG9UaHJvdyhcbiAgICAgICAgJ05lZWQgdG8gcGVyZm9ybSBBV1MgY2FsbHMnLFxuICAgICAgKTtcbiAgICB9KTtcblxuICAgIHRlc3QoJ3VzZSBwcm9maWxlIGFjY3QvcmVnaW9uIGlmIGFnbm9zdGljIGVudiByZXF1ZXN0ZWQnLCBhc3luYyAoKSA9PiB7XG4gICAgICAvLyBXSEVOXG4gICAgICBwcmVwYXJlQ3JlZHMoe1xuICAgICAgICBmYWtlU3RzLFxuICAgICAgICBjcmVkZW50aWFsczoge1xuICAgICAgICAgIGRlZmF1bHQ6IHsgYXdzX2FjY2Vzc19rZXlfaWQ6ICdhY2Nlc3MnLCAkYWNjb3VudDogJzExMTExJyB9LFxuICAgICAgICB9LFxuICAgICAgICBjb25maWc6IHtcbiAgICAgICAgICBkZWZhdWx0OiB7IHJlZ2lvbjogJ2V1LWJsYS01JyB9LFxuICAgICAgICB9LFxuICAgICAgfSk7XG4gICAgICBjb25zdCBwcm92aWRlciA9IGF3YWl0IHByb3ZpZGVyRnJvbVByb2ZpbGUodW5kZWZpbmVkKTtcblxuICAgICAgLy8gVEhFTlxuICAgICAgY29uc3Qgc2RrID0gKFxuICAgICAgICBhd2FpdCBwcm92aWRlci5mb3JFbnZpcm9ubWVudChcbiAgICAgICAgICBjeGFwaS5FbnZpcm9ubWVudFV0aWxzLm1ha2UoY3hhcGkuVU5LTk9XTl9BQ0NPVU5ULCBjeGFwaS5VTktOT1dOX1JFR0lPTiksXG4gICAgICAgICAgTW9kZS5Gb3JSZWFkaW5nLFxuICAgICAgICApXG4gICAgICApLnNkaztcbiAgICAgIGV4cGVjdChzZGtDb25maWcoc2RrKS5jcmVkZW50aWFscyEuYWNjZXNzS2V5SWQpLnRvRXF1YWwodW5pcSgnYWNjZXNzJykpO1xuICAgICAgZXhwZWN0KChhd2FpdCBzZGsuY3VycmVudEFjY291bnQoKSkuYWNjb3VudElkKS50b0VxdWFsKHVuaXEoJzExMTExJykpO1xuICAgICAgZXhwZWN0KHNkay5jdXJyZW50UmVnaW9uKS50b0VxdWFsKCdldS1ibGEtNScpO1xuICAgIH0pO1xuXG4gICAgdGVzdCgncGFzc2luZyBwcm9maWxlIHNraXBzIEVudmlyb25tZW50Q3JlZGVudGlhbHMnLCBhc3luYyAoKSA9PiB7XG4gICAgICAvLyBHSVZFTlxuICAgICAgY29uc3QgY2FsbHMgPSBqZXN0LnNweU9uKGNvbnNvbGUsICdkZWJ1ZycpO1xuICAgICAgcHJlcGFyZUNyZWRzKHtcbiAgICAgICAgZmFrZVN0cyxcbiAgICAgICAgY3JlZGVudGlhbHM6IHtcbiAgICAgICAgICBmb286IHsgYXdzX2FjY2Vzc19rZXlfaWQ6ICdhY2Nlc3MnLCAkYWNjb3VudDogJzExMTExJyB9LFxuICAgICAgICB9LFxuICAgICAgfSk7XG4gICAgICBjb25zdCBwcm92aWRlciA9IGF3YWl0IHByb3ZpZGVyRnJvbVByb2ZpbGUoJ2ZvbycpO1xuICAgICAgYXdhaXQgcHJvdmlkZXIuZGVmYXVsdEFjY291bnQoKTtcbiAgICAgIC8vIE9ubHkgY3JlZGVudGlhbC1wcm92aWRlci1pbmkgaXMgdXNlZC5cbiAgICAgIGV4cGVjdChjYWxscykudG9IYXZlQmVlbkNhbGxlZFRpbWVzKDIpO1xuICAgICAgZXhwZWN0KGNhbGxzLm1vY2suY2FsbHNbMF0pLnRvRXF1YWwoWydAYXdzLXNkay9jcmVkZW50aWFsLXByb3ZpZGVyLWluaSAtIGZyb21JbmknXSk7XG4gICAgICBleHBlY3QoY2FsbHMubW9jay5jYWxsc1sxXSkudG9FcXVhbChbJ0Bhd3Mtc2RrL2NyZWRlbnRpYWwtcHJvdmlkZXItaW5pIC0gcmVzb2x2ZVN0YXRpY0NyZWRlbnRpYWxzJ10pO1xuICAgIH0pO1xuXG4gICAgdGVzdCgnc3VwcG9ydHMgcHJvZmlsZSBzcHJlYWQgb3ZlciBjb25maWdfZmlsZSBhbmQgY3JlZGVudGlhbHNfZmlsZScsIGFzeW5jICgpID0+IHtcbiAgICAgIC8vIFdIRU5cbiAgICAgIHByZXBhcmVDcmVkcyh7XG4gICAgICAgIGZha2VTdHMsXG4gICAgICAgIGNyZWRlbnRpYWxzOiB7XG4gICAgICAgICAgZm9vOiB7IGF3c19hY2Nlc3Nfa2V5X2lkOiAnZm9vY2Nlc3MnLCAkYWNjb3VudDogJzIyMjIyJyB9LFxuICAgICAgICB9LFxuICAgICAgICBjb25maWc6IHtcbiAgICAgICAgICAnZGVmYXVsdCc6IHsgcmVnaW9uOiAnZXUtYmxhLTUnIH0sXG4gICAgICAgICAgJ3Byb2ZpbGUgZm9vJzogeyByZWdpb246ICdldS13ZXN0LTEnIH0sXG4gICAgICAgIH0sXG4gICAgICB9KTtcbiAgICAgIGNvbnN0IHByb3ZpZGVyID0gYXdhaXQgcHJvdmlkZXJGcm9tUHJvZmlsZSgnZm9vJyk7XG5cbiAgICAgIC8vIFRIRU5cbiAgICAgIGV4cGVjdChwcm92aWRlci5kZWZhdWx0UmVnaW9uKS50b0VxdWFsKCdldS13ZXN0LTEnKTtcbiAgICAgIGF3YWl0IGV4cGVjdChwcm92aWRlci5kZWZhdWx0QWNjb3VudCgpKS5yZXNvbHZlcy50b0VxdWFsKHsgYWNjb3VudElkOiB1bmlxKCcyMjIyMicpLCBwYXJ0aXRpb246ICdhd3MnIH0pO1xuXG4gICAgICBjb25zdCBzZGsgPSAoYXdhaXQgcHJvdmlkZXIuZm9yRW52aXJvbm1lbnQoZW52KHVuaXEoJzIyMjIyJykpLCBNb2RlLkZvclJlYWRpbmcpKS5zZGs7XG4gICAgICBleHBlY3Qoc2RrQ29uZmlnKHNkaykuY3JlZGVudGlhbHMhLmFjY2Vzc0tleUlkKS50b0VxdWFsKHVuaXEoJ2Zvb2NjZXNzJykpO1xuICAgIH0pO1xuXG4gICAgdGVzdCgnc3VwcG9ydHMgcHJvZmlsZSBvbmx5IGluIGNvbmZpZ19maWxlJywgYXN5bmMgKCkgPT4ge1xuICAgICAgLy8gV0hFTlxuICAgICAgcHJlcGFyZUNyZWRzKHtcbiAgICAgICAgZmFrZVN0cyxcbiAgICAgICAgY29uZmlnOiB7XG4gICAgICAgICAgJ2RlZmF1bHQnOiB7IHJlZ2lvbjogJ2V1LWJsYS01JyB9LFxuICAgICAgICAgICdwcm9maWxlIGZvbyc6IHsgYXdzX2FjY2Vzc19rZXlfaWQ6ICdmb29jY2VzcycsICRhY2NvdW50OiAnMjIyMjInIH0sXG4gICAgICAgIH0sXG4gICAgICB9KTtcbiAgICAgIGNvbnN0IHByb3ZpZGVyID0gYXdhaXQgcHJvdmlkZXJGcm9tUHJvZmlsZSgnZm9vJyk7XG5cbiAgICAgIC8vIFRIRU5cbiAgICAgIGV4cGVjdChwcm92aWRlci5kZWZhdWx0UmVnaW9uKS50b0VxdWFsKCdldS1ibGEtNScpOyAvLyBGYWxsIGJhY2sgdG8gZGVmYXVsdCBjb25maWdcbiAgICAgIGF3YWl0IGV4cGVjdChwcm92aWRlci5kZWZhdWx0QWNjb3VudCgpKS5yZXNvbHZlcy50b0VxdWFsKHsgYWNjb3VudElkOiB1bmlxKCcyMjIyMicpLCBwYXJ0aXRpb246ICdhd3MnIH0pO1xuXG4gICAgICBjb25zdCBzZGsgPSAoYXdhaXQgcHJvdmlkZXIuZm9yRW52aXJvbm1lbnQoZW52KHVuaXEoJzIyMjIyJykpLCBNb2RlLkZvclJlYWRpbmcpKS5zZGs7XG4gICAgICBleHBlY3Qoc2RrQ29uZmlnKHNkaykuY3JlZGVudGlhbHMhLmFjY2Vzc0tleUlkKS50b0VxdWFsKHVuaXEoJ2Zvb2NjZXNzJykpO1xuICAgIH0pO1xuXG4gICAgdGVzdCgnY2FuIGFzc3VtZS1yb2xlIGNvbmZpZ3VyZWQgaW4gY29uZmlnJywgYXN5bmMgKCkgPT4ge1xuICAgICAgLy8gR0lWRU5cbiAgICAgIGplc3Quc3B5T24oY29uc29sZSwgJ2RlYnVnJyk7XG4gICAgICBwcmVwYXJlQ3JlZHMoe1xuICAgICAgICBmYWtlU3RzLFxuICAgICAgICBjcmVkZW50aWFsczoge1xuICAgICAgICAgIGFzc3VtZXI6IHsgYXdzX2FjY2Vzc19rZXlfaWQ6ICdhc3N1bWVyJywgJGFjY291bnQ6ICcxMTExMScgfSxcbiAgICAgICAgfSxcbiAgICAgICAgY29uZmlnOiB7XG4gICAgICAgICAgJ2RlZmF1bHQnOiB7IHJlZ2lvbjogJ2V1LWJsYS01JyB9LFxuICAgICAgICAgICdwcm9maWxlIGFzc3VtZXInOiB7IHJlZ2lvbjogJ3VzLWVhc3QtMicgfSxcbiAgICAgICAgICAncHJvZmlsZSBhc3N1bWFibGUnOiB7XG4gICAgICAgICAgICByb2xlX2FybjogJ2Fybjphd3M6aWFtOjo2NjY2Njpyb2xlL0Fzc3VtYWJsZScsXG4gICAgICAgICAgICBzb3VyY2VfcHJvZmlsZTogJ2Fzc3VtZXInLFxuICAgICAgICAgICAgJGFjY291bnQ6ICc2NjY2NicsXG4gICAgICAgICAgICAkZmFrZVN0c09wdGlvbnM6IHsgYWxsb3dlZEFjY291bnRzOiBbJzExMTExJ10gfSxcbiAgICAgICAgICB9LFxuICAgICAgICB9LFxuICAgICAgfSk7XG4gICAgICBjb25zdCBwcm92aWRlciA9IGF3YWl0IHByb3ZpZGVyRnJvbVByb2ZpbGUoJ2Fzc3VtYWJsZScpO1xuXG4gICAgICAvLyBXSEVOXG4gICAgICBjb25zdCBzZGsgPSAoYXdhaXQgcHJvdmlkZXIuZm9yRW52aXJvbm1lbnQoZW52KHVuaXEoJzY2NjY2JykpLCBNb2RlLkZvclJlYWRpbmcpKS5zZGs7XG5cbiAgICAgIC8vIFRIRU5cbiAgICAgIGV4cGVjdCgoYXdhaXQgc2RrLmN1cnJlbnRBY2NvdW50KCkpLmFjY291bnRJZCkudG9FcXVhbCh1bmlxKCc2NjY2NicpKTtcbiAgICB9KTtcblxuICAgIHRlc3QoJ2NhbiBhc3N1bWUgcm9sZSBldmVuIGlmIFtkZWZhdWx0XSBwcm9maWxlIGlzIG1pc3NpbmcnLCBhc3luYyAoKSA9PiB7XG4gICAgICAvLyBHSVZFTlxuICAgICAgcHJlcGFyZUNyZWRzKHtcbiAgICAgICAgZmFrZVN0cyxcbiAgICAgICAgY3JlZGVudGlhbHM6IHtcbiAgICAgICAgICBhc3N1bWVyOiB7IGF3c19hY2Nlc3Nfa2V5X2lkOiAnYXNzdW1lcicsICRhY2NvdW50OiAnMjIyMjInIH0sXG4gICAgICAgICAgYXNzdW1hYmxlOiB7XG4gICAgICAgICAgICByb2xlX2FybjogJ2Fybjphd3M6aWFtOjoxMjM1Njc4OTAxMjpyb2xlL0Fzc3VtYWJsZScsXG4gICAgICAgICAgICBzb3VyY2VfcHJvZmlsZTogJ2Fzc3VtZXInLFxuICAgICAgICAgICAgJGFjY291bnQ6ICcyMjIyMicsXG4gICAgICAgICAgfSxcbiAgICAgICAgfSxcbiAgICAgICAgY29uZmlnOiB7XG4gICAgICAgICAgJ3Byb2ZpbGUgYXNzdW1hYmxlJzogeyByZWdpb246ICdldS1ibGEtNScgfSxcbiAgICAgICAgfSxcbiAgICAgIH0pO1xuXG4gICAgICAvLyBXSEVOXG4gICAgICBjb25zdCBwcm92aWRlciA9IGF3YWl0IHByb3ZpZGVyRnJvbVByb2ZpbGUoJ2Fzc3VtYWJsZScpO1xuXG4gICAgICAvLyBUSEVOXG4gICAgICBleHBlY3QoKGF3YWl0IHByb3ZpZGVyLmRlZmF1bHRBY2NvdW50KCkpPy5hY2NvdW50SWQpLnRvRXF1YWwodW5pcSgnMjIyMjInKSk7XG4gICAgfSk7XG5cbiAgICB0ZXN0KCdtZmFfc2VyaWFsIGluIHByb2ZpbGUgd2lsbCBhc2sgdXNlciBmb3IgdG9rZW4nLCBhc3luYyAoKSA9PiB7XG4gICAgICAvLyBHSVZFTlxuICAgICAgcHJlcGFyZUNyZWRzKHtcbiAgICAgICAgZmFrZVN0cyxcbiAgICAgICAgY3JlZGVudGlhbHM6IHtcbiAgICAgICAgICBhc3N1bWVyOiB7IGF3c19hY2Nlc3Nfa2V5X2lkOiAnYXNzdW1lcicsICRhY2NvdW50OiAnNjY2NjYnIH0sXG4gICAgICAgIH0sXG4gICAgICAgIGNvbmZpZzoge1xuICAgICAgICAgICdkZWZhdWx0JzogeyByZWdpb246ICdldS1ibGEtNScgfSxcbiAgICAgICAgICAncHJvZmlsZSBhc3N1bWVyJzogeyByZWdpb246ICd1cy1lYXN0LTInIH0sXG4gICAgICAgICAgJ3Byb2ZpbGUgbWZhLXJvbGUnOiB7XG4gICAgICAgICAgICByb2xlX2FybjogJ2Fybjphd3M6aWFtOjo2NjY2Njpyb2xlL0Fzc3VtYWJsZScsXG4gICAgICAgICAgICBzb3VyY2VfcHJvZmlsZTogJ2Fzc3VtZXInLFxuICAgICAgICAgICAgbWZhX3NlcmlhbDogJ2Fybjphd3M6aWFtOjphY2NvdW50Om1mYS91c2VyJyxcbiAgICAgICAgICAgICRhY2NvdW50OiAnNjY2NjYnLFxuICAgICAgICAgIH0sXG4gICAgICAgIH0sXG4gICAgICB9KTtcbiAgICAgIGNvbnN0IHByb3ZpZGVyID0gYXdhaXQgcHJvdmlkZXJGcm9tUHJvZmlsZSgnbWZhLXJvbGUnKTtcblxuICAgICAgY29uc3QgcHJvbXB0bHlNb2NrQ2FsbHMgPSAocHJvbXB0bHkucHJvbXB0IGFzIGplc3QuTW9jaykubW9jay5jYWxscy5sZW5ndGg7XG5cbiAgICAgIC8vIFRIRU5cbiAgICAgIGNvbnN0IHNkayA9IChhd2FpdCBwcm92aWRlci5mb3JFbnZpcm9ubWVudChlbnYodW5pcSgnNjY2NjYnKSksIE1vZGUuRm9yUmVhZGluZykpLnNkaztcbiAgICAgIGV4cGVjdCgoYXdhaXQgc2RrLmN1cnJlbnRBY2NvdW50KCkpLmFjY291bnRJZCkudG9FcXVhbCh1bmlxKCc2NjY2NicpKTtcbiAgICAgIGV4cGVjdChtb2NrU1RTQ2xpZW50KS50b0hhdmVSZWNlaXZlZENvbW1hbmRXaXRoKEFzc3VtZVJvbGVDb21tYW5kLCB7XG4gICAgICAgIFJvbGVBcm46ICdhcm46YXdzOmlhbTo6NjY2NjY6cm9sZS9Bc3N1bWFibGUnLFxuICAgICAgICBTZXJpYWxOdW1iZXI6ICdhcm46YXdzOmlhbTo6YWNjb3VudDptZmEvdXNlcicsXG4gICAgICAgIFRva2VuQ29kZTogJzEyMzQnLFxuICAgICAgICBSb2xlU2Vzc2lvbk5hbWU6IGV4cGVjdC5hbnl0aGluZygpLFxuICAgICAgfSk7XG5cbiAgICAgIC8vIE1vY2sgcmVzcG9uc2Ugd2FzIHNldCB0byBmYWlsIHRvIG1ha2Ugc3VyZSB3ZSBkb24ndCBjYWxsIFNUU1xuICAgICAgLy8gTWFrZSBzdXJlIHRoZSBNRkEgbW9jayB3YXMgY2FsbGVkIGR1cmluZyB0aGlzIHRlc3RcbiAgICAgIGV4cGVjdCgocHJvbXB0bHkucHJvbXB0IGFzIGplc3QuTW9jaykubW9jay5jYWxscy5sZW5ndGgpLnRvQmUocHJvbXB0bHlNb2NrQ2FsbHMgKyAxKTtcbiAgICB9KTtcbiAgfSk7XG5cbiAgLy8gRm9yIERlZmF1bHRTeW50aGVzaXMgd2Ugd2lsbCBkbyBhbiBhc3N1bWUtcm9sZSBhZnRlciBoYXZpbmcgZ290dGVuIGJhc2UgY3JlZGVudGlhbHNcbiAgZGVzY3JpYmUoJ3doZW4gQ0RLIEFzc3VtZVJvbGVzJywgKCkgPT4ge1xuICAgIGJlZm9yZUVhY2goKCkgPT4ge1xuICAgICAgLy8gQWxsIHRoZXNlIHRlc3RzIHNoYXJlIHRoYXQgJ2Fybjphd3M6cm9sZScgaXMgYSByb2xlIGludG8gYWNjb3VudCA4ODg4OCB3aGljaCBjYW4gYmUgYXNzdW1lZCBmcm9tIDExMTExXG4gICAgICBmYWtlU3RzLnJlZ2lzdGVyUm9sZSh1bmlxKCc4ODg4OCcpLCAnYXJuOmF3czpyb2xlJywgeyBhbGxvd2VkQWNjb3VudHM6IFt1bmlxKCcxMTExMScpXSB9KTtcbiAgICB9KTtcblxuICAgIHRlc3QoJ2Vycm9yIHdlIGdldCBmcm9tIGFzc3VtaW5nIGEgcm9sZSBpcyB1c2VmdWwnLCBhc3luYyAoKSA9PiB7XG4gICAgICAvLyBHSVZFTlxuICAgICAgcHJlcGFyZUNyZWRzKHtcbiAgICAgICAgZmFrZVN0cyxcbiAgICAgICAgY29uZmlnOiB7XG4gICAgICAgICAgZGVmYXVsdDogeyBhd3NfYWNjZXNzX2tleV9pZDogJ2ZvbycgfSxcbiAgICAgICAgfSxcbiAgICAgIH0pO1xuICAgICAgbW9ja1NUU0NsaWVudC5vbihBc3N1bWVSb2xlQ29tbWFuZCkucmVqZWN0c09uY2UoJ2RvZXNub3RleGlzdC5yb2xlLmFybicpO1xuICAgICAgY29uc3QgcHJvdmlkZXIgPSBhd2FpdCBwcm92aWRlckZyb21Qcm9maWxlKHVuZGVmaW5lZCk7XG5cbiAgICAgIC8vIFdIRU5cbiAgICAgIGNvbnN0IHByb21pc2UgPSBwcm92aWRlci5mb3JFbnZpcm9ubWVudChlbnYodW5pcSgnODg4ODgnKSksIE1vZGUuRm9yUmVhZGluZywge1xuICAgICAgICBhc3N1bWVSb2xlQXJuOiAnZG9lc25vdGV4aXN0LnJvbGUuYXJuJyxcbiAgICAgIH0pO1xuXG4gICAgICAvLyBUSEVOIC0gZXJyb3IgbWVzc2FnZSBjb250YWlucyBib3RoIGEgaGVscGZ1bCBoaW50IGFuZCB0aGUgdW5kZXJseWluZyBBc3N1bWVSb2xlIG1lc3NhZ2VcbiAgICAgIGF3YWl0IGV4cGVjdChwcm9taXNlKS5yZWplY3RzLnRvVGhyb3coJyhyZSktYm9vdHN0cmFwIHRoZSBlbnZpcm9ubWVudCcpO1xuICAgICAgYXdhaXQgZXhwZWN0KHByb21pc2UpLnJlamVjdHMudG9UaHJvdygnZG9lc25vdGV4aXN0LnJvbGUuYXJuJyk7XG4gICAgfSk7XG5cbiAgICB0ZXN0KCdhc3N1bWluZyBhIHJvbGUgc2FuaXRpemVzIHRoZSB1c2VybmFtZSBpbnRvIHRoZSBzZXNzaW9uIG5hbWUnLCBhc3luYyAoKSA9PiB7XG4gICAgICAvLyBHSVZFTlxuICAgICAgcHJlcGFyZUNyZWRzKHtcbiAgICAgICAgLy8gZmFrZVN0cyxcbiAgICAgICAgY29uZmlnOiB7XG4gICAgICAgICAgZGVmYXVsdDogeyBhd3NfYWNjZXNzX2tleV9pZDogJ2ZvbycsICRhY2NvdW50OiAnMTExMTEnIH0sXG4gICAgICAgIH0sXG4gICAgICB9KTtcblxuICAgICAgYXdhaXQgd2l0aE1vY2tlZChvcywgJ3VzZXJJbmZvJywgYXN5bmMgKHVzZXJJbmZvKSA9PiB7XG4gICAgICAgIHVzZXJJbmZvLm1vY2tSZXR1cm5WYWx1ZSh7IHVzZXJuYW1lOiAnc2vDpWwnLCB1aWQ6IDEsIGdpZDogMSwgaG9tZWRpcjogJy9oZXJlJywgc2hlbGw6ICcvYmluL3NoJyB9KTtcblxuICAgICAgICAvLyBXSEVOXG4gICAgICAgIGNvbnN0IHByb3ZpZGVyID0gYXdhaXQgcHJvdmlkZXJGcm9tUHJvZmlsZSh1bmRlZmluZWQpO1xuXG4gICAgICAgIGNvbnN0IHNkayA9IChcbiAgICAgICAgICBhd2FpdCBwcm92aWRlci5mb3JFbnZpcm9ubWVudChlbnYodW5pcSgnODg4ODgnKSksIE1vZGUuRm9yUmVhZGluZywgeyBhc3N1bWVSb2xlQXJuOiAnYXJuOmF3czpyb2xlJyB9KVxuICAgICAgICApLnNkayBhcyBTREs7XG4gICAgICAgIGF3YWl0IHNkay5jdXJyZW50QWNjb3VudCgpO1xuXG4gICAgICAgIC8vIFRIRU5cbiAgICAgICAgZXhwZWN0KG1vY2tTVFNDbGllbnQpLnRvSGF2ZVJlY2VpdmVkQ29tbWFuZFdpdGgoQXNzdW1lUm9sZUNvbW1hbmQsIHtcbiAgICAgICAgICBSb2xlQXJuOiAnYXJuOmF3czpyb2xlJyxcbiAgICAgICAgICBSb2xlU2Vzc2lvbk5hbWU6ICdhd3MtY2RrLXNrQGwnLFxuICAgICAgICB9KTtcbiAgICAgIH0pO1xuICAgIH0pO1xuXG4gICAgdGVzdCgnc2Vzc2lvbiB0YWdzIGNhbiBiZSBwYXNzZWQgd2hlbiBhc3N1bWluZyBhIHJvbGUnLCBhc3luYyAoKSA9PiB7XG4gICAgICAvLyBHSVZFTlxuICAgICAgcHJlcGFyZUNyZWRzKHtcbiAgICAgICAgZmFrZVN0cyxcbiAgICAgICAgY29uZmlnOiB7XG4gICAgICAgICAgZGVmYXVsdDogeyBhd3NfYWNjZXNzX2tleV9pZDogJ2ZvbycsICRhY2NvdW50OiAnMTExMTEnIH0sXG4gICAgICAgIH0sXG4gICAgICB9KTtcblxuICAgICAgYXdhaXQgd2l0aE1vY2tlZChvcywgJ3VzZXJJbmZvJywgYXN5bmMgKHVzZXJJbmZvKSA9PiB7XG4gICAgICAgIHVzZXJJbmZvLm1vY2tSZXR1cm5WYWx1ZSh7IHVzZXJuYW1lOiAnc2vDpWwnLCB1aWQ6IDEsIGdpZDogMSwgaG9tZWRpcjogJy9oZXJlJywgc2hlbGw6ICcvYmluL3NoJyB9KTtcblxuICAgICAgICAvLyBXSEVOXG4gICAgICAgIGNvbnN0IHByb3ZpZGVyID0gYXdhaXQgcHJvdmlkZXJGcm9tUHJvZmlsZSh1bmRlZmluZWQpO1xuXG4gICAgICAgIGNvbnN0IHNkayA9IChcbiAgICAgICAgICBhd2FpdCBwcm92aWRlci5mb3JFbnZpcm9ubWVudChlbnYodW5pcSgnODg4ODgnKSksIE1vZGUuRm9yUmVhZGluZywge1xuICAgICAgICAgICAgYXNzdW1lUm9sZUFybjogJ2Fybjphd3M6cm9sZScsXG4gICAgICAgICAgICBhc3N1bWVSb2xlRXh0ZXJuYWxJZDogJ2JydWgnLFxuICAgICAgICAgICAgYXNzdW1lUm9sZUFkZGl0aW9uYWxPcHRpb25zOiB7XG4gICAgICAgICAgICAgIFRhZ3M6IFt7IEtleTogJ0RlcGFydG1lbnQnLCBWYWx1ZTogJ0VuZ2luZWVyaW5nJyB9XSxcbiAgICAgICAgICAgIH0sXG4gICAgICAgICAgfSlcbiAgICAgICAgKS5zZGsgYXMgU0RLO1xuICAgICAgICBhd2FpdCBzZGsuY3VycmVudEFjY291bnQoKTtcblxuICAgICAgICAvLyBUSEVOXG4gICAgICAgIGV4cGVjdChtb2NrU1RTQ2xpZW50KS50b0hhdmVSZWNlaXZlZENvbW1hbmRXaXRoKEFzc3VtZVJvbGVDb21tYW5kLCB7XG4gICAgICAgICAgVGFnczogW3sgS2V5OiAnRGVwYXJ0bWVudCcsIFZhbHVlOiAnRW5naW5lZXJpbmcnIH1dLFxuICAgICAgICAgIFRyYW5zaXRpdmVUYWdLZXlzOiBbJ0RlcGFydG1lbnQnXSxcbiAgICAgICAgICBSb2xlQXJuOiAnYXJuOmF3czpyb2xlJyxcbiAgICAgICAgICBFeHRlcm5hbElkOiAnYnJ1aCcsXG4gICAgICAgICAgUm9sZVNlc3Npb25OYW1lOiAnYXdzLWNkay1za0BsJyxcbiAgICAgICAgfSk7XG4gICAgICB9KTtcbiAgICB9KTtcblxuICAgIHRlc3QoJ2Fzc3VtaW5nIGEgcm9sZSBkb2VzIG5vdCBmYWlsIHdoZW4gT1MgdXNlcm5hbWUgY2Fubm90IGJlIHJlYWQnLCBhc3luYyAoKSA9PiB7XG4gICAgICAvLyBHSVZFTlxuICAgICAgcHJlcGFyZUNyZWRzKHtcbiAgICAgICAgLy8gZmFrZVN0cyxcbiAgICAgICAgY29uZmlnOiB7XG4gICAgICAgICAgZGVmYXVsdDogeyBhd3NfYWNjZXNzX2tleV9pZDogJ2ZvbycsICRhY2NvdW50OiAnMTExMTEnIH0sXG4gICAgICAgIH0sXG4gICAgICB9KTtcblxuICAgICAgYXdhaXQgd2l0aE1vY2tlZChvcywgJ3VzZXJJbmZvJywgYXN5bmMgKHVzZXJJbmZvKSA9PiB7XG4gICAgICAgIHVzZXJJbmZvLm1vY2tJbXBsZW1lbnRhdGlvbigoKSA9PiB7XG4gICAgICAgICAgLy8gU3lzdGVtRXJyb3IgdGhyb3duIGFzIGRvY3VtZW50ZWQ6IGh0dHBzOi8vbm9kZWpzLm9yZy9kb2NzL2xhdGVzdC12MTYueC9hcGkvb3MuaHRtbCNvc3VzZXJpbmZvb3B0aW9uc1xuICAgICAgICAgIHRocm93IG5ldyBFcnJvcignU3lzdGVtRXJyb3Igb24gTGludXg6IHV2X29zX2dldF9wYXNzd2QgcmV0dXJuZWQgRU5PRU5ULiBTZWUgIzE5NDAxIGlzc3VlLicpO1xuICAgICAgICB9KTtcblxuICAgICAgICAvLyBXSEVOXG4gICAgICAgIGNvbnN0IHByb3ZpZGVyID0gYXdhaXQgcHJvdmlkZXJGcm9tUHJvZmlsZSh1bmRlZmluZWQpO1xuXG4gICAgICAgIGNvbnN0IHNkayA9IChcbiAgICAgICAgICBhd2FpdCBwcm92aWRlci5mb3JFbnZpcm9ubWVudChlbnYodW5pcSgnODg4ODgnKSksIE1vZGUuRm9yUmVhZGluZywgeyBhc3N1bWVSb2xlQXJuOiAnYXJuOmF3czpyb2xlJyB9KVxuICAgICAgICApLnNkayBhcyBTREs7XG4gICAgICAgIGF3YWl0IHNkay5jdXJyZW50QWNjb3VudCgpO1xuXG4gICAgICAgIC8vIFRIRU5cbiAgICAgICAgZXhwZWN0KG1vY2tTVFNDbGllbnQpLnRvSGF2ZVJlY2VpdmVkQ29tbWFuZFdpdGgoQXNzdW1lUm9sZUNvbW1hbmQsIHtcbiAgICAgICAgICBSb2xlQXJuOiAnYXJuOmF3czpyb2xlJyxcbiAgICAgICAgICBSb2xlU2Vzc2lvbk5hbWU6ICdhd3MtY2RrLW5vbmFtZScsXG4gICAgICAgIH0pO1xuICAgICAgfSk7XG4gICAgfSk7XG5cbiAgICB0ZXN0KCdldmVuIGlmIGN1cnJlbnQgY3JlZGVudGlhbHMgYXJlIGZvciB0aGUgd3JvbmcgYWNjb3VudCwgd2Ugd2lsbCBzdGlsbCB1c2UgdGhlbSB0byBBc3N1bWVSb2xlJywgYXN5bmMgKCkgPT4ge1xuICAgICAgLy8gR0lWRU5cbiAgICAgIHByZXBhcmVDcmVkcyh7XG4gICAgICAgIC8vIGZha2VTdHMsXG4gICAgICAgIGNvbmZpZzoge1xuICAgICAgICAgIGRlZmF1bHQ6IHsgYXdzX2FjY2Vzc19rZXlfaWQ6ICdmb28nLCAkYWNjb3VudDogJzExMTExJyB9LFxuICAgICAgICB9LFxuICAgICAgfSk7XG4gICAgICBjb25zdCBwcm92aWRlciA9IGF3YWl0IHByb3ZpZGVyRnJvbVByb2ZpbGUodW5kZWZpbmVkKTtcblxuICAgICAgLy8gV0hFTlxuICAgICAgY29uc3Qgc2RrID0gKFxuICAgICAgICBhd2FpdCBwcm92aWRlci5mb3JFbnZpcm9ubWVudChlbnYodW5pcSgnODg4ODgnKSksIE1vZGUuRm9yUmVhZGluZywgeyBhc3N1bWVSb2xlQXJuOiAnYXJuOmF3czpyb2xlJyB9KVxuICAgICAgKS5zZGsgYXMgU0RLO1xuXG4gICAgICAvLyBUSEVOXG4gICAgICBleHBlY3QoKGF3YWl0IHNkay5jdXJyZW50QWNjb3VudCgpKS5hY2NvdW50SWQpLnRvRXF1YWwodW5pcSgnODg4ODgnKSk7XG4gICAgfSk7XG5cbiAgICB0ZXN0KCdpZiBBc3N1bWVSb2xlIGZhaWxzIGJ1dCBjdXJyZW50IGNyZWRlbnRpYWxzIGFyZSBmb3IgdGhlIHJpZ2h0IGFjY291bnQsIHdlIHdpbGwgc3RpbGwgdXNlIHRoZW0nLCBhc3luYyAoKSA9PiB7XG4gICAgICAvLyBHSVZFTlxuICAgICAgcHJlcGFyZUNyZWRzKHtcbiAgICAgICAgLy8gZmFrZVN0cyxcbiAgICAgICAgY29uZmlnOiB7XG4gICAgICAgICAgZGVmYXVsdDogeyBhd3NfYWNjZXNzX2tleV9pZDogJ2ZvbycsICRhY2NvdW50OiAnODg4ODgnIH0sXG4gICAgICAgIH0sXG4gICAgICB9KTtcbiAgICAgIGNvbnN0IHByb3ZpZGVyID0gYXdhaXQgcHJvdmlkZXJGcm9tUHJvZmlsZSh1bmRlZmluZWQpO1xuXG4gICAgICAvLyBXSEVOIC0gYXNzdW1lUm9sZSBmYWlscyBiZWNhdXNlIHRoZSByb2xlIGNhbiBvbmx5IGJlIGFzc3VtZWQgZnJvbSBhY2NvdW50IDExMTExXG4gICAgICBjb25zdCBzZGsgPSAoXG4gICAgICAgIGF3YWl0IHByb3ZpZGVyLmZvckVudmlyb25tZW50KGVudih1bmlxKCc4ODg4OCcpKSwgTW9kZS5Gb3JSZWFkaW5nLCB7IGFzc3VtZVJvbGVBcm46ICdhcm46YXdzOnJvbGUnIH0pXG4gICAgICApLnNkayBhcyBTREs7XG5cbiAgICAgIC8vIFRIRU5cbiAgICAgIGV4cGVjdCgoYXdhaXQgc2RrLmN1cnJlbnRBY2NvdW50KCkpLmFjY291bnRJZCkudG9FcXVhbCh1bmlxKCc4ODg4OCcpKTtcbiAgICB9KTtcblxuICAgIHRlc3QoJ2lmIEFzc3VtZVJvbGUgZmFpbHMgYmVjYXVzZSBvZiBFeHBpcmVkVG9rZW4sIHRoZW4gZmFpbCBjb21wbGV0ZWx5JywgYXN5bmMgKCkgPT4ge1xuICAgICAgLy8gR0lWRU5cbiAgICAgIHByZXBhcmVDcmVkcyh7XG4gICAgICAgIC8vIGZha2VTdHMsXG4gICAgICAgIGNvbmZpZzoge1xuICAgICAgICAgIGRlZmF1bHQ6IHsgYXdzX2FjY2Vzc19rZXlfaWQ6ICdmb28nLCAkYWNjb3VudDogJzg4ODg4JyB9LFxuICAgICAgICB9LFxuICAgICAgfSk7XG4gICAgICBjb25zdCBlcnJvciA9IG5ldyBFcnJvcignVG9vIGxhdGUnKTtcbiAgICAgIGVycm9yLm5hbWUgPSAnRXhwaXJlZFRva2VuJztcbiAgICAgIG1vY2tTVFNDbGllbnQub24oQXNzdW1lUm9sZUNvbW1hbmQpLnJlamVjdHNPbmNlKGVycm9yKTtcbiAgICAgIGNvbnN0IHByb3ZpZGVyID0gYXdhaXQgcHJvdmlkZXJGcm9tUHJvZmlsZSh1bmRlZmluZWQpO1xuXG4gICAgICAvLyBXSEVOIC0gYXNzdW1lUm9sZSBmYWlscyB3aXRoIGEgc3BlY2lmaWMgZXJyb3JcbiAgICAgIGF3YWl0IGV4cGVjdChhc3luYyAoKSA9PiB7XG4gICAgICAgIGF3YWl0IHByb3ZpZGVyLmZvckVudmlyb25tZW50KGVudih1bmlxKCc4ODg4OCcpKSwgTW9kZS5Gb3JSZWFkaW5nLCB7IGFzc3VtZVJvbGVBcm46ICc8RkFJTDpFeHBpcmVkVG9rZW4+JyB9KTtcbiAgICAgIH0pLnJlamVjdHMudG9UaHJvdyhlcnJvcik7XG4gICAgfSk7XG4gIH0pO1xuXG4gIGRlc2NyaWJlKCdQbHVnaW5zJywgKCkgPT4ge1xuICAgIHRlc3QoJ2RvZXMgbm90IHVzZSBwbHVnaW5zIGlmIGN1cnJlbnQgY3JlZGVudGlhbHMgYXJlIGZvciBleHBlY3RlZCBhY2NvdW50JywgYXN5bmMgKCkgPT4ge1xuICAgICAgcHJlcGFyZUNyZWRzKHtcbiAgICAgICAgZmFrZVN0cyxcbiAgICAgICAgY29uZmlnOiB7XG4gICAgICAgICAgZGVmYXVsdDogeyBhd3NfYWNjZXNzX2tleV9pZDogJ2ZvbycsICRhY2NvdW50OiAnMTExMTEnIH0sXG4gICAgICAgIH0sXG4gICAgICB9KTtcbiAgICAgIGNvbnN0IHByb3ZpZGVyID0gYXdhaXQgcHJvdmlkZXJGcm9tUHJvZmlsZSh1bmRlZmluZWQpO1xuICAgICAgYXdhaXQgcHJvdmlkZXIuZm9yRW52aXJvbm1lbnQoZW52KHVuaXEoJzExMTExJykpLCBNb2RlLkZvclJlYWRpbmcpO1xuICAgICAgZXhwZWN0KHBsdWdpblF1ZXJpZWQpLnRvRXF1YWwoZmFsc2UpO1xuICAgIH0pO1xuXG4gICAgdGVzdCgndXNlcyBwbHVnaW4gZm9yIGFjY291bnQgOTk5OTknLCBhc3luYyAoKSA9PiB7XG4gICAgICBjb25zdCBwcm92aWRlciA9IGF3YWl0IHByb3ZpZGVyRnJvbVByb2ZpbGUodW5kZWZpbmVkKTtcbiAgICAgIGF3YWl0IHByb3ZpZGVyLmZvckVudmlyb25tZW50KGVudih1bmlxKCc5OTk5OScpKSwgTW9kZS5Gb3JSZWFkaW5nKTtcbiAgICAgIGV4cGVjdChwbHVnaW5RdWVyaWVkKS50b0VxdWFsKHRydWUpO1xuICAgIH0pO1xuXG4gICAgdGVzdCgnY2FuIGFzc3VtZSByb2xlIHdpdGggY3JlZGVudGlhbHMgZnJvbSBwbHVnaW4nLCBhc3luYyAoKSA9PiB7XG4gICAgICBmYWtlU3RzLnJlZ2lzdGVyUm9sZSh1bmlxKCc5OTk5OScpLCAnYXJuOmF3czppYW06Ojk5OTk5OnJvbGUvQXNzdW1hYmxlJyk7XG5cbiAgICAgIGNvbnN0IHByb3ZpZGVyID0gYXdhaXQgcHJvdmlkZXJGcm9tUHJvZmlsZSh1bmRlZmluZWQpO1xuICAgICAgYXdhaXQgcHJvdmlkZXIuZm9yRW52aXJvbm1lbnQoZW52KHVuaXEoJzk5OTk5JykpLCBNb2RlLkZvclJlYWRpbmcsIHtcbiAgICAgICAgYXNzdW1lUm9sZUFybjogJ2Fybjphd3M6aWFtOjo5OTk5OTpyb2xlL0Fzc3VtYWJsZScsXG4gICAgICB9KTtcblxuICAgICAgZXhwZWN0KG1vY2tTVFNDbGllbnQpLnRvSGF2ZVJlY2VpdmVkQ29tbWFuZFdpdGgoQXNzdW1lUm9sZUNvbW1hbmQsIHtcbiAgICAgICAgUm9sZUFybjogJ2Fybjphd3M6aWFtOjo5OTk5OTpyb2xlL0Fzc3VtYWJsZScsXG4gICAgICAgIFJvbGVTZXNzaW9uTmFtZTogZXhwZWN0LmFueXRoaW5nKCksXG4gICAgICB9KTtcbiAgICAgIGV4cGVjdChwbHVnaW5RdWVyaWVkKS50b0VxdWFsKHRydWUpO1xuICAgIH0pO1xuXG4gICAgdGVzdCgnZXZlbiBpZiBBc3N1bWVSb2xlIGZhaWxzIGJ1dCBjdXJyZW50IGNyZWRlbnRpYWxzIGFyZSBmcm9tIGEgcGx1Z2luLCB3ZSB3aWxsIHN0aWxsIHVzZSB0aGVtJywgYXN5bmMgKCkgPT4ge1xuICAgICAgY29uc3QgcHJvdmlkZXIgPSBhd2FpdCBwcm92aWRlckZyb21Qcm9maWxlKHVuZGVmaW5lZCk7XG4gICAgICBjb25zdCBzZGsgPSAoXG4gICAgICAgIGF3YWl0IHByb3ZpZGVyLmZvckVudmlyb25tZW50KGVudih1bmlxKCc5OTk5OScpKSwgTW9kZS5Gb3JSZWFkaW5nLCB7IGFzc3VtZVJvbGVBcm46ICdkb2VzOm5vdDpleGlzdCcgfSlcbiAgICAgICkuc2RrO1xuXG4gICAgICAvLyBUSEVOXG4gICAgICBleHBlY3QoKGF3YWl0IHNkay5jdXJyZW50QWNjb3VudCgpKS5hY2NvdW50SWQpLnRvRXF1YWwodW5pcSgnOTk5OTknKSk7XG4gICAgfSk7XG5cbiAgICB0ZXN0KCdwbHVnaW5zIGFyZSBzdGlsbCBxdWVyaWVkIGV2ZW4gaWYgY3VycmVudCBjcmVkZW50aWFscyBhcmUgZXhwaXJlZCAob3Igb3RoZXJ3aXNlIGludmFsaWQpJywgYXN5bmMgKCkgPT4ge1xuICAgICAgLy8gR0lWRU5cbiAgICAgIHByb2Nlc3MuZW52LkFXU19BQ0NFU1NfS0VZX0lEID0gYCR7dWlkfWFraWRgO1xuICAgICAgcHJvY2Vzcy5lbnYuQVdTX1NFQ1JFVF9BQ0NFU1NfS0VZID0gJ3Nla3JpdCc7XG4gICAgICBjb25zdCBwcm92aWRlciA9IGF3YWl0IHByb3ZpZGVyRnJvbVByb2ZpbGUodW5kZWZpbmVkKTtcblxuICAgICAgLy8gV0hFTlxuICAgICAgYXdhaXQgcHJvdmlkZXIuZm9yRW52aXJvbm1lbnQoZW52KHVuaXEoJzk5OTk5JykpLCBNb2RlLkZvclJlYWRpbmcpO1xuXG4gICAgICAvLyBUSEVOXG4gICAgICBleHBlY3QocGx1Z2luUXVlcmllZCkudG9FcXVhbCh0cnVlKTtcbiAgICB9KTtcbiAgfSk7XG5cbiAgZGVzY3JpYmUoJ3N1cHBvcnQgZm9yIGNyZWRlbnRpYWxfc291cmNlJywgKCkgPT4ge1xuICAgIHRlc3QoJ2NhbiBhc3N1bWUgcm9sZSB3aXRoIGVjcyBjcmVkZW50aWFscycsIGFzeW5jICgpID0+IHtcbiAgICAgIC8vIEdJVkVOXG4gICAgICBjb25zdCBjYWxscyA9IGplc3Quc3B5T24oY29uc29sZSwgJ2RlYnVnJyk7XG4gICAgICBwcmVwYXJlQ3JlZHMoe1xuICAgICAgICBjb25maWc6IHtcbiAgICAgICAgICAncHJvZmlsZSBlY3MnOiB7XG4gICAgICAgICAgICByb2xlX2FybjogJ2Fybjphd3M6aWFtOjoxMjM1Njc4OTAxMjpyb2xlL0Fzc3VtYWJsZScsXG4gICAgICAgICAgICBjcmVkZW50aWFsX3NvdXJjZTogJ0Vjc0NvbnRhaW5lcicsXG4gICAgICAgICAgICAkYWNjb3VudDogJzIyMjIyJyxcbiAgICAgICAgICB9LFxuICAgICAgICB9LFxuICAgICAgfSk7XG5cbiAgICAgIC8vIFdIRU5cbiAgICAgIGNvbnN0IHByb3ZpZGVyID0gYXdhaXQgcHJvdmlkZXJGcm9tUHJvZmlsZSgnZWNzJyk7XG4gICAgICBhd2FpdCBwcm92aWRlci5kZWZhdWx0QWNjb3VudCgpO1xuXG4gICAgICAvLyBUSEVOXG4gICAgICBleHBlY3QoY2FsbHMubW9jay5jYWxscykudG9Db250YWluRXF1YWwoW1xuICAgICAgICAnQGF3cy1zZGsvY3JlZGVudGlhbC1wcm92aWRlci1pbmkgLSBmaW5kaW5nIGNyZWRlbnRpYWwgcmVzb2x2ZXIgdXNpbmcgcHJvZmlsZT1bZWNzXScsXG4gICAgICBdKTtcbiAgICAgIGV4cGVjdChjYWxscy5tb2NrLmNhbGxzKS50b0NvbnRhaW5FcXVhbChbJ0Bhd3Mtc2RrL2NyZWRlbnRpYWwtcHJvdmlkZXItaW5pIC0gY3JlZGVudGlhbF9zb3VyY2UgaXMgRWNzQ29udGFpbmVyJ10pO1xuICAgIH0pO1xuXG4gICAgdGVzdCgnY2FuIGFzc3VtZSByb2xlIHdpdGggZWMyIGNyZWRlbnRpYWxzJywgYXN5bmMgKCkgPT4ge1xuICAgICAgLy8gR0lWRU5cbiAgICAgIGNvbnN0IGNhbGxzID0gamVzdC5zcHlPbihjb25zb2xlLCAnZGVidWcnKTtcbiAgICAgIHByZXBhcmVDcmVkcyh7XG4gICAgICAgIGNvbmZpZzoge1xuICAgICAgICAgICdwcm9maWxlIGVjcyc6IHtcbiAgICAgICAgICAgIHJvbGVfYXJuOiAnYXJuOmF3czppYW06OjEyMzU2Nzg5MDEyOnJvbGUvQXNzdW1hYmxlJyxcbiAgICAgICAgICAgIGNyZWRlbnRpYWxfc291cmNlOiAnRWMySW5zdGFuY2VNZXRhZGF0YScsXG4gICAgICAgICAgICAkYWNjb3VudDogJzIyMjIyJyxcbiAgICAgICAgICB9LFxuICAgICAgICB9LFxuICAgICAgfSk7XG5cbiAgICAgIC8vIFdIRU5cbiAgICAgIGNvbnN0IHByb3ZpZGVyID0gYXdhaXQgcHJvdmlkZXJGcm9tUHJvZmlsZSgnZWNzJyk7XG4gICAgICBhd2FpdCBwcm92aWRlci5kZWZhdWx0QWNjb3VudCgpO1xuXG4gICAgICAvLyBUSEVOXG4gICAgICBleHBlY3QoY2FsbHMubW9jay5jYWxscykudG9Db250YWluRXF1YWwoW1xuICAgICAgICAnQGF3cy1zZGsvY3JlZGVudGlhbC1wcm92aWRlci1pbmkgLSBmaW5kaW5nIGNyZWRlbnRpYWwgcmVzb2x2ZXIgdXNpbmcgcHJvZmlsZT1bZWNzXScsXG4gICAgICBdKTtcbiAgICAgIGV4cGVjdChjYWxscy5tb2NrLmNhbGxzKS50b0NvbnRhaW5FcXVhbChbXG4gICAgICAgICdAYXdzLXNkay9jcmVkZW50aWFsLXByb3ZpZGVyLWluaSAtIGNyZWRlbnRpYWxfc291cmNlIGlzIEVjMkluc3RhbmNlTWV0YWRhdGEnLFxuICAgICAgXSk7XG4gICAgfSk7XG5cbiAgICB0ZXN0KCdjYW4gYXNzdW1lIHJvbGUgd2l0aCBlbnYgY3JlZGVudGlhbHMnLCBhc3luYyAoKSA9PiB7XG4gICAgICAvLyBHSVZFTlxuICAgICAgY29uc3QgY2FsbHMgPSBqZXN0LnNweU9uKGNvbnNvbGUsICdkZWJ1ZycpO1xuICAgICAgcHJlcGFyZUNyZWRzKHtcbiAgICAgICAgY29uZmlnOiB7XG4gICAgICAgICAgJ3Byb2ZpbGUgZWNzJzoge1xuICAgICAgICAgICAgcm9sZV9hcm46ICdhcm46YXdzOmlhbTo6MTIzNTY3ODkwMTI6cm9sZS9Bc3N1bWFibGUnLFxuICAgICAgICAgICAgY3JlZGVudGlhbF9zb3VyY2U6ICdFbnZpcm9ubWVudCcsXG4gICAgICAgICAgICAkYWNjb3VudDogJzIyMjIyJyxcbiAgICAgICAgICB9LFxuICAgICAgICB9LFxuICAgICAgfSk7XG5cbiAgICAgIC8vIFdIRU5cbiAgICAgIGNvbnN0IHByb3ZpZGVyID0gYXdhaXQgcHJvdmlkZXJGcm9tUHJvZmlsZSgnZWNzJyk7XG4gICAgICBhd2FpdCBwcm92aWRlci5kZWZhdWx0QWNjb3VudCgpO1xuXG4gICAgICAvLyBUSEVOXG4gICAgICBleHBlY3QoY2FsbHMubW9jay5jYWxscykudG9Db250YWluRXF1YWwoW1xuICAgICAgICAnQGF3cy1zZGsvY3JlZGVudGlhbC1wcm92aWRlci1pbmkgLSBmaW5kaW5nIGNyZWRlbnRpYWwgcmVzb2x2ZXIgdXNpbmcgcHJvZmlsZT1bZWNzXScsXG4gICAgICBdKTtcbiAgICAgIGV4cGVjdChjYWxscy5tb2NrLmNhbGxzKS50b0NvbnRhaW5FcXVhbChbJ0Bhd3Mtc2RrL2NyZWRlbnRpYWwtcHJvdmlkZXItaW5pIC0gY3JlZGVudGlhbF9zb3VyY2UgaXMgRW52aXJvbm1lbnQnXSk7XG4gICAgfSk7XG5cbiAgICB0ZXN0KCdhc3N1bWUgZmFpbHMgd2l0aCB1bnN1cHBvcnRlZCBjcmVkZW50aWFsX3NvdXJjZScsIGFzeW5jICgpID0+IHtcbiAgICAgIC8vIEdJVkVOXG4gICAgICBwcmVwYXJlQ3JlZHMoe1xuICAgICAgICBjb25maWc6IHtcbiAgICAgICAgICAncHJvZmlsZSBlY3MnOiB7XG4gICAgICAgICAgICByb2xlX2FybjogJ2Fybjphd3M6aWFtOjoxMjM1Njc4OTAxMjpyb2xlL0Fzc3VtYWJsZScsXG4gICAgICAgICAgICBjcmVkZW50aWFsX3NvdXJjZTogJ3Vuc3VwcG9ydGVkJyxcbiAgICAgICAgICAgICRhY2NvdW50OiAnMjIyMjInLFxuICAgICAgICAgIH0sXG4gICAgICAgIH0sXG4gICAgICB9KTtcbiAgICAgIGNvbnN0IHByb3ZpZGVyID0gYXdhaXQgcHJvdmlkZXJGcm9tUHJvZmlsZSgnZWNzJyk7XG5cbiAgICAgIC8vIFdIRU5cbiAgICAgIGNvbnN0IGFjY291bnQgPSBhd2FpdCBwcm92aWRlci5kZWZhdWx0QWNjb3VudCgpO1xuXG4gICAgICAvLyBUSEVOXG4gICAgICBleHBlY3QoYWNjb3VudD8uYWNjb3VudElkKS50b0VxdWFsKHVuZGVmaW5lZCk7XG4gICAgfSk7XG4gIH0pO1xuXG4gIHRlc3QoJ2RlZmF1bHRBY2NvdW50IHJldHVybnMgdW5kZWZpbmVkIGlmIFNUUyBjYWxsIGZhaWxzJywgYXN5bmMgKCkgPT4ge1xuICAgIC8vIEdJVkVOXG4gICAgbW9ja1NUU0NsaWVudC5vbihBc3N1bWVSb2xlQ29tbWFuZCkucmVqZWN0c09uY2UoJ09vcHMsIGJhZCBzZWtyaXQnKTtcblxuICAgIC8vIFdIRU5cbiAgICBjb25zdCBwcm92aWRlciA9IGF3YWl0IHByb3ZpZGVyRnJvbVByb2ZpbGUodW5kZWZpbmVkKTtcblxuICAgIC8vIFRIRU5cbiAgICBhd2FpdCBleHBlY3QocHJvdmlkZXIuZGVmYXVsdEFjY291bnQoKSkucmVzb2x2ZXMudG9CZSh1bmRlZmluZWQpO1xuICB9KTtcblxuICB0ZXN0KCdkZWZhdWx0QWNjb3VudCByZXR1cm5zIHVuZGVmaW5lZCwgZXZlbnQgaWYgU1RTIGNhbGwgZmFpbHMgd2l0aCBFeHBpcmVkVG9rZW4nLCBhc3luYyAoKSA9PiB7XG4gICAgLy8gR0lWRU5cbiAgICBjb25zdCBlcnJvciA9IG5ldyBFcnJvcignVG9vIGxhdGUnKTtcbiAgICBlcnJvci5uYW1lID0gJ0V4cGlyZWRUb2tlbic7XG4gICAgbW9ja1NUU0NsaWVudC5vbihBc3N1bWVSb2xlQ29tbWFuZCkucmVqZWN0c09uY2UoZXJyb3IpO1xuXG4gICAgLy8gV0hFTlxuICAgIGNvbnN0IHByb3ZpZGVyID0gYXdhaXQgcHJvdmlkZXJGcm9tUHJvZmlsZSh1bmRlZmluZWQpO1xuXG4gICAgLy8gVEhFTlxuICAgIGF3YWl0IGV4cGVjdChwcm92aWRlci5kZWZhdWx0QWNjb3VudCgpKS5yZXNvbHZlcy50b0JlKHVuZGVmaW5lZCk7XG4gIH0pO1xufSk7XG5cbnRlc3QoJ2RlZmF1bHQgdXNlcmFnZW50IGlzIHJlYXNvbmFibGUnLCAoKSA9PiB7XG4gIGV4cGVjdChkZWZhdWx0Q2xpVXNlckFnZW50KCkpLnRvQ29udGFpbignYXdzLWNkay8nKTtcbn0pO1xuXG4vKipcbiAqIFVzZSBvYmplY3QgaGFja2VyeSB0byBnZXQgdGhlIGNyZWRlbnRpYWxzIG91dCBvZiB0aGUgU0RLIG9iamVjdFxuICovXG5mdW5jdGlvbiBzZGtDb25maWcoc2RrOiBTREspOiBDb25maWd1cmF0aW9uT3B0aW9ucyB7XG4gIHJldHVybiAoc2RrIGFzIGFueSkuY29uZmlnO1xufVxuXG4vKipcbiAqIEZpeHR1cmUgZm9yIFNESyBhdXRoIGZvciB0aGlzIHRlc3Qgc3VpdGVcbiAqXG4gKiBIYXMga25vd2xlZGdlIG9mIHRoZSBjYWNoZSBidXN0ZXIsIHdpbGwgd3JpdGUgcHJvcGVyIGZha2UgY29uZmlnIGZpbGVzIGFuZFxuICogcmVnaXN0ZXIgdXNlcnMgYW5kIHJvbGVzIGluIEZha2VTdHMgYXQgdGhlIHNhbWUgdGltZS5cbiAqL1xuZnVuY3Rpb24gcHJlcGFyZUNyZWRzKG9wdGlvbnM6IFByZXBhcmVDcmVkc09wdGlvbnMpIHtcbiAgZnVuY3Rpb24gY29udmVydFNlY3Rpb25zKHNlY3Rpb25zPzogUmVjb3JkPHN0cmluZywgUHJvZmlsZVVzZXIgfCBQcm9maWxlUm9sZT4pIHtcbiAgICBjb25zdCByZXQgPSBbXTtcbiAgICBmb3IgKGNvbnN0IFtwcm9maWxlLCB1c2VyXSBvZiBPYmplY3QuZW50cmllcyhzZWN0aW9ucyA/PyB7fSkpIHtcbiAgICAgIHJldC5wdXNoKGBbJHtwcm9maWxlfV1gKTtcblxuICAgICAgaWYgKGlzUHJvZmlsZVJvbGUodXNlcikpIHtcbiAgICAgICAgcmV0LnB1c2goYHJvbGVfYXJuPSR7dXNlci5yb2xlX2Fybn1gKTtcbiAgICAgICAgaWYgKCdzb3VyY2VfcHJvZmlsZScgaW4gdXNlcikge1xuICAgICAgICAgIHJldC5wdXNoKGBzb3VyY2VfcHJvZmlsZT0ke3VzZXIuc291cmNlX3Byb2ZpbGV9YCk7XG4gICAgICAgIH1cbiAgICAgICAgaWYgKCdjcmVkZW50aWFsX3NvdXJjZScgaW4gdXNlcikge1xuICAgICAgICAgIHJldC5wdXNoKGBjcmVkZW50aWFsX3NvdXJjZT0ke3VzZXIuY3JlZGVudGlhbF9zb3VyY2V9YCk7XG4gICAgICAgIH1cbiAgICAgICAgaWYgKHVzZXIubWZhX3NlcmlhbCkge1xuICAgICAgICAgIHJldC5wdXNoKGBtZmFfc2VyaWFsPSR7dXNlci5tZmFfc2VyaWFsfWApO1xuICAgICAgICB9XG4gICAgICAgIG9wdGlvbnMuZmFrZVN0cz8ucmVnaXN0ZXJSb2xlKHVuaXEodXNlci4kYWNjb3VudCA/PyAnMDAwMDAnKSwgdXNlci5yb2xlX2Fybiwge1xuICAgICAgICAgIC4uLnVzZXIuJGZha2VTdHNPcHRpb25zLFxuICAgICAgICAgIGFsbG93ZWRBY2NvdW50czogdXNlci4kZmFrZVN0c09wdGlvbnM/LmFsbG93ZWRBY2NvdW50cz8ubWFwKHVuaXEpLFxuICAgICAgICB9KTtcbiAgICAgIH0gZWxzZSB7XG4gICAgICAgIGlmICh1c2VyLmF3c19hY2Nlc3Nfa2V5X2lkKSB7XG4gICAgICAgICAgcmV0LnB1c2goYGF3c19hY2Nlc3Nfa2V5X2lkPSR7dW5pcSh1c2VyLmF3c19hY2Nlc3Nfa2V5X2lkKX1gKTtcbiAgICAgICAgICByZXQucHVzaCgnYXdzX3NlY3JldF9hY2Nlc3Nfa2V5PXNlY3JldCcpO1xuICAgICAgICAgIG9wdGlvbnMuZmFrZVN0cz8ucmVnaXN0ZXJVc2VyKFxuICAgICAgICAgICAgdW5pcSh1c2VyLiRhY2NvdW50ID8/ICcwMDAwMCcpLFxuICAgICAgICAgICAgdW5pcSh1c2VyLmF3c19hY2Nlc3Nfa2V5X2lkKSxcbiAgICAgICAgICAgIHVzZXIuJGZha2VTdHNPcHRpb25zLFxuICAgICAgICAgICk7XG4gICAgICAgIH1cbiAgICAgIH1cblxuICAgICAgaWYgKHVzZXIucmVnaW9uKSB7XG4gICAgICAgIHJldC5wdXNoKGByZWdpb249JHt1c2VyLnJlZ2lvbn1gKTtcbiAgICAgIH1cbiAgICB9XG4gICAgcmV0dXJuIHJldC5qb2luKCdcXG4nKTtcbiAgfVxuXG4gIGJvY2tmcyh7XG4gICAgJy9ob21lL21lLy5ieHQvY3JlZGVudGlhbHMnOiBjb252ZXJ0U2VjdGlvbnMob3B0aW9ucy5jcmVkZW50aWFscyksXG4gICAgJy9ob21lL21lLy5ieHQvY29uZmlnJzogY29udmVydFNlY3Rpb25zKG9wdGlvbnMuY29uZmlnKSxcbiAgfSk7XG5cbiAgLy8gU2V0IGVudmlyb25tZW50IHZhcmlhYmxlcyB0aGF0IHdlIHdhbnRcbiAgcHJvY2Vzcy5lbnYuQVdTX0NPTkZJR19GSUxFID0gYm9ja2ZzLnBhdGgoJy9ob21lL21lLy5ieHQvY29uZmlnJyk7XG4gIHByb2Nlc3MuZW52LkFXU19TSEFSRURfQ1JFREVOVElBTFNfRklMRSA9IGJvY2tmcy5wYXRoKCcvaG9tZS9tZS8uYnh0L2NyZWRlbnRpYWxzJyk7XG59XG5cbmludGVyZmFjZSBQcmVwYXJlQ3JlZHNPcHRpb25zIHtcbiAgLyoqXG4gICAqIFdyaXRlIHRoZSBhd3MvY3JlZGVudGlhbHMgZmlsZVxuICAgKi9cbiAgcmVhZG9ubHkgY3JlZGVudGlhbHM/OiBSZWNvcmQ8c3RyaW5nLCBQcm9maWxlVXNlciB8IFByb2ZpbGVSb2xlPjtcblxuICAvKipcbiAgICogV3JpdGUgdGhlIGF3cy9jb25maWcgZmlsZVxuICAgKi9cbiAgcmVhZG9ubHkgY29uZmlnPzogUmVjb3JkPHN0cmluZywgUHJvZmlsZVVzZXIgfCBQcm9maWxlUm9sZT47XG5cbiAgLyoqXG4gICAqIElmIGdpdmVuLCBhZGQgdXNlcnMgdG8gRmFrZVNUU1xuICAgKi9cbiAgcmVhZG9ubHkgZmFrZVN0cz86IEZha2VTdHM7XG59XG5cbmludGVyZmFjZSBQcm9maWxlVXNlciB7XG4gIHJlYWRvbmx5IGF3c19hY2Nlc3Nfa2V5X2lkPzogc3RyaW5nO1xuICByZWFkb25seSAkYWNjb3VudD86IHN0cmluZztcbiAgcmVhZG9ubHkgcmVnaW9uPzogc3RyaW5nO1xuICByZWFkb25seSAkZmFrZVN0c09wdGlvbnM/OiBSZWdpc3RlclVzZXJPcHRpb25zO1xufVxuXG50eXBlIFByb2ZpbGVSb2xlID0ge1xuICByZWFkb25seSByb2xlX2Fybjogc3RyaW5nO1xuICByZWFkb25seSBtZmFfc2VyaWFsPzogc3RyaW5nO1xuICByZWFkb25seSAkYWNjb3VudDogc3RyaW5nO1xuICByZWFkb25seSByZWdpb24/OiBzdHJpbmc7XG4gIHJlYWRvbmx5ICRmYWtlU3RzT3B0aW9ucz86IFJlZ2lzdGVyUm9sZU9wdGlvbnM7XG59ICYgKHsgcmVhZG9ubHkgc291cmNlX3Byb2ZpbGU6IHN0cmluZyB9IHwgeyByZWFkb25seSBjcmVkZW50aWFsX3NvdXJjZTogc3RyaW5nIH0pO1xuXG5mdW5jdGlvbiBpc1Byb2ZpbGVSb2xlKHg6IFByb2ZpbGVVc2VyIHwgUHJvZmlsZVJvbGUpOiB4IGlzIFByb2ZpbGVSb2xlIHtcbiAgcmV0dXJuICdyb2xlX2FybicgaW4geDtcbn1cblxuYXN5bmMgZnVuY3Rpb24gcHJvdmlkZXJGcm9tUHJvZmlsZShwcm9maWxlOiBzdHJpbmcgfCB1bmRlZmluZWQpIHtcbiAgcmV0dXJuIFNka1Byb3ZpZGVyLndpdGhBd3NDbGlDb21wYXRpYmxlRGVmYXVsdHMoeyBwcm9maWxlLCBsb2dnZXI6IGNvbnNvbGUgfSk7XG59XG4iXX0=