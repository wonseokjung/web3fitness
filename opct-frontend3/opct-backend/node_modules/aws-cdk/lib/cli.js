"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.exec = exec;
exports.cli = cli;
const cxapi = require("@aws-cdk/cx-api");
require("@jsii/check-node/run");
const chalk = require("chalk");
const common_1 = require("./api/hotswap/common");
const parse_command_line_arguments_1 = require("./parse-command-line-arguments");
const platform_warnings_1 = require("./platform-warnings");
const tracing_1 = require("./util/tracing");
const aws_auth_1 = require("../lib/api/aws-auth");
const bootstrap_1 = require("../lib/api/bootstrap");
const cloud_executable_1 = require("../lib/api/cxapp/cloud-executable");
const exec_1 = require("../lib/api/cxapp/exec");
const deployments_1 = require("../lib/api/deployments");
const plugin_1 = require("../lib/api/plugin");
const toolkit_info_1 = require("../lib/api/toolkit-info");
const cdk_toolkit_1 = require("../lib/cdk-toolkit");
const context_1 = require("../lib/commands/context");
const docs_1 = require("../lib/commands/docs");
const doctor_1 = require("../lib/commands/doctor");
const migrate_1 = require("../lib/commands/migrate");
const init_1 = require("../lib/init");
const logging_1 = require("../lib/logging");
const notices_1 = require("../lib/notices");
const settings_1 = require("../lib/settings");
const version = require("../lib/version");
/* eslint-disable max-len */
/* eslint-disable @typescript-eslint/no-shadow */ // yargs
if (!process.stdout.isTTY) {
    // Disable chalk color highlighting
    process.env.FORCE_COLOR = '0';
}
async function exec(args, synthesizer) {
    function makeBrowserDefault() {
        const defaultBrowserCommand = {
            darwin: 'open %u',
            win32: 'start %u',
        };
        const cmd = defaultBrowserCommand[process.platform];
        return cmd ?? 'xdg-open %u';
    }
    const argv = await (0, parse_command_line_arguments_1.parseCommandLineArguments)(args, makeBrowserDefault(), await (0, init_1.availableInitLanguages)(), migrate_1.MIGRATE_SUPPORTED_LANGUAGES, version.DISPLAY_VERSION, yargsNegativeAlias);
    if (argv.verbose) {
        (0, logging_1.setLogLevel)(argv.verbose);
    }
    // Debug should always imply tracing
    if (argv.debug || argv.verbose > 2) {
        (0, tracing_1.enableTracing)(true);
    }
    if (argv.ci) {
        (0, logging_1.setCI)(true);
    }
    try {
        await (0, platform_warnings_1.checkForPlatformWarnings)();
    }
    catch (e) {
        (0, logging_1.debug)(`Error while checking for platform warnings: ${e}`);
    }
    (0, logging_1.debug)('CDK toolkit version:', version.DISPLAY_VERSION);
    (0, logging_1.debug)('Command line arguments:', argv);
    const configuration = new settings_1.Configuration({
        commandLineArguments: {
            ...argv,
            _: argv._, // TypeScript at its best
        },
    });
    await configuration.load();
    const cmd = argv._[0];
    const notices = notices_1.Notices.create({ configuration, includeAcknowledged: cmd === 'notices' ? !argv.unacknowledged : false });
    await notices.refresh();
    const sdkProvider = await aws_auth_1.SdkProvider.withAwsCliCompatibleDefaults({
        profile: configuration.settings.get(['profile']),
        httpOptions: {
            proxyAddress: argv.proxy,
            caBundlePath: argv['ca-bundle-path'],
        },
    });
    let outDirLock;
    const cloudExecutable = new cloud_executable_1.CloudExecutable({
        configuration,
        sdkProvider,
        synthesizer: synthesizer ??
            (async (aws, config) => {
                // Invoke 'execProgram', and copy the lock for the directory in the global
                // variable here. It will be released when the CLI exits. Locks are not re-entrant
                // so release it if we have to synthesize more than once (because of context lookups).
                await outDirLock?.release();
                const { assembly, lock } = await (0, exec_1.execProgram)(aws, config);
                outDirLock = lock;
                return assembly;
            }),
    });
    /** Function to load plug-ins, using configurations additively. */
    function loadPlugins(...settings) {
        const loaded = new Set();
        for (const source of settings) {
            const plugins = source.get(['plugin']) || [];
            for (const plugin of plugins) {
                const resolved = tryResolve(plugin);
                if (loaded.has(resolved)) {
                    continue;
                }
                (0, logging_1.debug)(`Loading plug-in: ${chalk.green(plugin)} from ${chalk.blue(resolved)}`);
                plugin_1.PluginHost.instance.load(plugin);
                loaded.add(resolved);
            }
        }
        function tryResolve(plugin) {
            try {
                return require.resolve(plugin);
            }
            catch (e) {
                (0, logging_1.error)(`Unable to resolve plugin ${chalk.green(plugin)}: ${e.stack}`);
                throw new Error(`Unable to resolve plug-in: ${plugin}`);
            }
        }
    }
    loadPlugins(configuration.settings);
    if (typeof (cmd) !== 'string') {
        throw new Error(`First argument should be a string. Got: ${cmd} (${typeof (cmd)})`);
    }
    // Bundle up global objects so the commands have access to them
    const commandOptions = { args: argv, configuration, aws: sdkProvider };
    try {
        return await main(cmd, argv);
    }
    finally {
        // If we locked the 'cdk.out' directory, release it here.
        await outDirLock?.release();
        // Do PSAs here
        await version.displayVersionMessage();
        if (cmd === 'notices') {
            await notices.refresh({ force: true });
            notices.display({ showTotal: argv.unacknowledged });
        }
        else if (cmd !== 'version') {
            await notices.refresh();
            notices.display();
        }
    }
    async function main(command, args) {
        const toolkitStackName = toolkit_info_1.ToolkitInfo.determineName(configuration.settings.get(['toolkitStackName']));
        (0, logging_1.debug)(`Toolkit stack: ${chalk.bold(toolkitStackName)}`);
        const cloudFormation = new deployments_1.Deployments({ sdkProvider, toolkitStackName });
        if (args.all && args.STACKS) {
            throw new Error('You must either specify a list of Stacks or the `--all` argument');
        }
        args.STACKS = args.STACKS ?? (args.STACK ? [args.STACK] : []);
        args.ENVIRONMENTS = args.ENVIRONMENTS ?? [];
        const selector = {
            allTopLevel: args.all,
            patterns: args.STACKS,
        };
        const cli = new cdk_toolkit_1.CdkToolkit({
            cloudExecutable,
            deployments: cloudFormation,
            verbose: argv.trace || argv.verbose > 0,
            ignoreErrors: argv['ignore-errors'],
            strict: argv.strict,
            configuration,
            sdkProvider,
        });
        switch (command) {
            case 'context':
                return (0, context_1.realHandler)(commandOptions);
            case 'docs':
                return (0, docs_1.realHandler)(commandOptions);
            case 'doctor':
                return (0, doctor_1.realHandler)(commandOptions);
            case 'ls':
            case 'list':
                return cli.list(args.STACKS, {
                    long: args.long,
                    json: argv.json,
                    showDeps: args.showDependencies,
                });
            case 'diff':
                const enableDiffNoFail = isFeatureEnabled(configuration, cxapi.ENABLE_DIFF_NO_FAIL_CONTEXT);
                return cli.diff({
                    stackNames: args.STACKS,
                    exclusively: args.exclusively,
                    templatePath: args.template,
                    strict: args.strict,
                    contextLines: args.contextLines,
                    securityOnly: args.securityOnly,
                    fail: args.fail != null ? args.fail : !enableDiffNoFail,
                    stream: args.ci ? process.stdout : undefined,
                    compareAgainstProcessedTemplate: args.processed,
                    quiet: args.quiet,
                    changeSet: args['change-set'],
                    toolkitStackName: toolkitStackName,
                });
            case 'bootstrap':
                const source = determineBootstrapVersion(args, configuration);
                const bootstrapper = new bootstrap_1.Bootstrapper(source);
                if (args.showTemplate) {
                    return bootstrapper.showTemplate(args.json);
                }
                return cli.bootstrap(args.ENVIRONMENTS, bootstrapper, {
                    roleArn: args.roleArn,
                    force: argv.force,
                    toolkitStackName: toolkitStackName,
                    execute: args.execute,
                    tags: configuration.settings.get(['tags']),
                    terminationProtection: args.terminationProtection,
                    usePreviousParameters: args['previous-parameters'],
                    parameters: {
                        bucketName: configuration.settings.get(['toolkitBucket', 'bucketName']),
                        kmsKeyId: configuration.settings.get(['toolkitBucket', 'kmsKeyId']),
                        createCustomerMasterKey: args.bootstrapCustomerKey,
                        qualifier: args.qualifier ?? configuration.context.get('@aws-cdk/core:bootstrapQualifier'),
                        publicAccessBlockConfiguration: args.publicAccessBlockConfiguration,
                        examplePermissionsBoundary: argv.examplePermissionsBoundary,
                        customPermissionsBoundary: argv.customPermissionsBoundary,
                        trustedAccounts: arrayFromYargs(args.trust),
                        trustedAccountsForLookup: arrayFromYargs(args.trustForLookup),
                        cloudFormationExecutionPolicies: arrayFromYargs(args.cloudformationExecutionPolicies),
                    },
                });
            case 'deploy':
                const parameterMap = {};
                for (const parameter of args.parameters) {
                    if (typeof parameter === 'string') {
                        const keyValue = parameter.split('=');
                        parameterMap[keyValue[0]] = keyValue.slice(1).join('=');
                    }
                }
                if (args.execute !== undefined && args.method !== undefined) {
                    throw new Error('Can not supply both --[no-]execute and --method at the same time');
                }
                let deploymentMethod;
                switch (args.method) {
                    case 'direct':
                        if (args.changeSetName) {
                            throw new Error('--change-set-name cannot be used with method=direct');
                        }
                        deploymentMethod = { method: 'direct' };
                        break;
                    case 'change-set':
                        deploymentMethod = {
                            method: 'change-set',
                            execute: true,
                            changeSetName: args.changeSetName,
                        };
                        break;
                    case 'prepare-change-set':
                        deploymentMethod = {
                            method: 'change-set',
                            execute: false,
                            changeSetName: args.changeSetName,
                        };
                        break;
                    case undefined:
                        deploymentMethod = {
                            method: 'change-set',
                            execute: args.execute ?? true,
                            changeSetName: args.changeSetName,
                        };
                        break;
                }
                return cli.deploy({
                    selector,
                    exclusively: args.exclusively,
                    toolkitStackName,
                    roleArn: args.roleArn,
                    notificationArns: args.notificationArns,
                    requireApproval: configuration.settings.get(['requireApproval']),
                    reuseAssets: args['build-exclude'],
                    tags: configuration.settings.get(['tags']),
                    deploymentMethod,
                    force: args.force,
                    parameters: parameterMap,
                    usePreviousParameters: args['previous-parameters'],
                    outputsFile: configuration.settings.get(['outputsFile']),
                    progress: configuration.settings.get(['progress']),
                    ci: args.ci,
                    rollback: configuration.settings.get(['rollback']),
                    hotswap: determineHotswapMode(args.hotswap, args.hotswapFallback),
                    watch: args.watch,
                    traceLogs: args.logs,
                    concurrency: args.concurrency,
                    assetParallelism: configuration.settings.get(['assetParallelism']),
                    assetBuildTime: configuration.settings.get(['assetPrebuild'])
                        ? cdk_toolkit_1.AssetBuildTime.ALL_BEFORE_DEPLOY
                        : cdk_toolkit_1.AssetBuildTime.JUST_IN_TIME,
                    ignoreNoStacks: args.ignoreNoStacks,
                });
            case 'rollback':
                return cli.rollback({
                    selector,
                    toolkitStackName,
                    roleArn: args.roleArn,
                    force: args.force,
                    validateBootstrapStackVersion: args['validate-bootstrap-version'],
                    orphanLogicalIds: args.orphan,
                });
            case 'import':
                return cli.import({
                    selector,
                    toolkitStackName,
                    roleArn: args.roleArn,
                    deploymentMethod: {
                        method: 'change-set',
                        execute: args.execute,
                        changeSetName: args.changeSetName,
                    },
                    progress: configuration.settings.get(['progress']),
                    rollback: configuration.settings.get(['rollback']),
                    recordResourceMapping: args['record-resource-mapping'],
                    resourceMappingFile: args['resource-mapping'],
                    force: args.force,
                });
            case 'watch':
                return cli.watch({
                    selector,
                    exclusively: args.exclusively,
                    toolkitStackName,
                    roleArn: args.roleArn,
                    reuseAssets: args['build-exclude'],
                    deploymentMethod: {
                        method: 'change-set',
                        changeSetName: args.changeSetName,
                    },
                    force: args.force,
                    progress: configuration.settings.get(['progress']),
                    rollback: configuration.settings.get(['rollback']),
                    hotswap: determineHotswapMode(args.hotswap, args.hotswapFallback, true),
                    traceLogs: args.logs,
                    concurrency: args.concurrency,
                });
            case 'destroy':
                return cli.destroy({
                    selector,
                    exclusively: args.exclusively,
                    force: args.force,
                    roleArn: args.roleArn,
                    ci: args.ci,
                });
            case 'gc':
                if (!configuration.settings.get(['unstable']).includes('gc')) {
                    throw new Error('Unstable feature use: \'gc\' is unstable. It must be opted in via \'--unstable\', e.g. \'cdk gc --unstable=gc\'');
                }
                return cli.garbageCollect(args.ENVIRONMENTS, {
                    action: args.action,
                    type: args.type,
                    rollbackBufferDays: args['rollback-buffer-days'],
                    createdBufferDays: args['created-buffer-days'],
                    bootstrapStackName: args.bootstrapStackName,
                    confirm: args.confirm,
                });
            case 'synthesize':
            case 'synth':
                const quiet = configuration.settings.get(['quiet']) ?? args.quiet;
                if (args.exclusively) {
                    return cli.synth(args.STACKS, args.exclusively, quiet, args.validation, argv.json);
                }
                else {
                    return cli.synth(args.STACKS, true, quiet, args.validation, argv.json);
                }
            case 'notices':
                // This is a valid command, but we're postponing its execution
                return;
            case 'metadata':
                return cli.metadata(args.STACK, argv.json);
            case 'acknowledge':
            case 'ack':
                return cli.acknowledge(args.ID);
            case 'init':
                const language = configuration.settings.get(['language']);
                if (args.list) {
                    return (0, init_1.printAvailableTemplates)(language);
                }
                else {
                    return (0, init_1.cliInit)({
                        type: args.TEMPLATE,
                        language,
                        canUseNetwork: undefined,
                        generateOnly: args.generateOnly,
                    });
                }
            case 'migrate':
                return cli.migrate({
                    stackName: args['stack-name'],
                    fromPath: args['from-path'],
                    fromStack: args['from-stack'],
                    language: args.language,
                    outputPath: args['output-path'],
                    fromScan: (0, migrate_1.getMigrateScanType)(args['from-scan']),
                    filter: args.filter,
                    account: args.account,
                    region: args.region,
                    compress: args.compress,
                });
            case 'version':
                return (0, logging_1.data)(version.DISPLAY_VERSION);
            default:
                throw new Error('Unknown command: ' + command);
        }
    }
}
/**
 * Determine which version of bootstrapping
 * (legacy, or "new") should be used.
 */
