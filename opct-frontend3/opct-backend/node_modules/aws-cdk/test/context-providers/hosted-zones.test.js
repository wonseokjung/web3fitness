"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const client_route_53_1 = require("@aws-sdk/client-route-53");
const lib_1 = require("../../lib");
const hosted_zones_1 = require("../../lib/context-providers/hosted-zones");
const mock_sdk_1 = require("../util/mock-sdk");
const mockSDK = new (class extends mock_sdk_1.MockSdkProvider {
    forEnvironment() {
        return Promise.resolve({ sdk: new lib_1.SDK(mock_sdk_1.FAKE_CREDENTIALS, mockSDK.defaultRegion, {}), didAssumeRole: false });
    }
})();
test('get value without private zone', async () => {
    // GIVEN
    mock_sdk_1.mockRoute53Client.on(client_route_53_1.ListHostedZonesByNameCommand).resolves({
        HostedZones: [{
                Id: 'foo',
                Name: 'example.com.',
                CallerReference: 'xyz',
            }],
    });
    // WHEN
    const result = await new hosted_zones_1.HostedZoneContextProviderPlugin(mockSDK).getValue({
        domainName: 'example.com',
        account: '1234',
        region: 'rgn',
    });
    expect(result).toEqual({
        Id: 'foo',
        Name: 'example.com.',
    });
});
test('get value with private zone', async () => {
    // GIVEN
    mock_sdk_1.mockRoute53Client.on(client_route_53_1.ListHostedZonesByNameCommand).resolves({
        HostedZones: [{
                Id: 'foo',
                Name: 'example.com.',
                CallerReference: 'xyz',
                Config: {
                    PrivateZone: true,
                },
            }],
    });
    // WHEN
    const result = await new hosted_zones_1.HostedZoneContextProviderPlugin(mockSDK).getValue({
        domainName: 'example.com',
        account: '1234',
        region: 'rgn',
        privateZone: true,
    });
    expect(result).toEqual({
        Id: 'foo',
        Name: 'example.com.',
    });
});
test('get value with private zone and VPC not found', async () => {
    // GIVEN
    mock_sdk_1.mockRoute53Client.on(client_route_53_1.ListHostedZonesByNameCommand).resolves({
        HostedZones: [{
                Id: 'foo',
                Name: 'example.com.',
                CallerReference: 'xyz',
                Config: {
                    PrivateZone: true,
                },
            }],
    });
    // No VPCs
    mock_sdk_1.mockRoute53Client.on(client_route_53_1.GetHostedZoneCommand).resolves({});
    // WHEN
    const result = new hosted_zones_1.HostedZoneContextProviderPlugin(mockSDK).getValue({
        domainName: 'example.com',
        account: '1234',
        region: 'rgn',
        privateZone: true,
        vpcId: 'vpc-bla',
    });
    await expect(result)
        .rejects
        .toThrow(new Error('Found zones: [] for dns:example.com, privateZone:true, vpcId:vpc-bla, but wanted exactly 1 zone'));
});
test('get value with private zone and VPC found', async () => {
    // GIVEN
    mock_sdk_1.mockRoute53Client.on(client_route_53_1.ListHostedZonesByNameCommand).resolves({
        HostedZones: [{
                Id: 'foo',
                Name: 'example.com.',
                CallerReference: 'xyz',
                Config: {
                    PrivateZone: true,
                },
            }],
    });
    mock_sdk_1.mockRoute53Client.on(client_route_53_1.GetHostedZoneCommand).resolves({
        VPCs: [{
                VPCId: 'vpc-bla',
            }],
    });
    // WHEN
    const result = await new hosted_zones_1.HostedZoneContextProviderPlugin(mockSDK).getValue({
        domainName: 'example.com',
        account: '1234',
        region: 'rgn',
        privateZone: true,
        vpcId: 'vpc-bla',
    });
    expect(result).toEqual({
        Id: 'foo',
        Name: 'example.com.',
    });
});
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiaG9zdGVkLXpvbmVzLnRlc3QuanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyJob3N0ZWQtem9uZXMudGVzdC50cyJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiOztBQUFBLDhEQUE4RjtBQUM5RixtQ0FBbUQ7QUFDbkQsMkVBQTJGO0FBQzNGLCtDQUF3RjtBQUV4RixNQUFNLE9BQU8sR0FBRyxJQUFJLENBQUMsS0FBTSxTQUFRLDBCQUFlO0lBQ3pDLGNBQWM7UUFDbkIsT0FBTyxPQUFPLENBQUMsT0FBTyxDQUFDLEVBQUUsR0FBRyxFQUFFLElBQUksU0FBRyxDQUFDLDJCQUFnQixFQUFFLE9BQU8sQ0FBQyxhQUFhLEVBQUUsRUFBRSxDQUFDLEVBQUUsYUFBYSxFQUFFLEtBQUssRUFBRSxDQUFDLENBQUM7SUFDOUcsQ0FBQztDQUNGLENBQUMsRUFBRSxDQUFDO0FBRUwsSUFBSSxDQUFDLGdDQUFnQyxFQUFFLEtBQUssSUFBSSxFQUFFO0lBQ2hELFFBQVE7SUFDUiw0QkFBaUIsQ0FBQyxFQUFFLENBQUMsOENBQTRCLENBQUMsQ0FBQyxRQUFRLENBQUM7UUFDMUQsV0FBVyxFQUFFLENBQUM7Z0JBQ1osRUFBRSxFQUFFLEtBQUs7Z0JBQ1QsSUFBSSxFQUFFLGNBQWM7Z0JBQ3BCLGVBQWUsRUFBRSxLQUFLO2FBQ3ZCLENBQUM7S0FDSCxDQUFDLENBQUM7SUFFSCxPQUFPO0lBQ1AsTUFBTSxNQUFNLEdBQUcsTUFBTSxJQUFJLDhDQUErQixDQUFDLE9BQU8sQ0FBQyxDQUFDLFFBQVEsQ0FBQztRQUN6RSxVQUFVLEVBQUUsYUFBYTtRQUN6QixPQUFPLEVBQUUsTUFBTTtRQUNmLE1BQU0sRUFBRSxLQUFLO0tBQ2QsQ0FBQyxDQUFDO0lBRUgsTUFBTSxDQUFDLE1BQU0sQ0FBQyxDQUFDLE9BQU8sQ0FBQztRQUNyQixFQUFFLEVBQUUsS0FBSztRQUNULElBQUksRUFBRSxjQUFjO0tBQ3JCLENBQUMsQ0FBQztBQUNMLENBQUMsQ0FBQyxDQUFDO0FBRUgsSUFBSSxDQUFDLDZCQUE2QixFQUFFLEtBQUssSUFBSSxFQUFFO0lBQzdDLFFBQVE7SUFDUiw0QkFBaUIsQ0FBQyxFQUFFLENBQUMsOENBQTRCLENBQUMsQ0FBQyxRQUFRLENBQUM7UUFDMUQsV0FBVyxFQUFFLENBQUM7Z0JBQ1osRUFBRSxFQUFFLEtBQUs7Z0JBQ1QsSUFBSSxFQUFFLGNBQWM7Z0JBQ3BCLGVBQWUsRUFBRSxLQUFLO2dCQUN0QixNQUFNLEVBQUU7b0JBQ04sV0FBVyxFQUFFLElBQUk7aUJBQ2xCO2FBQ0YsQ0FBQztLQUNILENBQUMsQ0FBQztJQUVILE9BQU87SUFDUCxNQUFNLE1BQU0sR0FBRyxNQUFNLElBQUksOENBQStCLENBQUMsT0FBTyxDQUFDLENBQUMsUUFBUSxDQUFDO1FBQ3pFLFVBQVUsRUFBRSxhQUFhO1FBQ3pCLE9BQU8sRUFBRSxNQUFNO1FBQ2YsTUFBTSxFQUFFLEtBQUs7UUFDYixXQUFXLEVBQUUsSUFBSTtLQUNsQixDQUFDLENBQUM7SUFFSCxNQUFNLENBQUMsTUFBTSxDQUFDLENBQUMsT0FBTyxDQUFDO1FBQ3JCLEVBQUUsRUFBRSxLQUFLO1FBQ1QsSUFBSSxFQUFFLGNBQWM7S0FDckIsQ0FBQyxDQUFDO0FBQ0wsQ0FBQyxDQUFDLENBQUM7QUFFSCxJQUFJLENBQUMsK0NBQStDLEVBQUUsS0FBSyxJQUFJLEVBQUU7SUFDL0QsUUFBUTtJQUNSLDRCQUFpQixDQUFDLEVBQUUsQ0FBQyw4Q0FBNEIsQ0FBQyxDQUFDLFFBQVEsQ0FBQztRQUMxRCxXQUFXLEVBQUUsQ0FBQztnQkFDWixFQUFFLEVBQUUsS0FBSztnQkFDVCxJQUFJLEVBQUUsY0FBYztnQkFDcEIsZUFBZSxFQUFFLEtBQUs7Z0JBQ3RCLE1BQU0sRUFBRTtvQkFDTixXQUFXLEVBQUUsSUFBSTtpQkFDbEI7YUFDRixDQUFDO0tBQ0gsQ0FBQyxDQUFDO0lBRUgsVUFBVTtJQUNWLDRCQUFpQixDQUFDLEVBQUUsQ0FBQyxzQ0FBb0IsQ0FBQyxDQUFDLFFBQVEsQ0FBQyxFQUFFLENBQUMsQ0FBQztJQUV4RCxPQUFPO0lBQ1AsTUFBTSxNQUFNLEdBQUcsSUFBSSw4Q0FBK0IsQ0FBQyxPQUFPLENBQUMsQ0FBQyxRQUFRLENBQUM7UUFDbkUsVUFBVSxFQUFFLGFBQWE7UUFDekIsT0FBTyxFQUFFLE1BQU07UUFDZixNQUFNLEVBQUUsS0FBSztRQUNiLFdBQVcsRUFBRSxJQUFJO1FBQ2pCLEtBQUssRUFBRSxTQUFTO0tBQ2pCLENBQUMsQ0FBQztJQUVILE1BQU0sTUFBTSxDQUFDLE1BQU0sQ0FBQztTQUNqQixPQUFPO1NBQ1AsT0FBTyxDQUFDLElBQUksS0FBSyxDQUFDLGlHQUFpRyxDQUFDLENBQUMsQ0FBQztBQUMzSCxDQUFDLENBQUMsQ0FBQztBQUVILElBQUksQ0FBQywyQ0FBMkMsRUFBRSxLQUFLLElBQUksRUFBRTtJQUMzRCxRQUFRO0lBQ1IsNEJBQWlCLENBQUMsRUFBRSxDQUFDLDhDQUE0QixDQUFDLENBQUMsUUFBUSxDQUFDO1FBQzFELFdBQVcsRUFBRSxDQUFDO2dCQUNaLEVBQUUsRUFBRSxLQUFLO2dCQUNULElBQUksRUFBRSxjQUFjO2dCQUNwQixlQUFlLEVBQUUsS0FBSztnQkFDdEIsTUFBTSxFQUFFO29CQUNOLFdBQVcsRUFBRSxJQUFJO2lCQUNsQjthQUNGLENBQUM7S0FDSCxDQUFDLENBQUM7SUFFSCw0QkFBaUIsQ0FBQyxFQUFFLENBQUMsc0NBQW9CLENBQUMsQ0FBQyxRQUFRLENBQUM7UUFDbEQsSUFBSSxFQUFFLENBQUM7Z0JBQ0wsS0FBSyxFQUFFLFNBQVM7YUFDakIsQ0FBQztLQUNILENBQUMsQ0FBQztJQUVILE9BQU87SUFDUCxNQUFNLE1BQU0sR0FBRyxNQUFNLElBQUksOENBQStCLENBQUMsT0FBTyxDQUFDLENBQUMsUUFBUSxDQUFDO1FBQ3pFLFVBQVUsRUFBRSxhQUFhO1FBQ3pCLE9BQU8sRUFBRSxNQUFNO1FBQ2YsTUFBTSxFQUFFLEtBQUs7UUFDYixXQUFXLEVBQUUsSUFBSTtRQUNqQixLQUFLLEVBQUUsU0FBUztLQUNqQixDQUFDLENBQUM7SUFFSCxNQUFNLENBQUMsTUFBTSxDQUFDLENBQUMsT0FBTyxDQUFDO1FBQ3JCLEVBQUUsRUFBRSxLQUFLO1FBQ1QsSUFBSSxFQUFFLGNBQWM7S0FDckIsQ0FBQyxDQUFDO0FBQ0wsQ0FBQyxDQUFDLENBQUMiLCJzb3VyY2VzQ29udGVudCI6WyJpbXBvcnQgeyBHZXRIb3N0ZWRab25lQ29tbWFuZCwgTGlzdEhvc3RlZFpvbmVzQnlOYW1lQ29tbWFuZCB9IGZyb20gJ0Bhd3Mtc2RrL2NsaWVudC1yb3V0ZS01Myc7XG5pbXBvcnQgeyBTREssIFNka0ZvckVudmlyb25tZW50IH0gZnJvbSAnLi4vLi4vbGliJztcbmltcG9ydCB7IEhvc3RlZFpvbmVDb250ZXh0UHJvdmlkZXJQbHVnaW4gfSBmcm9tICcuLi8uLi9saWIvY29udGV4dC1wcm92aWRlcnMvaG9zdGVkLXpvbmVzJztcbmltcG9ydCB7IEZBS0VfQ1JFREVOVElBTFMsIG1vY2tSb3V0ZTUzQ2xpZW50LCBNb2NrU2RrUHJvdmlkZXIgfSBmcm9tICcuLi91dGlsL21vY2stc2RrJztcblxuY29uc3QgbW9ja1NESyA9IG5ldyAoY2xhc3MgZXh0ZW5kcyBNb2NrU2RrUHJvdmlkZXIge1xuICBwdWJsaWMgZm9yRW52aXJvbm1lbnQoKTogUHJvbWlzZTxTZGtGb3JFbnZpcm9ubWVudD4ge1xuICAgIHJldHVybiBQcm9taXNlLnJlc29sdmUoeyBzZGs6IG5ldyBTREsoRkFLRV9DUkVERU5USUFMUywgbW9ja1NESy5kZWZhdWx0UmVnaW9uLCB7fSksIGRpZEFzc3VtZVJvbGU6IGZhbHNlIH0pO1xuICB9XG59KSgpO1xuXG50ZXN0KCdnZXQgdmFsdWUgd2l0aG91dCBwcml2YXRlIHpvbmUnLCBhc3luYyAoKSA9PiB7XG4gIC8vIEdJVkVOXG4gIG1vY2tSb3V0ZTUzQ2xpZW50Lm9uKExpc3RIb3N0ZWRab25lc0J5TmFtZUNvbW1hbmQpLnJlc29sdmVzKHtcbiAgICBIb3N0ZWRab25lczogW3tcbiAgICAgIElkOiAnZm9vJyxcbiAgICAgIE5hbWU6ICdleGFtcGxlLmNvbS4nLFxuICAgICAgQ2FsbGVyUmVmZXJlbmNlOiAneHl6JyxcbiAgICB9XSxcbiAgfSk7XG5cbiAgLy8gV0hFTlxuICBjb25zdCByZXN1bHQgPSBhd2FpdCBuZXcgSG9zdGVkWm9uZUNvbnRleHRQcm92aWRlclBsdWdpbihtb2NrU0RLKS5nZXRWYWx1ZSh7XG4gICAgZG9tYWluTmFtZTogJ2V4YW1wbGUuY29tJyxcbiAgICBhY2NvdW50OiAnMTIzNCcsXG4gICAgcmVnaW9uOiAncmduJyxcbiAgfSk7XG5cbiAgZXhwZWN0KHJlc3VsdCkudG9FcXVhbCh7XG4gICAgSWQ6ICdmb28nLFxuICAgIE5hbWU6ICdleGFtcGxlLmNvbS4nLFxuICB9KTtcbn0pO1xuXG50ZXN0KCdnZXQgdmFsdWUgd2l0aCBwcml2YXRlIHpvbmUnLCBhc3luYyAoKSA9PiB7XG4gIC8vIEdJVkVOXG4gIG1vY2tSb3V0ZTUzQ2xpZW50Lm9uKExpc3RIb3N0ZWRab25lc0J5TmFtZUNvbW1hbmQpLnJlc29sdmVzKHtcbiAgICBIb3N0ZWRab25lczogW3tcbiAgICAgIElkOiAnZm9vJyxcbiAgICAgIE5hbWU6ICdleGFtcGxlLmNvbS4nLFxuICAgICAgQ2FsbGVyUmVmZXJlbmNlOiAneHl6JyxcbiAgICAgIENvbmZpZzoge1xuICAgICAgICBQcml2YXRlWm9uZTogdHJ1ZSxcbiAgICAgIH0sXG4gICAgfV0sXG4gIH0pO1xuXG4gIC8vIFdIRU5cbiAgY29uc3QgcmVzdWx0ID0gYXdhaXQgbmV3IEhvc3RlZFpvbmVDb250ZXh0UHJvdmlkZXJQbHVnaW4obW9ja1NESykuZ2V0VmFsdWUoe1xuICAgIGRvbWFpbk5hbWU6ICdleGFtcGxlLmNvbScsXG4gICAgYWNjb3VudDogJzEyMzQnLFxuICAgIHJlZ2lvbjogJ3JnbicsXG4gICAgcHJpdmF0ZVpvbmU6IHRydWUsXG4gIH0pO1xuXG4gIGV4cGVjdChyZXN1bHQpLnRvRXF1YWwoe1xuICAgIElkOiAnZm9vJyxcbiAgICBOYW1lOiAnZXhhbXBsZS5jb20uJyxcbiAgfSk7XG59KTtcblxudGVzdCgnZ2V0IHZhbHVlIHdpdGggcHJpdmF0ZSB6b25lIGFuZCBWUEMgbm90IGZvdW5kJywgYXN5bmMgKCkgPT4ge1xuICAvLyBHSVZFTlxuICBtb2NrUm91dGU1M0NsaWVudC5vbihMaXN0SG9zdGVkWm9uZXNCeU5hbWVDb21tYW5kKS5yZXNvbHZlcyh7XG4gICAgSG9zdGVkWm9uZXM6IFt7XG4gICAgICBJZDogJ2ZvbycsXG4gICAgICBOYW1lOiAnZXhhbXBsZS5jb20uJyxcbiAgICAgIENhbGxlclJlZmVyZW5jZTogJ3h5eicsXG4gICAgICBDb25maWc6IHtcbiAgICAgICAgUHJpdmF0ZVpvbmU6IHRydWUsXG4gICAgICB9LFxuICAgIH1dLFxuICB9KTtcblxuICAvLyBObyBWUENzXG4gIG1vY2tSb3V0ZTUzQ2xpZW50Lm9uKEdldEhvc3RlZFpvbmVDb21tYW5kKS5yZXNvbHZlcyh7fSk7XG5cbiAgLy8gV0hFTlxuICBjb25zdCByZXN1bHQgPSBuZXcgSG9zdGVkWm9uZUNvbnRleHRQcm92aWRlclBsdWdpbihtb2NrU0RLKS5nZXRWYWx1ZSh7XG4gICAgZG9tYWluTmFtZTogJ2V4YW1wbGUuY29tJyxcbiAgICBhY2NvdW50OiAnMTIzNCcsXG4gICAgcmVnaW9uOiAncmduJyxcbiAgICBwcml2YXRlWm9uZTogdHJ1ZSxcbiAgICB2cGNJZDogJ3ZwYy1ibGEnLFxuICB9KTtcblxuICBhd2FpdCBleHBlY3QocmVzdWx0KVxuICAgIC5yZWplY3RzXG4gICAgLnRvVGhyb3cobmV3IEVycm9yKCdGb3VuZCB6b25lczogW10gZm9yIGRuczpleGFtcGxlLmNvbSwgcHJpdmF0ZVpvbmU6dHJ1ZSwgdnBjSWQ6dnBjLWJsYSwgYnV0IHdhbnRlZCBleGFjdGx5IDEgem9uZScpKTtcbn0pO1xuXG50ZXN0KCdnZXQgdmFsdWUgd2l0aCBwcml2YXRlIHpvbmUgYW5kIFZQQyBmb3VuZCcsIGFzeW5jICgpID0+IHtcbiAgLy8gR0lWRU5cbiAgbW9ja1JvdXRlNTNDbGllbnQub24oTGlzdEhvc3RlZFpvbmVzQnlOYW1lQ29tbWFuZCkucmVzb2x2ZXMoe1xuICAgIEhvc3RlZFpvbmVzOiBbe1xuICAgICAgSWQ6ICdmb28nLFxuICAgICAgTmFtZTogJ2V4YW1wbGUuY29tLicsXG4gICAgICBDYWxsZXJSZWZlcmVuY2U6ICd4eXonLFxuICAgICAgQ29uZmlnOiB7XG4gICAgICAgIFByaXZhdGVab25lOiB0cnVlLFxuICAgICAgfSxcbiAgICB9XSxcbiAgfSk7XG5cbiAgbW9ja1JvdXRlNTNDbGllbnQub24oR2V0SG9zdGVkWm9uZUNvbW1hbmQpLnJlc29sdmVzKHtcbiAgICBWUENzOiBbe1xuICAgICAgVlBDSWQ6ICd2cGMtYmxhJyxcbiAgICB9XSxcbiAgfSk7XG5cbiAgLy8gV0hFTlxuICBjb25zdCByZXN1bHQgPSBhd2FpdCBuZXcgSG9zdGVkWm9uZUNvbnRleHRQcm92aWRlclBsdWdpbihtb2NrU0RLKS5nZXRWYWx1ZSh7XG4gICAgZG9tYWluTmFtZTogJ2V4YW1wbGUuY29tJyxcbiAgICBhY2NvdW50OiAnMTIzNCcsXG4gICAgcmVnaW9uOiAncmduJyxcbiAgICBwcml2YXRlWm9uZTogdHJ1ZSxcbiAgICB2cGNJZDogJ3ZwYy1ibGEnLFxuICB9KTtcblxuICBleHBlY3QocmVzdWx0KS50b0VxdWFsKHtcbiAgICBJZDogJ2ZvbycsXG4gICAgTmFtZTogJ2V4YW1wbGUuY29tLicsXG4gIH0pO1xufSk7XG5cbiJdfQ==