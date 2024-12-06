"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.CdkToolkit = exports.AssetBuildTime = void 0;
exports.markTesting = markTesting;
const path = require("path");
const util_1 = require("util");
const cxapi = require("@aws-cdk/cx-api");
const chalk = require("chalk");
const chokidar = require("chokidar");
const fs = require("fs-extra");
const promptly = require("promptly");
const uuid = require("uuid");
const cloud_assembly_1 = require("./api/cxapp/cloud-assembly");
const garbage_collector_1 = require("./api/garbage-collection/garbage-collector");
const common_1 = require("./api/hotswap/common");
const find_cloudwatch_logs_1 = require("./api/logs/find-cloudwatch-logs");
const logs_monitor_1 = require("./api/logs/logs-monitor");
const cloudformation_1 = require("./api/util/cloudformation");
const stack_activity_monitor_1 = require("./api/util/cloudformation/stack-activity-monitor");
const migrate_1 = require("./commands/migrate");
const diff_1 = require("./diff");
const import_1 = require("./import");
const list_stacks_1 = require("./list-stacks");
const logging_1 = require("./logging");
const serialize_1 = require("./serialize");
const settings_1 = require("./settings");
const util_2 = require("./util");
const validate_notification_arn_1 = require("./util/validate-notification-arn");
const work_graph_builder_1 = require("./util/work-graph-builder");
const environments_1 = require("../lib/api/cxapp/environments");
// Must use a require() otherwise esbuild complains about calling a namespace
// eslint-disable-next-line @typescript-eslint/no-require-imports
const pLimit = require('p-limit');
let TESTING = false;
function markTesting() {
    TESTING = true;
}
/**
 * When to build assets
 */
var AssetBuildTime;
(function (AssetBuildTime) {
    /**
     * Build all assets before deploying the first stack
     *
     * This is intended for expensive Docker image builds; so that if the Docker image build
     * fails, no stacks are unnecessarily deployed (with the attendant wait time).
     */
    AssetBuildTime[AssetBuildTime["ALL_BEFORE_DEPLOY"] = 0] = "ALL_BEFORE_DEPLOY";
    /**
     * Build assets just-in-time, before publishing
     */
    AssetBuildTime[AssetBuildTime["JUST_IN_TIME"] = 1] = "JUST_IN_TIME";
})(AssetBuildTime || (exports.AssetBuildTime = AssetBuildTime = {}));
/**
 * Toolkit logic
 *
 * The toolkit runs the `cloudExecutable` to obtain a cloud assembly and
 * deploys applies them to `cloudFormation`.
 */
class CdkToolkit {
    constructor(props) {
        this.props = props;
    }
    async metadata(stackName, json) {
        const stacks = await this.selectSingleStackByName(stackName);
        printSerializedObject(stacks.firstStack.manifest.metadata ?? {}, json);
    }
    async acknowledge(noticeId) {
        const acks = this.props.configuration.context.get('acknowledged-issue-numbers') ?? [];
        acks.push(Number(noticeId));
        this.props.configuration.context.set('acknowledged-issue-numbers', acks);
        await this.props.configuration.saveContext();
    }
    async diff(options) {
        const stacks = await this.selectStacksForDiff(options.stackNames, options.exclusively);
        const strict = !!options.strict;
        const contextLines = options.contextLines || 3;
        const stream = options.stream || process.stderr;
        const quiet = options.quiet || false;
        let diffs = 0;
        const parameterMap = buildParameterMap(options.parameters);
        if (options.templatePath !== undefined) {
            // Compare single stack against fixed template
            if (stacks.stackCount !== 1) {
                throw new Error('Can only select one stack when comparing to fixed template. Use --exclusively to avoid selecting multiple stacks.');
            }
            if (!(await fs.pathExists(options.templatePath))) {
                throw new Error(`There is no file at ${options.templatePath}`);
            }
            const template = (0, serialize_1.deserializeStructure)(await fs.readFile(options.templatePath, { encoding: 'UTF-8' }));
            diffs = options.securityOnly
                ? (0, util_2.numberFromBool)((0, diff_1.printSecurityDiff)(template, stacks.firstStack, diff_1.RequireApproval.Broadening, quiet))
                : (0, diff_1.printStackDiff)(template, stacks.firstStack, strict, contextLines, quiet, undefined, undefined, false, stream);
        }
        else {
            // Compare N stacks against deployed templates
            for (const stack of stacks.stackArtifacts) {
                const templateWithNestedStacks = await this.props.deployments.readCurrentTemplateWithNestedStacks(stack, options.compareAgainstProcessedTemplate);
                const currentTemplate = templateWithNestedStacks.deployedRootTemplate;
                const nestedStacks = templateWithNestedStacks.nestedStacks;
                const resourcesToImport = await this.tryGetResources(await this.props.deployments.resolveEnvironment(stack));
                if (resourcesToImport) {
                    (0, import_1.removeNonImportResources)(stack);
                }
                let changeSet = undefined;
                if (options.changeSet) {
                    let stackExists = false;
                    try {
                        stackExists = await this.props.deployments.stackExists({
                            stack,
                            deployName: stack.stackName,
                            tryLookupRole: true,
                        });
                    }
                    catch (e) {
                        (0, logging_1.debug)(e.message);
                        if (!quiet) {
                            stream.write(`Checking if the stack ${stack.stackName} exists before creating the changeset has failed, will base the diff on template differences (run again with -v to see the reason)\n`);
                        }
                        stackExists = false;
                    }
                    if (stackExists) {
                        changeSet = await (0, cloudformation_1.createDiffChangeSet)({
                            stack,
                            uuid: uuid.v4(),
                            deployments: this.props.deployments,
                            willExecute: false,
                            sdkProvider: this.props.sdkProvider,
                            parameters: Object.assign({}, parameterMap['*'], parameterMap[stack.stackName]),
                            resourcesToImport,
                            stream,
                        });
                    }
                    else {
                        (0, logging_1.debug)(`the stack '${stack.stackName}' has not been deployed to CloudFormation or describeStacks call failed, skipping changeset creation.`);
                    }
                }
                const stackCount = options.securityOnly
                    ? (0, util_2.numberFromBool)((0, diff_1.printSecurityDiff)(currentTemplate, stack, diff_1.RequireApproval.Broadening, quiet, stack.displayName, changeSet))
                    : (0, diff_1.printStackDiff)(currentTemplate, stack, strict, contextLines, quiet, stack.displayName, changeSet, !!resourcesToImport, stream, nestedStacks);
                diffs += stackCount;
            }
        }
        stream.write((0, util_1.format)('\n✨  Number of stacks with differences: %s\n', diffs));
        return diffs && options.fail ? 1 : 0;
    }
    async deploy(options) {
        if (options.watch) {
            return this.watch(options);
        }
        const startSynthTime = new Date().getTime();
        const stackCollection = await this.selectStacksForDeploy(options.selector, options.exclusively, options.cacheCloudAssembly, options.ignoreNoStacks);
        const elapsedSynthTime = new Date().getTime() - startSynthTime;
        (0, logging_1.print)('\n✨  Synthesis time: %ss\n', formatTime(elapsedSynthTime));
        if (stackCollection.stackCount === 0) {
            // eslint-disable-next-line no-console
            console.error('This app contains no stacks');
            return;
        }
        await this.tryMigrateResources(stackCollection, options);
        const requireApproval = options.requireApproval ?? diff_1.RequireApproval.Broadening;
        const parameterMap = buildParameterMap(options.parameters);
        if (options.hotswap !== common_1.HotswapMode.FULL_DEPLOYMENT) {
            (0, logging_1.warning)('⚠️ The --hotswap and --hotswap-fallback flags deliberately introduce CloudFormation drift to speed up deployments');
            (0, logging_1.warning)('⚠️ They should only be used for development - never use them for your production Stacks!\n');
        }
        let hotswapPropertiesFromSettings = this.props.configuration.settings.get(['hotswap']) || {};
        let hotswapPropertyOverrides = new common_1.HotswapPropertyOverrides();
        hotswapPropertyOverrides.ecsHotswapProperties = new common_1.EcsHotswapProperties(hotswapPropertiesFromSettings.ecs?.minimumHealthyPercent, hotswapPropertiesFromSettings.ecs?.maximumHealthyPercent);
        const stacks = stackCollection.stackArtifacts;
        const stackOutputs = {};
        const outputsFile = options.outputsFile;
        const buildAsset = async (assetNode) => {
            await this.props.deployments.buildSingleAsset(assetNode.assetManifestArtifact, assetNode.assetManifest, assetNode.asset, {
                stack: assetNode.parentStack,
                roleArn: options.roleArn,
                stackName: assetNode.parentStack.stackName,
            });
        };
        const publishAsset = async (assetNode) => {
            await this.props.deployments.publishSingleAsset(assetNode.assetManifest, assetNode.asset, {
                stack: assetNode.parentStack,
                roleArn: options.roleArn,
                stackName: assetNode.parentStack.stackName,
            });
        };
        const deployStack = async (stackNode) => {
            const stack = stackNode.stack;
            if (stackCollection.stackCount !== 1) {
                (0, logging_1.highlight)(stack.displayName);
            }
            if (!stack.environment) {
                // eslint-disable-next-line max-len
                throw new Error(`Stack ${stack.displayName} does not define an environment, and AWS credentials could not be obtained from standard locations or no region was configured.`);
            }
            if (Object.keys(stack.template.Resources || {}).length === 0) {
                // The generated stack has no resources
                if (!(await this.props.deployments.stackExists({ stack }))) {
                    (0, logging_1.warning)('%s: stack has no resources, skipping deployment.', chalk.bold(stack.displayName));
                }
                else {
                    (0, logging_1.warning)('%s: stack has no resources, deleting existing stack.', chalk.bold(stack.displayName));
                    await this.destroy({
                        selector: { patterns: [stack.hierarchicalId] },
                        exclusively: true,
                        force: true,
                        roleArn: options.roleArn,
                        fromDeploy: true,
                        ci: options.ci,
                    });
                }
                return;
            }
            if (requireApproval !== diff_1.RequireApproval.Never) {
                const currentTemplate = await this.props.deployments.readCurrentTemplate(stack);
                if ((0, diff_1.printSecurityDiff)(currentTemplate, stack, requireApproval)) {
                    await askUserConfirmation(concurrency, '"--require-approval" is enabled and stack includes security-sensitive updates', 'Do you wish to deploy these changes');
                }
            }
            // Following are the same semantics we apply with respect to Notification ARNs (dictated by the SDK)
            //
            //  - undefined  =>  cdk ignores it, as if it wasn't supported (allows external management).
            //  - []:        =>  cdk manages it, and the user wants to wipe it out.
            //  - ['arn-1']  =>  cdk manages it, and the user wants to set it to ['arn-1'].
            const notificationArns = (!!options.notificationArns || !!stack.notificationArns)
                ? (options.notificationArns ?? []).concat(stack.notificationArns ?? [])
                : undefined;
            for (const notificationArn of notificationArns ?? []) {
                if (!(0, validate_notification_arn_1.validateSnsTopicArn)(notificationArn)) {
                    throw new Error(`Notification arn ${notificationArn} is not a valid arn for an SNS topic`);
                }
            }
            const stackIndex = stacks.indexOf(stack) + 1;
            (0, logging_1.print)('%s: deploying... [%s/%s]', chalk.bold(stack.displayName), stackIndex, stackCollection.stackCount);
            const startDeployTime = new Date().getTime();
            let tags = options.tags;
            if (!tags || tags.length === 0) {
                tags = tagsForStack(stack);
            }
            let elapsedDeployTime = 0;
            try {
                let deployResult;
                let rollback = options.rollback;
                let iteration = 0;
                while (!deployResult) {
                    if (++iteration > 2) {
                        throw new Error('This loop should have stabilized in 2 iterations, but didn\'t. If you are seeing this error, please report it at https://github.com/aws/aws-cdk/issues/new/choose');
                    }
                    const r = await this.props.deployments.deployStack({
                        stack,
                        deployName: stack.stackName,
                        roleArn: options.roleArn,
                        toolkitStackName: options.toolkitStackName,
                        reuseAssets: options.reuseAssets,
                        notificationArns,
                        tags,
                        execute: options.execute,
                        changeSetName: options.changeSetName,
                        deploymentMethod: options.deploymentMethod,
                        force: options.force,
                        parameters: Object.assign({}, parameterMap['*'], parameterMap[stack.stackName]),
                        usePreviousParameters: options.usePreviousParameters,
                        progress,
                        ci: options.ci,
                        rollback,
                        hotswap: options.hotswap,
                        hotswapPropertyOverrides: hotswapPropertyOverrides,
                        extraUserAgent: options.extraUserAgent,
                        assetParallelism: options.assetParallelism,
                        ignoreNoStacks: options.ignoreNoStacks,
                    });
                    switch (r.type) {
                        case 'did-deploy-stack':
                            deployResult = r;
                            break;
                        case 'failpaused-need-rollback-first': {
                            const motivation = r.reason === 'replacement'
                                ? 'Stack is in a paused fail state and change includes a replacement which cannot be deployed with "--no-rollback"'
                                : 'Stack is in a paused fail state and command line arguments do not include "--no-rollback"';
                            if (options.force) {
                                (0, logging_1.warning)(`${motivation}. Rolling back first (--force).`);
                            }
                            else {
                                await askUserConfirmation(concurrency, motivation, `${motivation}. Roll back first and then proceed with deployment`);
                            }
                            // Perform a rollback
                            await this.rollback({
                                selector: { patterns: [stack.hierarchicalId] },
                                toolkitStackName: options.toolkitStackName,
                                force: options.force,
                            });
                            // Go around through the 'while' loop again but switch rollback to true.
                            rollback = true;
                            break;
                        }
                        case 'replacement-requires-norollback': {
                            const motivation = 'Change includes a replacement which cannot be deployed with "--no-rollback"';
                            if (options.force) {
                                (0, logging_1.warning)(`${motivation}. Proceeding with regular deployment (--force).`);
                            }
                            else {
                                await askUserConfirmation(concurrency, motivation, `${motivation}. Perform a regular deployment`);
                            }
                            // Go around through the 'while' loop again but switch rollback to false.
                            rollback = true;
                            break;
                        }
                        default:
                            throw new Error(`Unexpected result type from deployStack: ${JSON.stringify(r)}. If you are seeing this error, please report it at https://github.com/aws/aws-cdk/issues/new/choose`);
                    }
                }
                const message = deployResult.noOp
                    ? ' ✅  %s (no changes)'
                    : ' ✅  %s';
                (0, logging_1.success)('\n' + message, stack.displayName);
                elapsedDeployTime = new Date().getTime() - startDeployTime;
                (0, logging_1.print)('\n✨  Deployment time: %ss\n', formatTime(elapsedDeployTime));
                if (Object.keys(deployResult.outputs).length > 0) {
                    (0, logging_1.print)('Outputs:');
                    stackOutputs[stack.stackName] = deployResult.outputs;
                }
                for (const name of Object.keys(deployResult.outputs).sort()) {
                    const value = deployResult.outputs[name];
                    (0, logging_1.print)('%s.%s = %s', chalk.cyan(stack.id), chalk.cyan(name), chalk.underline(chalk.cyan(value)));
                }
                (0, logging_1.print)('Stack ARN:');
                (0, logging_1.data)(deployResult.stackArn);
            }
            catch (e) {
                // It has to be exactly this string because an integration test tests for
                // "bold(stackname) failed: ResourceNotReady: <error>"
                throw new Error([`❌  ${chalk.bold(stack.stackName)} failed:`, ...(e.name ? [`${e.name}:`] : []), e.message].join(' '));
            }
            finally {
                if (options.cloudWatchLogMonitor) {
                    const foundLogGroupsResult = await (0, find_cloudwatch_logs_1.findCloudWatchLogGroups)(this.props.sdkProvider, stack);
                    options.cloudWatchLogMonitor.addLogGroups(foundLogGroupsResult.env, foundLogGroupsResult.sdk, foundLogGroupsResult.logGroupNames);
                }
                // If an outputs file has been specified, create the file path and write stack outputs to it once.
                // Outputs are written after all stacks have been deployed. If a stack deployment fails,
                // all of the outputs from successfully deployed stacks before the failure will still be written.
                if (outputsFile) {
                    fs.ensureFileSync(outputsFile);
                    await fs.writeJson(outputsFile, stackOutputs, {
                        spaces: 2,
                        encoding: 'utf8',
                    });
                }
            }
            (0, logging_1.print)('\n✨  Total time: %ss\n', formatTime(elapsedSynthTime + elapsedDeployTime));
        };
        const assetBuildTime = options.assetBuildTime ?? AssetBuildTime.ALL_BEFORE_DEPLOY;
        const prebuildAssets = assetBuildTime === AssetBuildTime.ALL_BEFORE_DEPLOY;
        const concurrency = options.concurrency || 1;
        const progress = concurrency > 1 ? stack_activity_monitor_1.StackActivityProgress.EVENTS : options.progress;
        if (concurrency > 1 && options.progress && options.progress != stack_activity_monitor_1.StackActivityProgress.EVENTS) {
            (0, logging_1.warning)('⚠️ The --concurrency flag only supports --progress "events". Switching to "events".');
        }
        const stacksAndTheirAssetManifests = stacks.flatMap((stack) => [
            stack,
            ...stack.dependencies.filter(cxapi.AssetManifestArtifact.isAssetManifestArtifact),
        ]);
        const workGraph = new work_graph_builder_1.WorkGraphBuilder(prebuildAssets).build(stacksAndTheirAssetManifests);
        // Unless we are running with '--force', skip already published assets
        if (!options.force) {
            await this.removePublishedAssets(workGraph, options);
        }
        const graphConcurrency = {
            'stack': concurrency,
            'asset-build': 1, // This will be CPU-bound/memory bound, mostly matters for Docker builds
            'asset-publish': (options.assetParallelism ?? true) ? 8 : 1, // This will be I/O-bound, 8 in parallel seems reasonable
        };
        await workGraph.doParallel(graphConcurrency, {
            deployStack,
            buildAsset,
            publishAsset,
        });
    }
    /**
     * Roll back the given stack or stacks.
     */
    async rollback(options) {
        const startSynthTime = new Date().getTime();
        const stackCollection = await this.selectStacksForDeploy(options.selector, true);
        const elapsedSynthTime = new Date().getTime() - startSynthTime;
        (0, logging_1.print)('\n✨  Synthesis time: %ss\n', formatTime(elapsedSynthTime));
        if (stackCollection.stackCount === 0) {
            // eslint-disable-next-line no-console
            console.error('No stacks selected');
            return;
        }
        let anyRollbackable = false;
        for (const stack of stackCollection.stackArtifacts) {
            (0, logging_1.print)('Rolling back %s', chalk.bold(stack.displayName));
            const startRollbackTime = new Date().getTime();
            try {
                const result = await this.props.deployments.rollbackStack({
                    stack,
                    roleArn: options.roleArn,
                    toolkitStackName: options.toolkitStackName,
                    force: options.force,
                    validateBootstrapStackVersion: options.validateBootstrapStackVersion,
                    orphanLogicalIds: options.orphanLogicalIds,
                });
                if (!result.notInRollbackableState) {
                    anyRollbackable = true;
                }
                const elapsedRollbackTime = new Date().getTime() - startRollbackTime;
                (0, logging_1.print)('\n✨  Rollback time: %ss\n', formatTime(elapsedRollbackTime));
            }
            catch (e) {
                (0, logging_1.error)('\n ❌  %s failed: %s', chalk.bold(stack.displayName), e.message);
                throw new Error('Rollback failed (use --force to orphan failing resources)');
            }
        }
        if (!anyRollbackable) {
            throw new Error('No stacks were in a state that could be rolled back');
        }
    }
    async watch(options) {
        const rootDir = path.dirname(path.resolve(settings_1.PROJECT_CONFIG));
        (0, logging_1.debug)("root directory used for 'watch' is: %s", rootDir);
        const watchSettings = this.props.configuration.settings.get(['watch']);
        if (!watchSettings) {
            throw new Error("Cannot use the 'watch' command without specifying at least one directory to monitor. " +
                'Make sure to add a "watch" key to your cdk.json');
        }
        // For the "include" subkey under the "watch" key, the behavior is:
        // 1. No "watch" setting? We error out.
        // 2. "watch" setting without an "include" key? We default to observing "./**".
        // 3. "watch" setting with an empty "include" key? We default to observing "./**".
        // 4. Non-empty "include" key? Just use the "include" key.
        const watchIncludes = this.patternsArrayForWatch(watchSettings.include, {
            rootDir,
            returnRootDirIfEmpty: true,
        });
        (0, logging_1.debug)("'include' patterns for 'watch': %s", watchIncludes);
        // For the "exclude" subkey under the "watch" key,
        // the behavior is to add some default excludes in addition to the ones specified by the user:
        // 1. The CDK output directory.
        // 2. Any file whose name starts with a dot.
        // 3. Any directory's content whose name starts with a dot.
        // 4. Any node_modules and its content (even if it's not a JS/TS project, you might be using a local aws-cli package)
        const outputDir = this.props.configuration.settings.get(['output']);
        const watchExcludes = this.patternsArrayForWatch(watchSettings.exclude, {
            rootDir,
            returnRootDirIfEmpty: false,
        }).concat(`${outputDir}/**`, '**/.*', '**/.*/**', '**/node_modules/**');
        (0, logging_1.debug)("'exclude' patterns for 'watch': %s", watchExcludes);
        // Since 'cdk deploy' is a relatively slow operation for a 'watch' process,
        // introduce a concurrency latch that tracks the state.
        // This way, if file change events arrive when a 'cdk deploy' is still executing,
        // we will batch them, and trigger another 'cdk deploy' after the current one finishes,
        // making sure 'cdk deploy's  always execute one at a time.
        // Here's a diagram showing the state transitions:
        // --------------                --------    file changed     --------------    file changed     --------------  file changed
        // |            |  ready event   |      | ------------------> |            | ------------------> |            | --------------|
        // | pre-ready  | -------------> | open |                     | deploying  |                     |   queued   |               |
        // |            |                |      | <------------------ |            | <------------------ |            | <-------------|
        // --------------                --------  'cdk deploy' done  --------------  'cdk deploy' done  --------------
        let latch = 'pre-ready';
        const cloudWatchLogMonitor = options.traceLogs ? new logs_monitor_1.CloudWatchLogEventMonitor() : undefined;
        const deployAndWatch = async () => {
            latch = 'deploying';
            cloudWatchLogMonitor?.deactivate();
            await this.invokeDeployFromWatch(options, cloudWatchLogMonitor);
            // If latch is still 'deploying' after the 'await', that's fine,
            // but if it's 'queued', that means we need to deploy again
            while (latch === 'queued') {
                // TypeScript doesn't realize latch can change between 'awaits',
                // and thinks the above 'while' condition is always 'false' without the cast
                latch = 'deploying';
                (0, logging_1.print)("Detected file changes during deployment. Invoking 'cdk deploy' again");
                await this.invokeDeployFromWatch(options, cloudWatchLogMonitor);
            }
            latch = 'open';
            cloudWatchLogMonitor?.activate();
        };
        chokidar
            .watch(watchIncludes, {
            ignored: watchExcludes,
            cwd: rootDir,
            // ignoreInitial: true,
        })
            .on('ready', async () => {
            latch = 'open';
            (0, logging_1.debug)("'watch' received the 'ready' event. From now on, all file changes will trigger a deployment");
            (0, logging_1.print)("Triggering initial 'cdk deploy'");
            await deployAndWatch();
        })
            .on('all', async (event, filePath) => {
            if (latch === 'pre-ready') {
                (0, logging_1.print)(`'watch' is observing ${event === 'addDir' ? 'directory' : 'the file'} '%s' for changes`, filePath);
            }
            else if (latch === 'open') {
                (0, logging_1.print)("Detected change to '%s' (type: %s). Triggering 'cdk deploy'", filePath, event);
                await deployAndWatch();
            }
            else {
                // this means latch is either 'deploying' or 'queued'
                latch = 'queued';
                (0, logging_1.print)("Detected change to '%s' (type: %s) while 'cdk deploy' is still running. " +
                    'Will queue for another deployment after this one finishes', filePath, event);
            }
        });
    }
    async import(options) {
        const stacks = await this.selectStacksForDeploy(options.selector, true, true, false);
        if (stacks.stackCount > 1) {
            throw new Error(`Stack selection is ambiguous, please choose a specific stack for import [${stacks.stackArtifacts.map((x) => x.id).join(', ')}]`);
        }
        if (!process.stdout.isTTY && !options.resourceMappingFile) {
            throw new Error('--resource-mapping is required when input is not a terminal');
        }
        const stack = stacks.stackArtifacts[0];
        (0, logging_1.highlight)(stack.displayName);
        const resourceImporter = new import_1.ResourceImporter(stack, this.props.deployments);
        const { additions, hasNonAdditions } = await resourceImporter.discoverImportableResources(options.force);
        if (additions.length === 0) {
            (0, logging_1.warning)('%s: no new resources compared to the currently deployed stack, skipping import.', chalk.bold(stack.displayName));
            return;
        }
        // Prepare a mapping of physical resources to CDK constructs
        const actualImport = !options.resourceMappingFile
            ? await resourceImporter.askForResourceIdentifiers(additions)
            : await resourceImporter.loadResourceIdentifiers(additions, options.resourceMappingFile);
        if (actualImport.importResources.length === 0) {
            (0, logging_1.warning)('No resources selected for import.');
            return;
        }
        // If "--create-resource-mapping" option was passed, write the resource mapping to the given file and exit
        if (options.recordResourceMapping) {
            const outputFile = options.recordResourceMapping;
            fs.ensureFileSync(outputFile);
            await fs.writeJson(outputFile, actualImport.resourceMap, {
                spaces: 2,
                encoding: 'utf8',
            });
            (0, logging_1.print)('%s: mapping file written.', outputFile);
            return;
        }
        // Import the resources according to the given mapping
        (0, logging_1.print)('%s: importing resources into stack...', chalk.bold(stack.displayName));
        const tags = tagsForStack(stack);
        await resourceImporter.importResourcesFromMap(actualImport, {
            roleArn: options.roleArn,
            toolkitStackName: options.toolkitStackName,
            tags,
            deploymentMethod: options.deploymentMethod,
            usePreviousParameters: true,
            progress: options.progress,
            rollback: options.rollback,
        });
        // Notify user of next steps
        (0, logging_1.print)(`Import operation complete. We recommend you run a ${chalk.blueBright('drift detection')} operation ` +
            'to confirm your CDK app resource definitions are up-to-date. Read more here: ' +
            chalk.underline.blueBright('https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/detect-drift-stack.html'));
        if (actualImport.importResources.length < additions.length) {
            (0, logging_1.print)('');
            (0, logging_1.warning)(`Some resources were skipped. Run another ${chalk.blueBright('cdk import')} or a ${chalk.blueBright('cdk deploy')} to bring the stack up-to-date with your CDK app definition.`);
        }
        else if (hasNonAdditions) {
            (0, logging_1.print)('');
            (0, logging_1.warning)(`Your app has pending updates or deletes excluded from this import operation. Run a ${chalk.blueBright('cdk deploy')} to bring the stack up-to-date with your CDK app definition.`);
        }
    }
    async destroy(options) {
        let stacks = await this.selectStacksForDestroy(options.selector, options.exclusively);
        // The stacks will have been ordered for deployment, so reverse them for deletion.
        stacks = stacks.reversed();
        if (!options.force) {
            // eslint-disable-next-line max-len
            const confirmed = await promptly.confirm(`Are you sure you want to delete: ${chalk.blue(stacks.stackArtifacts.map((s) => s.hierarchicalId).join(', '))} (y/n)?`);
            if (!confirmed) {
                return;
            }
        }
        const action = options.fromDeploy ? 'deploy' : 'destroy';
        for (const [index, stack] of stacks.stackArtifacts.entries()) {
            (0, logging_1.success)('%s: destroying... [%s/%s]', chalk.blue(stack.displayName), index + 1, stacks.stackCount);
            try {
                await this.props.deployments.destroyStack({
                    stack,
                    deployName: stack.stackName,
                    roleArn: options.roleArn,
                    ci: options.ci,
                });
                (0, logging_1.success)(`\n ✅  %s: ${action}ed`, chalk.blue(stack.displayName));
            }
            catch (e) {
                (0, logging_1.error)(`\n ❌  %s: ${action} failed`, chalk.blue(stack.displayName), e);
                throw e;
            }
        }
    }
    async list(selectors, options = {}) {
        const stacks = await (0, list_stacks_1.listStacks)(this, {
            selectors: selectors,
        });
        if (options.long && options.showDeps) {
            printSerializedObject(stacks, options.json ?? false);
            return 0;
        }
        if (options.showDeps) {
            const stackDeps = [];
            for (const stack of stacks) {
                stackDeps.push({
                    id: stack.id,
                    dependencies: stack.dependencies,
                });
            }
            printSerializedObject(stackDeps, options.json ?? false);
            return 0;
        }
        if (options.long) {
            const long = [];
            for (const stack of stacks) {
                long.push({
                    id: stack.id,
                    name: stack.name,
                    environment: stack.environment,
                });
            }
            printSerializedObject(long, options.json ?? false);
            return 0;
        }
        // just print stack IDs
        for (const stack of stacks) {
            (0, logging_1.data)(stack.id);
        }
        return 0; // exit-code
    }
    /**
     * Synthesize the given set of stacks (called when the user runs 'cdk synth')
     *
     * INPUT: Stack names can be supplied using a glob filter. If no stacks are
     * given, all stacks from the application are implicitly selected.
     *
     * OUTPUT: If more than one stack ends up being selected, an output directory
     * should be supplied, where the templates will be written.
     */
    async synth(stackNames, exclusively, quiet, autoValidate, json) {
        const stacks = await this.selectStacksForDiff(stackNames, exclusively, autoValidate);
        // if we have a single stack, print it to STDOUT
        if (stacks.stackCount === 1) {
            if (!quiet) {
                printSerializedObject(obscureTemplate(stacks.firstStack.template), json ?? false);
            }
            return undefined;
        }
        // This is a slight hack; in integ mode we allow multiple stacks to be synthesized to stdout sequentially.
        // This is to make it so that we can support multi-stack integ test expectations, without so drastically
        // having to change the synthesis format that we have to rerun all integ tests.
        //
        // Because this feature is not useful to consumers (the output is missing
        // the stack names), it's not exposed as a CLI flag. Instead, it's hidden
        // behind an environment variable.
        const isIntegMode = process.env.CDK_INTEG_MODE === '1';
        if (isIntegMode) {
            printSerializedObject(stacks.stackArtifacts.map((s) => obscureTemplate(s.template)), json ?? false);
        }
        // not outputting template to stdout, let's explain things to the user a little bit...
        (0, logging_1.success)(`Successfully synthesized to ${chalk.blue(path.resolve(stacks.assembly.directory))}`);
        (0, logging_1.print)(`Supply a stack id (${stacks.stackArtifacts.map((s) => chalk.green(s.hierarchicalId)).join(', ')}) to display its template.`);
        return undefined;
    }
    /**
     * Bootstrap the CDK Toolkit stack in the accounts used by the specified stack(s).
     *
     * @param userEnvironmentSpecs environment names that need to have toolkit support
     *             provisioned, as a glob filter. If none is provided, all stacks are implicitly selected.
     * @param bootstrapper Legacy or modern.
     * @param options The name, role ARN, bootstrapping parameters, etc. to be used for the CDK Toolkit stack.
     */
    async bootstrap(userEnvironmentSpecs, bootstrapper, options) {
        // If there is an '--app' argument and an environment looks like a glob, we
        // select the environments from the app. Otherwise, use what the user said.
        const environments = await this.defineEnvironments(userEnvironmentSpecs);
        const limit = pLimit(20);
        // eslint-disable-next-line @cdklabs/promiseall-no-unbounded-parallelism
        await Promise.all(environments.map((environment) => limit(async () => {
            (0, logging_1.success)(' ⏳  Bootstrapping environment %s...', chalk.blue(environment.name));
            try {
                const result = await bootstrapper.bootstrapEnvironment(environment, this.props.sdkProvider, options);
                const message = result.noOp
                    ? ' ✅  Environment %s bootstrapped (no changes).'
                    : ' ✅  Environment %s bootstrapped.';
                (0, logging_1.success)(message, chalk.blue(environment.name));
            }
            catch (e) {
                (0, logging_1.error)(' ❌  Environment %s failed bootstrapping: %s', chalk.blue(environment.name), e);
                throw e;
            }
        })));
    }
    /**
     * Garbage collects assets from a CDK app's environment
     * @param options Options for Garbage Collection
     */
    async garbageCollect(userEnvironmentSpecs, options) {
        const environments = await this.defineEnvironments(userEnvironmentSpecs);
        for (const environment of environments) {
            (0, logging_1.success)(' ⏳  Garbage Collecting environment %s...', chalk.blue(environment.name));
            const gc = new garbage_collector_1.GarbageCollector({
                sdkProvider: this.props.sdkProvider,
                resolvedEnvironment: environment,
                bootstrapStackName: options.bootstrapStackName,
                rollbackBufferDays: options.rollbackBufferDays,
                createdBufferDays: options.createdBufferDays,
                action: options.action ?? 'full',
                type: options.type ?? 'all',
                confirm: options.confirm ?? true,
            });
            await gc.garbageCollect();
        }
        ;
    }
    async defineEnvironments(userEnvironmentSpecs) {
        // By default, glob for everything
        const environmentSpecs = userEnvironmentSpecs.length > 0 ? [...userEnvironmentSpecs] : ['**'];
        // Partition into globs and non-globs (this will mutate environmentSpecs).
        const globSpecs = (0, util_2.partition)(environmentSpecs, environments_1.looksLikeGlob);
        if (globSpecs.length > 0 && !this.props.cloudExecutable.hasApp) {
            if (userEnvironmentSpecs.length > 0) {
                // User did request this glob
                throw new Error(`'${globSpecs}' is not an environment name. Specify an environment name like 'aws://123456789012/us-east-1', or run in a directory with 'cdk.json' to use wildcards.`);
            }
            else {
                // User did not request anything
                throw new Error("Specify an environment name like 'aws://123456789012/us-east-1', or run in a directory with 'cdk.json'.");
            }
        }
        const environments = [...(0, environments_1.environmentsFromDescriptors)(environmentSpecs)];
        // If there is an '--app' argument, select the environments from the app.
        if (this.props.cloudExecutable.hasApp) {
            environments.push(...(await (0, environments_1.globEnvironmentsFromStacks)(await this.selectStacksForList([]), globSpecs, this.props.sdkProvider)));
        }
        return environments;
    }
    /**
     * Migrates a CloudFormation stack/template to a CDK app
     * @param options Options for CDK app creation
     */
    async migrate(options) {
        (0, logging_1.warning)('This command is an experimental feature.');
        const language = options.language?.toLowerCase() ?? 'typescript';
        const environment = (0, migrate_1.setEnvironment)(options.account, options.region);
        let generateTemplateOutput;
        let cfn;
        let templateToDelete;
        try {
            // if neither fromPath nor fromStack is provided, generate a template using cloudformation
            const scanType = (0, migrate_1.parseSourceOptions)(options.fromPath, options.fromStack, options.stackName).source;
            if (scanType == migrate_1.TemplateSourceOptions.SCAN) {
                generateTemplateOutput = await (0, migrate_1.generateTemplate)({
                    stackName: options.stackName,
                    filters: options.filter,
                    fromScan: options.fromScan,
                    sdkProvider: this.props.sdkProvider,
                    environment: environment,
                });
                templateToDelete = generateTemplateOutput.templateId;
            }
            else if (scanType == migrate_1.TemplateSourceOptions.PATH) {
                const templateBody = (0, migrate_1.readFromPath)(options.fromPath);
                const parsedTemplate = (0, serialize_1.deserializeStructure)(templateBody);
                const templateId = parsedTemplate.Metadata?.TemplateId?.toString();
                if (templateId) {
                    // if we have a template id, we can call describe generated template to get the resource identifiers
                    // resource metadata, and template source to generate the template
                    cfn = new migrate_1.CfnTemplateGeneratorProvider(await (0, migrate_1.buildCfnClient)(this.props.sdkProvider, environment));
                    const generatedTemplateSummary = await cfn.describeGeneratedTemplate(templateId);
                    generateTemplateOutput = (0, migrate_1.buildGenertedTemplateOutput)(generatedTemplateSummary, templateBody, generatedTemplateSummary.GeneratedTemplateId);
                }
                else {
                    generateTemplateOutput = {
                        migrateJson: {
                            templateBody: templateBody,
                            source: 'localfile',
                        },
                    };
                }
            }
            else if (scanType == migrate_1.TemplateSourceOptions.STACK) {
                const template = await (0, migrate_1.readFromStack)(options.stackName, this.props.sdkProvider, environment);
                if (!template) {
                    throw new Error(`No template found for stack-name: ${options.stackName}`);
                }
                generateTemplateOutput = {
                    migrateJson: {
                        templateBody: template,
                        source: options.stackName,
                    },
                };
            }
            else {
                // We shouldn't ever get here, but just in case.
                throw new Error(`Invalid source option provided: ${scanType}`);
            }
            const stack = (0, migrate_1.generateStack)(generateTemplateOutput.migrateJson.templateBody, options.stackName, language);
            (0, logging_1.success)(' ⏳  Generating CDK app for %s...', chalk.blue(options.stackName));
            await (0, migrate_1.generateCdkApp)(options.stackName, stack, language, options.outputPath, options.compress);
            if (generateTemplateOutput) {
                (0, migrate_1.writeMigrateJsonFile)(options.outputPath, options.stackName, generateTemplateOutput.migrateJson);
            }
            if ((0, migrate_1.isThereAWarning)(generateTemplateOutput)) {
                (0, logging_1.warning)(' ⚠️  Some resources could not be migrated completely. Please review the README.md file for more information.');
                (0, migrate_1.appendWarningsToReadme)(`${path.join(options.outputPath ?? process.cwd(), options.stackName)}/README.md`, generateTemplateOutput.resources);
            }
        }
        catch (e) {
            (0, logging_1.error)(' ❌  Migrate failed for `%s`: %s', options.stackName, e.message);
            throw e;
        }
        finally {
            if (templateToDelete) {
                if (!cfn) {
                    cfn = new migrate_1.CfnTemplateGeneratorProvider(await (0, migrate_1.buildCfnClient)(this.props.sdkProvider, environment));
                }
                if (!process.env.MIGRATE_INTEG_TEST) {
                    await cfn.deleteGeneratedTemplate(templateToDelete);
                }
            }
        }
    }
    async selectStacksForList(patterns) {
        const assembly = await this.assembly();
        const stacks = await assembly.selectStacks({ patterns }, { defaultBehavior: cloud_assembly_1.DefaultSelection.AllStacks });
        // No validation
        return stacks;
    }
    async selectStacksForDeploy(selector, exclusively, cacheCloudAssembly, ignoreNoStacks) {
        const assembly = await this.assembly(cacheCloudAssembly);
        const stacks = await assembly.selectStacks(selector, {
            extend: exclusively ? cloud_assembly_1.ExtendedStackSelection.None : cloud_assembly_1.ExtendedStackSelection.Upstream,
            defaultBehavior: cloud_assembly_1.DefaultSelection.OnlySingle,
            ignoreNoStacks,
        });
        this.validateStacksSelected(stacks, selector.patterns);
        this.validateStacks(stacks);
        return stacks;
    }
    async selectStacksForDiff(stackNames, exclusively, autoValidate) {
        const assembly = await this.assembly();
        const selectedForDiff = await assembly.selectStacks({ patterns: stackNames }, {
            extend: exclusively ? cloud_assembly_1.ExtendedStackSelection.None : cloud_assembly_1.ExtendedStackSelection.Upstream,
            defaultBehavior: cloud_assembly_1.DefaultSelection.MainAssembly,
        });
        const allStacks = await this.selectStacksForList([]);
        const autoValidateStacks = autoValidate
            ? allStacks.filter((art) => art.validateOnSynth ?? false)
            : new cloud_assembly_1.StackCollection(assembly, []);
        this.validateStacksSelected(selectedForDiff.concat(autoValidateStacks), stackNames);
        this.validateStacks(selectedForDiff.concat(autoValidateStacks));
        return selectedForDiff;
    }
    async selectStacksForDestroy(selector, exclusively) {
        const assembly = await this.assembly();
        const stacks = await assembly.selectStacks(selector, {
            extend: exclusively ? cloud_assembly_1.ExtendedStackSelection.None : cloud_assembly_1.ExtendedStackSelection.Downstream,
            defaultBehavior: cloud_assembly_1.DefaultSelection.OnlySingle,
        });
        // No validation
        return stacks;
    }
    /**
     * Validate the stacks for errors and warnings according to the CLI's current settings
     */
    validateStacks(stacks) {
        stacks.processMetadataMessages({
            ignoreErrors: this.props.ignoreErrors,
            strict: this.props.strict,
            verbose: this.props.verbose,
        });
    }
    /**
     * Validate that if a user specified a stack name there exists at least 1 stack selected
     */
    validateStacksSelected(stacks, stackNames) {
        if (stackNames.length != 0 && stacks.stackCount == 0) {
            throw new Error(`No stacks match the name(s) ${stackNames}`);
        }
    }
    /**
     * Select a single stack by its name
     */
    async selectSingleStackByName(stackName) {
        const assembly = await this.assembly();
        const stacks = await assembly.selectStacks({ patterns: [stackName] }, {
            extend: cloud_assembly_1.ExtendedStackSelection.None,
            defaultBehavior: cloud_assembly_1.DefaultSelection.None,
        });
        // Could have been a glob so check that we evaluated to exactly one
        if (stacks.stackCount > 1) {
            throw new Error(`This command requires exactly one stack and we matched more than one: ${stacks.stackIds}`);
        }
        return assembly.stackById(stacks.firstStack.id);
    }
    assembly(cacheCloudAssembly) {
        return this.props.cloudExecutable.synthesize(cacheCloudAssembly);
    }
    patternsArrayForWatch(patterns, options) {
        const patternsArray = patterns !== undefined ? (Array.isArray(patterns) ? patterns : [patterns]) : [];
        return patternsArray.length > 0 ? patternsArray : options.returnRootDirIfEmpty ? [options.rootDir] : [];
    }
    async invokeDeployFromWatch(options, cloudWatchLogMonitor) {
        const deployOptions = {
            ...options,
            requireApproval: diff_1.RequireApproval.Never,
            // if 'watch' is called by invoking 'cdk deploy --watch',
            // we need to make sure to not call 'deploy' with 'watch' again,
            // as that would lead to a cycle
            watch: false,
            cloudWatchLogMonitor,
            cacheCloudAssembly: false,
            hotswap: options.hotswap,
            extraUserAgent: `cdk-watch/hotswap-${options.hotswap !== common_1.HotswapMode.FALL_BACK ? 'on' : 'off'}`,
            concurrency: options.concurrency,
        };
        try {
            await this.deploy(deployOptions);
        }
        catch {
            // just continue - deploy will show the error
        }
    }
    /**
     * Remove the asset publishing and building from the work graph for assets that are already in place
     */
    async removePublishedAssets(graph, options) {
        await graph.removeUnnecessaryAssets(assetNode => this.props.deployments.isSingleAssetPublished(assetNode.assetManifest, assetNode.asset, {
            stack: assetNode.parentStack,
            roleArn: options.roleArn,
            stackName: assetNode.parentStack.stackName,
        }));
    }
    /**
     * Checks to see if a migrate.json file exists. If it does and the source is either `filepath` or
     * is in the same environment as the stack deployment, a new stack is created and the resources are
     * migrated to the stack using an IMPORT changeset. The normal deployment will resume after this is complete
     * to add back in any outputs and the CDKMetadata.
     */
    async tryMigrateResources(stacks, options) {
        const stack = stacks.stackArtifacts[0];
        const migrateDeployment = new import_1.ResourceImporter(stack, this.props.deployments);
        const resourcesToImport = await this.tryGetResources(await migrateDeployment.resolveEnvironment());
        if (resourcesToImport) {
            (0, logging_1.print)('%s: creating stack for resource migration...', chalk.bold(stack.displayName));
            (0, logging_1.print)('%s: importing resources into stack...', chalk.bold(stack.displayName));
            await this.performResourceMigration(migrateDeployment, resourcesToImport, options);
            fs.rmSync('migrate.json');
            (0, logging_1.print)('%s: applying CDKMetadata and Outputs to stack (if applicable)...', chalk.bold(stack.displayName));
        }
    }
    /**
     * Creates a new stack with just the resources to be migrated
     */
    async performResourceMigration(migrateDeployment, resourcesToImport, options) {
        const startDeployTime = new Date().getTime();
        let elapsedDeployTime = 0;
        // Initial Deployment
        await migrateDeployment.importResourcesFromMigrate(resourcesToImport, {
            roleArn: options.roleArn,
            toolkitStackName: options.toolkitStackName,
            deploymentMethod: options.deploymentMethod,
            usePreviousParameters: true,
            progress: options.progress,
            rollback: options.rollback,
        });
        elapsedDeployTime = new Date().getTime() - startDeployTime;
        (0, logging_1.print)('\n✨  Resource migration time: %ss\n', formatTime(elapsedDeployTime));
    }
    async tryGetResources(environment) {
        try {
            const migrateFile = fs.readJsonSync('migrate.json', {
                encoding: 'utf-8',
            });
            const sourceEnv = migrateFile.Source.split(':');
            if (sourceEnv[0] === 'localfile' ||
                (sourceEnv[4] === environment.account && sourceEnv[3] === environment.region)) {
                return migrateFile.Resources;
            }
        }
        catch (e) {
            // Nothing to do
        }
        return undefined;
    }
}
exports.CdkToolkit = CdkToolkit;
/**
 * Print a serialized object (YAML or JSON) to stdout.
 */