function determineBootstrapVersion(args, configuration) {
    const isV1 = version.DISPLAY_VERSION.startsWith('1.');
    return isV1 ? determineV1BootstrapSource(args, configuration) : determineV2BootstrapSource(args);
}
function determineV1BootstrapSource(args, configuration) {
    let source;
    if (args.template) {
        (0, logging_1.print)(`Using bootstrapping template from ${args.template}`);
        source = { source: 'custom', templateFile: args.template };
    }
    else if (process.env.CDK_NEW_BOOTSTRAP) {
        (0, logging_1.print)('CDK_NEW_BOOTSTRAP set, using new-style bootstrapping');
        source = { source: 'default' };
    }
    else if (isFeatureEnabled(configuration, cxapi.NEW_STYLE_STACK_SYNTHESIS_CONTEXT)) {
        (0, logging_1.print)(`'${cxapi.NEW_STYLE_STACK_SYNTHESIS_CONTEXT}' context set, using new-style bootstrapping`);
        source = { source: 'default' };
    }
    else {
        // in V1, the "legacy" bootstrapping is the default
        source = { source: 'legacy' };
    }
    return source;
}
function determineV2BootstrapSource(args) {
    let source;
    if (args.template) {
        (0, logging_1.print)(`Using bootstrapping template from ${args.template}`);
        source = { source: 'custom', templateFile: args.template };
    }
    else if (process.env.CDK_LEGACY_BOOTSTRAP) {
        (0, logging_1.print)('CDK_LEGACY_BOOTSTRAP set, using legacy-style bootstrapping');
        source = { source: 'legacy' };
    }
    else {
        // in V2, the "new" bootstrapping is the default
        source = { source: 'default' };
    }
    return source;
}
function isFeatureEnabled(configuration, featureFlag) {
    return configuration.context.get(featureFlag) ?? cxapi.futureFlagDefault(featureFlag);
}
/**
 * Translate a Yargs input array to something that makes more sense in a programming language
 * model (telling the difference between absence and an empty array)
 *
 * - An empty array is the default case, meaning the user didn't pass any arguments. We return
 *   undefined.
 * - If the user passed a single empty string, they did something like `--array=`, which we'll
 *   take to mean they passed an empty array.
 */
