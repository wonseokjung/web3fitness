"use strict";
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
var SdkProvider_1;
Object.defineProperty(exports, "__esModule", { value: true });
exports.SdkProvider = void 0;
exports.initContextProviderSdk = initContextProviderSdk;
const os = require("os");
const cx_api_1 = require("@aws-cdk/cx-api");
const credential_providers_1 = require("@aws-sdk/credential-providers");
const awscli_compatible_1 = require("./awscli-compatible");
const cached_1 = require("./cached");
const credential_plugins_1 = require("./credential-plugins");
const sdk_1 = require("./sdk");
const logging_1 = require("../../logging");
const tracing_1 = require("../../util/tracing");
const plugin_1 = require("../plugin");
const CACHED_ACCOUNT = Symbol('cached_account');
const CACHED_DEFAULT_CREDENTIALS = Symbol('cached_default_credentials');
/**
 * Creates instances of the AWS SDK appropriate for a given account/region.
 *
 * Behavior is as follows:
 *
 * - First, a set of "base" credentials are established
 *   - If a target environment is given and the default ("current") SDK credentials are for
 *     that account, return those; otherwise
 *   - If a target environment is given, scan all credential provider plugins
 *     for credentials, and return those if found; otherwise
 *   - Return default ("current") SDK credentials, noting that they might be wrong.
 *
 * - Second, a role may optionally need to be assumed. Use the base credentials
 *   established in the previous process to assume that role.
 *   - If assuming the role fails and the base credentials are for the correct
 *     account, return those. This is a fallback for people who are trying to interact
 *     with a Default Synthesized stack and already have right credentials setup.
 *
 *     Typical cases we see in the wild:
 *     - Credential plugin setup that, although not recommended, works for them
 *     - Seeded terminal with `ReadOnly` credentials in order to do `cdk diff`--the `ReadOnly`
 *       role doesn't have `sts:AssumeRole` and will fail for no real good reason.
 */
let SdkProvider = SdkProvider_1 = class SdkProvider {
    /**
     * Create a new SdkProvider which gets its defaults in a way that behaves like the AWS CLI does
     *
     * The AWS SDK for JS behaves slightly differently from the AWS CLI in a number of ways; see the
     * class `AwsCliCompatible` for the details.
     */
    static async withAwsCliCompatibleDefaults(options = {}) {
        const credentialProvider = await awscli_compatible_1.AwsCliCompatible.credentialChainBuilder({
            profile: options.profile,
            httpOptions: options.httpOptions,
            logger: options.logger,
        });
        const region = await awscli_compatible_1.AwsCliCompatible.region(options.profile);
        const requestHandler = awscli_compatible_1.AwsCliCompatible.requestHandlerBuilder(options.httpOptions);
        return new SdkProvider_1(credentialProvider, region, requestHandler);
    }
    constructor(defaultCredentialProvider, 
    /**
     * Default region
     */
    defaultRegion, requestHandler = {}) {
        this.defaultCredentialProvider = defaultCredentialProvider;
        this.defaultRegion = defaultRegion;
        this.requestHandler = requestHandler;
        this.plugins = new credential_plugins_1.CredentialPlugins();
    }
    /**
     * Return an SDK which can do operations in the given environment
     *
     * The `environment` parameter is resolved first (see `resolveEnvironment()`).
     */
    async forEnvironment(environment, mode, options, quiet = false) {
        const env = await this.resolveEnvironment(environment);
        const baseCreds = await this.obtainBaseCredentials(env.account, mode);
        // At this point, we need at least SOME credentials
        if (baseCreds.source === 'none') {
            throw new Error(fmtObtainCredentialsError(env.account, baseCreds));
        }
        // Simple case is if we don't need to "assumeRole" here. If so, we must now have credentials for the right
        // account.
        if (options?.assumeRoleArn === undefined) {
            if (baseCreds.source === 'incorrectDefault') {
                throw new Error(fmtObtainCredentialsError(env.account, baseCreds));
            }
            // Our current credentials must be valid and not expired. Confirm that before we get into doing
            // actual CloudFormation calls, which might take a long time to hang.
            const sdk = new sdk_1.SDK(baseCreds.credentials, env.region, this.requestHandler);
            await sdk.validateCredentials();
            return { sdk, didAssumeRole: false };
        }
        try {
            // We will proceed to AssumeRole using whatever we've been given.
            const sdk = await this.withAssumedRole(baseCreds, options.assumeRoleArn, options.assumeRoleExternalId, options.assumeRoleAdditionalOptions, env.region);
            return { sdk, didAssumeRole: true };
        }
        catch (err) {
            if (err.name === 'ExpiredToken') {
                throw err;
            }
            // AssumeRole failed. Proceed and warn *if and only if* the baseCredentials were already for the right account
            // or returned from a plugin. This is to cover some current setups for people using plugins or preferring to
            // feed the CLI credentials which are sufficient by themselves. Prefer to assume the correct role if we can,
            // but if we can't then let's just try with available credentials anyway.
            if (baseCreds.source === 'correctDefault' || baseCreds.source === 'plugin') {
                (0, logging_1.debug)(err.message);
                const logger = quiet ? logging_1.debug : logging_1.warning;
                logger(`${fmtObtainedCredentials(baseCreds)} could not be used to assume '${options.assumeRoleArn}', but are for the right account. Proceeding anyway.`);
                return {
                    sdk: new sdk_1.SDK(baseCreds.credentials, env.region, this.requestHandler),
                    didAssumeRole: false,
                };
            }
            throw err;
        }
    }
    /**
     * Return the partition that base credentials are for
     *
     * Returns `undefined` if there are no base credentials.
     */
    async baseCredentialsPartition(environment, mode) {
        const env = await this.resolveEnvironment(environment);
        const baseCreds = await this.obtainBaseCredentials(env.account, mode);
        if (baseCreds.source === 'none') {
            return undefined;
        }
        return (await new sdk_1.SDK(baseCreds.credentials, env.region, this.requestHandler).currentAccount()).partition;
    }
    /**
     * Resolve the environment for a stack
     *
     * Replaces the magic values `UNKNOWN_REGION` and `UNKNOWN_ACCOUNT`
     * with the defaults for the current SDK configuration (`~/.aws/config` or
     * otherwise).
     *
     * It is an error if `UNKNOWN_ACCOUNT` is used but the user hasn't configured
     * any SDK credentials.
     */
    async resolveEnvironment(env) {
        const region = env.region !== cx_api_1.UNKNOWN_REGION ? env.region : this.defaultRegion;
        const account = env.account !== cx_api_1.UNKNOWN_ACCOUNT ? env.account : (await this.defaultAccount())?.accountId;
        if (!account) {
            throw new Error('Unable to resolve AWS account to use. It must be either configured when you define your CDK Stack, or through the environment');
        }
        return {
            region,
            account,
            name: cx_api_1.EnvironmentUtils.format(account, region),
        };
    }
    /**
     * The account we'd auth into if we used default credentials.
     *
     * Default credentials are the set of ambiently configured credentials using
     * one of the environment variables, or ~/.aws/credentials, or the *one*
     * profile that was passed into the CLI.
     *
     * Might return undefined if there are no default/ambient credentials
     * available (in which case the user should better hope they have
     * credential plugins configured).
     *
     * Uses a cache to avoid STS calls if we don't need 'em.
     */
    async defaultAccount() {
        return (0, cached_1.cached)(this, CACHED_ACCOUNT, async () => {
            try {
                const credentials = await this.defaultCredentials();
                const accessKeyId = credentials.accessKeyId;
                if (!accessKeyId) {
                    throw new Error('Unable to resolve AWS credentials (setup with "aws configure")');
                }
                return await new sdk_1.SDK(credentials, this.defaultRegion, this.requestHandler).currentAccount();
            }
            catch (e) {
                // Treat 'ExpiredToken' specially. This is a common situation that people may find themselves in, and
                // they are complaining about if we fail 'cdk synth' on them. We loudly complain in order to show that
                // the current situation is probably undesirable, but we don't fail.
                if (e.name === 'ExpiredToken') {
                    (0, logging_1.warning)('There are expired AWS credentials in your environment. The CDK app will synth without current account information.');
                    return undefined;
                }
                (0, logging_1.debug)(`Unable to determine the default AWS account (${e.name}): ${e.message}`);
                return undefined;
            }
        });
    }
    /**
     * Get credentials for the given account ID in the given mode
     *
     * 1. Use the default credentials if the destination account matches the
     *    current credentials' account.
     * 2. Otherwise try all credential plugins.
     * 3. Fail if neither of these yield any credentials.
     * 4. Return a failure if any of them returned credentials
     */
    async obtainBaseCredentials(accountId, mode) {
        // First try 'current' credentials
        const defaultAccountId = (await this.defaultAccount())?.accountId;
        if (defaultAccountId === accountId) {
            return {
                source: 'correctDefault',
                credentials: await this.defaultCredentials(),
            };
        }
        // Then try the plugins
        const pluginCreds = await this.plugins.fetchCredentialsFor(accountId, mode);
        if (pluginCreds) {
            return { source: 'plugin', ...pluginCreds };
        }
        // Fall back to default credentials with a note that they're not the right ones yet
        if (defaultAccountId !== undefined) {
            return {
                source: 'incorrectDefault',
                accountId: defaultAccountId,
                credentials: await this.defaultCredentials(),
                unusedPlugins: this.plugins.availablePluginNames,
            };
        }
        // Apparently we didn't find any at all
        return {
            source: 'none',
            unusedPlugins: this.plugins.availablePluginNames,
        };
    }
    /**
     * Resolve the default chain to the first set of credentials that is available
     */
    async defaultCredentials() {
        return (0, cached_1.cached)(this, CACHED_DEFAULT_CREDENTIALS, async () => {
            (0, logging_1.debug)('Resolving default credentials');
            return this.defaultCredentialProvider();
        });
    }
    /**
     * Return an SDK which uses assumed role credentials
     *
     * The base credentials used to retrieve the assumed role credentials will be the
     * same credentials returned by obtainCredentials if an environment and mode is passed,
     * otherwise it will be the current credentials.
     */
    async withAssumedRole(mainCredentials, roleArn, externalId, additionalOptions, region) {
        (0, logging_1.debug)(`Assuming role '${roleArn}'.`);
        region = region ?? this.defaultRegion;
        const sourceDescription = fmtObtainedCredentials(mainCredentials);
        try {
            const credentials = await (0, credential_providers_1.fromTemporaryCredentials)({
                masterCredentials: mainCredentials.credentials,
                params: {
                    RoleArn: roleArn,
                    ExternalId: externalId,
                    RoleSessionName: `aws-cdk-${safeUsername()}`,
                    ...additionalOptions,
                    TransitiveTagKeys: additionalOptions?.Tags ? additionalOptions.Tags.map((t) => t.Key) : undefined,
                },
                clientConfig: {
                    region,
                    ...this.requestHandler,
                },
            })();
            return new sdk_1.SDK(credentials, region, this.requestHandler);
        }
        catch (err) {
            if (err.name === 'ExpiredToken') {
                throw err;
            }
            (0, logging_1.debug)(`Assuming role failed: ${err.message}`);
            throw new Error([
                'Could not assume role in target account',
                ...(sourceDescription ? [`using ${sourceDescription}`] : []),
                err.message,
                ". Please make sure that this role exists in the account. If it doesn't exist, (re)-bootstrap the environment " +
                    "with the right '--trust', using the latest version of the CDK CLI.",
            ].join(' '));
        }
    }
};
exports.SdkProvider = SdkProvider;
exports.SdkProvider = SdkProvider = SdkProvider_1 = __decorate([
    tracing_1.traceMethods
], SdkProvider);
/**
 * Return the username with characters invalid for a RoleSessionName removed
 *
 * @see https://docs.aws.amazon.com/STS/latest/APIReference/API_AssumeRole.html#API_AssumeRole_RequestParameters
 */
