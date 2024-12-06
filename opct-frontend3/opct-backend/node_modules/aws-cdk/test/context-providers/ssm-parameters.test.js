"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const client_ssm_1 = require("@aws-sdk/client-ssm");
const lib_1 = require("../../lib");
const ssm_parameters_1 = require("../../lib/context-providers/ssm-parameters");
const mock_sdk_1 = require("../util/mock-sdk");
const mockSDK = new (class extends mock_sdk_1.MockSdkProvider {
    forEnvironment() {
        return Promise.resolve({ sdk: new lib_1.SDK(mock_sdk_1.FAKE_CREDENTIALS, mockSDK.defaultRegion, {}), didAssumeRole: false });
    }
})();
describe('ssmParameters', () => {
    test('returns value', async () => {
        (0, mock_sdk_1.restoreSdkMocksToDefault)();
        const provider = new ssm_parameters_1.SSMContextProviderPlugin(mockSDK);
        mock_sdk_1.mockSSMClient.on(client_ssm_1.GetParameterCommand).resolves({
            Parameter: {
                Value: 'bar',
            },
        });
        // WHEN
        const value = await provider.getValue({
            account: '1234',
            region: 'us-east-1',
            parameterName: 'foo',
        });
        expect(value).toEqual('bar');
    });
    test('errors when parameter is not found', async () => {
        (0, mock_sdk_1.restoreSdkMocksToDefault)();
        const provider = new ssm_parameters_1.SSMContextProviderPlugin(mockSDK);
        const notFound = new Error('Parameter not found');
        notFound.name = 'ParameterNotFound';
        mock_sdk_1.mockSSMClient.on(client_ssm_1.GetParameterCommand).rejects(notFound);
        // WHEN
        await expect(provider.getValue({
            account: '1234',
            region: 'us-east-1',
            parameterName: 'foo',
        })).rejects.toThrow(/SSM parameter not available in account/);
    });
});
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoic3NtLXBhcmFtZXRlcnMudGVzdC5qcyIsInNvdXJjZVJvb3QiOiIiLCJzb3VyY2VzIjpbInNzbS1wYXJhbWV0ZXJzLnRlc3QudHMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6Ijs7QUFBQSxvREFBMEQ7QUFDMUQsbUNBQW1EO0FBQ25ELCtFQUFzRjtBQUN0RiwrQ0FBOEc7QUFFOUcsTUFBTSxPQUFPLEdBQUcsSUFBSSxDQUFDLEtBQU0sU0FBUSwwQkFBZTtJQUN6QyxjQUFjO1FBQ25CLE9BQU8sT0FBTyxDQUFDLE9BQU8sQ0FBQyxFQUFFLEdBQUcsRUFBRSxJQUFJLFNBQUcsQ0FBQywyQkFBZ0IsRUFBRSxPQUFPLENBQUMsYUFBYSxFQUFFLEVBQUUsQ0FBQyxFQUFFLGFBQWEsRUFBRSxLQUFLLEVBQUUsQ0FBQyxDQUFDO0lBQzlHLENBQUM7Q0FDRixDQUFDLEVBQUUsQ0FBQztBQUVMLFFBQVEsQ0FBQyxlQUFlLEVBQUUsR0FBRyxFQUFFO0lBQzdCLElBQUksQ0FBQyxlQUFlLEVBQUUsS0FBSyxJQUFJLEVBQUU7UUFDL0IsSUFBQSxtQ0FBd0IsR0FBRSxDQUFDO1FBQzNCLE1BQU0sUUFBUSxHQUFHLElBQUkseUNBQXdCLENBQUMsT0FBTyxDQUFDLENBQUM7UUFFdkQsd0JBQWEsQ0FBQyxFQUFFLENBQUMsZ0NBQW1CLENBQUMsQ0FBQyxRQUFRLENBQUM7WUFDN0MsU0FBUyxFQUFFO2dCQUNULEtBQUssRUFBRSxLQUFLO2FBQ2I7U0FDRixDQUFDLENBQUM7UUFFSCxPQUFPO1FBQ1AsTUFBTSxLQUFLLEdBQUcsTUFBTSxRQUFRLENBQUMsUUFBUSxDQUFDO1lBQ3BDLE9BQU8sRUFBRSxNQUFNO1lBQ2YsTUFBTSxFQUFFLFdBQVc7WUFDbkIsYUFBYSxFQUFFLEtBQUs7U0FDckIsQ0FBQyxDQUFDO1FBRUgsTUFBTSxDQUFDLEtBQUssQ0FBQyxDQUFDLE9BQU8sQ0FBQyxLQUFLLENBQUMsQ0FBQztJQUMvQixDQUFDLENBQUMsQ0FBQztJQUVILElBQUksQ0FBQyxvQ0FBb0MsRUFBRSxLQUFLLElBQUksRUFBRTtRQUNwRCxJQUFBLG1DQUF3QixHQUFFLENBQUM7UUFDM0IsTUFBTSxRQUFRLEdBQUcsSUFBSSx5Q0FBd0IsQ0FBQyxPQUFPLENBQUMsQ0FBQztRQUV2RCxNQUFNLFFBQVEsR0FBRyxJQUFJLEtBQUssQ0FBQyxxQkFBcUIsQ0FBQyxDQUFDO1FBQ2xELFFBQVEsQ0FBQyxJQUFJLEdBQUcsbUJBQW1CLENBQUM7UUFDcEMsd0JBQWEsQ0FBQyxFQUFFLENBQUMsZ0NBQW1CLENBQUMsQ0FBQyxPQUFPLENBQUMsUUFBUSxDQUFDLENBQUM7UUFFeEQsT0FBTztRQUNQLE1BQU0sTUFBTSxDQUNWLFFBQVEsQ0FBQyxRQUFRLENBQUM7WUFDaEIsT0FBTyxFQUFFLE1BQU07WUFDZixNQUFNLEVBQUUsV0FBVztZQUNuQixhQUFhLEVBQUUsS0FBSztTQUNyQixDQUFDLENBQUMsQ0FBQyxPQUFPLENBQUMsT0FBTyxDQUFDLHdDQUF3QyxDQUFDLENBQUM7SUFDbEUsQ0FBQyxDQUFDLENBQUM7QUFDTCxDQUFDLENBQUMsQ0FBQyIsInNvdXJjZXNDb250ZW50IjpbImltcG9ydCB7IEdldFBhcmFtZXRlckNvbW1hbmQgfSBmcm9tICdAYXdzLXNkay9jbGllbnQtc3NtJztcbmltcG9ydCB7IFNESywgU2RrRm9yRW52aXJvbm1lbnQgfSBmcm9tICcuLi8uLi9saWInO1xuaW1wb3J0IHsgU1NNQ29udGV4dFByb3ZpZGVyUGx1Z2luIH0gZnJvbSAnLi4vLi4vbGliL2NvbnRleHQtcHJvdmlkZXJzL3NzbS1wYXJhbWV0ZXJzJztcbmltcG9ydCB7IEZBS0VfQ1JFREVOVElBTFMsIE1vY2tTZGtQcm92aWRlciwgbW9ja1NTTUNsaWVudCwgcmVzdG9yZVNka01vY2tzVG9EZWZhdWx0IH0gZnJvbSAnLi4vdXRpbC9tb2NrLXNkayc7XG5cbmNvbnN0IG1vY2tTREsgPSBuZXcgKGNsYXNzIGV4dGVuZHMgTW9ja1Nka1Byb3ZpZGVyIHtcbiAgcHVibGljIGZvckVudmlyb25tZW50KCk6IFByb21pc2U8U2RrRm9yRW52aXJvbm1lbnQ+IHtcbiAgICByZXR1cm4gUHJvbWlzZS5yZXNvbHZlKHsgc2RrOiBuZXcgU0RLKEZBS0VfQ1JFREVOVElBTFMsIG1vY2tTREsuZGVmYXVsdFJlZ2lvbiwge30pLCBkaWRBc3N1bWVSb2xlOiBmYWxzZSB9KTtcbiAgfVxufSkoKTtcblxuZGVzY3JpYmUoJ3NzbVBhcmFtZXRlcnMnLCAoKSA9PiB7XG4gIHRlc3QoJ3JldHVybnMgdmFsdWUnLCBhc3luYyAoKSA9PiB7XG4gICAgcmVzdG9yZVNka01vY2tzVG9EZWZhdWx0KCk7XG4gICAgY29uc3QgcHJvdmlkZXIgPSBuZXcgU1NNQ29udGV4dFByb3ZpZGVyUGx1Z2luKG1vY2tTREspO1xuXG4gICAgbW9ja1NTTUNsaWVudC5vbihHZXRQYXJhbWV0ZXJDb21tYW5kKS5yZXNvbHZlcyh7XG4gICAgICBQYXJhbWV0ZXI6IHtcbiAgICAgICAgVmFsdWU6ICdiYXInLFxuICAgICAgfSxcbiAgICB9KTtcblxuICAgIC8vIFdIRU5cbiAgICBjb25zdCB2YWx1ZSA9IGF3YWl0IHByb3ZpZGVyLmdldFZhbHVlKHtcbiAgICAgIGFjY291bnQ6ICcxMjM0JyxcbiAgICAgIHJlZ2lvbjogJ3VzLWVhc3QtMScsXG4gICAgICBwYXJhbWV0ZXJOYW1lOiAnZm9vJyxcbiAgICB9KTtcblxuICAgIGV4cGVjdCh2YWx1ZSkudG9FcXVhbCgnYmFyJyk7XG4gIH0pO1xuXG4gIHRlc3QoJ2Vycm9ycyB3aGVuIHBhcmFtZXRlciBpcyBub3QgZm91bmQnLCBhc3luYyAoKSA9PiB7XG4gICAgcmVzdG9yZVNka01vY2tzVG9EZWZhdWx0KCk7XG4gICAgY29uc3QgcHJvdmlkZXIgPSBuZXcgU1NNQ29udGV4dFByb3ZpZGVyUGx1Z2luKG1vY2tTREspO1xuXG4gICAgY29uc3Qgbm90Rm91bmQgPSBuZXcgRXJyb3IoJ1BhcmFtZXRlciBub3QgZm91bmQnKTtcbiAgICBub3RGb3VuZC5uYW1lID0gJ1BhcmFtZXRlck5vdEZvdW5kJztcbiAgICBtb2NrU1NNQ2xpZW50Lm9uKEdldFBhcmFtZXRlckNvbW1hbmQpLnJlamVjdHMobm90Rm91bmQpO1xuXG4gICAgLy8gV0hFTlxuICAgIGF3YWl0IGV4cGVjdChcbiAgICAgIHByb3ZpZGVyLmdldFZhbHVlKHtcbiAgICAgICAgYWNjb3VudDogJzEyMzQnLFxuICAgICAgICByZWdpb246ICd1cy1lYXN0LTEnLFxuICAgICAgICBwYXJhbWV0ZXJOYW1lOiAnZm9vJyxcbiAgICAgIH0pKS5yZWplY3RzLnRvVGhyb3coL1NTTSBwYXJhbWV0ZXIgbm90IGF2YWlsYWJsZSBpbiBhY2NvdW50Lyk7XG4gIH0pO1xufSk7Il19