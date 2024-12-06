"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.CredentialPlugins = void 0;
const logging_1 = require("../../logging");
const plugin_1 = require("../plugin");
/**
 * Cache for credential providers.
 *
 * Given an account and an operating mode (read or write) will return an
 * appropriate credential provider for credentials for the given account. The
 * credential provider will be cached so that multiple AWS clients for the same
 * environment will not make multiple network calls to obtain credentials.
 *
 * Will use default credentials if they are for the right account; otherwise,
 * all loaded credential provider plugins will be tried to obtain credentials
 * for the given account.
 */
class CredentialPlugins {
    constructor() {
        this.cache = {};
    }
    async fetchCredentialsFor(awsAccountId, mode) {
        const key = `${awsAccountId}-${mode}`;
        if (!(key in this.cache)) {
            this.cache[key] = await this.lookupCredentials(awsAccountId, mode);
        }
        return this.cache[key];
    }
    get availablePluginNames() {
        return plugin_1.PluginHost.instance.credentialProviderSources.map((s) => s.name);
    }
    async lookupCredentials(awsAccountId, mode) {
        const triedSources = [];
        // Otherwise, inspect the various credential sources we have
        for (const source of plugin_1.PluginHost.instance.credentialProviderSources) {
            let available;
            try {
                available = await source.isAvailable();
            }
            catch (e) {
                // This shouldn't happen, but let's guard against it anyway
                (0, logging_1.warning)(`Uncaught exception in ${source.name}: ${e.message}`);
                available = false;
            }
            if (!available) {
                (0, logging_1.debug)('Credentials source %s is not available, ignoring it.', source.name);
                continue;
            }
            triedSources.push(source);
            let canProvide;
            try {
                canProvide = await source.canProvideCredentials(awsAccountId);
            }
            catch (e) {
                // This shouldn't happen, but let's guard against it anyway
                (0, logging_1.warning)(`Uncaught exception in ${source.name}: ${e.message}`);
                canProvide = false;
            }
            if (!canProvide) {
                continue;
            }
            (0, logging_1.debug)(`Using ${source.name} credentials for account ${awsAccountId}`);
            const providerOrCreds = await source.getProvider(awsAccountId, mode);
            // Backwards compatibility: if the plugin returns a ProviderChain, resolve that chain.
            // Otherwise it must have returned credentials.
            const credentials = providerOrCreds.resolvePromise
                ? await providerOrCreds.resolvePromise()
                : providerOrCreds;
            // Another layer of backwards compatibility: in SDK v2, the credentials object
            // is both a container and a provider. So we need to force the refresh using getPromise.
            // In SDK v3, these two responsibilities are separate, and the getPromise doesn't exist.
            if (credentials.getPromise) {
                await credentials.getPromise();
            }
            return { credentials, pluginName: source.name };
        }
        return undefined;
    }
}
exports.CredentialPlugins = CredentialPlugins;
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiY3JlZGVudGlhbC1wbHVnaW5zLmpzIiwic291cmNlUm9vdCI6IiIsInNvdXJjZXMiOlsiY3JlZGVudGlhbC1wbHVnaW5zLnRzIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiI7OztBQUNBLDJDQUErQztBQUMvQyxzQ0FBdUU7QUFFdkU7Ozs7Ozs7Ozs7O0dBV0c7QUFDSCxNQUFhLGlCQUFpQjtJQUE5QjtRQUNtQixVQUFLLEdBQXFELEVBQUUsQ0FBQztJQStEaEYsQ0FBQztJQTdEUSxLQUFLLENBQUMsbUJBQW1CLENBQUMsWUFBb0IsRUFBRSxJQUFVO1FBQy9ELE1BQU0sR0FBRyxHQUFHLEdBQUcsWUFBWSxJQUFJLElBQUksRUFBRSxDQUFDO1FBQ3RDLElBQUksQ0FBQyxDQUFDLEdBQUcsSUFBSSxJQUFJLENBQUMsS0FBSyxDQUFDLEVBQUUsQ0FBQztZQUN6QixJQUFJLENBQUMsS0FBSyxDQUFDLEdBQUcsQ0FBQyxHQUFHLE1BQU0sSUFBSSxDQUFDLGlCQUFpQixDQUFDLFlBQVksRUFBRSxJQUFJLENBQUMsQ0FBQztRQUNyRSxDQUFDO1FBQ0QsT0FBTyxJQUFJLENBQUMsS0FBSyxDQUFDLEdBQUcsQ0FBQyxDQUFDO0lBQ3pCLENBQUM7SUFFRCxJQUFXLG9CQUFvQjtRQUM3QixPQUFPLG1CQUFVLENBQUMsUUFBUSxDQUFDLHlCQUF5QixDQUFDLEdBQUcsQ0FBQyxDQUFDLENBQUMsRUFBRSxFQUFFLENBQUMsQ0FBQyxDQUFDLElBQUksQ0FBQyxDQUFDO0lBQzFFLENBQUM7SUFFTyxLQUFLLENBQUMsaUJBQWlCLENBQUMsWUFBb0IsRUFBRSxJQUFVO1FBQzlELE1BQU0sWUFBWSxHQUErQixFQUFFLENBQUM7UUFDcEQsNERBQTREO1FBQzVELEtBQUssTUFBTSxNQUFNLElBQUksbUJBQVUsQ0FBQyxRQUFRLENBQUMseUJBQXlCLEVBQUUsQ0FBQztZQUNuRSxJQUFJLFNBQWtCLENBQUM7WUFDdkIsSUFBSSxDQUFDO2dCQUNILFNBQVMsR0FBRyxNQUFNLE1BQU0sQ0FBQyxXQUFXLEVBQUUsQ0FBQztZQUN6QyxDQUFDO1lBQUMsT0FBTyxDQUFNLEVBQUUsQ0FBQztnQkFDaEIsMkRBQTJEO2dCQUMzRCxJQUFBLGlCQUFPLEVBQUMseUJBQXlCLE1BQU0sQ0FBQyxJQUFJLEtBQUssQ0FBQyxDQUFDLE9BQU8sRUFBRSxDQUFDLENBQUM7Z0JBQzlELFNBQVMsR0FBRyxLQUFLLENBQUM7WUFDcEIsQ0FBQztZQUVELElBQUksQ0FBQyxTQUFTLEVBQUUsQ0FBQztnQkFDZixJQUFBLGVBQUssRUFBQyxzREFBc0QsRUFBRSxNQUFNLENBQUMsSUFBSSxDQUFDLENBQUM7Z0JBQzNFLFNBQVM7WUFDWCxDQUFDO1lBQ0QsWUFBWSxDQUFDLElBQUksQ0FBQyxNQUFNLENBQUMsQ0FBQztZQUMxQixJQUFJLFVBQW1CLENBQUM7WUFDeEIsSUFBSSxDQUFDO2dCQUNILFVBQVUsR0FBRyxNQUFNLE1BQU0sQ0FBQyxxQkFBcUIsQ0FBQyxZQUFZLENBQUMsQ0FBQztZQUNoRSxDQUFDO1lBQUMsT0FBTyxDQUFNLEVBQUUsQ0FBQztnQkFDaEIsMkRBQTJEO2dCQUMzRCxJQUFBLGlCQUFPLEVBQUMseUJBQXlCLE1BQU0sQ0FBQyxJQUFJLEtBQUssQ0FBQyxDQUFDLE9BQU8sRUFBRSxDQUFDLENBQUM7Z0JBQzlELFVBQVUsR0FBRyxLQUFLLENBQUM7WUFDckIsQ0FBQztZQUNELElBQUksQ0FBQyxVQUFVLEVBQUUsQ0FBQztnQkFDaEIsU0FBUztZQUNYLENBQUM7WUFDRCxJQUFBLGVBQUssRUFBQyxTQUFTLE1BQU0sQ0FBQyxJQUFJLDRCQUE0QixZQUFZLEVBQUUsQ0FBQyxDQUFDO1lBQ3RFLE1BQU0sZUFBZSxHQUFHLE1BQU0sTUFBTSxDQUFDLFdBQVcsQ0FBQyxZQUFZLEVBQUUsSUFBSSxDQUFDLENBQUM7WUFFckUsc0ZBQXNGO1lBQ3RGLCtDQUErQztZQUMvQyxNQUFNLFdBQVcsR0FBSSxlQUF1QixDQUFDLGNBQWM7Z0JBQ3pELENBQUMsQ0FBQyxNQUFPLGVBQXVCLENBQUMsY0FBYyxFQUFFO2dCQUNqRCxDQUFDLENBQUMsZUFBZSxDQUFDO1lBRXBCLDhFQUE4RTtZQUM5RSx3RkFBd0Y7WUFDeEYsd0ZBQXdGO1lBQ3hGLElBQUssV0FBbUIsQ0FBQyxVQUFVLEVBQUUsQ0FBQztnQkFDcEMsTUFBTyxXQUFtQixDQUFDLFVBQVUsRUFBRSxDQUFDO1lBQzFDLENBQUM7WUFFRCxPQUFPLEVBQUUsV0FBVyxFQUFFLFVBQVUsRUFBRSxNQUFNLENBQUMsSUFBSSxFQUFFLENBQUM7UUFDbEQsQ0FBQztRQUNELE9BQU8sU0FBUyxDQUFDO0lBQ25CLENBQUM7Q0FDRjtBQWhFRCw4Q0FnRUMiLCJzb3VyY2VzQ29udGVudCI6WyJpbXBvcnQgdHlwZSB7IEF3c0NyZWRlbnRpYWxJZGVudGl0eSB9IGZyb20gJ0BzbWl0aHkvdHlwZXMnO1xuaW1wb3J0IHsgZGVidWcsIHdhcm5pbmcgfSBmcm9tICcuLi8uLi9sb2dnaW5nJztcbmltcG9ydCB7IENyZWRlbnRpYWxQcm92aWRlclNvdXJjZSwgTW9kZSwgUGx1Z2luSG9zdCB9IGZyb20gJy4uL3BsdWdpbic7XG5cbi8qKlxuICogQ2FjaGUgZm9yIGNyZWRlbnRpYWwgcHJvdmlkZXJzLlxuICpcbiAqIEdpdmVuIGFuIGFjY291bnQgYW5kIGFuIG9wZXJhdGluZyBtb2RlIChyZWFkIG9yIHdyaXRlKSB3aWxsIHJldHVybiBhblxuICogYXBwcm9wcmlhdGUgY3JlZGVudGlhbCBwcm92aWRlciBmb3IgY3JlZGVudGlhbHMgZm9yIHRoZSBnaXZlbiBhY2NvdW50LiBUaGVcbiAqIGNyZWRlbnRpYWwgcHJvdmlkZXIgd2lsbCBiZSBjYWNoZWQgc28gdGhhdCBtdWx0aXBsZSBBV1MgY2xpZW50cyBmb3IgdGhlIHNhbWVcbiAqIGVudmlyb25tZW50IHdpbGwgbm90IG1ha2UgbXVsdGlwbGUgbmV0d29yayBjYWxscyB0byBvYnRhaW4gY3JlZGVudGlhbHMuXG4gKlxuICogV2lsbCB1c2UgZGVmYXVsdCBjcmVkZW50aWFscyBpZiB0aGV5IGFyZSBmb3IgdGhlIHJpZ2h0IGFjY291bnQ7IG90aGVyd2lzZSxcbiAqIGFsbCBsb2FkZWQgY3JlZGVudGlhbCBwcm92aWRlciBwbHVnaW5zIHdpbGwgYmUgdHJpZWQgdG8gb2J0YWluIGNyZWRlbnRpYWxzXG4gKiBmb3IgdGhlIGdpdmVuIGFjY291bnQuXG4gKi9cbmV4cG9ydCBjbGFzcyBDcmVkZW50aWFsUGx1Z2lucyB7XG4gIHByaXZhdGUgcmVhZG9ubHkgY2FjaGU6IHsgW2tleTogc3RyaW5nXTogUGx1Z2luQ3JlZGVudGlhbHMgfCB1bmRlZmluZWQgfSA9IHt9O1xuXG4gIHB1YmxpYyBhc3luYyBmZXRjaENyZWRlbnRpYWxzRm9yKGF3c0FjY291bnRJZDogc3RyaW5nLCBtb2RlOiBNb2RlKTogUHJvbWlzZTxQbHVnaW5DcmVkZW50aWFscyB8IHVuZGVmaW5lZD4ge1xuICAgIGNvbnN0IGtleSA9IGAke2F3c0FjY291bnRJZH0tJHttb2RlfWA7XG4gICAgaWYgKCEoa2V5IGluIHRoaXMuY2FjaGUpKSB7XG4gICAgICB0aGlzLmNhY2hlW2tleV0gPSBhd2FpdCB0aGlzLmxvb2t1cENyZWRlbnRpYWxzKGF3c0FjY291bnRJZCwgbW9kZSk7XG4gICAgfVxuICAgIHJldHVybiB0aGlzLmNhY2hlW2tleV07XG4gIH1cblxuICBwdWJsaWMgZ2V0IGF2YWlsYWJsZVBsdWdpbk5hbWVzKCk6IHN0cmluZ1tdIHtcbiAgICByZXR1cm4gUGx1Z2luSG9zdC5pbnN0YW5jZS5jcmVkZW50aWFsUHJvdmlkZXJTb3VyY2VzLm1hcCgocykgPT4gcy5uYW1lKTtcbiAgfVxuXG4gIHByaXZhdGUgYXN5bmMgbG9va3VwQ3JlZGVudGlhbHMoYXdzQWNjb3VudElkOiBzdHJpbmcsIG1vZGU6IE1vZGUpOiBQcm9taXNlPFBsdWdpbkNyZWRlbnRpYWxzIHwgdW5kZWZpbmVkPiB7XG4gICAgY29uc3QgdHJpZWRTb3VyY2VzOiBDcmVkZW50aWFsUHJvdmlkZXJTb3VyY2VbXSA9IFtdO1xuICAgIC8vIE90aGVyd2lzZSwgaW5zcGVjdCB0aGUgdmFyaW91cyBjcmVkZW50aWFsIHNvdXJjZXMgd2UgaGF2ZVxuICAgIGZvciAoY29uc3Qgc291cmNlIG9mIFBsdWdpbkhvc3QuaW5zdGFuY2UuY3JlZGVudGlhbFByb3ZpZGVyU291cmNlcykge1xuICAgICAgbGV0IGF2YWlsYWJsZTogYm9vbGVhbjtcbiAgICAgIHRyeSB7XG4gICAgICAgIGF2YWlsYWJsZSA9IGF3YWl0IHNvdXJjZS5pc0F2YWlsYWJsZSgpO1xuICAgICAgfSBjYXRjaCAoZTogYW55KSB7XG4gICAgICAgIC8vIFRoaXMgc2hvdWxkbid0IGhhcHBlbiwgYnV0IGxldCdzIGd1YXJkIGFnYWluc3QgaXQgYW55d2F5XG4gICAgICAgIHdhcm5pbmcoYFVuY2F1Z2h0IGV4Y2VwdGlvbiBpbiAke3NvdXJjZS5uYW1lfTogJHtlLm1lc3NhZ2V9YCk7XG4gICAgICAgIGF2YWlsYWJsZSA9IGZhbHNlO1xuICAgICAgfVxuXG4gICAgICBpZiAoIWF2YWlsYWJsZSkge1xuICAgICAgICBkZWJ1ZygnQ3JlZGVudGlhbHMgc291cmNlICVzIGlzIG5vdCBhdmFpbGFibGUsIGlnbm9yaW5nIGl0LicsIHNvdXJjZS5uYW1lKTtcbiAgICAgICAgY29udGludWU7XG4gICAgICB9XG4gICAgICB0cmllZFNvdXJjZXMucHVzaChzb3VyY2UpO1xuICAgICAgbGV0IGNhblByb3ZpZGU6IGJvb2xlYW47XG4gICAgICB0cnkge1xuICAgICAgICBjYW5Qcm92aWRlID0gYXdhaXQgc291cmNlLmNhblByb3ZpZGVDcmVkZW50aWFscyhhd3NBY2NvdW50SWQpO1xuICAgICAgfSBjYXRjaCAoZTogYW55KSB7XG4gICAgICAgIC8vIFRoaXMgc2hvdWxkbid0IGhhcHBlbiwgYnV0IGxldCdzIGd1YXJkIGFnYWluc3QgaXQgYW55d2F5XG4gICAgICAgIHdhcm5pbmcoYFVuY2F1Z2h0IGV4Y2VwdGlvbiBpbiAke3NvdXJjZS5uYW1lfTogJHtlLm1lc3NhZ2V9YCk7XG4gICAgICAgIGNhblByb3ZpZGUgPSBmYWxzZTtcbiAgICAgIH1cbiAgICAgIGlmICghY2FuUHJvdmlkZSkge1xuICAgICAgICBjb250aW51ZTtcbiAgICAgIH1cbiAgICAgIGRlYnVnKGBVc2luZyAke3NvdXJjZS5uYW1lfSBjcmVkZW50aWFscyBmb3IgYWNjb3VudCAke2F3c0FjY291bnRJZH1gKTtcbiAgICAgIGNvbnN0IHByb3ZpZGVyT3JDcmVkcyA9IGF3YWl0IHNvdXJjZS5nZXRQcm92aWRlcihhd3NBY2NvdW50SWQsIG1vZGUpO1xuXG4gICAgICAvLyBCYWNrd2FyZHMgY29tcGF0aWJpbGl0eTogaWYgdGhlIHBsdWdpbiByZXR1cm5zIGEgUHJvdmlkZXJDaGFpbiwgcmVzb2x2ZSB0aGF0IGNoYWluLlxuICAgICAgLy8gT3RoZXJ3aXNlIGl0IG11c3QgaGF2ZSByZXR1cm5lZCBjcmVkZW50aWFscy5cbiAgICAgIGNvbnN0IGNyZWRlbnRpYWxzID0gKHByb3ZpZGVyT3JDcmVkcyBhcyBhbnkpLnJlc29sdmVQcm9taXNlXG4gICAgICAgID8gYXdhaXQgKHByb3ZpZGVyT3JDcmVkcyBhcyBhbnkpLnJlc29sdmVQcm9taXNlKClcbiAgICAgICAgOiBwcm92aWRlck9yQ3JlZHM7XG5cbiAgICAgIC8vIEFub3RoZXIgbGF5ZXIgb2YgYmFja3dhcmRzIGNvbXBhdGliaWxpdHk6IGluIFNESyB2MiwgdGhlIGNyZWRlbnRpYWxzIG9iamVjdFxuICAgICAgLy8gaXMgYm90aCBhIGNvbnRhaW5lciBhbmQgYSBwcm92aWRlci4gU28gd2UgbmVlZCB0byBmb3JjZSB0aGUgcmVmcmVzaCB1c2luZyBnZXRQcm9taXNlLlxuICAgICAgLy8gSW4gU0RLIHYzLCB0aGVzZSB0d28gcmVzcG9uc2liaWxpdGllcyBhcmUgc2VwYXJhdGUsIGFuZCB0aGUgZ2V0UHJvbWlzZSBkb2Vzbid0IGV4aXN0LlxuICAgICAgaWYgKChjcmVkZW50aWFscyBhcyBhbnkpLmdldFByb21pc2UpIHtcbiAgICAgICAgYXdhaXQgKGNyZWRlbnRpYWxzIGFzIGFueSkuZ2V0UHJvbWlzZSgpO1xuICAgICAgfVxuXG4gICAgICByZXR1cm4geyBjcmVkZW50aWFscywgcGx1Z2luTmFtZTogc291cmNlLm5hbWUgfTtcbiAgICB9XG4gICAgcmV0dXJuIHVuZGVmaW5lZDtcbiAgfVxufVxuXG5leHBvcnQgaW50ZXJmYWNlIFBsdWdpbkNyZWRlbnRpYWxzIHtcbiAgcmVhZG9ubHkgY3JlZGVudGlhbHM6IEF3c0NyZWRlbnRpYWxJZGVudGl0eTtcbiAgcmVhZG9ubHkgcGx1Z2luTmFtZTogc3RyaW5nO1xufVxuIl19