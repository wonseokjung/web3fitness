"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.CurrentActivityPrinter = exports.HistoryActivityPrinter = exports.StackActivityMonitor = exports.StackActivityProgress = void 0;
const util = require("util");
const cloud_assembly_schema_1 = require("@aws-cdk/cloud-assembly-schema");
const chalk = require("chalk");
const stack_event_poller_1 = require("./stack-event-poller");
const logging_1 = require("../../../logging");
const display_1 = require("../display");
/**
 * Supported display modes for stack deployment activity
 */
var StackActivityProgress;
(function (StackActivityProgress) {
    /**
     * Displays a progress bar with only the events for the resource currently being deployed
     */
    StackActivityProgress["BAR"] = "bar";
    /**
     * Displays complete history with all CloudFormation stack events
     */
    StackActivityProgress["EVENTS"] = "events";
})(StackActivityProgress || (exports.StackActivityProgress = StackActivityProgress = {}));
class StackActivityMonitor {
    /**
     * Create a Stack Activity Monitor using a default printer, based on context clues
     */
    static withDefaultPrinter(cfn, stackName, stackArtifact, options = {}) {
        const stream = options.ci ? process.stdout : process.stderr;
        const props = {
            resourceTypeColumnWidth: calcMaxResourceTypeLength(stackArtifact.template),
            resourcesTotal: options.resourcesTotal,
            stream,
        };
        const isWindows = process.platform === 'win32';
        const verbose = options.logLevel ?? logging_1.logLevel;
        // On some CI systems (such as CircleCI) output still reports as a TTY so we also
        // need an individual check for whether we're running on CI.
        // see: https://discuss.circleci.com/t/circleci-terminal-is-a-tty-but-term-is-not-set/9965
        const fancyOutputAvailable = !isWindows && stream.isTTY && !options.ci;
        const progress = options.progress ?? StackActivityProgress.BAR;
        const printer = fancyOutputAvailable && !verbose && progress === StackActivityProgress.BAR
            ? new CurrentActivityPrinter(props)
            : new HistoryActivityPrinter(props);
        return new StackActivityMonitor(cfn, stackName, printer, stackArtifact, options.changeSetCreationTime);
    }
    constructor(cfn, stackName, printer, stack, changeSetCreationTime) {
        this.stackName = stackName;
        this.printer = printer;
        this.stack = stack;
        this.errors = [];
        this.active = false;
        this.poller = new stack_event_poller_1.StackEventPoller(cfn, {
            stackName,
            startTime: changeSetCreationTime?.getTime() ?? Date.now(),
        });
    }
    start() {
        this.active = true;
        this.printer.start();
        this.scheduleNextTick();
        return this;
    }
    async stop() {
        this.active = false;
        if (this.tickTimer) {
            clearTimeout(this.tickTimer);
        }
        // Do a final poll for all events. This is to handle the situation where DescribeStackStatus
        // already returned an error, but the monitor hasn't seen all the events yet and we'd end
        // up not printing the failure reason to users.
        await this.finalPollToEnd();
        this.printer.stop();
    }
    scheduleNextTick() {
        if (!this.active) {
            return;
        }
        this.tickTimer = setTimeout(() => void this.tick(), this.printer.updateSleep);
    }
    async tick() {
        if (!this.active) {
            return;
        }
        try {
            this.readPromise = this.readNewEvents();
            await this.readPromise;
            this.readPromise = undefined;
            // We might have been stop()ped while the network call was in progress.
            if (!this.active) {
                return;
            }
            this.printer.print();
        }
        catch (e) {
            (0, logging_1.error)('Error occurred while monitoring stack: %s', e);
        }
        this.scheduleNextTick();
    }
    findMetadataFor(logicalId) {
        const metadata = this.stack?.manifest?.metadata;
        if (!logicalId || !metadata) {
            return undefined;
        }
        for (const path of Object.keys(metadata)) {
            const entry = metadata[path]
                .filter((e) => e.type === cloud_assembly_schema_1.ArtifactMetadataEntryType.LOGICAL_ID)
                .find((e) => e.data === logicalId);
            if (entry) {
                return {
                    entry,
                    constructPath: this.simplifyConstructPath(path),
                };
            }
        }
        return undefined;
    }
    /**
     * Reads all new events from the stack history
     *
     * The events are returned in reverse chronological order; we continue to the next page if we
     * see a next page and the last event in the page is new to us (and within the time window).
     * haven't seen the final event
     */
    async readNewEvents() {
        const pollEvents = await this.poller.poll();
        const activities = pollEvents.map((event) => ({
            ...event,
            metadata: this.findMetadataFor(event.event.LogicalResourceId),
        }));
        for (const activity of activities) {
            this.checkForErrors(activity);
            this.printer.addActivity(activity);
        }
    }
    /**
     * Perform a final poll to the end and flush out all events to the printer
     *
     * Finish any poll currently in progress, then do a final one until we've
     * reached the last page.
     */
    async finalPollToEnd() {
        // If we were doing a poll, finish that first. It was started before
        // the moment we were sure we weren't going to get any new events anymore
        // so we need to do a new one anyway. Need to wait for this one though
        // because our state is single-threaded.
        if (this.readPromise) {
            await this.readPromise;
        }
        await this.readNewEvents();
    }
    checkForErrors(activity) {
        if (hasErrorMessage(activity.event.ResourceStatus ?? '')) {
            const isCancelled = (activity.event.ResourceStatusReason ?? '').indexOf('cancelled') > -1;
            // Cancelled is not an interesting failure reason, nor is the stack message (stack
            // message will just say something like "stack failed to update")
            if (!isCancelled && activity.event.StackName !== activity.event.LogicalResourceId) {
                this.errors.push(activity.event.ResourceStatusReason ?? '');
            }
        }
    }
    simplifyConstructPath(path) {
        path = path.replace(/\/Resource$/, '');
        path = path.replace(/^\//, ''); // remove "/" prefix
        // remove "<stack-name>/" prefix
        if (path.startsWith(this.stackName + '/')) {
            path = path.slice(this.stackName.length + 1);
        }
        return path;
    }
}
exports.StackActivityMonitor = StackActivityMonitor;
function padRight(n, x) {
    return x + ' '.repeat(Math.max(0, n - x.length));
}
/**
 * Infamous padLeft()
 */
function padLeft(n, x) {
    return ' '.repeat(Math.max(0, n - x.length)) + x;
}
function calcMaxResourceTypeLength(template) {
    const resources = (template && template.Resources) || {};
    let maxWidth = 0;
    for (const id of Object.keys(resources)) {
        const type = resources[id].Type || '';
        if (type.length > maxWidth) {
            maxWidth = type.length;
        }
    }
    return maxWidth;
}
class ActivityPrinterBase {
    constructor(props) {
        this.props = props;
        /**
         * Fetch new activity every 5 seconds
         */
        this.updateSleep = 5000;
        /**
         * A list of resource IDs which are currently being processed
         */
        this.resourcesInProgress = {};
        /**
         * Previous completion state observed by logical ID
         *
         * We use this to detect that if we see a DELETE_COMPLETE after a
         * CREATE_COMPLETE, it's actually a rollback and we should DECREASE
         * resourcesDone instead of increase it
         */
        this.resourcesPrevCompleteState = {};
        /**
         * Count of resources that have reported a _COMPLETE status
         */
        this.resourcesDone = 0;
        /**
         * How many digits we need to represent the total count (for lining up the status reporting)
         */
        this.resourceDigits = 0;
        this.rollingBack = false;
        this.failures = new Array();
        this.hookFailureMap = new Map();
        // +1 because the stack also emits a "COMPLETE" event at the end, and that wasn't
        // counted yet. This makes it line up with the amount of events we expect.
        this.resourcesTotal = props.resourcesTotal ? props.resourcesTotal + 1 : undefined;
        // How many digits does this number take to represent?
        this.resourceDigits = this.resourcesTotal ? Math.ceil(Math.log10(this.resourcesTotal)) : 0;
        this.stream = props.stream;
    }
    failureReason(activity) {
        const resourceStatusReason = activity.event.ResourceStatusReason ?? '';
        const logicalResourceId = activity.event.LogicalResourceId ?? '';
        const hookFailureReasonMap = this.hookFailureMap.get(logicalResourceId);
        if (hookFailureReasonMap !== undefined) {
            for (const hookType of hookFailureReasonMap.keys()) {
                if (resourceStatusReason.includes(hookType)) {
                    return resourceStatusReason + ' : ' + hookFailureReasonMap.get(hookType);
                }
            }
        }
        return resourceStatusReason;
    }
    addActivity(activity) {
        const status = activity.event.ResourceStatus;
        const hookStatus = activity.event.HookStatus;
        const hookType = activity.event.HookType;
        if (!status || !activity.event.LogicalResourceId) {
            return;
        }
        if (status === 'ROLLBACK_IN_PROGRESS' || status === 'UPDATE_ROLLBACK_IN_PROGRESS') {
            // Only triggered on the stack once we've started doing a rollback
            this.rollingBack = true;
        }
        if (status.endsWith('_IN_PROGRESS')) {
            this.resourcesInProgress[activity.event.LogicalResourceId] = activity;
        }
        if (hasErrorMessage(status)) {
            const isCancelled = (activity.event.ResourceStatusReason ?? '').indexOf('cancelled') > -1;
            // Cancelled is not an interesting failure reason
            if (!isCancelled) {
                this.failures.push(activity);
            }
        }
        if (status.endsWith('_COMPLETE') || status.endsWith('_FAILED')) {
            delete this.resourcesInProgress[activity.event.LogicalResourceId];
        }
        if (status.endsWith('_COMPLETE_CLEANUP_IN_PROGRESS')) {
            this.resourcesDone++;
        }
        if (status.endsWith('_COMPLETE')) {
            const prevState = this.resourcesPrevCompleteState[activity.event.LogicalResourceId];
            if (!prevState) {
                this.resourcesDone++;
            }
            else {
                // If we completed this before and we're completing it AGAIN, means we're rolling back.
                // Protect against silly underflow.
                this.resourcesDone--;
                if (this.resourcesDone < 0) {
                    this.resourcesDone = 0;
                }
            }
            this.resourcesPrevCompleteState[activity.event.LogicalResourceId] = status;
        }
        if (hookStatus !== undefined &&
            hookStatus.endsWith('_COMPLETE_FAILED') &&
            activity.event.LogicalResourceId !== undefined &&
            hookType !== undefined) {
            if (this.hookFailureMap.has(activity.event.LogicalResourceId)) {
                this.hookFailureMap.get(activity.event.LogicalResourceId)?.set(hookType, activity.event.HookStatusReason ?? '');
            }
            else {
                this.hookFailureMap.set(activity.event.LogicalResourceId, new Map());
                this.hookFailureMap.get(activity.event.LogicalResourceId)?.set(hookType, activity.event.HookStatusReason ?? '');
            }
        }
    }
    start() {
        // Empty on purpose
    }
    stop() {
        // Empty on purpose
    }
}
/**
 * Activity Printer which shows a full log of all CloudFormation events
 *
 * When there hasn't been activity for a while, it will print the resources
 * that are currently in progress, to show what's holding up the deployment.
 */
class HistoryActivityPrinter extends ActivityPrinterBase {
    constructor(props) {
        super(props);
        /**
         * Last time we printed something to the console.
         *
         * Used to measure timeout for progress reporting.
         */
        this.lastPrintTime = Date.now();
        /**
         * Number of ms of change absence before we tell the user about the resources that are currently in progress.
         */
        this.inProgressDelay = 30000;
        this.printable = new Array();
    }
    addActivity(activity) {
        super.addActivity(activity);
        this.printable.push(activity);
        this.print();
    }
    print() {
        for (const activity of this.printable) {
            this.printOne(activity);
        }
        this.printable.splice(0, this.printable.length);
        this.printInProgress();
    }
    stop() {
        // Print failures at the end
        if (this.failures.length > 0) {
            this.stream.write('\nFailed resources:\n');
            for (const failure of this.failures) {
                // Root stack failures are not interesting
                if (failure.isStackEvent) {
                    continue;
                }
                this.printOne(failure, false);
            }
        }
    }
    printOne(activity, progress) {
        const event = activity.event;
        const color = colorFromStatusResult(event.ResourceStatus);
        let reasonColor = chalk.cyan;
        let stackTrace = '';
        const metadata = activity.metadata;
        if (event.ResourceStatus && event.ResourceStatus.indexOf('FAILED') !== -1) {
            if (progress == undefined || progress) {
                event.ResourceStatusReason = event.ResourceStatusReason ? this.failureReason(activity) : '';
            }
            if (metadata) {
                stackTrace = metadata.entry.trace ? `\n\t${metadata.entry.trace.join('\n\t\\_ ')}` : '';
            }
            reasonColor = chalk.red;
        }
        const resourceName = metadata ? metadata.constructPath : event.LogicalResourceId || '';
        const logicalId = resourceName !== event.LogicalResourceId ? `(${event.LogicalResourceId}) ` : '';
        this.stream.write(util.format('%s | %s%s | %s | %s | %s %s%s%s\n', event.StackName, progress !== false ? `${this.progress()} | ` : '', new Date(event.Timestamp).toLocaleTimeString(), color(padRight(STATUS_WIDTH, (event.ResourceStatus || '').slice(0, STATUS_WIDTH))), // pad left and trim
        padRight(this.props.resourceTypeColumnWidth, event.ResourceType || ''), color(chalk.bold(resourceName)), logicalId, reasonColor(chalk.bold(event.ResourceStatusReason ? event.ResourceStatusReason : '')), reasonColor(stackTrace)));
        this.lastPrintTime = Date.now();
    }
    /**
     * Report the current progress as a [34/42] string, or just [34] if the total is unknown
     */
    progress() {
        if (this.resourcesTotal == null) {
            // Don't have total, show simple count and hope the human knows
            return padLeft(3, util.format('%s', this.resourcesDone)); // max 500 resources
        }
        return util.format('%s/%s', padLeft(this.resourceDigits, this.resourcesDone.toString()), padLeft(this.resourceDigits, this.resourcesTotal != null ? this.resourcesTotal.toString() : '?'));
    }
    /**
     * If some resources are taking a while to create, notify the user about what's currently in progress
     */
    printInProgress() {
        if (Date.now() < this.lastPrintTime + this.inProgressDelay) {
            return;
        }
        if (Object.keys(this.resourcesInProgress).length > 0) {
            this.stream.write(util.format('%s Currently in progress: %s\n', this.progress(), chalk.bold(Object.keys(this.resourcesInProgress).join(', '))));
        }
        // We cheat a bit here. To prevent printInProgress() from repeatedly triggering,
        // we set the timestamp into the future. It will be reset whenever a regular print
        // occurs, after which we can be triggered again.
        this.lastPrintTime = +Infinity;
    }
}
exports.HistoryActivityPrinter = HistoryActivityPrinter;
/**
 * Activity Printer which shows the resources currently being updated
 *
 * It will continuously reupdate the terminal and show only the resources
 * that are currently being updated, in addition to a progress bar which
 * shows how far along the deployment is.
 *
 * Resources that have failed will always be shown, and will be recapitulated
 * along with their stack trace when the monitoring ends.
 *
 * Resources that failed deployment because they have been cancelled are
 * not included.
 */
class CurrentActivityPrinter extends ActivityPrinterBase {
    constructor(props) {
        super(props);
        /**
         * This looks very disorienting sleeping for 5 seconds. Update quicker.
         */
        this.updateSleep = 2000;
        this.oldLogLevel = logging_1.LogLevel.DEFAULT;
        this.block = new display_1.RewritableBlock(this.stream);
    }
    print() {
        const lines = [];
        // Add a progress bar at the top
        const progressWidth = Math.max(Math.min((this.block.width ?? 80) - PROGRESSBAR_EXTRA_SPACE - 1, MAX_PROGRESSBAR_WIDTH), MIN_PROGRESSBAR_WIDTH);
        const prog = this.progressBar(progressWidth);
        if (prog) {
            lines.push('  ' + prog, '');
        }
        // Normally we'd only print "resources in progress", but it's also useful
        // to keep an eye on the failures and know about the specific errors asquickly
        // as possible (while the stack is still rolling back), so add those in.
        const toPrint = [...this.failures, ...Object.values(this.resourcesInProgress)];
        toPrint.sort((a, b) => a.event.Timestamp.getTime() - b.event.Timestamp.getTime());
        lines.push(...toPrint.map((res) => {
            const color = colorFromStatusActivity(res.event.ResourceStatus);
            const resourceName = res.metadata?.constructPath ?? res.event.LogicalResourceId ?? '';
            return util.format('%s | %s | %s | %s%s', padLeft(TIMESTAMP_WIDTH, new Date(res.event.Timestamp).toLocaleTimeString()), color(padRight(STATUS_WIDTH, (res.event.ResourceStatus || '').slice(0, STATUS_WIDTH))), padRight(this.props.resourceTypeColumnWidth, res.event.ResourceType || ''), color(chalk.bold(shorten(40, resourceName))), this.failureReasonOnNextLine(res));
        }));
        this.block.displayLines(lines);
    }
    start() {
        // Need to prevent the waiter from printing 'stack not stable' every 5 seconds, it messes
        // with the output calculations.
        this.oldLogLevel = logging_1.logLevel;
        (0, logging_1.setLogLevel)(logging_1.LogLevel.DEFAULT);
    }
    stop() {
        (0, logging_1.setLogLevel)(this.oldLogLevel);
        // Print failures at the end
        const lines = new Array();
        for (const failure of this.failures) {
            // Root stack failures are not interesting
            if (failure.isStackEvent) {
                continue;
            }
            lines.push(util.format(chalk.red('%s | %s | %s | %s%s') + '\n', padLeft(TIMESTAMP_WIDTH, new Date(failure.event.Timestamp).toLocaleTimeString()), padRight(STATUS_WIDTH, (failure.event.ResourceStatus || '').slice(0, STATUS_WIDTH)), padRight(this.props.resourceTypeColumnWidth, failure.event.ResourceType || ''), shorten(40, failure.event.LogicalResourceId ?? ''), this.failureReasonOnNextLine(failure)));
            const trace = failure.metadata?.entry?.trace;
            if (trace) {
                lines.push(chalk.red(`\t${trace.join('\n\t\\_ ')}\n`));
            }
        }
        // Display in the same block space, otherwise we're going to have silly empty lines.
        this.block.displayLines(lines);
        this.block.removeEmptyLines();
    }
    progressBar(width) {
        if (!this.resourcesTotal) {
            return '';
        }
        const fraction = Math.min(this.resourcesDone / this.resourcesTotal, 1);
        const innerWidth = Math.max(1, width - 2);
        const chars = innerWidth * fraction;
        const remainder = chars - Math.floor(chars);
        const fullChars = FULL_BLOCK.repeat(Math.floor(chars));
        const partialChar = PARTIAL_BLOCK[Math.floor(remainder * PARTIAL_BLOCK.length)];
        const filler = '·'.repeat(innerWidth - Math.floor(chars) - (partialChar ? 1 : 0));
        const color = this.rollingBack ? chalk.yellow : chalk.green;
        return '[' + color(fullChars + partialChar) + filler + `] (${this.resourcesDone}/${this.resourcesTotal})`;
    }
    failureReasonOnNextLine(activity) {
        return hasErrorMessage(activity.event.ResourceStatus ?? '')
            ? `\n${' '.repeat(TIMESTAMP_WIDTH + STATUS_WIDTH + 6)}${chalk.red(this.failureReason(activity) ?? '')}`
            : '';
    }
}
exports.CurrentActivityPrinter = CurrentActivityPrinter;
const FULL_BLOCK = '█';
const PARTIAL_BLOCK = ['', '▏', '▎', '▍', '▌', '▋', '▊', '▉'];
const MAX_PROGRESSBAR_WIDTH = 60;
const MIN_PROGRESSBAR_WIDTH = 10;
const PROGRESSBAR_EXTRA_SPACE = 2 /* leading spaces */ + 2 /* brackets */ + 4 /* progress number decoration */ + 6; /* 2 progress numbers up to 999 */
function hasErrorMessage(status) {
    return status.endsWith('_FAILED') || status === 'ROLLBACK_IN_PROGRESS' || status === 'UPDATE_ROLLBACK_IN_PROGRESS';
}
function colorFromStatusResult(status) {
    if (!status) {
        return chalk.reset;
    }
    if (status.indexOf('FAILED') !== -1) {
        return chalk.red;
    }
    if (status.indexOf('ROLLBACK') !== -1) {
        return chalk.yellow;
    }
    if (status.indexOf('COMPLETE') !== -1) {
        return chalk.green;
    }
    return chalk.reset;
}
function colorFromStatusActivity(status) {
    if (!status) {
        return chalk.reset;
    }
    if (status.endsWith('_FAILED')) {
        return chalk.red;
    }
    if (status.startsWith('CREATE_') || status.startsWith('UPDATE_') || status.startsWith('IMPORT_')) {
        return chalk.green;
    }
    // For stacks, it may also be 'UPDDATE_ROLLBACK_IN_PROGRESS'
    if (status.indexOf('ROLLBACK_') !== -1) {
        return chalk.yellow;
    }
    if (status.startsWith('DELETE_')) {
        return chalk.yellow;
    }
    return chalk.reset;
}
function shorten(maxWidth, p) {
    if (p.length <= maxWidth) {
        return p;
    }
    const half = Math.floor((maxWidth - 3) / 2);
    return p.slice(0, half) + '...' + p.slice(-half);
}
const TIMESTAMP_WIDTH = 12;
const STATUS_WIDTH = 20;
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoic3RhY2stYWN0aXZpdHktbW9uaXRvci5qcyIsInNvdXJjZVJvb3QiOiIiLCJzb3VyY2VzIjpbInN0YWNrLWFjdGl2aXR5LW1vbml0b3IudHMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6Ijs7O0FBQUEsNkJBQTZCO0FBQzdCLDBFQUErRjtBQUUvRiwrQkFBK0I7QUFDL0IsNkRBQXVFO0FBQ3ZFLDhDQUEwRTtBQUUxRSx3Q0FBNkM7QUFXN0M7O0dBRUc7QUFDSCxJQUFZLHFCQVVYO0FBVkQsV0FBWSxxQkFBcUI7SUFDL0I7O09BRUc7SUFDSCxvQ0FBVyxDQUFBO0lBRVg7O09BRUc7SUFDSCwwQ0FBaUIsQ0FBQTtBQUNuQixDQUFDLEVBVlcscUJBQXFCLHFDQUFyQixxQkFBcUIsUUFVaEM7QUFzREQsTUFBYSxvQkFBb0I7SUFDL0I7O09BRUc7SUFDSSxNQUFNLENBQUMsa0JBQWtCLENBQzlCLEdBQTBCLEVBQzFCLFNBQWlCLEVBQ2pCLGFBQTBDLEVBQzFDLFVBQW1DLEVBQUU7UUFFckMsTUFBTSxNQUFNLEdBQUcsT0FBTyxDQUFDLEVBQUUsQ0FBQyxDQUFDLENBQUMsT0FBTyxDQUFDLE1BQU0sQ0FBQyxDQUFDLENBQUMsT0FBTyxDQUFDLE1BQU0sQ0FBQztRQUU1RCxNQUFNLEtBQUssR0FBaUI7WUFDMUIsdUJBQXVCLEVBQUUseUJBQXlCLENBQUMsYUFBYSxDQUFDLFFBQVEsQ0FBQztZQUMxRSxjQUFjLEVBQUUsT0FBTyxDQUFDLGNBQWM7WUFDdEMsTUFBTTtTQUNQLENBQUM7UUFFRixNQUFNLFNBQVMsR0FBRyxPQUFPLENBQUMsUUFBUSxLQUFLLE9BQU8sQ0FBQztRQUMvQyxNQUFNLE9BQU8sR0FBRyxPQUFPLENBQUMsUUFBUSxJQUFJLGtCQUFRLENBQUM7UUFDN0MsaUZBQWlGO1FBQ2pGLDREQUE0RDtRQUM1RCwwRkFBMEY7UUFDMUYsTUFBTSxvQkFBb0IsR0FBRyxDQUFDLFNBQVMsSUFBSSxNQUFNLENBQUMsS0FBSyxJQUFJLENBQUMsT0FBTyxDQUFDLEVBQUUs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Q0FBQyxFQUFFLENBQUM7UUFDakMsT0FBTyxLQUFLLENBQUMsTUFBTSxDQUFDO0lBQ3RCLENBQUM7SUFFRCxPQUFPLEtBQUssQ0FBQyxLQUFLLENBQUM7QUFDckIsQ0FBQztBQUVELFNBQVMsT0FBTyxDQUFDLFFBQWdCLEVBQUUsQ0FBUztJQUMxQyxJQUFJLENBQUMsQ0FBQyxNQUFNLElBQUksUUFBUSxFQUFFLENBQUM7UUFDekIsT0FBTyxDQUFDLENBQUM7SUFDWCxDQUFDO0lBQ0QsTUFBTSxJQUFJLEdBQUcsSUFBSSxDQUFDLEtBQUssQ0FBQyxDQUFDLFFBQVEsR0FBRyxDQUFDLENBQUMsR0FBRyxDQUFDLENBQUMsQ0FBQztJQUM1QyxPQUFPLENBQUMsQ0FBQyxLQUFLLENBQUMsQ0FBQyxFQUFFLElBQUksQ0FBQyxHQUFHLEtBQUssR0FBRyxDQUFDLENBQUMsS0FBSyxDQUFDLENBQUMsSUFBSSxDQUFDLENBQUM7QUFDbkQsQ0FBQztBQUVELE1BQU0sZUFBZSxHQUFHLEVBQUUsQ0FBQztBQUMzQixNQUFNLFlBQVksR0FBRyxFQUFFLENBQUMiLCJzb3VyY2VzQ29udGVudCI6WyJpbXBvcnQgKiBhcyB1dGlsIGZyb20gJ3V0aWwnO1xuaW1wb3J0IHsgQXJ0aWZhY3RNZXRhZGF0YUVudHJ5VHlwZSwgdHlwZSBNZXRhZGF0YUVudHJ5IH0gZnJvbSAnQGF3cy1jZGsvY2xvdWQtYXNzZW1ibHktc2NoZW1hJztcbmltcG9ydCB0eXBlIHsgQ2xvdWRGb3JtYXRpb25TdGFja0FydGlmYWN0IH0gZnJvbSAnQGF3cy1jZGsvY3gtYXBpJztcbmltcG9ydCAqIGFzIGNoYWxrIGZyb20gJ2NoYWxrJztcbmltcG9ydCB7IFJlc291cmNlRXZlbnQsIFN0YWNrRXZlbnRQb2xsZXIgfSBmcm9tICcuL3N0YWNrLWV2ZW50LXBvbGxlcic7XG5pbXBvcnQgeyBlcnJvciwgbG9nTGV2ZWwsIExvZ0xldmVsLCBzZXRMb2dMZXZlbCB9IGZyb20gJy4uLy4uLy4uL2xvZ2dpbmcnO1xuaW1wb3J0IHR5cGUgeyBJQ2xvdWRGb3JtYXRpb25DbGllbnQgfSBmcm9tICcuLi8uLi9hd3MtYXV0aCc7XG5pbXBvcnQgeyBSZXdyaXRhYmxlQmxvY2sgfSBmcm9tICcuLi9kaXNwbGF5JztcblxuZXhwb3J0IGludGVyZmFjZSBTdGFja0FjdGl2aXR5IGV4dGVuZHMgUmVzb3VyY2VFdmVudCB7XG4gIHJlYWRvbmx5IG1ldGFkYXRhPzogUmVzb3VyY2VNZXRhZGF0YTtcbn1cblxuZXhwb3J0IGludGVyZmFjZSBSZXNvdXJjZU1ldGFkYXRhIHtcbiAgZW50cnk6IE1ldGFkYXRhRW50cnk7XG4gIGNvbnN0cnVjdFBhdGg6IHN0cmluZztcbn1cblxuLyoqXG4gKiBTdXBwb3J0ZWQgZGlzcGxheSBtb2RlcyBmb3Igc3RhY2sgZGVwbG95bWVudCBhY3Rpdml0eVxuICovXG5leHBvcnQgZW51bSBTdGFja0FjdGl2aXR5UHJvZ3Jlc3Mge1xuICAvKipcbiAgICogRGlzcGxheXMgYSBwcm9ncmVzcyBiYXIgd2l0aCBvbmx5IHRoZSBldmVudHMgZm9yIHRoZSByZXNvdXJjZSBjdXJyZW50bHkgYmVpbmcgZGVwbG95ZWRcbiAgICovXG4gIEJBUiA9ICdiYXInLFxuXG4gIC8qKlxuICAgKiBEaXNwbGF5cyBjb21wbGV0ZSBoaXN0b3J5IHdpdGggYWxsIENsb3VkRm9ybWF0aW9uIHN0YWNrIGV2ZW50c1xuICAgKi9cbiAgRVZFTlRTID0gJ2V2ZW50cycsXG59XG5cbmV4cG9ydCBpbnRlcmZhY2UgV2l0aERlZmF1bHRQcmludGVyUHJvcHMge1xuICAvKipcbiAgICogVG90YWwgbnVtYmVyIG9mIHJlc291cmNlcyB0byB1cGRhdGVcbiAgICpcbiAgICogVXNlZCB0byBjYWxjdWxhdGUgYSBwcm9ncmVzcyBiYXIuXG4gICAqXG4gICAqIEBkZWZhdWx0IC0gTm8gcHJvZ3Jlc3MgcmVwb3J0aW5nLlxuICAgKi9cbiAgcmVhZG9ubHkgcmVzb3VyY2VzVG90YWw/OiBudW1iZXI7XG5cbiAgLyoqXG4gICAqIFRoZSBsb2cgbGV2ZWwgdGhhdCB3YXMgcmVxdWVzdGVkIGluIHRoZSBDTElcbiAgICpcbiAgICogSWYgdmVyYm9zZSBvciB0cmFjZSBpcyByZXF1ZXN0ZWQsIHdlJ2xsIGFsd2F5cyB1c2UgdGhlIGZ1bGwgaGlzdG9yeSBwcmludGVyLlxuICAgKlxuICAgKiBAZGVmYXVsdCAtIFVzZSB2YWx1ZSBmcm9tIGxvZ2dpbmcubG9nTGV2ZWxcbiAgICovXG4gIHJlYWRvbmx5IGxvZ0xldmVsPzogTG9nTGV2ZWw7XG5cbiAgLyoqXG4gICAqIFdoZXRoZXIgdG8gZGlzcGxheSBhbGwgc3RhY2sgZXZlbnRzIG9yIHRvIGRpc3BsYXkgb25seSB0aGUgZXZlbnRzIGZvciB0aGVcbiAgICogcmVzb3VyY2UgY3VycmVudGx5IGJlaW5nIGRlcGxveWVkXG4gICAqXG4gICAqIElmIG5vdCBzZXQsIHRoZSBzdGFjayBoaXN0b3J5IHdpdGggYWxsIHN0YWNrIGV2ZW50cyB3aWxsIGJlIGRpc3BsYXllZFxuICAgKlxuICAgKiBAZGVmYXVsdCBmYWxzZVxuICAgKi9cbiAgcHJvZ3Jlc3M/OiBTdGFja0FjdGl2aXR5UHJvZ3Jlc3M7XG5cbiAgLyoqXG4gICAqIFdoZXRoZXIgd2UgYXJlIG9uIGEgQ0kgc3lzdGVtXG4gICAqXG4gICAqIElmIHNvLCBkaXNhYmxlIHRoZSBcIm9wdGltaXplZFwiIHN0YWNrIG1vbml0b3IuXG4gICAqXG4gICAqIEBkZWZhdWx0IGZhbHNlXG4gICAqL1xuICByZWFkb25seSBjaT86IGJvb2xlYW47XG5cbiAgLyoqXG4gICAqIENyZWF0aW9uIHRpbWUgb2YgdGhlIGNoYW5nZSBzZXRcbiAgICpcbiAgICogVGhpcyB3aWxsIGJlIHVzZWQgdG8gZmlsdGVyIGV2ZW50cywgb25seSBzaG93aW5nIHRob3NlIGZyb20gYWZ0ZXIgdGhlIGNoYW5nZVxuICAgKiBzZXQgY3JlYXRpb24gdGltZS5cbiAgICpcbiAgICogSXQgaXMgcmVjb21tZW5kZWQgdG8gdXNlIHRoaXMsIG90aGVyd2lzZSB0aGUgZmlsdGVyaW5nIHdpbGwgYmUgc3ViamVjdFxuICAgKiB0byBjbG9jayBkcmlmdCBiZXR3ZWVuIGxvY2FsIGFuZCBjbG91ZCBtYWNoaW5lcy5cbiAgICpcbiAgICogQGRlZmF1bHQgLSBsb2NhbCBtYWNoaW5lJ3MgY3VycmVudCB0aW1lXG4gICAqL1xuICByZWFkb25seSBjaGFuZ2VTZXRDcmVhdGlvblRpbWU/OiBEYXRlO1xufVxuXG5leHBvcnQgY2xhc3MgU3RhY2tBY3Rpdml0eU1vbml0b3Ige1xuICAvKipcbiAgICogQ3JlYXRlIGEgU3RhY2sgQWN0aXZpdHkgTW9uaXRvciB1c2luZyBhIGRlZmF1bHQgcHJpbnRlciwgYmFzZWQgb24gY29udGV4dCBjbHVlc1xuICAgKi9cbiAgcHVibGljIHN0YXRpYyB3aXRoRGVmYXVsdFByaW50ZXIoXG4gICAgY2ZuOiBJQ2xvdWRGb3JtYXRpb25DbGllbnQsXG4gICAgc3RhY2tOYW1lOiBzdHJpbmcsXG4gICAgc3RhY2tBcnRpZmFjdDogQ2xvdWRGb3JtYXRpb25TdGFja0FydGlmYWN0LFxuICAgIG9wdGlvbnM6IFdpdGhEZWZhdWx0UHJpbnRlclByb3BzID0ge30sXG4gICkge1xuICAgIGNvbnN0IHN0cmVhbSA9IG9wdGlvbnMuY2kgPyBwcm9jZXNzLnN0ZG91dCA6IHByb2Nlc3Muc3RkZXJyO1xuXG4gICAgY29uc3QgcHJvcHM6IFByaW50ZXJQcm9wcyA9IHtcbiAgICAgIHJlc291cmNlVHlwZUNvbHVtbldpZHRoOiBjYWxjTWF4UmVzb3VyY2VUeXBlTGVuZ3RoKHN0YWNrQXJ0aWZhY3QudGVtcGxhdGUpLFxuICAgICAgcmVzb3VyY2VzVG90YWw6IG9wdGlvbnMucmVzb3VyY2VzVG90YWwsXG4gICAgICBzdHJlYW0sXG4gICAgfTtcblxuICAgIGNvbnN0IGlzV2luZG93cyA9IHByb2Nlc3MucGxhdGZvcm0gPT09ICd3aW4zMic7XG4gICAgY29uc3QgdmVyYm9zZSA9IG9wdGlvbnMubG9nTGV2ZWwgPz8gbG9nTGV2ZWw7XG4gICAgLy8gT24gc29tZSBDSSBzeXN0ZW1zIChzdWNoIGFzIENpcmNsZUNJKSBvdXRwdXQgc3RpbGwgcmVwb3J0cyBhcyBhIFRUWSBzbyB3ZSBhbHNvXG4gICAgLy8gbmVlZCBhbiBpbmRpdmlkdWFsIGNoZWNrIGZvciB3aGV0aGVyIHdlJ3JlIHJ1bm5pbmcgb24gQ0kuXG4gICAgLy8gc2VlOiBodHRwczovL2Rpc2N1c3MuY2lyY2xlY2kuY29tL3QvY2lyY2xlY2ktdGVybWluYWwtaXMtYS10dHktYnV0LXRlcm0taXMtbm90LXNldC85OTY1XG4gICAgY29uc3QgZmFuY3lPdXRwdXRBdmFpbGFibGUgPSAhaXNXaW5kb3dzICYmIHN0cmVhbS5pc1RUWSAmJiAhb3B0aW9ucy5jaTtcbiAgICBjb25zdCBwcm9ncmVzcyA9IG9wdGlvbnMucHJvZ3Jlc3MgPz8gU3RhY2tBY3Rpdml0eVByb2dyZXNzLkJBUjtcblxuICAgIGNvbnN0IHByaW50ZXIgPVxuICAgICAgZmFuY3lPdXRwdXRBdmFpbGFibGUgJiYgIXZlcmJvc2UgJiYgcHJvZ3Jlc3MgPT09IFN0YWNrQWN0aXZpdHlQcm9ncmVzcy5CQVJcbiAgICAgICAgPyBuZXcgQ3VycmVudEFjdGl2aXR5UHJpbnRlcihwcm9wcylcbiAgICAgICAgOiBuZXcgSGlzdG9yeUFjdGl2aXR5UHJpbnRlcihwcm9wcyk7XG5cbiAgICByZXR1cm4gbmV3IFN0YWNrQWN0aXZpdHlNb25pdG9yKGNmbiwgc3RhY2tOYW1lLCBwcmludGVyLCBzdGFja0FydGlmYWN0LCBvcHRpb25zLmNoYW5nZVNldENyZWF0aW9uVGltZSk7XG4gIH1cblxuICAvKipcbiAgICogVGhlIHBvbGxlciB1c2VkIHRvIHJlYWQgc3RhY2sgZXZlbnRzXG4gICAqL1xuICBwdWJsaWMgcmVhZG9ubHkgcG9sbGVyOiBTdGFja0V2ZW50UG9sbGVyO1xuXG4gIHB1YmxpYyByZWFkb25seSBlcnJvcnM6IHN0cmluZ1tdID0gW107XG5cbiAgcHJpdmF0ZSBhY3RpdmUgPSBmYWxzZTtcblxuICAvKipcbiAgICogQ3VycmVudCB0aWNrIHRpbWVyXG4gICAqL1xuICBwcml2YXRlIHRpY2tUaW1lcj86IFJldHVyblR5cGU8dHlwZW9mIHNldFRpbWVvdXQ+O1xuXG4gIC8qKlxuICAgKiBTZXQgdG8gdGhlIGFjdGl2aXR5IG9mIHJlYWRpbmcgdGhlIGN1cnJlbnQgZXZlbnRzXG4gICAqL1xuICBwcml2YXRlIHJlYWRQcm9taXNlPzogUHJvbWlzZTxhbnk+O1xuXG4gIGNvbnN0cnVjdG9yKFxuICAgIGNmbjogSUNsb3VkRm9ybWF0aW9uQ2xpZW50LFxuICAgIHByaXZhdGUgcmVhZG9ubHkgc3RhY2tOYW1lOiBzdHJpbmcsXG4gICAgcHJpdmF0ZSByZWFkb25seSBwcmludGVyOiBJQWN0aXZpdHlQcmludGVyLFxuICAgIHByaXZhdGUgcmVhZG9ubHkgc3RhY2s/OiBDbG91ZEZvcm1hdGlvblN0YWNrQXJ0aWZhY3QsXG4gICAgY2hhbmdlU2V0Q3JlYXRpb25UaW1lPzogRGF0ZSxcbiAgKSB7XG4gICAgdGhpcy5wb2xsZXIgPSBuZXcgU3RhY2tFdmVudFBvbGxlcihjZm4sIHtcbiAgICAgIHN0YWNrTmFtZSxcbiAgICAgIHN0YXJ0VGltZTogY2hhbmdlU2V0Q3JlYXRpb25UaW1lPy5nZXRUaW1lKCkgPz8gRGF0ZS5ub3coKSxcbiAgICB9KTtcbiAgfVxuXG4gIHB1YmxpYyBzdGFydCgpIHtcbiAgICB0aGlzLmFjdGl2ZSA9IHRydWU7XG4gICAgdGhpcy5wcmludGVyLnN0YXJ0KCk7XG4gICAgdGhpcy5zY2hlZHVsZU5leHRUaWNrKCk7XG4gICAgcmV0dXJuIHRoaXM7XG4gIH1cblxuICBwdWJsaWMgYXN5bmMgc3RvcCgpIHtcbiAgICB0aGlzLmFjdGl2ZSA9IGZhbHNlO1xuICAgIGlmICh0aGlzLnRpY2tUaW1lcikge1xuICAgICAgY2xlYXJUaW1lb3V0KHRoaXMudGlja1RpbWVyKTtcbiAgICB9XG5cbiAgICAvLyBEbyBhIGZpbmFsIHBvbGwgZm9yIGFsbCBldmVudHMuIFRoaXMgaXMgdG8gaGFuZGxlIHRoZSBzaXR1YXRpb24gd2hlcmUgRGVzY3JpYmVTdGFja1N0YXR1c1xuICAgIC8vIGFscmVhZHkgcmV0dXJuZWQgYW4gZXJyb3IsIGJ1dCB0aGUgbW9uaXRvciBoYXNuJ3Qgc2VlbiBhbGwgdGhlIGV2ZW50cyB5ZXQgYW5kIHdlJ2QgZW5kXG4gICAgLy8gdXAgbm90IHByaW50aW5nIHRoZSBmYWlsdXJlIHJlYXNvbiB0byB1c2Vycy5cbiAgICBhd2FpdCB0aGlzLmZpbmFsUG9sbFRvRW5kKCk7XG5cbiAgICB0aGlzLnByaW50ZXIuc3RvcCgpO1xuICB9XG5cbiAgcHJpdmF0ZSBzY2hlZHVsZU5leHRUaWNrKCkge1xuICAgIGlmICghdGhpcy5hY3RpdmUpIHtcbiAgICAgIHJldHVybjtcbiAgICB9XG5cbiAgICB0aGlzLnRpY2tUaW1lciA9IHNldFRpbWVvdXQoKCkgPT4gdm9pZCB0aGlzLnRpY2soKSwgdGhpcy5wcmludGVyLnVwZGF0ZVNsZWVwKTtcbiAgfVxuXG4gIHByaXZhdGUgYXN5bmMgdGljaygpIHtcbiAgICBpZiAoIXRoaXMuYWN0aXZlKSB7XG4gICAgICByZXR1cm47XG4gICAgfVxuXG4gICAgdHJ5IHtcbiAgICAgIHRoaXMucmVhZFByb21pc2UgPSB0aGlzLnJlYWROZXdFdmVudHMoKTtcbiAgICAgIGF3YWl0IHRoaXMucmVhZFByb21pc2U7XG4gICAgICB0aGlzLnJlYWRQcm9taXNlID0gdW5kZWZpbmVkO1xuXG4gICAgICAvLyBXZSBtaWdodCBoYXZlIGJlZW4gc3RvcCgpcGVkIHdoaWxlIHRoZSBuZXR3b3JrIGNhbGwgd2FzIGluIHByb2dyZXNzLlxuICAgICAgaWYgKCF0aGlzLmFjdGl2ZSkge1xuICAgICAgICByZXR1cm47XG4gICAgICB9XG5cbiAgICAgIHRoaXMucHJpbnRlci5wcmludCgpO1xuICAgIH0gY2F0Y2ggKGUpIHtcbiAgICAgIGVycm9yKCdFcnJvciBvY2N1cnJlZCB3aGlsZSBtb25pdG9yaW5nIHN0YWNrOiAlcycsIGUpO1xuICAgIH1cbiAgICB0aGlzLnNjaGVkdWxlTmV4dFRpY2soKTtcbiAgfVxuXG4gIHByaXZhdGUgZmluZE1ldGFkYXRhRm9yKGxvZ2ljYWxJZDogc3RyaW5nIHwgdW5kZWZpbmVkKTogUmVzb3VyY2VNZXRhZGF0YSB8IHVuZGVmaW5lZCB7XG4gICAgY29uc3QgbWV0YWRhdGEgPSB0aGlzLnN0YWNrPy5tYW5pZmVzdD8ubWV0YWRhdGE7XG4gICAgaWYgKCFsb2dpY2FsSWQgfHwgIW1ldGFkYXRhKSB7XG4gICAgICByZXR1cm4gdW5kZWZpbmVkO1xuICAgIH1cbiAgICBmb3IgKGNvbnN0IHBhdGggb2YgT2JqZWN0LmtleXMobWV0YWRhdGEpKSB7XG4gICAgICBjb25zdCBlbnRyeSA9IG1ldGFkYXRhW3BhdGhdXG4gICAgICAgIC5maWx0ZXIoKGUpID0+IGUudHlwZSA9PT0gQXJ0aWZhY3RNZXRhZGF0YUVudHJ5VHlwZS5MT0dJQ0FMX0lEKVxuICAgICAgICAuZmluZCgoZSkgPT4gZS5kYXRhID09PSBsb2dpY2FsSWQpO1xuICAgICAgaWYgKGVudHJ5KSB7XG4gICAgICAgIHJldHVybiB7XG4gICAgICAgICAgZW50cnksXG4gICAgICAgICAgY29uc3RydWN0UGF0aDogdGhpcy5zaW1wbGlmeUNvbnN0cnVjdFBhdGgocGF0aCksXG4gICAgICAgIH07XG4gICAgICB9XG4gICAgfVxuICAgIHJldHVybiB1bmRlZmluZWQ7XG4gIH1cblxuICAvKipcbiAgICogUmVhZHMgYWxsIG5ldyBldmVudHMgZnJvbSB0aGUgc3RhY2sgaGlzdG9yeVxuICAgKlxuICAgKiBUaGUgZXZlbnRzIGFyZSByZXR1cm5lZCBpbiByZXZlcnNlIGNocm9ub2xvZ2ljYWwgb3JkZXI7IHdlIGNvbnRpbnVlIHRvIHRoZSBuZXh0IHBhZ2UgaWYgd2VcbiAgICogc2VlIGEgbmV4dCBwYWdlIGFuZCB0aGUgbGFzdCBldmVudCBpbiB0aGUgcGFnZSBpcyBuZXcgdG8gdXMgKGFuZCB3aXRoaW4gdGhlIHRpbWUgd2luZG93KS5cbiAgICogaGF2ZW4ndCBzZWVuIHRoZSBmaW5hbCBldmVudFxuICAgKi9cbiAgcHJpdmF0ZSBhc3luYyByZWFkTmV3RXZlbnRzKCk6IFByb21pc2U8dm9pZD4ge1xuICAgIGNvbnN0IHBvbGxFdmVudHMgPSBhd2FpdCB0aGlzLnBvbGxlci5wb2xsKCk7XG5cbiAgICBjb25zdCBhY3Rpdml0aWVzOiBTdGFja0FjdGl2aXR5W10gPSBwb2xsRXZlbnRzLm1hcCgoZXZlbnQpID0+ICh7XG4gICAgICAuLi5ldmVudCxcbiAgICAgIG1ldGFkYXRhOiB0aGlzLmZpbmRNZXRhZGF0YUZvcihldmVudC5ldmVudC5Mb2dpY2FsUmVzb3VyY2VJZCksXG4gICAgfSkpO1xuXG4gICAgZm9yIChjb25zdCBhY3Rpdml0eSBvZiBhY3Rpdml0aWVzKSB7XG4gICAgICB0aGlzLmNoZWNrRm9yRXJyb3JzKGFjdGl2aXR5KTtcbiAgICAgIHRoaXMucHJpbnRlci5hZGRBY3Rpdml0eShhY3Rpdml0eSk7XG4gICAgfVxuICB9XG5cbiAgLyoqXG4gICAqIFBlcmZvcm0gYSBmaW5hbCBwb2xsIHRvIHRoZSBlbmQgYW5kIGZsdXNoIG91dCBhbGwgZXZlbnRzIHRvIHRoZSBwcmludGVyXG4gICAqXG4gICAqIEZpbmlzaCBhbnkgcG9sbCBjdXJyZW50bHkgaW4gcHJvZ3Jlc3MsIHRoZW4gZG8gYSBmaW5hbCBvbmUgdW50aWwgd2UndmVcbiAgICogcmVhY2hlZCB0aGUgbGFzdCBwYWdlLlxuICAgKi9cbiAgcHJpdmF0ZSBhc3luYyBmaW5hbFBvbGxUb0VuZCgpIHtcbiAgICAvLyBJZiB3ZSB3ZXJlIGRvaW5nIGEgcG9sbCwgZmluaXNoIHRoYXQgZmlyc3QuIEl0IHdhcyBzdGFydGVkIGJlZm9yZVxuICAgIC8vIHRoZSBtb21lbnQgd2Ugd2VyZSBzdXJlIHdlIHdlcmVuJ3QgZ29pbmcgdG8gZ2V0IGFueSBuZXcgZXZlbnRzIGFueW1vcmVcbiAgICAvLyBzbyB3ZSBuZWVkIHRvIGRvIGEgbmV3IG9uZSBhbnl3YXkuIE5lZWQgdG8gd2FpdCBmb3IgdGhpcyBvbmUgdGhvdWdoXG4gICAgLy8gYmVjYXVzZSBvdXIgc3RhdGUgaXMgc2luZ2xlLXRocmVhZGVkLlxuICAgIGlmICh0aGlzLnJlYWRQcm9taXNlKSB7XG4gICAgICBhd2FpdCB0aGlzLnJlYWRQcm9taXNlO1xuICAgIH1cblxuICAgIGF3YWl0IHRoaXMucmVhZE5ld0V2ZW50cygpO1xuICB9XG5cbiAgcHJpdmF0ZSBjaGVja0ZvckVycm9ycyhhY3Rpdml0eTogU3RhY2tBY3Rpdml0eSkge1xuICAgIGlmIChoYXNFcnJvck1lc3NhZ2UoYWN0aXZpdHkuZXZlbnQuUmVzb3VyY2VTdGF0dXMgPz8gJycpKSB7XG4gICAgICBjb25zdCBpc0NhbmNlbGxlZCA9IChhY3Rpdml0eS5ldmVudC5SZXNvdXJjZVN0YXR1c1JlYXNvbiA/PyAnJykuaW5kZXhPZignY2FuY2VsbGVkJykgPiAtMTtcblxuICAgICAgLy8gQ2FuY2VsbGVkIGlzIG5vdCBhbiBpbnRlcmVzdGluZyBmYWlsdXJlIHJlYXNvbiwgbm9yIGlzIHRoZSBzdGFjayBtZXNzYWdlIChzdGFja1xuICAgICAgLy8gbWVzc2FnZSB3aWxsIGp1c3Qgc2F5IHNvbWV0aGluZyBsaWtlIFwic3RhY2sgZmFpbGVkIHRvIHVwZGF0ZVwiKVxuICAgICAgaWYgKCFpc0NhbmNlbGxlZCAmJiBhY3Rpdml0eS5ldmVudC5TdGFja05hbWUgIT09IGFjdGl2aXR5LmV2ZW50LkxvZ2ljYWxSZXNvdXJjZUlkKSB7XG4gICAgICAgIHRoaXMuZXJyb3JzLnB1c2goYWN0aXZpdHkuZXZlbnQuUmVzb3VyY2VTdGF0dXNSZWFzb24gPz8gJycpO1xuICAgICAgfVxuICAgIH1cbiAgfVxuXG4gIHByaXZhdGUgc2ltcGxpZnlDb25zdHJ1Y3RQYXRoKHBhdGg6IHN0cmluZykge1xuICAgIHBhdGggPSBwYXRoLnJlcGxhY2UoL1xcL1Jlc291cmNlJC8sICcnKTtcbiAgICBwYXRoID0gcGF0aC5yZXBsYWNlKC9eXFwvLywgJycpOyAvLyByZW1vdmUgXCIvXCIgcHJlZml4XG5cbiAgICAvLyByZW1vdmUgXCI8c3RhY2stbmFtZT4vXCIgcHJlZml4XG4gICAgaWYgKHBhdGguc3RhcnRzV2l0aCh0aGlzLnN0YWNrTmFtZSArICcvJykpIHtcbiAgICAgIHBhdGggPSBwYXRoLnNsaWNlKHRoaXMuc3RhY2tOYW1lLmxlbmd0aCArIDEpO1xuICAgIH1cbiAgICByZXR1cm4gcGF0aDtcbiAgfVxufVxuXG5mdW5jdGlvbiBwYWRSaWdodChuOiBudW1iZXIsIHg6IHN0cmluZyk6IHN0cmluZyB7XG4gIHJldHVybiB4ICsgJyAnLnJlcGVhdChNYXRoLm1heCgwLCBuIC0geC5sZW5ndGgpKTtcbn1cblxuLyoqXG4gKiBJbmZhbW91cyBwYWRMZWZ0KClcbiAqL1xuZnVuY3Rpb24gcGFkTGVmdChuOiBudW1iZXIsIHg6IHN0cmluZyk6IHN0cmluZyB7XG4gIHJldHVybiAnICcucmVwZWF0KE1hdGgubWF4KDAsIG4gLSB4Lmxlbmd0aCkpICsgeDtcbn1cblxuZnVuY3Rpb24gY2FsY01heFJlc291cmNlVHlwZUxlbmd0aCh0ZW1wbGF0ZTogYW55KSB7XG4gIGNvbnN0IHJlc291cmNlcyA9ICh0ZW1wbGF0ZSAmJiB0ZW1wbGF0ZS5SZXNvdXJjZXMpIHx8IHt9O1xuICBsZXQgbWF4V2lkdGggPSAwO1xuICBmb3IgKGNvbnN0IGlkIG9mIE9iamVjdC5rZXlzKHJlc291cmNlcykpIHtcbiAgICBjb25zdCB0eXBlID0gcmVzb3VyY2VzW2lkXS5UeXBlIHx8ICcnO1xuICAgIGlmICh0eXBlLmxlbmd0aCA+IG1heFdpZHRoKSB7XG4gICAgICBtYXhXaWR0aCA9IHR5cGUubGVuZ3RoO1xuICAgIH1cbiAgfVxuICByZXR1cm4gbWF4V2lkdGg7XG59XG5cbmludGVyZmFjZSBQcmludGVyUHJvcHMge1xuICAvKipcbiAgICogVG90YWwgcmVzb3VyY2VzIHRvIGRlcGxveVxuICAgKi9cbiAgcmVhZG9ubHkgcmVzb3VyY2VzVG90YWw/OiBudW1iZXI7XG5cbiAgLyoqXG4gICAqIFRoZSB3aXRoIG9mIHRoZSBcInJlc291cmNlIHR5cGVcIiBjb2x1bW4uXG4gICAqL1xuICByZWFkb25seSByZXNvdXJjZVR5cGVDb2x1bW5XaWR0aDogbnVtYmVyO1xuXG4gIC8qKlxuICAgKiBTdHJlYW0gdG8gd3JpdGUgdG9cbiAgICovXG4gIHJlYWRvbmx5IHN0cmVhbTogTm9kZUpTLldyaXRlU3RyZWFtO1xufVxuXG5leHBvcnQgaW50ZXJmYWNlIElBY3Rpdml0eVByaW50ZXIge1xuICByZWFkb25seSB1cGRhdGVTbGVlcDogbnVtYmVyO1xuXG4gIGFkZEFjdGl2aXR5KGFjdGl2aXR5OiBTdGFja0FjdGl2aXR5KTogdm9pZDtcbiAgcHJpbnQoKTogdm9pZDtcbiAgc3RhcnQoKTogdm9pZDtcbiAgc3RvcCgpOiB2b2lkO1xufVxuXG5hYnN0cmFjdCBjbGFzcyBBY3Rpdml0eVByaW50ZXJCYXNlIGltcGxlbWVudHMgSUFjdGl2aXR5UHJpbnRlciB7XG4gIC8qKlxuICAgKiBGZXRjaCBuZXcgYWN0aXZpdHkgZXZlcnkgNSBzZWNvbmRzXG4gICAqL1xuICBwdWJsaWMgcmVhZG9ubHkgdXBkYXRlU2xlZXA6IG51bWJlciA9IDVfMDAwO1xuXG4gIC8qKlxuICAgKiBBIGxpc3Qgb2YgcmVzb3VyY2UgSURzIHdoaWNoIGFyZSBjdXJyZW50bHkgYmVpbmcgcHJvY2Vzc2VkXG4gICAqL1xuICBwcm90ZWN0ZWQgcmVzb3VyY2VzSW5Qcm9ncmVzczogUmVjb3JkPHN0cmluZywgU3RhY2tBY3Rpdml0eT4gPSB7fTtcblxuICAvKipcbiAgICogUHJldmlvdXMgY29tcGxldGlvbiBzdGF0ZSBvYnNlcnZlZCBieSBsb2dpY2FsIElEXG4gICAqXG4gICAqIFdlIHVzZSB0aGlzIHRvIGRldGVjdCB0aGF0IGlmIHdlIHNlZSBhIERFTEVURV9DT01QTEVURSBhZnRlciBhXG4gICAqIENSRUFURV9DT01QTEVURSwgaXQncyBhY3R1YWxseSBhIHJvbGxiYWNrIGFuZCB3ZSBzaG91bGQgREVDUkVBU0VcbiAgICogcmVzb3VyY2VzRG9uZSBpbnN0ZWFkIG9mIGluY3JlYXNlIGl0XG4gICAqL1xuICBwcm90ZWN0ZWQgcmVzb3VyY2VzUHJldkNvbXBsZXRlU3RhdGU6IFJlY29yZDxzdHJpbmcsIHN0cmluZz4gPSB7fTtcblxuICAvKipcbiAgICogQ291bnQgb2YgcmVzb3VyY2VzIHRoYXQgaGF2ZSByZXBvcnRlZCBhIF9DT01QTEVURSBzdGF0dXNcbiAgICovXG4gIHByb3RlY3RlZCByZXNvdXJjZXNEb25lOiBudW1iZXIgPSAwO1xuXG4gIC8qKlxuICAgKiBIb3cgbWFueSBkaWdpdHMgd2UgbmVlZCB0byByZXByZXNlbnQgdGhlIHRvdGFsIGNvdW50IChmb3IgbGluaW5nIHVwIHRoZSBzdGF0dXMgcmVwb3J0aW5nKVxuICAgKi9cbiAgcHJvdGVjdGVkIHJlYWRvbmx5IHJlc291cmNlRGlnaXRzOiBudW1iZXIgPSAwO1xuXG4gIHByb3RlY3RlZCByZWFkb25seSByZXNvdXJjZXNUb3RhbD86IG51bWJlcjtcblxuICBwcm90ZWN0ZWQgcm9sbGluZ0JhY2sgPSBmYWxzZTtcblxuICBwcm90ZWN0ZWQgcmVhZG9ubHkgZmFpbHVyZXMgPSBuZXcgQXJyYXk8U3RhY2tBY3Rpdml0eT4oKTtcblxuICBwcm90ZWN0ZWQgaG9va0ZhaWx1cmVNYXAgPSBuZXcgTWFwPHN0cmluZywgTWFwPHN0cmluZywgc3RyaW5nPj4oKTtcblxuICBwcm90ZWN0ZWQgcmVhZG9ubHkgc3RyZWFtOiBOb2RlSlMuV3JpdGVTdHJlYW07XG5cbiAgY29uc3RydWN0b3IocHJvdGVjdGVkIHJlYWRvbmx5IHByb3BzOiBQcmludGVyUHJvcHMpIHtcbiAgICAvLyArMSBiZWNhdXNlIHRoZSBzdGFjayBhbHNvIGVtaXRzIGEgXCJDT01QTEVURVwiIGV2ZW50IGF0IHRoZSBlbmQsIGFuZCB0aGF0IHdhc24ndFxuICAgIC8vIGNvdW50ZWQgeWV0LiBUaGlzIG1ha2VzIGl0IGxpbmUgdXAgd2l0aCB0aGUgYW1vdW50IG9mIGV2ZW50cyB3ZSBleHBlY3QuXG4gICAgdGhpcy5yZXNvdXJjZXNUb3RhbCA9IHByb3BzLnJlc291cmNlc1RvdGFsID8gcHJvcHMucmVzb3VyY2VzVG90YWwgKyAxIDogdW5kZWZpbmVkO1xuXG4gICAgLy8gSG93IG1hbnkgZGlnaXRzIGRvZXMgdGhpcyBudW1iZXIgdGFrZSB0byByZXByZXNlbnQ/XG4gICAgdGhpcy5yZXNvdXJjZURpZ2l0cyA9IHRoaXMucmVzb3VyY2VzVG90YWwgPyBNYXRoLmNlaWwoTWF0aC5sb2cxMCh0aGlzLnJlc291cmNlc1RvdGFsKSkgOiAwO1xuXG4gICAgdGhpcy5zdHJlYW0gPSBwcm9wcy5zdHJlYW07XG4gIH1cblxuICBwdWJsaWMgZmFpbHVyZVJlYXNvbihhY3Rpdml0eTogU3RhY2tBY3Rpdml0eSkge1xuICAgIGNvbnN0IHJlc291cmNlU3RhdHVzUmVhc29uID0gYWN0aXZpdHkuZXZlbnQuUmVzb3VyY2VTdGF0dXNSZWFzb24gPz8gJyc7XG4gICAgY29uc3QgbG9naWNhbFJlc291cmNlSWQgPSBhY3Rpdml0eS5ldmVudC5Mb2dpY2FsUmVzb3VyY2VJZCA/PyAnJztcbiAgICBjb25zdCBob29rRmFpbHVyZVJlYXNvbk1hcCA9IHRoaXMuaG9va0ZhaWx1cmVNYXAuZ2V0KGxvZ2ljYWxSZXNvdXJjZUlkKTtcblxuICAgIGlmIChob29rRmFpbHVyZVJlYXNvbk1hcCAhPT0gdW5kZWZpbmVkKSB7XG4gICAgICBmb3IgKGNvbnN0IGhvb2tUeXBlIG9mIGhvb2tGYWlsdXJlUmVhc29uTWFwLmtleXMoKSkge1xuICAgICAgICBpZiAocmVzb3VyY2VTdGF0dXNSZWFzb24uaW5jbHVkZXMoaG9va1R5cGUpKSB7XG4gICAgICAgICAgcmV0dXJuIHJlc291cmNlU3RhdHVzUmVhc29uICsgJyA6ICcgKyBob29rRmFpbHVyZVJlYXNvbk1hcC5nZXQoaG9va1R5cGUpO1xuICAgICAgICB9XG4gICAgICB9XG4gICAgfVxuICAgIHJldHVybiByZXNvdXJjZVN0YXR1c1JlYXNvbjtcbiAgfVxuXG4gIHB1YmxpYyBhZGRBY3Rpdml0eShhY3Rpdml0eTogU3RhY2tBY3Rpdml0eSkge1xuICAgIGNvbnN0IHN0YXR1cyA9IGFjdGl2aXR5LmV2ZW50LlJlc291cmNlU3RhdHVzO1xuICAgIGNvbnN0IGhvb2tTdGF0dXMgPSBhY3Rpdml0eS5ldmVudC5Ib29rU3RhdHVzO1xuICAgIGNvbnN0IGhvb2tUeXBlID0gYWN0aXZpdHkuZXZlbnQuSG9va1R5cGU7XG4gICAgaWYgKCFzdGF0dXMgfHwgIWFjdGl2aXR5LmV2ZW50LkxvZ2ljYWxSZXNvdXJjZUlkKSB7XG4gICAgICByZXR1cm47XG4gICAgfVxuXG4gICAgaWYgKHN0YXR1cyA9PT0gJ1JPTExCQUNLX0lOX1BST0dSRVNTJyB8fCBzdGF0dXMgPT09ICdVUERBVEVfUk9MTEJBQ0tfSU5fUFJPR1JFU1MnKSB7XG4gICAgICAvLyBPbmx5IHRyaWdnZXJlZCBvbiB0aGUgc3RhY2sgb25jZSB3ZSd2ZSBzdGFydGVkIGRvaW5nIGEgcm9sbGJhY2tcbiAgICAgIHRoaXMucm9sbGluZ0JhY2sgPSB0cnVlO1xuICAgIH1cblxuICAgIGlmIChzdGF0dXMuZW5kc1dpdGgoJ19JTl9QUk9HUkVTUycpKSB7XG4gICAgICB0aGlzLnJlc291cmNlc0luUHJvZ3Jlc3NbYWN0aXZpdHkuZXZlbnQuTG9naWNhbFJlc291cmNlSWRdID0gYWN0aXZpdHk7XG4gICAgfVxuXG4gICAgaWYgKGhhc0Vycm9yTWVzc2FnZShzdGF0dXMpKSB7XG4gICAgICBjb25zdCBpc0NhbmNlbGxlZCA9IChhY3Rpdml0eS5ldmVudC5SZXNvdXJjZVN0YXR1c1JlYXNvbiA/PyAnJykuaW5kZXhPZignY2FuY2VsbGVkJykgPiAtMTtcblxuICAgICAgLy8gQ2FuY2VsbGVkIGlzIG5vdCBhbiBpbnRlcmVzdGluZyBmYWlsdXJlIHJlYXNvblxuICAgICAgaWYgKCFpc0NhbmNlbGxlZCkge1xuICAgICAgICB0aGlzLmZhaWx1cmVzLnB1c2goYWN0aXZpdHkpO1xuICAgICAgfVxuICAgIH1cblxuICAgIGlmIChzdGF0dXMuZW5kc1dpdGgoJ19DT01QTEVURScpIHx8IHN0YXR1cy5lbmRzV2l0aCgnX0ZBSUxFRCcpKSB7XG4gICAgICBkZWxldGUgdGhpcy5yZXNvdXJjZXNJblByb2dyZXNzW2FjdGl2aXR5LmV2ZW50LkxvZ2ljYWxSZXNvdXJjZUlkXTtcbiAgICB9XG5cbiAgICBpZiAoc3RhdHVzLmVuZHNXaXRoKCdfQ09NUExFVEVfQ0xFQU5VUF9JTl9QUk9HUkVTUycpKSB7XG4gICAgICB0aGlzLnJlc291cmNlc0RvbmUrKztcbiAgICB9XG5cbiAgICBpZiAoc3RhdHVzLmVuZHNXaXRoKCdfQ09NUExFVEUnKSkge1xuICAgICAgY29uc3QgcHJldlN0YXRlID0gdGhpcy5yZXNvdXJjZXNQcmV2Q29tcGxldGVTdGF0ZVthY3Rpdml0eS5ldmVudC5Mb2dpY2FsUmVzb3VyY2VJZF07XG4gICAgICBpZiAoIXByZXZTdGF0ZSkge1xuICAgICAgICB0aGlzLnJlc291cmNlc0RvbmUrKztcbiAgICAgIH0gZWxzZSB7XG4gICAgICAgIC8vIElmIHdlIGNvbXBsZXRlZCB0aGlzIGJlZm9yZSBhbmQgd2UncmUgY29tcGxldGluZyBpdCBBR0FJTiwgbWVhbnMgd2UncmUgcm9sbGluZyBiYWNrLlxuICAgICAgICAvLyBQcm90ZWN0IGFnYWluc3Qgc2lsbHkgdW5kZXJmbG93LlxuICAgICAgICB0aGlzLnJlc291cmNlc0RvbmUtLTtcbiAgICAgICAgaWYgKHRoaXMucmVzb3VyY2VzRG9uZSA8IDApIHtcbiAgICAgICAgICB0aGlzLnJlc291cmNlc0RvbmUgPSAwO1xuICAgICAgICB9XG4gICAgICB9XG4gICAgICB0aGlzLnJlc291cmNlc1ByZXZDb21wbGV0ZVN0YXRlW2FjdGl2aXR5LmV2ZW50LkxvZ2ljYWxSZXNvdXJjZUlkXSA9IHN0YXR1cztcbiAgICB9XG5cbiAgICBpZiAoXG4gICAgICBob29rU3RhdHVzICE9PSB1bmRlZmluZWQgJiZcbiAgICAgIGhvb2tTdGF0dXMuZW5kc1dpdGgoJ19DT01QTEVURV9GQUlMRUQnKSAmJlxuICAgICAgYWN0aXZpdHkuZXZlbnQuTG9naWNhbFJlc291cmNlSWQgIT09IHVuZGVmaW5lZCAmJlxuICAgICAgaG9va1R5cGUgIT09IHVuZGVmaW5lZFxuICAgICkge1xuICAgICAgaWYgKHRoaXMuaG9va0ZhaWx1cmVNYXAuaGFzKGFjdGl2aXR5LmV2ZW50LkxvZ2ljYWxSZXNvdXJjZUlkKSkge1xuICAgICAgICB0aGlzLmhvb2tGYWlsdXJlTWFwLmdldChhY3Rpdml0eS5ldmVudC5Mb2dpY2FsUmVzb3VyY2VJZCk/LnNldChob29rVHlwZSwgYWN0aXZpdHkuZXZlbnQuSG9va1N0YXR1c1JlYXNvbiA/PyAnJyk7XG4gICAgICB9IGVsc2Uge1xuICAgICAgICB0aGlzLmhvb2tGYWlsdXJlTWFwLnNldChhY3Rpdml0eS5ldmVudC5Mb2dpY2FsUmVzb3VyY2VJZCwgbmV3IE1hcDxzdHJpbmcsIHN0cmluZz4oKSk7XG4gICAgICAgIHRoaXMuaG9va0ZhaWx1cmVNYXAuZ2V0KGFjdGl2aXR5LmV2ZW50LkxvZ2ljYWxSZXNvdXJjZUlkKT8uc2V0KGhvb2tUeXBlLCBhY3Rpdml0eS5ldmVudC5Ib29rU3RhdHVzUmVhc29uID8/ICcnKTtcbiAgICAgIH1cbiAgICB9XG4gIH1cblxuICBwdWJsaWMgYWJzdHJhY3QgcHJpbnQoKTogdm9pZDtcblxuICBwdWJsaWMgc3RhcnQoKSB7XG4gICAgLy8gRW1wdHkgb24gcHVycG9zZVxuICB9XG5cbiAgcHVibGljIHN0b3AoKSB7XG4gICAgLy8gRW1wdHkgb24gcHVycG9zZVxuICB9XG59XG5cbi8qKlxuICogQWN0aXZpdHkgUHJpbnRlciB3aGljaCBzaG93cyBhIGZ1bGwgbG9nIG9mIGFsbCBDbG91ZEZvcm1hdGlvbiBldmVudHNcbiAqXG4gKiBXaGVuIHRoZXJlIGhhc24ndCBiZWVuIGFjdGl2aXR5IGZvciBhIHdoaWxlLCBpdCB3aWxsIHByaW50IHRoZSByZXNvdXJjZXNcbiAqIHRoYXQgYXJlIGN1cnJlbnRseSBpbiBwcm9ncmVzcywgdG8gc2hvdyB3aGF0J3MgaG9sZGluZyB1cCB0aGUgZGVwbG95bWVudC5cbiAqL1xuZXhwb3J0IGNsYXNzIEhpc3RvcnlBY3Rpdml0eVByaW50ZXIgZXh0ZW5kcyBBY3Rpdml0eVByaW50ZXJCYXNlIHtcbiAgLyoqXG4gICAqIExhc3QgdGltZSB3ZSBwcmludGVkIHNvbWV0aGluZyB0byB0aGUgY29uc29sZS5cbiAgICpcbiAgICogVXNlZCB0byBtZWFzdXJlIHRpbWVvdXQgZm9yIHByb2dyZXNzIHJlcG9ydGluZy5cbiAgICovXG4gIHByaXZhdGUgbGFzdFByaW50VGltZSA9IERhdGUubm93KCk7XG5cbiAgLyoqXG4gICAqIE51bWJlciBvZiBtcyBvZiBjaGFuZ2UgYWJzZW5jZSBiZWZvcmUgd2UgdGVsbCB0aGUgdXNlciBhYm91dCB0aGUgcmVzb3VyY2VzIHRoYXQgYXJlIGN1cnJlbnRseSBpbiBwcm9ncmVzcy5cbiAgICovXG4gIHByaXZhdGUgcmVhZG9ubHkgaW5Qcm9ncmVzc0RlbGF5ID0gMzBfMDAwO1xuXG4gIHByaXZhdGUgcmVhZG9ubHkgcHJpbnRhYmxlID0gbmV3IEFycmF5PFN0YWNrQWN0aXZpdHk+KCk7XG5cbiAgY29uc3RydWN0b3IocHJvcHM6IFByaW50ZXJQcm9wcykge1xuICAgIHN1cGVyKHByb3BzKTtcbiAgfVxuXG4gIHB1YmxpYyBhZGRBY3Rpdml0eShhY3Rpdml0eTogU3RhY2tBY3Rpdml0eSkge1xuICAgIHN1cGVyLmFkZEFjdGl2aXR5KGFjdGl2aXR5KTtcbiAgICB0aGlzLnByaW50YWJsZS5wdXNoKGFjdGl2aXR5KTtcbiAgICB0aGlzLnByaW50KCk7XG4gIH1cblxuICBwdWJsaWMgcHJpbnQoKSB7XG4gICAgZm9yIChjb25zdCBhY3Rpdml0eSBvZiB0aGlzLnByaW50YWJsZSkge1xuICAgICAgdGhpcy5wcmludE9uZShhY3Rpdml0eSk7XG4gICAgfVxuICAgIHRoaXMucHJpbnRhYmxlLnNwbGljZSgwLCB0aGlzLnByaW50YWJsZS5sZW5ndGgpO1xuICAgIHRoaXMucHJpbnRJblByb2dyZXNzKCk7XG4gIH1cblxuICBwdWJsaWMgc3RvcCgpIHtcbiAgICAvLyBQcmludCBmYWlsdXJlcyBhdCB0aGUgZW5kXG4gICAgaWYgKHRoaXMuZmFpbHVyZXMubGVuZ3RoID4gMCkge1xuICAgICAgdGhpcy5zdHJlYW0ud3JpdGUoJ1xcbkZhaWxlZCByZXNvdXJjZXM6XFxuJyk7XG4gICAgICBmb3IgKGNvbnN0IGZhaWx1cmUgb2YgdGhpcy5mYWlsdXJlcykge1xuICAgICAgICAvLyBSb290IHN0YWNrIGZhaWx1cmVzIGFyZSBub3QgaW50ZXJlc3RpbmdcbiAgICAgICAgaWYgKGZhaWx1cmUuaXNTdGFja0V2ZW50KSB7XG4gICAgICAgICAgY29udGludWU7XG4gICAgICAgIH1cblxuICAgICAgICB0aGlzLnByaW50T25lKGZhaWx1cmUsIGZhbHNlKTtcbiAgICAgIH1cbiAgICB9XG4gIH1cblxuICBwcml2YXRlIHByaW50T25lKGFjdGl2aXR5OiBTdGFja0FjdGl2aXR5LCBwcm9ncmVzcz86IGJvb2xlYW4pIHtcbiAgICBjb25zdCBldmVudCA9IGFjdGl2aXR5LmV2ZW50O1xuICAgIGNvbnN0IGNvbG9yID0gY29sb3JGcm9tU3RhdHVzUmVzdWx0KGV2ZW50LlJlc291cmNlU3RhdHVzKTtcbiAgICBsZXQgcmVhc29uQ29sb3IgPSBjaGFsay5jeWFuO1xuXG4gICAgbGV0IHN0YWNrVHJhY2UgPSAnJztcbiAgICBjb25zdCBtZXRhZGF0YSA9IGFjdGl2aXR5Lm1ldGFkYXRhO1xuXG4gICAgaWYgKGV2ZW50LlJlc291cmNlU3RhdHVzICYmIGV2ZW50LlJlc291cmNlU3RhdHVzLmluZGV4T2YoJ0ZBSUxFRCcpICE9PSAtMSkge1xuICAgICAgaWYgKHByb2dyZXNzID09IHVuZGVmaW5lZCB8fCBwcm9ncmVzcykge1xuICAgICAgICBldmVudC5SZXNvdXJjZVN0YXR1c1JlYXNvbiA9IGV2ZW50LlJlc291cmNlU3RhdHVzUmVhc29uID8gdGhpcy5mYWlsdXJlUmVhc29uKGFjdGl2aXR5KSA6ICcnO1xuICAgICAgfVxuICAgICAgaWYgKG1ldGFkYXRhKSB7XG4gICAgICAgIHN0YWNrVHJhY2UgPSBtZXRhZGF0YS5lbnRyeS50cmFjZSA/IGBcXG5cXHQke21ldGFkYXRhLmVudHJ5LnRyYWNlLmpvaW4oJ1xcblxcdFxcXFxfICcpfWAgOiAnJztcbiAgICAgIH1cbiAgICAgIHJlYXNvbkNvbG9yID0gY2hhbGsucmVkO1xuICAgIH1cblxuICAgIGNvbnN0IHJlc291cmNlTmFtZSA9IG1ldGFkYXRhID8gbWV0YWRhdGEuY29uc3RydWN0UGF0aCA6IGV2ZW50LkxvZ2ljYWxSZXNvdXJjZUlkIHx8ICcnO1xuXG4gICAgY29uc3QgbG9naWNhbElkID0gcmVzb3VyY2VOYW1lICE9PSBldmVudC5Mb2dpY2FsUmVzb3VyY2VJZCA/IGAoJHtldmVudC5Mb2dpY2FsUmVzb3VyY2VJZH0pIGAgOiAnJztcblxuICAgIHRoaXMuc3RyZWFtLndyaXRlKFxuICAgICAgdXRpbC5mb3JtYXQoXG4gICAgICAgICclcyB8ICVzJXMgfCAlcyB8ICVzIHwgJXMgJXMlcyVzXFxuJyxcbiAgICAgICAgZXZlbnQuU3RhY2tOYW1lLFxuICAgICAgICBwcm9ncmVzcyAhPT0gZmFsc2UgPyBgJHt0aGlzLnByb2dyZXNzKCl9IHwgYCA6ICcnLFxuICAgICAgICBuZXcgRGF0ZShldmVudC5UaW1lc3RhbXAhKS50b0xvY2FsZVRpbWVTdHJpbmcoKSxcbiAgICAgICAgY29sb3IocGFkUmlnaHQoU1RBVFVTX1dJRFRILCAoZXZlbnQuUmVzb3VyY2VTdGF0dXMgfHwgJycpLnNsaWNlKDAsIFNUQVRVU19XSURUSCkpKSwgLy8gcGFkIGxlZnQgYW5kIHRyaW1cbiAgICAgICAgcGFkUmlnaHQodGhpcy5wcm9wcy5yZXNvdXJjZVR5cGVDb2x1bW5XaWR0aCwgZXZlbnQuUmVzb3VyY2VUeXBlIHx8ICcnKSxcbiAgICAgICAgY29sb3IoY2hhbGsuYm9sZChyZXNvdXJjZU5hbWUpKSxcbiAgICAgICAgbG9naWNhbElkLFxuICAgICAgICByZWFzb25Db2xvcihjaGFsay5ib2xkKGV2ZW50LlJlc291cmNlU3RhdHVzUmVhc29uID8gZXZlbnQuUmVzb3VyY2VTdGF0dXNSZWFzb24gOiAnJykpLFxuICAgICAgICByZWFzb25Db2xvcihzdGFja1RyYWNlKSxcbiAgICAgICksXG4gICAgKTtcblxuICAgIHRoaXMubGFzdFByaW50VGltZSA9IERhdGUubm93KCk7XG4gIH1cblxuICAvKipcbiAgICogUmVwb3J0IHRoZSBjdXJyZW50IHByb2dyZXNzIGFzIGEgWzM0LzQyXSBzdHJpbmcsIG9yIGp1c3QgWzM0XSBpZiB0aGUgdG90YWwgaXMgdW5rbm93blxuICAgKi9cbiAgcHJpdmF0ZSBwcm9ncmVzcygpOiBzdHJpbmcge1xuICAgIGlmICh0aGlzLnJlc291cmNlc1RvdGFsID09IG51bGwpIHtcbiAgICAgIC8vIERvbid0IGhhdmUgdG90YWwsIHNob3cgc2ltcGxlIGNvdW50IGFuZCBob3BlIHRoZSBodW1hbiBrbm93c1xuICAgICAgcmV0dXJuIHBhZExlZnQoMywgdXRpbC5mb3JtYXQoJyVzJywgdGhpcy5yZXNvdXJjZXNEb25lKSk7IC8vIG1heCA1MDAgcmVzb3VyY2VzXG4gICAgfVxuXG4gICAgcmV0dXJuIHV0aWwuZm9ybWF0KFxuICAgICAgJyVzLyVzJyxcbiAgICAgIHBhZExlZnQodGhpcy5yZXNvdXJjZURpZ2l0cywgdGhpcy5yZXNvdXJjZXNEb25lLnRvU3RyaW5nKCkpLFxuICAgICAgcGFkTGVmdCh0aGlzLnJlc291cmNlRGlnaXRzLCB0aGlzLnJlc291cmNlc1RvdGFsICE9IG51bGwgPyB0aGlzLnJlc291cmNlc1RvdGFsLnRvU3RyaW5nKCkgOiAnPycpLFxuICAgICk7XG4gIH1cblxuICAvKipcbiAgICogSWYgc29tZSByZXNvdXJjZXMgYXJlIHRha2luZyBhIHdoaWxlIHRvIGNyZWF0ZSwgbm90aWZ5IHRoZSB1c2VyIGFib3V0IHdoYXQncyBjdXJyZW50bHkgaW4gcHJvZ3Jlc3NcbiAgICovXG4gIHByaXZhdGUgcHJpbnRJblByb2dyZXNzKCkge1xuICAgIGlmIChEYXRlLm5vdygpIDwgdGhpcy5sYXN0UHJpbnRUaW1lICsgdGhpcy5pblByb2dyZXNzRGVsYXkpIHtcbiAgICAgIHJldHVybjtcbiAgICB9XG5cbiAgICBpZiAoT2JqZWN0LmtleXModGhpcy5yZXNvdXJjZXNJblByb2dyZXNzKS5sZW5ndGggPiAwKSB7XG4gICAgICB0aGlzLnN0cmVhbS53cml0ZShcbiAgICAgICAgdXRpbC5mb3JtYXQoXG4gICAgICAgICAgJyVzIEN1cnJlbnRseSBpbiBwcm9ncmVzczogJXNcXG4nLFxuICAgICAgICAgIHRoaXMucHJvZ3Jlc3MoKSxcbiAgICAgICAgICBjaGFsay5ib2xkKE9iamVjdC5rZXlzKHRoaXMucmVzb3VyY2VzSW5Qcm9ncmVzcykuam9pbignLCAnKSksXG4gICAgICAgICksXG4gICAgICApO1xuICAgIH1cblxuICAgIC8vIFdlIGNoZWF0IGEgYml0IGhlcmUuIFRvIHByZXZlbnQgcHJpbnRJblByb2dyZXNzKCkgZnJvbSByZXBlYXRlZGx5IHRyaWdnZXJpbmcsXG4gICAgLy8gd2Ugc2V0IHRoZSB0aW1lc3RhbXAgaW50byB0aGUgZnV0dXJlLiBJdCB3aWxsIGJlIHJlc2V0IHdoZW5ldmVyIGEgcmVndWxhciBwcmludFxuICAgIC8vIG9jY3VycywgYWZ0ZXIgd2hpY2ggd2UgY2FuIGJlIHRyaWdnZXJlZCBhZ2Fpbi5cbiAgICB0aGlzLmxhc3RQcmludFRpbWUgPSArSW5maW5pdHk7XG4gIH1cbn1cblxuLyoqXG4gKiBBY3Rpdml0eSBQcmludGVyIHdoaWNoIHNob3dzIHRoZSByZXNvdXJjZXMgY3VycmVudGx5IGJlaW5nIHVwZGF0ZWRcbiAqXG4gKiBJdCB3aWxsIGNvbnRpbnVvdXNseSByZXVwZGF0ZSB0aGUgdGVybWluYWwgYW5kIHNob3cgb25seSB0aGUgcmVzb3VyY2VzXG4gKiB0aGF0IGFyZSBjdXJyZW50bHkgYmVpbmcgdXBkYXRlZCwgaW4gYWRkaXRpb24gdG8gYSBwcm9ncmVzcyBiYXIgd2hpY2hcbiAqIHNob3dzIGhvdyBmYXIgYWxvbmcgdGhlIGRlcGxveW1lbnQgaXMuXG4gKlxuICogUmVzb3VyY2VzIHRoYXQgaGF2ZSBmYWlsZWQgd2lsbCBhbHdheXMgYmUgc2hvd24sIGFuZCB3aWxsIGJlIHJlY2FwaXR1bGF0ZWRcbiAqIGFsb25nIHdpdGggdGhlaXIgc3RhY2sgdHJhY2Ugd2hlbiB0aGUgbW9uaXRvcmluZyBlbmRzLlxuICpcbiAqIFJlc291cmNlcyB0aGF0IGZhaWxlZCBkZXBsb3ltZW50IGJlY2F1c2UgdGhleSBoYXZlIGJlZW4gY2FuY2VsbGVkIGFyZVxuICogbm90IGluY2x1ZGVkLlxuICovXG5leHBvcnQgY2xhc3MgQ3VycmVudEFjdGl2aXR5UHJpbnRlciBleHRlbmRzIEFjdGl2aXR5UHJpbnRlckJhc2Uge1xuICAvKipcbiAgICogVGhpcyBsb29rcyB2ZXJ5IGRpc29yaWVudGluZyBzbGVlcGluZyBmb3IgNSBzZWNvbmRzLiBVcGRhdGUgcXVpY2tlci5cbiAgICovXG4gIHB1YmxpYyByZWFkb25seSB1cGRhdGVTbGVlcDogbnVtYmVyID0gMl8wMDA7XG5cbiAgcHJpdmF0ZSBvbGRMb2dMZXZlbDogTG9nTGV2ZWwgPSBMb2dMZXZlbC5ERUZBVUxUO1xuICBwcml2YXRlIGJsb2NrID0gbmV3IFJld3JpdGFibGVCbG9jayh0aGlzLnN0cmVhbSk7XG5cbiAgY29uc3RydWN0b3IocHJvcHM6IFByaW50ZXJQcm9wcykge1xuICAgIHN1cGVyKHByb3BzKTtcbiAgfVxuXG4gIHB1YmxpYyBwcmludCgpOiB2b2lkIHtcbiAgICBjb25zdCBsaW5lcyA9IFtdO1xuXG4gICAgLy8gQWRkIGEgcHJvZ3Jlc3MgYmFyIGF0IHRoZSB0b3BcbiAgICBjb25zdCBwcm9ncmVzc1dpZHRoID0gTWF0aC5tYXgoXG4gICAgICBNYXRoLm1pbigodGhpcy5ibG9jay53aWR0aCA/PyA4MCkgLSBQUk9HUkVTU0JBUl9FWFRSQV9TUEFDRSAtIDEsIE1BWF9QUk9HUkVTU0JBUl9XSURUSCksXG4gICAgICBNSU5fUFJPR1JFU1NCQVJfV0lEVEgsXG4gICAgKTtcbiAgICBjb25zdCBwcm9nID0gdGhpcy5wcm9ncmVzc0Jhcihwcm9ncmVzc1dpZHRoKTtcbiAgICBpZiAocHJvZykge1xuICAgICAgbGluZXMucHVzaCgnICAnICsgcHJvZywgJycpO1xuICAgIH1cblxuICAgIC8vIE5vcm1hbGx5IHdlJ2Qgb25seSBwcmludCBcInJlc291cmNlcyBpbiBwcm9ncmVzc1wiLCBidXQgaXQncyBhbHNvIHVzZWZ1bFxuICAgIC8vIHRvIGtlZXAgYW4gZXllIG9uIHRoZSBmYWlsdXJlcyBhbmQga25vdyBhYm91dCB0aGUgc3BlY2lmaWMgZXJyb3JzIGFzcXVpY2tseVxuICAgIC8vIGFzIHBvc3NpYmxlICh3aGlsZSB0aGUgc3RhY2sgaXMgc3RpbGwgcm9sbGluZyBiYWNrKSwgc28gYWRkIHRob3NlIGluLlxuICAgIGNvbnN0IHRvUHJpbnQ6IFN0YWNrQWN0aXZpdHlbXSA9IFsuLi50aGlzLmZhaWx1cmVzLCAuLi5PYmplY3QudmFsdWVzKHRoaXMucmVzb3VyY2VzSW5Qcm9ncmVzcyldO1xuICAgIHRvUHJpbnQuc29ydCgoYSwgYikgPT4gYS5ldmVudC5UaW1lc3RhbXAhLmdldFRpbWUoKSAtIGIuZXZlbnQuVGltZXN0YW1wIS5nZXRUaW1lKCkpO1xuXG4gICAgbGluZXMucHVzaChcbiAgICAgIC4uLnRvUHJpbnQubWFwKChyZXMpID0+IHtcbiAgICAgICAgY29uc3QgY29sb3IgPSBjb2xvckZyb21TdGF0dXNBY3Rpdml0eShyZXMuZXZlbnQuUmVzb3VyY2VTdGF0dXMpO1xuICAgICAgICBjb25zdCByZXNvdXJjZU5hbWUgPSByZXMubWV0YWRhdGE/LmNvbnN0cnVjdFBhdGggPz8gcmVzLmV2ZW50LkxvZ2ljYWxSZXNvdXJjZUlkID8/ICcnO1xuXG4gICAgICAgIHJldHVybiB1dGlsLmZvcm1hdChcbiAgICAgICAgICAnJXMgfCAlcyB8ICVzIHwgJXMlcycsXG4gICAgICAgICAgcGFkTGVmdChUSU1FU1RBTVBfV0lEVEgsIG5ldyBEYXRlKHJlcy5ldmVudC5UaW1lc3RhbXAhKS50b0xvY2FsZVRpbWVTdHJpbmcoKSksXG4gICAgICAgICAgY29sb3IocGFkUmlnaHQoU1RBVFVTX1dJRFRILCAocmVzLmV2ZW50LlJlc291cmNlU3RhdHVzIHx8ICcnKS5zbGljZSgwLCBTVEFUVVNfV0lEVEgpKSksXG4gICAgICAgICAgcGFkUmlnaHQodGhpcy5wcm9wcy5yZXNvdXJjZVR5cGVDb2x1bW5XaWR0aCwgcmVzLmV2ZW50LlJlc291cmNlVHlwZSB8fCAnJyksXG4gICAgICAgICAgY29sb3IoY2hhbGsuYm9sZChzaG9ydGVuKDQwLCByZXNvdXJjZU5hbWUpKSksXG4gICAgICAgICAgdGhpcy5mYWlsdXJlUmVhc29uT25OZXh0TGluZShyZXMpLFxuICAgICAgICApO1xuICAgICAgfSksXG4gICAgKTtcblxuICAgIHRoaXMuYmxvY2suZGlzcGxheUxpbmVzKGxpbmVzKTtcbiAgfVxuXG4gIHB1YmxpYyBzdGFydCgpIHtcbiAgICAvLyBOZWVkIHRvIHByZXZlbnQgdGhlIHdhaXRlciBmcm9tIHByaW50aW5nICdzdGFjayBub3Qgc3RhYmxlJyBldmVyeSA1IHNlY29uZHMsIGl0IG1lc3Nlc1xuICAgIC8vIHdpdGggdGhlIG91dHB1dCBjYWxjdWxhdGlvbnMuXG4gICAgdGhpcy5vbGRMb2dMZXZlbCA9IGxvZ0xldmVsO1xuICAgIHNldExvZ0xldmVsKExvZ0xldmVsLkRFRkFVTFQpO1xuICB9XG5cbiAgcHVibGljIHN0b3AoKSB7XG4gICAgc2V0TG9nTGV2ZWwodGhpcy5vbGRMb2dMZXZlbCk7XG5cbiAgICAvLyBQcmludCBmYWlsdXJlcyBhdCB0aGUgZW5kXG4gICAgY29uc3QgbGluZXMgPSBuZXcgQXJyYXk8c3RyaW5nPigpO1xuICAgIGZvciAoY29uc3QgZmFpbHVyZSBvZiB0aGlzLmZhaWx1cmVzKSB7XG4gICAgICAvLyBSb290IHN0YWNrIGZhaWx1cmVzIGFyZSBub3QgaW50ZXJlc3RpbmdcbiAgICAgIGlmIChmYWlsdXJlLmlzU3RhY2tFdmVudCkge1xuICAgICAgICBjb250aW51ZTtcbiAgICAgIH1cblxuICAgICAgbGluZXMucHVzaChcbiAgICAgICAgdXRpbC5mb3JtYXQoXG4gICAgICAgICAgY2hhbGsucmVkKCclcyB8ICVzIHwgJXMgfCAlcyVzJykgKyAnXFxuJyxcbiAgICAgICAgICBwYWRMZWZ0KFRJTUVTVEFNUF9XSURUSCwgbmV3IERhdGUoZmFpbHVyZS5ldmVudC5UaW1lc3RhbXAhKS50b0xvY2FsZVRpbWVTdHJpbmcoKSksXG4gICAgICAgICAgcGFkUmlnaHQoU1RBVFVTX1dJRFRILCAoZmFpbHVyZS5ldmVudC5SZXNvdXJjZVN0YXR1cyB8fCAnJykuc2xpY2UoMCwgU1RBVFVTX1dJRFRIKSksXG4gICAgICAgICAgcGFkUmlnaHQodGhpcy5wcm9wcy5yZXNvdXJjZVR5cGVDb2x1bW5XaWR0aCwgZmFpbHVyZS5ldmVudC5SZXNvdXJjZVR5cGUgfHwgJycpLFxuICAgICAgICAgIHNob3J0ZW4oNDAsIGZhaWx1cmUuZXZlbnQuTG9naWNhbFJlc291cmNlSWQgPz8gJycpLFxuICAgICAgICAgIHRoaXMuZmFpbHVyZVJlYXNvbk9uTmV4dExpbmUoZmFpbHVyZSksXG4gICAgICAgICksXG4gICAgICApO1xuXG4gICAgICBjb25zdCB0cmFjZSA9IGZhaWx1cmUubWV0YWRhdGE/LmVudHJ5Py50cmFjZTtcbiAgICAgIGlmICh0cmFjZSkge1xuICAgICAgICBsaW5lcy5wdXNoKGNoYWxrLnJlZChgXFx0JHt0cmFjZS5qb2luKCdcXG5cXHRcXFxcXyAnKX1cXG5gKSk7XG4gICAgICB9XG4gICAgfVxuXG4gICAgLy8gRGlzcGxheSBpbiB0aGUgc2FtZSBibG9jayBzcGFjZSwgb3RoZXJ3aXNlIHdlJ3JlIGdvaW5nIHRvIGhhdmUgc2lsbHkgZW1wdHkgbGluZXMuXG4gICAgdGhpcy5ibG9jay5kaXNwbGF5TGluZXMobGluZXMpO1xuICAgIHRoaXMuYmxvY2sucmVtb3ZlRW1wdHlMaW5lcygpO1xuICB9XG5cbiAgcHJpdmF0ZSBwcm9ncmVzc0Jhcih3aWR0aDogbnVtYmVyKSB7XG4gICAgaWYgKCF0aGlzLnJlc291cmNlc1RvdGFsKSB7XG4gICAgICByZXR1cm4gJyc7XG4gICAgfVxuICAgIGNvbnN0IGZyYWN0aW9uID0gTWF0aC5taW4odGhpcy5yZXNvdXJjZXNEb25lIC8gdGhpcy5yZXNvdXJjZXNUb3RhbCwgMSk7XG4gICAgY29uc3QgaW5uZXJXaWR0aCA9IE1hdGgubWF4KDEsIHdpZHRoIC0gMik7XG4gICAgY29uc3QgY2hhcnMgPSBpbm5lcldpZHRoICogZnJhY3Rpb247XG4gICAgY29uc3QgcmVtYWluZGVyID0gY2hhcnMgLSBNYXRoLmZsb29yKGNoYXJzKTtcblxuICAgIGNvbnN0IGZ1bGxDaGFycyA9IEZVTExfQkxPQ0sucmVwZWF0KE1hdGguZmxvb3IoY2hhcnMpKTtcbiAgICBjb25zdCBwYXJ0aWFsQ2hhciA9IFBBUlRJQUxfQkxPQ0tbTWF0aC5mbG9vcihyZW1haW5kZXIgKiBQQVJUSUFMX0JMT0NLLmxlbmd0aCldO1xuICAgIGNvbnN0IGZpbGxlciA9ICfCtycucmVwZWF0KGlubmVyV2lkdGggLSBNYXRoLmZsb29yKGNoYXJzKSAtIChwYXJ0aWFsQ2hhciA/IDEgOiAwKSk7XG5cbiAgICBjb25zdCBjb2xvciA9IHRoaXMucm9sbGluZ0JhY2sgPyBjaGFsay55ZWxsb3cgOiBjaGFsay5ncmVlbjtcblxuICAgIHJldHVybiAnWycgKyBjb2xvcihmdWxsQ2hhcnMgKyBwYXJ0aWFsQ2hhcikgKyBmaWxsZXIgKyBgXSAoJHt0aGlzLnJlc291cmNlc0RvbmV9LyR7dGhpcy5yZXNvdXJjZXNUb3RhbH0pYDtcbiAgfVxuXG4gIHByaXZhdGUgZmFpbHVyZVJlYXNvbk9uTmV4dExpbmUoYWN0aXZpdHk6IFN0YWNrQWN0aXZpdHkpIHtcbiAgICByZXR1cm4gaGFzRXJyb3JNZXNzYWdlKGFjdGl2aXR5LmV2ZW50LlJlc291cmNlU3RhdHVzID8/ICcnKVxuICAgICAgPyBgXFxuJHsnICcucmVwZWF0KFRJTUVTVEFNUF9XSURUSCArIFNUQVRVU19XSURUSCArIDYpfSR7Y2hhbGsucmVkKHRoaXMuZmFpbHVyZVJlYXNvbihhY3Rpdml0eSkgPz8gJycpfWBcbiAgICAgIDogJyc7XG4gIH1cbn1cblxuY29uc3QgRlVMTF9CTE9DSyA9ICfilognO1xuY29uc3QgUEFSVElBTF9CTE9DSyA9IFsnJywgJ+KWjycsICfilo4nLCAn4paNJywgJ+KWjCcsICfilosnLCAn4paKJywgJ+KWiSddO1xuY29uc3QgTUFYX1BST0dSRVNTQkFSX1dJRFRIID0gNjA7XG5jb25zdCBNSU5fUFJPR1JFU1NCQVJfV0lEVEggPSAxMDtcbmNvbnN0IFBST0dSRVNTQkFSX0VYVFJBX1NQQUNFID1cbiAgMiAvKiBsZWFkaW5nIHNwYWNlcyAqLyArIDIgLyogYnJhY2tldHMgKi8gKyA0IC8qIHByb2dyZXNzIG51bWJlciBkZWNvcmF0aW9uICovICsgNjsgLyogMiBwcm9ncmVzcyBudW1iZXJzIHVwIHRvIDk5OSAqL1xuXG5mdW5jdGlvbiBoYXNFcnJvck1lc3NhZ2Uoc3RhdHVzOiBzdHJpbmcpIHtcbiAgcmV0dXJuIHN0YXR1cy5lbmRzV2l0aCgnX0ZBSUxFRCcpIHx8IHN0YXR1cyA9PT0gJ1JPTExCQUNLX0lOX1BST0dSRVNTJyB8fCBzdGF0dXMgPT09ICdVUERBVEVfUk9MTEJBQ0tfSU5fUFJPR1JFU1MnO1xufVxuXG5mdW5jdGlvbiBjb2xvckZyb21TdGF0dXNSZXN1bHQoc3RhdHVzPzogc3RyaW5nKSB7XG4gIGlmICghc3RhdHVzKSB7XG4gICAgcmV0dXJuIGNoYWxrLnJlc2V0O1xuICB9XG5cbiAgaWYgKHN0YXR1cy5pbmRleE9mKCdGQUlMRUQnKSAhPT0gLTEpIHtcbiAgICByZXR1cm4gY2hhbGsucmVkO1xuICB9XG4gIGlmIChzdGF0dXMuaW5kZXhPZignUk9MTEJBQ0snKSAhPT0gLTEpIHtcbiAgICByZXR1cm4gY2hhbGsueWVsbG93O1xuICB9XG4gIGlmIChzdGF0dXMuaW5kZXhPZignQ09NUExFVEUnKSAhPT0gLTEpIHtcbiAgICByZXR1cm4gY2hhbGsuZ3JlZW47XG4gIH1cblxuICByZXR1cm4gY2hhbGsucmVzZXQ7XG59XG5cbmZ1bmN0aW9uIGNvbG9yRnJvbVN0YXR1c0FjdGl2aXR5KHN0YXR1cz86IHN0cmluZykge1xuICBpZiAoIXN0YXR1cykge1xuICAgIHJldHVybiBjaGFsay5yZXNldDtcbiAgfVxuXG4gIGlmIChzdGF0dXMuZW5kc1dpdGgoJ19GQUlMRUQnKSkge1xuICAgIHJldHVybiBjaGFsay5yZWQ7XG4gIH1cblxuICBpZiAoc3RhdHVzLnN0YXJ0c1dpdGgoJ0NSRUFURV8nKSB8fCBzdGF0dXMuc3RhcnRzV2l0aCgnVVBEQVRFXycpIHx8IHN0YXR1cy5zdGFydHNXaXRoKCdJTVBPUlRfJykpIHtcbiAgICByZXR1cm4gY2hhbGsuZ3JlZW47XG4gIH1cbiAgLy8gRm9yIHN0YWNrcywgaXQgbWF5IGFsc28gYmUgJ1VQRERBVEVfUk9MTEJBQ0tfSU5fUFJPR1JFU1MnXG4gIGlmIChzdGF0dXMuaW5kZXhPZignUk9MTEJBQ0tfJykgIT09IC0xKSB7XG4gICAgcmV0dXJuIGNoYWxrLnllbGxvdztcbiAgfVxuICBpZiAoc3RhdHVzLnN0YXJ0c1dpdGgoJ0RFTEVURV8nKSkge1xuICAgIHJldHVybiBjaGFsay55ZWxsb3c7XG4gIH1cblxuICByZXR1cm4gY2hhbGsucmVzZXQ7XG59XG5cbmZ1bmN0aW9uIHNob3J0ZW4obWF4V2lkdGg6IG51bWJlciwgcDogc3RyaW5nKSB7XG4gIGlmIChwLmxlbmd0aCA8PSBtYXhXaWR0aCkge1xuICAgIHJldHVybiBwO1xuICB9XG4gIGNvbnN0IGhhbGYgPSBNYXRoLmZsb29yKChtYXhXaWR0aCAtIDMpIC8gMik7XG4gIHJldHVybiBwLnNsaWNlKDAsIGhhbGYpICsgJy4uLicgKyBwLnNsaWNlKC1oYWxmKTtcbn1cblxuY29uc3QgVElNRVNUQU1QX1dJRFRIID0gMTI7XG5jb25zdCBTVEFUVVNfV0lEVEggPSAyMDtcbiJdfQ==