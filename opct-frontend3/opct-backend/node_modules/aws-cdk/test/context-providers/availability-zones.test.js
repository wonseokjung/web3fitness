"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const client_ec2_1 = require("@aws-sdk/client-ec2");
const lib_1 = require("../../lib");
const availability_zones_1 = require("../../lib/context-providers/availability-zones");
const mock_sdk_1 = require("../util/mock-sdk");
const mockSDK = new (class extends mock_sdk_1.MockSdkProvider {
    forEnvironment() {
        return Promise.resolve({ sdk: new lib_1.SDK(mock_sdk_1.FAKE_CREDENTIALS, mockSDK.defaultRegion, {}), didAssumeRole: false });
    }
})();
test('empty array as result when response has no AZs', async () => {
    // GIVEN
    mock_sdk_1.mockEC2Client.on(client_ec2_1.DescribeAvailabilityZonesCommand).resolves({
        AvailabilityZones: undefined,
    });
    // WHEN
    const azs = await new availability_zones_1.AZContextProviderPlugin(mockSDK).getValue({
        account: '1234',
        region: 'asdf',
    });
    // THEN
    expect(azs).toEqual([]);
});
test('returns AZs', async () => {
    // GIVEN
    mock_sdk_1.mockEC2Client.on(client_ec2_1.DescribeAvailabilityZonesCommand).resolves({
        AvailabilityZones: [{
                ZoneName: 'us-east-1a',
                State: 'available',
            }],
    });
    // WHEN
    const azs = await new availability_zones_1.AZContextProviderPlugin(mockSDK).getValue({
        account: '1234',
        region: 'asdf',
    });
    // THEN
    expect(azs).toEqual(['us-east-1a']);
});
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiYXZhaWxhYmlsaXR5LXpvbmVzLnRlc3QuanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyJhdmFpbGFiaWxpdHktem9uZXMudGVzdC50cyJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiOztBQUFBLG9EQUF1RTtBQUN2RSxtQ0FBbUQ7QUFDbkQsdUZBQXlGO0FBQ3pGLCtDQUFvRjtBQUVwRixNQUFNLE9BQU8sR0FBRyxJQUFJLENBQUMsS0FBTSxTQUFRLDBCQUFlO0lBQ3pDLGNBQWM7UUFDbkIsT0FBTyxPQUFPLENBQUMsT0FBTyxDQUFDLEVBQUUsR0FBRyxFQUFFLElBQUksU0FBRyxDQUFDLDJCQUFnQixFQUFFLE9BQU8sQ0FBQyxhQUFhLEVBQUUsRUFBRSxDQUFDLEVBQUUsYUFBYSxFQUFFLEtBQUssRUFBRSxDQUFDLENBQUM7SUFDOUcsQ0FBQztDQUNGLENBQUMsRUFBRSxDQUFDO0FBRUwsSUFBSSxDQUFDLGdEQUFnRCxFQUFFLEtBQUssSUFBSSxFQUFFO0lBQ2hFLFFBQVE7SUFDUix3QkFBYSxDQUFDLEVBQUUsQ0FBQyw2Q0FBZ0MsQ0FBQyxDQUFDLFFBQVEsQ0FBQztRQUMxRCxpQkFBaUIsRUFBRSxTQUFTO0tBQzdCLENBQUMsQ0FBQztJQUVILE9BQU87SUFDUCxNQUFNLEdBQUcsR0FBRyxNQUFNLElBQUksNENBQXVCLENBQUMsT0FBTyxDQUFDLENBQUMsUUFBUSxDQUFDO1FBQzlELE9BQU8sRUFBRSxNQUFNO1FBQ2YsTUFBTSxFQUFFLE1BQU07S0FDZixDQUFDLENBQUM7SUFFSCxPQUFPO0lBQ1AsTUFBTSxDQUFDLEdBQUcsQ0FBQyxDQUFDLE9BQU8sQ0FBQyxFQUFFLENBQUMsQ0FBQztBQUMxQixDQUFDLENBQUMsQ0FBQztBQUVILElBQUksQ0FBQyxhQUFhLEVBQUUsS0FBSyxJQUFJLEVBQUU7SUFDN0IsUUFBUTtJQUNSLHdCQUFhLENBQUMsRUFBRSxDQUFDLDZDQUFnQyxDQUFDLENBQUMsUUFBUSxDQUFDO1FBQzFELGlCQUFpQixFQUFFLENBQUM7Z0JBQ2xCLFFBQVEsRUFBRSxZQUFZO2dCQUN0QixLQUFLLEVBQUUsV0FBVzthQUNuQixDQUFDO0tBQ0gsQ0FBQyxDQUFDO0lBRUgsT0FBTztJQUNQLE1BQU0sR0FBRyxHQUFHLE1BQU0sSUFBSSw0Q0FBdUIsQ0FBQyxPQUFPLENBQUMsQ0FBQyxRQUFRLENBQUM7UUFDOUQsT0FBTyxFQUFFLE1BQU07UUFDZixNQUFNLEVBQUUsTUFBTTtLQUNmLENBQUMsQ0FBQztJQUVILE9BQU87SUFDUCxNQUFNLENBQUMsR0FBRyxDQUFDLENBQUMsT0FBTyxDQUFDLENBQUMsWUFBWSxDQUFDLENBQUMsQ0FBQztBQUN0QyxDQUFDLENBQUMsQ0FBQyIsInNvdXJjZXNDb250ZW50IjpbImltcG9ydCB7IERlc2NyaWJlQXZhaWxhYmlsaXR5Wm9uZXNDb21tYW5kIH0gZnJvbSAnQGF3cy1zZGsvY2xpZW50LWVjMic7XG5pbXBvcnQgeyBTREssIFNka0ZvckVudmlyb25tZW50IH0gZnJvbSAnLi4vLi4vbGliJztcbmltcG9ydCB7IEFaQ29udGV4dFByb3ZpZGVyUGx1Z2luIH0gZnJvbSAnLi4vLi4vbGliL2NvbnRleHQtcHJvdmlkZXJzL2F2YWlsYWJpbGl0eS16b25lcyc7XG5pbXBvcnQgeyBGQUtFX0NSRURFTlRJQUxTLCBtb2NrRUMyQ2xpZW50LCBNb2NrU2RrUHJvdmlkZXIgfSBmcm9tICcuLi91dGlsL21vY2stc2RrJztcblxuY29uc3QgbW9ja1NESyA9IG5ldyAoY2xhc3MgZXh0ZW5kcyBNb2NrU2RrUHJvdmlkZXIge1xuICBwdWJsaWMgZm9yRW52aXJvbm1lbnQoKTogUHJvbWlzZTxTZGtGb3JFbnZpcm9ubWVudD4ge1xuICAgIHJldHVybiBQcm9taXNlLnJlc29sdmUoeyBzZGs6IG5ldyBTREsoRkFLRV9DUkVERU5USUFMUywgbW9ja1NESy5kZWZhdWx0UmVnaW9uLCB7fSksIGRpZEFzc3VtZVJvbGU6IGZhbHNlIH0pO1xuICB9XG59KSgpO1xuXG50ZXN0KCdlbXB0eSBhcnJheSBhcyByZXN1bHQgd2hlbiByZXNwb25zZSBoYXMgbm8gQVpzJywgYXN5bmMgKCkgPT4ge1xuICAvLyBHSVZFTlxuICBtb2NrRUMyQ2xpZW50Lm9uKERlc2NyaWJlQXZhaWxhYmlsaXR5Wm9uZXNDb21tYW5kKS5yZXNvbHZlcyh7XG4gICAgQXZhaWxhYmlsaXR5Wm9uZXM6IHVuZGVmaW5lZCxcbiAgfSk7XG5cbiAgLy8gV0hFTlxuICBjb25zdCBhenMgPSBhd2FpdCBuZXcgQVpDb250ZXh0UHJvdmlkZXJQbHVnaW4obW9ja1NESykuZ2V0VmFsdWUoe1xuICAgIGFjY291bnQ6ICcxMjM0JyxcbiAgICByZWdpb246ICdhc2RmJyxcbiAgfSk7XG5cbiAgLy8gVEhFTlxuICBleHBlY3QoYXpzKS50b0VxdWFsKFtdKTtcbn0pO1xuXG50ZXN0KCdyZXR1cm5zIEFacycsIGFzeW5jICgpID0+IHtcbiAgLy8gR0lWRU5cbiAgbW9ja0VDMkNsaWVudC5vbihEZXNjcmliZUF2YWlsYWJpbGl0eVpvbmVzQ29tbWFuZCkucmVzb2x2ZXMoe1xuICAgIEF2YWlsYWJpbGl0eVpvbmVzOiBbe1xuICAgICAgWm9uZU5hbWU6ICd1cy1lYXN0LTFhJyxcbiAgICAgIFN0YXRlOiAnYXZhaWxhYmxlJyxcbiAgICB9XSxcbiAgfSk7XG5cbiAgLy8gV0hFTlxuICBjb25zdCBhenMgPSBhd2FpdCBuZXcgQVpDb250ZXh0UHJvdmlkZXJQbHVnaW4obW9ja1NESykuZ2V0VmFsdWUoe1xuICAgIGFjY291bnQ6ICcxMjM0JyxcbiAgICByZWdpb246ICdhc2RmJyxcbiAgfSk7XG5cbiAgLy8gVEhFTlxuICBleHBlY3QoYXpzKS50b0VxdWFsKFsndXMtZWFzdC0xYSddKTtcbn0pOyJdfQ==