function safeUsername() {
    try {
        return os.userInfo().username.replace(/[^\w+=,.@-]/g, '@');
    }
    catch {
        return 'noname';
    }
}
/**
 * Isolating the code that translates calculation errors into human error messages
 *
 * We cover the following cases:
 *
 * - No credentials are available at all
 * - Default credentials are for the wrong account
 */
function fmtObtainCredentialsError(targetAccountId, obtainResult) {
    const msg = [`Need to perform AWS calls for account ${targetAccountId}`];
    switch (obtainResult.source) {
        case 'incorrectDefault':
            msg.push(`but the current credentials are for ${obtainResult.accountId}`);
            break;
        case 'none':
            msg.push('but no credentials have been configured');
    }
    if (obtainResult.unusedPlugins.length > 0) {
        msg.push(`and none of these plugins found any: ${obtainResult.unusedPlugins.join(', ')}`);
    }
    return msg.join(', ');
}
/**
 * Format a message indicating where we got base credentials for the assume role
 *
 * We cover the following cases:
 *
 * - Default credentials for the right account
 * - Default credentials for the wrong account
 * - Credentials returned from a plugin
 */
function fmtObtainedCredentials(obtainResult) {
    switch (obtainResult.source) {
        case 'correctDefault':
            return 'current credentials';
        case 'plugin':
            return `credentials returned by plugin '${obtainResult.pluginName}'`;
        case 'incorrectDefault':
            const msg = [];
            msg.push(`current credentials (which are for account ${obtainResult.accountId}`);
            if (obtainResult.unusedPlugins.length > 0) {
                msg.push(`, and none of the following plugins provided credentials: ${obtainResult.unusedPlugins.join(', ')}`);
            }
            msg.push(')');
            return msg.join('');
    }
}
/**
 * Instantiate an SDK for context providers. This function ensures that all
 * lookup assume role options are used when context providers perform lookups.
 */
