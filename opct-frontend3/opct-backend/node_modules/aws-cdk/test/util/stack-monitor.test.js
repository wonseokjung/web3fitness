"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const client_cloudformation_1 = require("@aws-sdk/client-cloudformation");
const mock_sdk_1 = require("./mock-sdk");
const stack_activity_monitor_1 = require("../../lib/api/util/cloudformation/stack-activity-monitor");
let sdk;
let printer;
let monitor;
beforeEach(() => {
    sdk = new mock_sdk_1.MockSdk();
    printer = new FakePrinter();
    monitor = new stack_activity_monitor_1.StackActivityMonitor(sdk.cloudFormation(), 'StackName', printer, undefined, new Date(T100)).start();
});
describe('stack monitor event ordering and pagination', () => {
    test('continue to the next page if it exists', async () => {
        mock_sdk_1.mockCloudFormationClient.on(client_cloudformation_1.DescribeStackEventsCommand).resolvesOnce({
            StackEvents: [event(102), event(101)],
        });
        await eventually(() => expect(mock_sdk_1.mockCloudFormationClient).toHaveReceivedCommand(client_cloudformation_1.DescribeStackEventsCommand), 2);
        await monitor.stop();
        // Printer sees them in chronological order
        expect(printer.eventIds).toEqual(['101', '102']);
    });
    test('do not page further if we already saw the last event', async () => {
        mock_sdk_1.mockCloudFormationClient
            .on(client_cloudformation_1.DescribeStackEventsCommand)
            .resolvesOnce({
            StackEvents: [event(101)],
        })
            .resolvesOnce({
            StackEvents: [event(102), event(101)],
        })
            .resolvesOnce({});
        await eventually(() => expect(mock_sdk_1.mockCloudFormationClient).toHaveReceivedCommand(client_cloudformation_1.DescribeStackEventsCommand), 2);
        await monitor.stop();
        // Seen in chronological order
        expect(printer.eventIds).toEqual(['101', '102']);
    });
    test('do not page further if the last event is too old', async () => {
        mock_sdk_1.mockCloudFormationClient
            .on(client_cloudformation_1.DescribeStackEventsCommand)
            .resolvesOnce({
            StackEvents: [event(101), event(95)],
        })
            .resolvesOnce({
            StackEvents: [],
        });
        await eventually(() => expect(mock_sdk_1.mockCloudFormationClient).toHaveReceivedCommand(client_cloudformation_1.DescribeStackEventsCommand), 2);
        await monitor.stop();
        // Seen only the new one
        expect(printer.eventIds).toEqual(['101']);
    });
    test('do a final request after the monitor is stopped', async () => {
        mock_sdk_1.mockCloudFormationClient.on(client_cloudformation_1.DescribeStackEventsCommand).resolves({
            StackEvents: [event(101)],
        });
        // Establish that we've received events prior to stop and then reset the mock
        await eventually(() => expect(mock_sdk_1.mockCloudFormationClient).toHaveReceivedCommand(client_cloudformation_1.DescribeStackEventsCommand), 2);
        mock_sdk_1.mockCloudFormationClient.resetHistory();
        await monitor.stop();
        mock_sdk_1.mockCloudFormationClient.on(client_cloudformation_1.DescribeStackEventsCommand).resolves({
            StackEvents: [event(102), event(101)],
        });
        // Since we can't reset the mock to a new value before calling stop, we'll have to check
        // and make sure it's called again instead.
        expect(mock_sdk_1.mockCloudFormationClient).toHaveReceivedCommand(client_cloudformation_1.DescribeStackEventsCommand);
    });
});
describe('stack monitor, collecting errors from events', () => {
    test('return errors from the root stack', async () => {
        mock_sdk_1.mockCloudFormationClient.on(client_cloudformation_1.DescribeStackEventsCommand).resolvesOnce({
            StackEvents: [addErrorToStackEvent(event(100))],
        });
        await eventually(() => expect(mock_sdk_1.mockCloudFormationClient).toHaveReceivedCommand(client_cloudformation_1.DescribeStackEventsCommand), 2);
        await monitor.stop();
        expect(monitor.errors).toStrictEqual(['Test Error']);
    });
    test('return errors from the nested stack', async () => {
        mock_sdk_1.mockCloudFormationClient
            .on(client_cloudformation_1.DescribeStackEventsCommand)
            .resolvesOnce({
            StackEvents: [
                addErrorToStackEvent(event(102), {
                    logicalResourceId: 'nestedStackLogicalResourceId',
                    physicalResourceId: 'nestedStackPhysicalResourceId',
                    resourceType: 'AWS::CloudFormation::Stack',
                    resourceStatusReason: 'nested stack failed',
                    resourceStatus: client_cloudformation_1.ResourceStatus.UPDATE_FAILED,
                }),
                addErrorToStackEvent(event(100), {
                    logicalResourceId: 'nestedStackLogicalResourceId',
                    physicalResourceId: 'nestedStackPhysicalResourceId',
                    resourceType: 'AWS::CloudFormation::Stack',
                    resourceStatus: client_cloudformation_1.ResourceStatus.UPDATE_IN_PROGRESS,
                }),
            ],
        })
            .resolvesOnce({
            StackEvents: [
                addErrorToStackEvent(event(101), {
                    logicalResourceId: 'nestedResource',
                    resourceType: 'Some::Nested::Resource',
                    resourceStatusReason: 'actual failure error message',
                }),
            ],
        });
        await eventually(() => expect(mock_sdk_1.mockCloudFormationClient).toHaveReceivedNthCommandWith(1, client_cloudformation_1.DescribeStackEventsCommand, {
            StackName: 'StackName',
        }), 2);
        await eventually(() => expect(mock_sdk_1.mockCloudFormationClient).toHaveReceivedNthCommandWith(2, client_cloudformation_1.DescribeStackEventsCommand, {
            StackName: 'nestedStackPhysicalResourceId',
        }), 2);
        await monitor.stop();
        expect(monitor.errors).toStrictEqual(['actual failure error message', 'nested stack failed']);
    });
    test('does not consider events without physical resource id for monitoring nested stacks', async () => {
        mock_sdk_1.mockCloudFormationClient
            .on(client_cloudformation_1.DescribeStackEventsCommand)
            .resolvesOnce({
            StackEvents: [
                addErrorToStackEvent(event(100), {
                    logicalResourceId: 'nestedStackLogicalResourceId',
                    physicalResourceId: '',
                    resourceType: 'AWS::CloudFormation::Stack',
                    resourceStatusReason: 'nested stack failed',
                }),
            ],
            NextToken: 'nextToken',
        })
            .resolvesOnce({
            StackEvents: [
                addErrorToStackEvent(event(101), {
                    logicalResourceId: 'OtherResource',
                    resourceType: 'Some::Other::Resource',
                    resourceStatusReason: 'some failure',
                }),
            ],
        });
        await eventually(() => expect(mock_sdk_1.mockCloudFormationClient).toHaveReceivedCommand(client_cloudformation_1.DescribeStackEventsCommand), 2);
        await monitor.stop();
        expect(monitor.errors).toStrictEqual(['nested stack failed', 'some failure']);
        expect(mock_sdk_1.mockCloudFormationClient).toHaveReceivedNthCommandWith(1, client_cloudformation_1.DescribeStackEventsCommand, {
            StackName: 'StackName',
        });
        // Note that the second call happened for the top level stack instead of a nested stack
        expect(mock_sdk_1.mockCloudFormationClient).toHaveReceivedNthCommandWith(2, client_cloudformation_1.DescribeStackEventsCommand, {
            StackName: 'StackName',
        });
    });
    test('does not check for nested stacks that have already completed successfully', async () => {
        mock_sdk_1.mockCloudFormationClient.on(client_cloudformation_1.DescribeStackEventsCommand).resolvesOnce({
            StackEvents: [
                addErrorToStackEvent(event(100), {
                    logicalResourceId: 'nestedStackLogicalResourceId',
                    physicalResourceId: 'nestedStackPhysicalResourceId',
                    resourceType: 'AWS::CloudFormation::Stack',
                    resourceStatusReason: 'nested stack status reason',
                    resourceStatus: client_cloudformation_1.StackStatus.CREATE_COMPLETE,
                }),
            ],
        });
        await eventually(() => expect(mock_sdk_1.mockCloudFormationClient).toHaveReceivedCommand(client_cloudformation_1.DescribeStackEventsCommand), 2);
        await monitor.stop();
        expect(monitor.errors).toStrictEqual([]);
    });
});
const T0 = 1597837230504;
// Events 0-99 are before we started paying attention
const T100 = T0 + 100 * 1000;
function event(nr) {
    return {
        EventId: `${nr}`,
        StackId: 'StackId',
        StackName: 'StackName',
        Timestamp: new Date(T0 + nr * 1000),
    };
}
function addErrorToStackEvent(eventToUpdate, props = {}) {
    eventToUpdate.ResourceStatus = props.resourceStatus ?? client_cloudformation_1.ResourceStatus.UPDATE_FAILED;
    eventToUpdate.ResourceType = props.resourceType ?? 'Test::Resource::Type';
    eventToUpdate.ResourceStatusReason = props.resourceStatusReason ?? 'Test Error';
    eventToUpdate.LogicalResourceId = props.logicalResourceId ?? 'testLogicalId';
    eventToUpdate.PhysicalResourceId = props.physicalResourceId ?? 'testPhysicalResourceId';
    return eventToUpdate;
}
class FakePrinter {
    constructor() {
        this.updateSleep = 0;
        this.activities = [];
    }
    get eventIds() {
        return this.activities.map((a) => a.event.EventId);
    }
    addActivity(activity) {
        this.activities.push(activity);
    }
    print() { }
    start() { }
    stop() { }
}
const wait = () => new Promise((resolve) => setTimeout(resolve, 5));
// Using the eventually function to ensure these functions have had sufficient time to execute.
const eventually = async (call, attempts) => {
    while (attempts-- >= 0) {
        try {
            return call();
        }
        catch (err) {
            if (attempts <= 0)
                throw err;
        }
        await wait();
    }
    throw new Error('An unexpected error has occurred.');
};
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoic3RhY2stbW9uaXRvci50ZXN0LmpzIiwic291cmNlUm9vdCI6IiIsInNvdXJjZXMiOlsic3RhY2stbW9uaXRvci50ZXN0LnRzIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiI7O0FBQUEsMEVBS3dDO0FBQ3hDLHlDQUErRDtBQUMvRCxxR0FJa0U7QUFFbEUsSUFBSSxHQUFZLENBQUM7QUFDakIsSUFBSSxPQUFvQixDQUFDO0FBQ3pCLElBQUksT0FBNkIsQ0FBQztBQUNsQyxVQUFVLENBQUMsR0FBRyxFQUFFO0lBQ2QsR0FBRyxHQUFHLElBQUksa0JBQU8sRUFBRSxDQUFDO0lBRXBCLE9BQU8sR0FBRyxJQUFJLFdBQVcsRUFBRSxDQUFDO0lBQzVCLE9BQU8sR0FBRyxJQUFJLDZDQUFvQixDQUFDLEdBQUcsQ0FBQyxjQUFjLEVBQUUsRUFBRSxXQUFXLEVBQUUsT0FBTyxFQUFFLFNBQVMsRUFBRSxJQUFJLElBQUksQ0FBQyxJQUFJLENBQUMsQ0FBQyxDQUFDLEtBQUssRUFBRSxDQUFDO0FBQ3BILENBQUMsQ0FBQyxDQUFDO0FBRUgsUUFBUSxDQUFDLDZDQUE2QyxFQUFFLEdBQUcsRUFBRTtJQUMzRCxJQUFJLENBQUMsd0NBQXdDLEVBQUUsS0FBSyxJQUFJLEVBQUU7UUFDeEQsbUNBQXdCLENBQUMsRUFBRSxDQUFDLGtEQUEwQixDQUFDLENBQUMsWUFBWSxDQUFDO1lBQ25FLFdBQVcsRUFBRSxDQUFDLEtBQUssQ0FBQyxHQUFHLENBQUMsRUFBRSxLQUFLLENBQUMsR0FBRyxDQUFDLENBQUM7U0FDdEMsQ0FBQyxDQUFDO1FBRUgsTUFBTSxVQUFVLENBQUMsR0FBRyxFQUFFLENBQUMsTUFBTSxDQUFDLG1DQUF3QixDQUFDLENBQUMscUJBQXFCLENBQUMsa0RBQTBCLENBQUMsRUFBRSxDQUFDLENBQUMsQ0FBQztRQUM5RyxNQUFNLE9BQU8sQ0FBQyxJQUFJLEVBQUUsQ0FBQztRQUVyQiwyQ0FBMkM7UUFDM0MsTUFBTSxDQUFDLE9BQU8sQ0FBQyxRQUFRLENBQUMsQ0FBQyxP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WyJpbXBvcnQge1xuICBEZXNjcmliZVN0YWNrRXZlbnRzQ29tbWFuZCxcbiAgUmVzb3VyY2VTdGF0dXMsXG4gIHR5cGUgU3RhY2tFdmVudCxcbiAgU3RhY2tTdGF0dXMsXG59IGZyb20gJ0Bhd3Mtc2RrL2NsaWVudC1jbG91ZGZvcm1hdGlvbic7XG5pbXBvcnQgeyBNb2NrU2RrLCBtb2NrQ2xvdWRGb3JtYXRpb25DbGllbnQgfSBmcm9tICcuL21vY2stc2RrJztcbmltcG9ydCB7XG4gIFN0YWNrQWN0aXZpdHlNb25pdG9yLFxuICB0eXBlIElBY3Rpdml0eVByaW50ZXIsXG4gIHR5cGUgU3RhY2tBY3Rpdml0eSxcbn0gZnJvbSAnLi4vLi4vbGliL2FwaS91dGlsL2Nsb3VkZm9ybWF0aW9uL3N0YWNrLWFjdGl2aXR5LW1vbml0b3InO1xuXG5sZXQgc2RrOiBNb2NrU2RrO1xubGV0IHByaW50ZXI6IEZha2VQcmludGVyO1xubGV0IG1vbml0b3I6IFN0YWNrQWN0aXZpdHlNb25pdG9yO1xuYmVmb3JlRWFjaCgoKSA9PiB7XG4gIHNkayA9IG5ldyBNb2NrU2RrKCk7XG5cbiAgcHJpbnRlciA9IG5ldyBGYWtlUHJpbnRlcigpO1xuICBtb25pdG9yID0gbmV3IFN0YWNrQWN0aXZpdHlNb25pdG9yKHNkay5jbG91ZEZvcm1hdGlvbigpLCAnU3RhY2tOYW1lJywgcHJpbnRlciwgdW5kZWZpbmVkLCBuZXcgRGF0ZShUMTAwKSkuc3RhcnQoKTtcbn0pO1xuXG5kZXNjcmliZSgnc3RhY2sgbW9uaXRvciBldmVudCBvcmRlcmluZyBhbmQgcGFnaW5hdGlvbicsICgpID0+IHtcbiAgdGVzdCgnY29udGludWUgdG8gdGhlIG5leHQgcGFnZSBpZiBpdCBleGlzdHMnLCBhc3luYyAoKSA9PiB7XG4gICAgbW9ja0Nsb3VkRm9ybWF0aW9uQ2xpZW50Lm9uKERlc2NyaWJlU3RhY2tFdmVudHNDb21tYW5kKS5yZXNvbHZlc09uY2Uoe1xuICAgICAgU3RhY2tFdmVudHM6IFtldmVudCgxMDIpLCBldmVudCgxMDEpXSxcbiAgICB9KTtcblxuICAgIGF3YWl0IGV2ZW50dWFsbHkoKCkgPT4gZXhwZWN0KG1vY2tDbG91ZEZvcm1hdGlvbkNsaWVudCkudG9IYXZlUmVjZWl2ZWRDb21tYW5kKERlc2NyaWJlU3RhY2tFdmVudHNDb21tYW5kKSwgMik7XG4gICAgYXdhaXQgbW9uaXRvci5zdG9wKCk7XG5cbiAgICAvLyBQcmludGVyIHNlZXMgdGhlbSBpbiBjaHJvbm9sb2dpY2FsIG9yZGVyXG4gICAgZXhwZWN0KHByaW50ZXIuZXZlbnRJZHMpLnRvRXF1YWwoWycxMDEnLCAnMTAyJ10pO1xuICB9KTtcblxuICB0ZXN0KCdkbyBub3QgcGFnZSBmdXJ0aGVyIGlmIHdlIGFscmVhZHkgc2F3IHRoZSBsYXN0IGV2ZW50JywgYXN5bmMgKCkgPT4ge1xuICAgIG1vY2tDbG91ZEZvcm1hdGlvbkNsaWVudFxuICAgICAgLm9uKERlc2NyaWJlU3RhY2tFdmVudHNDb21tYW5kKVxuICAgICAgLnJlc29sdmVzT25jZSh7XG4gICAgICAgIFN0YWNrRXZlbnRzOiBbZXZlbnQoMTAxKV0sXG4gICAgICB9KVxuICAgICAgLnJlc29sdmVzT25jZSh7XG4gICAgICAgIFN0YWNrRXZlbnRzOiBbZXZlbnQoMTAyKSwgZXZlbnQoMTAxKV0sXG4gICAgICB9KVxuICAgICAgLnJlc29sdmVzT25jZSh7fSk7XG5cbiAgICBhd2FpdCBldmVudHVhbGx5KCgpID0+IGV4cGVjdChtb2NrQ2xvdWRGb3JtYXRpb25DbGllbnQpLnRvSGF2ZVJlY2VpdmVkQ29tbWFuZChEZXNjcmliZVN0YWNrRXZlbnRzQ29tbWFuZCksIDIpO1xuICAgIGF3YWl0IG1vbml0b3Iuc3RvcCgpO1xuXG4gICAgLy8gU2VlbiBpbiBjaHJvbm9sb2dpY2FsIG9yZGVyXG4gICAgZXhwZWN0KHByaW50ZXIuZXZlbnRJZHMpLnRvRXF1YWwoWycxMDEnLCAnMTAyJ10pO1xuICB9KTtcblxuICB0ZXN0KCdkbyBub3QgcGFnZSBmdXJ0aGVyIGlmIHRoZSBsYXN0IGV2ZW50IGlzIHRvbyBvbGQnLCBhc3luYyAoKSA9PiB7XG4gICAgbW9ja0Nsb3VkRm9ybWF0aW9uQ2xpZW50XG4gICAgICAub24oRGVzY3JpYmVTdGFja0V2ZW50c0NvbW1hbmQpXG4gICAgICAucmVzb2x2ZXNPbmNlKHtcbiAgICAgICAgU3RhY2tFdmVudHM6IFtldmVudCgxMDEpLCBldmVudCg5NSldLFxuICAgICAgfSlcbiAgICAgIC5yZXNvbHZlc09uY2Uoe1xuICAgICAgICBTdGFja0V2ZW50czogW10sXG4gICAgICB9KTtcblxuICAgIGF3YWl0IGV2ZW50dWFsbHkoKCkgPT4gZXhwZWN0KG1vY2tDbG91ZEZvcm1hdGlvbkNsaWVudCkudG9IYXZlUmVjZWl2ZWRDb21tYW5kKERlc2NyaWJlU3RhY2tFdmVudHNDb21tYW5kKSwgMik7XG4gICAgYXdhaXQgbW9uaXRvci5zdG9wKCk7XG5cbiAgICAvLyBTZWVuIG9ubHkgdGhlIG5ldyBvbmVcbiAgICBleHBlY3QocHJpbnRlci5ldmVudElkcykudG9FcXVhbChbJzEwMSddKTtcbiAgfSk7XG5cbiAgdGVzdCgnZG8gYSBmaW5hbCByZXF1ZXN0IGFmdGVyIHRoZSBtb25pdG9yIGlzIHN0b3BwZWQnLCBhc3luYyAoKSA9PiB7XG4gICAgbW9ja0Nsb3VkRm9ybWF0aW9uQ2xpZW50Lm9uKERlc2NyaWJlU3RhY2tFdmVudHNDb21tYW5kKS5yZXNvbHZlcyh7XG4gICAgICBTdGFja0V2ZW50czogW2V2ZW50KDEwMSldLFxuICAgIH0pO1xuICAgIC8vIEVzdGFibGlzaCB0aGF0IHdlJ3ZlIHJlY2VpdmVkIGV2ZW50cyBwcmlvciB0byBzdG9wIGFuZCB0aGVuIHJlc2V0IHRoZSBtb2NrXG4gICAgYXdhaXQgZXZlbnR1YWxseSgoKSA9PiBleHBlY3QobW9ja0Nsb3VkRm9ybWF0aW9uQ2xpZW50KS50b0hhdmVSZWNlaXZlZENvbW1hbmQoRGVzY3JpYmVTdGFja0V2ZW50c0NvbW1hbmQpLCAyKTtcbiAgICBtb2NrQ2xvdWRGb3JtYXRpb25DbGllbnQucmVzZXRIaXN0b3J5KCk7XG4gICAgYXdhaXQgbW9uaXRvci5zdG9wKCk7XG4gICAgbW9ja0Nsb3VkRm9ybWF0aW9uQ2xpZW50Lm9uKERlc2NyaWJlU3RhY2tFdmVudHNDb21tYW5kKS5yZXNvbHZlcyh7XG4gICAgICBTdGFja0V2ZW50czogW2V2ZW50KDEwMiksIGV2ZW50KDEwMSldLFxuICAgIH0pO1xuICAgIC8vIFNpbmNlIHdlIGNhbid0IHJlc2V0IHRoZSBtb2NrIHRvIGEgbmV3IHZhbHVlIGJlZm9yZSBjYWxsaW5nIHN0b3AsIHdlJ2xsIGhhdmUgdG8gY2hlY2tcbiAgICAvLyBhbmQgbWFrZSBzdXJlIGl0J3MgY2FsbGVkIGFnYWluIGluc3RlYWQuXG4gICAgZXhwZWN0KG1vY2tDbG91ZEZvcm1hdGlvbkNsaWVudCkudG9IYXZlUmVjZWl2ZWRDb21tYW5kKERlc2NyaWJlU3RhY2tFdmVudHNDb21tYW5kKTtcbiAgfSk7XG59KTtcblxuZGVzY3JpYmUoJ3N0YWNrIG1vbml0b3IsIGNvbGxlY3RpbmcgZXJyb3JzIGZyb20gZXZlbnRzJywgKCkgPT4ge1xuICB0ZXN0KCdyZXR1cm4gZXJyb3JzIGZyb20gdGhlIHJvb3Qgc3RhY2snLCBhc3luYyAoKSA9PiB7XG4gICAgbW9ja0Nsb3VkRm9ybWF0aW9uQ2xpZW50Lm9uKERlc2NyaWJlU3RhY2tFdmVudHNDb21tYW5kKS5yZXNvbHZlc09uY2Uoe1xuICAgICAgU3RhY2tFdmVudHM6IFthZGRFcnJvclRvU3RhY2tFdmVudChldmVudCgxMDApKV0sXG4gICAgfSk7XG5cbiAgICBhd2FpdCBldmVudHVhbGx5KCgpID0+IGV4cGVjdChtb2NrQ2xvdWRGb3JtYXRpb25DbGllbnQpLnRvSGF2ZVJlY2VpdmVkQ29tbWFuZChEZXNjcmliZVN0YWNrRXZlbnRzQ29tbWFuZCksIDIpO1xuICAgIGF3YWl0IG1vbml0b3Iuc3RvcCgpO1xuICAgIGV4cGVjdChtb25pdG9yLmVycm9ycykudG9TdHJpY3RFcXVhbChbJ1Rlc3QgRXJyb3InXSk7XG4gIH0pO1xuXG4gIHRlc3QoJ3JldHVybiBlcnJvcnMgZnJvbSB0aGUgbmVzdGVkIHN0YWNrJywgYXN5bmMgKCkgPT4ge1xuICAgIG1vY2tDbG91ZEZvcm1hdGlvbkNsaWVudFxuICAgICAgLm9uKERlc2NyaWJlU3RhY2tFdmVudHNDb21tYW5kKVxuICAgICAgLnJlc29sdmVzT25jZSh7XG4gICAgICAgIFN0YWNrRXZlbnRzOiBbXG4gICAgICAgICAgYWRkRXJyb3JUb1N0YWNrRXZlbnQoZXZlbnQoMTAyKSwge1xuICAgICAgICAgICAgbG9naWNhbFJlc291cmNlSWQ6ICduZXN0ZWRTdGFja0xvZ2ljYWxSZXNvdXJjZUlkJyxcbiAgICAgICAgICAgIHBoeXNpY2FsUmVzb3VyY2VJZDogJ25lc3RlZFN0YWNrUGh5c2ljYWxSZXNvdXJjZUlkJyxcbiAgICAgICAgICAgIHJlc291cmNlVHlwZTogJ0FXUzo6Q2xvdWRGb3JtYXRpb246OlN0YWNrJyxcbiAgICAgICAgICAgIHJlc291cmNlU3RhdHVzUmVhc29uOiAnbmVzdGVkIHN0YWNrIGZhaWxlZCcsXG4gICAgICAgICAgICByZXNvdXJjZVN0YXR1czogUmVzb3VyY2VTdGF0dXMuVVBEQVRFX0ZBSUxFRCxcbiAgICAgICAgICB9KSxcbiAgICAgICAgICBhZGRFcnJvclRvU3RhY2tFdmVudChldmVudCgxMDApLCB7XG4gICAgICAgICAgICBsb2dpY2FsUmVzb3VyY2VJZDogJ25lc3RlZFN0YWNrTG9naWNhbFJlc291cmNlSWQnLFxuICAgICAgICAgICAgcGh5c2ljYWxSZXNvdXJjZUlkOiAnbmVzdGVkU3RhY2tQaHlzaWNhbFJlc291cmNlSWQnLFxuICAgICAgICAgICAgcmVzb3VyY2VUeXBlOiAnQVdTOjpDbG91ZEZvcm1hdGlvbjo6U3RhY2snLFxuICAgICAgICAgICAgcmVzb3VyY2VTdGF0dXM6IFJlc291cmNlU3RhdHVzLlVQREFURV9JTl9QUk9HUkVTUyxcbiAgICAgICAgICB9KSxcbiAgICAgICAgXSxcbiAgICAgIH0pXG4gICAgICAucmVzb2x2ZXNPbmNlKHtcbiAgICAgICAgU3RhY2tFdmVudHM6IFtcbiAgICAgICAgICBhZGRFcnJvclRvU3RhY2tFdmVudChldmVudCgxMDEpLCB7XG4gICAgICAgICAgICBsb2dpY2FsUmVzb3VyY2VJZDogJ25lc3RlZFJlc291cmNlJyxcbiAgICAgICAgICAgIHJlc291cmNlVHlwZTogJ1NvbWU6Ok5lc3RlZDo6UmVzb3VyY2UnLFxuICAgICAgICAgICAgcmVzb3VyY2VTdGF0dXNSZWFzb246ICdhY3R1YWwgZmFpbHVyZSBlcnJvciBtZXNzYWdlJyxcbiAgICAgICAgICB9KSxcbiAgICAgICAgXSxcbiAgICAgIH0pO1xuXG4gICAgYXdhaXQgZXZlbnR1YWxseShcbiAgICAgICgpID0+XG4gICAgICAgIGV4cGVjdChtb2NrQ2xvdWRGb3JtYXRpb25DbGllbnQpLnRvSGF2ZVJlY2VpdmVkTnRoQ29tbWFuZFdpdGgoMSwgRGVzY3JpYmVTdGFja0V2ZW50c0NvbW1hbmQsIHtcbiAgICAgICAgICBTdGFja05hbWU6ICdTdGFja05hbWUnLFxuICAgICAgICB9KSxcbiAgICAgIDIsXG4gICAgKTtcblxuICAgIGF3YWl0IGV2ZW50dWFsbHkoXG4gICAgICAoKSA9PlxuICAgICAgICBleHBlY3QobW9ja0Nsb3VkRm9ybWF0aW9uQ2xpZW50KS50b0hhdmVSZWNlaXZlZE50aENvbW1hbmRXaXRoKDIsIERlc2NyaWJlU3RhY2tFdmVudHNDb21tYW5kLCB7XG4gICAgICAgICAgU3RhY2tOYW1lOiAnbmVzdGVkU3RhY2tQaHlzaWNhbFJlc291cmNlSWQnLFxuICAgICAgICB9KSxcbiAgICAgIDIsXG4gICAgKTtcbiAgICBhd2FpdCBtb25pdG9yLnN0b3AoKTtcbiAgICBleHBlY3QobW9uaXRvci5lcnJvcnMpLnRvU3RyaWN0RXF1YWwoWydhY3R1YWwgZmFpbHVyZSBlcnJvciBtZXNzYWdlJywgJ25lc3RlZCBzdGFjayBmYWlsZWQnXSk7XG4gIH0pO1xuXG4gIHRlc3QoJ2RvZXMgbm90IGNvbnNpZGVyIGV2ZW50cyB3aXRob3V0IHBoeXNpY2FsIHJlc291cmNlIGlkIGZvciBtb25pdG9yaW5nIG5lc3RlZCBzdGFja3MnLCBhc3luYyAoKSA9PiB7XG4gICAgbW9ja0Nsb3VkRm9ybWF0aW9uQ2xpZW50XG4gICAgICAub24oRGVzY3JpYmVTdGFja0V2ZW50c0NvbW1hbmQpXG4gICAgICAucmVzb2x2ZXNPbmNlKHtcbiAgICAgICAgU3RhY2tFdmVudHM6IFtcbiAgICAgICAgICBhZGRFcnJvclRvU3RhY2tFdmVudChldmVudCgxMDApLCB7XG4gICAgICAgICAgICBsb2dpY2FsUmVzb3VyY2VJZDogJ25lc3RlZFN0YWNrTG9naWNhbFJlc291cmNlSWQnLFxuICAgICAgICAgICAgcGh5c2ljYWxSZXNvdXJjZUlkOiAnJyxcbiAgICAgICAgICAgIHJlc291cmNlVHlwZTogJ0FXUzo6Q2xvdWRGb3JtYXRpb246OlN0YWNrJyxcbiAgICAgICAgICAgIHJlc291cmNlU3RhdHVzUmVhc29uOiAnbmVzdGVkIHN0YWNrIGZhaWxlZCcsXG4gICAgICAgICAgfSksXG4gICAgICAgIF0sXG4gICAgICAgIE5leHRUb2tlbjogJ25leHRUb2tlbicsXG4gICAgICB9KVxuICAgICAgLnJlc29sdmVzT25jZSh7XG4gICAgICAgIFN0YWNrRXZlbnRzOiBbXG4gICAgICAgICAgYWRkRXJyb3JUb1N0YWNrRXZlbnQoZXZlbnQoMTAxKSwge1xuICAgICAgICAgICAgbG9naWNhbFJlc291cmNlSWQ6ICdPdGhlclJlc291cmNlJyxcbiAgICAgICAgICAgIHJlc291cmNlVHlwZTogJ1NvbWU6Ok90aGVyOjpSZXNvdXJjZScsXG4gICAgICAgICAgICByZXNvdXJjZVN0YXR1c1JlYXNvbjogJ3NvbWUgZmFpbHVyZScsXG4gICAgICAgICAgfSksXG4gICAgICAgIF0sXG4gICAgICB9KTtcblxuICAgIGF3YWl0IGV2ZW50dWFsbHkoKCkgPT4gZXhwZWN0KG1vY2tDbG91ZEZvcm1hdGlvbkNsaWVudCkudG9IYXZlUmVjZWl2ZWRDb21tYW5kKERlc2NyaWJlU3RhY2tFdmVudHNDb21tYW5kKSwgMik7XG4gICAgYXdhaXQgbW9uaXRvci5zdG9wKCk7XG5cbiAgICBleHBlY3QobW9uaXRvci5lcnJvcnMpLnRvU3RyaWN0RXF1YWwoWyduZXN0ZWQgc3RhY2sgZmFpbGVkJywgJ3NvbWUgZmFpbHVyZSddKTtcbiAgICBleHBlY3QobW9ja0Nsb3VkRm9ybWF0aW9uQ2xpZW50KS50b0hhdmVSZWNlaXZlZE50aENvbW1hbmRXaXRoKDEsIERlc2NyaWJlU3RhY2tFdmVudHNDb21tYW5kLCB7XG4gICAgICBTdGFja05hbWU6ICdTdGFja05hbWUnLFxuICAgIH0pO1xuICAgIC8vIE5vdGUgdGhhdCB0aGUgc2Vjb25kIGNhbGwgaGFwcGVuZWQgZm9yIHRoZSB0b3AgbGV2ZWwgc3RhY2sgaW5zdGVhZCBvZiBhIG5lc3RlZCBzdGFja1xuICAgIGV4cGVjdChtb2NrQ2xvdWRGb3JtYXRpb25DbGllbnQpLnRvSGF2ZVJlY2VpdmVkTnRoQ29tbWFuZFdpdGgoMiwgRGVzY3JpYmVTdGFja0V2ZW50c0NvbW1hbmQsIHtcbiAgICAgIFN0YWNrTmFtZTogJ1N0YWNrTmFtZScsXG4gICAgfSk7XG4gIH0pO1xuXG4gIHRlc3QoJ2RvZXMgbm90IGNoZWNrIGZvciBuZXN0ZWQgc3RhY2tzIHRoYXQgaGF2ZSBhbHJlYWR5IGNvbXBsZXRlZCBzdWNjZXNzZnVsbHknLCBhc3luYyAoKSA9PiB7XG4gICAgbW9ja0Nsb3VkRm9ybWF0aW9uQ2xpZW50Lm9uKERlc2NyaWJlU3RhY2tFdmVudHNDb21tYW5kKS5yZXNvbHZlc09uY2Uoe1xuICAgICAgU3RhY2tFdmVudHM6IFtcbiAgICAgICAgYWRkRXJyb3JUb1N0YWNrRXZlbnQoZXZlbnQoMTAwKSwge1xuICAgICAgICAgIGxvZ2ljYWxSZXNvdXJjZUlkOiAnbmVzdGVkU3RhY2tMb2dpY2FsUmVzb3VyY2VJZCcsXG4gICAgICAgICAgcGh5c2ljYWxSZXNvdXJjZUlkOiAnbmVzdGVkU3RhY2tQaHlzaWNhbFJlc291cmNlSWQnLFxuICAgICAgICAgIHJlc291cmNlVHlwZTogJ0FXUzo6Q2xvdWRGb3JtYXRpb246OlN0YWNrJyxcbiAgICAgICAgICByZXNvdXJjZVN0YXR1c1JlYXNvbjogJ25lc3RlZCBzdGFjayBzdGF0dXMgcmVhc29uJyxcbiAgICAgICAgICByZXNvdXJjZVN0YXR1czogU3RhY2tTdGF0dXMuQ1JFQVRFX0NPTVBMRVRFLFxuICAgICAgICB9KSxcbiAgICAgIF0sXG4gICAgfSk7XG5cbiAgICBhd2FpdCBldmVudHVhbGx5KCgpID0+IGV4cGVjdChtb2NrQ2xvdWRGb3JtYXRpb25DbGllbnQpLnRvSGF2ZVJlY2VpdmVkQ29tbWFuZChEZXNjcmliZVN0YWNrRXZlbnRzQ29tbWFuZCksIDIpO1xuICAgIGF3YWl0IG1vbml0b3Iuc3RvcCgpO1xuXG4gICAgZXhwZWN0KG1vbml0b3IuZXJyb3JzKS50b1N0cmljdEVxdWFsKFtdKTtcbiAgfSk7XG59KTtcblxuY29uc3QgVDAgPSAxNTk3ODM3MjMwNTA0O1xuXG4vLyBFdmVudHMgMC05OSBhcmUgYmVmb3JlIHdlIHN0YXJ0ZWQgcGF5aW5nIGF0dGVudGlvblxuY29uc3QgVDEwMCA9IFQwICsgMTAwICogMTAwMDtcblxuZnVuY3Rpb24gZXZlbnQobnI6IG51bWJlcik6IFN0YWNrRXZlbnQge1xuICByZXR1cm4ge1xuICAgIEV2ZW50SWQ6IGAke25yfWAsXG4gICAgU3RhY2tJZDogJ1N0YWNrSWQnLFxuICAgIFN0YWNrTmFtZTogJ1N0YWNrTmFtZScsXG4gICAgVGltZXN0YW1wOiBuZXcgRGF0ZShUMCArIG5yICogMTAwMCksXG4gIH07XG59XG5cbmZ1bmN0aW9uIGFkZEVycm9yVG9TdGFja0V2ZW50KFxuICBldmVudFRvVXBkYXRlOiBTdGFja0V2ZW50LFxuICBwcm9wczoge1xuICAgIHJlc291cmNlU3RhdHVzPzogUmVzb3VyY2VTdGF0dXM7XG4gICAgcmVzb3VyY2VUeXBlPzogc3RyaW5nO1xuICAgIHJlc291cmNlU3RhdHVzUmVhc29uPzogc3RyaW5nO1xuICAgIGxvZ2ljYWxSZXNvdXJjZUlkPzogc3RyaW5nO1xuICAgIHBoeXNpY2FsUmVzb3VyY2VJZD86IHN0cmluZztcbiAgfSA9IHt9LFxuKTogU3RhY2tFdmVudCB7XG4gIGV2ZW50VG9VcGRhdGUuUmVzb3VyY2VTdGF0dXMgPSBwcm9wcy5yZXNvdXJjZVN0YXR1cyA/PyBSZXNvdXJjZVN0YXR1cy5VUERBVEVfRkFJTEVEO1xuICBldmVudFRvVXBkYXRlLlJlc291cmNlVHlwZSA9IHByb3BzLnJlc291cmNlVHlwZSA/PyAnVGVzdDo6UmVzb3VyY2U6OlR5cGUnO1xuICBldmVudFRvVXBkYXRlLlJlc291cmNlU3RhdHVzUmVhc29uID0gcHJvcHMucmVzb3VyY2VTdGF0dXNSZWFzb24gPz8gJ1Rlc3QgRXJyb3InO1xuICBldmVudFRvVXBkYXRlLkxvZ2ljYWxSZXNvdXJjZUlkID0gcHJvcHMubG9naWNhbFJlc291cmNlSWQgPz8gJ3Rlc3RMb2dpY2FsSWQnO1xuICBldmVudFRvVXBkYXRlLlBoeXNpY2FsUmVzb3VyY2VJZCA9IHByb3BzLnBoeXNpY2FsUmVzb3VyY2VJZCA/PyAndGVzdFBoeXNpY2FsUmVzb3VyY2VJZCc7XG4gIHJldHVybiBldmVudFRvVXBkYXRlO1xufVxuXG5jbGFzcyBGYWtlUHJpbnRlciBpbXBsZW1lbnRzIElBY3Rpdml0eVByaW50ZXIge1xuICBwdWJsaWMgdXBkYXRlU2xlZXA6IG51bWJlciA9IDA7XG4gIHB1YmxpYyByZWFkb25seSBhY3Rpdml0aWVzOiBTdGFja0FjdGl2aXR5W10gPSBbXTtcblxuICBwdWJsaWMgZ2V0IGV2ZW50SWRzKCkge1xuICAgIHJldHVybiB0aGlzLmFjdGl2aXRpZXMubWFwKChhKSA9PiBhLmV2ZW50LkV2ZW50SWQpO1xuICB9XG5cbiAgcHVibGljIGFkZEFjdGl2aXR5KGFjdGl2aXR5OiBTdGFja0FjdGl2aXR5KTogdm9pZCB7XG4gICAgdGhpcy5hY3Rpdml0aWVzLnB1c2goYWN0aXZpdHkpO1xuICB9XG5cbiAgcHVibGljIHByaW50KCk6IHZvaWQge31cbiAgcHVibGljIHN0YXJ0KCk6IHZvaWQge31cbiAgcHVibGljIHN0b3AoKTogdm9pZCB7fVxufVxuXG5jb25zdCB3YWl0ID0gKCk6IFByb21pc2U8dm9pZD4gPT4gbmV3IFByb21pc2UoKHJlc29sdmUpID0+IHNldFRpbWVvdXQocmVzb2x2ZSwgNSkpO1xuXG4vLyBVc2luZyB0aGUgZXZlbnR1YWxseSBmdW5jdGlvbiB0byBlbnN1cmUgdGhlc2UgZnVuY3Rpb25zIGhhdmUgaGFkIHN1ZmZpY2llbnQgdGltZSB0byBleGVjdXRlLlxuY29uc3QgZXZlbnR1YWxseSA9IGFzeW5jIChjYWxsOiAoKSA9PiB2b2lkLCBhdHRlbXB0czogbnVtYmVyKTogUHJvbWlzZTx2b2lkPiA9PiB7XG4gIHdoaWxlIChhdHRlbXB0cy0tID49IDApIHtcbiAgICB0cnkge1xuICAgICAgcmV0dXJuIGNhbGwoKTtcbiAgICB9IGNhdGNoIChlcnIpIHtcbiAgICAgIGlmIChhdHRlbXB0cyA8PSAwKSB0aHJvdyBlcnI7XG4gICAgfVxuICAgIGF3YWl0IHdhaXQoKTtcbiAgfVxuXG4gIHRocm93IG5ldyBFcnJvcignQW4gdW5leHBlY3RlZCBlcnJvciBoYXMgb2NjdXJyZWQuJyk7XG59O1xuIl19