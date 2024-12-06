"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.assertIsSuccessfulDeployStackResult = assertIsSuccessfulDeployStackResult;
exports.deployStack = deployStack;
exports.destroyStack = destroyStack;
const chalk = require("chalk");
const uuid = require("uuid");
const evaluate_cloudformation_template_1 = require("./evaluate-cloudformation-template");
const common_1 = require("./hotswap/common");
const hotswap_deployments_1 = require("./hotswap-deployments");
const assets_1 = require("../assets");
const logging_1 = require("../logging");
const cloudformation_1 = require("./util/cloudformation");
const stack_activity_monitor_1 = require("./util/cloudformation/stack-activity-monitor");
const template_body_parameter_1 = require("./util/template-body-parameter");
const asset_manifest_builder_1 = require("../util/asset-manifest-builder");
const checks_1 = require("./util/checks");
const asset_publishing_1 = require("../util/asset-publishing");
function assertIsSuccessfulDeployStackResult(x) {
    if (x.type !== 'did-deploy-stack') {
        throw new Error(`Unexpected deployStack result. This should not happen: ${JSON.stringify(x)}. If you are seeing this error, please report it at https://github.com/aws/aws-cdk/issues/new/choose.`);
    }
}
async function deployStack(options) {
    const stackArtifact = options.stack;
    const stackEnv = options.resolvedEnvironment;
    options.sdk.appendCustomUserAgent(options.extraUserAgent);
    const cfn = options.sdk.cloudFormation();
    const deployName = options.deployName || stackArtifact.stackName;
    let cloudFormationStack = await cloudformation_1.CloudFormationStack.lookup(cfn, deployName);
    if (cloudFormationStack.stackStatus.isCreationFailure) {
        (0, logging_1.debug)(`Found existing stack ${deployName} that had previously failed creation. Deleting it before attempting to re-create it.`);
        await cfn.deleteStack({ StackName: deployName });
        const deletedStack = await (0, cloudformation_1.waitForStackDelete)(cfn, deployName);
        if (deletedStack && deletedStack.stackStatus.name !== 'DELETE_COMPLETE') {
            throw new Error(`Failed deleting stack ${deployName} that had previously failed creation (current state: ${deletedStack.stackStatus})`);
        }
        // Update variable to mark that the stack does not exist anymore, but avoid
        // doing an actual lookup in CloudFormation (which would be silly to do if
        // we just deleted it).
        cloudFormationStack = cloudformation_1.CloudFormationStack.doesNotExist(cfn, deployName);
    }
    // Detect "legacy" assets (which remain in the metadata) and publish them via
    // an ad-hoc asset manifest, while passing their locations via template
    // parameters.
    const legacyAssets = new asset_manifest_builder_1.AssetManifestBuilder();
    const assetParams = await (0, assets_1.addMetadataAssetsToManifest)(stackArtifact, legacyAssets, options.envResources, options.reuseAssets);
    const finalParameterValues = { ...options.parameters, ...assetParams };
    const templateParams = cloudformation_1.TemplateParameters.fromTemplate(stackArtifact.template);
    const stackParams = options.usePreviousParameters
        ? templateParams.updateExisting(finalParameterValues, cloudFormationStack.parameters)
        : templateParams.supplyAll(finalParameterValues);
    const hotswapMode = options.hotswap ?? common_1.HotswapMode.FULL_DEPLOYMENT;
    const hotswapPropertyOverrides = options.hotswapPropertyOverrides ?? new common_1.HotswapPropertyOverrides();
    if (await canSkipDeploy(options, cloudFormationStack, stackParams.hasChanges(cloudFormationStack.parameters))) {
        (0, logging_1.debug)(`${deployName}: skipping deployment (use --force to override)`);
        // if we can skip deployment and we are performing a hotswap, let the user know
        // that no hotswap deployment happened
        if (hotswapMode !== common_1.HotswapMode.FULL_DEPLOYMENT) {
            (0, logging_1.print)(`\n ${common_1.ICON} %s\n`, chalk.bold('hotswap deployment skipped - no changes were detected (use --force to override)'));
        }
        return {
            type: 'did-deploy-stack',
            noOp: true,
            outputs: cloudFormationStack.outputs,
            stackArn: cloudFormationStack.stackId,
        };
    }
    else {
        (0, logging_1.debug)(`${deployName}: deploying...`);
    }
    const bodyParameter = await (0, template_body_parameter_1.makeBodyParameter)(stackArtifact, options.resolvedEnvironment, legacyAssets, options.envResources, options.overrideTemplate);
    let bootstrapStackName;
    try {
        bootstrapStackName = (await options.envResources.lookupToolkit()).stackName;
    }
    catch (e) {
        (0, logging_1.debug)(`Could not determine the bootstrap stack name: ${e}`);
    }
    await (0, asset_publishing_1.publishAssets)(legacyAssets.toManifest(stackArtifact.assembly.directory), options.sdkProvider, stackEnv, {
        parallel: options.assetParallelism,
        allowCrossAccount: await (0, checks_1.determineAllowCrossAccountAssetPublishing)(options.sdk, bootstrapStackName),
    });
    if (hotswapMode !== common_1.HotswapMode.FULL_DEPLOYMENT) {
        // attempt to short-circuit the deployment if possible
        try {
            const hotswapDeploymentResult = await (0, hotswap_deployments_1.tryHotswapDeployment)(options.sdkProvider, stackParams.values, cloudFormationStack, stackArtifact, hotswapMode, hotswapPropertyOverrides);
            if (hotswapDeploymentResult) {
                return hotswapDeploymentResult;
            }
            (0, logging_1.print)('Could not perform a hotswap deployment, as the stack %s contains non-Asset changes', stackArtifact.displayName);
        }
        catch (e) {
            if (!(e instanceof evaluate_cloudformation_template_1.CfnEvaluationException)) {
                throw e;
            }
            (0, logging_1.print)('Could not perform a hotswap deployment, because the CloudFormation template could not be resolved: %s', e.message);
        }
        if (hotswapMode === common_1.HotswapMode.FALL_BACK) {
            (0, logging_1.print)('Falling back to doing a full deployment');
            options.sdk.appendCustomUserAgent('cdk-hotswap/fallback');
        }
        else {
            return {
                type: 'did-deploy-stack',
                noOp: true,
                stackArn: cloudFormationStack.stackId,
                outputs: cloudFormationStack.outputs,
            };
        }
    }
    // could not short-circuit the deployment, perform a full CFN deploy instead
    const fullDeployment = new FullCloudFormationDeployment(options, cloudFormationStack, stackArtifact, stackParams, bodyParameter);
    return fullDeployment.performDeployment();
}
/**
 * This class shares state and functionality between the different full deployment modes
 */
class FullCloudFormationDeployment {
    constructor(options, cloudFormationStack, stackArtifact, stackParams, bodyParameter) {
        this.options = options;
        this.cloudFormationStack = cloudFormationStack;
        this.stackArtifact = stackArtifact;
        this.stackParams = stackParams;
        this.bodyParameter = bodyParameter;
        this.cfn = options.sdk.cloudFormation();
        this.stackName = options.deployName ?? stackArtifact.stackName;
        this.update = cloudFormationStack.exists && cloudFormationStack.stackStatus.name !== 'REVIEW_IN_PROGRESS';
        this.verb = this.update ? 'update' : 'create';
        this.uuid = uuid.v4();
    }
    async performDeployment() {
        const deploymentMethod = this.options.deploymentMethod ?? {
            method: 'change-set',
        };
        if (deploymentMethod.method === 'direct' && this.options.resourcesToImport) {
            throw new Error('Importing resources requires a changeset deployment');
        }
        switch (deploymentMethod.method) {
            case 'change-set':
                return this.changeSetDeployment(deploymentMethod);
            case 'direct':
                return this.directDeployment();
        }
    }
    async changeSetDeployment(deploymentMethod) {
        const changeSetName = deploymentMethod.changeSetName ?? 'cdk-deploy-change-set';
        const execute = deploymentMethod.execute ?? true;
        const changeSetDescription = await this.createChangeSet(changeSetName, execute);
        await this.updateTerminationProtection();
        if ((0, cloudformation_1.changeSetHasNoChanges)(changeSetDescription)) {
            (0, logging_1.debug)('No changes are to be performed on %s.', this.stackName);
            if (execute) {
                (0, logging_1.debug)('Deleting empty change set %s', changeSetDescription.ChangeSetId);
                await this.cfn.deleteChangeSet({
                    StackName: this.stackName,
                    ChangeSetName: changeSetName,
                });
            }
            if (this.options.force) {
                (0, logging_1.warning)([
                    'You used the --force flag, but CloudFormation reported that the deployment would not make any changes.',
                    'According to CloudFormation, all resources are already up-to-date with the state in your CDK app.',
                    '',
                    'You cannot use the --force flag to get rid of changes you made in the console. Try using',
                    'CloudFormation drift detection instead: https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/using-cfn-stack-drift.html',
                ].join('\n'));
            }
            return {
                type: 'did-deploy-stack',
                noOp: true,
                outputs: this.cloudFormationStack.outputs,
                stackArn: changeSetDescription.StackId,
            };
        }
        if (!execute) {
            (0, logging_1.print)('Changeset %s created and waiting in review for manual execution (--no-execute)', changeSetDescription.ChangeSetId);
            return {
                type: 'did-deploy-stack',
                noOp: false,
                outputs: this.cloudFormationStack.outputs,
                stackArn: changeSetDescription.StackId,
            };
        }
        // If there are replacements in the changeset, check the rollback flag and stack status
        const replacement = hasReplacement(changeSetDescription);
        const isPausedFailState = this.cloudFormationStack.stackStatus.isRollbackable;
        const rollback = this.options.rollback ?? true;
        if (isPausedFailState && replacement) {
            return { type: 'failpaused-need-rollback-first', reason: 'replacement' };
        }
        if (isPausedFailState && !rollback) {
            return { type: 'failpaused-need-rollback-first', reason: 'not-norollback' };
        }
        if (!rollback && replacement) {
            return { type: 'replacement-requires-norollback' };
        }
        return this.executeChangeSet(changeSetDescription);
    }
    async createChangeSet(changeSetName, willExecute) {
        await this.cleanupOldChangeset(changeSetName);
        (0, logging_1.debug)(`Attempting to create ChangeSet with name ${changeSetName} to ${this.verb} stack ${this.stackName}`);
        (0, logging_1.print)('%s: creating CloudFormation changeset...', chalk.bold(this.stackName));
        const changeSet = await this.cfn.createChangeSet({
            StackName: this.stackName,
            ChangeSetName: changeSetName,
            ChangeSetType: this.options.resourcesToImport ? 'IMPORT' : this.update ? 'UPDATE' : 'CREATE',
            ResourcesToImport: this.options.resourcesToImport,
            Description: `CDK Changeset for execution ${this.uuid}`,
            ClientToken: `create${this.uuid}`,
            ...this.commonPrepareOptions(),
        });
        (0, logging_1.debug)('Initiated creation of changeset: %s; waiting for it to finish creating...', changeSet.Id);
        // Fetching all pages if we'll execute, so we can have the correct change count when monitoring.
        return (0, cloudformation_1.waitForChangeSet)(this.cfn, this.stackName, changeSetName, {
            fetchAll: willExecute,
        });
    }
    async executeChangeSet(changeSet) {
        (0, logging_1.debug)('Initiating execution of changeset %s on stack %s', changeSet.ChangeSetId, this.stackName);
        await this.cfn.executeChangeSet({
            StackName: this.stackName,
            ChangeSetName: changeSet.ChangeSetName,
            ClientRequestToken: `exec${this.uuid}`,
            ...this.commonExecuteOptions(),
        });
        (0, logging_1.debug)('Execution of changeset %s on stack %s has started; waiting for the update to complete...', changeSet.ChangeSetId, this.stackName);
        // +1 for the extra event emitted from updates.
        const changeSetLength = (changeSet.Changes ?? []).length + (this.update ? 1 : 0);
        return this.monitorDeployment(changeSet.CreationTime, changeSetLength);
    }
    async cleanupOldChangeset(changeSetName) {
        if (this.cloudFormationStack.exists) {
            // Delete any existing change sets generated by CDK since change set names must be unique.
            // The delete request is successful as long as the stack exists (even if the change set does not exist).
            (0, logging_1.debug)(`Removing existing change set with name ${changeSetName} if it exists`);
            await this.cfn.deleteChangeSet({
                StackName: this.stackName,
                ChangeSetName: changeSetName,
            });
        }
    }
    async updateTerminationProtection() {
        // Update termination protection only if it has changed.
        const terminationProtection = this.stackArtifact.terminationProtection ?? false;
        if (!!this.cloudFormationStack.terminationProtection !== terminationProtection) {
            (0, logging_1.debug)('Updating termination protection from %s to %s for stack %s', this.cloudFormationStack.terminationProtection, terminationProtection, this.stackName);
            await this.cfn.updateTerminationProtection({
                StackName: this.stackName,
                EnableTerminationProtection: terminationProtection,
            });
            (0, logging_1.debug)('Termination protection updated to %s for stack %s', terminationProtection, this.stackName);
        }
    }
    async directDeployment() {
        (0, logging_1.print)('%s: %s stack...', chalk.bold(this.stackName), this.update ? 'updating' : 'creating');
        const startTime = new Date();
        if (this.update) {
            await this.updateTerminationProtection();
            try {
                await this.cfn.updateStack({
                    StackName: this.stackName,
                    ClientRequestToken: `update${this.uuid}`,
                    ...this.commonPrepareOptions(),
                    ...this.commonExecuteOptions(),
                });
            }
            catch (err) {
                if (err.message === 'No updates are to be performed.') {
                    (0, logging_1.debug)('No updates are to be performed for stack %s', this.stackName);
                    return {
                        type: 'did-deploy-stack',
                        noOp: true,
                        outputs: this.cloudFormationStack.outputs,
                        stackArn: this.cloudFormationStack.stackId,
                    };
                }
                throw err;
            }
            return this.monitorDeployment(startTime, undefined);
        }
        else {
            // Take advantage of the fact that we can set termination protection during create
            const terminationProtection = this.stackArtifact.terminationProtection ?? false;
            await this.cfn.createStack({
                StackName: this.stackName,
                ClientRequestToken: `create${this.uuid}`,
                ...(terminationProtection ? { EnableTerminationProtection: true } : undefined),
                ...this.commonPrepareOptions(),
                ...this.commonExecuteOptions(),
            });
            return this.monitorDeployment(startTime, undefined);
        }
    }
    async monitorDeployment(startTime, expectedChanges) {
        const monitor = this.options.quiet
            ? undefined
            : stack_activity_monitor_1.StackActivityMonitor.withDefaultPrinter(this.cfn, this.stackName, this.stackArtifact, {
                resourcesTotal: expectedChanges,
                progress: this.options.progress,
                changeSetCreationTime: startTime,
                ci: this.options.ci,
            }).start();
        let finalState = this.cloudFormationStack;
        try {
            const successStack = await (0, cloudformation_1.waitForStackDeploy)(this.cfn, this.stackName);
            // This shouldn't really happen, but catch it anyway. You never know.
            if (!successStack) {
                throw new Error('Stack deploy failed (the stack disappeared while we were deploying it)');
            }
            finalState = successStack;
        }
        catch (e) {
            throw new Error(suffixWithErrors(e.message, monitor?.errors));
        }
        finally {
            await monitor?.stop();
        }
        (0, logging_1.debug)('Stack %s has completed updating', this.stackName);
        return {
            type: 'did-deploy-stack',
            noOp: false,
            outputs: finalState.outputs,
            stackArn: finalState.stackId,
        };
    }
    /**
     * Return the options that are shared between CreateStack, UpdateStack and CreateChangeSet
     */
    commonPrepareOptions() {
        return {
            Capabilities: ['CAPABILITY_IAM', 'CAPABILITY_NAMED_IAM', 'CAPABILITY_AUTO_EXPAND'],
            NotificationARNs: this.options.notificationArns,
            Parameters: this.stackParams.apiParameters,
            RoleARN: this.options.roleArn,
            TemplateBody: this.bodyParameter.TemplateBody,
            TemplateURL: this.bodyParameter.TemplateURL,
            Tags: this.options.tags,
        };
    }
    /**
     * Return the options that are shared between UpdateStack and CreateChangeSet
     *
     * Be careful not to add in keys for options that aren't used, as the features may not have been
     * deployed everywhere yet.
     */
    commonExecuteOptions() {
        const shouldDisableRollback = this.options.rollback === false;
        return {
            StackName: this.stackName,
            ...(shouldDisableRollback ? { DisableRollback: true } : undefined),
        };
    }
}
async function destroyStack(options) {
    const deployName = options.deployName || options.stack.stackName;
    const cfn = options.sdk.cloudFormation();
    const currentStack = await cloudformation_1.CloudFormationStack.lookup(cfn, deployName);
    if (!currentStack.exists) {
        return;
    }
    const monitor = options.quiet
        ? undefined
        : stack_activity_monitor_1.StackActivityMonitor.withDefaultPrinter(cfn, deployName, options.stack, {
            ci: options.ci,
        }).start();
    try {
        await cfn.deleteStack({ StackName: deployName, RoleARN: options.roleArn });
        const destroyedStack = await (0, cloudformation_1.waitForStackDelete)(cfn, deployName);
        if (destroyedStack && destroyedStack.stackStatus.name !== 'DELETE_COMPLETE') {
            throw new Error(`Failed to destroy ${deployName}: ${destroyedStack.stackStatus}`);
        }
    }
    catch (e) {
        throw new Error(suffixWithErrors(e.message, monitor?.errors));
    }
    finally {
        if (monitor) {
            await monitor.stop();
        }
    }
}
/**
 * Checks whether we can skip deployment
 *
 * We do this in a complicated way by preprocessing (instead of just
 * looking at the changeset), because if there are nested stacks involved
 * the changeset will always show the nested stacks as needing to be
 * updated, and the deployment will take a long time to in effect not
 * do anything.
 */