function arrayFromYargs(xs) {
    if (xs.length === 0) {
        return undefined;
    }
    return xs.filter((x) => x !== '');
}
function yargsNegativeAlias(shortName, longName) {
    return (argv) => {
        if (shortName in argv && argv[shortName]) {
            argv[longName] = false;
        }
        return argv;
    };
}
function determineHotswapMode(hotswap, hotswapFallback, watch) {
    if (hotswap && hotswapFallback) {
        throw new Error('Can not supply both --hotswap and --hotswap-fallback at the same time');
    }
    else if (!hotswap && !hotswapFallback) {
        if (hotswap === undefined && hotswapFallback === undefined) {
            return watch ? common_1.HotswapMode.HOTSWAP_ONLY : common_1.HotswapMode.FULL_DEPLOYMENT;
        }
        else if (hotswap === false || hotswapFallback === false) {
            return common_1.HotswapMode.FULL_DEPLOYMENT;
        }
    }
    let hotswapMode;
    if (hotswap) {
        hotswapMode = common_1.HotswapMode.HOTSWAP_ONLY;
        /*if (hotswapFallback)*/
    }
    else {
        hotswapMode = common_1.HotswapMode.FALL_BACK;
    }
    return hotswapMode;
}
function cli(args = process.argv.slice(2)) {
    exec(args)
        .then(async (value) => {
        if (typeof value === 'number') {
            process.exitCode = value;
        }
    })
        .catch((err) => {
        (0, logging_1.error)(err.message);
        if (err.stack) {
            (0, logging_1.debug)(err.stack);
        }
        process.exitCode = 1;
    });
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiY2xpLmpzIiwic291cmNlUm9vdCI6IiIsInNvdXJjZXMiOlsiY2xpLnRzIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiI7O0FBcUNBLG9CQThaQztBQWtHRCxrQkFjQztBQW5qQkQseUNBQXlDO0FBQ3pDLGdDQUE4QjtBQUM5QiwrQkFBK0I7QUFHL0IsaURBQW1EO0FBRW5ELGlGQUEyRTtBQUMzRSwyREFBK0Q7QUFDL0QsNENBQStDO0FBQy9DLGtEQUFrRDtBQUNsRCxvREFBcUU7QUFFckUsd0VBQWlGO0FBQ2pGLGdEQUFvRDtBQUNwRCx3REFBcUQ7QUFDckQsOENBQStDO0FBQy9DLDBEQUFzRDtBQUN0RCxvREFBZ0U7QUFDaEUscURBQWlFO0FBQ2pFLCtDQUEyRDtBQUMzRCxtREFBK0Q7QUFDL0QscURBQTBGO0FBQzFGLHNDQUF1RjtBQUN2Riw0Q0FBK0U7QUFDL0UsNENBQXlDO0FBQ3pDLDhDQUFtRTtBQUNuRSwwQ0FBMEM7QUFFMUMsNEJBQTRCO0FBQzVCLGlEQUFpRCxDQUFDLFFBQVE7QUFFMUQsSUFBSSxDQUFDLE9BQU8sQ0FBQyxNQUFNLENBQUMsS0FBSyxFQUFFLENBQUM7SUFDMUIsbUNBQW1DO0lBQ25DLE9BQU8sQ0FBQyxHQUFHLENBQUMsV0FBVyxHQUFHLEdBQUcsQ0FBQztBQUNoQyxDQUFDO0FBRU0sS0FBSyxVQUFVLElBQUksQ0FBQyxJQUFjLEVBQUUsV0FBeUI7SUFDbEUsU0FBUyxrQkFBa0I7UUFDekIsTUFBTSxxQkFBcUIsR0FBMEM7WUFDbkUsTUFBTSxFQUFFLFNBQVM7WUFDakIsS0FBSyxFQUFFLFVBQVU7U0FDbEIsQ0FBQztRQUVGLE1BQU0sR0FBRyxHQUFHLHFCQUFxQixDQUFDLE9BQU8sQ0FBQyxRQUFRLENBQUMsQ0FBQztRQUNwRCxPQUFPLEdBQUcsSUFBSSxhQUFhLENBQUM7SUFDOUIsQ0FBQztJQUVELE1BQU0sSUFBSSxHQUFHLE1BQU0sSUFBQSx3REFBeUIsRUFBQyxJQUFJLEVBQUUsa0JBQWtCLEVBQUUsRUFBRSxNQUFNLElBQUEs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VyxDQUFDLGVBQWUsQ0FBQztRQUN4RSxDQUFDO2FBQU0sSUFBSSxPQUFPLEtBQUssS0FBSyxJQUFJLGVBQWUsS0FBSyxLQUFLLEVBQUUsQ0FBQztZQUMxRCxPQUFPLG9CQUFXLENBQUMsZUFBZSxDQUFDO1FBQ3JDLENBQUM7SUFDSCxDQUFDO0lBRUQsSUFBSSxXQUF3QixDQUFDO0lBQzdCLElBQUksT0FBTyxFQUFFLENBQUM7UUFDWixXQUFXLEdBQUcsb0JBQVcsQ0FBQyxZQUFZLENBQUM7UUFDekMsd0JBQXdCO0lBQ3hCLENBQUM7U0FBTSxDQUFDO1FBQ04sV0FBVyxHQUFHLG9CQUFXLENBQUMsU0FBUyxDQUFDO0lBQ3RDLENBQUM7SUFFRCxPQUFPLFdBQVcsQ0FBQztBQUNyQixDQUFDO0FBRUQsU0FBZ0IsR0FBRyxDQUFDLE9BQWlCLE9BQU8sQ0FBQyxJQUFJLENBQUMsS0FBSyxDQUFDLENBQUMsQ0FBQztJQUN4RCxJQUFJLENBQUMsSUFBSSxDQUFDO1NBQ1AsSUFBSSxDQUFDLEtBQUssRUFBRSxLQUFLLEVBQUUsRUFBRTtRQUNwQixJQUFJLE9BQU8sS0FBSyxLQUFLLFFBQVEsRUFBRSxDQUFDO1lBQzlCLE9BQU8sQ0FBQyxRQUFRLEdBQUcsS0FBSyxDQUFDO1FBQzNCLENBQUM7SUFDSCxDQUFDLENBQUM7U0FDRCxLQUFLLENBQUMsQ0FBQyxHQUFHLEVBQUUsRUFBRTtRQUNiLElBQUEsZUFBSyxFQUFDLEdBQUcsQ0FBQyxPQUFPLENBQUMsQ0FBQztRQUNuQixJQUFJLEdBQUcsQ0FBQyxLQUFLLEVBQUUsQ0FBQztZQUNkLElBQUEsZUFBSyxFQUFDLEdBQUcsQ0FBQyxLQUFLLENBQUMsQ0FBQztRQUNuQixDQUFDO1FBQ0QsT0FBTyxDQUFDLFFBQVEsR0FBRyxDQUFDLENBQUM7SUFDdkIsQ0FBQyxDQUFDLENBQUM7QUFDUCxDQUFDIiwic291cmNlc0NvbnRlbnQiOlsiaW1wb3J0ICogYXMgY3hhcGkgZnJvbSAnQGF3cy1jZGsvY3gtYXBpJztcbmltcG9ydCAnQGpzaWkvY2hlY2stbm9kZS9ydW4nO1xuaW1wb3J0ICogYXMgY2hhbGsgZnJvbSAnY2hhbGsnO1xuXG5pbXBvcnQgeyBEZXBsb3ltZW50TWV0aG9kIH0gZnJvbSAnLi9hcGknO1xuaW1wb3J0IHsgSG90c3dhcE1vZGUgfSBmcm9tICcuL2FwaS9ob3Rzd2FwL2NvbW1vbic7XG5pbXBvcnQgeyBJTG9jayB9IGZyb20gJy4vYXBpL3V0aWwvcndsb2NrJztcbmltcG9ydCB7IHBhcnNlQ29tbWFuZExpbmVBcmd1bWVudHMgfSBmcm9tICcuL3BhcnNlLWNvbW1hbmQtbGluZS1hcmd1bWVudHMnO1xuaW1wb3J0IHsgY2hlY2tGb3JQbGF0Zm9ybVdhcm5pbmdzIH0gZnJvbSAnLi9wbGF0Zm9ybS13YXJuaW5ncyc7XG5pbXBvcnQgeyBlbmFibGVUcmFjaW5nIH0gZnJvbSAnLi91dGlsL3RyYWNpbmcnO1xuaW1wb3J0IHsgU2RrUHJvdmlkZXIgfSBmcm9tICcuLi9saWIvYXBpL2F3cy1hdXRoJztcbmltcG9ydCB7IEJvb3RzdHJhcFNvdXJjZSwgQm9vdHN0cmFwcGVyIH0gZnJvbSAnLi4vbGliL2FwaS9ib290c3RyYXAnO1xuaW1wb3J0IHsgU3RhY2tTZWxlY3RvciB9IGZyb20gJy4uL2xpYi9hcGkvY3hhcHAvY2xvdWQtYXNzZW1ibHknO1xuaW1wb3J0IHsgQ2xvdWRFeGVjdXRhYmxlLCBTeW50aGVzaXplciB9IGZyb20gJy4uL2xpYi9hcGkvY3hhcHAvY2xvdWQtZXhlY3V0YWJsZSc7XG5pbXBvcnQgeyBleGVjUHJvZ3JhbSB9IGZyb20gJy4uL2xpYi9hcGkvY3hhcHAvZXhlYyc7XG5pbXBvcnQgeyBEZXBsb3ltZW50cyB9IGZyb20gJy4uL2xpYi9hcGkvZGVwbG95bWVudHMnO1xuaW1wb3J0IHsgUGx1Z2luSG9zdCB9IGZyb20gJy4uL2xpYi9hcGkvcGx1Z2luJztcbmltcG9ydCB7IFRvb2xraXRJbmZvIH0gZnJvbSAnLi4vbGliL2FwaS90b29sa2l0LWluZm8nO1xuaW1wb3J0IHsgQ2RrVG9vbGtpdCwgQXNzZXRCdWlsZFRpbWUgfSBmcm9tICcuLi9saWIvY2RrLXRvb2xraXQnO1xuaW1wb3J0IHsgcmVhbEhhbmRsZXIgYXMgY29udGV4dCB9IGZyb20gJy4uL2xpYi9jb21tYW5kcy9jb250ZXh0JztcbmltcG9ydCB7IHJlYWxIYW5kbGVyIGFzIGRvY3MgfSBmcm9tICcuLi9saWIvY29tbWFuZHMvZG9jcyc7XG5pbXBvcnQgeyByZWFsSGFuZGxlciBhcyBkb2N0b3IgfSBmcm9tICcuLi9saWIvY29tbWFuZHMvZG9jdG9yJztcbmltcG9ydCB7IE1JR1JBVEVfU1VQUE9SVEVEX0xBTkdVQUdFUywgZ2V0TWlncmF0ZVNjYW5UeXBlIH0gZnJvbSAnLi4vbGliL2NvbW1hbmRzL21pZ3JhdGUnO1xuaW1wb3J0IHsgYXZhaWxhYmxlSW5pdExhbmd1YWdlcywgY2xpSW5pdCwgcHJpbnRBdmFpbGFibGVUZW1wbGF0ZXMgfSBmcm9tICcuLi9saWIvaW5pdCc7XG5pbXBvcnQgeyBkYXRhLCBkZWJ1ZywgZXJyb3IsIHByaW50LCBzZXRMb2dMZXZlbCwgc2V0Q0kgfSBmcm9tICcuLi9saWIvbG9nZ2luZyc7XG5pbXBvcnQgeyBOb3RpY2VzIH0gZnJvbSAnLi4vbGliL25vdGljZXMnO1xuaW1wb3J0IHsgQ29tbWFuZCwgQ29uZmlndXJhdGlvbiwgU2V0dGluZ3MgfSBmcm9tICcuLi9saWIvc2V0dGluZ3MnO1xuaW1wb3J0ICogYXMgdmVyc2lvbiBmcm9tICcuLi9saWIvdmVyc2lvbic7XG5cbi8qIGVzbGludC1kaXNhYmxlIG1heC1sZW4gKi9cbi8qIGVzbGludC1kaXNhYmxlIEB0eXBlc2NyaXB0LWVzbGludC9uby1zaGFkb3cgKi8gLy8geWFyZ3NcblxuaWYgKCFwcm9jZXNzLnN0ZG91dC5pc1RUWSkge1xuICAvLyBEaXNhYmxlIGNoYWxrIGNvbG9yIGhpZ2hsaWdodGluZ1xuICBwcm9jZXNzLmVudi5GT1JDRV9DT0xPUiA9ICcwJztcbn1cblxuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIGV4ZWMoYXJnczogc3RyaW5nW10sIHN5bnRoZXNpemVyPzogU3ludGhlc2l6ZXIpOiBQcm9taXNlPG51bWJlciB8IHZvaWQ+IHtcbiAgZnVuY3Rpb24gbWFrZUJyb3dzZXJEZWZhdWx0KCk6IHN0cmluZyB7XG4gICAgY29uc3QgZGVmYXVsdEJyb3dzZXJDb21tYW5kOiB7IFtrZXkgaW4gTm9kZUpTLlBsYXRmb3JtXT86IHN0cmluZyB9ID0ge1xuICAgICAgZGFyd2luOiAnb3BlbiAldScsXG4gICAgICB3aW4zMjogJ3N0YXJ0ICV1JyxcbiAgICB9O1xuXG4gICAgY29uc3QgY21kID0gZGVmYXVsdEJyb3dzZXJDb21tYW5kW3Byb2Nlc3MucGxhdGZvcm1dO1xuICAgIHJldHVybiBjbWQgPz8gJ3hkZy1vcGVuICV1JztcbiAgfVxuXG4gIGNvbnN0IGFyZ3YgPSBhd2FpdCBwYXJzZUNvbW1hbmRMaW5lQXJndW1lbnRzKGFyZ3MsIG1ha2VCcm93c2VyRGVmYXVsdCgpLCBhd2FpdCBhdmFpbGFibGVJbml0TGFuZ3VhZ2VzKCksIE1JR1JBVEVfU1VQUE9SVEVEX0xBTkdVQUdFUyBhcyBzdHJpbmdbXSwgdmVyc2lvbi5ESVNQTEFZX1ZFUlNJT04sIHlhcmdzTmVnYXRpdmVBbGlhcyk7XG5cbiAgaWYgKGFyZ3YudmVyYm9zZSkge1xuICAgIHNldExvZ0xldmVsKGFyZ3YudmVyYm9zZSk7XG4gIH1cblxuICAvLyBEZWJ1ZyBzaG91bGQgYWx3YXlzIGltcGx5IHRyYWNpbmdcbiAgaWYgKGFyZ3YuZGVidWcgfHwgYXJndi52ZXJib3NlID4gMikge1xuICAgIGVuYWJsZVRyYWNpbmcodHJ1ZSk7XG4gIH1cblxuICBpZiAoYXJndi5jaSkge1xuICAgIHNldENJKHRydWUpO1xuICB9XG5cbiAgdHJ5IHtcbiAgICBhd2FpdCBjaGVja0ZvclBsYXRmb3JtV2FybmluZ3MoKTtcbiAgfSBjYXRjaCAoZSkge1xuICAgIGRlYnVnKGBFcnJvciB3aGlsZSBjaGVja2luZyBmb3IgcGxhdGZvcm0gd2FybmluZ3M6ICR7ZX1gKTtcbiAgfVxuXG4gIGRlYnVnKCdDREsgdG9vbGtpdCB2ZXJzaW9uOicsIHZlcnNpb24uRElTUExBWV9WRVJTSU9OKTtcbiAgZGVidWcoJ0NvbW1hbmQgbGluZSBhcmd1bWVudHM6JywgYXJndik7XG5cbiAgY29uc3QgY29uZmlndXJhdGlvbiA9IG5ldyBDb25maWd1cmF0aW9uKHtcbiAgICBjb21tYW5kTGluZUFyZ3VtZW50czoge1xuICAgICAgLi4uYXJndixcbiAgICAgIF86IGFyZ3YuXyBhcyBbQ29tbWFuZCwgLi4uc3RyaW5nW11dLCAvLyBUeXBlU2NyaXB0IGF0IGl0cyBiZXN0XG4gICAgfSxcbiAgfSk7XG4gIGF3YWl0IGNvbmZpZ3VyYXRpb24ubG9hZCgpO1xuXG4gIGNvbnN0IGNtZCA9IGFyZ3YuX1swXTtcblxuICBjb25zdCBub3RpY2VzID0gTm90aWNlcy5jcmVhdGUoeyBjb25maWd1cmF0aW9uLCBpbmNsdWRlQWNrbm93bGVkZ2VkOiBjbWQgPT09ICdub3RpY2VzJyA/ICFhcmd2LnVuYWNrbm93bGVkZ2VkIDogZmFsc2UgfSk7XG4gIGF3YWl0IG5vdGljZXMucmVmcmVzaCgpO1xuXG4gIGNvbnN0IHNka1Byb3ZpZGVyID0gYXdhaXQgU2RrUHJvdmlkZXIud2l0aEF3c0NsaUNvbXBhdGlibGVEZWZhdWx0cyh7XG4gICAgcHJvZmlsZTogY29uZmlndXJhdGlvbi5zZXR0aW5ncy5nZXQoWydwcm9maWxlJ10pLFxuICAgIGh0dHBPcHRpb25zOiB7XG4gICAgICBwcm94eUFkZHJlc3M6IGFyZ3YucHJveHksXG4gICAgICBjYUJ1bmRsZVBhdGg6IGFyZ3ZbJ2NhLWJ1bmRsZS1wYXRoJ10sXG4gICAgfSxcbiAgfSk7XG5cbiAgbGV0IG91dERpckxvY2s6IElMb2NrIHwgdW5kZWZpbmVkO1xuICBjb25zdCBjbG91ZEV4ZWN1dGFibGUgPSBuZXcgQ2xvdWRFeGVjdXRhYmxlKHtcbiAgICBjb25maWd1cmF0aW9uLFxuICAgIHNka1Byb3ZpZGVyLFxuICAgIHN5bnRoZXNpemVyOlxuICAgICAgc3ludGhlc2l6ZXIgPz9cbiAgICAgIChhc3luYyAoYXdzLCBjb25maWcpID0+IHtcbiAgICAgICAgLy8gSW52b2tlICdleGVjUHJvZ3JhbScsIGFuZCBjb3B5IHRoZSBsb2NrIGZvciB0aGUgZGlyZWN0b3J5IGluIHRoZSBnbG9iYWxcbiAgICAgICAgLy8gdmFyaWFibGUgaGVyZS4gSXQgd2lsbCBiZSByZWxlYXNlZCB3aGVuIHRoZSBDTEkgZXhpdHMuIExvY2tzIGFyZSBub3QgcmUtZW50cmFudFxuICAgICAgICAvLyBzbyByZWxlYXNlIGl0IGlmIHdlIGhhdmUgdG8gc3ludGhlc2l6ZSBtb3JlIHRoYW4gb25jZSAoYmVjYXVzZSBvZiBjb250ZXh0IGxvb2t1cHMpLlxuICAgICAgICBhd2FpdCBvdXREaXJMb2NrPy5yZWxlYXNlKCk7XG4gICAgICAgIGNvbnN0IHsgYXNzZW1ibHksIGxvY2sgfSA9IGF3YWl0IGV4ZWNQcm9ncmFtKGF3cywgY29uZmlnKTtcbiAgICAgICAgb3V0RGlyTG9jayA9IGxvY2s7XG4gICAgICAgIHJldHVybiBhc3NlbWJseTtcbiAgICAgIH0pLFxuICB9KTtcblxuICAvKiogRnVuY3Rpb24gdG8gbG9hZCBwbHVnLWlucywgdXNpbmcgY29uZmlndXJhdGlvbnMgYWRkaXRpdmVseS4gKi9cbiAgZnVuY3Rpb24gbG9hZFBsdWdpbnMoLi4uc2V0dGluZ3M6IFNldHRpbmdzW10pIHtcbiAgICBjb25zdCBsb2FkZWQgPSBuZXcgU2V0PHN0cmluZz4oKTtcbiAgICBmb3IgKGNvbnN0IHNvdXJjZSBvZiBzZXR0aW5ncykge1xuICAgICAgY29uc3QgcGx1Z2luczogc3RyaW5nW10gPSBzb3VyY2UuZ2V0KFsncGx1Z2luJ10pIHx8IFtdO1xuICAgICAgZm9yIChjb25zdCBwbHVnaW4gb2YgcGx1Z2lucykge1xuICAgICAgICBjb25zdCByZXNvbHZlZCA9IHRyeVJlc29sdmUocGx1Z2luKTtcbiAgICAgICAgaWYgKGxvYWRlZC5oYXMocmVzb2x2ZWQpKSB7XG4gICAgICAgICAgY29udGludWU7XG4gICAgICAgIH1cbiAgICAgICAgZGVidWcoYExvYWRpbmcgcGx1Zy1pbjogJHtjaGFsay5ncmVlbihwbHVnaW4pfSBmcm9tICR7Y2hhbGsuYmx1ZShyZXNvbHZlZCl9YCk7XG4gICAgICAgIFBsdWdpbkhvc3QuaW5zdGFuY2UubG9hZChwbHVnaW4pO1xuICAgICAgICBsb2FkZWQuYWRkKHJlc29sdmVkKTtcbiAgICAgIH1cbiAgICB9XG5cbiAgICBmdW5jdGlvbiB0cnlSZXNvbHZlKHBsdWdpbjogc3RyaW5nKTogc3RyaW5nIHtcbiAgICAgIHRyeSB7XG4gICAgICAgIHJldHVybiByZXF1aXJlLnJlc29sdmUocGx1Z2luKTtcbiAgICAgIH0gY2F0Y2ggKGU6IGFueSkge1xuICAgICAgICBlcnJvcihgVW5hYmxlIHRvIHJlc29sdmUgcGx1Z2luICR7Y2hhbGsuZ3JlZW4ocGx1Z2luKX06ICR7ZS5zdGFja31gKTtcbiAgICAgICAgdGhyb3cgbmV3IEVycm9yKGBVbmFibGUgdG8gcmVzb2x2ZSBwbHVnLWluOiAke3BsdWdpbn1gKTtcbiAgICAgIH1cbiAgICB9XG4gIH1cblxuICBsb2FkUGx1Z2lucyhjb25maWd1cmF0aW9uLnNldHRpbmdzKTtcblxuICBpZiAodHlwZW9mKGNtZCkgIT09ICdzdHJpbmcnKSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKGBGaXJzdCBhcmd1bWVudCBzaG91bGQgYmUgYSBzdHJpbmcuIEdvdDogJHtjbWR9ICgke3R5cGVvZihjbWQpfSlgKTtcbiAgfVxuXG4gIC8vIEJ1bmRsZSB1cCBnbG9iYWwgb2JqZWN0cyBzbyB0aGUgY29tbWFuZHMgaGF2ZSBhY2Nlc3MgdG8gdGhlbVxuICBjb25zdCBjb21tYW5kT3B0aW9ucyA9IHsgYXJnczogYXJndiwgY29uZmlndXJhdGlvbiwgYXdzOiBzZGtQcm92aWRlciB9O1xuXG4gIHRyeSB7XG4gICAgcmV0dXJuIGF3YWl0IG1haW4oY21kLCBhcmd2KTtcbiAgfSBmaW5hbGx5IHtcbiAgICAvLyBJZiB3ZSBsb2NrZWQgdGhlICdjZGsub3V0JyBkaXJlY3RvcnksIHJlbGVhc2UgaXQgaGVyZS5cbiAgICBhd2FpdCBvdXREaXJMb2NrPy5yZWxlYXNlKCk7XG5cbiAgICAvLyBEbyBQU0FzIGhlcmVcbiAgICBhd2FpdCB2ZXJzaW9uLmRpc3BsYXlWZXJzaW9uTWVzc2FnZSgpO1xuXG4gICAgaWYgKGNtZCA9PT0gJ25vdGljZXMnKSB7XG4gICAgICBhd2FpdCBub3RpY2VzLnJlZnJlc2goeyBmb3JjZTogdHJ1ZSB9KTtcbiAgICAgIG5vdGljZXMuZGlzcGxheSh7IHNob3dUb3RhbDogYXJndi51bmFja25vd2xlZGdlZCB9KTtcblxuICAgIH0gZWxzZSBpZiAoY21kICE9PSAndmVyc2lvbicpIHtcbiAgICAgIGF3YWl0IG5vdGljZXMucmVmcmVzaCgpO1xuICAgICAgbm90aWNlcy5kaXNwbGF5KCk7XG4gICAgfVxuXG4gIH1cblxuICBhc3luYyBmdW5jdGlvbiBtYWluKGNvbW1hbmQ6IHN0cmluZywgYXJnczogYW55KTogUHJvbWlzZTxudW1iZXIgfCB2b2lkPiB7XG4gICAgY29uc3QgdG9vbGtpdFN0YWNrTmFtZTogc3RyaW5nID0gVG9vbGtpdEluZm8uZGV0ZXJtaW5lTmFtZShjb25maWd1cmF0aW9uLnNldHRpbmdzLmdldChbJ3Rvb2xraXRTdGFja05hbWUnXSkpO1xuICAgIGRlYnVnKGBUb29sa2l0IHN0YWNrOiAke2NoYWxrLmJvbGQodG9vbGtpdFN0YWNrTmFtZSl9YCk7XG5cbiAgICBjb25zdCBjbG91ZEZvcm1hdGlvbiA9IG5ldyBEZXBsb3ltZW50cyh7IHNka1Byb3ZpZGVyLCB0b29sa2l0U3RhY2tOYW1lIH0pO1xuXG4gICAgaWYgKGFyZ3MuYWxsICYmIGFyZ3MuU1RBQ0tTKSB7XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoJ1lvdSBtdXN0IGVpdGhlciBzcGVjaWZ5IGEgbGlzdCBvZiBTdGFja3Mgb3IgdGhlIGAtLWFsbGAgYXJndW1lbnQnKTtcbiAgICB9XG5cbiAgICBhcmdzLlNUQUNLUyA9IGFyZ3MuU1RBQ0tTID8/IChhcmdzLlNUQUNLID8gW2FyZ3MuU1RBQ0tdIDogW10pO1xuICAgIGFyZ3MuRU5WSVJPTk1FTlRTID0gYXJncy5FTlZJUk9OTUVOVFMgPz8gW107XG5cbiAgICBjb25zdCBzZWxlY3RvcjogU3RhY2tTZWxlY3RvciA9IHtcbiAgICAgIGFsbFRvcExldmVsOiBhcmdzLmFsbCxcbiAgICAgIHBhdHRlcm5zOiBhcmdzLlNUQUNLUyxcbiAgICB9O1xuXG4gICAgY29uc3QgY2xpID0gbmV3IENka1Rvb2xraXQoe1xuICAgICAgY2xvdWRFeGVjdXRhYmxlLFxuICAgICAgZGVwbG95bWVudHM6IGNsb3VkRm9ybWF0aW9uLFxuICAgICAgdmVyYm9zZTogYXJndi50cmFjZSB8fCBhcmd2LnZlcmJvc2UgPiAwLFxuICAgICAgaWdub3JlRXJyb3JzOiBhcmd2WydpZ25vcmUtZXJyb3JzJ10sXG4gICAgICBzdHJpY3Q6IGFyZ3Yuc3RyaWN0LFxuICAgICAgY29uZmlndXJhdGlvbixcbiAgICAgIHNka1Byb3ZpZGVyLFxuICAgIH0pO1xuXG4gICAgc3dpdGNoIChjb21tYW5kKSB7XG4gICAgICBjYXNlICdjb250ZXh0JzpcbiAgICAgICAgcmV0dXJuIGNvbnRleHQoY29tbWFuZE9wdGlvbnMpO1xuXG4gICAgICBjYXNlICdkb2NzJzpcbiAgICAgICAgcmV0dXJuIGRvY3MoY29tbWFuZE9wdGlvbnMpO1xuXG4gICAgICBjYXNlICdkb2N0b3InOlxuICAgICAgICByZXR1cm4gZG9jdG9yKGNvbW1hbmRPcHRpb25zKTtcblxuICAgICAgY2FzZSAnbHMnOlxuICAgICAgY2FzZSAnbGlzdCc6XG4gICAgICAgIHJldHVybiBjbGkubGlzdChhcmdzLlNUQUNLUywge1xuICAgICAgICAgIGxvbmc6IGFyZ3MubG9uZyxcbiAgICAgICAgICBqc29uOiBhcmd2Lmpzb24sXG4gICAgICAgICAgc2hvd0RlcHM6IGFyZ3Muc2hvd0RlcGVuZGVuY2llcyxcbiAgICAgICAgfSk7XG5cbiAgICAgIGNhc2UgJ2RpZmYnOlxuICAgICAgICBjb25zdCBlbmFibGVEaWZmTm9GYWlsID0gaXNGZWF0dXJlRW5hYmxlZChjb25maWd1cmF0aW9uLCBjeGFwaS5FTkFCTEVfRElGRl9OT19GQUlMX0NPTlRFWFQpO1xuICAgICAgICByZXR1cm4gY2xpLmRpZmYoe1xuICAgICAgICAgIHN0YWNrTmFtZXM6IGFyZ3MuU1RBQ0tTLFxuICAgICAgICAgIGV4Y2x1c2l2ZWx5OiBhcmdzLmV4Y2x1c2l2ZWx5LFxuICAgICAgICAgIHRlbXBsYXRlUGF0aDogYXJncy50ZW1wbGF0ZSxcbiAgICAgICAgICBzdHJpY3Q6IGFyZ3Muc3RyaWN0LFxuICAgICAgICAgIGNvbnRleHRMaW5lczogYXJncy5jb250ZXh0TGluZXMsXG4gICAgICAgICAgc2VjdXJpdHlPbmx5OiBhcmdzLnNlY3VyaXR5T25seSxcbiAgICAgICAgICBmYWlsOiBhcmdzLmZhaWwgIT0gbnVsbCA/IGFyZ3MuZmFpbCA6ICFlbmFibGVEaWZmTm9GYWlsLFxuICAgICAgICAgIHN0cmVhbTogYXJncy5jaSA/IHByb2Nlc3Muc3Rkb3V0IDogdW5kZWZpbmVkLFxuICAgICAgICAgIGNvbXBhcmVBZ2FpbnN0UHJvY2Vzc2VkVGVtcGxhdGU6IGFyZ3MucHJvY2Vzc2VkLFxuICAgICAgICAgIHF1aWV0OiBhcmdzLnF1aWV0LFxuICAgICAgICAgIGNoYW5nZVNldDogYXJnc1snY2hhbmdlLXNldCddLFxuICAgICAgICAgIHRvb2xraXRTdGFja05hbWU6IHRvb2xraXRTdGFja05hbWUsXG4gICAgICAgIH0pO1xuXG4gICAgICBjYXNlICdib290c3RyYXAnOlxuICAgICAgICBjb25zdCBzb3VyY2U6IEJvb3RzdHJhcFNvdXJjZSA9IGRldGVybWluZUJvb3RzdHJhcFZlcnNpb24oYXJncywgY29uZmlndXJhdGlvbik7XG5cbiAgICAgICAgY29uc3QgYm9vdHN0cmFwcGVyID0gbmV3IEJvb3RzdHJhcHBlcihzb3VyY2UpO1xuXG4gICAgICAgIGlmIChhcmdzLnNob3dUZW1wbGF0ZSkge1xuICAgICAgICAgIHJldHVybiBib290c3RyYXBwZXIuc2hvd1RlbXBsYXRlKGFyZ3MuanNvbik7XG4gICAgICAgIH1cblxuICAgICAgICByZXR1cm4gY2xpLmJvb3RzdHJhcChhcmdzLkVOVklST05NRU5UUywgYm9vdHN0cmFwcGVyLCB7XG4gICAgICAgICAgcm9sZUFybjogYXJncy5yb2xlQXJuLFxuICAgICAgICAgIGZvcmNlOiBhcmd2LmZvcmNlLFxuICAgICAgICAgIHRvb2xraXRTdGFja05hbWU6IHRvb2xraXRTdGFja05hbWUsXG4gICAgICAgICAgZXhlY3V0ZTogYXJncy5leGVjdXRlLFxuICAgICAgICAgIHRhZ3M6IGNvbmZpZ3VyYXRpb24uc2V0dGluZ3MuZ2V0KFsndGFncyddKSxcbiAgICAgICAgICB0ZXJtaW5hdGlvblByb3RlY3Rpb246IGFyZ3MudGVybWluYXRpb25Qcm90ZWN0aW9uLFxuICAgICAgICAgIHVzZVByZXZpb3VzUGFyYW1ldGVyczogYXJnc1sncHJldmlvdXMtcGFyYW1ldGVycyddLFxuICAgICAgICAgIHBhcmFtZXRlcnM6IHtcbiAgICAgICAgICAgIGJ1Y2tldE5hbWU6IGNvbmZpZ3VyYXRpb24uc2V0dGluZ3MuZ2V0KFsndG9vbGtpdEJ1Y2tldCcsICdidWNrZXROYW1lJ10pLFxuICAgICAgICAgICAga21zS2V5SWQ6IGNvbmZpZ3VyYXRpb24uc2V0dGluZ3MuZ2V0KFsndG9vbGtpdEJ1Y2tldCcsICdrbXNLZXlJZCddKSxcbiAgICAgICAgICAgIGNyZWF0ZUN1c3RvbWVyTWFzdGVyS2V5OiBhcmdzLmJvb3RzdHJhcEN1c3RvbWVyS2V5LFxuICAgICAgICAgICAgcXVhbGlmaWVyOiBhcmdzLnF1YWxpZmllciA/PyBjb25maWd1cmF0aW9uLmNvbnRleHQuZ2V0KCdAYXdzLWNkay9jb3JlOmJvb3RzdHJhcFF1YWxpZmllcicpLFxuICAgICAgICAgICAgcHVibGljQWNjZXNzQmxvY2tDb25maWd1cmF0aW9uOiBhcmdzLnB1YmxpY0FjY2Vzc0Jsb2NrQ29uZmlndXJhdGlvbixcbiAgICAgICAgICAgIGV4YW1wbGVQZXJtaXNzaW9uc0JvdW5kYXJ5OiBhcmd2LmV4YW1wbGVQZXJtaXNzaW9uc0JvdW5kYXJ5LFxuICAgICAgICAgICAgY3VzdG9tUGVybWlzc2lvbnNCb3VuZGFyeTogYXJndi5jdXN0b21QZXJtaXNzaW9uc0JvdW5kYXJ5LFxuICAgICAgICAgICAgdHJ1c3RlZEFjY291bnRzOiBhcnJheUZyb21ZYXJncyhhcmdzLnRydXN0KSxcbiAgICAgICAgICAgIHRydXN0ZWRBY2NvdW50c0Zvckxvb2t1cDogYXJyYXlGcm9tWWFyZ3MoYXJncy50cnVzdEZvckxvb2t1cCksXG4gICAgICAgICAgICBjbG91ZEZvcm1hdGlvbkV4ZWN1dGlvblBvbGljaWVzOiBhcnJheUZyb21ZYXJncyhhcmdzLmNsb3VkZm9ybWF0aW9uRXhlY3V0aW9uUG9saWNpZXMpLFxuICAgICAgICAgIH0sXG4gICAgICAgIH0pO1xuXG4gICAgICBjYXNlICdkZXBsb3knOlxuICAgICAgICBjb25zdCBwYXJhbWV0ZXJNYXA6IHsgW25hbWU6IHN0cmluZ106IHN0cmluZyB8IHVuZGVmaW5lZCB9ID0ge307XG4gICAgICAgIGZvciAoY29uc3QgcGFyYW1ldGVyIG9mIGFyZ3MucGFyYW1ldGVycykge1xuICAgICAgICAgIGlmICh0eXBlb2YgcGFyYW1ldGVyID09PSAnc3RyaW5nJykge1xuICAgICAgICAgICAgY29uc3Qga2V5VmFsdWUgPSAocGFyYW1ldGVyIGFzIHN0cmluZykuc3BsaXQoJz0nKTtcbiAgICAgICAgICAgIHBhcmFtZXRlck1hcFtrZXlWYWx1ZVswXV0gPSBrZXlWYWx1ZS5zbGljZSgxKS5qb2luKCc9Jyk7XG4gICAgICAgICAgfVxuICAgICAgICB9XG5cbiAgICAgICAgaWYgKGFyZ3MuZXhlY3V0ZSAhPT0gdW5kZWZpbmVkICYmIGFyZ3MubWV0aG9kICE9PSB1bmRlZmluZWQpIHtcbiAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoJ0NhbiBub3Qgc3VwcGx5IGJvdGggLS1bbm8tXWV4ZWN1dGUgYW5kIC0tbWV0aG9kIGF0IHRoZSBzYW1lIHRpbWUnKTtcbiAgICAgICAgfVxuXG4gICAgICAgIGxldCBkZXBsb3ltZW50TWV0aG9kOiBEZXBsb3ltZW50TWV0aG9kIHwgdW5kZWZpbmVkO1xuICAgICAgICBzd2l0Y2ggKGFyZ3MubWV0aG9kKSB7XG4gICAgICAgICAgY2FzZSAnZGlyZWN0JzpcbiAgICAgICAgICAgIGlmIChhcmdzLmNoYW5nZVNldE5hbWUpIHtcbiAgICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKCctLWNoYW5nZS1zZXQtbmFtZSBjYW5ub3QgYmUgdXNlZCB3aXRoIG1ldGhvZD1kaXJlY3QnKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIGRlcGxveW1lbnRNZXRob2QgPSB7IG1ldGhvZDogJ2RpcmVjdCcgfTtcbiAgICAgICAgICAgIGJyZWFrO1xuICAgICAgICAgIGNhc2UgJ2NoYW5nZS1zZXQnOlxuICAgICAgICAgICAgZGVwbG95bWVudE1ldGhvZCA9IHtcbiAgICAgICAgICAgICAgbWV0aG9kOiAnY2hhbmdlLXNldCcsXG4gICAgICAgICAgICAgIGV4ZWN1dGU6IHRydWUsXG4gICAgICAgICAgICAgIGNoYW5nZVNldE5hbWU6IGFyZ3MuY2hhbmdlU2V0TmFtZSxcbiAgICAgICAgICAgIH07XG4gICAgICAgICAgICBicmVhaztcbiAgICAgICAgICBjYXNlICdwcmVwYXJlLWNoYW5nZS1zZXQnOlxuICAgICAgICAgICAgZGVwbG95bWVudE1ldGhvZCA9IHtcbiAgICAgICAgICAgICAgbWV0aG9kOiAnY2hhbmdlLXNldCcsXG4gICAgICAgICAgICAgIGV4ZWN1dGU6IGZhbHNlLFxuICAgICAgICAgICAgICBjaGFuZ2VTZXROYW1lOiBhcmdzLmNoYW5nZVNldE5hbWUsXG4gICAgICAgICAgICB9O1xuICAgICAgICAgICAgYnJlYWs7XG4gICAgICAgICAgY2FzZSB1bmRlZmluZWQ6XG4gICAgICAgICAgICBkZXBsb3ltZW50TWV0aG9kID0ge1xuICAgICAgICAgICAgICBtZXRob2Q6ICdjaGFuZ2Utc2V0JyxcbiAgICAgICAgICAgICAgZXhlY3V0ZTogYXJncy5leGVjdXRlID8/IHRydWUsXG4gICAgICAgICAgICAgIGNoYW5nZVNldE5hbWU6IGFyZ3MuY2hhbmdlU2V0TmFtZSxcbiAgICAgICAgICAgIH07XG4gICAgICAgICAgICBicmVhaztcbiAgICAgICAgfVxuXG4gICAgICAgIHJldHVybiBjbGkuZGVwbG95KHtcbiAgICAgICAgICBzZWxlY3RvcixcbiAgICAgICAgICBleGNsdXNpdmVseTogYXJncy5leGNsdXNpdmVseSxcbiAgICAgICAgICB0b29sa2l0U3RhY2tOYW1lLFxuICAgICAgICAgIHJvbGVBcm46IGFyZ3Mucm9sZUFybixcbiAgICAgICAgICBub3RpZmljYXRpb25Bcm5zOiBhcmdzLm5vdGlmaWNhdGlvbkFybnMsXG4gICAgICAgICAgcmVxdWlyZUFwcHJvdmFsOiBjb25maWd1cmF0aW9uLnNldHRpbmdzLmdldChbJ3JlcXVpcmVBcHByb3ZhbCddKSxcbiAgICAgICAgICByZXVzZUFzc2V0czogYXJnc1snYnVpbGQtZXhjbHVkZSddLFxuICAgICAgICAgIHRhZ3M6IGNvbmZpZ3VyYXRpb24uc2V0dGluZ3MuZ2V0KFsndGFncyddKSxcbiAgICAgICAgICBkZXBsb3ltZW50TWV0aG9kLFxuICAgICAgICAgIGZvcmNlOiBhcmdzLmZvcmNlLFxuICAgICAgICAgIHBhcmFtZXRlcnM6IHBhcmFtZXRlck1hcCxcbiAgICAgICAgICB1c2VQcmV2aW91c1BhcmFtZXRlcnM6IGFyZ3NbJ3ByZXZpb3VzLXBhcmFtZXRlcnMnXSxcbiAgICAgICAgICBvdXRwdXRzRmlsZTogY29uZmlndXJhdGlvbi5zZXR0aW5ncy5nZXQoWydvdXRwdXRzRmlsZSddKSxcbiAgICAgICAgICBwcm9ncmVzczogY29uZmlndXJhdGlvbi5zZXR0aW5ncy5nZXQoWydwcm9ncmVzcyddKSxcbiAgICAgICAgICBjaTogYXJncy5jaSxcbiAgICAgICAgICByb2xsYmFjazogY29uZmlndXJhdGlvbi5zZXR0aW5ncy5nZXQoWydyb2xsYmFjayddKSxcbiAgICAgICAgICBob3Rzd2FwOiBkZXRlcm1pbmVIb3Rzd2FwTW9kZShhcmdzLmhvdHN3YXAsIGFyZ3MuaG90c3dhcEZhbGxiYWNrKSxcbiAgICAgICAgICB3YXRjaDogYXJncy53YXRjaCxcbiAgICAgICAgICB0cmFjZUxvZ3M6IGFyZ3MubG9ncyxcbiAgICAgICAgICBjb25jdXJyZW5jeTogYXJncy5jb25jdXJyZW5jeSxcbiAgICAgICAgICBhc3NldFBhcmFsbGVsaXNtOiBjb25maWd1cmF0aW9uLnNldHRpbmdzLmdldChbJ2Fzc2V0UGFyYWxsZWxpc20nXSksXG4gICAgICAgICAgYXNzZXRCdWlsZFRpbWU6IGNvbmZpZ3VyYXRpb24uc2V0dGluZ3MuZ2V0KFsnYXNzZXRQcmVidWlsZCddKVxuICAgICAgICAgICAgPyBBc3NldEJ1aWxkVGltZS5BTExfQkVGT1JFX0RFUExPWVxuICAgICAgICAgICAgOiBBc3NldEJ1aWxkVGltZS5KVVNUX0lOX1RJTUUsXG4gICAgICAgICAgaWdub3JlTm9TdGFja3M6IGFyZ3MuaWdub3JlTm9TdGFja3MsXG4gICAgICAgIH0pO1xuXG4gICAgICBjYXNlICdyb2xsYmFjayc6XG4gICAgICAgIHJldHVybiBjbGkucm9sbGJhY2soe1xuICAgICAgICAgIHNlbGVjdG9yLFxuICAgICAgICAgIHRvb2xraXRTdGFja05hbWUsXG4gICAgICAgICAgcm9sZUFybjogYXJncy5yb2xlQXJuLFxuICAgICAgICAgIGZvcmNlOiBhcmdzLmZvcmNlLFxuICAgICAgICAgIHZhbGlkYXRlQm9vdHN0cmFwU3RhY2tWZXJzaW9uOiBhcmdzWyd2YWxpZGF0ZS1ib290c3RyYXAtdmVyc2lvbiddLFxuICAgICAgICAgIG9ycGhhbkxvZ2ljYWxJZHM6IGFyZ3Mub3JwaGFuLFxuICAgICAgICB9KTtcblxuICAgICAgY2FzZSAnaW1wb3J0JzpcbiAgICAgICAgcmV0dXJuIGNsaS5pbXBvcnQoe1xuICAgICAgICAgIHNlbGVjdG9yLFxuICAgICAgICAgIHRvb2xraXRTdGFja05hbWUsXG4gICAgICAgICAgcm9sZUFybjogYXJncy5yb2xlQXJuLFxuICAgICAgICAgIGRlcGxveW1lbnRNZXRob2Q6IHtcbiAgICAgICAgICAgIG1ldGhvZDogJ2NoYW5nZS1zZXQnLFxuICAgICAgICAgICAgZXhlY3V0ZTogYXJncy5leGVjdXRlLFxuICAgICAgICAgICAgY2hhbmdlU2V0TmFtZTogYXJncy5jaGFuZ2VTZXROYW1lLFxuICAgICAgICAgIH0sXG4gICAgICAgICAgcHJvZ3Jlc3M6IGNvbmZpZ3VyYXRpb24uc2V0dGluZ3MuZ2V0KFsncHJvZ3Jlc3MnXSksXG4gICAgICAgICAgcm9sbGJhY2s6IGNvbmZpZ3VyYXRpb24uc2V0dGluZ3MuZ2V0KFsncm9sbGJhY2snXSksXG4gICAgICAgICAgcmVjb3JkUmVzb3VyY2VNYXBwaW5nOiBhcmdzWydyZWNvcmQtcmVzb3VyY2UtbWFwcGluZyddLFxuICAgICAgICAgIHJlc291cmNlTWFwcGluZ0ZpbGU6IGFyZ3NbJ3Jlc291cmNlLW1hcHBpbmcnXSxcbiAgICAgICAgICBmb3JjZTogYXJncy5mb3JjZSxcbiAgICAgICAgfSk7XG5cbiAgICAgIGNhc2UgJ3dhdGNoJzpcbiAgICAgICAgcmV0dXJuIGNsaS53YXRjaCh7XG4gICAgICAgICAgc2VsZWN0b3IsXG4gICAgICAgICAgZXhjbHVzaXZlbHk6IGFyZ3MuZXhjbHVzaXZlbHksXG4gICAgICAgICAgdG9vbGtpdFN0YWNrTmFtZSxcbiAgICAgICAgICByb2xlQXJuOiBhcmdzLnJvbGVBcm4sXG4gICAgICAgICAgcmV1c2VBc3NldHM6IGFyZ3NbJ2J1aWxkLWV4Y2x1ZGUnXSxcbiAgICAgICAgICBkZXBsb3ltZW50TWV0aG9kOiB7XG4gICAgICAgICAgICBtZXRob2Q6ICdjaGFuZ2Utc2V0JyxcbiAgICAgICAgICAgIGNoYW5nZVNldE5hbWU6IGFyZ3MuY2hhbmdlU2V0TmFtZSxcbiAgICAgICAgICB9LFxuICAgICAgICAgIGZvcmNlOiBhcmdzLmZvcmNlLFxuICAgICAgICAgIHByb2dyZXNzOiBjb25maWd1cmF0aW9uLnNldHRpbmdzLmdldChbJ3Byb2dyZXNzJ10pLFxuICAgICAgICAgIHJvbGxiYWNrOiBjb25maWd1cmF0aW9uLnNldHRpbmdzLmdldChbJ3JvbGxiYWNrJ10pLFxuICAgICAgICAgIGhvdHN3YXA6IGRldGVybWluZUhvdHN3YXBNb2RlKGFyZ3MuaG90c3dhcCwgYXJncy5ob3Rzd2FwRmFsbGJhY2ssIHRydWUpLFxuICAgICAgICAgIHRyYWNlTG9nczogYXJncy5sb2dzLFxuICAgICAgICAgIGNvbmN1cnJlbmN5OiBhcmdzLmNvbmN1cnJlbmN5LFxuICAgICAgICB9KTtcblxuICAgICAgY2FzZSAnZGVzdHJveSc6XG4gICAgICAgIHJldHVybiBjbGkuZGVzdHJveSh7XG4gICAgICAgICAgc2VsZWN0b3IsXG4gICAgICAgICAgZXhjbHVzaXZlbHk6IGFyZ3MuZXhjbHVzaXZlbHksXG4gICAgICAgICAgZm9yY2U6IGFyZ3MuZm9yY2UsXG4gICAgICAgICAgcm9sZUFybjogYXJncy5yb2xlQXJuLFxuICAgICAgICAgIGNpOiBhcmdzLmNpLFxuICAgICAgICB9KTtcblxuICAgICAgY2FzZSAnZ2MnOlxuICAgICAgICBpZiAoIWNvbmZpZ3VyYXRpb24uc2V0dGluZ3MuZ2V0KFsndW5zdGFibGUnXSkuaW5jbHVkZXMoJ2djJykpIHtcbiAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoJ1Vuc3RhYmxlIGZlYXR1cmUgdXNlOiBcXCdnY1xcJyBpcyB1bnN0YWJsZS4gSXQgbXVzdCBiZSBvcHRlZCBpbiB2aWEgXFwnLS11bnN0YWJsZVxcJywgZS5nLiBcXCdjZGsgZ2MgLS11bnN0YWJsZT1nY1xcJycpO1xuICAgICAgICB9XG4gICAgICAgIHJldHVybiBjbGkuZ2FyYmFnZUNvbGxlY3QoYXJncy5FTlZJUk9OTUVOVFMsIHtcbiAgICAgICAgICBhY3Rpb246IGFyZ3MuYWN0aW9uLFxuICAgICAgICAgIHR5cGU6IGFyZ3MudHlwZSxcbiAgICAgICAgICByb2xsYmFja0J1ZmZlckRheXM6IGFyZ3NbJ3JvbGxiYWNrLWJ1ZmZlci1kYXlzJ10sXG4gICAgICAgICAgY3JlYXRlZEJ1ZmZlckRheXM6IGFyZ3NbJ2NyZWF0ZWQtYnVmZmVyLWRheXMnXSxcbiAgICAgICAgICBib290c3RyYXBTdGFja05hbWU6IGFyZ3MuYm9vdHN0cmFwU3RhY2tOYW1lLFxuICAgICAgICAgIGNvbmZpcm06IGFyZ3MuY29uZmlybSxcbiAgICAgICAgfSk7XG5cbiAgICAgIGNhc2UgJ3N5bnRoZXNpemUnOlxuICAgICAgY2FzZSAnc3ludGgnOlxuICAgICAgICBjb25zdCBxdWlldCA9IGNvbmZpZ3VyYXRpb24uc2V0dGluZ3MuZ2V0KFsncXVpZXQnXSkgPz8gYXJncy5xdWlldDtcbiAgICAgICAgaWYgKGFyZ3MuZXhjbHVzaXZlbHkpIHtcbiAgICAgICAgICByZXR1cm4gY2xpLnN5bnRoKGFyZ3MuU1RBQ0tTLCBhcmdzLmV4Y2x1c2l2ZWx5LCBxdWlldCwgYXJncy52YWxpZGF0aW9uLCBhcmd2Lmpzb24pO1xuICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgIHJldHVybiBjbGkuc3ludGgoYXJncy5TVEFDS1MsIHRydWUsIHF1aWV0LCBhcmdzLnZhbGlkYXRpb24sIGFyZ3YuanNvbik7XG4gICAgICAgIH1cblxuICAgICAgY2FzZSAnbm90aWNlcyc6XG4gICAgICAgIC8vIFRoaXMgaXMgYSB2YWxpZCBjb21tYW5kLCBidXQgd2UncmUgcG9zdHBvbmluZyBpdHMgZXhlY3V0aW9uXG4gICAgICAgIHJldHVybjtcblxuICAgICAgY2FzZSAnbWV0YWRhdGEnOlxuICAgICAgICByZXR1cm4gY2xpLm1ldGFkYXRhKGFyZ3MuU1RBQ0ssIGFyZ3YuanNvbik7XG5cbiAgICAgIGNhc2UgJ2Fja25vd2xlZGdlJzpcbiAgICAgIGNhc2UgJ2Fjayc6XG4gICAgICAgIHJldHVybiBjbGkuYWNrbm93bGVkZ2UoYXJncy5JRCk7XG5cbiAgICAgIGNhc2UgJ2luaXQnOlxuICAgICAgICBjb25zdCBsYW5ndWFnZSA9IGNvbmZpZ3VyYXRpb24uc2V0dGluZ3MuZ2V0KFsnbGFuZ3VhZ2UnXSk7XG4gICAgICAgIGlmIChhcmdzLmxpc3QpIHtcbiAgICAgICAgICByZXR1cm4gcHJpbnRBdmFpbGFibGVUZW1wbGF0ZXMobGFuZ3VhZ2UpO1xuICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgIHJldHVybiBjbGlJbml0KHtcbiAgICAgICAgICAgIHR5cGU6IGFyZ3MuVEVNUExBVEUsXG4gICAgICAgICAgICBsYW5ndWFnZSxcbiAgICAgICAgICAgIGNhblVzZU5ldHdvcms6IHVuZGVmaW5lZCxcbiAgICAgICAgICAgIGdlbmVyYXRlT25seTogYXJncy5nZW5lcmF0ZU9ubHksXG4gICAgICAgICAgfSk7XG4gICAgICAgIH1cbiAgICAgIGNhc2UgJ21pZ3JhdGUnOlxuICAgICAgICByZXR1cm4gY2xpLm1pZ3JhdGUoe1xuICAgICAgICAgIHN0YWNrTmFtZTogYXJnc1snc3RhY2stbmFtZSddLFxuICAgICAgICAgIGZyb21QYXRoOiBhcmdzWydmcm9tLXBhdGgnXSxcbiAgICAgICAgICBmcm9tU3RhY2s6IGFyZ3NbJ2Zyb20tc3RhY2snXSxcbiAgICAgICAgICBsYW5ndWFnZTogYXJncy5sYW5ndWFnZSxcbiAgICAgICAgICBvdXRwdXRQYXRoOiBhcmdzWydvdXRwdXQtcGF0aCddLFxuICAgICAgICAgIGZyb21TY2FuOiBnZXRNaWdyYXRlU2NhblR5cGUoYXJnc1snZnJvbS1zY2FuJ10pLFxuICAgICAgICAgIGZpbHRlcjogYXJncy5maWx0ZXIsXG4gICAgICAgICAgYWNjb3VudDogYXJncy5hY2NvdW50LFxuICAgICAgICAgIHJlZ2lvbjogYXJncy5yZWdpb24sXG4gICAgICAgICAgY29tcHJlc3M6IGFyZ3MuY29tcHJlc3MsXG4gICAgICAgIH0pO1xuICAgICAgY2FzZSAndmVyc2lvbic6XG4gICAgICAgIHJldHVybiBkYXRhKHZlcnNpb24uRElTUExBWV9WRVJTSU9OKTtcblxuICAgICAgZGVmYXVsdDpcbiAgICAgICAgdGhyb3cgbmV3IEVycm9yKCdVbmtub3duIGNvbW1hbmQ6ICcgKyBjb21tYW5kKTtcbiAgICB9XG4gIH1cbn1cblxuLyoqXG4gKiBEZXRlcm1pbmUgd2hpY2ggdmVyc2lvbiBvZiBib290c3RyYXBwaW5nXG4gKiAobGVnYWN5LCBvciBcIm5ld1wiKSBzaG91bGQgYmUgdXNlZC5cbiAqL1xuZnVuY3Rpb24gZGV0ZXJtaW5lQm9vdHN0cmFwVmVyc2lvbihhcmdzOiB7IHRlbXBsYXRlPzogc3RyaW5nIH0sIGNvbmZpZ3VyYXRpb246IENvbmZpZ3VyYXRpb24pOiBCb290c3RyYXBTb3VyY2Uge1xuICBjb25zdCBpc1YxID0gdmVyc2lvbi5ESVNQTEFZX1ZFUlNJT04uc3RhcnRzV2l0aCgnMS4nKTtcbiAgcmV0dXJuIGlzVjEgPyBkZXRlcm1pbmVWMUJvb3RzdHJhcFNvdXJjZShhcmdzLCBjb25maWd1cmF0aW9uKSA6IGRldGVybWluZVYyQm9vdHN0cmFwU291cmNlKGFyZ3MpO1xufVxuXG5mdW5jdGlvbiBkZXRlcm1pbmVWMUJvb3RzdHJhcFNvdXJjZShhcmdzOiB7IHRlbXBsYXRlPzogc3RyaW5nIH0sIGNvbmZpZ3VyYXRpb246IENvbmZpZ3VyYXRpb24pOiBCb290c3RyYXBTb3VyY2Uge1xuICBsZXQgc291cmNlOiBCb290c3RyYXBTb3VyY2U7XG4gIGlmIChhcmdzLnRlbXBsYXRlKSB7XG4gICAgcHJpbnQoYFVzaW5nIGJvb3RzdHJhcHBpbmcgdGVtcGxhdGUgZnJvbSAke2FyZ3MudGVtcGxhdGV9YCk7XG4gICAgc291cmNlID0geyBzb3VyY2U6ICdjdXN0b20nLCB0ZW1wbGF0ZUZpbGU6IGFyZ3MudGVtcGxhdGUgfTtcbiAgfSBlbHNlIGlmIChwcm9jZXNzLmVudi5DREtfTkVXX0JPT1RTVFJBUCkge1xuICAgIHByaW50KCdDREtfTkVXX0JPT1RTVFJBUCBzZXQsIHVzaW5nIG5ldy1zdHlsZSBib290c3RyYXBwaW5nJyk7XG4gICAgc291cmNlID0geyBzb3VyY2U6ICdkZWZhdWx0JyB9O1xuICB9IGVsc2UgaWYgKGlzRmVhdHVyZUVuYWJsZWQoY29uZmlndXJhdGlvbiwgY3hhcGkuTkVXX1NUWUxFX1NUQUNLX1NZTlRIRVNJU19DT05URVhUKSkge1xuICAgIHByaW50KGAnJHtjeGFwaS5ORVdfU1RZTEVfU1RBQ0tfU1lOVEhFU0lTX0NPTlRFWFR9JyBjb250ZXh0IHNldCwgdXNpbmcgbmV3LXN0eWxlIGJvb3RzdHJhcHBpbmdgKTtcbiAgICBzb3VyY2UgPSB7IHNvdXJjZTogJ2RlZmF1bHQnIH07XG4gIH0gZWxzZSB7XG4gICAgLy8gaW4gVjEsIHRoZSBcImxlZ2FjeVwiIGJvb3RzdHJhcHBpbmcgaXMgdGhlIGRlZmF1bHRcbiAgICBzb3VyY2UgPSB7IHNvdXJjZTogJ2xlZ2FjeScgfTtcbiAgfVxuICByZXR1cm4gc291cmNlO1xufVxuXG5mdW5jdGlvbiBkZXRlcm1pbmVWMkJvb3RzdHJhcFNvdXJjZShhcmdzOiB7IHRlbXBsYXRlPzogc3RyaW5nIH0pOiBCb290c3RyYXBTb3VyY2Uge1xuICBsZXQgc291cmNlOiBCb290c3RyYXBTb3VyY2U7XG4gIGlmIChhcmdzLnRlbXBsYXRlKSB7XG4gICAgcHJpbnQoYFVzaW5nIGJvb3RzdHJhcHBpbmcgdGVtcGxhdGUgZnJvbSAke2FyZ3MudGVtcGxhdGV9YCk7XG4gICAgc291cmNlID0geyBzb3VyY2U6ICdjdXN0b20nLCB0ZW1wbGF0ZUZpbGU6IGFyZ3MudGVtcGxhdGUgfTtcbiAgfSBlbHNlIGlmIChwcm9jZXNzLmVudi5DREtfTEVHQUNZX0JPT1RTVFJBUCkge1xuICAgIHByaW50KCdDREtfTEVHQUNZX0JPT1RTVFJBUCBzZXQsIHVzaW5nIGxlZ2FjeS1zdHlsZSBib290c3RyYXBwaW5nJyk7XG4gICAgc291cmNlID0geyBzb3VyY2U6ICdsZWdhY3knIH07XG4gIH0gZWxzZSB7XG4gICAgLy8gaW4gVjIsIHRoZSBcIm5ld1wiIGJvb3RzdHJhcHBpbmcgaXMgdGhlIGRlZmF1bHRcbiAgICBzb3VyY2UgPSB7IHNvdXJjZTogJ2RlZmF1bHQnIH07XG4gIH1cbiAgcmV0dXJuIHNvdXJjZTtcbn1cblxuZnVuY3Rpb24gaXNGZWF0dXJlRW5hYmxlZChjb25maWd1cmF0aW9uOiBDb25maWd1cmF0aW9uLCBmZWF0dXJlRmxhZzogc3RyaW5nKSB7XG4gIHJldHVybiBjb25maWd1cmF0aW9uLmNvbnRleHQuZ2V0KGZlYXR1cmVGbGFnKSA/PyBjeGFwaS5mdXR1cmVGbGFnRGVmYXVsdChmZWF0dXJlRmxhZyk7XG59XG5cbi8qKlxuICogVHJhbnNsYXRlIGEgWWFyZ3MgaW5wdXQgYXJyYXkgdG8gc29tZXRoaW5nIHRoYXQgbWFrZXMgbW9yZSBzZW5zZSBpbiBhIHByb2dyYW1taW5nIGxhbmd1YWdlXG4gKiBtb2RlbCAodGVsbGluZyB0aGUgZGlmZmVyZW5jZSBiZXR3ZWVuIGFic2VuY2UgYW5kIGFuIGVtcHR5IGFycmF5KVxuICpcbiAqIC0gQW4gZW1wdHkgYXJyYXkgaXMgdGhlIGRlZmF1bHQgY2FzZSwgbWVhbmluZyB0aGUgdXNlciBkaWRuJ3QgcGFzcyBhbnkgYXJndW1lbnRzLiBXZSByZXR1cm5cbiAqICAgdW5kZWZpbmVkLlxuICogLSBJZiB0aGUgdXNlciBwYXNzZWQgYSBzaW5nbGUgZW1wdHkgc3RyaW5nLCB0aGV5IGRpZCBzb21ldGhpbmcgbGlrZSBgLS1hcnJheT1gLCB3aGljaCB3ZSdsbFxuICogICB0YWtlIHRvIG1lYW4gdGhleSBwYXNzZWQgYW4gZW1wdHkgYXJyYXkuXG4gKi9cbmZ1bmN0aW9uIGFycmF5RnJvbVlhcmdzKHhzOiBzdHJpbmdbXSk6IHN0cmluZ1tdIHwgdW5kZWZpbmVkIHtcbiAgaWYgKHhzLmxlbmd0aCA9PT0gMCkge1xuICAgIHJldHVybiB1bmRlZmluZWQ7XG4gIH1cbiAgcmV0dXJuIHhzLmZpbHRlcigoeCkgPT4geCAhPT0gJycpO1xufVxuXG5mdW5jdGlvbiB5YXJnc05lZ2F0aXZlQWxpYXM8VCBleHRlbmRzIHsgW3ggaW4gUyB8IExdOiBib29sZWFuIHwgdW5kZWZpbmVkIH0sIFMgZXh0ZW5kcyBzdHJpbmcsIEwgZXh0ZW5kcyBzdHJpbmc+KFxuICBzaG9ydE5hbWU6IFMsXG4gIGxvbmdOYW1lOiBMLFxuKTogKGFyZ3Y6IFQpID0+IFQge1xuICByZXR1cm4gKGFyZ3Y6IFQpID0+IHtcbiAgICBpZiAoc2hvcnROYW1lIGluIGFyZ3YgJiYgYXJndltzaG9ydE5hbWVdKSB7XG4gICAgICAoYXJndiBhcyBhbnkpW2xvbmdOYW1lXSA9IGZhbHNlO1xuICAgIH1cbiAgICByZXR1cm4gYXJndjtcbiAgfTtcbn1cblxuZnVuY3Rpb24gZGV0ZXJtaW5lSG90c3dhcE1vZGUoaG90c3dhcD86IGJvb2xlYW4sIGhvdHN3YXBGYWxsYmFjaz86IGJvb2xlYW4sIHdhdGNoPzogYm9vbGVhbik6IEhvdHN3YXBNb2RlIHtcbiAgaWYgKGhvdHN3YXAgJiYgaG90c3dhcEZhbGxiYWNrKSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKCdDYW4gbm90IHN1cHBseSBib3RoIC0taG90c3dhcCBhbmQgLS1ob3Rzd2FwLWZhbGxiYWNrIGF0IHRoZSBzYW1lIHRpbWUnKTtcbiAgfSBlbHNlIGlmICghaG90c3dhcCAmJiAhaG90c3dhcEZhbGxiYWNrKSB7XG4gICAgaWYgKGhvdHN3YXAgPT09IHVuZGVmaW5lZCAmJiBob3Rzd2FwRmFsbGJhY2sgPT09IHVuZGVmaW5lZCkge1xuICAgICAgcmV0dXJuIHdhdGNoID8gSG90c3dhcE1vZGUuSE9UU1dBUF9PTkxZIDogSG90c3dhcE1vZGUuRlVMTF9ERVBMT1lNRU5UO1xuICAgIH0gZWxzZSBpZiAoaG90c3dhcCA9PT0gZmFsc2UgfHwgaG90c3dhcEZhbGxiYWNrID09PSBmYWxzZSkge1xuICAgICAgcmV0dXJuIEhvdHN3YXBNb2RlLkZVTExfREVQTE9ZTUVOVDtcbiAgICB9XG4gIH1cblxuICBsZXQgaG90c3dhcE1vZGU6IEhvdHN3YXBNb2RlO1xuICBpZiAoaG90c3dhcCkge1xuICAgIGhvdHN3YXBNb2RlID0gSG90c3dhcE1vZGUuSE9UU1dBUF9PTkxZO1xuICAvKmlmIChob3Rzd2FwRmFsbGJhY2spKi9cbiAgfSBlbHNlIHtcbiAgICBob3Rzd2FwTW9kZSA9IEhvdHN3YXBNb2RlLkZBTExfQkFDSztcbiAgfVxuXG4gIHJldHVybiBob3Rzd2FwTW9kZTtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIGNsaShhcmdzOiBzdHJpbmdbXSA9IHByb2Nlc3MuYXJndi5zbGljZSgyKSkge1xuICBleGVjKGFyZ3MpXG4gICAgLnRoZW4oYXN5bmMgKHZhbHVlKSA9PiB7XG4gICAgICBpZiAodHlwZW9mIHZhbHVlID09PSAnbnVtYmVyJykge1xuICAgICAgICBwcm9jZXNzLmV4aXRDb2RlID0gdmFsdWU7XG4gICAgICB9XG4gICAgfSlcbiAgICAuY2F0Y2goKGVycikgPT4ge1xuICAgICAgZXJyb3IoZXJyLm1lc3NhZ2UpO1xuICAgICAgaWYgKGVyci5zdGFjaykge1xuICAgICAgICBkZWJ1ZyhlcnIuc3RhY2spO1xuICAgICAgfVxuICAgICAgcHJvY2Vzcy5leGl0Q29kZSA9IDE7XG4gICAgfSk7XG59XG4iXX0=