function printSerializedObject(obj, json) {
    (0, logging_1.data)((0, serialize_1.serializeStructure)(obj, json));
}
/**
 * @returns an array with the tags available in the stack metadata.
 */
function tagsForStack(stack) {
    return Object.entries(stack.tags).map(([Key, Value]) => ({ Key, Value }));
}
/**
 * Formats time in milliseconds (which we get from 'Date.getTime()')
 * to a human-readable time; returns time in seconds rounded to 2
 * decimal places.
 */
function formatTime(num) {
    return roundPercentage(millisecondsToSeconds(num));
}
/**
 * Rounds a decimal number to two decimal points.
 * The function is useful for fractions that need to be outputted as percentages.
 */
function roundPercentage(num) {
    return Math.round(100 * num) / 100;
}
/**
 * Given a time in milliseconds, return an equivalent amount in seconds.
 */
function millisecondsToSeconds(num) {
    return num / 1000;
}
function buildParameterMap(parameters) {
    const parameterMap = { '*': {} };
    for (const key in parameters) {
        if (parameters.hasOwnProperty(key)) {
            const [stack, parameter] = key.split(':', 2);
            if (!parameter) {
                parameterMap['*'][stack] = parameters[key];
            }
            else {
                if (!parameterMap[stack]) {
                    parameterMap[stack] = {};
                }
                parameterMap[stack][parameter] = parameters[key];
            }
        }
    }
    return parameterMap;
}
/**
 * Remove any template elements that we don't want to show users.
 */
function obscureTemplate(template = {}) {
    if (template.Rules) {
        // see https://github.com/aws/aws-cdk/issues/17942
        if (template.Rules.CheckBootstrapVersion) {
            if (Object.keys(template.Rules).length > 1) {
                delete template.Rules.CheckBootstrapVersion;
            }
            else {
                delete template.Rules;
            }
        }
    }
    return template;
}
/**
 * Ask the user for a yes/no confirmation
 *
 * Automatically fail the confirmation in case we're in a situation where the confirmation
 * cannot be interactively obtained from a human at the keyboard.
 */