async function canSkipDeploy(deployStackOptions, cloudFormationStack, parameterChanges) {
    const deployName = deployStackOptions.deployName || deployStackOptions.stack.stackName;
    (0, logging_1.debug)(`${deployName}: checking if we can skip deploy`);
    // Forced deploy
    if (deployStackOptions.force) {
        (0, logging_1.debug)(`${deployName}: forced deployment`);
        return false;
    }
    // Creating changeset only (default true), never skip
    if (deployStackOptions.deploymentMethod?.method === 'change-set' &&
        deployStackOptions.deploymentMethod.execute === false) {
        (0, logging_1.debug)(`${deployName}: --no-execute, always creating change set`);
        return false;
    }
    // No existing stack
    if (!cloudFormationStack.exists) {
        (0, logging_1.debug)(`${deployName}: no existing stack`);
        return false;
    }
    // Template has changed (assets taken into account here)
    if (JSON.stringify(deployStackOptions.stack.template) !== JSON.stringify(await cloudFormationStack.template())) {
        (0, logging_1.debug)(`${deployName}: template has changed`);
        return false;
    }
    // Tags have changed
    if (!compareTags(cloudFormationStack.tags, deployStackOptions.tags ?? [])) {
        (0, logging_1.debug)(`${deployName}: tags have changed`);
        return false;
    }
    // Notification arns have changed
    if (!arrayEquals(cloudFormationStack.notificationArns, deployStackOptions.notificationArns ?? [])) {
        (0, logging_1.debug)(`${deployName}: notification arns have changed`);
        return false;
    }
    // Termination protection has been updated
    if (!!deployStackOptions.stack.terminationProtection !== !!cloudFormationStack.terminationProtection) {
        (0, logging_1.debug)(`${deployName}: termination protection has been updated`);
        return false;
    }
    // Parameters have changed
    if (parameterChanges) {
        if (parameterChanges === 'ssm') {
            (0, logging_1.debug)(`${deployName}: some parameters come from SSM so we have to assume they may have changed`);
        }
        else {
            (0, logging_1.debug)(`${deployName}: parameters have changed`);
        }
        return false;
    }
    // Existing stack is in a failed state
    if (cloudFormationStack.stackStatus.isFailure) {
        (0, logging_1.debug)(`${deployName}: stack is in a failure state`);
        return false;
    }
    // We can skip deploy
    return true;
}
/**
 * Compares two list of tags, returns true if identical.
 */