async function initContextProviderSdk(aws, options) {
    const account = options.account;
    const region = options.region;
    const creds = {
        assumeRoleArn: options.lookupRoleArn,
        assumeRoleExternalId: options.lookupRoleExternalId,
        assumeRoleAdditionalOptions: options.assumeRoleAdditionalOptions,
    };
    return (await aws.forEnvironment(cx_api_1.EnvironmentUtils.make(account, region), plugin_1.Mode.ForReading, creds)).sdk;
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoic2RrLXByb3ZpZGVyLmpzIiwic291cmNlUm9vdCI6IiIsInNvdXJjZXMiOlsic2RrLXByb3ZpZGVyLnRzIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiI7Ozs7Ozs7Ozs7QUE4Z0JBLHdEQVdDO0FBemhCRCx5QkFBeUI7QUFFekIsNENBQWlHO0FBRWpHLHdFQUF5RTtBQUd6RSwyREFBdUQ7QUFDdkQscUNBQWtDO0FBQ2xDLDZEQUF5RDtBQUN6RCwrQkFBNEI7QUFDNUIsMkNBQStDO0FBQy9DLGdEQUFrRDtBQUNsRCxzQ0FBaUM7QUE2Q2pDLE1BQU0sY0FBYyxHQUFHLE1BQU0sQ0FBQyxnQkFBZ0IsQ0FBQyxDQUFDO0FBQ2hELE1BQU0sMEJBQTBCLEdBQUcsTUFBTSxDQUFDLDRCQUE0QixDQUFDLENBQUM7QUE2QnhFOzs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7O0dBc0JHO0FBRUksSUFBTSxXQUFXLG1CQUFqQixNQUFNLFdBQVc7SUFDdEI7Ozs7O09BS0c7SUFDSSxNQUFNLENBQUMsS0FBSyxDQUFDLDRCQUE0QixDQUFDLFVBQThCLEVBQUU7UUFDL0UsTUFBTSxrQkFBa0IsR0FBRyxNQUFNLG9DQUFnQixDQUFDLHNCQUFzQixDQUFDO1lBQ3ZFLE9BQU8sRUFBRSxPQUFPLENBQUMsT0FBTztZQUN4QixXQUFXLEVBQUUsT0FBTyxDQUFDLFdBQVc7WUFDaEMsTUFBTSxFQUFFLE9BQU8sQ0FBQyxNQUFNO1NBQ3ZCLENBQUMsQ0FBQztRQUVILE1BQU0sTUFBTSxHQUFHLE1BQU0sb0NBQWdCLENBQUMsTUFBTSxDQUFDLE9BQU8sQ0FBQyxPQUFPLENBQUMsQ0FBQztRQUM5RCxNQUFNLGNBQWMsR0FBRyxvQ0FBZ0IsQ0FBQyxxQkFBcUIsQ0FBQyxPQUFPLENBQUMsV0FBVyxDQUFDLENBQUM7UUFDbkYsT0FBTyxJQUFJLGFBQVcsQ0FBQyxrQkFBa0IsRUFBRSxNQUFNLEVBQUUsY0FBYyxDQUFDLENBQUM7SUFDckUsQ0FBQztJQUlELFlBQ21CLHlCQUF3RDtJQUN6RTs7T0FFRztJQUNh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Q2xELDJCQUEyQixFQUFFLE9BQU8sQ0FBQywyQkFBMkI7S0FDakUsQ0FBQztJQUVGLE9BQU8sQ0FBQyxNQUFNLEdBQUcsQ0FBQyxjQUFjLENBQUMseUJBQWdCLENBQUMsSUFBSSxDQUFDLE9BQU8sRUFBRSxNQUFNLENBQUMsRUFBRSxhQUFJLENBQUMsVUFBVSxFQUFFLEtBQUssQ0FBQyxDQUFDLENBQUMsR0FBRyxDQUFDO0FBQ3hHLENBQUMiLCJzb3VyY2VzQ29udGVudCI6WyJpbXBvcnQgKiBhcyBvcyBmcm9tICdvcyc7XG5pbXBvcnQgeyBDb250ZXh0TG9va3VwUm9sZU9wdGlvbnMgfSBmcm9tICdAYXdzLWNkay9jbG91ZC1hc3NlbWJseS1zY2hlbWEnO1xuaW1wb3J0IHsgRW52aXJvbm1lbnQsIEVudmlyb25tZW50VXRpbHMsIFVOS05PV05fQUNDT1VOVCwgVU5LTk9XTl9SRUdJT04gfSBmcm9tICdAYXdzLWNkay9jeC1hcGknO1xuaW1wb3J0IHsgQXNzdW1lUm9sZUNvbW1hbmRJbnB1dCB9IGZyb20gJ0Bhd3Mtc2RrL2NsaWVudC1zdHMnO1xuaW1wb3J0IHsgZnJvbVRlbXBvcmFyeUNyZWRlbnRpYWxzIH0gZnJvbSAnQGF3cy1zZGsvY3JlZGVudGlhbC1wcm92aWRlcnMnO1xuaW1wb3J0IHR5cGUgeyBOb2RlSHR0cEhhbmRsZXJPcHRpb25zIH0gZnJvbSAnQHNtaXRoeS9ub2RlLWh0dHAtaGFuZGxlcic7XG5pbXBvcnQgeyBBd3NDcmVkZW50aWFsSWRlbnRpdHksIEF3c0NyZWRlbnRpYWxJZGVudGl0eVByb3ZpZGVyLCBMb2dnZXIgfSBmcm9tICdAc21pdGh5L3R5cGVzJztcbmltcG9ydCB7IEF3c0NsaUNvbXBhdGlibGUgfSBmcm9tICcuL2F3c2NsaS1jb21wYXRpYmxlJztcbmltcG9ydCB7IGNhY2hlZCB9IGZyb20gJy4vY2FjaGVkJztcbmltcG9ydCB7IENyZWRlbnRpYWxQbHVnaW5zIH0gZnJvbSAnLi9jcmVkZW50aWFsLXBsdWdpbnMnO1xuaW1wb3J0IHsgU0RLIH0gZnJvbSAnLi9zZGsnO1xuaW1wb3J0IHsgZGVidWcsIHdhcm5pbmcgfSBmcm9tICcuLi8uLi9sb2dnaW5nJztcbmltcG9ydCB7IHRyYWNlTWV0aG9kcyB9IGZyb20gJy4uLy4uL3V0aWwvdHJhY2luZyc7XG5pbXBvcnQgeyBNb2RlIH0gZnJvbSAnLi4vcGx1Z2luJztcblxuZXhwb3J0IHR5cGUgQXNzdW1lUm9sZUFkZGl0aW9uYWxPcHRpb25zID0gUGFydGlhbDxPbWl0PEFzc3VtZVJvbGVDb21tYW5kSW5wdXQsICdFeHRlcm5hbElkJyB8ICdSb2xlQXJuJz4+O1xuXG4vKipcbiAqIE9wdGlvbnMgZm9yIHRoZSBkZWZhdWx0IFNESyBwcm92aWRlclxuICovXG5leHBvcnQgaW50ZXJmYWNlIFNka1Byb3ZpZGVyT3B0aW9ucyB7XG4gIC8qKlxuICAgKiBQcm9maWxlIHRvIHJlYWQgZnJvbSB+Ly5hd3NcbiAgICpcbiAgICogQGRlZmF1bHQgLSBObyBwcm9maWxlXG4gICAqL1xuICByZWFkb25seSBwcm9maWxlPzogc3RyaW5nO1xuXG4gIC8qKlxuICAgKiBIVFRQIG9wdGlvbnMgZm9yIFNES1xuICAgKi9cbiAgcmVhZG9ubHkgaHR0cE9wdGlvbnM/OiBTZGtIdHRwT3B0aW9ucztcblxuICAvKipcbiAgICogVGhlIGxvZ2dlciBmb3Igc2RrIGNhbGxzLlxuICAgKi9cbiAgcmVhZG9ubHkgbG9nZ2VyPzogTG9nZ2VyO1xufVxuXG4vKipcbiAqIE9wdGlvbnMgZm9yIGluZGl2aWR1YWwgU0RLc1xuICovXG5leHBvcnQgaW50ZXJmYWNlIFNka0h0dHBPcHRpb25zIHtcbiAgLyoqXG4gICAqIFByb3h5IGFkZHJlc3MgdG8gdXNlXG4gICAqXG4gICAqIEBkZWZhdWx0IE5vIHByb3h5XG4gICAqL1xuICByZWFkb25seSBwcm94eUFkZHJlc3M/OiBzdHJpbmc7XG5cbiAgLyoqXG4gICAqIEEgcGF0aCB0byBhIGNlcnRpZmljYXRlIGJ1bmRsZSB0aGF0IGNvbnRhaW5zIGEgY2VydCB0byBiZSB0cnVzdGVkLlxuICAgKlxuICAgKiBAZGVmYXVsdCBObyBjZXJ0aWZpY2F0ZSBidW5kbGVcbiAgICovXG4gIHJlYWRvbmx5IGNhQnVuZGxlUGF0aD86IHN0cmluZztcbn1cblxuY29uc3QgQ0FDSEVEX0FDQ09VTlQgPSBTeW1ib2woJ2NhY2hlZF9hY2NvdW50Jyk7XG5jb25zdCBDQUNIRURfREVGQVVMVF9DUkVERU5USUFMUyA9IFN5bWJvbCgnY2FjaGVkX2RlZmF1bHRfY3JlZGVudGlhbHMnKTtcblxuLyoqXG4gKiBTREsgY29uZmlndXJhdGlvbiBmb3IgYSBnaXZlbiBlbnZpcm9ubWVudFxuICogJ2ZvckVudmlyb25tZW50JyB3aWxsIGF0dGVtcHQgdG8gYXNzdW1lIGEgcm9sZSBhbmQgaWYgaXRcbiAqIGlzIG5vdCBzdWNjZXNzZnVsLCB0aGVuIGl0IHdpbGwgZWl0aGVyOlxuICogICAxLiBDaGVjayB0byBzZWUgaWYgdGhlIGRlZmF1bHQgY3JlZGVudGlhbHMgKGxvY2FsIGNyZWRlbnRpYWxzIHRoZSBDTEkgd2FzIGV4ZWN1dGVkIHdpdGgpXG4gKiAgICAgIGFyZSBmb3IgdGhlIGdpdmVuIGVudmlyb25tZW50LiBJZiB0aGV5IGFyZSB0aGVuIHJldHVybiB0aG9zZS5cbiAqICAgMi4gSWYgdGhlIGRlZmF1bHQgY3JlZGVudGlhbHMgYXJlIG5vdCBmb3IgdGhlIGdpdmVuIGVudmlyb25tZW50IHRoZW5cbiAqICAgICAgdGhyb3cgYW4gZXJyb3JcbiAqXG4gKiAnZGlkQXNzdW1lUm9sZScgYWxsb3dzIGNhbGxlcnMgdG8gd2hldGhlciB0aGV5IGFyZSByZWNlaXZpbmcgdGhlIGFzc3VtZSByb2xlXG4gKiBjcmVkZW50aWFscyBvciB0aGUgZGVmYXVsdCBjcmVkZW50aWFscy5cbiAqL1xuZXhwb3J0IGludGVyZmFjZSBTZGtGb3JFbnZpcm9ubWVudCB7XG4gIC8qKlxuICAgKiBUaGUgU0RLIGZvciB0aGUgZ2l2ZW4gZW52aXJvbm1lbnRcbiAgICovXG4gIHJlYWRvbmx5IHNkazogU0RLO1xuXG4gIC8qKlxuICAgKiBXaGV0aGVyIG9yIG5vdCB0aGUgYXNzdW1lIHJvbGUgd2FzIHN1Y2Nlc3NmdWwuXG4gICAqIElmIHRoZSBhc3N1bWUgcm9sZSB3YXMgbm90IHN1Y2Nlc3NmdWwgKGZhbHNlKVxuICAgKiB0aGVuIHRoYXQgbWVhbnMgdGhhdCB0aGUgJ3NkaycgcmV0dXJuZWQgY29udGFpbnNcbiAgICogdGhlIGRlZmF1bHQgY3JlZGVudGlhbHMgKG5vdCB0aGUgYXNzdW1lIHJvbGUgY3JlZGVudGlhbHMpXG4gICAqL1xuICByZWFkb25seSBkaWRBc3N1bWVSb2xlOiBib29sZWFuO1xufVxuXG4vKipcbiAqIENyZWF0ZXMgaW5zdGFuY2VzIG9mIHRoZSBBV1MgU0RLIGFwcHJvcHJpYXRlIGZvciBhIGdpdmVuIGFjY291bnQvcmVnaW9uLlxuICpcbiAqIEJlaGF2aW9yIGlzIGFzIGZvbGxvd3M6XG4gKlxuICogLSBGaXJzdCwgYSBzZXQgb2YgXCJiYXNlXCIgY3JlZGVudGlhbHMgYXJlIGVzdGFibGlzaGVkXG4gKiAgIC0gSWYgYSB0YXJnZXQgZW52aXJvbm1lbnQgaXMgZ2l2ZW4gYW5kIHRoZSBkZWZhdWx0IChcImN1cnJlbnRcIikgU0RLIGNyZWRlbnRpYWxzIGFyZSBmb3JcbiAqICAgICB0aGF0IGFjY291bnQsIHJldHVybiB0aG9zZTsgb3RoZXJ3aXNlXG4gKiAgIC0gSWYgYSB0YXJnZXQgZW52aXJvbm1lbnQgaXMgZ2l2ZW4sIHNjYW4gYWxsIGNyZWRlbnRpYWwgcHJvdmlkZXIgcGx1Z2luc1xuICogICAgIGZvciBjcmVkZW50aWFscywgYW5kIHJldHVybiB0aG9zZSBpZiBmb3VuZDsgb3RoZXJ3aXNlXG4gKiAgIC0gUmV0dXJuIGRlZmF1bHQgKFwiY3VycmVudFwiKSBTREsgY3JlZGVudGlhbHMsIG5vdGluZyB0aGF0IHRoZXkgbWlnaHQgYmUgd3JvbmcuXG4gKlxuICogLSBTZWNvbmQsIGEgcm9sZSBtYXkgb3B0aW9uYWxseSBuZWVkIHRvIGJlIGFzc3VtZWQuIFVzZSB0aGUgYmFzZSBjcmVkZW50aWFsc1xuICogICBlc3RhYmxpc2hlZCBpbiB0aGUgcHJldmlvdXMgcHJvY2VzcyB0byBhc3N1bWUgdGhhdCByb2xlLlxuICogICAtIElmIGFzc3VtaW5nIHRoZSByb2xlIGZhaWxzIGFuZCB0aGUgYmFzZSBjcmVkZW50aWFscyBhcmUgZm9yIHRoZSBjb3JyZWN0XG4gKiAgICAgYWNjb3VudCwgcmV0dXJuIHRob3NlLiBUaGlzIGlzIGEgZmFsbGJhY2sgZm9yIHBlb3BsZSB3aG8gYXJlIHRyeWluZyB0byBpbnRlcmFjdFxuICogICAgIHdpdGggYSBEZWZhdWx0IFN5bnRoZXNpemVkIHN0YWNrIGFuZCBhbHJlYWR5IGhhdmUgcmlnaHQgY3JlZGVudGlhbHMgc2V0dXAuXG4gKlxuICogICAgIFR5cGljYWwgY2FzZXMgd2Ugc2VlIGluIHRoZSB3aWxkOlxuICogICAgIC0gQ3JlZGVudGlhbCBwbHVnaW4gc2V0dXAgdGhhdCwgYWx0aG91Z2ggbm90IHJlY29tbWVuZGVkLCB3b3JrcyBmb3IgdGhlbVxuICogICAgIC0gU2VlZGVkIHRlcm1pbmFsIHdpdGggYFJlYWRPbmx5YCBjcmVkZW50aWFscyBpbiBvcmRlciB0byBkbyBgY2RrIGRpZmZgLS10aGUgYFJlYWRPbmx5YFxuICogICAgICAgcm9sZSBkb2Vzbid0IGhhdmUgYHN0czpBc3N1bWVSb2xlYCBhbmQgd2lsbCBmYWlsIGZvciBubyByZWFsIGdvb2QgcmVhc29uLlxuICovXG5AdHJhY2VNZXRob2RzXG5leHBvcnQgY2xhc3MgU2RrUHJvdmlkZXIge1xuICAvKipcbiAgICogQ3JlYXRlIGEgbmV3IFNka1Byb3ZpZGVyIHdoaWNoIGdldHMgaXRzIGRlZmF1bHRzIGluIGEgd2F5IHRoYXQgYmVoYXZlcyBsaWtlIHRoZSBBV1MgQ0xJIGRvZXNcbiAgICpcbiAgICogVGhlIEFXUyBTREsgZm9yIEpTIGJlaGF2ZXMgc2xpZ2h0bHkgZGlmZmVyZW50bHkgZnJvbSB0aGUgQVdTIENMSSBpbiBhIG51bWJlciBvZiB3YXlzOyBzZWUgdGhlXG4gICAqIGNsYXNzIGBBd3NDbGlDb21wYXRpYmxlYCBmb3IgdGhlIGRldGFpbHMuXG4gICAqL1xuICBwdWJsaWMgc3RhdGljIGFzeW5jIHdpdGhBd3NDbGlDb21wYXRpYmxlRGVmYXVsdHMob3B0aW9uczogU2RrUHJvdmlkZXJPcHRpb25zID0ge30pIHtcbiAgICBjb25zdCBjcmVkZW50aWFsUHJvdmlkZXIgPSBhd2FpdCBBd3NDbGlDb21wYXRpYmxlLmNyZWRlbnRpYWxDaGFpbkJ1aWxkZXIoe1xuICAgICAgcHJvZmlsZTogb3B0aW9ucy5wcm9maWxlLFxuICAgICAgaHR0cE9wdGlvbnM6IG9wdGlvbnMuaHR0cE9wdGlvbnMsXG4gICAgICBsb2dnZXI6IG9wdGlvbnMubG9nZ2VyLFxuICAgIH0pO1xuXG4gICAgY29uc3QgcmVnaW9uID0gYXdhaXQgQXdzQ2xpQ29tcGF0aWJsZS5yZWdpb24ob3B0aW9ucy5wcm9maWxlKTtcbiAgICBjb25zdCByZXF1ZXN0SGFuZGxlciA9IEF3c0NsaUNvbXBhdGlibGUucmVxdWVzdEhhbmRsZXJCdWlsZGVyKG9wdGlvbnMuaHR0cE9wdGlvbnMpO1xuICAgIHJldHVybiBuZXcgU2RrUHJvdmlkZXIoY3JlZGVudGlhbFByb3ZpZGVyLCByZWdpb24sIHJlcXVlc3RIYW5kbGVyKTtcbiAgfVxuXG4gIHByaXZhdGUgcmVhZG9ubHkgcGx1Z2lucyA9IG5ldyBDcmVkZW50aWFsUGx1Z2lucygpO1xuXG4gIHB1YmxpYyBjb25zdHJ1Y3RvcihcbiAgICBwcml2YXRlIHJlYWRvbmx5IGRlZmF1bHRDcmVkZW50aWFsUHJvdmlkZXI6IEF3c0NyZWRlbnRpYWxJZGVudGl0eVByb3ZpZGVyLFxuICAgIC8qKlxuICAgICAqIERlZmF1bHQgcmVnaW9uXG4gICAgICovXG4gICAgcHVibGljIHJlYWRvbmx5IGRlZmF1bHRSZWdpb246IHN0cmluZyxcbiAgICBwcml2YXRlIHJlYWRvbmx5IHJlcXVlc3RIYW5kbGVyOiBOb2RlSHR0cEhhbmRsZXJPcHRpb25zID0ge30sXG4gICkge31cblxuICAvKipcbiAgICogUmV0dXJuIGFuIFNESyB3aGljaCBjYW4gZG8gb3BlcmF0aW9ucyBpbiB0aGUgZ2l2ZW4gZW52aXJvbm1lbnRcbiAgICpcbiAgICogVGhlIGBlbnZpcm9ubWVudGAgcGFyYW1ldGVyIGlzIHJlc29sdmVkIGZpcnN0IChzZWUgYHJlc29sdmVFbnZpcm9ubWVudCgpYCkuXG4gICAqL1xuICBwdWJsaWMgYXN5bmMgZm9yRW52aXJvbm1lbnQoXG4gICAgZW52aXJvbm1lbnQ6IEVudmlyb25tZW50LFxuICAgIG1vZGU6IE1vZGUsXG4gICAgb3B0aW9ucz86IENyZWRlbnRpYWxzT3B0aW9ucyxcbiAgICBxdWlldCA9IGZhbHNlLFxuICApOiBQcm9taXNlPFNka0ZvckVudmlyb25tZW50PiB7XG4gICAgY29uc3QgZW52ID0gYXdhaXQgdGhpcy5yZXNvbHZlRW52aXJvbm1lbnQoZW52aXJvbm1lbnQpO1xuXG4gICAgY29uc3QgYmFzZUNyZWRzID0gYXdhaXQgdGhpcy5vYnRhaW5CYXNlQ3JlZGVudGlhbHMoZW52LmFjY291bnQsIG1vZGUpO1xuXG4gICAgLy8gQXQgdGhpcyBwb2ludCwgd2UgbmVlZCBhdCBsZWFzdCBTT01FIGNyZWRlbnRpYWxzXG4gICAgaWYgKGJhc2VDcmVkcy5zb3VyY2UgPT09ICdub25lJykge1xuICAgICAgdGhyb3cgbmV3IEVycm9yKGZtdE9idGFpbkNyZWRlbnRpYWxzRXJyb3IoZW52LmFjY291bnQsIGJhc2VDcmVkcykpO1xuICAgIH1cblxuICAgIC8vIFNpbXBsZSBjYXNlIGlzIGlmIHdlIGRvbid0IG5lZWQgdG8gXCJhc3N1bWVSb2xlXCIgaGVyZS4gSWYgc28sIHdlIG11c3Qgbm93IGhhdmUgY3JlZGVudGlhbHMgZm9yIHRoZSByaWdodFxuICAgIC8vIGFjY291bnQuXG4gICAgaWYgKG9wdGlvbnM/LmFzc3VtZVJvbGVBcm4gPT09IHVuZGVmaW5lZCkge1xuICAgICAgaWYgKGJhc2VDcmVkcy5zb3VyY2UgPT09ICdpbmNvcnJlY3REZWZhdWx0Jykge1xuICAgICAgICB0aHJvdyBuZXcgRXJyb3IoZm10T2J0YWluQ3JlZGVudGlhbHNFcnJvcihlbnYuYWNjb3VudCwgYmFzZUNyZWRzKSk7XG4gICAgICB9XG5cbiAgICAgIC8vIE91ciBjdXJyZW50IGNyZWRlbnRpYWxzIG11c3QgYmUgdmFsaWQgYW5kIG5vdCBleHBpcmVkLiBDb25maXJtIHRoYXQgYmVmb3JlIHdlIGdldCBpbnRvIGRvaW5nXG4gICAgICAvLyBhY3R1YWwgQ2xvdWRGb3JtYXRpb24gY2FsbHMsIHdoaWNoIG1pZ2h0IHRha2UgYSBsb25nIHRpbWUgdG8gaGFuZy5cbiAgICAgIGNvbnN0IHNkayA9IG5ldyBTREsoYmFzZUNyZWRzLmNyZWRlbnRpYWxzLCBlbnYucmVnaW9uLCB0aGlzLnJlcXVlc3RIYW5kbGVyKTtcbiAgICAgIGF3YWl0IHNkay52YWxpZGF0ZUNyZWRlbnRpYWxzKCk7XG4gICAgICByZXR1cm4geyBzZGssIGRpZEFzc3VtZVJvbGU6IGZhbHNlIH07XG4gICAgfVxuXG4gICAgdHJ5IHtcbiAgICAgIC8vIFdlIHdpbGwgcHJvY2VlZCB0byBBc3N1bWVSb2xlIHVzaW5nIHdoYXRldmVyIHdlJ3ZlIGJlZW4gZ2l2ZW4uXG4gICAgICBjb25zdCBzZGsgPSBhd2FpdCB0aGlzLndpdGhBc3N1bWVkUm9sZShcbiAgICAgICAgYmFzZUNyZWRzLFxuICAgICAgICBvcHRpb25zLmFzc3VtZVJvbGVBcm4sXG4gICAgICAgIG9wdGlvbnMuYXNzdW1lUm9sZUV4dGVybmFsSWQsXG4gICAgICAgIG9wdGlvbnMuYXNzdW1lUm9sZUFkZGl0aW9uYWxPcHRpb25zLFxuICAgICAgICBlbnYucmVnaW9uLFxuICAgICAgKTtcblxuICAgICAgcmV0dXJuIHsgc2RrLCBkaWRBc3N1bWVSb2xlOiB0cnVlIH07XG4gICAgfSBjYXRjaCAoZXJyOiBhbnkpIHtcbiAgICAgIGlmIChlcnIubmFtZSA9PT0gJ0V4cGlyZWRUb2tlbicpIHtcbiAgICAgICAgdGhyb3cgZXJyO1xuICAgICAgfVxuXG4gICAgICAvLyBBc3N1bWVSb2xlIGZhaWxlZC4gUHJvY2VlZCBhbmQgd2FybiAqaWYgYW5kIG9ubHkgaWYqIHRoZSBiYXNlQ3JlZGVudGlhbHMgd2VyZSBhbHJlYWR5IGZvciB0aGUgcmlnaHQgYWNjb3VudFxuICAgICAgLy8gb3IgcmV0dXJuZWQgZnJvbSBhIHBsdWdpbi4gVGhpcyBpcyB0byBjb3ZlciBzb21lIGN1cnJlbnQgc2V0dXBzIGZvciBwZW9wbGUgdXNpbmcgcGx1Z2lucyBvciBwcmVmZXJyaW5nIHRvXG4gICAgICAvLyBmZWVkIHRoZSBDTEkgY3JlZGVudGlhbHMgd2hpY2ggYXJlIHN1ZmZpY2llbnQgYnkgdGhlbXNlbHZlcy4gUHJlZmVyIHRvIGFzc3VtZSB0aGUgY29ycmVjdCByb2xlIGlmIHdlIGNhbixcbiAgICAgIC8vIGJ1dCBpZiB3ZSBjYW4ndCB0aGVuIGxldCdzIGp1c3QgdHJ5IHdpdGggYXZhaWxhYmxlIGNyZWRlbnRpYWxzIGFueXdheS5cbiAgICAgIGlmIChiYXNlQ3JlZHMuc291cmNlID09PSAnY29ycmVjdERlZmF1bHQnIHx8IGJhc2VDcmVkcy5zb3VyY2UgPT09ICdwbHVnaW4nKSB7XG4gICAgICAgIGRlYnVnKGVyci5tZXNzYWdlKTtcbiAgICAgICAgY29uc3QgbG9nZ2VyID0gcXVpZXQgPyBkZWJ1ZyA6IHdhcm5pbmc7XG4gICAgICAgIGxvZ2dlcihcbiAgICAgICAgICBgJHtmbXRPYnRhaW5lZENyZWRlbnRpYWxzKGJhc2VDcmVkcyl9IGNvdWxkIG5vdCBiZSB1c2VkIHRvIGFzc3VtZSAnJHtvcHRpb25zLmFzc3VtZVJvbGVBcm59JywgYnV0IGFyZSBmb3IgdGhlIHJpZ2h0IGFjY291bnQuIFByb2NlZWRpbmcgYW55d2F5LmAsXG4gICAgICAgICk7XG4gICAgICAgIHJldHVybiB7XG4gICAgICAgICAgc2RrOiBuZXcgU0RLKGJhc2VDcmVkcy5jcmVkZW50aWFscywgZW52LnJlZ2lvbiwgdGhpcy5yZXF1ZXN0SGFuZGxlciksXG4gICAgICAgICAgZGlkQXNzdW1lUm9sZTogZmFsc2UsXG4gICAgICAgIH07XG4gICAgICB9XG5cbiAgICAgIHRocm93IGVycjtcbiAgICB9XG4gIH1cblxuICAvKipcbiAgICogUmV0dXJuIHRoZSBwYXJ0aXRpb24gdGhhdCBiYXNlIGNyZWRlbnRpYWxzIGFyZSBmb3JcbiAgICpcbiAgICogUmV0dXJucyBgdW5kZWZpbmVkYCBpZiB0aGVyZSBhcmUgbm8gYmFzZSBjcmVkZW50aWFscy5cbiAgICovXG4gIHB1YmxpYyBhc3luYyBiYXNlQ3JlZGVudGlhbHNQYXJ0aXRpb24oZW52aXJvbm1lbnQ6IEVudmlyb25tZW50LCBtb2RlOiBNb2RlKTogUHJvbWlzZTxzdHJpbmcgfCB1bmRlZmluZWQ+IHtcbiAgICBjb25zdCBlbnYgPSBhd2FpdCB0aGlzLnJlc29sdmVFbnZpcm9ubWVudChlbnZpcm9ubWVudCk7XG4gICAgY29uc3QgYmFzZUNyZWRzID0gYXdhaXQgdGhpcy5vYnRhaW5CYXNlQ3JlZGVudGlhbHMoZW52LmFjY291bnQsIG1vZGUpO1xuICAgIGlmIChiYXNlQ3JlZHMuc291cmNlID09PSAnbm9uZScpIHtcbiAgICAgIHJldHVybiB1bmRlZmluZWQ7XG4gICAgfVxuICAgIHJldHVybiAoYXdhaXQgbmV3IFNESyhiYXNlQ3JlZHMuY3JlZGVudGlhbHMsIGVudi5yZWdpb24sIHRoaXMucmVxdWVzdEhhbmRsZXIpLmN1cnJlbnRBY2NvdW50KCkpLnBhcnRpdGlvbjtcbiAgfVxuXG4gIC8qKlxuICAgKiBSZXNvbHZlIHRoZSBlbnZpcm9ubWVudCBmb3IgYSBzdGFja1xuICAgKlxuICAgKiBSZXBsYWNlcyB0aGUgbWFnaWMgdmFsdWVzIGBVTktOT1dOX1JFR0lPTmAgYW5kIGBVTktOT1dOX0FDQ09VTlRgXG4gICAqIHdpdGggdGhlIGRlZmF1bHRzIGZvciB0aGUgY3VycmVudCBTREsgY29uZmlndXJhdGlvbiAoYH4vLmF3cy9jb25maWdgIG9yXG4gICAqIG90aGVyd2lzZSkuXG4gICAqXG4gICAqIEl0IGlzIGFuIGVycm9yIGlmIGBVTktOT1dOX0FDQ09VTlRgIGlzIHVzZWQgYnV0IHRoZSB1c2VyIGhhc24ndCBjb25maWd1cmVkXG4gICAqIGFueSBTREsgY3JlZGVudGlhbHMuXG4gICAqL1xuICBwdWJsaWMgYXN5bmMgcmVzb2x2ZUVudmlyb25tZW50KGVudjogRW52aXJvbm1lbnQpOiBQcm9taXNlPEVudmlyb25tZW50PiB7XG4gICAgY29uc3QgcmVnaW9uID0gZW52LnJlZ2lvbiAhPT0gVU5LTk9XTl9SRUdJT04gPyBlbnYucmVnaW9uIDogdGhpcy5kZWZhdWx0UmVnaW9uO1xuICAgIGNvbnN0IGFjY291bnQgPSBlbnYuYWNjb3VudCAhPT0gVU5LTk9XTl9BQ0NPVU5UID8gZW52LmFjY291bnQgOiAoYXdhaXQgdGhpcy5kZWZhdWx0QWNjb3VudCgpKT8uYWNjb3VudElkO1xuXG4gICAgaWYgKCFhY2NvdW50KSB7XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICAgICdVbmFibGUgdG8gcmVzb2x2ZSBBV1MgYWNjb3VudCB0byB1c2UuIEl0IG11c3QgYmUgZWl0aGVyIGNvbmZpZ3VyZWQgd2hlbiB5b3UgZGVmaW5lIHlvdXIgQ0RLIFN0YWNrLCBvciB0aHJvdWdoIHRoZSBlbnZpcm9ubWVudCcsXG4gICAgICApO1xuICAgIH1cblxuICAgIHJldHVybiB7XG4gICAgICByZWdpb24sXG4gICAgICBhY2NvdW50LFxuICAgICAgbmFtZTogRW52aXJvbm1lbnRVdGlscy5mb3JtYXQoYWNjb3VudCwgcmVnaW9uKSxcbiAgICB9O1xuICB9XG5cbiAgLyoqXG4gICAqIFRoZSBhY2NvdW50IHdlJ2QgYXV0aCBpbnRvIGlmIHdlIHVzZWQgZGVmYXVsdCBjcmVkZW50aWFscy5cbiAgICpcbiAgICogRGVmYXVsdCBjcmVkZW50aWFscyBhcmUgdGhlIHNldCBvZiBhbWJpZW50bHkgY29uZmlndXJlZCBjcmVkZW50aWFscyB1c2luZ1xuICAgKiBvbmUgb2YgdGhlIGVudmlyb25tZW50IHZhcmlhYmxlcywgb3Igfi8uYXdzL2NyZWRlbnRpYWxzLCBvciB0aGUgKm9uZSpcbiAgICogcHJvZmlsZSB0aGF0IHdhcyBwYXNzZWQgaW50byB0aGUgQ0xJLlxuICAgKlxuICAgKiBNaWdodCByZXR1cm4gdW5kZWZpbmVkIGlmIHRoZXJlIGFyZSBubyBkZWZhdWx0L2FtYmllbnQgY3JlZGVudGlhbHNcbiAgICogYXZhaWxhYmxlIChpbiB3aGljaCBjYXNlIHRoZSB1c2VyIHNob3VsZCBiZXR0ZXIgaG9wZSB0aGV5IGhhdmVcbiAgICogY3JlZGVudGlhbCBwbHVnaW5zIGNvbmZpZ3VyZWQpLlxuICAgKlxuICAgKiBVc2VzIGEgY2FjaGUgdG8gYXZvaWQgU1RTIGNhbGxzIGlmIHdlIGRvbid0IG5lZWQgJ2VtLlxuICAgKi9cbiAgcHVibGljIGFzeW5jIGRlZmF1bHRBY2NvdW50KCk6IFByb21pc2U8QWNjb3VudCB8IHVuZGVmaW5lZD4ge1xuICAgIHJldHVybiBjYWNoZWQodGhpcywgQ0FDSEVEX0FDQ09VTlQsIGFzeW5jICgpID0+IHtcbiAgICAgIHRyeSB7XG4gICAgICAgIGNvbnN0IGNyZWRlbnRpYWxzID0gYXdhaXQgdGhpcy5kZWZhdWx0Q3JlZGVudGlhbHMoKTtcbiAgICAgICAgY29uc3QgYWNjZXNzS2V5SWQgPSBjcmVkZW50aWFscy5hY2Nlc3NLZXlJZDtcbiAgICAgICAgaWYgKCFhY2Nlc3NLZXlJZCkge1xuICAgICAgICAgIHRocm93IG5ldyBFcnJvcignVW5hYmxlIHRvIHJlc29sdmUgQVdTIGNyZWRlbnRpYWxzIChzZXR1cCB3aXRoIFwiYXdzIGNvbmZpZ3VyZVwiKScpO1xuICAgICAgICB9XG5cbiAgICAgICAgcmV0dXJuIGF3YWl0IG5ldyBTREsoY3JlZGVudGlhbHMsIHRoaXMuZGVmYXVsdFJlZ2lvbiwgdGhpcy5yZXF1ZXN0SGFuZGxlcikuY3VycmVudEFjY291bnQoKTtcbiAgICAgIH0gY2F0Y2ggKGU6IGFueSkge1xuICAgICAgICAvLyBUcmVhdCAnRXhwaXJlZFRva2VuJyBzcGVjaWFsbHkuIFRoaXMgaXMgYSBjb21tb24gc2l0dWF0aW9uIHRoYXQgcGVvcGxlIG1heSBmaW5kIHRoZW1zZWx2ZXMgaW4sIGFuZFxuICAgICAgICAvLyB0aGV5IGFyZSBjb21wbGFpbmluZyBhYm91dCBpZiB3ZSBmYWlsICdjZGsgc3ludGgnIG9uIHRoZW0uIFdlIGxvdWRseSBjb21wbGFpbiBpbiBvcmRlciB0byBzaG93IHRoYXRcbiAgICAgICAgLy8gdGhlIGN1cnJlbnQgc2l0dWF0aW9uIGlzIHByb2JhYmx5IHVuZGVzaXJhYmxlLCBidXQgd2UgZG9uJ3QgZmFpbC5cbiAgICAgICAgaWYgKGUubmFtZSA9PT0gJ0V4cGlyZWRUb2tlbicpIHtcbiAgICAgICAgICB3YXJuaW5nKFxuICAgICAgICAgICAgJ1RoZXJlIGFyZSBleHBpcmVkIEFXUyBjcmVkZW50aWFscyBpbiB5b3VyIGVudmlyb25tZW50LiBUaGUgQ0RLIGFwcCB3aWxsIHN5bnRoIHdpdGhvdXQgY3VycmVudCBhY2NvdW50IGluZm9ybWF0aW9uLicsXG4gICAgICAgICAgKTtcbiAgICAgICAgICByZXR1cm4gdW5kZWZpbmVkO1xuICAgICAgICB9XG5cbiAgICAgICAgZGVidWcoYFVuYWJsZSB0byBkZXRlcm1pbmUgdGhlIGRlZmF1bHQgQVdTIGFjY291bnQgKCR7ZS5uYW1lfSk6ICR7ZS5tZXNzYWdlfWApO1xuICAgICAgICByZXR1cm4gdW5kZWZpbmVkO1xuICAgICAgfVxuICAgIH0pO1xuICB9XG5cbiAgLyoqXG4gICAqIEdldCBjcmVkZW50aWFscyBmb3IgdGhlIGdpdmVuIGFjY291bnQgSUQgaW4gdGhlIGdpdmVuIG1vZGVcbiAgICpcbiAgICogMS4gVXNlIHRoZSBkZWZhdWx0IGNyZWRlbnRpYWxzIGlmIHRoZSBkZXN0aW5hdGlvbiBhY2NvdW50IG1hdGNoZXMgdGhlXG4gICAqICAgIGN1cnJlbnQgY3JlZGVudGlhbHMnIGFjY291bnQuXG4gICAqIDIuIE90aGVyd2lzZSB0cnkgYWxsIGNyZWRlbnRpYWwgcGx1Z2lucy5cbiAgICogMy4gRmFpbCBpZiBuZWl0aGVyIG9mIHRoZXNlIHlpZWxkIGFueSBjcmVkZW50aWFscy5cbiAgICogNC4gUmV0dXJuIGEgZmFpbHVyZSBpZiBhbnkgb2YgdGhlbSByZXR1cm5lZCBjcmVkZW50aWFsc1xuICAgKi9cbiAgcHJpdmF0ZSBhc3luYyBvYnRhaW5CYXNlQ3JlZGVudGlhbHMoYWNjb3VudElkOiBzdHJpbmcsIG1vZGU6IE1vZGUpOiBQcm9taXNlPE9idGFpbkJhc2VDcmVkZW50aWFsc1Jlc3VsdD4ge1xuICAgIC8vIEZpcnN0IHRyeSAnY3VycmVudCcgY3JlZGVudGlhbHNcbiAgICBjb25zdCBkZWZhdWx0QWNjb3VudElkID0gKGF3YWl0IHRoaXMuZGVmYXVsdEFjY291bnQoKSk/LmFjY291bnRJZDtcbiAgICBpZiAoZGVmYXVsdEFjY291bnRJZCA9PT0gYWNjb3VudElkKSB7XG4gICAgICByZXR1cm4ge1xuICAgICAgICBzb3VyY2U6ICdjb3JyZWN0RGVmYXVsdCcsXG4gICAgICAgIGNyZWRlbnRpYWxzOiBhd2FpdCB0aGlzLmRlZmF1bHRDcmVkZW50aWFscygpLFxuICAgICAgfTtcbiAgICB9XG5cbiAgICAvLyBUaGVuIHRyeSB0aGUgcGx1Z2luc1xuICAgIGNvbnN0IHBsdWdpbkNyZWRzID0gYXdhaXQgdGhpcy5wbHVnaW5zLmZldGNoQ3JlZGVudGlhbHNGb3IoYWNjb3VudElkLCBtb2RlKTtcbiAgICBpZiAocGx1Z2luQ3JlZHMpIHtcbiAgICAgIHJldHVybiB7IHNvdXJjZTogJ3BsdWdpbicsIC4uLnBsdWdpbkNyZWRzIH07XG4gICAgfVxuXG4gICAgLy8gRmFsbCBiYWNrIHRvIGRlZmF1bHQgY3JlZGVudGlhbHMgd2l0aCBhIG5vdGUgdGhhdCB0aGV5J3JlIG5vdCB0aGUgcmlnaHQgb25lcyB5ZXRcbiAgICBpZiAoZGVmYXVsdEFjY291bnRJZCAhPT0gdW5kZWZpbmVkKSB7XG4gICAgICByZXR1cm4ge1xuICAgICAgICBzb3VyY2U6ICdpbmNvcnJlY3REZWZhdWx0JyxcbiAgICAgICAgYWNjb3VudElkOiBkZWZhdWx0QWNjb3VudElkLFxuICAgICAgICBjcmVkZW50aWFsczogYXdhaXQgdGhpcy5kZWZhdWx0Q3JlZGVudGlhbHMoKSxcbiAgICAgICAgdW51c2VkUGx1Z2luczogdGhpcy5wbHVnaW5zLmF2YWlsYWJsZVBsdWdpbk5hbWVzLFxuICAgICAgfTtcbiAgICB9XG5cbiAgICAvLyBBcHBhcmVudGx5IHdlIGRpZG4ndCBmaW5kIGFueSBhdCBhbGxcbiAgICByZXR1cm4ge1xuICAgICAgc291cmNlOiAnbm9uZScsXG4gICAgICB1bnVzZWRQbHVnaW5zOiB0aGlzLnBsdWdpbnMuYXZhaWxhYmxlUGx1Z2luTmFtZXMsXG4gICAgfTtcbiAgfVxuXG4gIC8qKlxuICAgKiBSZXNvbHZlIHRoZSBkZWZhdWx0IGNoYWluIHRvIHRoZSBmaXJzdCBzZXQgb2YgY3JlZGVudGlhbHMgdGhhdCBpcyBhdmFpbGFibGVcbiAgICovXG4gIHByaXZhdGUgYXN5bmMgZGVmYXVsdENyZWRlbnRpYWxzKCk6IFByb21pc2U8QXdzQ3JlZGVudGlhbElkZW50aXR5PiB7XG4gICAgcmV0dXJuIGNhY2hlZCh0aGlzLCBDQUNIRURfREVGQVVMVF9DUkVERU5USUFMUywgYXN5bmMgKCkgPT4ge1xuICAgICAgZGVidWcoJ1Jlc29sdmluZyBkZWZhdWx0IGNyZWRlbnRpYWxzJyk7XG4gICAgICByZXR1cm4gdGhpcy5kZWZhdWx0Q3JlZGVudGlhbFByb3ZpZGVyKCk7XG4gICAgfSk7XG4gIH1cblxuICAvKipcbiAgICogUmV0dXJuIGFuIFNESyB3aGljaCB1c2VzIGFzc3VtZWQgcm9sZSBjcmVkZW50aWFsc1xuICAgKlxuICAgKiBUaGUgYmFzZSBjcmVkZW50aWFscyB1c2VkIHRvIHJldHJpZXZlIHRoZSBhc3N1bWVkIHJvbGUgY3JlZGVudGlhbHMgd2lsbCBiZSB0aGVcbiAgICogc2FtZSBjcmVkZW50aWFscyByZXR1cm5lZCBieSBvYnRhaW5DcmVkZW50aWFscyBpZiBhbiBlbnZpcm9ubWVudCBhbmQgbW9kZSBpcyBwYXNzZWQsXG4gICAqIG90aGVyd2lzZSBpdCB3aWxsIGJlIHRoZSBjdXJyZW50IGNyZWRlbnRpYWxzLlxuICAgKi9cbiAgcHJpdmF0ZSBhc3luYyB3aXRoQXNzdW1lZFJvbGUoXG4gICAgbWFpbkNyZWRlbnRpYWxzOiBFeGNsdWRlPE9idGFpbkJhc2VDcmVkZW50aWFsc1Jlc3VsdCwgeyBzb3VyY2U6ICdub25lJyB9PixcbiAgICByb2xlQXJuOiBzdHJpbmcsXG4gICAgZXh0ZXJuYWxJZD86IHN0cmluZyxcbiAgICBhZGRpdGlvbmFsT3B0aW9ucz86IEFzc3VtZVJvbGVBZGRpdGlvbmFsT3B0aW9ucyxcbiAgICByZWdpb24/OiBzdHJpbmcsXG4gICk6IFByb21pc2U8U0RLPiB7XG4gICAgZGVidWcoYEFzc3VtaW5nIHJvbGUgJyR7cm9sZUFybn0nLmApO1xuXG4gICAgcmVnaW9uID0gcmVnaW9uID8/IHRoaXMuZGVmYXVsdFJlZ2lvbjtcblxuICAgIGNvbnN0IHNvdXJjZURlc2NyaXB0aW9uID0gZm10T2J0YWluZWRDcmVkZW50aWFscyhtYWluQ3JlZGVudGlhbHMpO1xuXG4gICAgdHJ5IHtcbiAgICAgIGNvbnN0IGNyZWRlbnRpYWxzID0gYXdhaXQgZnJvbVRlbXBvcmFyeUNyZWRlbnRpYWxzKHtcbiAgICAgICAgbWFzdGVyQ3JlZGVudGlhbHM6IG1haW5DcmVkZW50aWFscy5jcmVkZW50aWFscyxcbiAgICAgICAgcGFyYW1zOiB7XG4gICAgICAgICAgUm9sZUFybjogcm9sZUFybixcbiAgICAgICAgICBFeHRlcm5hbElkOiBleHRlcm5hbElkLFxuICAgICAgICAgIFJvbGVTZXNzaW9uTmFtZTogYGF3cy1jZGstJHtzYWZlVXNlcm5hbWUoKX1gLFxuICAgICAgICAgIC4uLmFkZGl0aW9uYWxPcHRpb25zLFxuICAgICAgICAgIFRyYW5zaXRpdmVUYWdLZXlzOiBhZGRpdGlvbmFsT3B0aW9ucz8uVGFncyA/IGFkZGl0aW9uYWxPcHRpb25zLlRhZ3MubWFwKCh0KSA9PiB0LktleSEpIDogdW5kZWZpbmVkLFxuICAgICAgICB9LFxuICAgICAgICBjbGllbnRDb25maWc6IHtcbiAgICAgICAgICByZWdpb24sXG4gICAgICAgICAgLi4udGhpcy5yZXF1ZXN0SGFuZGxlcixcbiAgICAgICAgfSxcbiAgICAgIH0pKCk7XG5cbiAgICAgIHJldHVybiBuZXcgU0RLKGNyZWRlbnRpYWxzLCByZWdpb24sIHRoaXMucmVxdWVzdEhhbmRsZXIpO1xuICAgIH0gY2F0Y2ggKGVycjogYW55KSB7XG4gICAgICBpZiAoZXJyLm5hbWUgPT09ICdFeHBpcmVkVG9rZW4nKSB7XG4gICAgICAgIHRocm93IGVycjtcbiAgICAgIH1cblxuICAgICAgZGVidWcoYEFzc3VtaW5nIHJvbGUgZmFpbGVkOiAke2Vyci5tZXNzYWdlfWApO1xuICAgICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgICBbXG4gICAgICAgICAgJ0NvdWxkIG5vdCBhc3N1bWUgcm9sZSBpbiB0YXJnZXQgYWNjb3VudCcsXG4gICAgICAgICAgLi4uKHNvdXJjZURlc2NyaXB0aW9uID8gW2B1c2luZyAke3NvdXJjZURlc2NyaXB0aW9ufWBdIDogW10pLFxuICAgICAgICAgIGVyci5tZXNzYWdlLFxuICAgICAgICAgIFwiLiBQbGVhc2UgbWFrZSBzdXJlIHRoYXQgdGhpcyByb2xlIGV4aXN0cyBpbiB0aGUgYWNjb3VudC4gSWYgaXQgZG9lc24ndCBleGlzdCwgKHJlKS1ib290c3RyYXAgdGhlIGVudmlyb25tZW50IFwiICtcbiAgICAgICAgICAgIFwid2l0aCB0aGUgcmlnaHQgJy0tdHJ1c3QnLCB1c2luZyB0aGUgbGF0ZXN0IHZlcnNpb24gb2YgdGhlIENESyBDTEkuXCIsXG4gICAgICAgIF0uam9pbignICcpLFxuICAgICAgKTtcbiAgICB9XG4gIH1cbn1cblxuLyoqXG4gKiBBbiBBV1MgYWNjb3VudFxuICpcbiAqIEFuIEFXUyBhY2NvdW50IGFsd2F5cyBleGlzdHMgaW4gb25seSBvbmUgcGFydGl0aW9uLiBVc3VhbGx5IHdlIGRvbid0IGNhcmUgYWJvdXRcbiAqIHRoZSBwYXJ0aXRpb24sIGJ1dCB3aGVuIHdlIG5lZWQgdG8gZm9ybSBBUk5zIHdlIGRvLlxuICovXG5leHBvcnQgaW50ZXJmYWNlIEFjY291bnQge1xuICAvKipcbiAgICogVGhlIGFjY291bnQgbnVtYmVyXG4gICAqL1xuICByZWFkb25seSBhY2NvdW50SWQ6IHN0cmluZztcblxuICAvKipcbiAgICogVGhlIHBhcnRpdGlvbiAoJ2F3cycgb3IgJ2F3cy1jbicgb3Igb3RoZXJ3aXNlKVxuICAgKi9cbiAgcmVhZG9ubHkgcGFydGl0aW9uOiBzdHJpbmc7XG59XG5cbi8qKlxuICogUmV0dXJuIHRoZSB1c2VybmFtZSB3aXRoIGNoYXJhY3RlcnMgaW52YWxpZCBmb3IgYSBSb2xlU2Vzc2lvbk5hbWUgcmVtb3ZlZFxuICpcbiAqIEBzZWUgaHR0cHM6Ly9kb2NzLmF3cy5hbWF6b24uY29tL1NUUy9sYXRlc3QvQVBJUmVmZXJlbmNlL0FQSV9Bc3N1bWVSb2xlLmh0bWwjQVBJX0Fzc3VtZVJvbGVfUmVxdWVzdFBhcmFtZXRlcnNcbiAqL1xuZnVuY3Rpb24gc2FmZVVzZXJuYW1lKCkge1xuICB0cnkge1xuICAgIHJldHVybiBvcy51c2VySW5mbygpLnVzZXJuYW1lLnJlcGxhY2UoL1teXFx3Kz0sLkAtXS9nLCAnQCcpO1xuICB9IGNhdGNoIHtcbiAgICByZXR1cm4gJ25vbmFtZSc7XG4gIH1cbn1cblxuLyoqXG4gKiBPcHRpb25zIGZvciBvYnRhaW5pbmcgY3JlZGVudGlhbHMgZm9yIGFuIGVudmlyb25tZW50XG4gKi9cbmV4cG9ydCBpbnRlcmZhY2UgQ3JlZGVudGlhbHNPcHRpb25zIHtcbiAgLyoqXG4gICAqIFRoZSBBUk4gb2YgdGhlIHJvbGUgdGhhdCBuZWVkcyB0byBiZSBhc3N1bWVkLCBpZiBhbnlcbiAgICovXG4gIHJlYWRvbmx5IGFzc3VtZVJvbGVBcm4/OiBzdHJpbmc7XG5cbiAgLyoqXG4gICAqIEV4dGVybmFsIElEIHJlcXVpcmVkIHRvIGFzc3VtZSB0aGUgZ2l2ZW4gcm9sZS5cbiAgICovXG4gIHJlYWRvbmx5IGFzc3VtZVJvbGVFeHRlcm5hbElkPzogc3RyaW5nO1xuXG4gIC8qKlxuICAgKiBTZXNzaW9uIHRhZ3MgcmVxdWlyZWQgdG8gYXNzdW1lIHRoZSBnaXZlbiByb2xlLlxuICAgKi9cbiAgcmVhZG9ubHkgYXNzdW1lUm9sZUFkZGl0aW9uYWxPcHRpb25zPzogQXNzdW1lUm9sZUFkZGl0aW9uYWxPcHRpb25zO1xufVxuXG4vKipcbiAqIFJlc3VsdCBvZiBvYnRhaW5pbmcgYmFzZSBjcmVkZW50aWFsc1xuICovXG50eXBlIE9idGFpbkJhc2VDcmVkZW50aWFsc1Jlc3VsdCA9XG4gIHwgeyBzb3VyY2U6ICdjb3JyZWN0RGVmYXVsdCc7IGNyZWRlbnRpYWxzOiBBd3NDcmVkZW50aWFsSWRlbnRpdHkgfVxuICB8IHsgc291cmNlOiAncGx1Z2luJzsgcGx1Z2luTmFtZTogc3RyaW5nOyBjcmVkZW50aWFsczogQXdzQ3JlZGVudGlhbElkZW50aXR5IH1cbiAgfCB7XG4gICAgc291cmNlOiAnaW5jb3JyZWN0RGVmYXVsdCc7XG4gICAgY3JlZGVudGlhbHM6IEF3c0NyZWRlbnRpYWxJZGVudGl0eTtcbiAgICBhY2NvdW50SWQ6IHN0cmluZztcbiAgICB1bnVzZWRQbHVnaW5zOiBzdHJpbmdbXTtcbiAgfVxuICB8IHsgc291cmNlOiAnbm9uZSc7IHVudXNlZFBsdWdpbnM6IHN0cmluZ1tdIH07XG5cbi8qKlxuICogSXNvbGF0aW5nIHRoZSBjb2RlIHRoYXQgdHJhbnNsYXRlcyBjYWxjdWxhdGlvbiBlcnJvcnMgaW50byBodW1hbiBlcnJvciBtZXNzYWdlc1xuICpcbiAqIFdlIGNvdmVyIHRoZSBmb2xsb3dpbmcgY2FzZXM6XG4gKlxuICogLSBObyBjcmVkZW50aWFscyBhcmUgYXZhaWxhYmxlIGF0IGFsbFxuICogLSBEZWZhdWx0IGNyZWRlbnRpYWxzIGFyZSBmb3IgdGhlIHdyb25nIGFjY291bnRcbiAqL1xuZnVuY3Rpb24gZm10T2J0YWluQ3JlZGVudGlhbHNFcnJvcihcbiAgdGFyZ2V0QWNjb3VudElkOiBzdHJpbmcsXG4gIG9idGFpblJlc3VsdDogT2J0YWluQmFzZUNyZWRlbnRpYWxzUmVzdWx0ICYge1xuICAgIHNvdXJjZTogJ25vbmUnIHwgJ2luY29ycmVjdERlZmF1bHQnO1xuICB9LFxuKTogc3RyaW5nIHtcbiAgY29uc3QgbXNnID0gW2BOZWVkIHRvIHBlcmZvcm0gQVdTIGNhbGxzIGZvciBhY2NvdW50ICR7dGFyZ2V0QWNjb3VudElkfWBdO1xuICBzd2l0Y2ggKG9idGFpblJlc3VsdC5zb3VyY2UpIHtcbiAgICBjYXNlICdpbmNvcnJlY3REZWZhdWx0JzpcbiAgICAgIG1zZy5wdXNoKGBidXQgdGhlIGN1cnJlbnQgY3JlZGVudGlhbHMgYXJlIGZvciAke29idGFpblJlc3VsdC5hY2NvdW50SWR9YCk7XG4gICAgICBicmVhaztcbiAgICBjYXNlICdub25lJzpcbiAgICAgIG1zZy5wdXNoKCdidXQgbm8gY3JlZGVudGlhbHMgaGF2ZSBiZWVuIGNvbmZpZ3VyZWQnKTtcbiAgfVxuICBpZiAob2J0YWluUmVzdWx0LnVudXNlZFBsdWdpbnMubGVuZ3RoID4gMCkge1xuICAgIG1zZy5wdXNoKGBhbmQgbm9uZSBvZiB0aGVzZSBwbHVnaW5zIGZvdW5kIGFueTogJHtvYnRhaW5SZXN1bHQudW51c2VkUGx1Z2lucy5qb2luKCcsICcpfWApO1xuICB9XG4gIHJldHVybiBtc2cuam9pbignLCAnKTtcbn1cblxuLyoqXG4gKiBGb3JtYXQgYSBtZXNzYWdlIGluZGljYXRpbmcgd2hlcmUgd2UgZ290IGJhc2UgY3JlZGVudGlhbHMgZm9yIHRoZSBhc3N1bWUgcm9sZVxuICpcbiAqIFdlIGNvdmVyIHRoZSBmb2xsb3dpbmcgY2FzZXM6XG4gKlxuICogLSBEZWZhdWx0IGNyZWRlbnRpYWxzIGZvciB0aGUgcmlnaHQgYWNjb3VudFxuICogLSBEZWZhdWx0IGNyZWRlbnRpYWxzIGZvciB0aGUgd3JvbmcgYWNjb3VudFxuICogLSBDcmVkZW50aWFscyByZXR1cm5lZCBmcm9tIGEgcGx1Z2luXG4gKi9cbmZ1bmN0aW9uIGZtdE9idGFpbmVkQ3JlZGVudGlhbHMob2J0YWluUmVzdWx0OiBFeGNsdWRlPE9idGFpbkJhc2VDcmVkZW50aWFsc1Jlc3VsdCwgeyBzb3VyY2U6ICdub25lJyB9Pik6IHN0cmluZyB7XG4gIHN3aXRjaCAob2J0YWluUmVzdWx0LnNvdXJjZSkge1xuICAgIGNhc2UgJ2NvcnJlY3REZWZhdWx0JzpcbiAgICAgIHJldHVybiAnY3VycmVudCBjcmVkZW50aWFscyc7XG4gICAgY2FzZSAncGx1Z2luJzpcbiAgICAgIHJldHVybiBgY3JlZGVudGlhbHMgcmV0dXJuZWQgYnkgcGx1Z2luICcke29idGFpblJlc3VsdC5wbHVnaW5OYW1lfSdgO1xuICAgIGNhc2UgJ2luY29ycmVjdERlZmF1bHQnOlxuICAgICAgY29uc3QgbXNnID0gW107XG4gICAgICBtc2cucHVzaChgY3VycmVudCBjcmVkZW50aWFscyAod2hpY2ggYXJlIGZvciBhY2NvdW50ICR7b2J0YWluUmVzdWx0LmFjY291bnRJZH1gKTtcblxuICAgICAgaWYgKG9idGFpblJlc3VsdC51bnVzZWRQbHVnaW5zLmxlbmd0aCA+IDApIHtcbiAgICAgICAgbXNnLnB1c2goYCwgYW5kIG5vbmUgb2YgdGhlIGZvbGxvd2luZyBwbHVnaW5zIHByb3ZpZGVkIGNyZWRlbnRpYWxzOiAke29idGFpblJlc3VsdC51bnVzZWRQbHVnaW5zLmpvaW4oJywgJyl9YCk7XG4gICAgICB9XG4gICAgICBtc2cucHVzaCgnKScpO1xuXG4gICAgICByZXR1cm4gbXNnLmpvaW4oJycpO1xuICB9XG59XG5cbi8qKlxuICogSW5zdGFudGlhdGUgYW4gU0RLIGZvciBjb250ZXh0IHByb3ZpZGVycy4gVGhpcyBmdW5jdGlvbiBlbnN1cmVzIHRoYXQgYWxsXG4gKiBsb29rdXAgYXNzdW1lIHJvbGUgb3B0aW9ucyBhcmUgdXNlZCB3aGVuIGNvbnRleHQgcHJvdmlkZXJzIHBlcmZvcm0gbG9va3Vwcy5cbiAqL1xuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIGluaXRDb250ZXh0UHJvdmlkZXJTZGsoYXdzOiBTZGtQcm92aWRlciwgb3B0aW9uczogQ29udGV4dExvb2t1cFJvbGVPcHRpb25zKTogUHJvbWlzZTxTREs+IHtcbiAgY29uc3QgYWNjb3VudCA9IG9wdGlvbnMuYWNjb3VudDtcbiAgY29uc3QgcmVnaW9uID0gb3B0aW9ucy5yZWdpb247XG5cbiAgY29uc3QgY3JlZHM6IENyZWRlbnRpYWxzT3B0aW9ucyA9IHtcbiAgICBhc3N1bWVSb2xlQXJuOiBvcHRpb25zLmxvb2t1cFJvbGVBcm4sXG4gICAgYXNzdW1lUm9sZUV4dGVybmFsSWQ6IG9wdGlvbnMubG9va3VwUm9sZUV4dGVybmFsSWQsXG4gICAgYXNzdW1lUm9sZUFkZGl0aW9uYWxPcHRpb25zOiBvcHRpb25zLmFzc3VtZVJvbGVBZGRpdGlvbmFsT3B0aW9ucyxcbiAgfTtcblxuICByZXR1cm4gKGF3YWl0IGF3cy5mb3JFbnZpcm9ubWVudChFbnZpcm9ubWVudFV0aWxzLm1ha2UoYWNjb3VudCwgcmVnaW9uKSwgTW9kZS5Gb3JSZWFkaW5nLCBjcmVkcykpLnNkaztcbn1cbiJdfQ==