async function askUserConfirmation(concurrency, motivation, question) {
    await (0, logging_1.withCorkedLogging)(async () => {
        // only talk to user if STDIN is a terminal (otherwise, fail)
        if (!TESTING && !process.stdin.isTTY) {
            throw new Error(`${motivation}, but terminal (TTY) is not attached so we are unable to get a confirmation from the user`);
        }
        // only talk to user if concurrency is 1 (otherwise, fail)
        if (concurrency > 1) {
            throw new Error(`${motivation}, but concurrency is greater than 1 so we are unable to get a confirmation from the user`);
        }
        const confirmed = await promptly.confirm(`${chalk.cyan(question)} (y/n)?`);
        if (!confirmed) {
            throw new Error('Aborted by user');
        }
    });
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiY2RrLXRvb2xraXQuanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyJjZGstdG9vbGtpdC50cyJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiOzs7QUErREEsa0NBRUM7QUFqRUQsNkJBQTZCO0FBQzdCLCtCQUE4QjtBQUM5Qix5Q0FBeUM7QUFDekMsK0JBQStCO0FBQy9CLHFDQUFxQztBQUNyQywrQkFBK0I7QUFDL0IscUNBQXFDO0FBQ3JDLDZCQUE2QjtBQUk3QiwrREFNb0M7QUFHcEMsa0ZBQThFO0FBQzlFLGlEQUFtRztBQUNuRywwRUFBMEU7QUFDMUUsMERBQW9FO0FBQ3BFLDhEQUFtRjtBQUNuRiw2RkFBeUY7QUFDekYsZ0RBaUI0QjtBQUM1QixpQ0FBNEU7QUFDNUUscUNBQXNFO0FBQ3RFLCtDQUEyQztBQUMzQyx1Q0FBc0c7QUFDdEcsMkNBQXVFO0FBQ3ZFLHlDQUEyRDtBQUMzRCxpQ0FBbUQ7QUFDbkQsZ0ZBQXVFO0FBRXZFLGtFQUE2RDtBQUU3RCxnRUFBdUg7QUFFdkgsNkVBQTZFO0FBQzdFLGlFQUFpRTtBQUNqRSxNQUFNLE1BQU0sR0FBNkIsT0FBTyxDQUFDLFNBQVMsQ0FBQyxDQUFDO0FBRTVELElBQUksT0FBTyxHQUFHLEtBQUssQ0FBQztBQUVwQixTQUFnQixXQUFXO0lBQ3pCLE9BQU8sR0FBRyxJQUFJLENBQUM7QUFDakIsQ0FBQztBQTZDRDs7R0FFRztBQUNILElBQVksY0FhWDtBQWJELFdBQVksY0FBYztJQUN4Qjs7Ozs7T0FLRztJQUNILDZFQUFpQixDQUFBO0lBRWpCOztPQUVHO0lBQ0gsbUVBQVksQ0FBQTtBQUNkLENBQUMsRUFiVyxjQUFjLDhCQUFkLGNBQWMsUUFhekI7QUFFRDs7Ozs7R0FLRztBQUNILE1BQWEsVUFBVTtJQUNyQixZQUE2QixLQUFzQjtRQUF0QixVQUFLLEdBQUwsS0FBSyxDQUFpQjtJQUFHLENBQUM7SUFFaEQsS0FBSyxDQUFDLFFBQVEsQ0FBQyxTQUFpQixFQUFFLElBQWE7UUFDcEQsTUFBTSxNQUFNLEdB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QUFDLFFBQVEsQ0FBQyxLQUFLLENBQUMsQ0FBQyxNQUFNLEdBQUcsQ0FBQyxFQUFFLENBQUM7Z0JBQzNDLE9BQU8sUUFBUSxDQUFDLEtBQUssQ0FBQyxxQkFBcUIsQ0FBQztZQUM5QyxDQUFDO2lCQUFNLENBQUM7Z0JBQ04sT0FBTyxRQUFRLENBQUMsS0FBSyxDQUFDO1lBQ3hCLENBQUM7UUFDSCxDQUFDO0lBQ0gsQ0FBQztJQUVELE9BQU8sUUFBUSxDQUFDO0FBQ2xCLENBQUM7QUFFRDs7Ozs7R0FLRztBQUNILEtBQUssVUFBVSxtQkFBbUIsQ0FDaEMsV0FBbUIsRUFDbkIsVUFBa0IsRUFDbEIsUUFBZ0I7SUFFaEIsTUFBTSxJQUFBLDJCQUFpQixFQUFDLEtBQUssSUFBSSxFQUFFO1FBQ2pDLDZEQUE2RDtRQUM3RCxJQUFJLENBQUMsT0FBTyxJQUFJLENBQUMsT0FBTyxDQUFDLEtBQUssQ0FBQyxLQUFLLEVBQUUsQ0FBQztZQUNyQyxNQUFNLElBQUksS0FBSyxDQUFDLEdBQUcsVUFBVSwyRkFBMkYsQ0FBQyxDQUFDO1FBQzVILENBQUM7UUFFRCwwREFBMEQ7UUFDMUQsSUFBSSxXQUFXLEdBQUcsQ0FBQyxFQUFFLENBQUM7WUFDcEIsTUFBTSxJQUFJLEtBQUssQ0FBQyxHQUFHLFVBQVUsMEZBQTBGLENBQUMsQ0FBQztRQUMzSCxDQUFDO1FBRUQsTUFBTSxTQUFTLEdBQUcsTUFBTSxRQUFRLENBQUMsT0FBTyxDQUFDLEdBQUcsS0FBSyxDQUFDLElBQUksQ0FBQyxRQUFRLENBQUMsU0FBUyxDQUFDLENBQUM7UUFDM0UsSUFBSSxDQUFDLFNBQVMsRUFBRSxDQUFDO1lBQUMsTUFBTSxJQUFJLEtBQUssQ0FBQyxpQkFBaUIsQ0FBQyxDQUFDO1FBQUMsQ0FBQztJQUN6RCxDQUFDLENBQUMsQ0FBQztBQUNMLENBQUMiLCJzb3VyY2VzQ29udGVudCI6WyJpbXBvcnQgKiBhcyBwYXRoIGZyb20gJ3BhdGgnO1xuaW1wb3J0IHsgZm9ybWF0IH0gZnJvbSAndXRpbCc7XG5pbXBvcnQgKiBhcyBjeGFwaSBmcm9tICdAYXdzLWNkay9jeC1hcGknO1xuaW1wb3J0ICogYXMgY2hhbGsgZnJvbSAnY2hhbGsnO1xuaW1wb3J0ICogYXMgY2hva2lkYXIgZnJvbSAnY2hva2lkYXInO1xuaW1wb3J0ICogYXMgZnMgZnJvbSAnZnMtZXh0cmEnO1xuaW1wb3J0ICogYXMgcHJvbXB0bHkgZnJvbSAncHJvbXB0bHknO1xuaW1wb3J0ICogYXMgdXVpZCBmcm9tICd1dWlkJztcbmltcG9ydCB7IERlcGxveW1lbnRNZXRob2QsIFN1Y2Nlc3NmdWxEZXBsb3lTdGFja1Jlc3VsdCB9IGZyb20gJy4vYXBpJztcbmltcG9ydCB7IFNka1Byb3ZpZGVyIH0gZnJvbSAnLi9hcGkvYXdzLWF1dGgnO1xuaW1wb3J0IHsgQm9vdHN0cmFwcGVyLCBCb290c3RyYXBFbnZpcm9ubWVudE9wdGlvbnMgfSBmcm9tICcuL2FwaS9ib290c3RyYXAnO1xuaW1wb3J0IHtcbiAgQ2xvdWRBc3NlbWJseSxcbiAgRGVmYXVsdFNlbGVjdGlvbixcbiAgRXh0ZW5kZWRTdGFja1NlbGVjdGlvbixcbiAgU3RhY2tDb2xsZWN0aW9uLFxuICBTdGFja1NlbGVjdG9yLFxufSBmcm9tICcuL2FwaS9jeGFwcC9jbG91ZC1hc3NlbWJseSc7XG5pbXBvcnQgeyBDbG91ZEV4ZWN1dGFibGUgfSBmcm9tICcuL2FwaS9jeGFwcC9jbG91ZC1leGVjdXRhYmxlJztcbmltcG9ydCB7IERlcGxveW1lbnRzIH0gZnJvbSAnLi9hcGkvZGVwbG95bWVudHMnO1xuaW1wb3J0IHsgR2FyYmFnZUNvbGxlY3RvciB9IGZyb20gJy4vYXBpL2dhcmJhZ2UtY29sbGVjdGlvbi9nYXJiYWdlLWNvbGxlY3Rvcic7XG5pbXBvcnQgeyBIb3Rzd2FwTW9kZSwgSG90c3dhcFByb3BlcnR5T3ZlcnJpZGVzLCBFY3NIb3Rzd2FwUHJvcGVydGllcyB9IGZyb20gJy4vYXBpL2hvdHN3YXAvY29tbW9uJztcbmltcG9ydCB7IGZpbmRDbG91ZFdhdGNoTG9nR3JvdXBzIH0gZnJvbSAnLi9hcGkvbG9ncy9maW5kLWNsb3Vkd2F0Y2gtbG9ncyc7XG5pbXBvcnQgeyBDbG91ZFdhdGNoTG9nRXZlbnRNb25pdG9yIH0gZnJvbSAnLi9hcGkvbG9ncy9sb2dzLW1vbml0b3InO1xuaW1wb3J0IHsgY3JlYXRlRGlmZkNoYW5nZVNldCwgUmVzb3VyY2VzVG9JbXBvcnQgfSBmcm9tICcuL2FwaS91dGlsL2Nsb3VkZm9ybWF0aW9uJztcbmltcG9ydCB7IFN0YWNrQWN0aXZpdHlQcm9ncmVzcyB9IGZyb20gJy4vYXBpL3V0aWwvY2xvdWRmb3JtYXRpb24vc3RhY2stYWN0aXZpdHktbW9uaXRvcic7XG5pbXBvcnQge1xuICBnZW5lcmF0ZUNka0FwcCxcbiAgZ2VuZXJhdGVTdGFjayxcbiAgcmVhZEZyb21QYXRoLFxuICByZWFkRnJvbVN0YWNrLFxuICBzZXRFbnZpcm9ubWVudCxcbiAgcGFyc2VTb3VyY2VPcHRpb25zLFxuICBnZW5lcmF0ZVRlbXBsYXRlLFxuICBGcm9tU2NhbixcbiAgVGVtcGxhdGVTb3VyY2VPcHRpb25zLFxuICBHZW5lcmF0ZVRlbXBsYXRlT3V0cHV0LFxuICBDZm5UZW1wbGF0ZUdlbmVyYXRvclByb3ZpZGVyLFxuICB3cml0ZU1pZ3JhdGVKc29uRmlsZSxcbiAgYnVpbGRHZW5lcnRlZFRlbXBsYXRlT3V0cHV0LFxuICBhcHBlbmRXYXJuaW5nc1RvUmVhZG1lLFxuICBpc1RoZXJlQVdhcm5pbmcsXG4gIGJ1aWxkQ2ZuQ2xpZW50LFxufSBmcm9tICcuL2NvbW1hbmRzL21pZ3JhdGUnO1xuaW1wb3J0IHsgcHJpbnRTZWN1cml0eURpZmYsIHByaW50U3RhY2tEaWZmLCBSZXF1aXJlQXBwcm92YWwgfSBmcm9tICcuL2RpZmYnO1xuaW1wb3J0IHsgUmVzb3VyY2VJbXBvcnRlciwgcmVtb3ZlTm9uSW1wb3J0UmVzb3VyY2VzIH0gZnJvbSAnLi9pbXBvcnQnO1xuaW1wb3J0IHsgbGlzdFN0YWNrcyB9IGZyb20gJy4vbGlzdC1zdGFja3MnO1xuaW1wb3J0IHsgZGF0YSwgZGVidWcsIGVycm9yLCBoaWdobGlnaHQsIHByaW50LCBzdWNjZXNzLCB3YXJuaW5nLCB3aXRoQ29ya2VkTG9nZ2luZyB9IGZyb20gJy4vbG9nZ2luZyc7XG5pbXBvcnQgeyBkZXNlcmlhbGl6ZVN0cnVjdHVyZSwgc2VyaWFsaXplU3RydWN0dXJlIH0gZnJvbSAnLi9zZXJpYWxpemUnO1xuaW1wb3J0IHsgQ29uZmlndXJhdGlvbiwgUFJPSkVDVF9DT05GSUcgfSBmcm9tICcuL3NldHRpbmdzJztcbmltcG9ydCB7IG51bWJlckZyb21Cb29sLCBwYXJ0aXRpb24gfSBmcm9tICcuL3V0aWwnO1xuaW1wb3J0IHsgdmFsaWRhdGVTbnNUb3BpY0FybiB9IGZyb20gJy4vdXRpbC92YWxpZGF0ZS1ub3RpZmljYXRpb24tYXJuJztcbmltcG9ydCB7IENvbmN1cnJlbmN5LCBXb3JrR3JhcGggfSBmcm9tICcuL3V0aWwvd29yay1ncmFwaCc7XG5pbXBvcnQgeyBXb3JrR3JhcGhCdWlsZGVyIH0gZnJvbSAnLi91dGlsL3dvcmstZ3JhcGgtYnVpbGRlcic7XG5pbXBvcnQgeyBBc3NldEJ1aWxkTm9kZSwgQXNzZXRQdWJsaXNoTm9kZSwgU3RhY2tOb2RlIH0gZnJvbSAnLi91dGlsL3dvcmstZ3JhcGgtdHlwZXMnO1xuaW1wb3J0IHsgZW52aXJvbm1lbnRzRnJvbURlc2NyaXB0b3JzLCBnbG9iRW52aXJvbm1lbnRzRnJvbVN0YWNrcywgbG9va3NMaWtlR2xvYiB9IGZyb20gJy4uL2xpYi9hcGkvY3hhcHAvZW52aXJvbm1lbnRzJztcblxuLy8gTXVzdCB1c2UgYSByZXF1aXJlKCkgb3RoZXJ3aXNlIGVzYnVpbGQgY29tcGxhaW5zIGFib3V0IGNhbGxpbmcgYSBuYW1lc3BhY2Vcbi8vIGVzbGludC1kaXNhYmxlLW5leHQtbGluZSBAdHlwZXNjcmlwdC1lc2xpbnQvbm8tcmVxdWlyZS1pbXBvcnRzXG5jb25zdCBwTGltaXQ6IHR5cGVvZiBpbXBvcnQoJ3AtbGltaXQnKSA9IHJlcXVpcmUoJ3AtbGltaXQnKTtcblxubGV0IFRFU1RJTkcgPSBmYWxzZTtcblxuZXhwb3J0IGZ1bmN0aW9uIG1hcmtUZXN0aW5nKCkge1xuICBURVNUSU5HID0gdHJ1ZTtcbn1cblxuZXhwb3J0IGludGVyZmFjZSBDZGtUb29sa2l0UHJvcHMge1xuICAvKipcbiAgICogVGhlIENsb3VkIEV4ZWN1dGFibGVcbiAgICovXG4gIGNsb3VkRXhlY3V0YWJsZTogQ2xvdWRFeGVjdXRhYmxlO1xuXG4gIC8qKlxuICAgKiBUaGUgcHJvdmlzaW9uaW5nIGVuZ2luZSB1c2VkIHRvIGFwcGx5IGNoYW5nZXMgdG8gdGhlIGNsb3VkXG4gICAqL1xuICBkZXBsb3ltZW50czogRGVwbG95bWVudHM7XG5cbiAgLyoqXG4gICAqIFdoZXRoZXIgdG8gYmUgdmVyYm9zZVxuICAgKlxuICAgKiBAZGVmYXVsdCBmYWxzZVxuICAgKi9cbiAgdmVyYm9zZT86IGJvb2xlYW47XG5cbiAgLyoqXG4gICAqIERvbid0IHN0b3Agb24gZXJyb3IgbWV0YWRhdGFcbiAgICpcbiAgICogQGRlZmF1bHQgZmFsc2VcbiAgICovXG4gIGlnbm9yZUVycm9ycz86IGJvb2xlYW47XG5cbiAgLyoqXG4gICAqIFRyZWF0IHdhcm5pbmdzIGluIG1ldGFkYXRhIGFzIGVycm9yc1xuICAgKlxuICAgKiBAZGVmYXVsdCBmYWxzZVxuICAgKi9cbiAgc3RyaWN0PzogYm9vbGVhbjtcblxuICAvKipcbiAgICogQXBwbGljYXRpb24gY29uZmlndXJhdGlvbiAoc2V0dGluZ3MgYW5kIGNvbnRleHQpXG4gICAqL1xuICBjb25maWd1cmF0aW9uOiBDb25maWd1cmF0aW9uO1xuXG4gIC8qKlxuICAgKiBBV1Mgb2JqZWN0ICh1c2VkIGJ5IHN5bnRoZXNpemVyIGFuZCBjb250ZXh0cHJvdmlkZXIpXG4gICAqL1xuICBzZGtQcm92aWRlcjogU2RrUHJvdmlkZXI7XG59XG5cbi8qKlxuICogV2hlbiB0byBidWlsZCBhc3NldHNcbiAqL1xuZXhwb3J0IGVudW0gQXNzZXRCdWlsZFRpbWUge1xuICAvKipcbiAgICogQnVpbGQgYWxsIGFzc2V0cyBiZWZvcmUgZGVwbG95aW5nIHRoZSBmaXJzdCBzdGFja1xuICAgKlxuICAgKiBUaGlzIGlzIGludGVuZGVkIGZvciBleHBlbnNpdmUgRG9ja2VyIGltYWdlIGJ1aWxkczsgc28gdGhhdCBpZiB0aGUgRG9ja2VyIGltYWdlIGJ1aWxkXG4gICAqIGZhaWxzLCBubyBzdGFja3MgYXJlIHVubmVjZXNzYXJpbHkgZGVwbG95ZWQgKHdpdGggdGhlIGF0dGVuZGFudCB3YWl0IHRpbWUpLlxuICAgKi9cbiAgQUxMX0JFRk9SRV9ERVBMT1ksXG5cbiAgLyoqXG4gICAqIEJ1aWxkIGFzc2V0cyBqdXN0LWluLXRpbWUsIGJlZm9yZSBwdWJsaXNoaW5nXG4gICAqL1xuICBKVVNUX0lOX1RJTUUsXG59XG5cbi8qKlxuICogVG9vbGtpdCBsb2dpY1xuICpcbiAqIFRoZSB0b29sa2l0IHJ1bnMgdGhlIGBjbG91ZEV4ZWN1dGFibGVgIHRvIG9idGFpbiBhIGNsb3VkIGFzc2VtYmx5IGFuZFxuICogZGVwbG95cyBhcHBsaWVzIHRoZW0gdG8gYGNsb3VkRm9ybWF0aW9uYC5cbiAqL1xuZXhwb3J0IGNsYXNzIENka1Rvb2xraXQge1xuICBjb25zdHJ1Y3Rvcihwcml2YXRlIHJlYWRvbmx5IHByb3BzOiBDZGtUb29sa2l0UHJvcHMpIHt9XG5cbiAgcHVibGljIGFzeW5jIG1ldGFkYXRhKHN0YWNrTmFtZTogc3RyaW5nLCBqc29uOiBib29sZWFuKSB7XG4gICAgY29uc3Qgc3RhY2tzID0gYXdhaXQgdGhpcy5zZWxlY3RTaW5nbGVTdGFja0J5TmFtZShzdGFja05hbWUpO1xuICAgIHByaW50U2VyaWFsaXplZE9iamVjdChzdGFja3MuZmlyc3RTdGFjay5tYW5pZmVzdC5tZXRhZGF0YSA/PyB7fSwganNvbik7XG4gIH1cblxuICBwdWJsaWMgYXN5bmMgYWNrbm93bGVkZ2Uobm90aWNlSWQ6IHN0cmluZykge1xuICAgIGNvbnN0IGFja3MgPSB0aGlzLnByb3BzLmNvbmZpZ3VyYXRpb24uY29udGV4dC5nZXQoJ2Fja25vd2xlZGdlZC1pc3N1ZS1udW1iZXJzJykgPz8gW107XG4gICAgYWNrcy5wdXNoKE51bWJlcihub3RpY2VJZCkpO1xuICAgIHRoaXMucHJvcHMuY29uZmlndXJhdGlvbi5jb250ZXh0LnNldCgnYWNrbm93bGVkZ2VkLWlzc3VlLW51bWJlcnMnLCBhY2tzKTtcbiAgICBhd2FpdCB0aGlzLnByb3BzLmNvbmZpZ3VyYXRpb24uc2F2ZUNvbnRleHQoKTtcbiAgfVxuXG4gIHB1YmxpYyBhc3luYyBkaWZmKG9wdGlvbnM6IERpZmZPcHRpb25zKTogUHJvbWlzZTxudW1iZXI+IHtcbiAgICBjb25zdCBzdGFja3MgPSBhd2FpdCB0aGlzLnNlbGVjdFN0YWNrc0ZvckRpZmYob3B0aW9ucy5zdGFja05hbWVzLCBvcHRpb25zLmV4Y2x1c2l2ZWx5KTtcblxuICAgIGNvbnN0IHN0cmljdCA9ICEhb3B0aW9ucy5zdHJpY3Q7XG4gICAgY29uc3QgY29udGV4dExpbmVzID0gb3B0aW9ucy5jb250ZXh0TGluZXMgfHwgMztcbiAgICBjb25zdCBzdHJlYW0gPSBvcHRpb25zLnN0cmVhbSB8fCBwcm9jZXNzLnN0ZGVycjtcbiAgICBjb25zdCBxdWlldCA9IG9wdGlvbnMucXVpZXQgfHwgZmFsc2U7XG5cbiAgICBsZXQgZGlmZnMgPSAwO1xuICAgIGNvbnN0IHBhcmFtZXRlck1hcCA9IGJ1aWxkUGFyYW1ldGVyTWFwKG9wdGlvbnMucGFyYW1ldGVycyk7XG5cbiAgICBpZiAob3B0aW9ucy50ZW1wbGF0ZVBhdGggIT09IHVuZGVmaW5lZCkge1xuICAgICAgLy8gQ29tcGFyZSBzaW5nbGUgc3RhY2sgYWdhaW5zdCBmaXhlZCB0ZW1wbGF0ZVxuICAgICAgaWYgKHN0YWNrcy5zdGFja0NvdW50ICE9PSAxKSB7XG4gICAgICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgICAgICAnQ2FuIG9ubHkgc2VsZWN0IG9uZSBzdGFjayB3aGVuIGNvbXBhcmluZyB0byBmaXhlZCB0ZW1wbGF0ZS4gVXNlIC0tZXhjbHVzaXZlbHkgdG8gYXZvaWQgc2VsZWN0aW5nIG11bHRpcGxlIHN0YWNrcy4nLFxuICAgICAgICApO1xuICAgICAgfVxuXG4gICAgICBpZiAoIShhd2FpdCBmcy5wYXRoRXhpc3RzKG9wdGlvbnMudGVtcGxhdGVQYXRoKSkpIHtcbiAgICAgICAgdGhyb3cgbmV3IEVycm9yKGBUaGVyZSBpcyBubyBmaWxlIGF0ICR7b3B0aW9ucy50ZW1wbGF0ZVBhdGh9YCk7XG4gICAgICB9XG5cbiAgICAgIGNvbnN0IHRlbXBsYXRlID0gZGVzZXJpYWxpemVTdHJ1Y3R1cmUoYXdhaXQgZnMucmVhZEZpbGUob3B0aW9ucy50ZW1wbGF0ZVBhdGgsIHsgZW5jb2Rpbmc6ICdVVEYtOCcgfSkpO1xuICAgICAgZGlmZnMgPSBvcHRpb25zLnNlY3VyaXR5T25seVxuICAgICAgICA/IG51bWJlckZyb21Cb29sKHByaW50U2VjdXJpdHlEaWZmKHRlbXBsYXRlLCBzdGFja3MuZmlyc3RTdGFjaywgUmVxdWlyZUFwcHJvdmFsLkJyb2FkZW5pbmcsIHF1aWV0KSlcbiAgICAgICAgOiBwcmludFN0YWNrRGlmZih0ZW1wbGF0ZSwgc3RhY2tzLmZpcnN0U3RhY2ssIHN0cmljdCwgY29udGV4dExpbmVzLCBxdWlldCwgdW5kZWZpbmVkLCB1bmRlZmluZWQsIGZhbHNlLCBzdHJlYW0pO1xuICAgIH0gZWxzZSB7XG4gICAgICAvLyBDb21wYXJlIE4gc3RhY2tzIGFnYWluc3QgZGVwbG95ZWQgdGVtcGxhdGVzXG4gICAgICBmb3IgKGNvbnN0IHN0YWNrIG9mIHN0YWNrcy5zdGFja0FydGlmYWN0cykge1xuICAgICAgICBjb25zdCB0ZW1wbGF0ZVdpdGhOZXN0ZWRTdGFja3MgPSBhd2FpdCB0aGlzLnByb3BzLmRlcGxveW1lbnRzLnJlYWRDdXJyZW50VGVtcGxhdGVXaXRoTmVzdGVkU3RhY2tzKFxuICAgICAgICAgIHN0YWNrLFxuICAgICAgICAgIG9wdGlvbnMuY29tcGFyZUFnYWluc3RQcm9jZXNzZWRUZW1wbGF0ZSxcbiAgICAgICAgKTtcbiAgICAgICAgY29uc3QgY3VycmVudFRlbXBsYXRlID0gdGVtcGxhdGVXaXRoTmVzdGVkU3RhY2tzLmRlcGxveWVkUm9vdFRlbXBsYXRlO1xuICAgICAgICBjb25zdCBuZXN0ZWRTdGFja3MgPSB0ZW1wbGF0ZVdpdGhOZXN0ZWRTdGFja3MubmVzdGVkU3RhY2tzO1xuXG4gICAgICAgIGNvbnN0IHJlc291cmNlc1RvSW1wb3J0ID0gYXdhaXQgdGhpcy50cnlHZXRSZXNvdXJjZXMoYXdhaXQgdGhpcy5wcm9wcy5kZXBsb3ltZW50cy5yZXNvbHZlRW52aXJvbm1lbnQoc3RhY2spKTtcbiAgICAgICAgaWYgKHJlc291cmNlc1RvSW1wb3J0KSB7XG4gICAgICAgICAgcmVtb3ZlTm9uSW1wb3J0UmVzb3VyY2VzKHN0YWNrKTtcbiAgICAgICAgfVxuXG4gICAgICAgIGxldCBjaGFuZ2VTZXQgPSB1bmRlZmluZWQ7XG5cbiAgICAgICAgaWYgKG9wdGlvbnMuY2hhbmdlU2V0KSB7XG4gICAgICAgICAgbGV0IHN0YWNrRXhpc3RzID0gZmFsc2U7XG4gICAgICAgICAgdHJ5IHtcbiAgICAgICAgICAgIHN0YWNrRXhpc3RzID0gYXdhaXQgdGhpcy5wcm9wcy5kZXBsb3ltZW50cy5zdGFja0V4aXN0cyh7XG4gICAgICAgICAgICAgIHN0YWNrLFxuICAgICAgICAgICAgICBkZXBsb3lOYW1lOiBzdGFjay5zdGFja05hbWUsXG4gICAgICAgICAgICAgIHRyeUxvb2t1cFJvbGU6IHRydWUsXG4gICAgICAgICAgICB9KTtcbiAgICAgICAgICB9IGNhdGNoIChlOiBhbnkpIHtcbiAgICAgICAgICAgIGRlYnVnKGUubWVzc2FnZSk7XG4gICAgICAgICAgICBpZiAoIXF1aWV0KSB7XG4gICAgICAgICAgICAgIHN0cmVhbS53cml0ZShcbiAgICAgICAgICAgICAgICBgQ2hlY2tpbmcgaWYgdGhlIHN0YWNrICR7c3RhY2suc3RhY2tOYW1lfSBleGlzdHMgYmVmb3JlIGNyZWF0aW5nIHRoZSBjaGFuZ2VzZXQgaGFzIGZhaWxlZCwgd2lsbCBiYXNlIHRoZSBkaWZmIG9uIHRlbXBsYXRlIGRpZmZlcmVuY2VzIChydW4gYWdhaW4gd2l0aCAtdiB0byBzZWUgdGhlIHJlYXNvbilcXG5gLFxuICAgICAgICAgICAgICApO1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgc3RhY2tFeGlzdHMgPSBmYWxzZTtcbiAgICAgICAgICB9XG5cbiAgICAgICAgICBpZiAoc3RhY2tFeGlzdHMpIHtcbiAgICAgICAgICAgIGNoYW5nZVNldCA9IGF3YWl0IGNyZWF0ZURpZmZDaGFuZ2VTZXQoe1xuICAgICAgICAgICAgICBzdGFjayxcbiAgICAgICAgICAgICAgdXVpZDogdXVpZC52NCgpLFxuICAgICAgICAgICAgICBkZXBsb3ltZW50czogdGhpcy5wcm9wcy5kZXBsb3ltZW50cyxcbiAgICAgICAgICAgICAgd2lsbEV4ZWN1dGU6IGZhbHNlLFxuICAgICAgICAgICAgICBzZGtQcm92aWRlcjogdGhpcy5wcm9wcy5zZGtQcm92aWRlcixcbiAgICAgICAgICAgICAgcGFyYW1ldGVyczogT2JqZWN0LmFzc2lnbih7fSwgcGFyYW1ldGVyTWFwWycqJ10sIHBhcmFtZXRlck1hcFtzdGFjay5zdGFja05hbWVdKSxcbiAgICAgICAgICAgICAgcmVzb3VyY2VzVG9JbXBvcnQsXG4gICAgICAgICAgICAgIHN0cmVhbSxcbiAgICAgICAgICAgIH0pO1xuICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICBkZWJ1ZyhcbiAgICAgICAgICAgICAgYHRoZSBzdGFjayAnJHtzdGFjay5zdGFja05hbWV9JyBoYXMgbm90IGJlZW4gZGVwbG95ZWQgdG8gQ2xvdWRGb3JtYXRpb24gb3IgZGVzY3JpYmVTdGFja3MgY2FsbCBmYWlsZWQsIHNraXBwaW5nIGNoYW5nZXNldCBjcmVhdGlvbi5gLFxuICAgICAgICAgICAgKTtcbiAgICAgICAgICB9XG4gICAgICAgIH1cblxuICAgICAgICBjb25zdCBzdGFja0NvdW50ID0gb3B0aW9ucy5zZWN1cml0eU9ubHlcbiAgICAgICAgICA/IG51bWJlckZyb21Cb29sKFxuICAgICAgICAgICAgcHJpbnRTZWN1cml0eURpZmYoXG4gICAgICAgICAgICAgIGN1cnJlbnRUZW1wbGF0ZSxcbiAgICAgICAgICAgICAgc3RhY2ssXG4gICAgICAgICAgICAgIFJlcXVpcmVBcHByb3ZhbC5Ccm9hZGVuaW5nLFxuICAgICAgICAgICAgICBxdWlldCxcbiAgICAgICAgICAgICAgc3RhY2suZGlzcGxheU5hbWUsXG4gICAgICAgICAgICAgIGNoYW5nZVNldCxcbiAgICAgICAgICAgICksXG4gICAgICAgICAgKVxuICAgICAgICAgIDogcHJpbnRTdGFja0RpZmYoXG4gICAgICAgICAgICBjdXJyZW50VGVtcGxhdGUsXG4gICAgICAgICAgICBzdGFjayxcbiAgICAgICAgICAgIHN0cmljdCxcbiAgICAgICAgICAgIGNvbnRleHRMaW5lcyxcbiAgICAgICAgICAgIHF1aWV0LFxuICAgICAgICAgICAgc3RhY2suZGlzcGxheU5hbWUsXG4gICAgICAgICAgICBjaGFuZ2VTZXQsXG4gICAgICAgICAgICAhIXJlc291cmNlc1RvSW1wb3J0LFxuICAgICAgICAgICAgc3RyZWFtLFxuICAgICAgICAgICAgbmVzdGVkU3RhY2tzLFxuICAgICAgICAgICk7XG5cbiAgICAgICAgZGlmZnMgKz0gc3RhY2tDb3VudDtcbiAgICAgIH1cbiAgICB9XG5cbiAgICBzdHJlYW0ud3JpdGUoZm9ybWF0KCdcXG7inKggIE51bWJlciBvZiBzdGFja3Mgd2l0aCBkaWZmZXJlbmNlczogJXNcXG4nLCBkaWZmcykpO1xuXG4gICAgcmV0dXJuIGRpZmZzICYmIG9wdGlvbnMuZmFpbCA/IDEgOiAwO1xuICB9XG5cbiAgcHVibGljIGFzeW5jIGRlcGxveShvcHRpb25zOiBEZXBsb3lPcHRpb25zKSB7XG4gICAgaWYgKG9wdGlvbnMud2F0Y2gpIHtcbiAgICAgIHJldHVybiB0aGlzLndhdGNoKG9wdGlvbnMpO1xuICAgIH1cblxuICAgIGNvbnN0IHN0YXJ0U3ludGhUaW1lID0gbmV3IERhdGUoKS5nZXRUaW1lKCk7XG4gICAgY29uc3Qgc3RhY2tDb2xsZWN0aW9uID0gYXdhaXQgdGhpcy5zZWxlY3RTdGFja3NGb3JEZXBsb3koXG4gICAgICBvcHRpb25zLnNlbGVjdG9yLFxuICAgICAgb3B0aW9ucy5leGNsdXNpdmVseSxcbiAgICAgIG9wdGlvbnMuY2FjaGVDbG91ZEFzc2VtYmx5LFxuICAgICAgb3B0aW9ucy5pZ25vcmVOb1N0YWNrcyxcbiAgICApO1xuICAgIGNvbnN0IGVsYXBzZWRTeW50aFRpbWUgPSBuZXcgRGF0ZSgpLmdldFRpbWUoKSAtIHN0YXJ0U3ludGhUaW1lO1xuICAgIHByaW50KCdcXG7inKggIFN5bnRoZXNpcyB0aW1lOiAlc3NcXG4nLCBmb3JtYXRUaW1lKGVsYXBzZWRTeW50aFRpbWUpKTtcblxuICAgIGlmIChzdGFja0NvbGxlY3Rpb24uc3RhY2tDb3VudCA9PT0gMCkge1xuICAgICAgLy8gZXNsaW50LWRpc2FibGUtbmV4dC1saW5lIG5vLWNvbnNvbGVcbiAgICAgIGNvbnNvbGUuZXJyb3IoJ1RoaXMgYXBwIGNvbnRhaW5zIG5vIHN0YWNrcycpO1xuICAgICAgcmV0dXJuO1xuICAgIH1cblxuICAgIGF3YWl0IHRoaXMudHJ5TWlncmF0ZVJlc291cmNlcyhzdGFja0NvbGxlY3Rpb24sIG9wdGlvbnMpO1xuXG4gICAgY29uc3QgcmVxdWlyZUFwcHJvdmFsID0gb3B0aW9ucy5yZXF1aXJlQXBwcm92YWwgPz8gUmVxdWlyZUFwcHJvdmFsLkJyb2FkZW5pbmc7XG5cbiAgICBjb25zdCBwYXJhbWV0ZXJNYXAgPSBidWlsZFBhcmFtZXRlck1hcChvcHRpb25zLnBhcmFtZXRlcnMpO1xuXG4gICAgaWYgKG9wdGlvbnMuaG90c3dhcCAhPT0gSG90c3dhcE1vZGUuRlVMTF9ERVBMT1lNRU5UKSB7XG4gICAgICB3YXJuaW5nKFxuICAgICAgICAn4pqg77iPIFRoZSAtLWhvdHN3YXAgYW5kIC0taG90c3dhcC1mYWxsYmFjayBmbGFncyBkZWxpYmVyYXRlbHkgaW50cm9kdWNlIENsb3VkRm9ybWF0aW9uIGRyaWZ0IHRvIHNwZWVkIHVwIGRlcGxveW1lbnRzJyxcbiAgICAgICk7XG4gICAgICB3YXJuaW5nKCfimqDvuI8gVGhleSBzaG91bGQgb25seSBiZSB1c2VkIGZvciBkZXZlbG9wbWVudCAtIG5ldmVyIHVzZSB0aGVtIGZvciB5b3VyIHByb2R1Y3Rpb24gU3RhY2tzIVxcbicpO1xuICAgIH1cblxuICAgIGxldCBob3Rzd2FwUHJvcGVydGllc0Zyb21TZXR0aW5ncyA9IHRoaXMucHJvcHMuY29uZmlndXJhdGlvbi5zZXR0aW5ncy5nZXQoWydob3Rzd2FwJ10pIHx8IHt9O1xuXG4gICAgbGV0IGhvdHN3YXBQcm9wZXJ0eU92ZXJyaWRlcyA9IG5ldyBIb3Rzd2FwUHJvcGVydHlPdmVycmlkZXMoKTtcbiAgICBob3Rzd2FwUHJvcGVydHlPdmVycmlkZXMuZWNzSG90c3dhcFByb3BlcnRpZXMgPSBuZXcgRWNzSG90c3dhcFByb3BlcnRpZXMoXG4gICAgICBob3Rzd2FwUHJvcGVydGllc0Zyb21TZXR0aW5ncy5lY3M/Lm1pbmltdW1IZWFsdGh5UGVyY2VudCxcbiAgICAgIGhvdHN3YXBQcm9wZXJ0aWVzRnJvbVNldHRpbmdzLmVjcz8ubWF4aW11bUhlYWx0aHlQZXJjZW50LFxuICAgICk7XG5cbiAgICBjb25zdCBzdGFja3MgPSBzdGFja0NvbGxlY3Rpb24uc3RhY2tBcnRpZmFjdHM7XG5cbiAgICBjb25zdCBzdGFja091dHB1dHM6IHsgW2tleTogc3RyaW5nXTogYW55IH0gPSB7fTtcbiAgICBjb25zdCBvdXRwdXRzRmlsZSA9IG9wdGlvbnMub3V0cHV0c0ZpbGU7XG5cbiAgICBjb25zdCBidWlsZEFzc2V0ID0gYXN5bmMgKGFzc2V0Tm9kZTogQXNzZXRCdWlsZE5vZGUpID0+IHtcbiAgICAgIGF3YWl0IHRoaXMucHJvcHMuZGVwbG95bWVudHMuYnVpbGRTaW5nbGVBc3NldChcbiAgICAgICAgYXNzZXROb2RlLmFzc2V0TWFuaWZlc3RBcnRpZmFjdCxcbiAgICAgICAgYXNzZXROb2RlLmFzc2V0TWFuaWZlc3QsXG4gICAgICAgIGFzc2V0Tm9kZS5hc3NldCxcbiAgICAgICAge1xuICAgICAgICAgIHN0YWNrOiBhc3NldE5vZGUucGFyZW50U3RhY2ssXG4gICAgICAgICAgcm9sZUFybjogb3B0aW9ucy5yb2xlQXJuLFxuICAgICAgICAgIHN0YWNrTmFtZTogYXNzZXROb2RlLnBhcmVudFN0YWNrLnN0YWNrTmFtZSxcbiAgICAgICAgfSxcbiAgICAgICk7XG4gICAgfTtcblxuICAgIGNvbnN0IHB1Ymxpc2hBc3NldCA9IGFzeW5jIChhc3NldE5vZGU6IEFzc2V0UHVibGlzaE5vZGUpID0+IHtcbiAgICAgIGF3YWl0IHRoaXMucHJvcHMuZGVwbG95bWVudHMucHVibGlzaFNpbmdsZUFzc2V0KGFzc2V0Tm9kZS5hc3NldE1hbmlmZXN0LCBhc3NldE5vZGUuYXNzZXQsIHtcbiAgICAgICAgc3RhY2s6IGFzc2V0Tm9kZS5wYXJlbnRTdGFjayxcbiAgICAgICAgcm9sZUFybjogb3B0aW9ucy5yb2xlQXJuLFxuICAgICAgICBzdGFja05hbWU6IGFzc2V0Tm9kZS5wYXJlbnRTdGFjay5zdGFja05hbWUsXG4gICAgICB9KTtcbiAgICB9O1xuXG4gICAgY29uc3QgZGVwbG95U3RhY2sgPSBhc3luYyAoc3RhY2tOb2RlOiBTdGFja05vZGUpID0+IHtcbiAgICAgIGNvbnN0IHN0YWNrID0gc3RhY2tOb2RlLnN0YWNrO1xuICAgICAgaWYgKHN0YWNrQ29sbGVjdGlvbi5zdGFja0NvdW50ICE9PSAxKSB7XG4gICAgICAgIGhpZ2hsaWdodChzdGFjay5kaXNwbGF5TmFtZSk7XG4gICAgICB9XG5cbiAgICAgIGlmICghc3RhY2suZW52aXJvbm1lbnQpIHtcbiAgICAgICAgLy8gZXNsaW50LWRpc2FibGUtbmV4dC1saW5lIG1heC1sZW5cbiAgICAgICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgICAgIGBTdGFjayAke3N0YWNrLmRpc3BsYXlOYW1lfSBkb2VzIG5vdCBkZWZpbmUgYW4gZW52aXJvbm1lbnQsIGFuZCBBV1MgY3JlZGVudGlhbHMgY291bGQgbm90IGJlIG9idGFpbmVkIGZyb20gc3RhbmRhcmQgbG9jYXRpb25zIG9yIG5vIHJlZ2lvbiB3YXMgY29uZmlndXJlZC5gLFxuICAgICAgICApO1xuICAgICAgfVxuXG4gICAgICBpZiAoT2JqZWN0LmtleXMoc3RhY2sudGVtcGxhdGUuUmVzb3VyY2VzIHx8IHt9KS5sZW5ndGggPT09IDApIHtcbiAgICAgICAgLy8gVGhlIGdlbmVyYXRlZCBzdGFjayBoYXMgbm8gcmVzb3VyY2VzXG4gICAgICAgIGlmICghKGF3YWl0IHRoaXMucHJvcHMuZGVwbG95bWVudHMuc3RhY2tFeGlzdHMoeyBzdGFjayB9KSkpIHtcbiAgICAgICAgICB3YXJuaW5nKCclczogc3RhY2sgaGFzIG5vIHJlc291cmNlcywgc2tpcHBpbmcgZGVwbG95bWVudC4nLCBjaGFsay5ib2xkKHN0YWNrLmRpc3BsYXlOYW1lKSk7XG4gICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgd2FybmluZygnJXM6IHN0YWNrIGhhcyBubyByZXNvdXJjZXMsIGRlbGV0aW5nIGV4aXN0aW5nIHN0YWNrLicsIGNoYWxrLmJvbGQoc3RhY2suZGlzcGxheU5hbWUpKTtcbiAgICAgICAgICBhd2FpdCB0aGlzLmRlc3Ryb3koe1xuICAgICAgICAgICAgc2VsZWN0b3I6IHsgcGF0dGVybnM6IFtzdGFjay5oaWVyYXJjaGljYWxJZF0gfSxcbiAgICAgICAgICAgIGV4Y2x1c2l2ZWx5OiB0cnVlLFxuICAgICAgICAgICAgZm9yY2U6IHRydWUsXG4gICAgICAgICAgICByb2xlQXJuOiBvcHRpb25zLnJvbGVBcm4sXG4gICAgICAgICAgICBmcm9tRGVwbG95OiB0cnVlLFxuICAgICAgICAgICAgY2k6IG9wdGlvbnMuY2ksXG4gICAgICAgICAgfSk7XG4gICAgICAgIH1cbiAgICAgICAgcmV0dXJuO1xuICAgICAgfVxuXG4gICAgICBpZiAocmVxdWlyZUFwcHJvdmFsICE9PSBSZXF1aXJlQXBwcm92YWwuTmV2ZXIpIHtcbiAgICAgICAgY29uc3QgY3VycmVudFRlbXBsYXRlID0gYXdhaXQgdGhpcy5wcm9wcy5kZXBsb3ltZW50cy5yZWFkQ3VycmVudFRlbXBsYXRlKHN0YWNrKTtcbiAgICAgICAgaWYgKHByaW50U2VjdXJpdHlEaWZmKGN1cnJlbnRUZW1wbGF0ZSwgc3RhY2ssIHJlcXVpcmVBcHByb3ZhbCkpIHtcbiAgICAgICAgICBhd2FpdCBhc2tVc2VyQ29uZmlybWF0aW9uKFxuICAgICAgICAgICAgY29uY3VycmVuY3ksXG4gICAgICAgICAgICAnXCItLXJlcXVpcmUtYXBwcm92YWxcIiBpcyBlbmFibGVkIGFuZCBzdGFjayBpbmNsdWRlcyBzZWN1cml0eS1zZW5zaXRpdmUgdXBkYXRlcycsXG4gICAgICAgICAgICAnRG8geW91IHdpc2ggdG8gZGVwbG95IHRoZXNlIGNoYW5nZXMnLFxuICAgICAgICAgICk7XG4gICAgICAgIH1cbiAgICAgIH1cblxuICAgICAgLy8gRm9sbG93aW5nIGFyZSB0aGUgc2FtZSBzZW1hbnRpY3Mgd2UgYXBwbHkgd2l0aCByZXNwZWN0IHRvIE5vdGlmaWNhdGlvbiBBUk5zIChkaWN0YXRlZCBieSB0aGUgU0RLKVxuICAgICAgLy9cbiAgICAgIC8vICAtIHVuZGVmaW5lZCAgPT4gIGNkayBpZ25vcmVzIGl0LCBhcyBpZiBpdCB3YXNuJ3Qgc3VwcG9ydGVkIChhbGxvd3MgZXh0ZXJuYWwgbWFuYWdlbWVudCkuXG4gICAgICAvLyAgLSBbXTogICAgICAgID0+ICBjZGsgbWFuYWdlcyBpdCwgYW5kIHRoZSB1c2VyIHdhbnRzIHRvIHdpcGUgaXQgb3V0LlxuICAgICAgLy8gIC0gWydhcm4tMSddICA9PiAgY2RrIG1hbmFnZXMgaXQsIGFuZCB0aGUgdXNlciB3YW50cyB0byBzZXQgaXQgdG8gWydhcm4tMSddLlxuICAgICAgY29uc3Qgbm90aWZpY2F0aW9uQXJucyA9ICghIW9wdGlvbnMubm90aWZpY2F0aW9uQXJucyB8fCAhIXN0YWNrLm5vdGlmaWNhdGlvbkFybnMpXG4gICAgICAgID8gKG9wdGlvbnMubm90aWZpY2F0aW9uQXJucyA/PyBbXSkuY29uY2F0KHN0YWNrLm5vdGlmaWNhdGlvbkFybnMgPz8gW10pXG4gICAgICAgIDogdW5kZWZpbmVkO1xuXG4gICAgICBmb3IgKGNvbnN0IG5vdGlmaWNhdGlvbkFybiBvZiBub3RpZmljYXRpb25Bcm5zID8/IFtdKSB7XG4gICAgICAgIGlmICghdmFsaWRhdGVTbnNUb3BpY0Fybihub3RpZmljYXRpb25Bcm4pKSB7XG4gICAgICAgICAgdGhyb3cgbmV3IEVycm9yKGBOb3RpZmljYXRpb24gYXJuICR7bm90aWZpY2F0aW9uQXJufSBpcyBub3QgYSB2YWxpZCBhcm4gZm9yIGFuIFNOUyB0b3BpY2ApO1xuICAgICAgICB9XG4gICAgICB9XG5cbiAgICAgIGNvbnN0IHN0YWNrSW5kZXggPSBzdGFja3MuaW5kZXhPZihzdGFjaykgKyAxO1xuICAgICAgcHJpbnQoJyVzOiBkZXBsb3lpbmcuLi4gWyVzLyVzXScsIGNoYWxrLmJvbGQoc3RhY2suZGlzcGxheU5hbWUpLCBzdGFja0luZGV4LCBzdGFja0NvbGxlY3Rpb24uc3RhY2tDb3VudCk7XG4gICAgICBjb25zdCBzdGFydERlcGxveVRpbWUgPSBuZXcgRGF0ZSgpLmdldFRpbWUoKTtcblxuICAgICAgbGV0IHRhZ3MgPSBvcHRpb25zLnRhZ3M7XG4gICAgICBpZiAoIXRhZ3MgfHwgdGFncy5sZW5ndGggPT09IDApIHtcbiAgICAgICAgdGFncyA9IHRhZ3NGb3JTdGFjayhzdGFjayk7XG4gICAgICB9XG5cbiAgICAgIGxldCBlbGFwc2VkRGVwbG95VGltZSA9IDA7XG4gICAgICB0cnkge1xuICAgICAgICBsZXQgZGVwbG95UmVzdWx0OiBTdWNjZXNzZnVsRGVwbG95U3RhY2tSZXN1bHQgfCB1bmRlZmluZWQ7XG5cbiAgICAgICAgbGV0IHJvbGxiYWNrID0gb3B0aW9ucy5yb2xsYmFjaztcbiAgICAgICAgbGV0IGl0ZXJhdGlvbiA9IDA7XG4gICAgICAgIHdoaWxlICghZGVwbG95UmVzdWx0KSB7XG4gICAgICAgICAgaWYgKCsraXRlcmF0aW9uID4gMikge1xuICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKCdUaGlzIGxvb3Agc2hvdWxkIGhhdmUgc3RhYmlsaXplZCBpbiAyIGl0ZXJhdGlvbnMsIGJ1dCBkaWRuXFwndC4gSWYgeW91IGFyZSBzZWVpbmcgdGhpcyBlcnJvciwgcGxlYXNlIHJlcG9ydCBpdCBhdCBodHRwczovL2dpdGh1Yi5jb20vYXdzL2F3cy1jZGsvaXNzdWVzL25ldy9jaG9vc2UnKTtcbiAgICAgICAgICB9XG5cbiAgICAgICAgICBjb25zdCByID0gYXdhaXQgdGhpcy5wcm9wcy5kZXBsb3ltZW50cy5kZXBsb3lTdGFjayh7XG4gICAgICAgICAgICBzdGFjayxcbiAgICAgICAgICAgIGRlcGxveU5hbWU6IHN0YWNrLnN0YWNrTmFtZSxcbiAgICAgICAgICAgIHJvbGVBcm46IG9wdGlvbnMucm9sZUFybixcbiAgICAgICAgICAgIHRvb2xraXRTdGFja05hbWU6IG9wdGlvbnMudG9vbGtpdFN0YWNrTmFtZSxcbiAgICAgICAgICAgIHJldXNlQXNzZXRzOiBvcHRpb25zLnJldXNlQXNzZXRzLFxuICAgICAgICAgICAgbm90aWZpY2F0aW9uQXJucyxcbiAgICAgICAgICAgIHRhZ3MsXG4gICAgICAgICAgICBleGVjdXRlOiBvcHRpb25zLmV4ZWN1dGUsXG4gICAgICAgICAgICBjaGFuZ2VTZXROYW1lOiBvcHRpb25zLmNoYW5nZVNldE5hbWUsXG4gICAgICAgICAgICBkZXBsb3ltZW50TWV0aG9kOiBvcHRpb25zLmRlcGxveW1lbnRNZXRob2QsXG4gICAgICAgICAgICBmb3JjZTogb3B0aW9ucy5mb3JjZSxcbiAgICAgICAgICAgIHBhcmFtZXRlcnM6IE9iamVjdC5hc3NpZ24oe30sIHBhcmFtZXRlck1hcFsnKiddLCBwYXJhbWV0ZXJNYXBbc3RhY2suc3RhY2tOYW1lXSksXG4gICAgICAgICAgICB1c2VQcmV2aW91c1BhcmFtZXRlcnM6IG9wdGlvbnMudXNlUHJldmlvdXNQYXJhbWV0ZXJzLFxuICAgICAgICAgICAgcHJvZ3Jlc3MsXG4gICAgICAgICAgICBjaTogb3B0aW9ucy5jaSxcbiAgICAgICAgICAgIHJvbGxiYWNrLFxuICAgICAgICAgICAgaG90c3dhcDogb3B0aW9ucy5ob3Rzd2FwLFxuICAgICAgICAgICAgaG90c3dhcFByb3BlcnR5T3ZlcnJpZGVzOiBob3Rzd2FwUHJvcGVydHlPdmVycmlkZXMsXG4gICAgICAgICAgICBleHRyYVVzZXJBZ2VudDogb3B0aW9ucy5leHRyYVVzZXJBZ2VudCxcbiAgICAgICAgICAgIGFzc2V0UGFyYWxsZWxpc206IG9wdGlvbnMuYXNzZXRQYXJhbGxlbGlzbSxcbiAgICAgICAgICAgIGlnbm9yZU5vU3RhY2tzOiBvcHRpb25zLmlnbm9yZU5vU3RhY2tzLFxuICAgICAgICAgIH0pO1xuXG4gICAgICAgICAgc3dpdGNoIChyLnR5cGUpIHtcbiAgICAgICAgICAgIGNhc2UgJ2RpZC1kZXBsb3ktc3RhY2snOlxuICAgICAgICAgICAgICBkZXBsb3lSZXN1bHQgPSByO1xuICAgICAgICAgICAgICBicmVhaztcblxuICAgICAgICAgICAgY2FzZSAnZmFpbHBhdXNlZC1uZWVkLXJvbGxiYWNrLWZpcnN0Jzoge1xuICAgICAgICAgICAgICBjb25zdCBtb3RpdmF0aW9uID0gci5yZWFzb24gPT09ICdyZXBsYWNlbWVudCdcbiAgICAgICAgICAgICAgICA/ICdTdGFjayBpcyBpbiBhIHBhdXNlZCBmYWlsIHN0YXRlIGFuZCBjaGFuZ2UgaW5jbHVkZXMgYSByZXBsYWNlbWVudCB3aGljaCBjYW5ub3QgYmUgZGVwbG95ZWQgd2l0aCBcIi0tbm8tcm9sbGJhY2tcIidcbiAgICAgICAgICAgICAgICA6ICdTdGFjayBpcyBpbiBhIHBhdXNlZCBmYWlsIHN0YXRlIGFuZCBjb21tYW5kIGxpbmUgYXJndW1lbnRzIGRvIG5vdCBpbmNsdWRlIFwiLS1uby1yb2xsYmFja1wiJztcblxuICAgICAgICAgICAgICBpZiAob3B0aW9ucy5mb3JjZSkge1xuICAgICAgICAgICAgICAgIHdhcm5pbmcoYCR7bW90aXZhdGlvbn0uIFJvbGxpbmcgYmFjayBmaXJzdCAoLS1mb3JjZSkuYCk7XG4gICAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgYXdhaXQgYXNrVXNlckNvbmZpcm1hdGlvbihcbiAgICAgICAgICAgICAgICAgIGNvbmN1cnJlbmN5LFxuICAgICAgICAgICAgICAgICAgbW90aXZhdGlvbixcbiAgICAgICAgICAgICAgICAgIGAke21vdGl2YXRpb259LiBSb2xsIGJhY2sgZmlyc3QgYW5kIHRoZW4gcHJvY2VlZCB3aXRoIGRlcGxveW1lbnRgLFxuICAgICAgICAgICAgICAgICk7XG4gICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAvLyBQZXJmb3JtIGEgcm9sbGJhY2tcbiAgICAgICAgICAgICAgYXdhaXQgdGhpcy5yb2xsYmFjayh7XG4gICAgICAgICAgICAgICAgc2VsZWN0b3I6IHsgcGF0dGVybnM6IFtzdGFjay5oaWVyYXJjaGljYWxJZF0gfSxcbiAgICAgICAgICAgICAgICB0b29sa2l0U3RhY2tOYW1lOiBvcHRpb25zLnRvb2xraXRTdGFja05hbWUsXG4gICAgICAgICAgICAgICAgZm9yY2U6IG9wdGlvbnMuZm9yY2UsXG4gICAgICAgICAgICAgIH0pO1xuXG4gICAgICAgICAgICAgIC8vIEdvIGFyb3VuZCB0aHJvdWdoIHRoZSAnd2hpbGUnIGxvb3AgYWdhaW4gYnV0IHN3aXRjaCByb2xsYmFjayB0byB0cnVlLlxuICAgICAgICAgICAgICByb2xsYmFjayA9IHRydWU7XG4gICAgICAgICAgICAgIGJyZWFrO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBjYXNlICdyZXBsYWNlbWVudC1yZXF1aXJlcy1ub3JvbGxiYWNrJzoge1xuICAgICAgICAgICAgICBjb25zdCBtb3RpdmF0aW9uID0gJ0NoYW5nZSBpbmNsdWRlcyBhIHJlcGxhY2VtZW50IHdoaWNoIGNhbm5vdCBiZSBkZXBsb3llZCB3aXRoIFwiLS1uby1yb2xsYmFja1wiJztcblxuICAgICAgICAgICAgICBpZiAob3B0aW9ucy5mb3JjZSkge1xuICAgICAgICAgICAgICAgIHdhcm5pbmcoYCR7bW90aXZhdGlvbn0uIFByb2NlZWRpbmcgd2l0aCByZWd1bGFyIGRlcGxveW1lbnQgKC0tZm9yY2UpLmApO1xuICAgICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgIGF3YWl0IGFza1VzZXJDb25maXJtYXRpb24oXG4gICAgICAgICAgICAgICAgICBjb25jdXJyZW5jeSxcbiAgICAgICAgICAgICAgICAgIG1vdGl2YXRpb24sXG4gICAgICAgICAgICAgICAgICBgJHttb3RpdmF0aW9ufS4gUGVyZm9ybSBhIHJlZ3VsYXIgZGVwbG95bWVudGAsXG4gICAgICAgICAgICAgICAgKTtcbiAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgIC8vIEdvIGFyb3VuZCB0aHJvdWdoIHRoZSAnd2hpbGUnIGxvb3AgYWdhaW4gYnV0IHN3aXRjaCByb2xsYmFjayB0byBmYWxzZS5cbiAgICAgICAgICAgICAgcm9sbGJhY2sgPSB0cnVlO1xuICAgICAgICAgICAgICBicmVhaztcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgZGVmYXVsdDpcbiAgICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKGBVbmV4cGVjdGVkIHJlc3VsdCB0eXBlIGZyb20gZGVwbG95U3RhY2s6ICR7SlNPTi5zdHJpbmdpZnkocil9LiBJZiB5b3UgYXJlIHNlZWluZyB0aGlzIGVycm9yLCBwbGVhc2UgcmVwb3J0IGl0IGF0IGh0dHBzOi8vZ2l0aHViLmNvbS9hd3MvYXdzLWNkay9pc3N1ZXMvbmV3L2Nob29zZWApO1xuICAgICAgICAgIH1cbiAgICAgICAgfVxuXG4gICAgICAgIGNvbnN0IG1lc3NhZ2UgPSBkZXBsb3lSZXN1bHQubm9PcFxuICAgICAgICAgID8gJyDinIUgICVzIChubyBjaGFuZ2VzKSdcbiAgICAgICAgICA6ICcg4pyFICAlcyc7XG5cbiAgICAgICAgc3VjY2VzcygnXFxuJyArIG1lc3NhZ2UsIHN0YWNrLmRpc3BsYXlOYW1lKTtcbiAgICAgICAgZWxhcHNlZERlcGxveVRpbWUgPSBuZXcgRGF0ZSgpLmdldFRpbWUoKSAtIHN0YXJ0RGVwbG95VGltZTtcbiAgICAgICAgcHJpbnQoJ1xcbuKcqCAgRGVwbG95bWVudCB0aW1lOiAlc3NcXG4nLCBmb3JtYXRUaW1lKGVsYXBzZWREZXBsb3lUaW1lKSk7XG5cbiAgICAgICAgaWYgKE9iamVjdC5rZXlzKGRlcGxveVJlc3VsdC5vdXRwdXRzKS5sZW5ndGggPiAwKSB7XG4gICAgICAgICAgcHJpbnQoJ091dHB1dHM6Jyk7XG5cbiAgICAgICAgICBzdGFja091dHB1dHNbc3RhY2suc3RhY2tOYW1lXSA9IGRlcGxveVJlc3VsdC5vdXRwdXRzO1xuICAgICAgICB9XG5cbiAgICAgICAgZm9yIChjb25zdCBuYW1lIG9mIE9iamVjdC5rZXlzKGRlcGxveVJlc3VsdC5vdXRwdXRzKS5zb3J0KCkpIHtcbiAgICAgICAgICBjb25zdCB2YWx1ZSA9IGRlcGxveVJlc3VsdC5vdXRwdXRzW25hbWVdO1xuICAgICAgICAgIHByaW50KCclcy4lcyA9ICVzJywgY2hhbGsuY3lhbihzdGFjay5pZCksIGNoYWxrLmN5YW4obmFtZSksIGNoYWxrLnVuZGVybGluZShjaGFsay5jeWFuKHZhbHVlKSkpO1xuICAgICAgICB9XG5cbiAgICAgICAgcHJpbnQoJ1N0YWNrIEFSTjonKTtcblxuICAgICAgICBkYXRhKGRlcGxveVJlc3VsdC5zdGFja0Fybik7XG4gICAgICB9IGNhdGNoIChlOiBhbnkpIHtcbiAgICAgICAgLy8gSXQgaGFzIHRvIGJlIGV4YWN0bHkgdGhpcyBzdHJpbmcgYmVjYXVzZSBhbiBpbnRlZ3JhdGlvbiB0ZXN0IHRlc3RzIGZvclxuICAgICAgICAvLyBcImJvbGQoc3RhY2tuYW1lKSBmYWlsZWQ6IFJlc291cmNlTm90UmVhZHk6IDxlcnJvcj5cIlxuICAgICAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICAgICAgW2DinYwgICR7Y2hhbGsuYm9sZChzdGFjay5zdGFja05hbWUpfSBmYWlsZWQ6YCwgLi4uKGUubmFtZSA/IFtgJHtlLm5hbWV9OmBdIDogW10pLCBlLm1lc3NhZ2VdLmpvaW4oJyAnKSxcbiAgICAgICAgKTtcbiAgICAgIH0gZmluYWxseSB7XG4gICAgICAgIGlmIChvcHRpb25zLmNsb3VkV2F0Y2hMb2dNb25pdG9yKSB7XG4gICAgICAgICAgY29uc3QgZm91bmRMb2dHcm91cHNSZXN1bHQgPSBhd2FpdCBmaW5kQ2xvdWRXYXRjaExvZ0dyb3Vwcyh0aGlzLnByb3BzLnNka1Byb3ZpZGVyLCBzdGFjayk7XG4gICAgICAgICAgb3B0aW9ucy5jbG91ZFdhdGNoTG9nTW9uaXRvci5hZGRMb2dHcm91cHMoXG4gICAgICAgICAgICBmb3VuZExvZ0dyb3Vwc1Jlc3VsdC5lbnYsXG4gICAgICAgICAgICBmb3VuZExvZ0dyb3Vwc1Jlc3VsdC5zZGssXG4gICAgICAgICAgICBmb3VuZExvZ0dyb3Vwc1Jlc3VsdC5sb2dHcm91cE5hbWVzLFxuICAgICAgICAgICk7XG4gICAgICAgIH1cbiAgICAgICAgLy8gSWYgYW4gb3V0cHV0cyBmaWxlIGhhcyBiZWVuIHNwZWNpZmllZCwgY3JlYXRlIHRoZSBmaWxlIHBhdGggYW5kIHdyaXRlIHN0YWNrIG91dHB1dHMgdG8gaXQgb25jZS5cbiAgICAgICAgLy8gT3V0cHV0cyBhcmUgd3JpdHRlbiBhZnRlciBhbGwgc3RhY2tzIGhhdmUgYmVlbiBkZXBsb3llZC4gSWYgYSBzdGFjayBkZXBsb3ltZW50IGZhaWxzLFxuICAgICAgICAvLyBhbGwgb2YgdGhlIG91dHB1dHMgZnJvbSBzdWNjZXNzZnVsbHkgZGVwbG95ZWQgc3RhY2tzIGJlZm9yZSB0aGUgZmFpbHVyZSB3aWxsIHN0aWxsIGJlIHdyaXR0ZW4uXG4gICAgICAgIGlmIChvdXRwdXRzRmlsZSkge1xuICAgICAgICAgIGZzLmVuc3VyZUZpbGVTeW5jKG91dHB1dHNGaWxlKTtcbiAgICAgICAgICBhd2FpdCBmcy53cml0ZUpzb24ob3V0cHV0c0ZpbGUsIHN0YWNrT3V0cHV0cywge1xuICAgICAgICAgICAgc3BhY2VzOiAyLFxuICAgICAgICAgICAgZW5jb2Rpbmc6ICd1dGY4JyxcbiAgICAgICAgICB9KTtcbiAgICAgICAgfVxuICAgICAgfVxuICAgICAgcHJpbnQoJ1xcbuKcqCAgVG90YWwgdGltZTogJXNzXFxuJywgZm9ybWF0VGltZShlbGFwc2VkU3ludGhUaW1lICsgZWxhcHNlZERlcGxveVRpbWUpKTtcbiAgICB9O1xuXG4gICAgY29uc3QgYXNzZXRCdWlsZFRpbWUgPSBvcHRpb25zLmFzc2V0QnVpbGRUaW1lID8/IEFzc2V0QnVpbGRUaW1lLkFMTF9CRUZPUkVfREVQTE9ZO1xuICAgIGNvbnN0IHByZWJ1aWxkQXNzZXRzID0gYXNzZXRCdWlsZFRpbWUgPT09IEFzc2V0QnVpbGRUaW1lLkFMTF9CRUZPUkVfREVQTE9ZO1xuICAgIGNvbnN0IGNvbmN1cnJlbmN5ID0gb3B0aW9ucy5jb25jdXJyZW5jeSB8fCAxO1xuICAgIGNvbnN0IHByb2dyZXNzID0gY29uY3VycmVuY3kgPiAxID8gU3RhY2tBY3Rpdml0eVByb2dyZXNzLkVWRU5UUyA6IG9wdGlvbnMucHJvZ3Jlc3M7XG4gICAgaWYgKGNvbmN1cnJlbmN5ID4gMSAmJiBvcHRpb25zLnByb2dyZXNzICYmIG9wdGlvbnMucHJvZ3Jlc3MgIT0gU3RhY2tBY3Rpdml0eVByb2dyZXNzLkVWRU5UUykge1xuICAgICAgd2FybmluZygn4pqg77iPIFRoZSAtLWNvbmN1cnJlbmN5IGZsYWcgb25seSBzdXBwb3J0cyAtLXByb2dyZXNzIFwiZXZlbnRzXCIuIFN3aXRjaGluZyB0byBcImV2ZW50c1wiLicpO1xuICAgIH1cblxuICAgIGNvbnN0IHN0YWNrc0FuZFRoZWlyQXNzZXRNYW5pZmVzdHMgPSBzdGFja3MuZmxhdE1hcCgoc3RhY2spID0+IFtcbiAgICAgIHN0YWNrLFxuICAgICAgLi4uc3RhY2suZGVwZW5kZW5jaWVzLmZpbHRlcihjeGFwaS5Bc3NldE1hbmlmZXN0QXJ0aWZhY3QuaXNBc3NldE1hbmlmZXN0QXJ0aWZhY3QpLFxuICAgIF0pO1xuICAgIGNvbnN0IHdvcmtHcmFwaCA9IG5ldyBXb3JrR3JhcGhCdWlsZGVyKHByZWJ1aWxkQXNzZXRzKS5idWlsZChzdGFja3NBbmRUaGVpckFzc2V0TWFuaWZlc3RzKTtcblxuICAgIC8vIFVubGVzcyB3ZSBhcmUgcnVubmluZyB3aXRoICctLWZvcmNlJywgc2tpcCBhbHJlYWR5IHB1Ymxpc2hlZCBhc3NldHNcbiAgICBpZiAoIW9wdGlvbnMuZm9yY2UpIHtcbiAgICAgIGF3YWl0IHRoaXMucmVtb3ZlUHVibGlzaGVkQXNzZXRzKHdvcmtHcmFwaCwgb3B0aW9ucyk7XG4gICAgfVxuXG4gICAgY29uc3QgZ3JhcGhDb25jdXJyZW5jeTogQ29uY3VycmVuY3kgPSB7XG4gICAgICAnc3RhY2snOiBjb25jdXJyZW5jeSxcbiAgICAgICdhc3NldC1idWlsZCc6IDEsIC8vIFRoaXMgd2lsbCBiZSBDUFUtYm91bmQvbWVtb3J5IGJvdW5kLCBtb3N0bHkgbWF0dGVycyBmb3IgRG9ja2VyIGJ1aWxkc1xuICAgICAgJ2Fzc2V0LXB1Ymxpc2gnOiAob3B0aW9ucy5hc3NldFBhcmFsbGVsaXNtID8/IHRydWUpID8gOCA6IDEsIC8vIFRoaXMgd2lsbCBiZSBJL08tYm91bmQsIDggaW4gcGFyYWxsZWwgc2VlbXMgcmVhc29uYWJsZVxuICAgIH07XG5cbiAgICBhd2FpdCB3b3JrR3JhcGguZG9QYXJhbGxlbChncmFwaENvbmN1cnJlbmN5LCB7XG4gICAgICBkZXBsb3lTdGFjayxcbiAgICAgIGJ1aWxkQXNzZXQsXG4gICAgICBwdWJsaXNoQXNzZXQsXG4gICAgfSk7XG4gIH1cblxuICAvKipcbiAgICogUm9sbCBiYWNrIHRoZSBnaXZlbiBzdGFjayBvciBzdGFja3MuXG4gICAqL1xuICBwdWJsaWMgYXN5bmMgcm9sbGJhY2sob3B0aW9uczogUm9sbGJhY2tPcHRpb25zKSB7XG4gICAgY29uc3Qgc3RhcnRTeW50aFRpbWUgPSBuZXcgRGF0ZSgpLmdldFRpbWUoKTtcbiAgICBjb25zdCBzdGFja0NvbGxlY3Rpb24gPSBhd2FpdCB0aGlzLnNlbGVjdFN0YWNrc0ZvckRlcGxveShvcHRpb25zLnNlbGVjdG9yLCB0cnVlKTtcbiAgICBjb25zdCBlbGFwc2VkU3ludGhUaW1lID0gbmV3IERhdGUoKS5nZXRUaW1lKCkgLSBzdGFydFN5bnRoVGltZTtcbiAgICBwcmludCgnXFxu4pyoICBTeW50aGVzaXMgdGltZTogJXNzXFxuJywgZm9ybWF0VGltZShlbGFwc2VkU3ludGhUaW1lKSk7XG5cbiAgICBpZiAoc3RhY2tDb2xsZWN0aW9uLnN0YWNrQ291bnQgPT09IDApIHtcbiAgICAgIC8vIGVzbGludC1kaXNhYmxlLW5leHQtbGluZSBuby1jb25zb2xlXG4gICAgICBjb25zb2xlLmVycm9yKCdObyBzdGFja3Mgc2VsZWN0ZWQnKTtcbiAgICAgIHJldHVybjtcbiAgICB9XG5cbiAgICBsZXQgYW55Um9sbGJhY2thYmxlID0gZmFsc2U7XG5cbiAgICBmb3IgKGNvbnN0IHN0YWNrIG9mIHN0YWNrQ29sbGVjdGlvbi5zdGFja0FydGlmYWN0cykge1xuICAgICAgcHJpbnQoJ1JvbGxpbmcgYmFjayAlcycsIGNoYWxrLmJvbGQoc3RhY2suZGlzcGxheU5hbWUpKTtcbiAgICAgIGNvbnN0IHN0YXJ0Um9sbGJhY2tUaW1lID0gbmV3IERhdGUoKS5nZXRUaW1lKCk7XG4gICAgICB0cnkge1xuICAgICAgICBjb25zdCByZXN1bHQgPSBhd2FpdCB0aGlzLnByb3BzLmRlcGxveW1lbnRzLnJvbGxiYWNrU3RhY2soe1xuICAgICAgICAgIHN0YWNrLFxuICAgICAgICAgIHJvbGVBcm46IG9wdGlvbnMucm9sZUFybixcbiAgICAgICAgICB0b29sa2l0U3RhY2tOYW1lOiBvcHRpb25zLnRvb2xraXRTdGFja05hbWUsXG4gICAgICAgICAgZm9yY2U6IG9wdGlvbnMuZm9yY2UsXG4gICAgICAgICAgdmFsaWRhdGVCb290c3RyYXBTdGFja1ZlcnNpb246IG9wdGlvbnMudmFsaWRhdGVCb290c3RyYXBTdGFja1ZlcnNpb24sXG4gICAgICAgICAgb3JwaGFuTG9naWNhbElkczogb3B0aW9ucy5vcnBoYW5Mb2dpY2FsSWRzLFxuICAgICAgICB9KTtcbiAgICAgICAgaWYgKCFyZXN1bHQubm90SW5Sb2xsYmFja2FibGVTdGF0ZSkge1xuICAgICAgICAgIGFueVJvbGxiYWNrYWJsZSA9IHRydWU7XG4gICAgICAgIH1cbiAgICAgICAgY29uc3QgZWxhcHNlZFJvbGxiYWNrVGltZSA9IG5ldyBEYXRlKCkuZ2V0VGltZSgpIC0gc3RhcnRSb2xsYmFja1RpbWU7XG4gICAgICAgIHByaW50KCdcXG7inKggIFJvbGxiYWNrIHRpbWU6ICVzc1xcbicsIGZvcm1hdFRpbWUoZWxhcHNlZFJvbGxiYWNrVGltZSkpO1xuICAgICAgfSBjYXRjaCAoZTogYW55KSB7XG4gICAgICAgIGVycm9yKCdcXG4g4p2MICAlcyBmYWlsZWQ6ICVzJywgY2hhbGsuYm9sZChzdGFjay5kaXNwbGF5TmFtZSksIGUubWVzc2FnZSk7XG4gICAgICAgIHRocm93IG5ldyBFcnJvcignUm9sbGJhY2sgZmFpbGVkICh1c2UgLS1mb3JjZSB0byBvcnBoYW4gZmFpbGluZyByZXNvdXJjZXMpJyk7XG4gICAgICB9XG4gICAgfVxuICAgIGlmICghYW55Um9sbGJhY2thYmxlKSB7XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoJ05vIHN0YWNrcyB3ZXJlIGluIGEgc3RhdGUgdGhhdCBjb3VsZCBiZSByb2xsZWQgYmFjaycpO1xuICAgIH1cbiAgfVxuXG4gIHB1YmxpYyBhc3luYyB3YXRjaChvcHRpb25zOiBXYXRjaE9wdGlvbnMpIHtcbiAgICBjb25zdCByb290RGlyID0gcGF0aC5kaXJuYW1lKHBhdGgucmVzb2x2ZShQUk9KRUNUX0NPTkZJRykpO1xuICAgIGRlYnVnKFwicm9vdCBkaXJlY3RvcnkgdXNlZCBmb3IgJ3dhdGNoJyBpczogJXNcIiwgcm9vdERpcik7XG5cbiAgICBjb25zdCB3YXRjaFNldHRpbmdzOiB7IGluY2x1ZGU/OiBzdHJpbmcgfCBzdHJpbmdbXTsgZXhjbHVkZTogc3RyaW5nIHwgc3RyaW5nW10gfSB8IHVuZGVmaW5lZCA9XG4gICAgICB0aGlzLnByb3BzLmNvbmZpZ3VyYXRpb24uc2V0dGluZ3MuZ2V0KFsnd2F0Y2gnXSk7XG4gICAgaWYgKCF3YXRjaFNldHRpbmdzKSB7XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICAgIFwiQ2Fubm90IHVzZSB0aGUgJ3dhdGNoJyBjb21tYW5kIHdpdGhvdXQgc3BlY2lmeWluZyBhdCBsZWFzdCBvbmUgZGlyZWN0b3J5IHRvIG1vbml0b3IuIFwiICtcbiAgICAgICAgICAnTWFrZSBzdXJlIHRvIGFkZCBhIFwid2F0Y2hcIiBrZXkgdG8geW91ciBjZGsuanNvbicsXG4gICAgICApO1xuICAgIH1cblxuICAgIC8vIEZvciB0aGUgXCJpbmNsdWRlXCIgc3Via2V5IHVuZGVyIHRoZSBcIndhdGNoXCIga2V5LCB0aGUgYmVoYXZpb3IgaXM6XG4gICAgLy8gMS4gTm8gXCJ3YXRjaFwiIHNldHRpbmc/IFdlIGVycm9yIG91dC5cbiAgICAvLyAyLiBcIndhdGNoXCIgc2V0dGluZyB3aXRob3V0IGFuIFwiaW5jbHVkZVwiIGtleT8gV2UgZGVmYXVsdCB0byBvYnNlcnZpbmcgXCIuLyoqXCIuXG4gICAgLy8gMy4gXCJ3YXRjaFwiIHNldHRpbmcgd2l0aCBhbiBlbXB0eSBcImluY2x1ZGVcIiBrZXk/IFdlIGRlZmF1bHQgdG8gb2JzZXJ2aW5nIFwiLi8qKlwiLlxuICAgIC8vIDQuIE5vbi1lbXB0eSBcImluY2x1ZGVcIiBrZXk/IEp1c3QgdXNlIHRoZSBcImluY2x1ZGVcIiBrZXkuXG4gICAgY29uc3Qgd2F0Y2hJbmNsdWRlcyA9IHRoaXMucGF0dGVybnNBcnJheUZvcldhdGNoKHdhdGNoU2V0dGluZ3MuaW5jbHVkZSwge1xuICAgICAgcm9vdERpcixcbiAgICAgIHJldHVyblJvb3REaXJJZkVtcHR5OiB0cnVlLFxuICAgIH0pO1xuICAgIGRlYnVnKFwiJ2luY2x1ZGUnIHBhdHRlcm5zIGZvciAnd2F0Y2gnOiAlc1wiLCB3YXRjaEluY2x1ZGVzKTtcblxuICAgIC8vIEZvciB0aGUgXCJleGNsdWRlXCIgc3Via2V5IHVuZGVyIHRoZSBcIndhdGNoXCIga2V5LFxuICAgIC8vIHRoZSBiZWhhdmlvciBpcyB0byBhZGQgc29tZSBkZWZhdWx0IGV4Y2x1ZGVzIGluIGFkZGl0aW9uIHRvIHRoZSBvbmVzIHNwZWNpZmllZCBieSB0aGUgdXNlcjpcbiAgICAvLyAxLiBUaGUgQ0RLIG91dHB1dCBkaXJlY3RvcnkuXG4gICAgLy8gMi4gQW55IGZpbGUgd2hvc2UgbmFtZSBzdGFydHMgd2l0aCBhIGRvdC5cbiAgICAvLyAzLiBBbnkgZGlyZWN0b3J5J3MgY29udGVudCB3aG9zZSBuYW1lIHN0YXJ0cyB3aXRoIGEgZG90LlxuICAgIC8vIDQuIEFueSBub2RlX21vZHVsZXMgYW5kIGl0cyBjb250ZW50IChldmVuIGlmIGl0J3Mgbm90IGEgSlMvVFMgcHJvamVjdCwgeW91IG1pZ2h0IGJlIHVzaW5nIGEgbG9jYWwgYXdzLWNsaSBwYWNrYWdlKVxuICAgIGNvbnN0IG91dHB1dERpciA9IHRoaXMucHJvcHMuY29uZmlndXJhdGlvbi5zZXR0aW5ncy5nZXQoWydvdXRwdXQnXSk7XG4gICAgY29uc3Qgd2F0Y2hFeGNsdWRlcyA9IHRoaXMucGF0dGVybnNBcnJheUZvcldhdGNoKHdhdGNoU2V0dGluZ3MuZXhjbHVkZSwge1xuICAgICAgcm9vdERpcixcbiAgICAgIHJldHVyblJvb3REaXJJZkVtcHR5OiBmYWxzZSxcbiAgICB9KS5jb25jYXQoYCR7b3V0cHV0RGlyfS8qKmAsICcqKi8uKicsICcqKi8uKi8qKicsICcqKi9ub2RlX21vZHVsZXMvKionKTtcbiAgICBkZWJ1ZyhcIidleGNsdWRlJyBwYXR0ZXJucyBmb3IgJ3dhdGNoJzogJXNcIiwgd2F0Y2hFeGNsdWRlcyk7XG5cbiAgICAvLyBTaW5jZSAnY2RrIGRlcGxveScgaXMgYSByZWxhdGl2ZWx5IHNsb3cgb3BlcmF0aW9uIGZvciBhICd3YXRjaCcgcHJvY2VzcyxcbiAgICAvLyBpbnRyb2R1Y2UgYSBjb25jdXJyZW5jeSBsYXRjaCB0aGF0IHRyYWNrcyB0aGUgc3RhdGUuXG4gICAgLy8gVGhpcyB3YXksIGlmIGZpbGUgY2hhbmdlIGV2ZW50cyBhcnJpdmUgd2hlbiBhICdjZGsgZGVwbG95JyBpcyBzdGlsbCBleGVjdXRpbmcsXG4gICAgLy8gd2Ugd2lsbCBiYXRjaCB0aGVtLCBhbmQgdHJpZ2dlciBhbm90aGVyICdjZGsgZGVwbG95JyBhZnRlciB0aGUgY3VycmVudCBvbmUgZmluaXNoZXMsXG4gICAgLy8gbWFraW5nIHN1cmUgJ2NkayBkZXBsb3kncyAgYWx3YXlzIGV4ZWN1dGUgb25lIGF0IGEgdGltZS5cbiAgICAvLyBIZXJlJ3MgYSBkaWFncmFtIHNob3dpbmcgdGhlIHN0YXRlIHRyYW5zaXRpb25zOlxuICAgIC8vIC0tLS0tLS0tLS0tLS0tICAgICAgICAgICAgICAgIC0tLS0tLS0tICAgIGZpbGUgY2hhbmdlZCAgICAgLS0tLS0tLS0tLS0tLS0gICAgZmlsZSBjaGFuZ2VkICAgICAtLS0tLS0tLS0tLS0tLSAgZmlsZSBjaGFuZ2VkXG4gICAgLy8gfCAgICAgICAgICAgIHwgIHJlYWR5IGV2ZW50ICAgfCAgICAgIHwgLS0tLS0tLS0tLS0tLS0tLS0tPiB8ICAgICAgICAgICAgfCAtLS0tLS0tLS0tLS0tLS0tLS0+IHwgICAgICAgICAgICB8IC0tLS0tLS0tLS0tLS0tfFxuICAgIC8vIHwgcHJlLXJlYWR5ICB8IC0tLS0tLS0tLS0tLS0+IHwgb3BlbiB8ICAgICAgICAgICAgICAgICAgICAgfCBkZXBsb3lpbmcgIHwgICAgICAgICAgICAgICAgICAgICB8ICAgcXVldWVkICAgfCAgICAgICAgICAgICAgIHxcbiAgICAvLyB8ICAgICAgICAgICAgfCAgICAgICAgICAgICAgICB8ICAgICAgfCA8LS0tLS0tLS0tLS0tLS0tLS0tIHwgICAgICAgICAgICB8IDwtLS0tLS0tLS0tLS0tLS0tLS0gfCAgICAgICAgICAgIHwgPC0tLS0tLS0tLS0tLS18XG4gICAgLy8gLS0tLS0tLS0tLS0tLS0gICAgICAgICAgICAgICAgLS0tLS0tLS0gICdjZGsgZGVwbG95JyBkb25lICAtLS0tLS0tLS0tLS0tLSAgJ2NkayBkZXBsb3knIGRvbmUgIC0tLS0tLS0tLS0tLS0tXG4gICAgbGV0IGxhdGNoOiAncHJlLXJlYWR5JyB8ICdvcGVuJyB8ICdkZXBsb3lpbmcnIHwgJ3F1ZXVlZCcgPSAncHJlLXJlYWR5JztcblxuICAgIGNvbnN0IGNsb3VkV2F0Y2hMb2dNb25pdG9yID0gb3B0aW9ucy50cmFjZUxvZ3MgPyBuZXcgQ2xvdWRXYXRjaExvZ0V2ZW50TW9uaXRvcigpIDogdW5kZWZpbmVkO1xuICAgIGNvbnN0IGRlcGxveUFuZFdhdGNoID0gYXN5bmMgKCkgPT4ge1xuICAgICAgbGF0Y2ggPSAnZGVwbG95aW5nJztcbiAgICAgIGNsb3VkV2F0Y2hMb2dNb25pdG9yPy5kZWFjdGl2YXRlKCk7XG5cbiAgICAgIGF3YWl0IHRoaXMuaW52b2tlRGVwbG95RnJvbVdhdGNoKG9wdGlvbnMsIGNsb3VkV2F0Y2hMb2dNb25pdG9yKTtcblxuICAgICAgLy8gSWYgbGF0Y2ggaXMgc3RpbGwgJ2RlcGxveWluZycgYWZ0ZXIgdGhlICdhd2FpdCcsIHRoYXQncyBmaW5lLFxuICAgICAgLy8gYnV0IGlmIGl0J3MgJ3F1ZXVlZCcsIHRoYXQgbWVhbnMgd2UgbmVlZCB0byBkZXBsb3kgYWdhaW5cbiAgICAgIHdoaWxlICgobGF0Y2ggYXMgJ2RlcGxveWluZycgfCAncXVldWVkJykgPT09ICdxdWV1ZWQnKSB7XG4gICAgICAgIC8vIFR5cGVTY3JpcHQgZG9lc24ndCByZWFsaXplIGxhdGNoIGNhbiBjaGFuZ2UgYmV0d2VlbiAnYXdhaXRzJyxcbiAgICAgICAgLy8gYW5kIHRoaW5rcyB0aGUgYWJvdmUgJ3doaWxlJyBjb25kaXRpb24gaXMgYWx3YXlzICdmYWxzZScgd2l0aG91dCB0aGUgY2FzdFxuICAgICAgICBsYXRjaCA9ICdkZXBsb3lpbmcnO1xuICAgICAgICBwcmludChcIkRldGVjdGVkIGZpbGUgY2hhbmdlcyBkdXJpbmcgZGVwbG95bWVudC4gSW52b2tpbmcgJ2NkayBkZXBsb3knIGFnYWluXCIpO1xuICAgICAgICBhd2FpdCB0aGlzLmludm9rZURlcGxveUZyb21XYXRjaChvcHRpb25zLCBjbG91ZFdhdGNoTG9nTW9uaXRvcik7XG4gICAgICB9XG4gICAgICBsYXRjaCA9ICdvcGVuJztcbiAgICAgIGNsb3VkV2F0Y2hMb2dNb25pdG9yPy5hY3RpdmF0ZSgpO1xuICAgIH07XG5cbiAgICBjaG9raWRhclxuICAgICAgLndhdGNoKHdhdGNoSW5jbHVkZXMsIHtcbiAgICAgICAgaWdub3JlZDogd2F0Y2hFeGNsdWRlcyxcbiAgICAgICAgY3dkOiByb290RGlyLFxuICAgICAgICAvLyBpZ25vcmVJbml0aWFsOiB0cnVlLFxuICAgICAgfSlcbiAgICAgIC5vbigncmVhZHknLCBhc3luYyAoKSA9PiB7XG4gICAgICAgIGxhdGNoID0gJ29wZW4nO1xuICAgICAgICBkZWJ1ZyhcIid3YXRjaCcgcmVjZWl2ZWQgdGhlICdyZWFkeScgZXZlbnQuIEZyb20gbm93IG9uLCBhbGwgZmlsZSBjaGFuZ2VzIHdpbGwgdHJpZ2dlciBhIGRlcGxveW1lbnRcIik7XG4gICAgICAgIHByaW50KFwiVHJpZ2dlcmluZyBpbml0aWFsICdjZGsgZGVwbG95J1wiKTtcbiAgICAgICAgYXdhaXQgZGVwbG95QW5kV2F0Y2goKTtcbiAgICAgIH0pXG4gICAgICAub24oJ2FsbCcsIGFzeW5jIChldmVudDogJ2FkZCcgfCAnYWRkRGlyJyB8ICdjaGFuZ2UnIHwgJ3VubGluaycgfCAndW5saW5rRGlyJywgZmlsZVBhdGg/OiBzdHJpbmcpID0+IHtcbiAgICAgICAgaWYgKGxhdGNoID09PSAncHJlLXJlYWR5Jykge1xuICAgICAgICAgIHByaW50KGAnd2F0Y2gnIGlzIG9ic2VydmluZyAke2V2ZW50ID09PSAnYWRkRGlyJyA/ICdkaXJlY3RvcnknIDogJ3RoZSBmaWxlJ30gJyVzJyBmb3IgY2hhbmdlc2AsIGZpbGVQYXRoKTtcbiAgICAgICAgfSBlbHNlIGlmIChsYXRjaCA9PT0gJ29wZW4nKSB7XG4gICAgICAgICAgcHJpbnQoXCJEZXRlY3RlZCBjaGFuZ2UgdG8gJyVzJyAodHlwZTogJXMpLiBUcmlnZ2VyaW5nICdjZGsgZGVwbG95J1wiLCBmaWxlUGF0aCwgZXZlbnQpO1xuICAgICAgICAgIGF3YWl0IGRlcGxveUFuZFdhdGNoKCk7XG4gICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgLy8gdGhpcyBtZWFucyBsYXRjaCBpcyBlaXRoZXIgJ2RlcGxveWluZycgb3IgJ3F1ZXVlZCdcbiAgICAgICAgICBsYXRjaCA9ICdxdWV1ZWQnO1xuICAgICAgICAgIHByaW50KFxuICAgICAgICAgICAgXCJEZXRlY3RlZCBjaGFuZ2UgdG8gJyVzJyAodHlwZTogJXMpIHdoaWxlICdjZGsgZGVwbG95JyBpcyBzdGlsbCBydW5uaW5nLiBcIiArXG4gICAgICAgICAgICAgICdXaWxsIHF1ZXVlIGZvciBhbm90aGVyIGRlcGxveW1lbnQgYWZ0ZXIgdGhpcyBvbmUgZmluaXNoZXMnLFxuICAgICAgICAgICAgZmlsZVBhdGgsXG4gICAgICAgICAgICBldmVudCxcbiAgICAgICAgICApO1xuICAgICAgICB9XG4gICAgICB9KTtcbiAgfVxuXG4gIHB1YmxpYyBhc3luYyBpbXBvcnQob3B0aW9uczogSW1wb3J0T3B0aW9ucykge1xuICAgIGNvbnN0IHN0YWNrcyA9IGF3YWl0IHRoaXMuc2VsZWN0U3RhY2tzRm9yRGVwbG95KG9wdGlvbnMuc2VsZWN0b3IsIHRydWUsIHRydWUsIGZhbHNlKTtcblxuICAgIGlmIChzdGFja3Muc3RhY2tDb3VudCA+IDEpIHtcbiAgICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgICAgYFN0YWNrIHNlbGVjdGlvbiBpcyBhbWJpZ3VvdXMsIHBsZWFzZSBjaG9vc2UgYSBzcGVjaWZpYyBzdGFjayBmb3IgaW1wb3J0IFske3N0YWNrcy5zdGFja0FydGlmYWN0cy5tYXAoKHgpID0+IHguaWQpLmpvaW4oJywgJyl9XWAsXG4gICAgICApO1xuICAgIH1cblxuICAgIGlmICghcHJvY2Vzcy5zdGRvdXQuaXNUVFkgJiYgIW9wdGlvbnMucmVzb3VyY2VNYXBwaW5nRmlsZSkge1xuICAgICAgdGhyb3cgbmV3IEVycm9yKCctLXJlc291cmNlLW1hcHBpbmcgaXMgcmVxdWlyZWQgd2hlbiBpbnB1dCBpcyBub3QgYSB0ZXJtaW5hbCcpO1xuICAgIH1cblxuICAgIGNvbnN0IHN0YWNrID0gc3RhY2tzLnN0YWNrQXJ0aWZhY3RzWzBdO1xuXG4gICAgaGlnaGxpZ2h0KHN0YWNrLmRpc3BsYXlOYW1lKTtcblxuICAgIGNvbnN0IHJlc291cmNlSW1wb3J0ZXIgPSBuZXcgUmVzb3VyY2VJbXBvcnRlcihzdGFjaywgdGhpcy5wcm9wcy5kZXBsb3ltZW50cyk7XG4gICAgY29uc3QgeyBhZGRpdGlvbnMsIGhhc05vbkFkZGl0aW9ucyB9ID0gYXdhaXQgcmVzb3VyY2VJbXBvcnRlci5kaXNjb3ZlckltcG9ydGFibGVSZXNvdXJjZXMob3B0aW9ucy5mb3JjZSk7XG4gICAgaWYgKGFkZGl0aW9ucy5sZW5ndGggPT09IDApIHtcbiAgICAgIHdhcm5pbmcoXG4gICAgICAgICclczogbm8gbmV3IHJlc291cmNlcyBjb21wYXJlZCB0byB0aGUgY3VycmVudGx5IGRlcGxveWVkIHN0YWNrLCBza2lwcGluZyBpbXBvcnQuJyxcbiAgICAgICAgY2hhbGsuYm9sZChzdGFjay5kaXNwbGF5TmFtZSksXG4gICAgICApO1xuICAgICAgcmV0dXJuO1xuICAgIH1cblxuICAgIC8vIFByZXBhcmUgYSBtYXBwaW5nIG9mIHBoeXNpY2FsIHJlc291cmNlcyB0byBDREsgY29uc3RydWN0c1xuICAgIGNvbnN0IGFjdHVhbEltcG9ydCA9ICFvcHRpb25zLnJlc291cmNlTWFwcGluZ0ZpbGVcbiAgICAgID8gYXdhaXQgcmVzb3VyY2VJbXBvcnRlci5hc2tGb3JSZXNvdXJjZUlkZW50aWZpZXJzKGFkZGl0aW9ucylcbiAgICAgIDogYXdhaXQgcmVzb3VyY2VJbXBvcnRlci5sb2FkUmVzb3VyY2VJZGVudGlmaWVycyhhZGRpdGlvbnMsIG9wdGlvbnMucmVzb3VyY2VNYXBwaW5nRmlsZSk7XG5cbiAgICBpZiAoYWN0dWFsSW1wb3J0LmltcG9ydFJlc291cmNlcy5sZW5ndGggPT09IDApIHtcbiAgICAgIHdhcm5pbmcoJ05vIHJlc291cmNlcyBzZWxlY3RlZCBmb3IgaW1wb3J0LicpO1xuICAgICAgcmV0dXJuO1xuICAgIH1cblxuICAgIC8vIElmIFwiLS1jcmVhdGUtcmVzb3VyY2UtbWFwcGluZ1wiIG9wdGlvbiB3YXMgcGFzc2VkLCB3cml0ZSB0aGUgcmVzb3VyY2UgbWFwcGluZyB0byB0aGUgZ2l2ZW4gZmlsZSBhbmQgZXhpdFxuICAgIGlmIChvcHRpb25zLnJlY29yZFJlc291cmNlTWFwcGluZykge1xuICAgICAgY29uc3Qgb3V0cHV0RmlsZSA9IG9wdGlvbnMucmVjb3JkUmVzb3VyY2VNYXBwaW5nO1xuICAgICAgZnMuZW5zdXJlRmlsZVN5bmMob3V0cHV0RmlsZSk7XG4gICAgICBhd2FpdCBmcy53cml0ZUpzb24ob3V0cHV0RmlsZSwgYWN0dWFsSW1wb3J0LnJlc291cmNlTWFwLCB7XG4gICAgICAgIHNwYWNlczogMixcbiAgICAgICAgZW5jb2Rpbmc6ICd1dGY4JyxcbiAgICAgIH0pO1xuICAgICAgcHJpbnQoJyVzOiBtYXBwaW5nIGZpbGUgd3JpdHRlbi4nLCBvdXRwdXRGaWxlKTtcbiAgICAgIHJldHVybjtcbiAgICB9XG5cbiAgICAvLyBJbXBvcnQgdGhlIHJlc291cmNlcyBhY2NvcmRpbmcgdG8gdGhlIGdpdmVuIG1hcHBpbmdcbiAgICBwcmludCgnJXM6IGltcG9ydGluZyByZXNvdXJjZXMgaW50byBzdGFjay4uLicsIGNoYWxrLmJvbGQoc3RhY2suZGlzcGxheU5hbWUpKTtcbiAgICBjb25zdCB0YWdzID0gdGFnc0ZvclN0YWNrKHN0YWNrKTtcbiAgICBhd2FpdCByZXNvdXJjZUltcG9ydGVyLmltcG9ydFJlc291cmNlc0Zyb21NYXAoYWN0dWFsSW1wb3J0LCB7XG4gICAgICByb2xlQXJuOiBvcHRpb25zLnJvbGVBcm4sXG4gICAgICB0b29sa2l0U3RhY2tOYW1lOiBvcHRpb25zLnRvb2xraXRTdGFja05hbWUsXG4gICAgICB0YWdzLFxuICAgICAgZGVwbG95bWVudE1ldGhvZDogb3B0aW9ucy5kZXBsb3ltZW50TWV0aG9kLFxuICAgICAgdXNlUHJldmlvdXNQYXJhbWV0ZXJzOiB0cnVlLFxuICAgICAgcHJvZ3Jlc3M6IG9wdGlvbnMucHJvZ3Jlc3MsXG4gICAgICByb2xsYmFjazogb3B0aW9ucy5yb2xsYmFjayxcbiAgICB9KTtcblxuICAgIC8vIE5vdGlmeSB1c2VyIG9mIG5leHQgc3RlcHNcbiAgICBwcmludChcbiAgICAgIGBJbXBvcnQgb3BlcmF0aW9uIGNvbXBsZXRlLiBXZSByZWNvbW1lbmQgeW91IHJ1biBhICR7Y2hhbGsuYmx1ZUJyaWdodCgnZHJpZnQgZGV0ZWN0aW9uJyl9IG9wZXJhdGlvbiBgICtcbiAgICAgICAgJ3RvIGNvbmZpcm0geW91ciBDREsgYXBwIHJlc291cmNlIGRlZmluaXRpb25zIGFyZSB1cC10by1kYXRlLiBSZWFkIG1vcmUgaGVyZTogJyArXG4gICAgICAgIGNoYWxrLnVuZGVybGluZS5ibHVlQnJpZ2h0KFxuICAgICAgICAgICdodHRwczovL2RvY3MuYXdzLmFtYXpvbi5jb20vQVdTQ2xvdWRGb3JtYXRpb24vbGF0ZXN0L1VzZXJHdWlkZS9kZXRlY3QtZHJpZnQtc3RhY2suaHRtbCcsXG4gICAgICAgICksXG4gICAgKTtcbiAgICBpZiAoYWN0dWFsSW1wb3J0LmltcG9ydFJlc291cmNlcy5sZW5ndGggPCBhZGRpdGlvbnMubGVuZ3RoKSB7XG4gICAgICBwcmludCgnJyk7XG4gICAgICB3YXJuaW5nKFxuICAgICAgICBgU29tZSByZXNvdXJjZXMgd2VyZSBza2lwcGVkLiBSdW4gYW5vdGhlciAke2NoYWxrLmJsdWVCcmlnaHQoJ2NkayBpbXBvcnQnKX0gb3IgYSAke2NoYWxrLmJsdWVCcmlnaHQoJ2NkayBkZXBsb3knKX0gdG8gYnJpbmcgdGhlIHN0YWNrIHVwLXRvLWRhdGUgd2l0aCB5b3VyIENESyBhcHAgZGVmaW5pdGlvbi5gLFxuICAgICAgKTtcbiAgICB9IGVsc2UgaWYgKGhhc05vbkFkZGl0aW9ucykge1xuICAgICAgcHJpbnQoJycpO1xuICAgICAgd2FybmluZyhcbiAgICAgICAgYFlvdXIgYXBwIGhhcyBwZW5kaW5nIHVwZGF0ZXMgb3IgZGVsZXRlcyBleGNsdWRlZCBmcm9tIHRoaXMgaW1wb3J0IG9wZXJhdGlvbi4gUnVuIGEgJHtjaGFsay5ibHVlQnJpZ2h0KCdjZGsgZGVwbG95Jyl9IHRvIGJyaW5nIHRoZSBzdGFjayB1cC10by1kYXRlIHdpdGggeW91ciBDREsgYXBwIGRlZmluaXRpb24uYCxcbiAgICAgICk7XG4gICAgfVxuICB9XG5cbiAgcHVibGljIGFzeW5jIGRlc3Ryb3kob3B0aW9uczogRGVzdHJveU9wdGlvbnMpIHtcbiAgICBsZXQgc3RhY2tzID0gYXdhaXQgdGhpcy5zZWxlY3RTdGFja3NGb3JEZXN0cm95KG9wdGlvbnMuc2VsZWN0b3IsIG9wdGlvbnMuZXhjbHVzaXZlbHkpO1xuXG4gICAgLy8gVGhlIHN0YWNrcyB3aWxsIGhhdmUgYmVlbiBvcmRlcmVkIGZvciBkZXBsb3ltZW50LCBzbyByZXZlcnNlIHRoZW0gZm9yIGRlbGV0aW9uLlxuICAgIHN0YWNrcyA9IHN0YWNrcy5yZXZlcnNlZCgpO1xuXG4gICAgaWYgKCFvcHRpb25zLmZvcmNlKSB7XG4gICAgICAvLyBlc2xpbnQtZGlzYWJsZS1uZXh0LWxpbmUgbWF4LWxlblxuICAgICAgY29uc3QgY29uZmlybWVkID0gYXdhaXQgcHJvbXB0bHkuY29uZmlybShcbiAgICAgICAgYEFyZSB5b3Ugc3VyZSB5b3Ugd2FudCB0byBkZWxldGU6ICR7Y2hhbGsuYmx1ZShzdGFja3Muc3RhY2tBcnRpZmFjdHMubWFwKChzKSA9PiBzLmhpZXJhcmNoaWNhbElkKS5qb2luKCcsICcpKX0gKHkvbik/YCxcbiAgICAgICk7XG4gICAgICBpZiAoIWNvbmZpcm1lZCkge1xuICAgICAgICByZXR1cm47XG4gICAgICB9XG4gICAgfVxuXG4gICAgY29uc3QgYWN0aW9uID0gb3B0aW9ucy5mcm9tRGVwbG95ID8gJ2RlcGxveScgOiAnZGVzdHJveSc7XG4gICAgZm9yIChjb25zdCBbaW5kZXgsIHN0YWNrXSBvZiBzdGFja3Muc3RhY2tBcnRpZmFjdHMuZW50cmllcygpKSB7XG4gICAgICBzdWNjZXNzKCclczogZGVzdHJveWluZy4uLiBbJXMvJXNdJywgY2hhbGsuYmx1ZShzdGFjay5kaXNwbGF5TmFtZSksIGluZGV4ICsgMSwgc3RhY2tzLnN0YWNrQ291bnQpO1xuICAgICAgdHJ5IHtcbiAgICAgICAgYXdhaXQgdGhpcy5wcm9wcy5kZXBsb3ltZW50cy5kZXN0cm95U3RhY2soe1xuICAgICAgICAgIHN0YWNrLFxuICAgICAgICAgIGRlcGxveU5hbWU6IHN0YWNrLnN0YWNrTmFtZSxcbiAgICAgICAgICByb2xlQXJuOiBvcHRpb25zLnJvbGVBcm4sXG4gICAgICAgICAgY2k6IG9wdGlvbnMuY2ksXG4gICAgICAgIH0pO1xuICAgICAgICBzdWNjZXNzKGBcXG4g4pyFICAlczogJHthY3Rpb259ZWRgLCBjaGFsay5ibHVlKHN0YWNrLmRpc3BsYXlOYW1lKSk7XG4gICAgICB9IGNhdGNoIChlKSB7XG4gICAgICAgIGVycm9yKGBcXG4g4p2MICAlczogJHthY3Rpb259IGZhaWxlZGAsIGNoYWxrLmJsdWUoc3RhY2suZGlzcGxheU5hbWUpLCBlKTtcbiAgICAgICAgdGhyb3cgZTtcbiAgICAgIH1cbiAgICB9XG4gIH1cblxuICBwdWJsaWMgYXN5bmMgbGlzdChcbiAgICBzZWxlY3RvcnM6IHN0cmluZ1tdLFxuICAgIG9wdGlvbnM6IHsgbG9uZz86IGJvb2xlYW47IGpzb24/OiBib29sZWFuOyBzaG93RGVwcz86IGJvb2xlYW4gfSA9IHt9LFxuICApOiBQcm9taXNlPG51bWJlcj4ge1xuICAgIGNvbnN0IHN0YWNrcyA9IGF3YWl0IGxpc3RTdGFja3ModGhpcywge1xuICAgICAgc2VsZWN0b3JzOiBzZWxlY3RvcnMsXG4gICAgfSk7XG5cbiAgICBpZiAob3B0aW9ucy5sb25nICYmIG9wdGlvbnMuc2hvd0RlcHMpIHtcbiAgICAgIHByaW50U2VyaWFsaXplZE9iamVjdChzdGFja3MsIG9wdGlvbnMuanNvbiA/PyBmYWxzZSk7XG4gICAgICByZXR1cm4gMDtcbiAgICB9XG5cbiAgICBpZiAob3B0aW9ucy5zaG93RGVwcykge1xuICAgICAgY29uc3Qgc3RhY2tEZXBzID0gW107XG5cbiAgICAgIGZvciAoY29uc3Qgc3RhY2sgb2Ygc3RhY2tzKSB7XG4gICAgICAgIHN0YWNrRGVwcy5wdXNoKHtcbiAgICAgICAgICBpZDogc3RhY2suaWQsXG4gICAgICAgICAgZGVwZW5kZW5jaWVzOiBzdGFjay5kZXBlbmRlbmNpZXMsXG4gICAgICAgIH0pO1xuICAgICAgfVxuXG4gICAgICBwcmludFNlcmlhbGl6ZWRPYmplY3Qoc3RhY2tEZXBzLCBvcHRpb25zLmpzb24gPz8gZmFsc2UpO1xuICAgICAgcmV0dXJuIDA7XG4gICAgfVxuXG4gICAgaWYgKG9wdGlvbnMubG9uZykge1xuICAgICAgY29uc3QgbG9uZyA9IFtdO1xuXG4gICAgICBmb3IgKGNvbnN0IHN0YWNrIG9mIHN0YWNrcykge1xuICAgICAgICBsb25nLnB1c2goe1xuICAgICAgICAgIGlkOiBzdGFjay5pZCxcbiAgICAgICAgICBuYW1lOiBzdGFjay5uYW1lLFxuICAgICAgICAgIGVudmlyb25tZW50OiBzdGFjay5lbnZpcm9ubWVudCxcbiAgICAgICAgfSk7XG4gICAgICB9XG4gICAgICBwcmludFNlcmlhbGl6ZWRPYmplY3QobG9uZywgb3B0aW9ucy5qc29uID8/IGZhbHNlKTtcbiAgICAgIHJldHVybiAwO1xuICAgIH1cblxuICAgIC8vIGp1c3QgcHJpbnQgc3RhY2sgSURzXG4gICAgZm9yIChjb25zdCBzdGFjayBvZiBzdGFja3MpIHtcbiAgICAgIGRhdGEoc3RhY2suaWQpO1xuICAgIH1cblxuICAgIHJldHVybiAwOyAvLyBleGl0LWNvZGVcbiAgfVxuXG4gIC8qKlxuICAgKiBTeW50aGVzaXplIHRoZSBnaXZlbiBzZXQgb2Ygc3RhY2tzIChjYWxsZWQgd2hlbiB0aGUgdXNlciBydW5zICdjZGsgc3ludGgnKVxuICAgKlxuICAgKiBJTlBVVDogU3RhY2sgbmFtZXMgY2FuIGJlIHN1cHBsaWVkIHVzaW5nIGEgZ2xvYiBmaWx0ZXIuIElmIG5vIHN0YWNrcyBhcmVcbiAgICogZ2l2ZW4sIGFsbCBzdGFja3MgZnJvbSB0aGUgYXBwbGljYXRpb24gYXJlIGltcGxpY2l0bHkgc2VsZWN0ZWQuXG4gICAqXG4gICAqIE9VVFBVVDogSWYgbW9yZSB0aGFuIG9uZSBzdGFjayBlbmRzIHVwIGJlaW5nIHNlbGVjdGVkLCBhbiBvdXRwdXQgZGlyZWN0b3J5XG4gICAqIHNob3VsZCBiZSBzdXBwbGllZCwgd2hlcmUgdGhlIHRlbXBsYXRlcyB3aWxsIGJlIHdyaXR0ZW4uXG4gICAqL1xuICBwdWJsaWMgYXN5bmMgc3ludGgoXG4gICAgc3RhY2tOYW1lczogc3RyaW5nW10sXG4gICAgZXhjbHVzaXZlbHk6IGJvb2xlYW4sXG4gICAgcXVpZXQ6IGJvb2xlYW4sXG4gICAgYXV0b1ZhbGlkYXRlPzogYm9vbGVhbixcbiAgICBqc29uPzogYm9vbGVhbixcbiAgKTogUHJvbWlzZTxhbnk+IHtcbiAgICBjb25zdCBzdGFja3MgPSBhd2FpdCB0aGlzLnNlbGVjdFN0YWNrc0ZvckRpZmYoc3RhY2tOYW1lcywgZXhjbHVzaXZlbHksIGF1dG9WYWxpZGF0ZSk7XG5cbiAgICAvLyBpZiB3ZSBoYXZlIGEgc2luZ2xlIHN0YWNrLCBwcmludCBpdCB0byBTVERPVVRcbiAgICBpZiAoc3RhY2tzLnN0YWNrQ291bnQgPT09IDEpIHtcbiAgICAgIGlmICghcXVpZXQpIHtcbiAgICAgICAgcHJpbnRTZXJpYWxpemVkT2JqZWN0KG9ic2N1cmVUZW1wbGF0ZShzdGFja3MuZmlyc3RTdGFjay50ZW1wbGF0ZSksIGpzb24gPz8gZmFsc2UpO1xuICAgICAgfVxuICAgICAgcmV0dXJuIHVuZGVmaW5lZDtcbiAgICB9XG5cbiAgICAvLyBUaGlzIGlzIGEgc2xpZ2h0IGhhY2s7IGluIGludGVnIG1vZGUgd2UgYWxsb3cgbXVsdGlwbGUgc3RhY2tzIHRvIGJlIHN5bnRoZXNpemVkIHRvIHN0ZG91dCBzZXF1ZW50aWFsbHkuXG4gICAgLy8gVGhpcyBpcyB0byBtYWtlIGl0IHNvIHRoYXQgd2UgY2FuIHN1cHBvcnQgbXVsdGktc3RhY2sgaW50ZWcgdGVzdCBleHBlY3RhdGlvbnMsIHdpdGhvdXQgc28gZHJhc3RpY2FsbHlcbiAgICAvLyBoYXZpbmcgdG8gY2hhbmdlIHRoZSBzeW50aGVzaXMgZm9ybWF0IHRoYXQgd2UgaGF2ZSB0byByZXJ1biBhbGwgaW50ZWcgdGVzdHMuXG4gICAgLy9cbiAgICAvLyBCZWNhdXNlIHRoaXMgZmVhdHVyZSBpcyBub3QgdXNlZnVsIHRvIGNvbnN1bWVycyAodGhlIG91dHB1dCBpcyBtaXNzaW5nXG4gICAgLy8gdGhlIHN0YWNrIG5hbWVzKSwgaXQncyBub3QgZXhwb3NlZCBhcyBhIENMSSBmbGFnLiBJbnN0ZWFkLCBpdCdzIGhpZGRlblxuICAgIC8vIGJlaGluZCBhbiBlbnZpcm9ubWVudCB2YXJpYWJsZS5cbiAgICBjb25zdCBpc0ludGVnTW9kZSA9IHByb2Nlc3MuZW52LkNES19JTlRFR19NT0RFID09PSAnMSc7XG4gICAgaWYgKGlzSW50ZWdNb2RlKSB7XG4gICAgICBwcmludFNlcmlhbGl6ZWRPYmplY3QoXG4gICAgICAgIHN0YWNrcy5zdGFja0FydGlmYWN0cy5tYXAoKHMpID0+IG9ic2N1cmVUZW1wbGF0ZShzLnRlbXBsYXRlKSksXG4gICAgICAgIGpzb24gPz8gZmFsc2UsXG4gICAgICApO1xuICAgIH1cblxuICAgIC8vIG5vdCBvdXRwdXR0aW5nIHRlbXBsYXRlIHRvIHN0ZG91dCwgbGV0J3MgZXhwbGFpbiB0aGluZ3MgdG8gdGhlIHVzZXIgYSBsaXR0bGUgYml0Li4uXG4gICAgc3VjY2VzcyhgU3VjY2Vzc2Z1bGx5IHN5bnRoZXNpemVkIHRvICR7Y2hhbGsuYmx1ZShwYXRoLnJlc29sdmUoc3RhY2tzLmFzc2VtYmx5LmRpcmVjdG9yeSkpfWApO1xuICAgIHByaW50KFxuICAgICAgYFN1cHBseSBhIHN0YWNrIGlkICgke3N0YWNrcy5zdGFja0FydGlmYWN0cy5tYXAoKHMpID0+IGNoYWxrLmdyZWVuKHMuaGllcmFyY2hpY2FsSWQpKS5qb2luKCcsICcpfSkgdG8gZGlzcGxheSBpdHMgdGVtcGxhdGUuYCxcbiAgICApO1xuXG4gICAgcmV0dXJuIHVuZGVmaW5lZDtcbiAgfVxuXG4gIC8qKlxuICAgKiBCb290c3RyYXAgdGhlIENESyBUb29sa2l0IHN0YWNrIGluIHRoZSBhY2NvdW50cyB1c2VkIGJ5IHRoZSBzcGVjaWZpZWQgc3RhY2socykuXG4gICAqXG4gICAqIEBwYXJhbSB1c2VyRW52aXJvbm1lbnRTcGVjcyBlbnZpcm9ubWVudCBuYW1lcyB0aGF0IG5lZWQgdG8gaGF2ZSB0b29sa2l0IHN1cHBvcnRcbiAgICogICAgICAgICAgICAgcHJvdmlzaW9uZWQsIGFzIGEgZ2xvYiBmaWx0ZXIuIElmIG5vbmUgaXMgcHJvdmlkZWQsIGFsbCBzdGFja3MgYXJlIGltcGxpY2l0bHkgc2VsZWN0ZWQuXG4gICAqIEBwYXJhbSBib290c3RyYXBwZXIgTGVnYWN5IG9yIG1vZGVybi5cbiAgICogQHBhcmFtIG9wdGlvbnMgVGhlIG5hbWUsIHJvbGUgQVJOLCBib290c3RyYXBwaW5nIHBhcmFtZXRlcnMsIGV0Yy4gdG8gYmUgdXNlZCBmb3IgdGhlIENESyBUb29sa2l0IHN0YWNrLlxuICAgKi9cbiAgcHVibGljIGFzeW5jIGJvb3RzdHJhcChcbiAgICB1c2VyRW52aXJvbm1lbnRTcGVjczogc3RyaW5nW10sXG4gICAgYm9vdHN0cmFwcGVyOiBCb290c3RyYXBwZXIsXG4gICAgb3B0aW9uczogQm9vdHN0cmFwRW52aXJvbm1lbnRPcHRpb25zLFxuICApOiBQcm9taXNlPHZvaWQ+IHtcbiAgICAvLyBJZiB0aGVyZSBpcyBhbiAnLS1hcHAnIGFyZ3VtZW50IGFuZCBhbiBlbnZpcm9ubWVudCBsb29rcyBsaWtlIGEgZ2xvYiwgd2VcbiAgICAvLyBzZWxlY3QgdGhlIGVudmlyb25tZW50cyBmcm9tIHRoZSBhcHAuIE90aGVyd2lzZSwgdXNlIHdoYXQgdGhlIHVzZXIgc2FpZC5cblxuICAgIGNvbnN0IGVudmlyb25tZW50cyA9IGF3YWl0IHRoaXMuZGVmaW5lRW52aXJvbm1lbnRzKHVzZXJFbnZpcm9ubWVudFNwZWNzKTtcblxuICAgIGNvbnN0IGxpbWl0ID0gcExpbWl0KDIwKTtcblxuICAgIC8vIGVzbGludC1kaXNhYmxlLW5leHQtbGluZSBAY2RrbGFicy9wcm9taXNlYWxsLW5vLXVuYm91bmRlZC1wYXJhbGxlbGlzbVxuICAgIGF3YWl0IFByb21pc2UuYWxsKGVudmlyb25tZW50cy5tYXAoKGVudmlyb25tZW50KSA9PiBsaW1pdChhc3luYyAoKSA9PiB7XG4gICAgICBzdWNjZXNzKCcg4o+zICBCb290c3RyYXBwaW5nIGVudmlyb25tZW50ICVzLi4uJywgY2hhbGsuYmx1ZShlbnZpcm9ubWVudC5uYW1lKSk7XG4gICAgICB0cnkge1xuICAgICAgICBjb25zdCByZXN1bHQgPSBhd2FpdCBib290c3RyYXBwZXIuYm9vdHN0cmFwRW52aXJvbm1lbnQoZW52aXJvbm1lbnQsIHRoaXMucHJvcHMuc2RrUHJvdmlkZXIsIG9wdGlvbnMpO1xuICAgICAgICBjb25zdCBtZXNzYWdlID0gcmVzdWx0Lm5vT3BcbiAgICAgICAgICA/ICcg4pyFICBFbnZpcm9ubWVudCAlcyBib290c3RyYXBwZWQgKG5vIGNoYW5nZXMpLidcbiAgICAgICAgICA6ICcg4pyFICBFbnZpcm9ubWVudCAlcyBib290c3RyYXBwZWQuJztcbiAgICAgICAgc3VjY2VzcyhtZXNzYWdlLCBjaGFsay5ibHVlKGVudmlyb25tZW50Lm5hbWUpKTtcbiAgICAgIH0gY2F0Y2ggKGUpIHtcbiAgICAgICAgZXJyb3IoJyDinYwgIEVudmlyb25tZW50ICVzIGZhaWxlZCBib290c3RyYXBwaW5nOiAlcycsIGNoYWxrLmJsdWUoZW52aXJvbm1lbnQubmFtZSksIGUpO1xuICAgICAgICB0aHJvdyBlO1xuICAgICAgfVxuICAgIH0pKSk7XG4gIH1cblxuICAvKipcbiAgICogR2FyYmFnZSBjb2xsZWN0cyBhc3NldHMgZnJvbSBhIENESyBhcHAncyBlbnZpcm9ubWVudFxuICAgKiBAcGFyYW0gb3B0aW9ucyBPcHRpb25zIGZvciBHYXJiYWdlIENvbGxlY3Rpb25cbiAgICovXG4gIHB1YmxpYyBhc3luYyBnYXJiYWdlQ29sbGVjdCh1c2VyRW52aXJvbm1lbnRTcGVjczogc3RyaW5nW10sIG9wdGlvbnM6IEdhcmJhZ2VDb2xsZWN0aW9uT3B0aW9ucykge1xuICAgIGNvbnN0IGVudmlyb25tZW50cyA9IGF3YWl0IHRoaXMuZGVmaW5lRW52aXJvbm1lbnRzKHVzZXJFbnZpcm9ubWVudFNwZWNzKTtcblxuICAgIGZvciAoY29uc3QgZW52aXJvbm1lbnQgb2YgZW52aXJvbm1lbnRzKSB7XG4gICAgICBzdWNjZXNzKCcg4o+zICBHYXJiYWdlIENvbGxlY3RpbmcgZW52aXJvbm1lbnQgJXMuLi4nLCBjaGFsay5ibHVlKGVudmlyb25tZW50Lm5hbWUpKTtcbiAgICAgIGNvbnN0IGdjID0gbmV3IEdhcmJhZ2VDb2xsZWN0b3Ioe1xuICAgICAgICBzZGtQcm92aWRlcjogdGhpcy5wcm9wcy5zZGtQcm92aWRlcixcbiAgICAgICAgcmVzb2x2ZWRFbnZpcm9ubWVudDogZW52aXJvbm1lbnQsXG4gICAgICAgIGJvb3RzdHJhcFN0YWNrTmFtZTogb3B0aW9ucy5ib290c3RyYXBTdGFja05hbWUsXG4gICAgICAgIHJvbGxiYWNrQnVmZmVyRGF5czogb3B0aW9ucy5yb2xsYmFja0J1ZmZlckRheXMsXG4gICAgICAgIGNyZWF0ZWRCdWZmZXJEYXlzOiBvcHRpb25zLmNyZWF0ZWRCdWZmZXJEYXlzLFxuICAgICAgICBhY3Rpb246IG9wdGlvbnMuYWN0aW9uID8/ICdmdWxsJyxcbiAgICAgICAgdHlwZTogb3B0aW9ucy50eXBlID8/ICdhbGwnLFxuICAgICAgICBjb25maXJtOiBvcHRpb25zLmNvbmZpcm0gPz8gdHJ1ZSxcbiAgICAgIH0pO1xuICAgICAgYXdhaXQgZ2MuZ2FyYmFnZUNvbGxlY3QoKTtcbiAgICB9O1xuICB9XG5cbiAgcHJpdmF0ZSBhc3luYyBkZWZpbmVFbnZpcm9ubWVudHModXNlckVudmlyb25tZW50U3BlY3M6IHN0cmluZ1tdKTogUHJvbWlzZTxjeGFwaS5FbnZpcm9ubWVudFtdPiB7XG4gICAgLy8gQnkgZGVmYXVsdCwgZ2xvYiBmb3IgZXZlcnl0aGluZ1xuICAgIGNvbnN0IGVudmlyb25tZW50U3BlY3MgPSB1c2VyRW52aXJvbm1lbnRTcGVjcy5sZW5ndGggPiAwID8gWy4uLnVzZXJFbnZpcm9ubWVudFNwZWNzXSA6IFsnKionXTtcblxuICAgIC8vIFBhcnRpdGlvbiBpbnRvIGdsb2JzIGFuZCBub24tZ2xvYnMgKHRoaXMgd2lsbCBtdXRhdGUgZW52aXJvbm1lbnRTcGVjcykuXG4gICAgY29uc3QgZ2xvYlNwZWNzID0gcGFydGl0aW9uKGVudmlyb25tZW50U3BlY3MsIGxvb2tzTGlrZUdsb2IpO1xuICAgIGlmIChnbG9iU3BlY3MubGVuZ3RoID4gMCAmJiAhdGhpcy5wcm9wcy5jbG91ZEV4ZWN1dGFibGUuaGFzQXBwKSB7XG4gICAgICBpZiAodXNlckVudmlyb25tZW50U3BlY3MubGVuZ3RoID4gMCkge1xuICAgICAgICAvLyBVc2VyIGRpZCByZXF1ZXN0IHRoaXMgZ2xvYlxuICAgICAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICAgICAgYCcke2dsb2JTcGVjc30nIGlzIG5vdCBhbiBlbnZpcm9ubWVudCBuYW1lLiBTcGVjaWZ5IGFuIGVudmlyb25tZW50IG5hbWUgbGlrZSAnYXdzOi8vMTIzNDU2Nzg5MDEyL3VzLWVhc3QtMScsIG9yIHJ1biBpbiBhIGRpcmVjdG9yeSB3aXRoICdjZGsuanNvbicgdG8gdXNlIHdpbGRjYXJkcy5gLFxuICAgICAgICApO1xuICAgICAgfSBlbHNlIHtcbiAgICAgICAgLy8gVXNlciBkaWQgbm90IHJlcXVlc3QgYW55dGhpbmdcbiAgICAgICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgICAgIFwiU3BlY2lmeSBhbiBlbnZpcm9ubWVudCBuYW1lIGxpa2UgJ2F3czovLzEyMzQ1Njc4OTAxMi91cy1lYXN0LTEnLCBvciBydW4gaW4gYSBkaXJlY3Rvcnkgd2l0aCAnY2RrLmpzb24nLlwiLFxuICAgICAgICApO1xuICAgICAgfVxuICAgIH1cblxuICAgIGNvbnN0IGVudmlyb25tZW50czogY3hhcGkuRW52aXJvbm1lbnRbXSA9IFsuLi5lbnZpcm9ubWVudHNGcm9tRGVzY3JpcHRvcnMoZW52aXJvbm1lbnRTcGVjcyldO1xuXG4gICAgLy8gSWYgdGhlcmUgaXMgYW4gJy0tYXBwJyBhcmd1bWVudCwgc2VsZWN0IHRoZSBlbnZpcm9ubWVudHMgZnJvbSB0aGUgYXBwLlxuICAgIGlmICh0aGlzLnByb3BzLmNsb3VkRXhlY3V0YWJsZS5oYXNBcHApIHtcbiAgICAgIGVudmlyb25tZW50cy5wdXNoKFxuICAgICAgICAuLi4oYXdhaXQgZ2xvYkVudmlyb25tZW50c0Zyb21TdGFja3MoYXdhaXQgdGhpcy5zZWxlY3RTdGFja3NGb3JMaXN0KFtdKSwgZ2xvYlNwZWNzLCB0aGlzLnByb3BzLnNka1Byb3ZpZGVyKSksXG4gICAgICApO1xuICAgIH1cblxuICAgIHJldHVybiBlbnZpcm9ubWVudHM7XG4gIH1cblxuICAvKipcbiAgICogTWlncmF0ZXMgYSBDbG91ZEZvcm1hdGlvbiBzdGFjay90ZW1wbGF0ZSB0byBhIENESyBhcHBcbiAgICogQHBhcmFtIG9wdGlvbnMgT3B0aW9ucyBmb3IgQ0RLIGFwcCBjcmVhdGlvblxuICAgKi9cbiAgcHVibGljIGFzeW5jIG1pZ3JhdGUob3B0aW9uczogTWlncmF0ZU9wdGlvbnMpOiBQcm9taXNlPHZvaWQ+IHtcbiAgICB3YXJuaW5nKCdUaGlzIGNvbW1hbmQgaXMgYW4gZXhwZXJpbWVudGFsIGZlYXR1cmUuJyk7XG4gICAgY29uc3QgbGFuZ3VhZ2UgPSBvcHRpb25zLmxhbmd1YWdlPy50b0xvd2VyQ2FzZSgpID8/ICd0eXBlc2NyaXB0JztcbiAgICBjb25zdCBlbnZpcm9ubWVudCA9IHNldEVudmlyb25tZW50KG9wdGlvbnMuYWNjb3VudCwgb3B0aW9ucy5yZWdpb24pO1xuICAgIGxldCBnZW5lcmF0ZVRlbXBsYXRlT3V0cHV0OiBHZW5lcmF0ZVRlbXBsYXRlT3V0cHV0IHwgdW5kZWZpbmVkO1xuICAgIGxldCBjZm46IENmblRlbXBsYXRlR2VuZXJhdG9yUHJvdmlkZXIgfCB1bmRlZmluZWQ7XG4gICAgbGV0IHRlbXBsYXRlVG9EZWxldGU6IHN0cmluZyB8IHVuZGVmaW5lZDtcblxuICAgIHRyeSB7XG4gICAgICAvLyBpZiBuZWl0aGVyIGZyb21QYXRoIG5vciBmcm9tU3RhY2sgaXMgcHJvdmlkZWQsIGdlbmVyYXRlIGEgdGVtcGxhdGUgdXNpbmcgY2xvdWRmb3JtYXRpb25cbiAgICAgIGNvbnN0IHNjYW5UeXBlID0gcGFyc2VTb3VyY2VPcHRpb25zKG9wdGlvbnMuZnJvbVBhdGgsIG9wdGlvbnMuZnJvbVN0YWNrLCBvcHRpb25zLnN0YWNrTmFtZSkuc291cmNlO1xuICAgICAgaWYgKHNjYW5UeXBlID09IFRlbXBsYXRlU291cmNlT3B0aW9ucy5TQ0FOKSB7XG4gICAgICAgIGdlbmVyYXRlVGVtcGxhdGVPdXRwdXQgPSBhd2FpdCBnZW5lcmF0ZVRlbXBsYXRlKHtcbiAgICAgICAgICBzdGFja05hbWU6IG9wdGlvbnMuc3RhY2tOYW1lLFxuICAgICAgICAgIGZpbHRlcnM6IG9wdGlvbnMuZmlsdGVyLFxuICAgICAgICAgIGZyb21TY2FuOiBvcHRpb25zLmZyb21TY2FuLFxuICAgICAgICAgIHNka1Byb3ZpZGVyOiB0aGlzLnByb3BzLnNka1Byb3ZpZGVyLFxuICAgICAgICAgIGVudmlyb25tZW50OiBlbnZpcm9ubWVudCxcbiAgICAgICAgfSk7XG4gICAgICAgIHRlbXBsYXRlVG9EZWxldGUgPSBnZW5lcmF0ZVRlbXBsYXRlT3V0cHV0LnRlbXBsYXRlSWQ7XG4gICAgICB9IGVsc2UgaWYgKHNjYW5UeXBlID09IFRlbXBsYXRlU291cmNlT3B0aW9ucy5QQVRIKSB7XG4gICAgICAgIGNvbnN0IHRlbXBsYXRlQm9keSA9IHJlYWRGcm9tUGF0aChvcHRpb25zLmZyb21QYXRoISk7XG5cbiAgICAgICAgY29uc3QgcGFyc2VkVGVtcGxhdGUgPSBkZXNlcmlhbGl6ZVN0cnVjdHVyZSh0ZW1wbGF0ZUJvZHkpO1xuICAgICAgICBjb25zdCB0ZW1wbGF0ZUlkID0gcGFyc2VkVGVtcGxhdGUuTWV0YWRhdGE/LlRlbXBsYXRlSWQ/LnRvU3RyaW5nKCk7XG4gICAgICAgIGlmICh0ZW1wbGF0ZUlkKSB7XG4gICAgICAgICAgLy8gaWYgd2UgaGF2ZSBhIHRlbXBsYXRlIGlkLCB3ZSBjYW4gY2FsbCBkZXNjcmliZSBnZW5lcmF0ZWQgdGVtcGxhdGUgdG8gZ2V0IHRoZSByZXNvdXJjZSBpZGVudGlmaWVyc1xuICAgICAgICAgIC8vIHJlc291cmNlIG1ldGFkYXRhLCBhbmQgdGVtcGxhdGUgc291cmNlIHRvIGdlbmVyYXRlIHRoZSB0ZW1wbGF0ZVxuICAgICAgICAgIGNmbiA9IG5ldyBDZm5UZW1wbGF0ZUdlbmVyYXRvclByb3ZpZGVyKGF3YWl0IGJ1aWxkQ2ZuQ2xpZW50KHRoaXMucHJvcHMuc2RrUHJvdmlkZXIsIGVudmlyb25tZW50KSk7XG4gICAgICAgICAgY29uc3QgZ2VuZXJhdGVkVGVtcGxhdGVTdW1tYXJ5ID0gYXdhaXQgY2ZuLmRlc2NyaWJlR2VuZXJhdGVkVGVtcGxhdGUodGVtcGxhdGVJZCk7XG4gICAgICAgICAgZ2VuZXJhdGVUZW1wbGF0ZU91dHB1dCA9IGJ1aWxkR2VuZXJ0ZWRUZW1wbGF0ZU91dHB1dChcbiAgICAgICAgICAgIGdlbmVyYXRlZFRlbXBsYXRlU3VtbWFyeSxcbiAgICAgICAgICAgIHRlbXBsYXRlQm9keSxcbiAgICAgICAgICAgIGdlbmVyYXRlZFRlbXBsYXRlU3VtbWFyeS5HZW5lcmF0ZWRUZW1wbGF0ZUlkISxcbiAgICAgICAgICApO1xuICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgIGdlbmVyYXRlVGVtcGxhdGVPdXRwdXQgPSB7XG4gICAgICAgICAgICBtaWdyYXRlSnNvbjoge1xuICAgICAgICAgICAgICB0ZW1wbGF0ZUJvZHk6IHRlbXBsYXRlQm9keSxcbiAgICAgICAgICAgICAgc291cmNlOiAnbG9jYWxmaWxlJyxcbiAgICAgICAgICAgIH0sXG4gICAgICAgICAgfTtcbiAgICAgICAgfVxuICAgICAgfSBlbHNlIGlmIChzY2FuVHlwZSA9PSBUZW1wbGF0ZVNvdXJjZU9wdGlvbnMuU1RBQ0spIHtcbiAgICAgICAgY29uc3QgdGVtcGxhdGUgPSBhd2FpdCByZWFkRnJvbVN0YWNrKG9wdGlvbnMuc3RhY2tOYW1lLCB0aGlzLnByb3BzLnNka1Byb3ZpZGVyLCBlbnZpcm9ubWVudCk7XG4gICAgICAgIGlmICghdGVtcGxhdGUpIHtcbiAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoYE5vIHRlbXBsYXRlIGZvdW5kIGZvciBzdGFjay1uYW1lOiAke29wdGlvbnMuc3RhY2tOYW1lfWApO1xuICAgICAgICB9XG4gICAgICAgIGdlbmVyYXRlVGVtcGxhdGVPdXRwdXQgPSB7XG4gICAgICAgICAgbWlncmF0ZUpzb246IHtcbiAgICAgICAgICAgIHRlbXBsYXRlQm9keTogdGVtcGxhdGUsXG4gICAgICAgICAgICBzb3VyY2U6IG9wdGlvbnMuc3RhY2tOYW1lLFxuICAgICAgICAgIH0sXG4gICAgICAgIH07XG4gICAgICB9IGVsc2Uge1xuICAgICAgICAvLyBXZSBzaG91bGRuJ3QgZXZlciBnZXQgaGVyZSwgYnV0IGp1c3QgaW4gY2FzZS5cbiAgICAgICAgdGhyb3cgbmV3IEVycm9yKGBJbnZhbGlkIHNvdXJjZSBvcHRpb24gcHJvdmlkZWQ6ICR7c2NhblR5cGV9YCk7XG4gICAgICB9XG4gICAgICBjb25zdCBzdGFjayA9IGdlbmVyYXRlU3RhY2soZ2VuZXJhdGVUZW1wbGF0ZU91dHB1dC5taWdyYXRlSnNvbi50ZW1wbGF0ZUJvZHksIG9wdGlvbnMuc3RhY2tOYW1lLCBsYW5ndWFnZSk7XG4gICAgICBzdWNjZXNzKCcg4o+zICBHZW5lcmF0aW5nIENESyBhcHAgZm9yICVzLi4uJywgY2hhbGsuYmx1ZShvcHRpb25zLnN0YWNrTmFtZSkpO1xuICAgICAgYXdhaXQgZ2VuZXJhdGVDZGtBcHAob3B0aW9ucy5zdGFja05hbWUsIHN0YWNrISwgbGFuZ3VhZ2UsIG9wdGlvbnMub3V0cHV0UGF0aCwgb3B0aW9ucy5jb21wcmVzcyk7XG4gICAgICBpZiAoZ2VuZXJhdGVUZW1wbGF0ZU91dHB1dCkge1xuICAgICAgICB3cml0ZU1pZ3JhdGVKc29uRmlsZShvcHRpb25zLm91dHB1dFBhdGgsIG9wdGlvbnMuc3RhY2tOYW1lLCBnZW5lcmF0ZVRlbXBsYXRlT3V0cHV0Lm1pZ3JhdGVKc29uKTtcbiAgICAgIH1cbiAgICAgIGlmIChpc1RoZXJlQVdhcm5pbmcoZ2VuZXJhdGVUZW1wbGF0ZU91dHB1dCkpIHtcbiAgICAgICAgd2FybmluZyhcbiAgICAgICAgICAnIOKaoO+4jyAgU29tZSByZXNvdXJjZXMgY291bGQgbm90IGJlIG1pZ3JhdGVkIGNvbXBsZXRlbHkuIFBsZWFzZSByZXZpZXcgdGhlIFJFQURNRS5tZCBmaWxlIGZvciBtb3JlIGluZm9ybWF0aW9uLicsXG4gICAgICAgICk7XG4gICAgICAgIGFwcGVuZFdhcm5pbmdzVG9SZWFkbWUoXG4gICAgICAgICAgYCR7cGF0aC5qb2luKG9wdGlvbnMub3V0cHV0UGF0aCA/PyBwcm9jZXNzLmN3ZCgpLCBvcHRpb25zLnN0YWNrTmFtZSl9L1JFQURNRS5tZGAsXG4gICAgICAgICAgZ2VuZXJhdGVUZW1wbGF0ZU91dHB1dC5yZXNvdXJjZXMhLFxuICAgICAgICApO1xuICAgICAgfVxuICAgIH0gY2F0Y2ggKGUpIHtcbiAgICAgIGVycm9yKCcg4p2MICBNaWdyYXRlIGZhaWxlZCBmb3IgYCVzYDogJXMnLCBvcHRpb25zLnN0YWNrTmFtZSwgKGUgYXMgRXJyb3IpLm1lc3NhZ2UpO1xuICAgICAgdGhyb3cgZTtcbiAgICB9IGZpbmFsbHkge1xuICAgICAgaWYgKHRlbXBsYXRlVG9EZWxldGUpIHtcbiAgICAgICAgaWYgKCFjZm4pIHtcbiAgICAgICAgICBjZm4gPSBuZXcgQ2ZuVGVtcGxhdGVHZW5lcmF0b3JQcm92aWRlcihhd2FpdCBidWlsZENmbkNsaWVudCh0aGlzLnByb3BzLnNka1Byb3ZpZGVyLCBlbnZpcm9ubWVudCkpO1xuICAgICAgICB9XG4gICAgICAgIGlmICghcHJvY2Vzcy5lbnYuTUlHUkFURV9JTlRFR19URVNUKSB7XG4gICAgICAgICAgYXdhaXQgY2ZuLmRlbGV0ZUdlbmVyYXRlZFRlbXBsYXRlKHRlbXBsYXRlVG9EZWxldGUpO1xuICAgICAgICB9XG4gICAgICB9XG4gICAgfVxuICB9XG5cbiAgcHJpdmF0ZSBhc3luYyBzZWxlY3RTdGFja3NGb3JMaXN0KHBhdHRlcm5zOiBzdHJpbmdbXSkge1xuICAgIGNvbnN0IGFzc2VtYmx5ID0gYXdhaXQgdGhpcy5hc3NlbWJseSgpO1xuICAgIGNvbnN0IHN0YWNrcyA9IGF3YWl0IGFzc2VtYmx5LnNlbGVjdFN0YWNrcyh7IHBhdHRlcm5zIH0sIHsgZGVmYXVsdEJlaGF2aW9yOiBEZWZhdWx0U2VsZWN0aW9uLkFsbFN0YWNrcyB9KTtcblxuICAgIC8vIE5vIHZhbGlkYXRpb25cblxuICAgIHJldHVybiBzdGFja3M7XG4gIH1cblxuICBwcml2YXRlIGFzeW5jIHNlbGVjdFN0YWNrc0ZvckRlcGxveShcbiAgICBzZWxlY3RvcjogU3RhY2tTZWxlY3RvcixcbiAgICBleGNsdXNpdmVseT86IGJvb2xlYW4sXG4gICAgY2FjaGVDbG91ZEFzc2VtYmx5PzogYm9vbGVhbixcbiAgICBpZ25vcmVOb1N0YWNrcz86IGJvb2xlYW4sXG4gICk6IFByb21pc2U8U3RhY2tDb2xsZWN0aW9uPiB7XG4gICAgY29uc3QgYXNzZW1ibHkgPSBhd2FpdCB0aGlzLmFzc2VtYmx5KGNhY2hlQ2xvdWRBc3NlbWJseSk7XG4gICAgY29uc3Qgc3RhY2tzID0gYXdhaXQgYXNzZW1ibHkuc2VsZWN0U3RhY2tzKHNlbGVjdG9yLCB7XG4gICAgICBleHRlbmQ6IGV4Y2x1c2l2ZWx5ID8gRXh0ZW5kZWRTdGFja1NlbGVjdGlvbi5Ob25lIDogRXh0ZW5kZWRTdGFja1NlbGVjdGlvbi5VcHN0cmVhbSxcbiAgICAgIGRlZmF1bHRCZWhhdmlvcjogRGVmYXVsdFNlbGVjdGlvbi5Pbmx5U2luZ2xlLFxuICAgICAgaWdub3JlTm9TdGFja3MsXG4gICAgfSk7XG5cbiAgICB0aGlzLnZhbGlkYXRlU3RhY2tzU2VsZWN0ZWQoc3RhY2tzLCBzZWxlY3Rvci5wYXR0ZXJucyk7XG4gICAgdGhpcy52YWxpZGF0ZVN0YWNrcyhzdGFja3MpO1xuXG4gICAgcmV0dXJuIHN0YWNrcztcbiAgfVxuXG4gIHByaXZhdGUgYXN5bmMgc2VsZWN0U3RhY2tzRm9yRGlmZihcbiAgICBzdGFja05hbWVzOiBzdHJpbmdbXSxcbiAgICBleGNsdXNpdmVseT86IGJvb2xlYW4sXG4gICAgYXV0b1ZhbGlkYXRlPzogYm9vbGVhbixcbiAgKTogUHJvbWlzZTxTdGFja0NvbGxlY3Rpb24+IHtcbiAgICBjb25zdCBhc3NlbWJseSA9IGF3YWl0IHRoaXMuYXNzZW1ibHkoKTtcblxuICAgIGNvbnN0IHNlbGVjdGVkRm9yRGlmZiA9IGF3YWl0IGFzc2VtYmx5LnNlbGVjdFN0YWNrcyhcbiAgICAgIHsgcGF0dGVybnM6IHN0YWNrTmFtZXMgfSxcbiAgICAgIHtcbiAgICAgICAgZXh0ZW5kOiBleGNsdXNpdmVseSA/IEV4dGVuZGVkU3RhY2tTZWxlY3Rpb24uTm9uZSA6IEV4dGVuZGVkU3RhY2tTZWxlY3Rpb24uVXBzdHJlYW0sXG4gICAgICAgIGRlZmF1bHRCZWhhdmlvcjogRGVmYXVsdFNlbGVjdGlvbi5NYWluQXNzZW1ibHksXG4gICAgICB9LFxuICAgICk7XG5cbiAgICBjb25zdCBhbGxTdGFja3MgPSBhd2FpdCB0aGlzLnNlbGVjdFN0YWNrc0Zvckxpc3QoW10pO1xuICAgIGNvbnN0IGF1dG9WYWxpZGF0ZVN0YWNrcyA9IGF1dG9WYWxpZGF0ZVxuICAgICAgPyBhbGxTdGFja3MuZmlsdGVyKChhcnQpID0+IGFydC52YWxpZGF0ZU9uU3ludGggPz8gZmFsc2UpXG4gICAgICA6IG5ldyBTdGFja0NvbGxlY3Rpb24oYXNzZW1ibHksIFtdKTtcblxuICAgIHRoaXMudmFsaWRhdGVTdGFja3NTZWxlY3RlZChzZWxlY3RlZEZvckRpZmYuY29uY2F0KGF1dG9WYWxpZGF0ZVN0YWNrcyksIHN0YWNrTmFtZXMpO1xuICAgIHRoaXMudmFsaWRhdGVTdGFja3Moc2VsZWN0ZWRGb3JEaWZmLmNvbmNhdChhdXRvVmFsaWRhdGVTdGFja3MpKTtcblxuICAgIHJldHVybiBzZWxlY3RlZEZvckRpZmY7XG4gIH1cblxuICBwcml2YXRlIGFzeW5jIHNlbGVjdFN0YWNrc0ZvckRlc3Ryb3koc2VsZWN0b3I6IFN0YWNrU2VsZWN0b3IsIGV4Y2x1c2l2ZWx5PzogYm9vbGVhbikge1xuICAgIGNvbnN0IGFzc2VtYmx5ID0gYXdhaXQgdGhpcy5hc3NlbWJseSgpO1xuICAgIGNvbnN0IHN0YWNrcyA9IGF3YWl0IGFzc2VtYmx5LnNlbGVjdFN0YWNrcyhzZWxlY3Rvciwge1xuICAgICAgZXh0ZW5kOiBleGNsdXNpdmVseSA/IEV4dGVuZGVkU3RhY2tTZWxlY3Rpb24uTm9uZSA6IEV4dGVuZGVkU3RhY2tTZWxlY3Rpb24uRG93bnN0cmVhbSxcbiAgICAgIGRlZmF1bHRCZWhhdmlvcjogRGVmYXVsdFNlbGVjdGlvbi5Pbmx5U2luZ2xlLFxuICAgIH0pO1xuXG4gICAgLy8gTm8gdmFsaWRhdGlvblxuXG4gICAgcmV0dXJuIHN0YWNrcztcbiAgfVxuXG4gIC8qKlxuICAgKiBWYWxpZGF0ZSB0aGUgc3RhY2tzIGZvciBlcnJvcnMgYW5kIHdhcm5pbmdzIGFjY29yZGluZyB0byB0aGUgQ0xJJ3MgY3VycmVudCBzZXR0aW5nc1xuICAgKi9cbiAgcHJpdmF0ZSB2YWxpZGF0ZVN0YWNrcyhzdGFja3M6IFN0YWNrQ29sbGVjdGlvbikge1xuICAgIHN0YWNrcy5wcm9jZXNzTWV0YWRhdGFNZXNzYWdlcyh7XG4gICAgICBpZ25vcmVFcnJvcnM6IHRoaXMucHJvcHMuaWdub3JlRXJyb3JzLFxuICAgICAgc3RyaWN0OiB0aGlzLnByb3BzLnN0cmljdCxcbiAgICAgIHZlcmJvc2U6IHRoaXMucHJvcHMudmVyYm9zZSxcbiAgICB9KTtcbiAgfVxuXG4gIC8qKlxuICAgKiBWYWxpZGF0ZSB0aGF0IGlmIGEgdXNlciBzcGVjaWZpZWQgYSBzdGFjayBuYW1lIHRoZXJlIGV4aXN0cyBhdCBsZWFzdCAxIHN0YWNrIHNlbGVjdGVkXG4gICAqL1xuICBwcml2YXRlIHZhbGlkYXRlU3RhY2tzU2VsZWN0ZWQoc3RhY2tzOiBTdGFja0NvbGxlY3Rpb24sIHN0YWNrTmFtZXM6IHN0cmluZ1tdKSB7XG4gICAgaWYgKHN0YWNrTmFtZXMubGVuZ3RoICE9IDAgJiYgc3RhY2tzLnN0YWNrQ291bnQgPT0gMCkge1xuICAgICAgdGhyb3cgbmV3IEVycm9yKGBObyBzdGFja3MgbWF0Y2ggdGhlIG5hbWUocykgJHtzdGFja05hbWVzfWApO1xuICAgIH1cbiAgfVxuXG4gIC8qKlxuICAgKiBTZWxlY3QgYSBzaW5nbGUgc3RhY2sgYnkgaXRzIG5hbWVcbiAgICovXG4gIHByaXZhdGUgYXN5bmMgc2VsZWN0U2luZ2xlU3RhY2tCeU5hbWUoc3RhY2tOYW1lOiBzdHJpbmcpIHtcbiAgICBjb25zdCBhc3NlbWJseSA9IGF3YWl0IHRoaXMuYXNzZW1ibHkoKTtcblxuICAgIGNvbnN0IHN0YWNrcyA9IGF3YWl0IGFzc2VtYmx5LnNlbGVjdFN0YWNrcyhcbiAgICAgIHsgcGF0dGVybnM6IFtzdGFja05hbWVdIH0sXG4gICAgICB7XG4gICAgICAgIGV4dGVuZDogRXh0ZW5kZWRTdGFja1NlbGVjdGlvbi5Ob25lLFxuICAgICAgICBkZWZhdWx0QmVoYXZpb3I6IERlZmF1bHRTZWxlY3Rpb24uTm9uZSxcbiAgICAgIH0sXG4gICAgKTtcblxuICAgIC8vIENvdWxkIGhhdmUgYmVlbiBhIGdsb2Igc28gY2hlY2sgdGhhdCB3ZSBldmFsdWF0ZWQgdG8gZXhhY3RseSBvbmVcbiAgICBpZiAoc3RhY2tzLnN0YWNrQ291bnQgPiAxKSB7XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoYFRoaXMgY29tbWFuZCByZXF1aXJlcyBleGFjdGx5IG9uZSBzdGFjayBhbmQgd2UgbWF0Y2hlZCBtb3JlIHRoYW4gb25lOiAke3N0YWNrcy5zdGFja0lkc31gKTtcbiAgICB9XG5cbiAgICByZXR1cm4gYXNzZW1ibHkuc3RhY2tCeUlkKHN0YWNrcy5maXJzdFN0YWNrLmlkKTtcbiAgfVxuXG4gIHB1YmxpYyBhc3NlbWJseShjYWNoZUNsb3VkQXNzZW1ibHk/OiBib29sZWFuKTogUHJvbWlzZTxDbG91ZEFzc2VtYmx5PiB7XG4gICAgcmV0dXJuIHRoaXMucHJvcHMuY2xvdWRFeGVjdXRhYmxlLnN5bnRoZXNpemUoY2FjaGVDbG91ZEFzc2VtYmx5KTtcbiAgfVxuXG4gIHByaXZhdGUgcGF0dGVybnNBcnJheUZvcldhdGNoKFxuICAgIHBhdHRlcm5zOiBzdHJpbmcgfCBzdHJpbmdbXSB8IHVuZGVmaW5lZCxcbiAgICBvcHRpb25zOiB7IHJvb3REaXI6IHN0cmluZzsgcmV0dXJuUm9vdERpcklmRW1wdHk6IGJvb2xlYW4gfSxcbiAgKTogc3RyaW5nW10ge1xuICAgIGNvbnN0IHBhdHRlcm5zQXJyYXk6IHN0cmluZ1tdID0gcGF0dGVybnMgIT09IHVuZGVmaW5lZCA/IChBcnJheS5pc0FycmF5KHBhdHRlcm5zKSA/IHBhdHRlcm5zIDogW3BhdHRlcm5zXSkgOiBbXTtcbiAgICByZXR1cm4gcGF0dGVybnNBcnJheS5sZW5ndGggPiAwID8gcGF0dGVybnNBcnJheSA6IG9wdGlvbnMucmV0dXJuUm9vdERpcklmRW1wdHkgPyBbb3B0aW9ucy5yb290RGlyXSA6IFtdO1xuICB9XG5cbiAgcHJpdmF0ZSBhc3luYyBpbnZva2VEZXBsb3lGcm9tV2F0Y2goXG4gICAgb3B0aW9uczogV2F0Y2hPcHRpb25zLFxuICAgIGNsb3VkV2F0Y2hMb2dNb25pdG9yPzogQ2xvdWRXYXRjaExvZ0V2ZW50TW9uaXRvcixcbiAgKTogUHJvbWlzZTx2b2lkPiB7XG4gICAgY29uc3QgZGVwbG95T3B0aW9uczogRGVwbG95T3B0aW9ucyA9IHtcbiAgICAgIC4uLm9wdGlvbnMsXG4gICAgICByZXF1aXJlQXBwcm92YWw6IFJlcXVpcmVBcHByb3ZhbC5OZXZlcixcbiAgICAgIC8vIGlmICd3YXRjaCcgaXMgY2FsbGVkIGJ5IGludm9raW5nICdjZGsgZGVwbG95IC0td2F0Y2gnLFxuICAgICAgLy8gd2UgbmVlZCB0byBtYWtlIHN1cmUgdG8gbm90IGNhbGwgJ2RlcGxveScgd2l0aCAnd2F0Y2gnIGFnYWluLFxuICAgICAgLy8gYXMgdGhhdCB3b3VsZCBsZWFkIHRvIGEgY3ljbGVcbiAgICAgIHdhdGNoOiBmYWxzZSxcbiAgICAgIGNsb3VkV2F0Y2hMb2dNb25pdG9yLFxuICAgICAgY2FjaGVDbG91ZEFzc2VtYmx5OiBmYWxzZSxcbiAgICAgIGhvdHN3YXA6IG9wdGlvbnMuaG90c3dhcCxcbiAgICAgIGV4dHJhVXNlckFnZW50OiBgY2RrLXdhdGNoL2hvdHN3YXAtJHtvcHRpb25zLmhvdHN3YXAgIT09IEhvdHN3YXBNb2RlLkZBTExfQkFDSyA/ICdvbicgOiAnb2ZmJ31gLFxuICAgICAgY29uY3VycmVuY3k6IG9wdGlvbnMuY29uY3VycmVuY3ksXG4gICAgfTtcblxuICAgIHRyeSB7XG4gICAgICBhd2FpdCB0aGlzLmRlcGxveShkZXBsb3lPcHRpb25zKTtcbiAgICB9IGNhdGNoIHtcbiAgICAgIC8vIGp1c3QgY29udGludWUgLSBkZXBsb3kgd2lsbCBzaG93IHRoZSBlcnJvclxuICAgIH1cbiAgfVxuXG4gIC8qKlxuICAgKiBSZW1vdmUgdGhlIGFzc2V0IHB1Ymxpc2hpbmcgYW5kIGJ1aWxkaW5nIGZyb20gdGhlIHdvcmsgZ3JhcGggZm9yIGFzc2V0cyB0aGF0IGFyZSBhbHJlYWR5IGluIHBsYWNlXG4gICAqL1xuICBwcml2YXRlIGFzeW5jIHJlbW92ZVB1Ymxpc2hlZEFzc2V0cyhncmFwaDogV29ya0dyYXBoLCBvcHRpb25zOiBEZXBsb3lPcHRpb25zKSB7XG4gICAgYXdhaXQgZ3JhcGgucmVtb3ZlVW5uZWNlc3NhcnlBc3NldHMoYXNzZXROb2RlID0+IHRoaXMucHJvcHMuZGVwbG95bWVudHMuaXNTaW5nbGVBc3NldFB1Ymxpc2hlZChhc3NldE5vZGUuYXNzZXRNYW5pZmVzdCwgYXNzZXROb2RlLmFzc2V0LCB7XG4gICAgICBzdGFjazogYXNzZXROb2RlLnBhcmVudFN0YWNrLFxuICAgICAgcm9sZUFybjogb3B0aW9ucy5yb2xlQXJuLFxuICAgICAgc3RhY2tOYW1lOiBhc3NldE5vZGUucGFyZW50U3RhY2suc3RhY2tOYW1lLFxuICAgIH0pKTtcbiAgfVxuXG4gIC8qKlxuICAgKiBDaGVja3MgdG8gc2VlIGlmIGEgbWlncmF0ZS5qc29uIGZpbGUgZXhpc3RzLiBJZiBpdCBkb2VzIGFuZCB0aGUgc291cmNlIGlzIGVpdGhlciBgZmlsZXBhdGhgIG9yXG4gICAqIGlzIGluIHRoZSBzYW1lIGVudmlyb25tZW50IGFzIHRoZSBzdGFjayBkZXBsb3ltZW50LCBhIG5ldyBzdGFjayBpcyBjcmVhdGVkIGFuZCB0aGUgcmVzb3VyY2VzIGFyZVxuICAgKiBtaWdyYXRlZCB0byB0aGUgc3RhY2sgdXNpbmcgYW4gSU1QT1JUIGNoYW5nZXNldC4gVGhlIG5vcm1hbCBkZXBsb3ltZW50IHdpbGwgcmVzdW1lIGFmdGVyIHRoaXMgaXMgY29tcGxldGVcbiAgICogdG8gYWRkIGJhY2sgaW4gYW55IG91dHB1dHMgYW5kIHRoZSBDREtNZXRhZGF0YS5cbiAgICovXG4gIHByaXZhdGUgYXN5bmMgdHJ5TWlncmF0ZVJlc291cmNlcyhzdGFja3M6IFN0YWNrQ29sbGVjdGlvbiwgb3B0aW9uczogRGVwbG95T3B0aW9ucyk6IFByb21pc2U8dm9pZD4ge1xuICAgIGNvbnN0IHN0YWNrID0gc3RhY2tzLnN0YWNrQXJ0aWZhY3RzWzBdO1xuICAgIGNvbnN0IG1pZ3JhdGVEZXBsb3ltZW50ID0gbmV3IFJlc291cmNlSW1wb3J0ZXIoc3RhY2ssIHRoaXMucHJvcHMuZGVwbG95bWVudHMpO1xuICAgIGNvbnN0IHJlc291cmNlc1RvSW1wb3J0ID0gYXdhaXQgdGhpcy50cnlHZXRSZXNvdXJjZXMoYXdhaXQgbWlncmF0ZURlcGxveW1lbnQucmVzb2x2ZUVudmlyb25tZW50KCkpO1xuXG4gICAgaWYgKHJlc291cmNlc1RvSW1wb3J0KSB7XG4gICAgICBwcmludCgnJXM6IGNyZWF0aW5nIHN0YWNrIGZvciByZXNvdXJjZSBtaWdyYXRpb24uLi4nLCBjaGFsay5ib2xkKHN0YWNrLmRpc3BsYXlOYW1lKSk7XG4gICAgICBwcmludCgnJXM6IGltcG9ydGluZyByZXNvdXJjZXMgaW50byBzdGFjay4uLicsIGNoYWxrLmJvbGQoc3RhY2suZGlzcGxheU5hbWUpKTtcblxuICAgICAgYXdhaXQgdGhpcy5wZXJmb3JtUmVzb3VyY2VNaWdyYXRpb24obWlncmF0ZURlcGxveW1lbnQsIHJlc291cmNlc1RvSW1wb3J0LCBvcHRpb25zKTtcblxuICAgICAgZnMucm1TeW5jKCdtaWdyYXRlLmpzb24nKTtcbiAgICAgIHByaW50KCclczogYXBwbHlpbmcgQ0RLTWV0YWRhdGEgYW5kIE91dHB1dHMgdG8gc3RhY2sgKGlmIGFwcGxpY2FibGUpLi4uJywgY2hhbGsuYm9sZChzdGFjay5kaXNwbGF5TmFtZSkpO1xuICAgIH1cbiAgfVxuXG4gIC8qKlxuICAgKiBDcmVhdGVzIGEgbmV3IHN0YWNrIHdpdGgganVzdCB0aGUgcmVzb3VyY2VzIHRvIGJlIG1pZ3JhdGVkXG4gICAqL1xuICBwcml2YXRlIGFzeW5jIHBlcmZvcm1SZXNvdXJjZU1pZ3JhdGlvbihcbiAgICBtaWdyYXRlRGVwbG95bWVudDogUmVzb3VyY2VJbXBvcnRlcixcbiAgICByZXNvdXJjZXNUb0ltcG9ydDogUmVzb3VyY2VzVG9JbXBvcnQsXG4gICAgb3B0aW9uczogRGVwbG95T3B0aW9ucyxcbiAgKSB7XG4gICAgY29uc3Qgc3RhcnREZXBsb3lUaW1lID0gbmV3IERhdGUoKS5nZXRUaW1lKCk7XG4gICAgbGV0IGVsYXBzZWREZXBsb3lUaW1lID0gMDtcblxuICAgIC8vIEluaXRpYWwgRGVwbG95bWVudFxuICAgIGF3YWl0IG1pZ3JhdGVEZXBsb3ltZW50LmltcG9ydFJlc291cmNlc0Zyb21NaWdyYXRlKHJlc291cmNlc1RvSW1wb3J0LCB7XG4gICAgICByb2xlQXJuOiBvcHRpb25zLnJvbGVBcm4sXG4gICAgICB0b29sa2l0U3RhY2tOYW1lOiBvcHRpb25zLnRvb2xraXRTdGFja05hbWUsXG4gICAgICBkZXBsb3ltZW50TWV0aG9kOiBvcHRpb25zLmRlcGxveW1lbnRNZXRob2QsXG4gICAgICB1c2VQcmV2aW91c1BhcmFtZXRlcnM6IHRydWUsXG4gICAgICBwcm9ncmVzczogb3B0aW9ucy5wcm9ncmVzcyxcbiAgICAgIHJvbGxiYWNrOiBvcHRpb25zLnJvbGxiYWNrLFxuICAgIH0pO1xuXG4gICAgZWxhcHNlZERlcGxveVRpbWUgPSBuZXcgRGF0ZSgpLmdldFRpbWUoKSAtIHN0YXJ0RGVwbG95VGltZTtcbiAgICBwcmludCgnXFxu4pyoICBSZXNvdXJjZSBtaWdyYXRpb24gdGltZTogJXNzXFxuJywgZm9ybWF0VGltZShlbGFwc2VkRGVwbG95VGltZSkpO1xuICB9XG5cbiAgcHJpdmF0ZSBhc3luYyB0cnlHZXRSZXNvdXJjZXMoZW52aXJvbm1lbnQ6IGN4YXBpLkVudmlyb25tZW50KTogUHJvbWlzZTxSZXNvdXJjZXNUb0ltcG9ydCB8IHVuZGVmaW5lZD4ge1xuICAgIHRyeSB7XG4gICAgICBjb25zdCBtaWdyYXRlRmlsZSA9IGZzLnJlYWRKc29uU3luYygnbWlncmF0ZS5qc29uJywge1xuICAgICAgICBlbmNvZGluZzogJ3V0Zi04JyxcbiAgICAgIH0pO1xuICAgICAgY29uc3Qgc291cmNlRW52ID0gKG1pZ3JhdGVGaWxlLlNvdXJjZSBhcyBzdHJpbmcpLnNwbGl0KCc6Jyk7XG4gICAgICBpZiAoXG4gICAgICAgIHNvdXJjZUVudlswXSA9PT0gJ2xvY2FsZmlsZScgfHxcbiAgICAgICAgKHNvdXJjZUVudls0XSA9PT0gZW52aXJvbm1lbnQuYWNjb3VudCAmJiBzb3VyY2VFbnZbM10gPT09IGVudmlyb25tZW50LnJlZ2lvbilcbiAgICAgICkge1xuICAgICAgICByZXR1cm4gbWlncmF0ZUZpbGUuUmVzb3VyY2VzO1xuICAgICAgfVxuICAgIH0gY2F0Y2ggKGUpIHtcbiAgICAgIC8vIE5vdGhpbmcgdG8gZG9cbiAgICB9XG5cbiAgICByZXR1cm4gdW5kZWZpbmVkO1xuICB9XG59XG5cbi8qKlxuICogUHJpbnQgYSBzZXJpYWxpemVkIG9iamVjdCAoWUFNTCBvciBKU09OKSB0byBzdGRvdXQuXG4gKi9cbmZ1bmN0aW9uIHByaW50U2VyaWFsaXplZE9iamVjdChvYmo6IGFueSwganNvbjogYm9vbGVhbikge1xuICBkYXRhKHNlcmlhbGl6ZVN0cnVjdHVyZShvYmosIGpzb24pKTtcbn1cblxuZXhwb3J0IGludGVyZmFjZSBEaWZmT3B0aW9ucyB7XG4gIC8qKlxuICAgKiBTdGFjayBuYW1lcyB0byBkaWZmXG4gICAqL1xuICBzdGFja05hbWVzOiBzdHJpbmdbXTtcblxuICAvKipcbiAgICogTmFtZSBvZiB0aGUgdG9vbGtpdCBzdGFjaywgaWYgbm90IHRoZSBkZWZhdWx0IG5hbWVcbiAgICpcbiAgICogQGRlZmF1bHQgJ0NES1Rvb2xraXQnXG4gICAqL1xuICByZWFkb25seSB0b29sa2l0U3RhY2tOYW1lPzogc3RyaW5nO1xuXG4gIC8qKlxuICAgKiBPbmx5IHNlbGVjdCB0aGUgZ2l2ZW4gc3RhY2tcbiAgICpcbiAgICogQGRlZmF1bHQgZmFsc2VcbiAgICovXG4gIGV4Y2x1c2l2ZWx5PzogYm9vbGVhbjtcblxuICAvKipcbiAgICogVXNlZCBhIHRlbXBsYXRlIGZyb20gZGlzayBpbnN0ZWFkIG9mIGZyb20gdGhlIHNlcnZlclxuICAgKlxuICAgKiBAZGVmYXVsdCBVc2UgZnJvbSB0aGUgc2VydmVyXG4gICAqL1xuICB0ZW1wbGF0ZVBhdGg/OiBzdHJpbmc7XG5cbiAgLyoqXG4gICAqIFN0cmljdCBkaWZmIG1vZGVcbiAgICpcbiAgICogQGRlZmF1bHQgZmFsc2VcbiAgICovXG4gIHN0cmljdD86IGJvb2xlYW47XG5cbiAgLyoqXG4gICAqIEhvdyBtYW55IGxpbmVzIG9mIGNvbnRleHQgdG8gc2hvdyBpbiB0aGUgZGlmZlxuICAgKlxuICAgKiBAZGVmYXVsdCAzXG4gICAqL1xuICBjb250ZXh0TGluZXM/OiBudW1iZXI7XG5cbiAgLyoqXG4gICAqIFdoZXJlIHRvIHdyaXRlIHRoZSBkZWZhdWx0XG4gICAqXG4gICAqIEBkZWZhdWx0IHN0ZGVyclxuICAgKi9cbiAgc3RyZWFtPzogTm9kZUpTLldyaXRhYmxlU3RyZWFtO1xuXG4gIC8qKlxuICAgKiBXaGV0aGVyIHRvIGZhaWwgd2l0aCBleGl0IGNvZGUgMSBpbiBjYXNlIG9mIGRpZmZcbiAgICpcbiAgICogQGRlZmF1bHQgZmFsc2VcbiAgICovXG4gIGZhaWw/OiBib29sZWFuO1xuXG4gIC8qKlxuICAgKiBPbmx5IHJ1biBkaWZmIG9uIGJyb2FkZW5lZCBzZWN1cml0eSBjaGFuZ2VzXG4gICAqXG4gICAqIEBkZWZhdWx0IGZhbHNlXG4gICAqL1xuICBzZWN1cml0eU9ubHk/OiBib29sZWFuO1xuXG4gIC8qKlxuICAgKiBXaGV0aGVyIHRvIHJ1biB0aGUgZGlmZiBhZ2FpbnN0IHRoZSB0ZW1wbGF0ZSBhZnRlciB0aGUgQ2xvdWRGb3JtYXRpb24gVHJhbnNmb3JtcyBpbnNpZGUgaXQgaGF2ZSBiZWVuIGV4ZWN1dGVkXG4gICAqIChhcyBvcHBvc2VkIHRvIHRoZSBvcmlnaW5hbCB0ZW1wbGF0ZSwgdGhlIGRlZmF1bHQsIHdoaWNoIGNvbnRhaW5zIHRoZSB1bnByb2Nlc3NlZCBUcmFuc2Zvcm1zKS5cbiAgICpcbiAgICogQGRlZmF1bHQgZmFsc2VcbiAgICovXG4gIGNvbXBhcmVBZ2FpbnN0UHJvY2Vzc2VkVGVtcGxhdGU/OiBib29sZWFuO1xuXG4gIC8qXG4gICAqIFJ1biBkaWZmIGluIHF1aWV0IG1vZGUgd2l0aG91dCBwcmludGluZyB0aGUgZGlmZiBzdGF0dXNlc1xuICAgKlxuICAgKiBAZGVmYXVsdCBmYWxzZVxuICAgKi9cbiAgcXVpZXQ/OiBib29sZWFuO1xuXG4gIC8qKlxuICAgKiBBZGRpdGlvbmFsIHBhcmFtZXRlcnMgZm9yIENsb3VkRm9ybWF0aW9uIGF0IGRpZmYgdGltZSwgdXNlZCB0byBjcmVhdGUgYSBjaGFuZ2Ugc2V0XG4gICAqIEBkZWZhdWx0IHt9XG4gICAqL1xuICBwYXJhbWV0ZXJzPzogeyBbbmFtZTogc3RyaW5nXTogc3RyaW5nIHwgdW5kZWZpbmVkIH07XG5cbiAgLyoqXG4gICAqIFdoZXRoZXIgb3Igbm90IHRvIGNyZWF0ZSwgYW5hbHl6ZSwgYW5kIHN1YnNlcXVlbnRseSBkZWxldGUgYSBjaGFuZ2VzZXRcbiAgICpcbiAgICogQGRlZmF1bHQgdHJ1ZVxuICAgKi9cbiAgY2hhbmdlU2V0PzogYm9vbGVhbjtcbn1cblxuaW50ZXJmYWNlIENmbkRlcGxveU9wdGlvbnMge1xuICAvKipcbiAgICogQ3JpdGVyaWEgZm9yIHNlbGVjdGluZyBzdGFja3MgdG8gZGVwbG95XG4gICAqL1xuICBzZWxlY3RvcjogU3RhY2tTZWxlY3RvcjtcblxuICAvKipcbiAgICogTmFtZSBvZiB0aGUgdG9vbGtpdCBzdGFjayB0byB1c2UvZGVwbG95XG4gICAqXG4gICAqIEBkZWZhdWx0IENES1Rvb2xraXRcbiAgICovXG4gIHRvb2xraXRTdGFja05hbWU/OiBzdHJpbmc7XG5cbiAgLyoqXG4gICAqIFJvbGUgdG8gcGFzcyB0byBDbG91ZEZvcm1hdGlvbiBmb3IgZGVwbG95bWVudFxuICAgKi9cbiAgcm9sZUFybj86IHN0cmluZztcblxuICAvKipcbiAgICogT3B0aW9uYWwgbmFtZSB0byB1c2UgZm9yIHRoZSBDbG91ZEZvcm1hdGlvbiBjaGFuZ2Ugc2V0LlxuICAgKiBJZiBub3QgcHJvdmlkZWQsIGEgbmFtZSB3aWxsIGJlIGdlbmVyYXRlZCBhdXRvbWF0aWNhbGx5LlxuICAgKlxuICAgKiBAZGVwcmVjYXRlZCBVc2UgJ2RlcGxveW1lbnRNZXRob2QnIGluc3RlYWRcbiAgICovXG4gIGNoYW5nZVNldE5hbWU/OiBzdHJpbmc7XG5cbiAgLyoqXG4gICAqIFdoZXRoZXIgdG8gZXhlY3V0ZSB0aGUgQ2hhbmdlU2V0XG4gICAqIE5vdCBwcm92aWRpbmcgYGV4ZWN1dGVgIHBhcmFtZXRlciB3aWxsIHJlc3VsdCBpbiBleGVjdXRpb24gb2YgQ2hhbmdlU2V0XG4gICAqXG4gICAqIEBkZWZhdWx0IHRydWVcbiAgICogQGRlcHJlY2F0ZWQgVXNlICdkZXBsb3ltZW50TWV0aG9kJyBpbnN0ZWFkXG4gICAqL1xuICBleGVjdXRlPzogYm9vbGVhbjtcblxuICAvKipcbiAgICogRGVwbG95bWVudCBtZXRob2RcbiAgICovXG4gIHJlYWRvbmx5IGRlcGxveW1lbnRNZXRob2Q/OiBEZXBsb3ltZW50TWV0aG9kO1xuXG4gIC8qKlxuICAgKiBEaXNwbGF5IG1vZGUgZm9yIHN0YWNrIGRlcGxveW1lbnQgcHJvZ3Jlc3MuXG4gICAqXG4gICAqIEBkZWZhdWx0IC0gU3RhY2tBY3Rpdml0eVByb2dyZXNzLkJhciAtIHN0YWNrIGV2ZW50cyB3aWxsIGJlIGRpc3BsYXllZCBmb3JcbiAgICogICB0aGUgcmVzb3VyY2UgY3VycmVudGx5IGJlaW5nIGRlcGxveWVkLlxuICAgKi9cbiAgcHJvZ3Jlc3M/OiBTdGFja0FjdGl2aXR5UHJvZ3Jlc3M7XG5cbiAgLyoqXG4gICAqIFJvbGxiYWNrIGZhaWxlZCBkZXBsb3ltZW50c1xuICAgKlxuICAgKiBAZGVmYXVsdCB0cnVlXG4gICAqL1xuICByZWFkb25seSByb2xsYmFjaz86IGJvb2xlYW47XG59XG5cbmludGVyZmFjZSBXYXRjaE9wdGlvbnMgZXh0ZW5kcyBPbWl0PENmbkRlcGxveU9wdGlvbnMsICdleGVjdXRlJz4ge1xuICAvKipcbiAgICogT25seSBzZWxlY3QgdGhlIGdpdmVuIHN0YWNrXG4gICAqXG4gICAqIEBkZWZhdWx0IGZhbHNlXG4gICAqL1xuICBleGNsdXNpdmVseT86IGJvb2xlYW47XG5cbiAgLyoqXG4gICAqIFJldXNlIHRoZSBhc3NldHMgd2l0aCB0aGUgZ2l2ZW4gYXNzZXQgSURzXG4gICAqL1xuICByZXVzZUFzc2V0cz86IHN0cmluZ1tdO1xuXG4gIC8qKlxuICAgKiBBbHdheXMgZGVwbG95LCBldmVuIGlmIHRlbXBsYXRlcyBhcmUgaWRlbnRpY2FsLlxuICAgKiBAZGVmYXVsdCBmYWxzZVxuICAgKi9cbiAgZm9yY2U/OiBib29sZWFuO1xuXG4gIC8qKlxuICAgKiBXaGV0aGVyIHRvIHBlcmZvcm0gYSAnaG90c3dhcCcgZGVwbG95bWVudC5cbiAgICogQSAnaG90c3dhcCcgZGVwbG95bWVudCB3aWxsIGF0dGVtcHQgdG8gc2hvcnQtY2lyY3VpdCBDbG91ZEZvcm1hdGlvblxuICAgKiBhbmQgdXBkYXRlIHRoZSBhZmZlY3RlZCByZXNvdXJjZXMgbGlrZSBMYW1iZGEgZnVuY3Rpb25zIGRpcmVjdGx5LlxuICAgKlxuICAgKiBAZGVmYXVsdCAtIGBIb3Rzd2FwTW9kZS5GQUxMX0JBQ0tgIGZvciByZWd1bGFyIGRlcGxveW1lbnRzLCBgSG90c3dhcE1vZGUuSE9UU1dBUF9PTkxZYCBmb3IgJ3dhdGNoJyBkZXBsb3ltZW50c1xuICAgKi9cbiAgcmVhZG9ubHkgaG90c3dhcDogSG90c3dhcE1vZGU7XG5cbiAgLyoqXG4gICAqIFRoZSBleHRyYSBzdHJpbmcgdG8gYXBwZW5kIHRvIHRoZSBVc2VyLUFnZW50IGhlYWRlciB3aGVuIHBlcmZvcm1pbmcgQVdTIFNESyBjYWxscy5cbiAgICpcbiAgICogQGRlZmF1bHQgLSBub3RoaW5nIGV4dHJhIGlzIGFwcGVuZGVkIHRvIHRoZSBVc2VyLUFnZW50IGhlYWRlclxuICAgKi9cbiAgcmVhZG9ubHkgZXh0cmFVc2VyQWdlbnQ/OiBzdHJpbmc7XG5cbiAgLyoqXG4gICAqIFdoZXRoZXIgdG8gc2hvdyBDbG91ZFdhdGNoIGxvZ3MgZm9yIGhvdHN3YXBwZWQgcmVzb3VyY2VzXG4gICAqIGxvY2FsbHkgaW4gdGhlIHVzZXJzIHRlcm1pbmFsXG4gICAqXG4gICAqIEBkZWZhdWx0IC0gZmFsc2VcbiAgICovXG4gIHJlYWRvbmx5IHRyYWNlTG9ncz86IGJvb2xlYW47XG5cbiAgLyoqXG4gICAqIE1heGltdW0gbnVtYmVyIG9mIHNpbXVsdGFuZW91cyBkZXBsb3ltZW50cyAoZGVwZW5kZW5jeSBwZXJtaXR0aW5nKSB0byBleGVjdXRlLlxuICAgKiBUaGUgZGVmYXVsdCBpcyAnMScsIHdoaWNoIGV4ZWN1dGVzIGFsbCBkZXBsb3ltZW50cyBzZXJpYWxseS5cbiAgICpcbiAgICogQGRlZmF1bHQgMVxuICAgKi9cbiAgcmVhZG9ubHkgY29uY3VycmVuY3k/OiBudW1iZXI7XG59XG5cbmV4cG9ydCBpbnRlcmZhY2UgRGVwbG95T3B0aW9ucyBleHRlbmRzIENmbkRlcGxveU9wdGlvbnMsIFdhdGNoT3B0aW9ucyB7XG4gIC8qKlxuICAgKiBBUk5zIG9mIFNOUyB0b3BpY3MgdGhhdCBDbG91ZEZvcm1hdGlvbiB3aWxsIG5vdGlmeSB3aXRoIHN0YWNrIHJlbGF0ZWQgZXZlbnRzXG4gICAqL1xuICBub3RpZmljYXRpb25Bcm5zPzogc3RyaW5nW107XG5cbiAgLyoqXG4gICAqIFdoYXQga2luZCBvZiBzZWN1cml0eSBjaGFuZ2VzIHJlcXVpcmUgYXBwcm92YWxcbiAgICpcbiAgICogQGRlZmF1bHQgUmVxdWlyZUFwcHJvdmFsLkJyb2FkZW5pbmdcbiAgICovXG4gIHJlcXVpcmVBcHByb3ZhbD86IFJlcXVpcmVBcHByb3ZhbDtcblxuICAvKipcbiAgICogVGFncyB0byBwYXNzIHRvIENsb3VkRm9ybWF0aW9uIGZvciBkZXBsb3ltZW50XG4gICAqL1xuICB0YWdzPzogVGFnW107XG5cbiAgLyoqXG4gICAqIEFkZGl0aW9uYWwgcGFyYW1ldGVycyBmb3IgQ2xvdWRGb3JtYXRpb24gYXQgZGVwbG95IHRpbWVcbiAgICogQGRlZmF1bHQge31cbiAgICovXG4gIHBhcmFtZXRlcnM/OiB7IFtuYW1lOiBzdHJpbmddOiBzdHJpbmcgfCB1bmRlZmluZWQgfTtcblxuICAvKipcbiAgICogVXNlIHByZXZpb3VzIHZhbHVlcyBmb3IgdW5zcGVjaWZpZWQgcGFyYW1ldGVyc1xuICAgKlxuICAgKiBJZiBub3Qgc2V0LCBhbGwgcGFyYW1ldGVycyBtdXN0IGJlIHNwZWNpZmllZCBmb3IgZXZlcnkgZGVwbG95bWVudC5cbiAgICpcbiAgICogQGRlZmF1bHQgdHJ1ZVxuICAgKi9cbiAgdXNlUHJldmlvdXNQYXJhbWV0ZXJzPzogYm9vbGVhbjtcblxuICAvKipcbiAgICogUGF0aCB0byBmaWxlIHdoZXJlIHN0YWNrIG91dHB1dHMgd2lsbCBiZSB3cml0dGVuIGFmdGVyIGEgc3VjY2Vzc2Z1bCBkZXBsb3kgYXMgSlNPTlxuICAgKiBAZGVmYXVsdCAtIE91dHB1dHMgYXJlIG5vdCB3cml0dGVuIHRvIGFueSBmaWxlXG4gICAqL1xuICBvdXRwdXRzRmlsZT86IHN0cmluZztcblxuICAvKipcbiAgICogV2hldGhlciB3ZSBhcmUgb24gYSBDSSBzeXN0ZW1cbiAgICpcbiAgICogQGRlZmF1bHQgZmFsc2VcbiAgICovXG4gIHJlYWRvbmx5IGNpPzogYm9vbGVhbjtcblxuICAvKipcbiAgICogV2hldGhlciB0aGlzICdkZXBsb3knIGNvbW1hbmQgc2hvdWxkIGFjdHVhbGx5IGRlbGVnYXRlIHRvIHRoZSAnd2F0Y2gnIGNvbW1hbmQuXG4gICAqXG4gICAqIEBkZWZhdWx0IGZhbHNlXG4gICAqL1xuICByZWFkb25seSB3YXRjaD86IGJvb2xlYW47XG5cbiAgLyoqXG4gICAqIFdoZXRoZXIgd2Ugc2hvdWxkIGNhY2hlIHRoZSBDbG91ZCBBc3NlbWJseSBhZnRlciB0aGUgZmlyc3QgdGltZSBpdCBoYXMgYmVlbiBzeW50aGVzaXplZC5cbiAgICogVGhlIGRlZmF1bHQgaXMgJ3RydWUnLCB3ZSBvbmx5IGRvbid0IHdhbnQgdG8gZG8gaXQgaW4gY2FzZSB0aGUgZGVwbG95bWVudCBpcyB0cmlnZ2VyZWQgYnlcbiAgICogJ2NkayB3YXRjaCcuXG4gICAqXG4gICAqIEBkZWZhdWx0IHRydWVcbiAgICovXG4gIHJlYWRvbmx5IGNhY2hlQ2xvdWRBc3NlbWJseT86IGJvb2xlYW47XG5cbiAgLyoqXG4gICAqIEFsbG93cyBhZGRpbmcgQ2xvdWRXYXRjaCBsb2cgZ3JvdXBzIHRvIHRoZSBsb2cgbW9uaXRvciB2aWFcbiAgICogY2xvdWRXYXRjaExvZ01vbml0b3Iuc2V0TG9nR3JvdXBzKCk7XG4gICAqXG4gICAqIEBkZWZhdWx0IC0gbm90IG1vbml0b3JpbmcgQ2xvdWRXYXRjaCBsb2dzXG4gICAqL1xuICByZWFkb25seSBjbG91ZFdhdGNoTG9nTW9uaXRvcj86IENsb3VkV2F0Y2hMb2dFdmVudE1vbml0b3I7XG5cbiAgLyoqXG4gICAqIE1heGltdW0gbnVtYmVyIG9mIHNpbXVsdGFuZW91cyBkZXBsb3ltZW50cyAoZGVwZW5kZW5jeSBwZXJtaXR0aW5nKSB0byBleGVjdXRlLlxuICAgKiBUaGUgZGVmYXVsdCBpcyAnMScsIHdoaWNoIGV4ZWN1dGVzIGFsbCBkZXBsb3ltZW50cyBzZXJpYWxseS5cbiAgICpcbiAgICogQGRlZmF1bHQgMVxuICAgKi9cbiAgcmVhZG9ubHkgY29uY3VycmVuY3k/OiBudW1iZXI7XG5cbiAgLyoqXG4gICAqIEJ1aWxkL3B1Ymxpc2ggYXNzZXRzIGZvciBhIHNpbmdsZSBzdGFjayBpbiBwYXJhbGxlbFxuICAgKlxuICAgKiBJbmRlcGVuZGVudCBvZiB3aGV0aGVyIHN0YWNrcyBhcmUgYmVpbmcgZG9uZSBpbiBwYXJhbGxlbCBvciBuby5cbiAgICpcbiAgICogQGRlZmF1bHQgdHJ1ZVxuICAgKi9cbiAgcmVhZG9ubHkgYXNzZXRQYXJhbGxlbGlzbT86IGJvb2xlYW47XG5cbiAgLyoqXG4gICAqIFdoZW4gdG8gYnVpbGQgYXNzZXRzXG4gICAqXG4gICAqIFRoZSBkZWZhdWx0IGlzIHRoZSBEb2NrZXItZnJpZW5kbHkgZGVmYXVsdC5cbiAgICpcbiAgICogQGRlZmF1bHQgQXNzZXRCdWlsZFRpbWUuQUxMX0JFRk9SRV9ERVBMT1lcbiAgICovXG4gIHJlYWRvbmx5IGFzc2V0QnVpbGRUaW1lPzogQXNzZXRCdWlsZFRpbWU7XG5cbiAgLyoqXG4gICAqIFdoZXRoZXIgdG8gZGVwbG95IGlmIHRoZSBhcHAgY29udGFpbnMgbm8gc3RhY2tzLlxuICAgKlxuICAgKiBAZGVmYXVsdCBmYWxzZVxuICAgKi9cbiAgcmVhZG9ubHkgaWdub3JlTm9TdGFja3M/OiBib29sZWFuO1xufVxuXG5leHBvcnQgaW50ZXJmYWNlIFJvbGxiYWNrT3B0aW9ucyB7XG4gIC8qKlxuICAgKiBDcml0ZXJpYSBmb3Igc2VsZWN0aW5nIHN0YWNrcyB0byBkZXBsb3lcbiAgICovXG4gIHJlYWRvbmx5IHNlbGVjdG9yOiBTdGFja1NlbGVjdG9yO1xuXG4gIC8qKlxuICAgKiBOYW1lIG9mIHRoZSB0b29sa2l0IHN0YWNrIHRvIHVzZS9kZXBsb3lcbiAgICpcbiAgICogQGRlZmF1bHQgQ0RLVG9vbGtpdFxuICAgKi9cbiAgcmVhZG9ubHkgdG9vbGtpdFN0YWNrTmFtZT86IHN0cmluZztcblxuICAvKipcbiAgICogUm9sZSB0byBwYXNzIHRvIENsb3VkRm9ybWF0aW9uIGZvciBkZXBsb3ltZW50XG4gICAqXG4gICAqIEBkZWZhdWx0IC0gRGVmYXVsdCBzdGFjayByb2xlXG4gICAqL1xuICByZWFkb25seSByb2xlQXJuPzogc3RyaW5nO1xuXG4gIC8qKlxuICAgKiBXaGV0aGVyIHRvIGZvcmNlIHRoZSByb2xsYmFjayBvciBub3RcbiAgICpcbiAgICogQGRlZmF1bHQgZmFsc2VcbiAgICovXG4gIHJlYWRvbmx5IGZvcmNlPzogYm9vbGVhbjtcblxuICAvKipcbiAgICogTG9naWNhbCBJRHMgb2YgcmVzb3VyY2VzIHRvIG9ycGhhblxuICAgKlxuICAgKiBAZGVmYXVsdCAtIE5vIG9ycGhhbmluZ1xuICAgKi9cbiAgcmVhZG9ubHkgb3JwaGFuTG9naWNhbElkcz86IHN0cmluZ1tdO1xuXG4gIC8qKlxuICAgKiBXaGV0aGVyIHRvIHZhbGlkYXRlIHRoZSB2ZXJzaW9uIG9mIHRoZSBib290c3RyYXAgc3RhY2sgcGVybWlzc2lvbnNcbiAgICpcbiAgICogQGRlZmF1bHQgdHJ1ZVxuICAgKi9cbiAgcmVhZG9ubHkgdmFsaWRhdGVCb290c3RyYXBTdGFja1ZlcnNpb24/OiBib29sZWFuO1xufVxuXG5leHBvcnQgaW50ZXJmYWNlIEltcG9ydE9wdGlvbnMgZXh0ZW5kcyBDZm5EZXBsb3lPcHRpb25zIHtcbiAgLyoqXG4gICAqIEJ1aWxkIGEgcGh5c2ljYWwgcmVzb3VyY2UgbWFwcGluZyBhbmQgd3JpdGUgaXQgdG8gdGhlIGdpdmVuIGZpbGUsIHdpdGhvdXQgcGVyZm9ybWluZyB0aGUgYWN0dWFsIGltcG9ydCBvcGVyYXRpb25cbiAgICpcbiAgICogQGRlZmF1bHQgLSBObyBmaWxlXG4gICAqL1xuXG4gIHJlYWRvbmx5IHJlY29yZFJlc291cmNlTWFwcGluZz86IHN0cmluZztcblxuICAvKipcbiAgICogUGF0aCB0byBhIGZpbGUgd2l0aCB0aGUgcGh5c2ljYWwgcmVzb3VyY2UgbWFwcGluZyB0byBDREsgY29uc3RydWN0cyBpbiBKU09OIGZvcm1hdFxuICAgKlxuICAgKiBAZGVmYXVsdCAtIE5vIG1hcHBpbmcgZmlsZVxuICAgKi9cbiAgcmVhZG9ubHkgcmVzb3VyY2VNYXBwaW5nRmlsZT86IHN0cmluZztcblxuICAvKipcbiAgICogQWxsb3cgbm9uLWFkZGl0aW9uIGNoYW5nZXMgdG8gdGhlIHRlbXBsYXRlXG4gICAqXG4gICAqIEBkZWZhdWx0IGZhbHNlXG4gICAqL1xuICByZWFkb25seSBmb3JjZT86IGJvb2xlYW47XG59XG5cbmV4cG9ydCBpbnRlcmZhY2UgRGVzdHJveU9wdGlvbnMge1xuICAvKipcbiAgICogQ3JpdGVyaWEgZm9yIHNlbGVjdGluZyBzdGFja3MgdG8gZGVwbG95XG4gICAqL1xuICBzZWxlY3RvcjogU3RhY2tTZWxlY3RvcjtcblxuICAvKipcbiAgICogV2hldGhlciB0byBleGNsdWRlIHN0YWNrcyB0aGF0IGRlcGVuZCBvbiB0aGUgc3RhY2tzIHRvIGJlIGRlbGV0ZWRcbiAgICovXG4gIGV4Y2x1c2l2ZWx5OiBib29sZWFuO1xuXG4gIC8qKlxuICAgKiBXaGV0aGVyIHRvIHNraXAgcHJvbXB0aW5nIGZvciBjb25maXJtYXRpb25cbiAgICovXG4gIGZvcmNlOiBib29sZWFuO1xuXG4gIC8qKlxuICAgKiBUaGUgYXJuIG9mIHRoZSBJQU0gcm9sZSB0byB1c2VcbiAgICovXG4gIHJvbGVBcm4/OiBzdHJpbmc7XG5cbiAgLyoqXG4gICAqIFdoZXRoZXIgdGhlIGRlc3Ryb3kgcmVxdWVzdCBjYW1lIGZyb20gYSBkZXBsb3kuXG4gICAqL1xuICBmcm9tRGVwbG95PzogYm9vbGVhbjtcblxuICAvKipcbiAgICogV2hldGhlciB3ZSBhcmUgb24gYSBDSSBzeXN0ZW1cbiAgICpcbiAgICogQGRlZmF1bHQgZmFsc2VcbiAgICovXG4gIHJlYWRvbmx5IGNpPzogYm9vbGVhbjtcbn1cblxuLyoqXG4gKiBPcHRpb25zIGZvciB0aGUgZ2FyYmFnZSBjb2xsZWN0aW9uXG4gKi9cbmV4cG9ydCBpbnRlcmZhY2UgR2FyYmFnZUNvbGxlY3Rpb25PcHRpb25zIHtcbiAgLyoqXG4gICAqIFRoZSBhY3Rpb24gdG8gcGVyZm9ybS5cbiAgICpcbiAgICogQGRlZmF1bHQgJ2Z1bGwnXG4gICAqL1xuICByZWFkb25seSBhY3Rpb246ICdwcmludCcgfCAndGFnJyB8ICdkZWxldGUtdGFnZ2VkJyB8ICdmdWxsJztcblxuICAvKipcbiAgICogVGhlIHR5cGUgb2YgdGhlIGFzc2V0cyB0byBiZSBnYXJiYWdlIGNvbGxlY3RlZC5cbiAgICpcbiAgICogQGRlZmF1bHQgJ2FsbCdcbiAgICovXG4gIHJlYWRvbmx5IHR5cGU6ICdzMycgfCAnZWNyJyB8ICdhbGwnO1xuXG4gIC8qKlxuICAgKiBFbGFwc2VkIHRpbWUgYmV0d2VlbiBhbiBhc3NldCBiZWluZyBtYXJrZWQgYXMgaXNvbGF0ZWQgYW5kIGFjdHVhbGx5IGRlbGV0ZWQuXG4gICAqXG4gICAqIEBkZWZhdWx0IDBcbiAgICovXG4gIHJlYWRvbmx5IHJvbGxiYWNrQnVmZmVyRGF5czogbnVtYmVyO1xuXG4gIC8qKlxuICAgKiBSZWZ1c2UgZGVsZXRpb24gb2YgYW55IGFzc2V0cyB5b3VuZ2VyIHRoYW4gdGhpcyBudW1iZXIgb2YgZGF5cy5cbiAgICovXG4gIHJlYWRvbmx5IGNyZWF0ZWRCdWZmZXJEYXlzOiBudW1iZXI7XG5cbiAgLyoqXG4gICAqIFRoZSBzdGFjayBuYW1lIG9mIHRoZSBib290c3RyYXAgc3RhY2suXG4gICAqXG4gICAqIEBkZWZhdWx0IERFRkFVTFRfVE9PTEtJVF9TVEFDS19OQU1FXG4gICAqL1xuICByZWFkb25seSBib290c3RyYXBTdGFja05hbWU/OiBzdHJpbmc7XG5cbiAgLyoqXG4gICAqIFNraXBzIHRoZSBwcm9tcHQgYmVmb3JlIGFjdHVhbCBkZWxldGlvbiBiZWdpbnNcbiAgICpcbiAgICogQGRlZmF1bHQgZmFsc2VcbiAgICovXG4gIHJlYWRvbmx5IGNvbmZpcm0/OiBib29sZWFuO1xufVxuXG5leHBvcnQgaW50ZXJmYWNlIE1pZ3JhdGVPcHRpb25zIHtcbiAgLyoqXG4gICAqIFRoZSBuYW1lIGFzc2lnbmVkIHRvIHRoZSBnZW5lcmF0ZWQgc3RhY2suIFRoaXMgaXMgYWxzbyB1c2VkIHRvIGdldFxuICAgKiB0aGUgc3RhY2sgZnJvbSB0aGUgdXNlcidzIGFjY291bnQgaWYgYC0tZnJvbS1zdGFja2AgaXMgdXNlZC5cbiAgICovXG4gIHJlYWRvbmx5IHN0YWNrTmFtZTogc3RyaW5nO1xuXG4gIC8qKlxuICAgKiBUaGUgdGFyZ2V0IGxhbmd1YWdlIGZvciB0aGUgZ2VuZXJhdGVkIHRoZSBDREsgYXBwLlxuICAgKlxuICAgKiBAZGVmYXVsdCB0eXBlc2NyaXB0XG4gICAqL1xuICByZWFkb25seSBsYW5ndWFnZT86IHN0cmluZztcblxuICAvKipcbiAgICogVGhlIGxvY2FsIHBhdGggb2YgdGhlIHRlbXBsYXRlIHVzZWQgdG8gZ2VuZXJhdGUgdGhlIENESyBhcHAuXG4gICAqXG4gICAqIEBkZWZhdWx0IC0gTG9jYWwgcGF0aCBpcyBub3QgdXNlZCBmb3IgdGhlIHRlbXBsYXRlIHNvdXJjZS5cbiAgICovXG4gIHJlYWRvbmx5IGZyb21QYXRoPzogc3RyaW5nO1xuXG4gIC8qKlxuICAgKiBXaGV0aGVyIHRvIGdldCB0aGUgdGVtcGxhdGUgZnJvbSBhbiBleGlzdGluZyBDbG91ZEZvcm1hdGlvbiBzdGFjay5cbiAgICpcbiAgICogQGRlZmF1bHQgZmFsc2VcbiAgICovXG4gIHJlYWRvbmx5IGZyb21TdGFjaz86IGJvb2xlYW47XG5cbiAgLyoqXG4gICAqIFRoZSBvdXRwdXQgcGF0aCBhdCB3aGljaCB0byBjcmVhdGUgdGhlIENESyBhcHAuXG4gICAqXG4gICAqIEBkZWZhdWx0IC0gVGhlIGN1cnJlbnQgZGlyZWN0b3J5XG4gICAqL1xuICByZWFkb25seSBvdXRwdXRQYXRoPzogc3RyaW5nO1xuXG4gIC8qKlxuICAgKiBUaGUgYWNjb3VudCBmcm9tIHdoaWNoIHRvIHJldHJpZXZlIHRoZSB0ZW1wbGF0ZSBvZiB0aGUgQ2xvdWRGb3JtYXRpb24gc3RhY2suXG4gICAqXG4gICAqIEBkZWZhdWx0IC0gVXNlcyB0aGUgYWNjb3VudCBmb3IgdGhlIGNyZWRlbnRpYWxzIGluIHVzZSBieSB0aGUgdXNlci5cbiAgICovXG4gIHJlYWRvbmx5IGFjY291bnQ/OiBzdHJpbmc7XG5cbiAgLyoqXG4gICAqIFRoZSByZWdpb24gZnJvbSB3aGljaCB0byByZXRyaWV2ZSB0aGUgdGVtcGxhdGUgb2YgdGhlIENsb3VkRm9ybWF0aW9uIHN0YWNrLlxuICAgKlxuICAgKiBAZGVmYXVsdCAtIFVzZXMgdGhlIGRlZmF1bHQgcmVnaW9uIGZvciB0aGUgY3JlZGVudGlhbHMgaW4gdXNlIGJ5IHRoZSB1c2VyLlxuICAgKi9cbiAgcmVhZG9ubHkgcmVnaW9uPzogc3RyaW5nO1xuXG4gIC8qKlxuICAgKiBGaWx0ZXJpbmcgY3JpdGVyaWEgdXNlZCB0byBzZWxlY3QgdGhlIHJlc291cmNlcyB0byBiZSBpbmNsdWRlZCBpbiB0aGUgZ2VuZXJhdGVkIENESyBhcHAuXG4gICAqXG4gICAqIEBkZWZhdWx0IC0gSW5jbHVkZSBhbGwgcmVzb3VyY2VzXG4gICAqL1xuICByZWFkb25seSBmaWx0ZXI/OiBzdHJpbmdbXTtcblxuICAvKipcbiAgICogV2hldGhlciB0byBpbml0aWF0ZSBhIG5ldyBhY2NvdW50IHNjYW4gZm9yIGdlbmVyYXRpbmcgdGhlIENESyBhcHAuXG4gICAqXG4gICAqIEBkZWZhdWx0IGZhbHNlXG4gICAqL1xuICByZWFkb25seSBmcm9tU2Nhbj86IEZyb21TY2FuO1xuXG4gIC8qKlxuICAgKiBXaGV0aGVyIHRvIHppcCB0aGUgZ2VuZXJhdGVkIGNkayBhcHAgZm9sZGVyLlxuICAgKlxuICAgKiBAZGVmYXVsdCBmYWxzZVxuICAgKi9cbiAgcmVhZG9ubHkgY29tcHJlc3M/OiBib29sZWFuO1xufVxuXG4vKipcbiAqIEByZXR1cm5zIGFuIGFycmF5IHdpdGggdGhlIHRhZ3MgYXZhaWxhYmxlIGluIHRoZSBzdGFjayBtZXRhZGF0YS5cbiAqL1xuZnVuY3Rpb24gdGFnc0ZvclN0YWNrKHN0YWNrOiBjeGFwaS5DbG91ZEZvcm1hdGlvblN0YWNrQXJ0aWZhY3QpOiBUYWdbXSB7XG4gIHJldHVybiBPYmplY3QuZW50cmllcyhzdGFjay50YWdzKS5tYXAoKFtLZXksIFZhbHVlXSkgPT4gKHsgS2V5LCBWYWx1ZSB9KSk7XG59XG5cbmV4cG9ydCBpbnRlcmZhY2UgVGFnIHtcbiAgcmVhZG9ubHkgS2V5OiBzdHJpbmc7XG4gIHJlYWRvbmx5IFZhbHVlOiBzdHJpbmc7XG59XG5cbi8qKlxuICogRm9ybWF0cyB0aW1lIGluIG1pbGxpc2Vjb25kcyAod2hpY2ggd2UgZ2V0IGZyb20gJ0RhdGUuZ2V0VGltZSgpJylcbiAqIHRvIGEgaHVtYW4tcmVhZGFibGUgdGltZTsgcmV0dXJucyB0aW1lIGluIHNlY29uZHMgcm91bmRlZCB0byAyXG4gKiBkZWNpbWFsIHBsYWNlcy5cbiAqL1xuZnVuY3Rpb24gZm9ybWF0VGltZShudW06IG51bWJlcik6IG51bWJlciB7XG4gIHJldHVybiByb3VuZFBlcmNlbnRhZ2UobWlsbGlzZWNvbmRzVG9TZWNvbmRzKG51bSkpO1xufVxuXG4vKipcbiAqIFJvdW5kcyBhIGRlY2ltYWwgbnVtYmVyIHRvIHR3byBkZWNpbWFsIHBvaW50cy5cbiAqIFRoZSBmdW5jdGlvbiBpcyB1c2VmdWwgZm9yIGZyYWN0aW9ucyB0aGF0IG5lZWQgdG8gYmUgb3V0cHV0dGVkIGFzIHBlcmNlbnRhZ2VzLlxuICovXG5mdW5jdGlvbiByb3VuZFBlcmNlbnRhZ2UobnVtOiBudW1iZXIpOiBudW1iZXIge1xuICByZXR1cm4gTWF0aC5yb3VuZCgxMDAgKiBudW0pIC8gMTAwO1xufVxuXG4vKipcbiAqIEdpdmVuIGEgdGltZSBpbiBtaWxsaXNlY29uZHMsIHJldHVybiBhbiBlcXVpdmFsZW50IGFtb3VudCBpbiBzZWNvbmRzLlxuICovXG5mdW5jdGlvbiBtaWxsaXNlY29uZHNUb1NlY29uZHMobnVtOiBudW1iZXIpOiBudW1iZXIge1xuICByZXR1cm4gbnVtIC8gMTAwMDtcbn1cblxuZnVuY3Rpb24gYnVpbGRQYXJhbWV0ZXJNYXAoXG4gIHBhcmFtZXRlcnM6XG4gIHwge1xuICAgIFtuYW1lOiBzdHJpbmddOiBzdHJpbmcgfCB1bmRlZmluZWQ7XG4gIH1cbiAgfCB1bmRlZmluZWQsXG4pOiB7IFtuYW1lOiBzdHJpbmddOiB7IFtuYW1lOiBzdHJpbmddOiBzdHJpbmcgfCB1bmRlZmluZWQgfSB9IHtcbiAgY29uc3QgcGFyYW1ldGVyTWFwOiB7XG4gICAgW25hbWU6IHN0cmluZ106IHsgW25hbWU6IHN0cmluZ106IHN0cmluZyB8IHVuZGVmaW5lZCB9O1xuICB9ID0geyAnKic6IHt9IH07XG4gIGZvciAoY29uc3Qga2V5IGluIHBhcmFtZXRlcnMpIHtcbiAgICBpZiAocGFyYW1ldGVycy5oYXNPd25Qcm9wZXJ0eShrZXkpKSB7XG4gICAgICBjb25zdCBbc3RhY2ssIHBhcmFtZXRlcl0gPSBrZXkuc3BsaXQoJzonLCAyKTtcbiAgICAgIGlmICghcGFyYW1ldGVyKSB7XG4gICAgICAgIHBhcmFtZXRlck1hcFsnKiddW3N0YWNrXSA9IHBhcmFtZXRlcnNba2V5XTtcbiAgICAgIH0gZWxzZSB7XG4gICAgICAgIGlmICghcGFyYW1ldGVyTWFwW3N0YWNrXSkge1xuICAgICAgICAgIHBhcmFtZXRlck1hcFtzdGFja10gPSB7fTtcbiAgICAgICAgfVxuICAgICAgICBwYXJhbWV0ZXJNYXBbc3RhY2tdW3BhcmFtZXRlcl0gPSBwYXJhbWV0ZXJzW2tleV07XG4gICAgICB9XG4gICAgfVxuICB9XG5cbiAgcmV0dXJuIHBhcmFtZXRlck1hcDtcbn1cblxuLyoqXG4gKiBSZW1vdmUgYW55IHRlbXBsYXRlIGVsZW1lbnRzIHRoYXQgd2UgZG9uJ3Qgd2FudCB0byBzaG93IHVzZXJzLlxuICovXG5mdW5jdGlvbiBvYnNjdXJlVGVtcGxhdGUodGVtcGxhdGU6IGFueSA9IHt9KSB7XG4gIGlmICh0ZW1wbGF0ZS5SdWxlcykge1xuICAgIC8vIHNlZSBodHRwczovL2dpdGh1Yi5jb20vYXdzL2F3cy1jZGsvaXNzdWVzLzE3OTQyXG4gICAgaWYgKHRlbXBsYXRlLlJ1bGVzLkNoZWNrQm9vdHN0cmFwVmVyc2lvbikge1xuICAgICAgaWYgKE9iamVjdC5rZXlzKHRlbXBsYXRlLlJ1bGVzKS5sZW5ndGggPiAxKSB7XG4gICAgICAgIGRlbGV0ZSB0ZW1wbGF0ZS5SdWxlcy5DaGVja0Jvb3RzdHJhcFZlcnNpb247XG4gICAgICB9IGVsc2Uge1xuICAgICAgICBkZWxldGUgdGVtcGxhdGUuUnVsZXM7XG4gICAgICB9XG4gICAgfVxuICB9XG5cbiAgcmV0dXJuIHRlbXBsYXRlO1xufVxuXG4vKipcbiAqIEFzayB0aGUgdXNlciBmb3IgYSB5ZXMvbm8gY29uZmlybWF0aW9uXG4gKlxuICogQXV0b21hdGljYWxseSBmYWlsIHRoZSBjb25maXJtYXRpb24gaW4gY2FzZSB3ZSdyZSBpbiBhIHNpdHVhdGlvbiB3aGVyZSB0aGUgY29uZmlybWF0aW9uXG4gKiBjYW5ub3QgYmUgaW50ZXJhY3RpdmVseSBvYnRhaW5lZCBmcm9tIGEgaHVtYW4gYXQgdGhlIGtleWJvYXJkLlxuICovXG5hc3luYyBmdW5jdGlvbiBhc2tVc2VyQ29uZmlybWF0aW9uKFxuICBjb25jdXJyZW5jeTogbnVtYmVyLFxuICBtb3RpdmF0aW9uOiBzdHJpbmcsXG4gIHF1ZXN0aW9uOiBzdHJpbmcsXG4pIHtcbiAgYXdhaXQgd2l0aENvcmtlZExvZ2dpbmcoYXN5bmMgKCkgPT4ge1xuICAgIC8vIG9ubHkgdGFsayB0byB1c2VyIGlmIFNURElOIGlzIGEgdGVybWluYWwgKG90aGVyd2lzZSwgZmFpbClcbiAgICBpZiAoIVRFU1RJTkcgJiYgIXByb2Nlc3Muc3RkaW4uaXNUVFkpIHtcbiAgICAgIHRocm93IG5ldyBFcnJvcihgJHttb3RpdmF0aW9ufSwgYnV0IHRlcm1pbmFsIChUVFkpIGlzIG5vdCBhdHRhY2hlZCBzbyB3ZSBhcmUgdW5hYmxlIHRvIGdldCBhIGNvbmZpcm1hdGlvbiBmcm9tIHRoZSB1c2VyYCk7XG4gICAgfVxuXG4gICAgLy8gb25seSB0YWxrIHRvIHVzZXIgaWYgY29uY3VycmVuY3kgaXMgMSAob3RoZXJ3aXNlLCBmYWlsKVxuICAgIGlmIChjb25jdXJyZW5jeSA+IDEpIHtcbiAgICAgIHRocm93IG5ldyBFcnJvcihgJHttb3RpdmF0aW9ufSwgYnV0IGNvbmN1cnJlbmN5IGlzIGdyZWF0ZXIgdGhhbiAxIHNvIHdlIGFyZSB1bmFibGUgdG8gZ2V0IGEgY29uZmlybWF0aW9uIGZyb20gdGhlIHVzZXJgKTtcbiAgICB9XG5cbiAgICBjb25zdCBjb25maXJtZWQgPSBhd2FpdCBwcm9tcHRseS5jb25maXJtKGAke2NoYWxrLmN5YW4ocXVlc3Rpb24pfSAoeS9uKT9gKTtcbiAgICBpZiAoIWNvbmZpcm1lZCkgeyB0aHJvdyBuZXcgRXJyb3IoJ0Fib3J0ZWQgYnkgdXNlcicpOyB9XG4gIH0pO1xufVxuIl19