function compareTags(a, b) {
    if (a.length !== b.length) {
        return false;
    }
    for (const aTag of a) {
        const bTag = b.find((tag) => tag.Key === aTag.Key);
        if (!bTag || bTag.Value !== aTag.Value) {
            return false;
        }
    }
    return true;
}
function suffixWithErrors(msg, errors) {
    return errors && errors.length > 0 ? `${msg}: ${errors.join(', ')}` : msg;
}
function arrayEquals(a, b) {
    return a.every((item) => b.includes(item)) && b.every((item) => a.includes(item));
}
function hasReplacement(cs) {
    return (cs.Changes ?? []).some(c => {
        const a = c.ResourceChange?.PolicyAction;
        return a === 'ReplaceAndDelete' || a === 'ReplaceAndRetain' || a === 'ReplaceAndSnapshot';
    });
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiZGVwbG95LXN0YWNrLmpzIiwic291cmNlUm9vdCI6IiIsInNvdXJjZXMiOlsiZGVwbG95LXN0YWNrLnRzIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiI7O0FBNkRBLGtGQUlDO0FBZ05ELGtDQXVJQztBQXlURCxvQ0EyQkM7QUFudUJELCtCQUErQjtBQUMvQiw2QkFBNkI7QUFHN0IseUZBQTRFO0FBQzVFLDZDQUErRTtBQUMvRSwrREFBNkQ7QUFDN0Qsc0NBQXdEO0FBQ3hELHdDQUFtRDtBQUNuRCwwREFVK0I7QUFDL0IseUZBQWdIO0FBQ2hILDRFQUErRjtBQUMvRiwyRUFBc0U7QUFDdEUsMENBQTBFO0FBQzFFLCtEQUF5RDtBQTRCekQsU0FBZ0IsbUNBQW1DLENBQUMsQ0FBb0I7SUFDdEUsSUFBSSxDQUFDLENBQUMsSUFBSSxLQUFLLGtCQUFrQixFQUFFLENBQUM7UUFDbEMsTUFBTSxJQUFJLEtBQUssQ0FBQywwREFBMEQsSUFBSSxDQUFDLFNBQVMsQ0FBQyxDQUFDLENBQUMsdUdBQXVHLENBQUMsQ0FBQztJQUN0TSxDQUFDO0FBQ0gsQ0FBQztBQWdOTSxLQUFLLFVBQVUsV0FBVyxDQUFDLE9BQTJCO0lBQzNELE1BQU0sYUFBYSxHQUFHLE9BQU8sQ0FBQyxLQUFLLENBQUM7SUFFcEMsTUFBTSxRQUFRLEdBQUcsT0FBTyxDQUFDLG1CQUFtQixDQUFDO0lBRTdDLE9BQU8sQ0FBQyxHQUFHLENBQUMscUJBQXFCLENBQUMsT0FBTyxDQUFDLGNBQWMsQ0FBQyxDQUFDO0lBQzFELE1BQU0sR0FBRyxHQUFHLE9BQU8sQ0FBQyxHQUFHLENBQUMsY0FBYyxFQUFFLENBQUM7SUFDekMsTUFBTSxVQUFVLEdBQUcsT0FBTyxDQUFDLFVBQVUsSUFBSSxhQUFhLENBQUMsU0FBUyxDQUFDO0lBQ2pFLElBQUksbUJBQW1CLEdBQUcsTUFBTSxvQ0FBbUIsQ0FBQyxNQUFNLENBQUMsR0FBRyxFQUFFLFVBQVUsQ0FBQyxDQUFDO0lBRTVFLElBQUksbUJBQW1CLENBQUMsV0FBVyxDQUFD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SSxJQUFJLENBQUMsS0FBSyxLQUFLLElBQUksQ0FBQyxLQUFLLEVBQUUsQ0FBQztZQUN2QyxPQUFPLEtBQUssQ0FBQztRQUNmLENBQUM7SUFDSCxDQUFDO0lBRUQsT0FBTyxJQUFJLENBQUM7QUFDZCxDQUFDO0FBRUQsU0FBUyxnQkFBZ0IsQ0FBQyxHQUFXLEVBQUUsTUFBaUI7SUFDdEQsT0FBTyxNQUFNLElBQUksTUFBTSxDQUFDLE1BQU0sR0FBRyxDQUFDLENBQUMsQ0FBQyxDQUFDLEdBQUcsR0FBRyxLQUFLLE1BQU0sQ0FBQyxJQUFJLENBQUMsSUFBSSxDQUFDLEVBQUUsQ0FBQyxDQUFDLENBQUMsR0FBRyxDQUFDO0FBQzVFLENBQUM7QUFFRCxTQUFTLFdBQVcsQ0FBQyxDQUFRLEVBQUUsQ0FBUTtJQUNyQyxPQUFPLENBQUMsQ0FBQyxLQUFLLENBQUMsQ0FBQyxJQUFJLEVBQUUsRUFBRSxDQUFDLENBQUMsQ0FBQyxRQUFRLENBQUMsSUFBSSxDQUFDLENBQUMsSUFBSSxDQUFDLENBQUMsS0FBSyxDQUFDLENBQUMsSUFBSSxFQUFFLEVBQUUsQ0FBQyxDQUFDLENBQUMsUUFBUSxDQUFDLElBQUksQ0FBQyxDQUFDLENBQUM7QUFDcEYsQ0FBQztBQUVELFNBQVMsY0FBYyxDQUFDLEVBQWtDO0lBQ3hELE9BQU8sQ0FBQyxFQUFFLENBQUMsT0FBTyxJQUFJLEVBQUUsQ0FBQyxDQUFDLElBQUksQ0FBQyxDQUFDLENBQUMsRUFBRTtRQUNqQyxNQUFNLENBQUMsR0FBRyxDQUFDLENBQUMsY0FBYyxFQUFFLFlBQVksQ0FBQztRQUN6QyxPQUFPLENBQUMsS0FBSyxrQkFBa0IsSUFBSSxDQUFDLEtBQUssa0JBQWtCLElBQUksQ0FBQyxLQUFLLG9CQUFvQixDQUFDO0lBQzVGLENBQUMsQ0FBQyxDQUFDO0FBQ0wsQ0FBQyIsInNvdXJjZXNDb250ZW50IjpbImltcG9ydCAqIGFzIGN4YXBpIGZyb20gJ0Bhd3MtY2RrL2N4LWFwaSc7XG5pbXBvcnQgdHlwZSB7XG4gIENyZWF0ZUNoYW5nZVNldENvbW1hbmRJbnB1dCxcbiAgQ3JlYXRlU3RhY2tDb21tYW5kSW5wdXQsXG4gIERlc2NyaWJlQ2hhbmdlU2V0Q29tbWFuZE91dHB1dCxcbiAgRXhlY3V0ZUNoYW5nZVNldENvbW1hbmRJbnB1dCxcbiAgVXBkYXRlU3RhY2tDb21tYW5kSW5wdXQsXG4gIFRhZyxcbn0gZnJvbSAnQGF3cy1zZGsvY2xpZW50LWNsb3VkZm9ybWF0aW9uJztcbmltcG9ydCAqIGFzIGNoYWxrIGZyb20gJ2NoYWxrJztcbmltcG9ydCAqIGFzIHV1aWQgZnJvbSAndXVpZCc7XG5pbXBvcnQgdHlwZSB7IFNESywgU2RrUHJvdmlkZXIsIElDbG91ZEZvcm1hdGlvbkNsaWVudCB9IGZyb20gJy4vYXdzLWF1dGgnO1xuaW1wb3J0IHR5cGUgeyBFbnZpcm9ubWVudFJlc291cmNlcyB9IGZyb20gJy4vZW52aXJvbm1lbnQtcmVzb3VyY2VzJztcbmltcG9ydCB7IENmbkV2YWx1YXRpb25FeGNlcHRpb24gfSBmcm9tICcuL2V2YWx1YXRlLWNsb3VkZm9ybWF0aW9uLXRlbXBsYXRlJztcbmltcG9ydCB7IEhvdHN3YXBNb2RlLCBIb3Rzd2FwUHJvcGVydHlPdmVycmlkZXMsIElDT04gfSBmcm9tICcuL2hvdHN3YXAvY29tbW9uJztcbmltcG9ydCB7IHRyeUhvdHN3YXBEZXBsb3ltZW50IH0gZnJvbSAnLi9ob3Rzd2FwLWRlcGxveW1lbnRzJztcbmltcG9ydCB7IGFkZE1ldGFkYXRhQXNzZXRzVG9NYW5pZmVzdCB9IGZyb20gJy4uL2Fzc2V0cyc7XG5pbXBvcnQgeyBkZWJ1ZywgcHJpbnQsIHdhcm5pbmcgfSBmcm9tICcuLi9sb2dnaW5nJztcbmltcG9ydCB7XG4gIGNoYW5nZVNldEhhc05vQ2hhbmdlcyxcbiAgQ2xvdWRGb3JtYXRpb25TdGFjayxcbiAgVGVtcGxhdGVQYXJhbWV0ZXJzLFxuICB3YWl0Rm9yQ2hhbmdlU2V0LFxuICB3YWl0Rm9yU3RhY2tEZXBsb3ksXG4gIHdhaXRGb3JTdGFja0RlbGV0ZSxcbiAgUGFyYW1ldGVyVmFsdWVzLFxuICBQYXJhbWV0ZXJDaGFuZ2VzLFxuICBSZXNvdXJjZXNUb0ltcG9ydCxcbn0gZnJvbSAnLi91dGlsL2Nsb3VkZm9ybWF0aW9uJztcbmltcG9ydCB7IFN0YWNrQWN0aXZpdHlNb25pdG9yLCB0eXBlIFN0YWNrQWN0aXZpdHlQcm9ncmVzcyB9IGZyb20gJy4vdXRpbC9jbG91ZGZvcm1hdGlvbi9zdGFjay1hY3Rpdml0eS1tb25pdG9yJztcbmltcG9ydCB7IHR5cGUgVGVtcGxhdGVCb2R5UGFyYW1ldGVyLCBtYWtlQm9keVBhcmFtZXRlciB9IGZyb20gJy4vdXRpbC90ZW1wbGF0ZS1ib2R5LXBhcmFtZXRlcic7XG5pbXBvcnQgeyBBc3NldE1hbmlmZXN0QnVpbGRlciB9IGZyb20gJy4uL3V0aWwvYXNzZXQtbWFuaWZlc3QtYnVpbGRlcic7XG5pbXBvcnQgeyBkZXRlcm1pbmVBbGxvd0Nyb3NzQWNjb3VudEFzc2V0UHVibGlzaGluZyB9IGZyb20gJy4vdXRpbC9jaGVja3MnO1xuaW1wb3J0IHsgcHVibGlzaEFzc2V0cyB9IGZyb20gJy4uL3V0aWwvYXNzZXQtcHVibGlzaGluZyc7XG5pbXBvcnQgeyBTdHJpbmdXaXRob3V0UGxhY2Vob2xkZXJzIH0gZnJvbSAnLi91dGlsL3BsYWNlaG9sZGVycyc7XG5cbmV4cG9ydCB0eXBlIERlcGxveVN0YWNrUmVzdWx0ID1cbiAgfCBTdWNjZXNzZnVsRGVwbG95U3RhY2tSZXN1bHRcbiAgfCBOZWVkUm9sbGJhY2tGaXJzdERlcGxveVN0YWNrUmVzdWx0XG4gIHwgUmVwbGFjZW1lbnRSZXF1aXJlc05vUm9sbGJhY2tTdGFja1Jlc3VsdFxuICA7XG5cbi8qKiBTdWNjZXNzZnVsbHkgZGVwbG95ZWQgYSBzdGFjayAqL1xuZXhwb3J0IGludGVyZmFjZSBTdWNjZXNzZnVsRGVwbG95U3RhY2tSZXN1bHQge1xuICByZWFkb25seSB0eXBlOiAnZGlkLWRlcGxveS1zdGFjayc7XG4gIHJlYWRvbmx5IG5vT3A6IGJvb2xlYW47XG4gIHJlYWRvbmx5IG91dHB1dHM6IHsgW25hbWU6IHN0cmluZ106IHN0cmluZyB9O1xuICByZWFkb25seSBzdGFja0Fybjogc3RyaW5nO1xufVxuXG4vKiogVGhlIHN0YWNrIGlzIGN1cnJlbnRseSBpbiBhIGZhaWxwYXVzZWQgc3RhdGUsIGFuZCBuZWVkcyB0byBiZSByb2xsZWQgYmFjayBiZWZvcmUgdGhlIGRlcGxveW1lbnQgKi9cbmV4cG9ydCBpbnRlcmZhY2UgTmVlZFJvbGxiYWNrRmlyc3REZXBsb3lTdGFja1Jlc3VsdCB7XG4gIHJlYWRvbmx5IHR5cGU6ICdmYWlscGF1c2VkLW5lZWQtcm9sbGJhY2stZmlyc3QnO1xuICByZWFkb25seSByZWFzb246ICdub3Qtbm9yb2xsYmFjaycgfCAncmVwbGFjZW1lbnQnO1xufVxuXG4vKiogVGhlIHVwY29taW5nIGNoYW5nZSBoYXMgYSByZXBsYWNlbWVudCwgd2hpY2ggcmVxdWlyZXMgZGVwbG95aW5nIHdpdGhvdXQgLS1uby1yb2xsYmFjayAqL1xuZXhwb3J0IGludGVyZmFjZSBSZXBsYWNlbWVudFJlcXVpcmVzTm9Sb2xsYmFja1N0YWNrUmVzdWx0IHtcbiAgcmVhZG9ubHkgdHlwZTogJ3JlcGxhY2VtZW50LXJlcXVpcmVzLW5vcm9sbGJhY2snO1xufVxuXG5leHBvcnQgZnVuY3Rpb24gYXNzZXJ0SXNTdWNjZXNzZnVsRGVwbG95U3RhY2tSZXN1bHQoeDogRGVwbG95U3RhY2tSZXN1bHQpOiBhc3NlcnRzIHggaXMgU3VjY2Vzc2Z1bERlcGxveVN0YWNrUmVzdWx0IHtcbiAgaWYgKHgudHlwZSAhPT0gJ2RpZC1kZXBsb3ktc3RhY2snKSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKGBVbmV4cGVjdGVkIGRlcGxveVN0YWNrIHJlc3VsdC4gVGhpcyBzaG91bGQgbm90IGhhcHBlbjogJHtKU09OLnN0cmluZ2lmeSh4KX0uIElmIHlvdSBhcmUgc2VlaW5nIHRoaXMgZXJyb3IsIHBsZWFzZSByZXBvcnQgaXQgYXQgaHR0cHM6Ly9naXRodWIuY29tL2F3cy9hd3MtY2RrL2lzc3Vlcy9uZXcvY2hvb3NlLmApO1xuICB9XG59XG5cbmV4cG9ydCBpbnRlcmZhY2UgRGVwbG95U3RhY2tPcHRpb25zIHtcbiAgLyoqXG4gICAqIFRoZSBzdGFjayB0byBiZSBkZXBsb3llZFxuICAgKi9cbiAgcmVhZG9ubHkgc3RhY2s6IGN4YXBpLkNsb3VkRm9ybWF0aW9uU3RhY2tBcnRpZmFjdDtcblxuICAvKipcbiAgICogVGhlIGVudmlyb25tZW50IHRvIGRlcGxveSB0aGlzIHN0YWNrIGluXG4gICAqXG4gICAqIFRoZSBlbnZpcm9ubWVudCBvbiB0aGUgc3RhY2sgYXJ0aWZhY3QgbWF5IGJlIHVucmVzb2x2ZWQsIHRoaXMgb25lXG4gICAqIG11c3QgYmUgcmVzb2x2ZWQuXG4gICAqL1xuICByZWFkb25seSByZXNvbHZlZEVudmlyb25tZW50OiBjeGFwaS5FbnZpcm9ubWVudDtcblxuICAvKipcbiAgICogVGhlIFNESyB0byB1c2UgZm9yIGRlcGxveWluZyB0aGUgc3RhY2tcbiAgICpcbiAgICogU2hvdWxkIGhhdmUgYmVlbiBpbml0aWFsaXplZCB3aXRoIHRoZSBjb3JyZWN0IHJvbGUgd2l0aCB3aGljaFxuICAgKiBzdGFjayBvcGVyYXRpb25zIHNob3VsZCBiZSBwZXJmb3JtZWQuXG4gICAqL1xuICByZWFkb25seSBzZGs6IFNESztcblxuICAvKipcbiAgICogU0RLIHByb3ZpZGVyIChzZWVkZWQgd2l0aCBkZWZhdWx0IGNyZWRlbnRpYWxzKVxuICAgKlxuICAgKiBXaWxsIGJlIHVzZWQgdG86XG4gICAqXG4gICAqIC0gUHVibGlzaCBhc3NldHMsIGVpdGhlciBsZWdhY3kgYXNzZXRzIG9yIGxhcmdlIENGTiB0ZW1wbGF0ZXNcbiAgICogICB0aGF0IGFyZW4ndCB0aGVtc2VsdmVzIGFzc2V0cyBmcm9tIGEgbWFuaWZlc3QuIChOZWVkcyBhbiBTREtcbiAgICogICBQcm92aWRlciBiZWNhdXNlIHRoZSBmaWxlIHB1Ymxpc2hpbmcgcm9sZSBpcyBkZWNsYXJlZCBhcyBwYXJ0XG4gICAqICAgb2YgdGhlIGFzc2V0KS5cbiAgICogLSBIb3Rzd2FwXG4gICAqL1xuICByZWFkb25seSBzZGtQcm92aWRlcjogU2RrUHJvdmlkZXI7XG5cbiAgLyoqXG4gICAqIEluZm9ybWF0aW9uIGFib3V0IHRoZSBib290c3RyYXAgc3RhY2sgZm91bmQgaW4gdGhlIHRhcmdldCBlbnZpcm9ubWVudFxuICAgKi9cbiAgcmVhZG9ubHkgZW52UmVzb3VyY2VzOiBFbnZpcm9ubWVudFJlc291cmNlcztcblxuICAvKipcbiAgICogUm9sZSB0byBwYXNzIHRvIENsb3VkRm9ybWF0aW9uIHRvIGV4ZWN1dGUgdGhlIGNoYW5nZSBzZXRcbiAgICpcbiAgICogVG8gb2J0YWluIGEgYFN0cmluZ1dpdGhvdXRQbGFjZWhvbGRlcnNgLCBydW4gYSByZWd1bGFyXG4gICAqIHN0cmluZyB0aG91Z2ggYFRhcmdldEVudmlyb25tZW50LnJlcGxhY2VQbGFjZWhvbGRlcnNgLlxuICAgKlxuICAgKiBAZGVmYXVsdCAtIE5vIGV4ZWN1dGlvbiByb2xlOyBDbG91ZEZvcm1hdGlvbiBlaXRoZXIgdXNlcyB0aGUgcm9sZSBjdXJyZW50bHkgYXNzb2NpYXRlZCB3aXRoXG4gICAqIHRoZSBzdGFjaywgb3Igb3RoZXJ3aXNlIHVzZXMgY3VycmVudCBBV1MgY3JlZGVudGlhbHMuXG4gICAqL1xuICByZWFkb25seSByb2xlQXJuPzogU3RyaW5nV2l0aG91dFBsYWNlaG9sZGVycztcblxuICAvKipcbiAgICogTm90aWZpY2F0aW9uIEFSTnMgdG8gcGFzcyB0byBDbG91ZEZvcm1hdGlvbiB0byBub3RpZnkgd2hlbiB0aGUgY2hhbmdlIHNldCBoYXMgY29tcGxldGVkXG4gICAqXG4gICAqIEBkZWZhdWx0IC0gTm8gbm90aWZpY2F0aW9uc1xuICAgKi9cbiAgcmVhZG9ubHkgbm90aWZpY2F0aW9uQXJucz86IHN0cmluZ1tdO1xuXG4gIC8qKlxuICAgKiBOYW1lIHRvIGRlcGxveSB0aGUgc3RhY2sgdW5kZXJcbiAgICpcbiAgICogQGRlZmF1bHQgLSBOYW1lIGZyb20gYXNzZW1ibHlcbiAgICovXG4gIHJlYWRvbmx5IGRlcGxveU5hbWU/OiBzdHJpbmc7XG5cbiAgLyoqXG4gICAqIFF1aWV0IG9yIHZlcmJvc2UgZGVwbG95bWVudFxuICAgKlxuICAgKiBAZGVmYXVsdCBmYWxzZVxuICAgKi9cbiAgcmVhZG9ubHkgcXVpZXQ/OiBib29sZWFuO1xuXG4gIC8qKlxuICAgKiBMaXN0IG9mIGFzc2V0IElEcyB3aGljaCBzaG91bGRuJ3QgYmUgYnVpbHRcbiAgICpcbiAgICogQGRlZmF1bHQgLSBCdWlsZCBhbGwgYXNzZXRzXG4gICAqL1xuICByZWFkb25seSByZXVzZUFzc2V0cz86IHN0cmluZ1tdO1xuXG4gIC8qKlxuICAgKiBUYWdzIHRvIHBhc3MgdG8gQ2xvdWRGb3JtYXRpb24gdG8gYWRkIHRvIHN0YWNrXG4gICAqXG4gICAqIEBkZWZhdWx0IC0gTm8gdGFnc1xuICAgKi9cbiAgcmVhZG9ubHkgdGFncz86IFRhZ1tdO1xuXG4gIC8qKlxuICAgKiBXaGF0IGRlcGxveW1lbnQgbWV0aG9kIHRvIHVzZVxuICAgKlxuICAgKiBAZGVmYXVsdCAtIENoYW5nZSBzZXQgd2l0aCBkZWZhdWx0c1xuICAgKi9cbiAgcmVhZG9ubHkgZGVwbG95bWVudE1ldGhvZD86IERlcGxveW1lbnRNZXRob2Q7XG5cbiAgLyoqXG4gICAqIFRoZSBjb2xsZWN0aW9uIG9mIGV4dHJhIHBhcmFtZXRlcnNcbiAgICogKGluIGFkZGl0aW9uIHRvIHRob3NlIHVzZWQgZm9yIGFzc2V0cylcbiAgICogdG8gcGFzcyB0byB0aGUgZGVwbG95ZWQgdGVtcGxhdGUuXG4gICAqIE5vdGUgdGhhdCBwYXJhbWV0ZXJzIHdpdGggYHVuZGVmaW5lZGAgb3IgZW1wdHkgdmFsdWVzIHdpbGwgYmUgaWdub3JlZCxcbiAgICogYW5kIG5vdCBwYXNzZWQgdG8gdGhlIHRlbXBsYXRlLlxuICAgKlxuICAgKiBAZGVmYXVsdCAtIG5vIGFkZGl0aW9uYWwgcGFyYW1ldGVycyB3aWxsIGJlIHBhc3NlZCB0byB0aGUgdGVtcGxhdGVcbiAgICovXG4gIHJlYWRvbmx5IHBhcmFtZXRlcnM/OiB7IFtuYW1lOiBzdHJpbmddOiBzdHJpbmcgfCB1bmRlZmluZWQgfTtcblxuICAvKipcbiAgICogVXNlIHByZXZpb3VzIHZhbHVlcyBmb3IgdW5zcGVjaWZpZWQgcGFyYW1ldGVyc1xuICAgKlxuICAgKiBJZiBub3Qgc2V0LCBhbGwgcGFyYW1ldGVycyBtdXN0IGJlIHNwZWNpZmllZCBmb3IgZXZlcnkgZGVwbG95bWVudC5cbiAgICpcbiAgICogQGRlZmF1bHQgZmFsc2VcbiAgICovXG4gIHJlYWRvbmx5IHVzZVByZXZpb3VzUGFyYW1ldGVycz86IGJvb2xlYW47XG5cbiAgLyoqXG4gICAqIERpc3BsYXkgbW9kZSBmb3Igc3RhY2sgZGVwbG95bWVudCBwcm9ncmVzcy5cbiAgICpcbiAgICogQGRlZmF1bHQgU3RhY2tBY3Rpdml0eVByb2dyZXNzLkJhciBzdGFjayBldmVudHMgd2lsbCBiZSBkaXNwbGF5ZWQgZm9yXG4gICAqICAgdGhlIHJlc291cmNlIGN1cnJlbnRseSBiZWluZyBkZXBsb3llZC5cbiAgICovXG4gIHJlYWRvbmx5IHByb2dyZXNzPzogU3RhY2tBY3Rpdml0eVByb2dyZXNzO1xuXG4gIC8qKlxuICAgKiBEZXBsb3kgZXZlbiBpZiB0aGUgZGVwbG95ZWQgdGVtcGxhdGUgaXMgaWRlbnRpY2FsIHRvIHRoZSBvbmUgd2UgYXJlIGFib3V0IHRvIGRlcGxveS5cbiAgICogQGRlZmF1bHQgZmFsc2VcbiAgICovXG4gIHJlYWRvbmx5IGZvcmNlPzogYm9vbGVhbjtcblxuICAvKipcbiAgICogV2hldGhlciB3ZSBhcmUgb24gYSBDSSBzeXN0ZW1cbiAgICpcbiAgICogQGRlZmF1bHQgZmFsc2VcbiAgICovXG4gIHJlYWRvbmx5IGNpPzogYm9vbGVhbjtcblxuICAvKipcbiAgICogUm9sbGJhY2sgZmFpbGVkIGRlcGxveW1lbnRzXG4gICAqXG4gICAqIEBkZWZhdWx0IHRydWVcbiAgICovXG4gIHJlYWRvbmx5IHJvbGxiYWNrPzogYm9vbGVhbjtcblxuICAvKlxuICAgKiBXaGV0aGVyIHRvIHBlcmZvcm0gYSAnaG90c3dhcCcgZGVwbG95bWVudC5cbiAgICogQSAnaG90c3dhcCcgZGVwbG95bWVudCB3aWxsIGF0dGVtcHQgdG8gc2hvcnQtY2lyY3VpdCBDbG91ZEZvcm1hdGlvblxuICAgKiBhbmQgdXBkYXRlIHRoZSBhZmZlY3RlZCByZXNvdXJjZXMgbGlrZSBMYW1iZGEgZnVuY3Rpb25zIGRpcmVjdGx5LlxuICAgKlxuICAgKiBAZGVmYXVsdCAtIGBIb3Rzd2FwTW9kZS5GVUxMX0RFUExPWU1FTlRgIGZvciByZWd1bGFyIGRlcGxveW1lbnRzLCBgSG90c3dhcE1vZGUuSE9UU1dBUF9PTkxZYCBmb3IgJ3dhdGNoJyBkZXBsb3ltZW50c1xuICAgKi9cbiAgcmVhZG9ubHkgaG90c3dhcD86IEhvdHN3YXBNb2RlO1xuXG4gIC8qKlxuICAgKiBFeHRyYSBwcm9wZXJ0aWVzIHRoYXQgY29uZmlndXJlIGhvdHN3YXAgYmVoYXZpb3JcbiAgICovXG4gIHJlYWRvbmx5IGhvdHN3YXBQcm9wZXJ0eU92ZXJyaWRlcz86IEhvdHN3YXBQcm9wZXJ0eU92ZXJyaWRlcztcblxuICAvKipcbiAgICogVGhlIGV4dHJhIHN0cmluZyB0byBhcHBlbmQgdG8gdGhlIFVzZXItQWdlbnQgaGVhZGVyIHdoZW4gcGVyZm9ybWluZyBBV1MgU0RLIGNhbGxzLlxuICAgKlxuICAgKiBAZGVmYXVsdCAtIG5vdGhpbmcgZXh0cmEgaXMgYXBwZW5kZWQgdG8gdGhlIFVzZXItQWdlbnQgaGVhZGVyXG4gICAqL1xuICByZWFkb25seSBleHRyYVVzZXJBZ2VudD86IHN0cmluZztcblxuICAvKipcbiAgICogSWYgc2V0LCBjaGFuZ2Ugc2V0IG9mIHR5cGUgSU1QT1JUIHdpbGwgYmUgY3JlYXRlZCwgYW5kIHJlc291cmNlc1RvSW1wb3J0XG4gICAqIHBhc3NlZCB0byBpdC5cbiAgICovXG4gIHJlYWRvbmx5IHJlc291cmNlc1RvSW1wb3J0PzogUmVzb3VyY2VzVG9JbXBvcnQ7XG5cbiAgLyoqXG4gICAqIElmIHByZXNlbnQsIHVzZSB0aGlzIGdpdmVuIHRlbXBsYXRlIGluc3RlYWQgb2YgdGhlIHN0b3JlZCBvbmVcbiAgICpcbiAgICogQGRlZmF1bHQgLSBVc2UgdGhlIHN0b3JlZCB0ZW1wbGF0ZVxuICAgKi9cbiAgcmVhZG9ubHkgb3ZlcnJpZGVUZW1wbGF0ZT86IGFueTtcblxuICAvKipcbiAgICogV2hldGhlciB0byBidWlsZC9wdWJsaXNoIGFzc2V0cyBpbiBwYXJhbGxlbFxuICAgKlxuICAgKiBAZGVmYXVsdCB0cnVlIFRvIHJlbWFpbiBiYWNrd2FyZCBjb21wYXRpYmxlLlxuICAgKi9cbiAgcmVhZG9ubHkgYXNzZXRQYXJhbGxlbGlzbT86IGJvb2xlYW47XG59XG5cbmV4cG9ydCB0eXBlIERlcGxveW1lbnRNZXRob2QgPSBEaXJlY3REZXBsb3ltZW50TWV0aG9kIHwgQ2hhbmdlU2V0RGVwbG95bWVudE1ldGhvZDtcblxuZXhwb3J0IGludGVyZmFjZSBEaXJlY3REZXBsb3ltZW50TWV0aG9kIHtcbiAgcmVhZG9ubHkgbWV0aG9kOiAnZGlyZWN0Jztcbn1cblxuZXhwb3J0IGludGVyZmFjZSBDaGFuZ2VTZXREZXBsb3ltZW50TWV0aG9kIHtcbiAgcmVhZG9ubHkgbWV0aG9kOiAnY2hhbmdlLXNldCc7XG5cbiAgLyoqXG4gICAqIFdoZXRoZXIgdG8gZXhlY3V0ZSB0aGUgY2hhbmdlc2V0IG9yIGxlYXZlIGl0IGluIHJldmlldy5cbiAgICpcbiAgICogQGRlZmF1bHQgdHJ1ZVxuICAgKi9cbiAgcmVhZG9ubHkgZXhlY3V0ZT86IGJvb2xlYW47XG5cbiAgLyoqXG4gICAqIE9wdGlvbmFsIG5hbWUgdG8gdXNlIGZvciB0aGUgQ2xvdWRGb3JtYXRpb24gY2hhbmdlIHNldC5cbiAgICogSWYgbm90IHByb3ZpZGVkLCBhIG5hbWUgd2lsbCBiZSBnZW5lcmF0ZWQgYXV0b21hdGljYWxseS5cbiAgICovXG4gIHJlYWRvbmx5IGNoYW5nZVNldE5hbWU/OiBzdHJpbmc7XG59XG5cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiBkZXBsb3lTdGFjayhvcHRpb25zOiBEZXBsb3lTdGFja09wdGlvbnMpOiBQcm9taXNlPERlcGxveVN0YWNrUmVzdWx0PiB7XG4gIGNvbnN0IHN0YWNrQXJ0aWZhY3QgPSBvcHRpb25zLnN0YWNrO1xuXG4gIGNvbnN0IHN0YWNrRW52ID0gb3B0aW9ucy5yZXNvbHZlZEVudmlyb25tZW50O1xuXG4gIG9wdGlvbnMuc2RrLmFwcGVuZEN1c3RvbVVzZXJBZ2VudChvcHRpb25zLmV4dHJhVXNlckFnZW50KTtcbiAgY29uc3QgY2ZuID0gb3B0aW9ucy5zZGsuY2xvdWRGb3JtYXRpb24oKTtcbiAgY29uc3QgZGVwbG95TmFtZSA9IG9wdGlvbnMuZGVwbG95TmFtZSB8fCBzdGFja0FydGlmYWN0LnN0YWNrTmFtZTtcbiAgbGV0IGNsb3VkRm9ybWF0aW9uU3RhY2sgPSBhd2FpdCBDbG91ZEZvcm1hdGlvblN0YWNrLmxvb2t1cChjZm4sIGRlcGxveU5hbWUpO1xuXG4gIGlmIChjbG91ZEZvcm1hdGlvblN0YWNrLnN0YWNrU3RhdHVzLmlzQ3JlYXRpb25GYWlsdXJlKSB7XG4gICAgZGVidWcoXG4gICAgICBgRm91bmQgZXhpc3Rpbmcgc3RhY2sgJHtkZXBsb3lOYW1lfSB0aGF0IGhhZCBwcmV2aW91c2x5IGZhaWxlZCBjcmVhdGlvbi4gRGVsZXRpbmcgaXQgYmVmb3JlIGF0dGVtcHRpbmcgdG8gcmUtY3JlYXRlIGl0LmAsXG4gICAgKTtcbiAgICBhd2FpdCBjZm4uZGVsZXRlU3RhY2soeyBTdGFja05hbWU6IGRlcGxveU5hbWUgfSk7XG4gICAgY29uc3QgZGVsZXRlZFN0YWNrID0gYXdhaXQgd2FpdEZvclN0YWNrRGVsZXRlKGNmbiwgZGVwbG95TmFtZSk7XG4gICAgaWYgKGRlbGV0ZWRTdGFjayAmJiBkZWxldGVkU3RhY2suc3RhY2tTdGF0dXMubmFtZSAhPT0gJ0RFTEVURV9DT01QTEVURScpIHtcbiAgICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgICAgYEZhaWxlZCBkZWxldGluZyBzdGFjayAke2RlcGxveU5hbWV9IHRoYXQgaGFkIHByZXZpb3VzbHkgZmFpbGVkIGNyZWF0aW9uIChjdXJyZW50IHN0YXRlOiAke2RlbGV0ZWRTdGFjay5zdGFja1N0YXR1c30pYCxcbiAgICAgICk7XG4gICAgfVxuICAgIC8vIFVwZGF0ZSB2YXJpYWJsZSB0byBtYXJrIHRoYXQgdGhlIHN0YWNrIGRvZXMgbm90IGV4aXN0IGFueW1vcmUsIGJ1dCBhdm9pZFxuICAgIC8vIGRvaW5nIGFuIGFjdHVhbCBsb29rdXAgaW4gQ2xvdWRGb3JtYXRpb24gKHdoaWNoIHdvdWxkIGJlIHNpbGx5IHRvIGRvIGlmXG4gICAgLy8gd2UganVzdCBkZWxldGVkIGl0KS5cbiAgICBjbG91ZEZvcm1hdGlvblN0YWNrID0gQ2xvdWRGb3JtYXRpb25TdGFjay5kb2VzTm90RXhpc3QoY2ZuLCBkZXBsb3lOYW1lKTtcbiAgfVxuXG4gIC8vIERldGVjdCBcImxlZ2FjeVwiIGFzc2V0cyAod2hpY2ggcmVtYWluIGluIHRoZSBtZXRhZGF0YSkgYW5kIHB1Ymxpc2ggdGhlbSB2aWFcbiAgLy8gYW4gYWQtaG9jIGFzc2V0IG1hbmlmZXN0LCB3aGlsZSBwYXNzaW5nIHRoZWlyIGxvY2F0aW9ucyB2aWEgdGVtcGxhdGVcbiAgLy8gcGFyYW1ldGVycy5cbiAgY29uc3QgbGVnYWN5QXNzZXRzID0gbmV3IEFzc2V0TWFuaWZlc3RCdWlsZGVyKCk7XG4gIGNvbnN0IGFzc2V0UGFyYW1zID0gYXdhaXQgYWRkTWV0YWRhdGFBc3NldHNUb01hbmlmZXN0KFxuICAgIHN0YWNrQXJ0aWZhY3QsXG4gICAgbGVnYWN5QXNzZXRzLFxuICAgIG9wdGlvbnMuZW52UmVzb3VyY2VzLFxuICAgIG9wdGlvbnMucmV1c2VBc3NldHMsXG4gICk7XG5cbiAgY29uc3QgZmluYWxQYXJhbWV0ZXJWYWx1ZXMgPSB7IC4uLm9wdGlvbnMucGFyYW1ldGVycywgLi4uYXNzZXRQYXJhbXMgfTtcblxuICBjb25zdCB0ZW1wbGF0ZVBhcmFtcyA9IFRlbXBsYXRlUGFyYW1ldGVycy5mcm9tVGVtcGxhdGUoc3RhY2tBcnRpZmFjdC50ZW1wbGF0ZSk7XG4gIGNvbnN0IHN0YWNrUGFyYW1zID0gb3B0aW9ucy51c2VQcmV2aW91c1BhcmFtZXRlcnNcbiAgICA/IHRlbXBsYXRlUGFyYW1zLnVwZGF0ZUV4aXN0aW5nKGZpbmFsUGFyYW1ldGVyVmFsdWVzLCBjbG91ZEZvcm1hdGlvblN0YWNrLnBhcmFtZXRlcnMpXG4gICAgOiB0ZW1wbGF0ZVBhcmFtcy5zdXBwbHlBbGwoZmluYWxQYXJhbWV0ZXJWYWx1ZXMpO1xuXG4gIGNvbnN0IGhvdHN3YXBNb2RlID0gb3B0aW9ucy5ob3Rzd2FwID8/IEhvdHN3YXBNb2RlLkZVTExfREVQTE9ZTUVOVDtcbiAgY29uc3QgaG90c3dhcFByb3BlcnR5T3ZlcnJpZGVzID0gb3B0aW9ucy5ob3Rzd2FwUHJvcGVydHlPdmVycmlkZXMgPz8gbmV3IEhvdHN3YXBQcm9wZXJ0eU92ZXJyaWRlcygpO1xuXG4gIGlmIChhd2FpdCBjYW5Ta2lwRGVwbG95KG9wdGlvbnMsIGNsb3VkRm9ybWF0aW9uU3RhY2ssIHN0YWNrUGFyYW1zLmhhc0NoYW5nZXMoY2xvdWRGb3JtYXRpb25TdGFjay5wYXJhbWV0ZXJzKSkpIHtcbiAgICBkZWJ1ZyhgJHtkZXBsb3lOYW1lfTogc2tpcHBpbmcgZGVwbG95bWVudCAodXNlIC0tZm9yY2UgdG8gb3ZlcnJpZGUpYCk7XG4gICAgLy8gaWYgd2UgY2FuIHNraXAgZGVwbG95bWVudCBhbmQgd2UgYXJlIHBlcmZvcm1pbmcgYSBob3Rzd2FwLCBsZXQgdGhlIHVzZXIga25vd1xuICAgIC8vIHRoYXQgbm8gaG90c3dhcCBkZXBsb3ltZW50IGhhcHBlbmVkXG4gICAgaWYgKGhvdHN3YXBNb2RlICE9PSBIb3Rzd2FwTW9kZS5GVUxMX0RFUExPWU1FTlQpIHtcbiAgICAgIHByaW50KFxuICAgICAgICBgXFxuICR7SUNPTn0gJXNcXG5gLFxuICAgICAgICBjaGFsay5ib2xkKCdob3Rzd2FwIGRlcGxveW1lbnQgc2tpcHBlZCAtIG5vIGNoYW5nZXMgd2VyZSBkZXRlY3RlZCAodXNlIC0tZm9yY2UgdG8gb3ZlcnJpZGUpJyksXG4gICAgICApO1xuICAgIH1cbiAgICByZXR1cm4ge1xuICAgICAgdHlwZTogJ2RpZC1kZXBsb3ktc3RhY2snLFxuICAgICAgbm9PcDogdHJ1ZSxcbiAgICAgIG91dHB1dHM6IGNsb3VkRm9ybWF0aW9uU3RhY2sub3V0cHV0cyxcbiAgICAgIHN0YWNrQXJuOiBjbG91ZEZvcm1hdGlvblN0YWNrLnN0YWNrSWQsXG4gICAgfTtcbiAgfSBlbHNlIHtcbiAgICBkZWJ1ZyhgJHtkZXBsb3lOYW1lfTogZGVwbG95aW5nLi4uYCk7XG4gIH1cblxuICBjb25zdCBib2R5UGFyYW1ldGVyID0gYXdhaXQgbWFrZUJvZHlQYXJhbWV0ZXIoXG4gICAgc3RhY2tBcnRpZmFjdCxcbiAgICBvcHRpb25zLnJlc29sdmVkRW52aXJvbm1lbnQsXG4gICAgbGVnYWN5QXNzZXRzLFxuICAgIG9wdGlvbnMuZW52UmVzb3VyY2VzLFxuICAgIG9wdGlvbnMub3ZlcnJpZGVUZW1wbGF0ZSxcbiAgKTtcbiAgbGV0IGJvb3RzdHJhcFN0YWNrTmFtZTogc3RyaW5nIHwgdW5kZWZpbmVkO1xuICB0cnkge1xuICAgIGJvb3RzdHJhcFN0YWNrTmFtZSA9IChhd2FpdCBvcHRpb25zLmVudlJlc291cmNlcy5sb29rdXBUb29sa2l0KCkpLnN0YWNrTmFtZTtcbiAgfSBjYXRjaCAoZSkge1xuICAgIGRlYnVnKGBDb3VsZCBub3QgZGV0ZXJtaW5lIHRoZSBib290c3RyYXAgc3RhY2sgbmFtZTogJHtlfWApO1xuICB9XG4gIGF3YWl0IHB1Ymxpc2hBc3NldHMobGVnYWN5QXNzZXRzLnRvTWFuaWZlc3Qoc3RhY2tBcnRpZmFjdC5hc3NlbWJseS5kaXJlY3RvcnkpLCBvcHRpb25zLnNka1Byb3ZpZGVyLCBzdGFja0Vudiwge1xuICAgIHBhcmFsbGVsOiBvcHRpb25zLmFzc2V0UGFyYWxsZWxpc20sXG4gICAgYWxsb3dDcm9zc0FjY291bnQ6IGF3YWl0IGRldGVybWluZUFsbG93Q3Jvc3NBY2NvdW50QXNzZXRQdWJsaXNoaW5nKG9wdGlvbnMuc2RrLCBib290c3RyYXBTdGFja05hbWUpLFxuICB9KTtcblxuICBpZiAoaG90c3dhcE1vZGUgIT09IEhvdHN3YXBNb2RlLkZVTExfREVQTE9ZTUVOVCkge1xuICAgIC8vIGF0dGVtcHQgdG8gc2hvcnQtY2lyY3VpdCB0aGUgZGVwbG95bWVudCBpZiBwb3NzaWJsZVxuICAgIHRyeSB7XG4gICAgICBjb25zdCBob3Rzd2FwRGVwbG95bWVudFJlc3VsdCA9IGF3YWl0IHRyeUhvdHN3YXBEZXBsb3ltZW50KFxuICAgICAgICBvcHRpb25zLnNka1Byb3ZpZGVyLFxuICAgICAgICBzdGFja1BhcmFtcy52YWx1ZXMsXG4gICAgICAgIGNsb3VkRm9ybWF0aW9uU3RhY2ssXG4gICAgICAgIHN0YWNrQXJ0aWZhY3QsXG4gICAgICAgIGhvdHN3YXBNb2RlLCBob3Rzd2FwUHJvcGVydHlPdmVycmlkZXMsXG4gICAgICApO1xuICAgICAgaWYgKGhvdHN3YXBEZXBsb3ltZW50UmVzdWx0KSB7XG4gICAgICAgIHJldHVybiBob3Rzd2FwRGVwbG95bWVudFJlc3VsdDtcbiAgICAgIH1cbiAgICAgIHByaW50KFxuICAgICAgICAnQ291bGQgbm90IHBlcmZvcm0gYSBob3Rzd2FwIGRlcGxveW1lbnQsIGFzIHRoZSBzdGFjayAlcyBjb250YWlucyBub24tQXNzZXQgY2hhbmdlcycsXG4gICAgICAgIHN0YWNrQXJ0aWZhY3QuZGlzcGxheU5hbWUsXG4gICAgICApO1xuICAgIH0gY2F0Y2ggKGUpIHtcbiAgICAgIGlmICghKGUgaW5zdGFuY2VvZiBDZm5FdmFsdWF0aW9uRXhjZXB0aW9uKSkge1xuICAgICAgICB0aHJvdyBlO1xuICAgICAgfVxuICAgICAgcHJpbnQoXG4gICAgICAgICdDb3VsZCBub3QgcGVyZm9ybSBhIGhvdHN3YXAgZGVwbG95bWVudCwgYmVjYXVzZSB0aGUgQ2xvdWRGb3JtYXRpb24gdGVtcGxhdGUgY291bGQgbm90IGJlIHJlc29sdmVkOiAlcycsXG4gICAgICAgIGUubWVzc2FnZSxcbiAgICAgICk7XG4gICAgfVxuXG4gICAgaWYgKGhvdHN3YXBNb2RlID09PSBIb3Rzd2FwTW9kZS5GQUxMX0JBQ0spIHtcbiAgICAgIHByaW50KCdGYWxsaW5nIGJhY2sgdG8gZG9pbmcgYSBmdWxsIGRlcGxveW1lbnQnKTtcbiAgICAgIG9wdGlvbnMuc2RrLmFwcGVuZEN1c3RvbVVzZXJBZ2VudCgnY2RrLWhvdHN3YXAvZmFsbGJhY2snKTtcbiAgICB9IGVsc2Uge1xuICAgICAgcmV0dXJuIHtcbiAgICAgICAgdHlwZTogJ2RpZC1kZXBsb3ktc3RhY2snLFxuICAgICAgICBub09wOiB0cnVlLFxuICAgICAgICBzdGFja0FybjogY2xvdWRGb3JtYXRpb25TdGFjay5zdGFja0lkLFxuICAgICAgICBvdXRwdXRzOiBjbG91ZEZvcm1hdGlvblN0YWNrLm91dHB1dHMsXG4gICAgICB9O1xuICAgIH1cbiAgfVxuXG4gIC8vIGNvdWxkIG5vdCBzaG9ydC1jaXJjdWl0IHRoZSBkZXBsb3ltZW50LCBwZXJmb3JtIGEgZnVsbCBDRk4gZGVwbG95IGluc3RlYWRcbiAgY29uc3QgZnVsbERlcGxveW1lbnQgPSBuZXcgRnVsbENsb3VkRm9ybWF0aW9uRGVwbG95bWVudChcbiAgICBvcHRpb25zLFxuICAgIGNsb3VkRm9ybWF0aW9uU3RhY2ssXG4gICAgc3RhY2tBcnRpZmFjdCxcbiAgICBzdGFja1BhcmFtcyxcbiAgICBib2R5UGFyYW1ldGVyLFxuICApO1xuICByZXR1cm4gZnVsbERlcGxveW1lbnQucGVyZm9ybURlcGxveW1lbnQoKTtcbn1cblxudHlwZSBDb21tb25QcmVwYXJlT3B0aW9ucyA9IGtleW9mIENyZWF0ZVN0YWNrQ29tbWFuZElucHV0ICZcbmtleW9mIFVwZGF0ZVN0YWNrQ29tbWFuZElucHV0ICZcbmtleW9mIENyZWF0ZUNoYW5nZVNldENvbW1hbmRJbnB1dDtcbnR5cGUgQ29tbW9uRXhlY3V0ZU9wdGlvbnMgPSBrZXlvZiBDcmVhdGVTdGFja0NvbW1hbmRJbnB1dCAmXG5rZXlvZiBVcGRhdGVTdGFja0NvbW1hbmRJbnB1dCAmXG5rZXlvZiBFeGVjdXRlQ2hhbmdlU2V0Q29tbWFuZElucHV0O1xuXG4vKipcbiAqIFRoaXMgY2xhc3Mgc2hhcmVzIHN0YXRlIGFuZCBmdW5jdGlvbmFsaXR5IGJldHdlZW4gdGhlIGRpZmZlcmVudCBmdWxsIGRlcGxveW1lbnQgbW9kZXNcbiAqL1xuY2xhc3MgRnVsbENsb3VkRm9ybWF0aW9uRGVwbG95bWVudCB7XG4gIHByaXZhdGUgcmVhZG9ubHkgY2ZuOiBJQ2xvdWRGb3JtYXRpb25DbGllbnQ7XG4gIHByaXZhdGUgcmVhZG9ubHkgc3RhY2tOYW1lOiBzdHJpbmc7XG4gIHByaXZhdGUgcmVhZG9ubHkgdXBkYXRlOiBib29sZWFuO1xuICBwcml2YXRlIHJlYWRvbmx5IHZlcmI6IHN0cmluZztcbiAgcHJpdmF0ZSByZWFkb25seSB1dWlkOiBzdHJpbmc7XG5cbiAgY29uc3RydWN0b3IoXG4gICAgcHJpdmF0ZSByZWFkb25seSBvcHRpb25zOiBEZXBsb3lTdGFja09wdGlvbnMsXG4gICAgcHJpdmF0ZSByZWFkb25seSBjbG91ZEZvcm1hdGlvblN0YWNrOiBDbG91ZEZvcm1hdGlvblN0YWNrLFxuICAgIHByaXZhdGUgcmVhZG9ubHkgc3RhY2tBcnRpZmFjdDogY3hhcGkuQ2xvdWRGb3JtYXRpb25TdGFja0FydGlmYWN0LFxuICAgIHByaXZhdGUgcmVhZG9ubHkgc3RhY2tQYXJhbXM6IFBhcmFtZXRlclZhbHVlcyxcbiAgICBwcml2YXRlIHJlYWRvbmx5IGJvZHlQYXJhbWV0ZXI6IFRlbXBsYXRlQm9keVBhcmFtZXRlcixcbiAgKSB7XG4gICAgdGhpcy5jZm4gPSBvcHRpb25zLnNkay5jbG91ZEZvcm1hdGlvbigpO1xuICAgIHRoaXMuc3RhY2tOYW1lID0gb3B0aW9ucy5kZXBsb3lOYW1lID8/IHN0YWNrQXJ0aWZhY3Quc3RhY2tOYW1lO1xuXG4gICAgdGhpcy51cGRhdGUgPSBjbG91ZEZvcm1hdGlvblN0YWNrLmV4aXN0cyAmJiBjbG91ZEZvcm1hdGlvblN0YWNrLnN0YWNrU3RhdHVzLm5hbWUgIT09ICdSRVZJRVdfSU5fUFJPR1JFU1MnO1xuICAgIHRoaXMudmVyYiA9IHRoaXMudXBkYXRlID8gJ3VwZGF0ZScgOiAnY3JlYXRlJztcbiAgICB0aGlzLnV1aWQgPSB1dWlkLnY0KCk7XG4gIH1cblxuICBwdWJsaWMgYXN5bmMgcGVyZm9ybURlcGxveW1lbnQoKTogUHJvbWlzZTxEZXBsb3lTdGFja1Jlc3VsdD4ge1xuICAgIGNvbnN0IGRlcGxveW1lbnRNZXRob2QgPSB0aGlzLm9wdGlvbnMuZGVwbG95bWVudE1ldGhvZCA/PyB7XG4gICAgICBtZXRob2Q6ICdjaGFuZ2Utc2V0JyxcbiAgICB9O1xuXG4gICAgaWYgKGRlcGxveW1lbnRNZXRob2QubWV0aG9kID09PSAnZGlyZWN0JyAmJiB0aGlzLm9wdGlvbnMucmVzb3VyY2VzVG9JbXBvcnQpIHtcbiAgICAgIHRocm93IG5ldyBFcnJvcignSW1wb3J0aW5nIHJlc291cmNlcyByZXF1aXJlcyBhIGNoYW5nZXNldCBkZXBsb3ltZW50Jyk7XG4gICAgfVxuXG4gICAgc3dpdGNoIChkZXBsb3ltZW50TWV0aG9kLm1ldGhvZCkge1xuICAgICAgY2FzZSAnY2hhbmdlLXNldCc6XG4gICAgICAgIHJldHVybiB0aGlzLmNoYW5nZVNldERlcGxveW1lbnQoZGVwbG95bWVudE1ldGhvZCk7XG5cbiAgICAgIGNhc2UgJ2RpcmVjdCc6XG4gICAgICAgIHJldHVybiB0aGlzLmRpcmVjdERlcGxveW1lbnQoKTtcbiAgICB9XG4gIH1cblxuICBwcml2YXRlIGFzeW5jIGNoYW5nZVNldERlcGxveW1lbnQoZGVwbG95bWVudE1ldGhvZDogQ2hhbmdlU2V0RGVwbG95bWVudE1ldGhvZCk6IFByb21pc2U8RGVwbG95U3RhY2tSZXN1bHQ+IHtcbiAgICBjb25zdCBjaGFuZ2VTZXROYW1lID0gZGVwbG95bWVudE1ldGhvZC5jaGFuZ2VTZXROYW1lID8/ICdjZGstZGVwbG95LWNoYW5nZS1zZXQnO1xuICAgIGNvbnN0IGV4ZWN1dGUgPSBkZXBsb3ltZW50TWV0aG9kLmV4ZWN1dGUgPz8gdHJ1ZTtcbiAgICBjb25zdCBjaGFuZ2VTZXREZXNjcmlwdGlvbiA9IGF3YWl0IHRoaXMuY3JlYXRlQ2hhbmdlU2V0KGNoYW5nZVNldE5hbWUsIGV4ZWN1dGUpO1xuICAgIGF3YWl0IHRoaXMudXBkYXRlVGVybWluYXRpb25Qcm90ZWN0aW9uKCk7XG5cbiAgICBpZiAoY2hhbmdlU2V0SGFzTm9DaGFuZ2VzKGNoYW5nZVNldERlc2NyaXB0aW9uKSkge1xuICAgICAgZGVidWcoJ05vIGNoYW5nZXMgYXJlIHRvIGJlIHBlcmZvcm1lZCBvbiAlcy4nLCB0aGlzLnN0YWNrTmFtZSk7XG4gICAgICBpZiAoZXhlY3V0ZSkge1xuICAgICAgICBkZWJ1ZygnRGVsZXRpbmcgZW1wdHkgY2hhbmdlIHNldCAlcycsIGNoYW5nZVNldERlc2NyaXB0aW9uLkNoYW5nZVNldElkKTtcbiAgICAgICAgYXdhaXQgdGhpcy5jZm4uZGVsZXRlQ2hhbmdlU2V0KHtcbiAgICAgICAgICBTdGFja05hbWU6IHRoaXMuc3RhY2tOYW1lLFxuICAgICAgICAgIENoYW5nZVNldE5hbWU6IGNoYW5nZVNldE5hbWUsXG4gICAgICAgIH0pO1xuICAgICAgfVxuXG4gICAgICBpZiAodGhpcy5vcHRpb25zLmZvcmNlKSB7XG4gICAgICAgIHdhcm5pbmcoXG4gICAgICAgICAgW1xuICAgICAgICAgICAgJ1lvdSB1c2VkIHRoZSAtLWZvcmNlIGZsYWcsIGJ1dCBDbG91ZEZvcm1hdGlvbiByZXBvcnRlZCB0aGF0IHRoZSBkZXBsb3ltZW50IHdvdWxkIG5vdCBtYWtlIGFueSBjaGFuZ2VzLicsXG4gICAgICAgICAgICAnQWNjb3JkaW5nIHRvIENsb3VkRm9ybWF0aW9uLCBhbGwgcmVzb3VyY2VzIGFyZSBhbHJlYWR5IHVwLXRvLWRhdGUgd2l0aCB0aGUgc3RhdGUgaW4geW91ciBDREsgYXBwLicsXG4gICAgICAgICAgICAnJyxcbiAgICAgICAgICAgICdZb3UgY2Fubm90IHVzZSB0aGUgLS1mb3JjZSBmbGFnIHRvIGdldCByaWQgb2YgY2hhbmdlcyB5b3UgbWFkZSBpbiB0aGUgY29uc29sZS4gVHJ5IHVzaW5nJyxcbiAgICAgICAgICAgICdDbG91ZEZvcm1hdGlvbiBkcmlmdCBkZXRlY3Rpb24gaW5zdGVhZDogaHR0cHM6Ly9kb2NzLmF3cy5hbWF6b24uY29tL0FXU0Nsb3VkRm9ybWF0aW9uL2xhdGVzdC9Vc2VyR3VpZGUvdXNpbmctY2ZuLXN0YWNrLWRyaWZ0Lmh0bWwnLFxuICAgICAgICAgIF0uam9pbignXFxuJyksXG4gICAgICAgICk7XG4gICAgICB9XG5cbiAgICAgIHJldHVybiB7XG4gICAgICAgIHR5cGU6ICdkaWQtZGVwbG95LXN0YWNrJyxcbiAgICAgICAgbm9PcDogdHJ1ZSxcbiAgICAgICAgb3V0cHV0czogdGhpcy5jbG91ZEZvcm1hdGlvblN0YWNrLm91dHB1dHMsXG4gICAgICAgIHN0YWNrQXJuOiBjaGFuZ2VTZXREZXNjcmlwdGlvbi5TdGFja0lkISxcbiAgICAgIH07XG4gICAgfVxuXG4gICAgaWYgKCFleGVjdXRlKSB7XG4gICAgICBwcmludChcbiAgICAgICAgJ0NoYW5nZXNldCAlcyBjcmVhdGVkIGFuZCB3YWl0aW5nIGluIHJldmlldyBmb3IgbWFudWFsIGV4ZWN1dGlvbiAoLS1uby1leGVjdXRlKScsXG4gICAgICAgIGNoYW5nZVNldERlc2NyaXB0aW9uLkNoYW5nZVNldElkLFxuICAgICAgKTtcbiAgICAgIHJldHVybiB7XG4gICAgICAgIHR5cGU6ICdkaWQtZGVwbG95LXN0YWNrJyxcbiAgICAgICAgbm9PcDogZmFsc2UsXG4gICAgICAgIG91dHB1dHM6IHRoaXMuY2xvdWRGb3JtYXRpb25TdGFjay5vdXRwdXRzLFxuICAgICAgICBzdGFja0FybjogY2hhbmdlU2V0RGVzY3JpcHRpb24uU3RhY2tJZCEsXG4gICAgICB9O1xuICAgIH1cblxuICAgIC8vIElmIHRoZXJlIGFyZSByZXBsYWNlbWVudHMgaW4gdGhlIGNoYW5nZXNldCwgY2hlY2sgdGhlIHJvbGxiYWNrIGZsYWcgYW5kIHN0YWNrIHN0YXR1c1xuICAgIGNvbnN0IHJlcGxhY2VtZW50ID0gaGFzUmVwbGFjZW1lbnQoY2hhbmdlU2V0RGVzY3JpcHRpb24pO1xuICAgIGNvbnN0IGlzUGF1c2VkRmFpbFN0YXRlID0gdGhpcy5jbG91ZEZvcm1hdGlvblN0YWNrLnN0YWNrU3RhdHVzLmlzUm9sbGJhY2thYmxlO1xuICAgIGNvbnN0IHJvbGxiYWNrID0gdGhpcy5vcHRpb25zLnJvbGxiYWNrID8/IHRydWU7XG4gICAgaWYgKGlzUGF1c2VkRmFpbFN0YXRlICYmIHJlcGxhY2VtZW50KSB7XG4gICAgICByZXR1cm4geyB0eXBlOiAnZmFpbHBhdXNlZC1uZWVkLXJvbGxiYWNrLWZpcnN0JywgcmVhc29uOiAncmVwbGFjZW1lbnQnIH07XG4gICAgfVxuICAgIGlmIChpc1BhdXNlZEZhaWxTdGF0ZSAmJiAhcm9sbGJhY2spIHtcbiAgICAgIHJldHVybiB7IHR5cGU6ICdmYWlscGF1c2VkLW5lZWQtcm9sbGJhY2stZmlyc3QnLCByZWFzb246ICdub3Qtbm9yb2xsYmFjaycgfTtcbiAgICB9XG4gICAgaWYgKCFyb2xsYmFjayAmJiByZXBsYWNlbWVudCkge1xuICAgICAgcmV0dXJuIHsgdHlwZTogJ3JlcGxhY2VtZW50LXJlcXVpcmVzLW5vcm9sbGJhY2snIH07XG4gICAgfVxuXG4gICAgcmV0dXJuIHRoaXMuZXhlY3V0ZUNoYW5nZVNldChjaGFuZ2VTZXREZXNjcmlwdGlvbik7XG4gIH1cblxuICBwcml2YXRlIGFzeW5jIGNyZWF0ZUNoYW5nZVNldChjaGFuZ2VTZXROYW1lOiBzdHJpbmcsIHdpbGxFeGVjdXRlOiBib29sZWFuKSB7XG4gICAgYXdhaXQgdGhpcy5jbGVhbnVwT2xkQ2hhbmdlc2V0KGNoYW5nZVNldE5hbWUpO1xuXG4gICAgZGVidWcoYEF0dGVtcHRpbmcgdG8gY3JlYXRlIENoYW5nZVNldCB3aXRoIG5hbWUgJHtjaGFuZ2VTZXROYW1lfSB0byAke3RoaXMudmVyYn0gc3RhY2sgJHt0aGlzLnN0YWNrTmFtZX1gKTtcbiAgICBwcmludCgnJXM6IGNyZWF0aW5nIENsb3VkRm9ybWF0aW9uIGNoYW5nZXNldC4uLicsIGNoYWxrLmJvbGQodGhpcy5zdGFja05hbWUpKTtcbiAgICBjb25zdCBjaGFuZ2VTZXQgPSBhd2FpdCB0aGlzLmNmbi5jcmVhdGVDaGFuZ2VTZXQoe1xuICAgICAgU3RhY2tOYW1lOiB0aGlzLnN0YWNrTmFtZSxcbiAgICAgIENoYW5nZVNldE5hbWU6IGNoYW5nZVNldE5hbWUsXG4gICAgICBDaGFuZ2VTZXRUeXBlOiB0aGlzLm9wdGlvbnMucmVzb3VyY2VzVG9JbXBvcnQgPyAnSU1QT1JUJyA6IHRoaXMudXBkYXRlID8gJ1VQREFURScgOiAnQ1JFQVRFJyxcbiAgICAgIFJlc291cmNlc1RvSW1wb3J0OiB0aGlzLm9wdGlvbnMucmVzb3VyY2VzVG9JbXBvcnQsXG4gICAgICBEZXNjcmlwdGlvbjogYENESyBDaGFuZ2VzZXQgZm9yIGV4ZWN1dGlvbiAke3RoaXMudXVpZH1gLFxuICAgICAgQ2xpZW50VG9rZW46IGBjcmVhdGUke3RoaXMudXVpZH1gLFxuICAgICAgLi4udGhpcy5jb21tb25QcmVwYXJlT3B0aW9ucygpLFxuICAgIH0pO1xuXG4gICAgZGVidWcoJ0luaXRpYXRlZCBjcmVhdGlvbiBvZiBjaGFuZ2VzZXQ6ICVzOyB3YWl0aW5nIGZvciBpdCB0byBmaW5pc2ggY3JlYXRpbmcuLi4nLCBjaGFuZ2VTZXQuSWQpO1xuICAgIC8vIEZldGNoaW5nIGFsbCBwYWdlcyBpZiB3ZSdsbCBleGVjdXRlLCBzbyB3ZSBjYW4gaGF2ZSB0aGUgY29ycmVjdCBjaGFuZ2UgY291bnQgd2hlbiBtb25pdG9yaW5nLlxuICAgIHJldHVybiB3YWl0Rm9yQ2hhbmdlU2V0KHRoaXMuY2ZuLCB0aGlzLnN0YWNrTmFtZSwgY2hhbmdlU2V0TmFtZSwge1xuICAgICAgZmV0Y2hBbGw6IHdpbGxFeGVjdXRlLFxuICAgIH0pO1xuICB9XG5cbiAgcHJpdmF0ZSBhc3luYyBleGVjdXRlQ2hhbmdlU2V0KGNoYW5nZVNldDogRGVzY3JpYmVDaGFuZ2VTZXRDb21tYW5kT3V0cHV0KTogUHJvbWlzZTxTdWNjZXNzZnVsRGVwbG95U3RhY2tSZXN1bHQ+IHtcbiAgICBkZWJ1ZygnSW5pdGlhdGluZyBleGVjdXRpb24gb2YgY2hhbmdlc2V0ICVzIG9uIHN0YWNrICVzJywgY2hhbmdlU2V0LkNoYW5nZVNldElkLCB0aGlzLnN0YWNrTmFtZSk7XG5cbiAgICBhd2FpdCB0aGlzLmNmbi5leGVjdXRlQ2hhbmdlU2V0KHtcbiAgICAgIFN0YWNrTmFtZTogdGhpcy5zdGFja05hbWUsXG4gICAgICBDaGFuZ2VTZXROYW1lOiBjaGFuZ2VTZXQuQ2hhbmdlU2V0TmFtZSEsXG4gICAgICBDbGllbnRSZXF1ZXN0VG9rZW46IGBleGVjJHt0aGlzLnV1aWR9YCxcbiAgICAgIC4uLnRoaXMuY29tbW9uRXhlY3V0ZU9wdGlvbnMoKSxcbiAgICB9KTtcblxuICAgIGRlYnVnKFxuICAgICAgJ0V4ZWN1dGlvbiBvZiBjaGFuZ2VzZXQgJXMgb24gc3RhY2sgJXMgaGFzIHN0YXJ0ZWQ7IHdhaXRpbmcgZm9yIHRoZSB1cGRhdGUgdG8gY29tcGxldGUuLi4nLFxuICAgICAgY2hhbmdlU2V0LkNoYW5nZVNldElkLFxuICAgICAgdGhpcy5zdGFja05hbWUsXG4gICAgKTtcblxuICAgIC8vICsxIGZvciB0aGUgZXh0cmEgZXZlbnQgZW1pdHRlZCBmcm9tIHVwZGF0ZXMuXG4gICAgY29uc3QgY2hhbmdlU2V0TGVuZ3RoOiBudW1iZXIgPSAoY2hhbmdlU2V0LkNoYW5nZXMgPz8gW10pLmxlbmd0aCArICh0aGlzLnVwZGF0ZSA/IDEgOiAwKTtcbiAgICByZXR1cm4gdGhpcy5tb25pdG9yRGVwbG95bWVudChjaGFuZ2VTZXQuQ3JlYXRpb25UaW1lISwgY2hhbmdlU2V0TGVuZ3RoKTtcbiAgfVxuXG4gIHByaXZhdGUgYXN5bmMgY2xlYW51cE9sZENoYW5nZXNldChjaGFuZ2VTZXROYW1lOiBzdHJpbmcpIHtcbiAgICBpZiAodGhpcy5jbG91ZEZvcm1hdGlvblN0YWNrLmV4aXN0cykge1xuICAgICAgLy8gRGVsZXRlIGFueSBleGlzdGluZyBjaGFuZ2Ugc2V0cyBnZW5lcmF0ZWQgYnkgQ0RLIHNpbmNlIGNoYW5nZSBzZXQgbmFtZXMgbXVzdCBiZSB1bmlxdWUuXG4gICAgICAvLyBUaGUgZGVsZXRlIHJlcXVlc3QgaXMgc3VjY2Vzc2Z1bCBhcyBsb25nIGFzIHRoZSBzdGFjayBleGlzdHMgKGV2ZW4gaWYgdGhlIGNoYW5nZSBzZXQgZG9lcyBub3QgZXhpc3QpLlxuICAgICAgZGVidWcoYFJlbW92aW5nIGV4aXN0aW5nIGNoYW5nZSBzZXQgd2l0aCBuYW1lICR7Y2hhbmdlU2V0TmFtZX0gaWYgaXQgZXhpc3RzYCk7XG4gICAgICBhd2FpdCB0aGlzLmNmbi5kZWxldGVDaGFuZ2VTZXQoe1xuICAgICAgICBTdGFja05hbWU6IHRoaXMuc3RhY2tOYW1lLFxuICAgICAgICBDaGFuZ2VTZXROYW1lOiBjaGFuZ2VTZXROYW1lLFxuICAgICAgfSk7XG4gICAgfVxuICB9XG5cbiAgcHJpdmF0ZSBhc3luYyB1cGRhdGVUZXJtaW5hdGlvblByb3RlY3Rpb24oKSB7XG4gICAgLy8gVXBkYXRlIHRlcm1pbmF0aW9uIHByb3RlY3Rpb24gb25seSBpZiBpdCBoYXMgY2hhbmdlZC5cbiAgICBjb25zdCB0ZXJtaW5hdGlvblByb3RlY3Rpb24gPSB0aGlzLnN0YWNrQXJ0aWZhY3QudGVybWluYXRpb25Qcm90ZWN0aW9uID8/IGZhbHNlO1xuICAgIGlmICghIXRoaXMuY2xvdWRGb3JtYXRpb25TdGFjay50ZXJtaW5hdGlvblByb3RlY3Rpb24gIT09IHRlcm1pbmF0aW9uUHJvdGVjdGlvbikge1xuICAgICAgZGVidWcoXG4gICAgICAgICdVcGRhdGluZyB0ZXJtaW5hdGlvbiBwcm90ZWN0aW9uIGZyb20gJXMgdG8gJXMgZm9yIHN0YWNrICVzJyxcbiAgICAgICAgdGhpcy5jbG91ZEZvcm1hdGlvblN0YWNrLnRlcm1pbmF0aW9uUHJvdGVjdGlvbixcbiAgICAgICAgdGVybWluYXRpb25Qcm90ZWN0aW9uLFxuICAgICAgICB0aGlzLnN0YWNrTmFtZSxcbiAgICAgICk7XG4gICAgICBhd2FpdCB0aGlzLmNmbi51cGRhdGVUZXJtaW5hdGlvblByb3RlY3Rpb24oe1xuICAgICAgICBTdGFja05hbWU6IHRoaXMuc3RhY2tOYW1lLFxuICAgICAgICBFbmFibGVUZXJtaW5hdGlvblByb3RlY3Rpb246IHRlcm1pbmF0aW9uUHJvdGVjdGlvbixcbiAgICAgIH0pO1xuICAgICAgZGVidWcoJ1Rlcm1pbmF0aW9uIHByb3RlY3Rpb24gdXBkYXRlZCB0byAlcyBmb3Igc3RhY2sgJXMnLCB0ZXJtaW5hdGlvblByb3RlY3Rpb24sIHRoaXMuc3RhY2tOYW1lKTtcbiAgICB9XG4gIH1cblxuICBwcml2YXRlIGFzeW5jIGRpcmVjdERlcGxveW1lbnQoKTogUHJvbWlzZTxTdWNjZXNzZnVsRGVwbG95U3RhY2tSZXN1bHQ+IHtcbiAgICBwcmludCgnJXM6ICVzIHN0YWNrLi4uJywgY2hhbGsuYm9sZCh0aGlzLnN0YWNrTmFtZSksIHRoaXMudXBkYXRlID8gJ3VwZGF0aW5nJyA6ICdjcmVhdGluZycpO1xuXG4gICAgY29uc3Qgc3RhcnRUaW1lID0gbmV3IERhdGUoKTtcblxuICAgIGlmICh0aGlzLnVwZGF0ZSkge1xuICAgICAgYXdhaXQgdGhpcy51cGRhdGVUZXJtaW5hdGlvblByb3RlY3Rpb24oKTtcblxuICAgICAgdHJ5IHtcbiAgICAgICAgYXdhaXQgdGhpcy5jZm4udXBkYXRlU3RhY2soe1xuICAgICAgICAgIFN0YWNrTmFtZTogdGhpcy5zdGFja05hbWUsXG4gICAgICAgICAgQ2xpZW50UmVxdWVzdFRva2VuOiBgdXBkYXRlJHt0aGlzLnV1aWR9YCxcbiAgICAgICAgICAuLi50aGlzLmNvbW1vblByZXBhcmVPcHRpb25zKCksXG4gICAgICAgICAgLi4udGhpcy5jb21tb25FeGVjdXRlT3B0aW9ucygpLFxuICAgICAgICB9KTtcbiAgICAgIH0gY2F0Y2ggKGVycjogYW55KSB7XG4gICAgICAgIGlmIChlcnIubWVzc2FnZSA9PT0gJ05vIHVwZGF0ZXMgYXJlIHRvIGJlIHBlcmZvcm1lZC4nKSB7XG4gICAgICAgICAgZGVidWcoJ05vIHVwZGF0ZXMgYXJlIHRvIGJlIHBlcmZvcm1lZCBmb3Igc3RhY2sgJXMnLCB0aGlzLnN0YWNrTmFtZSk7XG4gICAgICAgICAgcmV0dXJuIHtcbiAgICAgICAgICAgIHR5cGU6ICdkaWQtZGVwbG95LXN0YWNrJyxcbiAgICAgICAgICAgIG5vT3A6IHRydWUsXG4gICAgICAgICAgICBvdXRwdXRzOiB0aGlzLmNsb3VkRm9ybWF0aW9uU3RhY2sub3V0cHV0cyxcbiAgICAgICAgICAgIHN0YWNrQXJuOiB0aGlzLmNsb3VkRm9ybWF0aW9uU3RhY2suc3RhY2tJZCxcbiAgICAgICAgICB9O1xuICAgICAgICB9XG4gICAgICAgIHRocm93IGVycjtcbiAgICAgIH1cblxuICAgICAgcmV0dXJuIHRoaXMubW9uaXRvckRlcGxveW1lbnQoc3RhcnRUaW1lLCB1bmRlZmluZWQpO1xuICAgIH0gZWxzZSB7XG4gICAgICAvLyBUYWtlIGFkdmFudGFnZSBvZiB0aGUgZmFjdCB0aGF0IHdlIGNhbiBzZXQgdGVybWluYXRpb24gcHJvdGVjdGlvbiBkdXJpbmcgY3JlYXRlXG4gICAgICBjb25zdCB0ZXJtaW5hdGlvblByb3RlY3Rpb24gPSB0aGlzLnN0YWNrQXJ0aWZhY3QudGVybWluYXRpb25Qcm90ZWN0aW9uID8/IGZhbHNlO1xuXG4gICAgICBhd2FpdCB0aGlzLmNmbi5jcmVhdGVTdGFjayh7XG4gICAgICAgIFN0YWNrTmFtZTogdGhpcy5zdGFja05hbWUsXG4gICAgICAgIENsaWVudFJlcXVlc3RUb2tlbjogYGNyZWF0ZSR7dGhpcy51dWlkfWAsXG4gICAgICAgIC4uLih0ZXJtaW5hdGlvblByb3RlY3Rpb24gPyB7IEVuYWJsZVRlcm1pbmF0aW9uUHJvdGVjdGlvbjogdHJ1ZSB9IDogdW5kZWZpbmVkKSxcbiAgICAgICAgLi4udGhpcy5jb21tb25QcmVwYXJlT3B0aW9ucygpLFxuICAgICAgICAuLi50aGlzLmNvbW1vbkV4ZWN1dGVPcHRpb25zKCksXG4gICAgICB9KTtcblxuICAgICAgcmV0dXJuIHRoaXMubW9uaXRvckRlcGxveW1lbnQoc3RhcnRUaW1lLCB1bmRlZmluZWQpO1xuICAgIH1cbiAgfVxuXG4gIHByaXZhdGUgYXN5bmMgbW9uaXRvckRlcGxveW1lbnQoc3RhcnRUaW1lOiBEYXRlLCBleHBlY3RlZENoYW5nZXM6IG51bWJlciB8IHVuZGVmaW5lZCk6IFByb21pc2U8U3VjY2Vzc2Z1bERlcGxveVN0YWNrUmVzdWx0PiB7XG4gICAgY29uc3QgbW9uaXRvciA9IHRoaXMub3B0aW9ucy5xdWlldFxuICAgICAgPyB1bmRlZmluZWRcbiAgICAgIDogU3RhY2tBY3Rpdml0eU1vbml0b3Iud2l0aERlZmF1bHRQcmludGVyKHRoaXMuY2ZuLCB0aGlzLnN0YWNrTmFtZSwgdGhpcy5zdGFja0FydGlmYWN0LCB7XG4gICAgICAgIHJlc291cmNlc1RvdGFsOiBleHBlY3RlZENoYW5nZXMsXG4gICAgICAgIHByb2dyZXNzOiB0aGlzLm9wdGlvbnMucHJvZ3Jlc3MsXG4gICAgICAgIGNoYW5nZVNldENyZWF0aW9uVGltZTogc3RhcnRUaW1lLFxuICAgICAgICBjaTogdGhpcy5vcHRpb25zLmNpLFxuICAgICAgfSkuc3RhcnQoKTtcblxuICAgIGxldCBmaW5hbFN0YXRlID0gdGhpcy5jbG91ZEZvcm1hdGlvblN0YWNrO1xuICAgIHRyeSB7XG4gICAgICBjb25zdCBzdWNjZXNzU3RhY2sgPSBhd2FpdCB3YWl0Rm9yU3RhY2tEZXBsb3kodGhpcy5jZm4sIHRoaXMuc3RhY2tOYW1lKTtcblxuICAgICAgLy8gVGhpcyBzaG91bGRuJ3QgcmVhbGx5IGhhcHBlbiwgYnV0IGNhdGNoIGl0IGFueXdheS4gWW91IG5ldmVyIGtub3cuXG4gICAgICBpZiAoIXN1Y2Nlc3NTdGFjaykge1xuICAgICAgICB0aHJvdyBuZXcgRXJyb3IoJ1N0YWNrIGRlcGxveSBmYWlsZWQgKHRoZSBzdGFjayBkaXNhcHBlYXJlZCB3aGlsZSB3ZSB3ZXJlIGRlcGxveWluZyBpdCknKTtcbiAgICAgIH1cbiAgICAgIGZpbmFsU3RhdGUgPSBzdWNjZXNzU3RhY2s7XG4gICAgfSBjYXRjaCAoZTogYW55KSB7XG4gICAgICB0aHJvdyBuZXcgRXJyb3Ioc3VmZml4V2l0aEVycm9ycyhlLm1lc3NhZ2UsIG1vbml0b3I/LmVycm9ycykpO1xuICAgIH0gZmluYWxseSB7XG4gICAgICBhd2FpdCBtb25pdG9yPy5zdG9wKCk7XG4gICAgfVxuICAgIGRlYnVnKCdTdGFjayAlcyBoYXMgY29tcGxldGVkIHVwZGF0aW5nJywgdGhpcy5zdGFja05hbWUpO1xuICAgIHJldHVybiB7XG4gICAgICB0eXBlOiAnZGlkLWRlcGxveS1zdGFjaycsXG4gICAgICBub09wOiBmYWxzZSxcbiAgICAgIG91dHB1dHM6IGZpbmFsU3RhdGUub3V0cHV0cyxcbiAgICAgIHN0YWNrQXJuOiBmaW5hbFN0YXRlLnN0YWNrSWQsXG4gICAgfTtcbiAgfVxuXG4gIC8qKlxuICAgKiBSZXR1cm4gdGhlIG9wdGlvbnMgdGhhdCBhcmUgc2hhcmVkIGJldHdlZW4gQ3JlYXRlU3RhY2ssIFVwZGF0ZVN0YWNrIGFuZCBDcmVhdGVDaGFuZ2VTZXRcbiAgICovXG4gIHByaXZhdGUgY29tbW9uUHJlcGFyZU9wdGlvbnMoKTogUGFydGlhbDxQaWNrPFVwZGF0ZVN0YWNrQ29tbWFuZElucHV0LCBDb21tb25QcmVwYXJlT3B0aW9ucz4+IHtcbiAgICByZXR1cm4ge1xuICAgICAgQ2FwYWJpbGl0aWVzOiBbJ0NBUEFCSUxJVFlfSUFNJywgJ0NBUEFCSUxJVFlfTkFNRURfSUFNJywgJ0NBUEFCSUxJVFlfQVVUT19FWFBBTkQnXSxcbiAgICAgIE5vdGlmaWNhdGlvbkFSTnM6IHRoaXMub3B0aW9ucy5ub3RpZmljYXRpb25Bcm5zLFxuICAgICAgUGFyYW1ldGVyczogdGhpcy5zdGFja1BhcmFtcy5hcGlQYXJhbWV0ZXJzLFxuICAgICAgUm9sZUFSTjogdGhpcy5vcHRpb25zLnJvbGVBcm4sXG4gICAgICBUZW1wbGF0ZUJvZHk6IHRoaXMuYm9keVBhcmFtZXRlci5UZW1wbGF0ZUJvZHksXG4gICAgICBUZW1wbGF0ZVVSTDogdGhpcy5ib2R5UGFyYW1ldGVyLlRlbXBsYXRlVVJMLFxuICAgICAgVGFnczogdGhpcy5vcHRpb25zLnRhZ3MsXG4gICAgfTtcbiAgfVxuXG4gIC8qKlxuICAgKiBSZXR1cm4gdGhlIG9wdGlvbnMgdGhhdCBhcmUgc2hhcmVkIGJldHdlZW4gVXBkYXRlU3RhY2sgYW5kIENyZWF0ZUNoYW5nZVNldFxuICAgKlxuICAgKiBCZSBjYXJlZnVsIG5vdCB0byBhZGQgaW4ga2V5cyBmb3Igb3B0aW9ucyB0aGF0IGFyZW4ndCB1c2VkLCBhcyB0aGUgZmVhdHVyZXMgbWF5IG5vdCBoYXZlIGJlZW5cbiAgICogZGVwbG95ZWQgZXZlcnl3aGVyZSB5ZXQuXG4gICAqL1xuICBwcml2YXRlIGNvbW1vbkV4ZWN1dGVPcHRpb25zKCk6IFBhcnRpYWw8UGljazxVcGRhdGVTdGFja0NvbW1hbmRJbnB1dCwgQ29tbW9uRXhlY3V0ZU9wdGlvbnM+PiB7XG4gICAgY29uc3Qgc2hvdWxkRGlzYWJsZVJvbGxiYWNrID0gdGhpcy5vcHRpb25zLnJvbGxiYWNrID09PSBmYWxzZTtcblxuICAgIHJldHVybiB7XG4gICAgICBTdGFja05hbWU6IHRoaXMuc3RhY2tOYW1lLFxuICAgICAgLi4uKHNob3VsZERpc2FibGVSb2xsYmFjayA/IHsgRGlzYWJsZVJvbGxiYWNrOiB0cnVlIH0gOiB1bmRlZmluZWQpLFxuICAgIH07XG4gIH1cbn1cblxuZXhwb3J0IGludGVyZmFjZSBEZXN0cm95U3RhY2tPcHRpb25zIHtcbiAgLyoqXG4gICAqIFRoZSBzdGFjayB0byBiZSBkZXN0cm95ZWRcbiAgICovXG4gIHN0YWNrOiBjeGFwaS5DbG91ZEZvcm1hdGlvblN0YWNrQXJ0aWZhY3Q7XG5cbiAgc2RrOiBTREs7XG4gIHJvbGVBcm4/OiBzdHJpbmc7XG4gIGRlcGxveU5hbWU/OiBzdHJpbmc7XG4gIHF1aWV0PzogYm9vbGVhbjtcbiAgY2k/OiBib29sZWFuO1xufVxuXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gZGVzdHJveVN0YWNrKG9wdGlvbnM6IERlc3Ryb3lTdGFja09wdGlvbnMpIHtcbiAgY29uc3QgZGVwbG95TmFtZSA9IG9wdGlvbnMuZGVwbG95TmFtZSB8fCBvcHRpb25zLnN0YWNrLnN0YWNrTmFtZTtcbiAgY29uc3QgY2ZuID0gb3B0aW9ucy5zZGsuY2xvdWRGb3JtYXRpb24oKTtcblxuICBjb25zdCBjdXJyZW50U3RhY2sgPSBhd2FpdCBDbG91ZEZvcm1hdGlvblN0YWNrLmxvb2t1cChjZm4sIGRlcGxveU5hbWUpO1xuICBpZiAoIWN1cnJlbnRTdGFjay5leGlzdHMpIHtcbiAgICByZXR1cm47XG4gIH1cbiAgY29uc3QgbW9uaXRvciA9IG9wdGlvbnMucXVpZXRcbiAgICA/IHVuZGVmaW5lZFxuICAgIDogU3RhY2tBY3Rpdml0eU1vbml0b3Iud2l0aERlZmF1bHRQcmludGVyKGNmbiwgZGVwbG95TmFtZSwgb3B0aW9ucy5zdGFjaywge1xuICAgICAgY2k6IG9wdGlvbnMuY2ksXG4gICAgfSkuc3RhcnQoKTtcblxuICB0cnkge1xuICAgIGF3YWl0IGNmbi5kZWxldGVTdGFjayh7IFN0YWNrTmFtZTogZGVwbG95TmFtZSwgUm9sZUFSTjogb3B0aW9ucy5yb2xlQXJuIH0pO1xuICAgIGNvbnN0IGRlc3Ryb3llZFN0YWNrID0gYXdhaXQgd2FpdEZvclN0YWNrRGVsZXRlKGNmbiwgZGVwbG95TmFtZSk7XG4gICAgaWYgKGRlc3Ryb3llZFN0YWNrICYmIGRlc3Ryb3llZFN0YWNrLnN0YWNrU3RhdHVzLm5hbWUgIT09ICdERUxFVEVfQ09NUExFVEUnKSB7XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoYEZhaWxlZCB0byBkZXN0cm95ICR7ZGVwbG95TmFtZX06ICR7ZGVzdHJveWVkU3RhY2suc3RhY2tTdGF0dXN9YCk7XG4gICAgfVxuICB9IGNhdGNoIChlOiBhbnkpIHtcbiAgICB0aHJvdyBuZXcgRXJyb3Ioc3VmZml4V2l0aEVycm9ycyhlLm1lc3NhZ2UsIG1vbml0b3I/LmVycm9ycykpO1xuICB9IGZpbmFsbHkge1xuICAgIGlmIChtb25pdG9yKSB7XG4gICAgICBhd2FpdCBtb25pdG9yLnN0b3AoKTtcbiAgICB9XG4gIH1cbn1cblxuLyoqXG4gKiBDaGVja3Mgd2hldGhlciB3ZSBjYW4gc2tpcCBkZXBsb3ltZW50XG4gKlxuICogV2UgZG8gdGhpcyBpbiBhIGNvbXBsaWNhdGVkIHdheSBieSBwcmVwcm9jZXNzaW5nIChpbnN0ZWFkIG9mIGp1c3RcbiAqIGxvb2tpbmcgYXQgdGhlIGNoYW5nZXNldCksIGJlY2F1c2UgaWYgdGhlcmUgYXJlIG5lc3RlZCBzdGFja3MgaW52b2x2ZWRcbiAqIHRoZSBjaGFuZ2VzZXQgd2lsbCBhbHdheXMgc2hvdyB0aGUgbmVzdGVkIHN0YWNrcyBhcyBuZWVkaW5nIHRvIGJlXG4gKiB1cGRhdGVkLCBhbmQgdGhlIGRlcGxveW1lbnQgd2lsbCB0YWtlIGEgbG9uZyB0aW1lIHRvIGluIGVmZmVjdCBub3RcbiAqIGRvIGFueXRoaW5nLlxuICovXG5hc3luYyBmdW5jdGlvbiBjYW5Ta2lwRGVwbG95KFxuICBkZXBsb3lTdGFja09wdGlvbnM6IERlcGxveVN0YWNrT3B0aW9ucyxcbiAgY2xvdWRGb3JtYXRpb25TdGFjazogQ2xvdWRGb3JtYXRpb25TdGFjayxcbiAgcGFyYW1ldGVyQ2hhbmdlczogUGFyYW1ldGVyQ2hhbmdlcyxcbik6IFByb21pc2U8Ym9vbGVhbj4ge1xuICBjb25zdCBkZXBsb3lOYW1lID0gZGVwbG95U3RhY2tPcHRpb25zLmRlcGxveU5hbWUgfHwgZGVwbG95U3RhY2tPcHRpb25zLnN0YWNrLnN0YWNrTmFtZTtcbiAgZGVidWcoYCR7ZGVwbG95TmFtZX06IGNoZWNraW5nIGlmIHdlIGNhbiBza2lwIGRlcGxveWApO1xuXG4gIC8vIEZvcmNlZCBkZXBsb3lcbiAgaWYgKGRlcGxveVN0YWNrT3B0aW9ucy5mb3JjZSkge1xuICAgIGRlYnVnKGAke2RlcGxveU5hbWV9OiBmb3JjZWQgZGVwbG95bWVudGApO1xuICAgIHJldHVybiBmYWxzZTtcbiAgfVxuXG4gIC8vIENyZWF0aW5nIGNoYW5nZXNldCBvbmx5IChkZWZhdWx0IHRydWUpLCBuZXZlciBza2lwXG4gIGlmIChcbiAgICBkZXBsb3lTdGFja09wdGlvbnMuZGVwbG95bWVudE1ldGhvZD8ubWV0aG9kID09PSAnY2hhbmdlLXNldCcgJiZcbiAgICBkZXBsb3lTdGFja09wdGlvbnMuZGVwbG95bWVudE1ldGhvZC5leGVjdXRlID09PSBmYWxzZVxuICApIHtcbiAgICBkZWJ1ZyhgJHtkZXBsb3lOYW1lfTogLS1uby1leGVjdXRlLCBhbHdheXMgY3JlYXRpbmcgY2hhbmdlIHNldGApO1xuICAgIHJldHVybiBmYWxzZTtcbiAgfVxuXG4gIC8vIE5vIGV4aXN0aW5nIHN0YWNrXG4gIGlmICghY2xvdWRGb3JtYXRpb25TdGFjay5leGlzdHMpIHtcbiAgICBkZWJ1ZyhgJHtkZXBsb3lOYW1lfTogbm8gZXhpc3Rpbmcgc3RhY2tgKTtcbiAgICByZXR1cm4gZmFsc2U7XG4gIH1cblxuICAvLyBUZW1wbGF0ZSBoYXMgY2hhbmdlZCAoYXNzZXRzIHRha2VuIGludG8gYWNjb3VudCBoZXJlKVxuICBpZiAoSlNPTi5zdHJpbmdpZnkoZGVwbG95U3RhY2tPcHRpb25zLnN0YWNrLnRlbXBsYXRlKSAhPT0gSlNPTi5zdHJpbmdpZnkoYXdhaXQgY2xvdWRGb3JtYXRpb25TdGFjay50ZW1wbGF0ZSgpKSkge1xuICAgIGRlYnVnKGAke2RlcGxveU5hbWV9OiB0ZW1wbGF0ZSBoYXMgY2hhbmdlZGApO1xuICAgIHJldHVybiBmYWxzZTtcbiAgfVxuXG4gIC8vIFRhZ3MgaGF2ZSBjaGFuZ2VkXG4gIGlmICghY29tcGFyZVRhZ3MoY2xvdWRGb3JtYXRpb25TdGFjay50YWdzLCBkZXBsb3lTdGFja09wdGlvbnMudGFncyA/PyBbXSkpIHtcbiAgICBkZWJ1ZyhgJHtkZXBsb3lOYW1lfTogdGFncyBoYXZlIGNoYW5nZWRgKTtcbiAgICByZXR1cm4gZmFsc2U7XG4gIH1cblxuICAvLyBOb3RpZmljYXRpb24gYXJucyBoYXZlIGNoYW5nZWRcbiAgaWYgKCFhcnJheUVxdWFscyhjbG91ZEZvcm1hdGlvblN0YWNrLm5vdGlmaWNhdGlvbkFybnMsIGRlcGxveVN0YWNrT3B0aW9ucy5ub3RpZmljYXRpb25Bcm5zID8/IFtdKSkge1xuICAgIGRlYnVnKGAke2RlcGxveU5hbWV9OiBub3RpZmljYXRpb24gYXJucyBoYXZlIGNoYW5nZWRgKTtcbiAgICByZXR1cm4gZmFsc2U7XG4gIH1cblxuICAvLyBUZXJtaW5hdGlvbiBwcm90ZWN0aW9uIGhhcyBiZWVuIHVwZGF0ZWRcbiAgaWYgKCEhZGVwbG95U3RhY2tPcHRpb25zLnN0YWNrLnRlcm1pbmF0aW9uUHJvdGVjdGlvbiAhPT0gISFjbG91ZEZvcm1hdGlvblN0YWNrLnRlcm1pbmF0aW9uUHJvdGVjdGlvbikge1xuICAgIGRlYnVnKGAke2RlcGxveU5hbWV9OiB0ZXJtaW5hdGlvbiBwcm90ZWN0aW9uIGhhcyBiZWVuIHVwZGF0ZWRgKTtcbiAgICByZXR1cm4gZmFsc2U7XG4gIH1cblxuICAvLyBQYXJhbWV0ZXJzIGhhdmUgY2hhbmdlZFxuICBpZiAocGFyYW1ldGVyQ2hhbmdlcykge1xuICAgIGlmIChwYXJhbWV0ZXJDaGFuZ2VzID09PSAnc3NtJykge1xuICAgICAgZGVidWcoYCR7ZGVwbG95TmFtZX06IHNvbWUgcGFyYW1ldGVycyBjb21lIGZyb20gU1NNIHNvIHdlIGhhdmUgdG8gYXNzdW1lIHRoZXkgbWF5IGhhdmUgY2hhbmdlZGApO1xuICAgIH0gZWxzZSB7XG4gICAgICBkZWJ1ZyhgJHtkZXBsb3lOYW1lfTogcGFyYW1ldGVycyBoYXZlIGNoYW5nZWRgKTtcbiAgICB9XG4gICAgcmV0dXJuIGZhbHNlO1xuICB9XG5cbiAgLy8gRXhpc3Rpbmcgc3RhY2sgaXMgaW4gYSBmYWlsZWQgc3RhdGVcbiAgaWYgKGNsb3VkRm9ybWF0aW9uU3RhY2suc3RhY2tTdGF0dXMuaXNGYWlsdXJlKSB7XG4gICAgZGVidWcoYCR7ZGVwbG95TmFtZX06IHN0YWNrIGlzIGluIGEgZmFpbHVyZSBzdGF0ZWApO1xuICAgIHJldHVybiBmYWxzZTtcbiAgfVxuXG4gIC8vIFdlIGNhbiBza2lwIGRlcGxveVxuICByZXR1cm4gdHJ1ZTtcbn1cblxuLyoqXG4gKiBDb21wYXJlcyB0d28gbGlzdCBvZiB0YWdzLCByZXR1cm5zIHRydWUgaWYgaWRlbnRpY2FsLlxuICovXG5mdW5jdGlvbiBjb21wYXJlVGFncyhhOiBUYWdbXSwgYjogVGFnW10pOiBib29sZWFuIHtcbiAgaWYgKGEubGVuZ3RoICE9PSBiLmxlbmd0aCkge1xuICAgIHJldHVybiBmYWxzZTtcbiAgfVxuXG4gIGZvciAoY29uc3QgYVRhZyBvZiBhKSB7XG4gICAgY29uc3QgYlRhZyA9IGIuZmluZCgodGFnKSA9PiB0YWcuS2V5ID09PSBhVGFnLktleSk7XG5cbiAgICBpZiAoIWJUYWcgfHwgYlRhZy5WYWx1ZSAhPT0gYVRhZy5WYWx1ZSkge1xuICAgICAgcmV0dXJuIGZhbHNlO1xuICAgIH1cbiAgfVxuXG4gIHJldHVybiB0cnVlO1xufVxuXG5mdW5jdGlvbiBzdWZmaXhXaXRoRXJyb3JzKG1zZzogc3RyaW5nLCBlcnJvcnM/OiBzdHJpbmdbXSkge1xuICByZXR1cm4gZXJyb3JzICYmIGVycm9ycy5sZW5ndGggPiAwID8gYCR7bXNnfTogJHtlcnJvcnMuam9pbignLCAnKX1gIDogbXNnO1xufVxuXG5mdW5jdGlvbiBhcnJheUVxdWFscyhhOiBhbnlbXSwgYjogYW55W10pOiBib29sZWFuIHtcbiAgcmV0dXJuIGEuZXZlcnkoKGl0ZW0pID0+IGIuaW5jbHVkZXMoaXRlbSkpICYmIGIuZXZlcnkoKGl0ZW0pID0+IGEuaW5jbHVkZXMoaXRlbSkpO1xufVxuXG5mdW5jdGlvbiBoYXNSZXBsYWNlbWVudChjczogRGVzY3JpYmVDaGFuZ2VTZXRDb21tYW5kT3V0cHV0KSB7XG4gIHJldHVybiAoY3MuQ2hhbmdlcyA/PyBbXSkuc29tZShjID0+IHtcbiAgICBjb25zdCBhID0gYy5SZXNvdXJjZUNoYW5nZT8uUG9saWN5QWN0aW9uO1xuICAgIHJldHVybiBhID09PSAnUmVwbGFjZUFuZERlbGV0ZScgfHwgYSA9PT0gJ1JlcGxhY2VBbmRSZXRhaW4nIHx8IGEgPT09ICdSZXBsYWNlQW5kU25hcHNob3QnO1xuICB9KTtcbn1cbiJdfQ==