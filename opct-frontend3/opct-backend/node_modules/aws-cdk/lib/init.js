"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.InitTemplate = void 0;
exports.cliInit = cliInit;
exports.availableInitTemplates = availableInitTemplates;
exports.availableInitLanguages = availableInitLanguages;
exports.printAvailableTemplates = printAvailableTemplates;
const childProcess = require("child_process");
const path = require("path");
const cxapi = require("@aws-cdk/cx-api");
const chalk = require("chalk");
const fs = require("fs-extra");
const init_hooks_1 = require("./init-hooks");
const logging_1 = require("./logging");
const directories_1 = require("./util/directories");
const version_range_1 = require("./util/version-range");
/* eslint-disable @typescript-eslint/no-var-requires */ // Packages don't have @types module
// eslint-disable-next-line @typescript-eslint/no-require-imports
const camelCase = require('camelcase');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const decamelize = require('decamelize');
/**
 * Initialize a CDK package in the current directory
 */
async function cliInit(options) {
    const canUseNetwork = options.canUseNetwork ?? true;
    const generateOnly = options.generateOnly ?? false;
    const workDir = options.workDir ?? process.cwd();
    if (!options.type && !options.language) {
        await printAvailableTemplates();
        return;
    }
    const type = options.type || 'default'; // "default" is the default type (and maps to "app")
    const template = (await availableInitTemplates()).find((t) => t.hasName(type));
    if (!template) {
        await printAvailableTemplates(options.language);
        throw new Error(`Unknown init template: ${type}`);
    }
    if (!options.language && template.languages.length === 1) {
        const language = template.languages[0];
        (0, logging_1.warning)(`No --language was provided, but '${type}' supports only '${language}', so defaulting to --language=${language}`);
    }
    if (!options.language) {
        (0, logging_1.print)(`Available languages for ${chalk.green(type)}: ${template.languages.map((l) => chalk.blue(l)).join(', ')}`);
        throw new Error('No language was selected');
    }
    await initializeProject(template, options.language, canUseNetwork, generateOnly, workDir, options.stackName, options.migrate);
}
/**
 * Returns the name of the Python executable for this OS
 */
function pythonExecutable() {
    let python = 'python3';
    if (process.platform === 'win32') {
        python = 'python';
    }
    return python;
}
const INFO_DOT_JSON = 'info.json';
class InitTemplate {
    static async fromName(templatesDir, name) {
        const basePath = path.join(templatesDir, name);
        const languages = await listDirectory(basePath);
        const info = await fs.readJson(path.join(basePath, INFO_DOT_JSON));
        return new InitTemplate(basePath, name, languages, info);
    }
    constructor(basePath, name, languages, info) {
        this.basePath = basePath;
        this.name = name;
        this.languages = languages;
        this.aliases = new Set();
        this.description = info.description;
        for (const alias of info.aliases || []) {
            this.aliases.add(alias);
        }
    }
    /**
     * @param name the name that is being checked
     * @returns ``true`` if ``name`` is the name of this template or an alias of it.
     */
    hasName(name) {
        return name === this.name || this.aliases.has(name);
    }
    /**
     * Creates a new instance of this ``InitTemplate`` for a given language to a specified folder.
     *
     * @param language    the language to instantiate this template with
     * @param targetDirectory the directory where the template is to be instantiated into
     */
    async install(language, targetDirectory, stackName) {
        if (this.languages.indexOf(language) === -1) {
            (0, logging_1.error)(`The ${chalk.blue(language)} language is not supported for ${chalk.green(this.name)} ` +
                `(it supports: ${this.languages.map((l) => chalk.blue(l)).join(', ')})`);
            throw new Error(`Unsupported language: ${language}`);
        }
        const projectInfo = {
            name: decamelize(path.basename(path.resolve(targetDirectory))),
            stackName,
        };
        const sourceDirectory = path.join(this.basePath, language);
        await this.installFiles(sourceDirectory, targetDirectory, language, projectInfo);
        await this.applyFutureFlags(targetDirectory);
        await (0, init_hooks_1.invokeBuiltinHooks)({ targetDirectory, language, templateName: this.name }, {
            substitutePlaceholdersIn: async (...fileNames) => {
                for (const fileName of fileNames) {
                    const fullPath = path.join(targetDirectory, fileName);
                    const template = await fs.readFile(fullPath, { encoding: 'utf-8' });
                    await fs.writeFile(fullPath, this.expand(template, language, projectInfo));
                }
            },
            placeholder: (ph) => this.expand(`%${ph}%`, language, projectInfo),
        });
    }
    async installFiles(sourceDirectory, targetDirectory, language, project) {
        for (const file of await fs.readdir(sourceDirectory)) {
            const fromFile = path.join(sourceDirectory, file);
            const toFile = path.join(targetDirectory, this.expand(file, language, project));
            if ((await fs.stat(fromFile)).isDirectory()) {
                await fs.mkdir(toFile);
                await this.installFiles(fromFile, toFile, language, project);
                continue;
            }
            else if (file.match(/^.*\.template\.[^.]+$/)) {
                await this.installProcessed(fromFile, toFile.replace(/\.template(\.[^.]+)$/, '$1'), language, project);
                continue;
            }
            else if (file.match(/^.*\.hook\.(d.)?[^.]+$/)) {
                // Ignore
                continue;
            }
            else {
                await fs.copy(fromFile, toFile);
            }
        }
    }
    async installProcessed(templatePath, toFile, language, project) {
        const template = await fs.readFile(templatePath, { encoding: 'utf-8' });
        await fs.writeFile(toFile, this.expand(template, language, project));
    }
    expand(template, language, project) {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const manifest = require(path.join((0, directories_1.rootDir)(), 'package.json'));
        const MATCH_VER_BUILD = /\+[a-f0-9]+$/; // Matches "+BUILD" in "x.y.z-beta+BUILD"
        const cdkVersion = manifest.version.replace(MATCH_VER_BUILD, '');
        let constructsVersion = manifest.devDependencies.constructs.replace(MATCH_VER_BUILD, '');
        switch (language) {
            case 'java':
            case 'csharp':
            case 'fsharp':
                constructsVersion = (0, version_range_1.rangeFromSemver)(constructsVersion, 'bracket');
                break;
            case 'python':
                constructsVersion = (0, version_range_1.rangeFromSemver)(constructsVersion, 'pep');
                break;
        }
        return template
            .replace(/%name%/g, project.name)
            .replace(/%stackname%/, project.stackName ?? '%name.PascalCased%Stack')
            .replace(/%PascalNameSpace%/, project.stackName ? camelCase(project.stackName + 'Stack', { pascalCase: true }) : '%name.PascalCased%')
            .replace(/%PascalStackProps%/, project.stackName ? camelCase(project.stackName, { pascalCase: true }) + 'StackProps' : 'StackProps')
            .replace(/%name\.camelCased%/g, camelCase(project.name))
            .replace(/%name\.PascalCased%/g, camelCase(project.name, { pascalCase: true }))
            .replace(/%cdk-version%/g, cdkVersion)
            .replace(/%constructs-version%/g, constructsVersion)
            .replace(/%cdk-home%/g, (0, directories_1.cdkHomeDir)())
            .replace(/%name\.PythonModule%/g, project.name.replace(/-/g, '_'))
            .replace(/%python-executable%/g, pythonExecutable())
            .replace(/%name\.StackName%/g, project.name.replace(/[^A-Za-z0-9-]/g, '-'));
    }
    /**
     * Adds context variables to `cdk.json` in the generated project directory to
     * enable future behavior for new projects.
     */
    async applyFutureFlags(projectDir) {
        const cdkJson = path.join(projectDir, 'cdk.json');
        if (!(await fs.pathExists(cdkJson))) {
            return;
        }
        const config = await fs.readJson(cdkJson);
        config.context = {
            ...config.context,
            ...cxapi.NEW_PROJECT_CONTEXT,
        };
        await fs.writeJson(cdkJson, config, { spaces: 2 });
    }
    async addMigrateContext(projectDir) {
        const cdkJson = path.join(projectDir, 'cdk.json');
        if (!(await fs.pathExists(cdkJson))) {
            return;
        }
        const config = await fs.readJson(cdkJson);
        config.context = {
            ...config.context,
            'cdk-migrate': true,
        };
        await fs.writeJson(cdkJson, config, { spaces: 2 });
    }
}
exports.InitTemplate = InitTemplate;
async function availableInitTemplates() {
    return new Promise(async (resolve) => {
        try {
            const templatesDir = path.join((0, directories_1.rootDir)(), 'lib', 'init-templates');
            const templateNames = await listDirectory(templatesDir);
            const templates = new Array();
            for (const templateName of templateNames) {
                templates.push(await InitTemplate.fromName(templatesDir, templateName));
            }
            resolve(templates);
        }
        catch {
            resolve([]);
        }
    });
}
async function availableInitLanguages() {
    return new Promise(async (resolve) => {
        const templates = await availableInitTemplates();
        const result = new Set();
        for (const template of templates) {
            for (const language of template.languages) {
                result.add(language);
            }
        }
        resolve([...result]);
    });
}
/**
 * @param dirPath is the directory to be listed.
 * @returns the list of file or directory names contained in ``dirPath``, excluding any dot-file, and sorted.
 */
async function listDirectory(dirPath) {
    return ((await fs.readdir(dirPath))
        .filter((p) => !p.startsWith('.'))
        .filter((p) => !(p === 'LICENSE'))
        // if, for some reason, the temp folder for the hook doesn't get deleted we don't want to display it in this list
        .filter((p) => !(p === INFO_DOT_JSON))
        .sort());
}
async function printAvailableTemplates(language) {
    (0, logging_1.print)('Available templates:');
    for (const template of await availableInitTemplates()) {
        if (language && template.languages.indexOf(language) === -1) {
            continue;
        }
        (0, logging_1.print)(`* ${chalk.green(template.name)}: ${template.description}`);
        const languageArg = language
            ? chalk.bold(language)
            : template.languages.length > 1
                ? `[${template.languages.map((t) => chalk.bold(t)).join('|')}]`
                : chalk.bold(template.languages[0]);
        (0, logging_1.print)(`   └─ ${chalk.blue(`cdk init ${chalk.bold(template.name)} --language=${languageArg}`)}`);
    }
}
async function initializeProject(template, language, canUseNetwork, generateOnly, workDir, stackName, migrate) {
    await assertIsEmptyDirectory(workDir);
    (0, logging_1.print)(`Applying project template ${chalk.green(template.name)} for ${chalk.blue(language)}`);
    await template.install(language, workDir, stackName);
    if (migrate) {
        await template.addMigrateContext(workDir);
    }
    if (await fs.pathExists('README.md')) {
        const readme = await fs.readFile('README.md', { encoding: 'utf-8' });
        // Save the logs!
        // Without this statement, the readme of the CLI is printed in every init test
        if (!readme.startsWith('# AWS CDK Toolkit')) {
            (0, logging_1.print)(chalk.green(readme));
        }
    }
    if (!generateOnly) {
        await initializeGitRepository(workDir);
        await postInstall(language, canUseNetwork, workDir);
    }
    (0, logging_1.print)('✅ All done!');
}
async function assertIsEmptyDirectory(workDir) {
    const files = await fs.readdir(workDir);
    if (files.filter((f) => !f.startsWith('.')).length !== 0) {
        throw new Error('`cdk init` cannot be run in a non-empty directory!');
    }
}
async function initializeGitRepository(workDir) {
    if (await isInGitRepository(workDir)) {
        return;
    }
    (0, logging_1.print)('Initializing a new git repository...');
    try {
        await execute('git', ['init'], { cwd: workDir });
        await execute('git', ['add', '.'], { cwd: workDir });
        await execute('git', ['commit', '--message="Initial commit"', '--no-gpg-sign'], { cwd: workDir });
    }
    catch {
        (0, logging_1.warning)('Unable to initialize git repository for your project.');
    }
}
async function postInstall(language, canUseNetwork, workDir) {
    switch (language) {
        case 'javascript':
            return postInstallJavascript(canUseNetwork, workDir);
        case 'typescript':
            return postInstallTypescript(canUseNetwork, workDir);
        case 'java':
            return postInstallJava(canUseNetwork, workDir);
        case 'python':
            return postInstallPython(workDir);
    }
}
async function postInstallJavascript(canUseNetwork, cwd) {
    return postInstallTypescript(canUseNetwork, cwd);
}
async function postInstallTypescript(canUseNetwork, cwd) {
    const command = 'npm';
    if (!canUseNetwork) {
        (0, logging_1.warning)(`Please run '${command} install'!`);
        return;
    }
    (0, logging_1.print)(`Executing ${chalk.green(`${command} install`)}...`);
    try {
        await execute(command, ['install'], { cwd });
    }
    catch (e) {
        (0, logging_1.warning)(`${command} install failed: ` + e.message);
    }
}
async function postInstallJava(canUseNetwork, cwd) {
    const mvnPackageWarning = "Please run 'mvn package'!";
    if (!canUseNetwork) {
        (0, logging_1.warning)(mvnPackageWarning);
        return;
    }
    (0, logging_1.print)("Executing 'mvn package'");
    try {
        await execute('mvn', ['package'], { cwd });
    }
    catch {
        (0, logging_1.warning)('Unable to package compiled code as JAR');
        (0, logging_1.warning)(mvnPackageWarning);
    }
}
async function postInstallPython(cwd) {
    const python = pythonExecutable();
    (0, logging_1.warning)(`Please run '${python} -m venv .venv'!`);
    (0, logging_1.print)(`Executing ${chalk.green('Creating virtualenv...')}`);
    try {
        await execute(python, ['-m venv', '.venv'], { cwd });
    }
    catch {
        (0, logging_1.warning)('Unable to create virtualenv automatically');
        (0, logging_1.warning)(`Please run '${python} -m venv .venv'!`);
    }
}
/**
 * @param dir a directory to be checked
 * @returns true if ``dir`` is within a git repository.
 */
async function isInGitRepository(dir) {
    while (true) {
        if (await fs.pathExists(path.join(dir, '.git'))) {
            return true;
        }
        if (isRoot(dir)) {
            return false;
        }
        dir = path.dirname(dir);
    }
}
/**
 * @param dir a directory to be checked.
 * @returns true if ``dir`` is the root of a filesystem.
 */
function isRoot(dir) {
    return path.dirname(dir) === dir;
}
/**
 * Executes `command`. STDERR is emitted in real-time.
 *
 * If command exits with non-zero exit code, an exceprion is thrown and includes
 * the contents of STDOUT.
 *
 * @returns STDOUT (if successful).
 */
async function execute(cmd, args, { cwd }) {
    const child = childProcess.spawn(cmd, args, {
        cwd,
        shell: true,
        stdio: ['ignore', 'pipe', 'inherit'],
    });
    let stdout = '';
    child.stdout.on('data', (chunk) => (stdout += chunk.toString()));
    return new Promise((ok, fail) => {
        child.once('error', (err) => fail(err));
        child.once('exit', (status) => {
            if (status === 0) {
                return ok(stdout);
            }
            else {
                process.stderr.write(stdout);
                return fail(new Error(`${cmd} exited with status ${status}`));
            }
        });
    });
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiaW5pdC5qcyIsInNvdXJjZVJvb3QiOiIiLCJzb3VyY2VzIjpbImluaXQudHMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6Ijs7O0FBNkJBLDBCQW9DQztBQTJMRCx3REFjQztBQUNELHdEQVdDO0FBaUJELDBEQWNDO0FBclRELDhDQUE4QztBQUM5Qyw2QkFBNkI7QUFDN0IseUNBQXlDO0FBQ3pDLCtCQUErQjtBQUMvQiwrQkFBK0I7QUFDL0IsNkNBQWtEO0FBQ2xELHVDQUFrRDtBQUNsRCxvREFBeUQ7QUFDekQsd0RBQXVEO0FBRXZELHVEQUF1RCxDQUFDLG9DQUFvQztBQUM1RixpRUFBaUU7QUFDakUsTUFBTSxTQUFTLEdBQUcsT0FBTyxDQUFDLFdBQVcsQ0FBQyxDQUFDO0FBQ3ZDLGlFQUFpRTtBQUNqRSxNQUFNLFVBQVUsR0FBRyxPQUFPLENBQUMsWUFBWSxDQUFDLENBQUM7QUFZekM7O0dBRUc7QUFDSSxLQUFLLFVBQVUsT0FBTyxDQUFDLE9BQXVCO0lBQ25ELE1BQU0sYUFBYSxHQUFHLE9BQU8sQ0FBQyxhQUFhLElBQUksSUFBSSxDQUFDO0lBQ3BELE1BQU0sWUFBWSxHQUFHLE9BQU8sQ0FBQyxZQUFZLElBQUksS0FBSyxDQUFDO0lBQ25ELE1BQU0sT0FBTyxHQUFHLE9BQU8sQ0FBQyxPQUFPLElBQUksT0FBTyxDQUFDLEdBQUcsRUFBRSxDQUFDO0lBQ2pELElBQUksQ0FBQyxPQUFPLENBQUMsSUFBSSxJQUFJLENBQUMsT0FBTyxDQUFDLFFBQVEsRUFBRSxDQUFDO1FBQ3ZDLE1BQU0sdUJBQXVCLEVBQUUsQ0FBQztRQUNoQyxPQUFPO0lBQ1QsQ0FBQztJQUVELE1BQU0sSUFBSSxHQUFHLE9BQU8sQ0FBQyxJQUFJLElBQUksU0FBUyxDQUFDLENBQUMsb0RBQW9EO0lBRTVGLE1BQU0sUUFBUSxHQUFHLENBQUMsTUFBTSxzQkFBc0IsRUFBRSxDQUFDLENBQUMsSUFBSSxDQUFDLENBQUMsQ0FBQyxFQUFFLEVBQUUsQ0FBQyxDQUFDLENBQUMsT0FBTyxDQUFDLElB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Z0JBQ2pCLE9BQU8sRUFBRSxDQUFDLE1BQU0sQ0FBQyxDQUFDO1lBQ3BCLENBQUM7aUJBQU0sQ0FBQztnQkFDTixPQUFPLENBQUMsTUFBTSxDQUFDLEtBQUssQ0FBQyxNQUFNLENBQUMsQ0FBQztnQkFDN0IsT0FBTyxJQUFJLENBQUMsSUFBSSxLQUFLLENBQUMsR0FBRyxHQUFHLHVCQUF1QixNQUFNLEVBQUUsQ0FBQyxDQUFDLENBQUM7WUFDaEUsQ0FBQztRQUNILENBQUMsQ0FBQyxDQUFDO0lBQ0wsQ0FBQyxDQUFDLENBQUM7QUFDTCxDQUFDIiwic291cmNlc0NvbnRlbnQiOlsiaW1wb3J0ICogYXMgY2hpbGRQcm9jZXNzIGZyb20gJ2NoaWxkX3Byb2Nlc3MnO1xuaW1wb3J0ICogYXMgcGF0aCBmcm9tICdwYXRoJztcbmltcG9ydCAqIGFzIGN4YXBpIGZyb20gJ0Bhd3MtY2RrL2N4LWFwaSc7XG5pbXBvcnQgKiBhcyBjaGFsayBmcm9tICdjaGFsayc7XG5pbXBvcnQgKiBhcyBmcyBmcm9tICdmcy1leHRyYSc7XG5pbXBvcnQgeyBpbnZva2VCdWlsdGluSG9va3MgfSBmcm9tICcuL2luaXQtaG9va3MnO1xuaW1wb3J0IHsgZXJyb3IsIHByaW50LCB3YXJuaW5nIH0gZnJvbSAnLi9sb2dnaW5nJztcbmltcG9ydCB7IGNka0hvbWVEaXIsIHJvb3REaXIgfSBmcm9tICcuL3V0aWwvZGlyZWN0b3JpZXMnO1xuaW1wb3J0IHsgcmFuZ2VGcm9tU2VtdmVyIH0gZnJvbSAnLi91dGlsL3ZlcnNpb24tcmFuZ2UnO1xuXG4vKiBlc2xpbnQtZGlzYWJsZSBAdHlwZXNjcmlwdC1lc2xpbnQvbm8tdmFyLXJlcXVpcmVzICovIC8vIFBhY2thZ2VzIGRvbid0IGhhdmUgQHR5cGVzIG1vZHVsZVxuLy8gZXNsaW50LWRpc2FibGUtbmV4dC1saW5lIEB0eXBlc2NyaXB0LWVzbGludC9uby1yZXF1aXJlLWltcG9ydHNcbmNvbnN0IGNhbWVsQ2FzZSA9IHJlcXVpcmUoJ2NhbWVsY2FzZScpO1xuLy8gZXNsaW50LWRpc2FibGUtbmV4dC1saW5lIEB0eXBlc2NyaXB0LWVzbGludC9uby1yZXF1aXJlLWltcG9ydHNcbmNvbnN0IGRlY2FtZWxpemUgPSByZXF1aXJlKCdkZWNhbWVsaXplJyk7XG5cbmV4cG9ydCBpbnRlcmZhY2UgQ2xpSW5pdE9wdGlvbnMge1xuICByZWFkb25seSB0eXBlPzogc3RyaW5nO1xuICByZWFkb25seSBsYW5ndWFnZT86IHN0cmluZztcbiAgcmVhZG9ubHkgY2FuVXNlTmV0d29yaz86IGJvb2xlYW47XG4gIHJlYWRvbmx5IGdlbmVyYXRlT25seT86IGJvb2xlYW47XG4gIHJlYWRvbmx5IHdvcmtEaXI/OiBzdHJpbmc7XG4gIHJlYWRvbmx5IHN0YWNrTmFtZT86IHN0cmluZztcbiAgcmVhZG9ubHkgbWlncmF0ZT86IGJvb2xlYW47XG59XG5cbi8qKlxuICogSW5pdGlhbGl6ZSBhIENESyBwYWNrYWdlIGluIHRoZSBjdXJyZW50IGRpcmVjdG9yeVxuICovXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gY2xpSW5pdChvcHRpb25zOiBDbGlJbml0T3B0aW9ucykge1xuICBjb25zdCBjYW5Vc2VOZXR3b3JrID0gb3B0aW9ucy5jYW5Vc2VOZXR3b3JrID8/IHRydWU7XG4gIGNvbnN0IGdlbmVyYXRlT25seSA9IG9wdGlvbnMuZ2VuZXJhdGVPbmx5ID8/IGZhbHNlO1xuICBjb25zdCB3b3JrRGlyID0gb3B0aW9ucy53b3JrRGlyID8/IHByb2Nlc3MuY3dkKCk7XG4gIGlmICghb3B0aW9ucy50eXBlICYmICFvcHRpb25zLmxhbmd1YWdlKSB7XG4gICAgYXdhaXQgcHJpbnRBdmFpbGFibGVUZW1wbGF0ZXMoKTtcbiAgICByZXR1cm47XG4gIH1cblxuICBjb25zdCB0eXBlID0gb3B0aW9ucy50eXBlIHx8ICdkZWZhdWx0JzsgLy8gXCJkZWZhdWx0XCIgaXMgdGhlIGRlZmF1bHQgdHlwZSAoYW5kIG1hcHMgdG8gXCJhcHBcIilcblxuICBjb25zdCB0ZW1wbGF0ZSA9IChhd2FpdCBhdmFpbGFibGVJbml0VGVtcGxhdGVzKCkpLmZpbmQoKHQpID0+IHQuaGFzTmFtZSh0eXBlISkpO1xuICBpZiAoIXRlbXBsYXRlKSB7XG4gICAgYXdhaXQgcHJpbnRBdmFpbGFibGVUZW1wbGF0ZXMob3B0aW9ucy5sYW5ndWFnZSk7XG4gICAgdGhyb3cgbmV3IEVycm9yKGBVbmtub3duIGluaXQgdGVtcGxhdGU6ICR7dHlwZX1gKTtcbiAgfVxuICBpZiAoIW9wdGlvbnMubGFuZ3VhZ2UgJiYgdGVtcGxhdGUubGFuZ3VhZ2VzLmxlbmd0aCA9PT0gMSkge1xuICAgIGNvbnN0IGxhbmd1YWdlID0gdGVtcGxhdGUubGFuZ3VhZ2VzWzBdO1xuICAgIHdhcm5pbmcoXG4gICAgICBgTm8gLS1sYW5ndWFnZSB3YXMgcHJvdmlkZWQsIGJ1dCAnJHt0eXBlfScgc3VwcG9ydHMgb25seSAnJHtsYW5ndWFnZX0nLCBzbyBkZWZhdWx0aW5nIHRvIC0tbGFuZ3VhZ2U9JHtsYW5ndWFnZX1gLFxuICAgICk7XG4gIH1cbiAgaWYgKCFvcHRpb25zLmxhbmd1YWdlKSB7XG4gICAgcHJpbnQoYEF2YWlsYWJsZSBsYW5ndWFnZXMgZm9yICR7Y2hhbGsuZ3JlZW4odHlwZSl9OiAke3RlbXBsYXRlLmxhbmd1YWdlcy5tYXAoKGwpID0+IGNoYWxrLmJsdWUobCkpLmpvaW4oJywgJyl9YCk7XG4gICAgdGhyb3cgbmV3IEVycm9yKCdObyBsYW5ndWFnZSB3YXMgc2VsZWN0ZWQnKTtcbiAgfVxuXG4gIGF3YWl0IGluaXRpYWxpemVQcm9qZWN0KFxuICAgIHRlbXBsYXRlLFxuICAgIG9wdGlvbnMubGFuZ3VhZ2UsXG4gICAgY2FuVXNlTmV0d29yayxcbiAgICBnZW5lcmF0ZU9ubHksXG4gICAgd29ya0RpcixcbiAgICBvcHRpb25zLnN0YWNrTmFtZSxcbiAgICBvcHRpb25zLm1pZ3JhdGUsXG4gICk7XG59XG5cbi8qKlxuICogUmV0dXJucyB0aGUgbmFtZSBvZiB0aGUgUHl0aG9uIGV4ZWN1dGFibGUgZm9yIHRoaXMgT1NcbiAqL1xuZnVuY3Rpb24gcHl0aG9uRXhlY3V0YWJsZSgpIHtcbiAgbGV0IHB5dGhvbiA9ICdweXRob24zJztcbiAgaWYgKHByb2Nlc3MucGxhdGZvcm0gPT09ICd3aW4zMicpIHtcbiAgICBweXRob24gPSAncHl0aG9uJztcbiAgfVxuICByZXR1cm4gcHl0aG9uO1xufVxuY29uc3QgSU5GT19ET1RfSlNPTiA9ICdpbmZvLmpzb24nO1xuXG5leHBvcnQgY2xhc3MgSW5pdFRlbXBsYXRlIHtcbiAgcHVibGljIHN0YXRpYyBhc3luYyBmcm9tTmFtZSh0ZW1wbGF0ZXNEaXI6IHN0cmluZywgbmFtZTogc3RyaW5nKSB7XG4gICAgY29uc3QgYmFzZVBhdGggPSBwYXRoLmpvaW4odGVtcGxhdGVzRGlyLCBuYW1lKTtcbiAgICBjb25zdCBsYW5ndWFnZXMgPSBhd2FpdCBsaXN0RGlyZWN0b3J5KGJhc2VQYXRoKTtcbiAgICBjb25zdCBpbmZvID0gYXdhaXQgZnMucmVhZEpzb24ocGF0aC5qb2luKGJhc2VQYXRoLCBJTkZPX0RPVF9KU09OKSk7XG4gICAgcmV0dXJuIG5ldyBJbml0VGVtcGxhdGUoYmFzZVBhdGgsIG5hbWUsIGxhbmd1YWdlcywgaW5mbyk7XG4gIH1cblxuICBwdWJsaWMgcmVhZG9ubHkgZGVzY3JpcHRpb246IHN0cmluZztcbiAgcHVibGljIHJlYWRvbmx5IGFsaWFzZXMgPSBuZXcgU2V0PHN0cmluZz4oKTtcblxuICBjb25zdHJ1Y3RvcihcbiAgICBwcml2YXRlIHJlYWRvbmx5IGJhc2VQYXRoOiBzdHJpbmcsXG4gICAgcHVibGljIHJlYWRvbmx5IG5hbWU6IHN0cmluZyxcbiAgICBwdWJsaWMgcmVhZG9ubHkgbGFuZ3VhZ2VzOiBzdHJpbmdbXSxcbiAgICBpbmZvOiBhbnksXG4gICkge1xuICAgIHRoaXMuZGVzY3JpcHRpb24gPSBpbmZvLmRlc2NyaXB0aW9uO1xuICAgIGZvciAoY29uc3QgYWxpYXMgb2YgaW5mby5hbGlhc2VzIHx8IFtdKSB7XG4gICAgICB0aGlzLmFsaWFzZXMuYWRkKGFsaWFzKTtcbiAgICB9XG4gIH1cblxuICAvKipcbiAgICogQHBhcmFtIG5hbWUgdGhlIG5hbWUgdGhhdCBpcyBiZWluZyBjaGVja2VkXG4gICAqIEByZXR1cm5zIGBgdHJ1ZWBgIGlmIGBgbmFtZWBgIGlzIHRoZSBuYW1lIG9mIHRoaXMgdGVtcGxhdGUgb3IgYW4gYWxpYXMgb2YgaXQuXG4gICAqL1xuICBwdWJsaWMgaGFzTmFtZShuYW1lOiBzdHJpbmcpOiBib29sZWFuIHtcbiAgICByZXR1cm4gbmFtZSA9PT0gdGhpcy5uYW1lIHx8IHRoaXMuYWxpYXNlcy5oYXMobmFtZSk7XG4gIH1cblxuICAvKipcbiAgICogQ3JlYXRlcyBhIG5ldyBpbnN0YW5jZSBvZiB0aGlzIGBgSW5pdFRlbXBsYXRlYGAgZm9yIGEgZ2l2ZW4gbGFuZ3VhZ2UgdG8gYSBzcGVjaWZpZWQgZm9sZGVyLlxuICAgKlxuICAgKiBAcGFyYW0gbGFuZ3VhZ2UgICAgdGhlIGxhbmd1YWdlIHRvIGluc3RhbnRpYXRlIHRoaXMgdGVtcGxhdGUgd2l0aFxuICAgKiBAcGFyYW0gdGFyZ2V0RGlyZWN0b3J5IHRoZSBkaXJlY3Rvcnkgd2hlcmUgdGhlIHRlbXBsYXRlIGlzIHRvIGJlIGluc3RhbnRpYXRlZCBpbnRvXG4gICAqL1xuICBwdWJsaWMgYXN5bmMgaW5zdGFsbChsYW5ndWFnZTogc3RyaW5nLCB0YXJnZXREaXJlY3Rvcnk6IHN0cmluZywgc3RhY2tOYW1lPzogc3RyaW5nKSB7XG4gICAgaWYgKHRoaXMubGFuZ3VhZ2VzLmluZGV4T2YobGFuZ3VhZ2UpID09PSAtMSkge1xuICAgICAgZXJyb3IoXG4gICAgICAgIGBUaGUgJHtjaGFsay5ibHVlKGxhbmd1YWdlKX0gbGFuZ3VhZ2UgaXMgbm90IHN1cHBvcnRlZCBmb3IgJHtjaGFsay5ncmVlbih0aGlzLm5hbWUpfSBgICtcbiAgICAgICAgICBgKGl0IHN1cHBvcnRzOiAke3RoaXMubGFuZ3VhZ2VzLm1hcCgobCkgPT4gY2hhbGsuYmx1ZShsKSkuam9pbignLCAnKX0pYCxcbiAgICAgICk7XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoYFVuc3VwcG9ydGVkIGxhbmd1YWdlOiAke2xhbmd1YWdlfWApO1xuICAgIH1cblxuICAgIGNvbnN0IHByb2plY3RJbmZvOiBQcm9qZWN0SW5mbyA9IHtcbiAgICAgIG5hbWU6IGRlY2FtZWxpemUocGF0aC5iYXNlbmFtZShwYXRoLnJlc29sdmUodGFyZ2V0RGlyZWN0b3J5KSkpLFxuICAgICAgc3RhY2tOYW1lLFxuICAgIH07XG5cbiAgICBjb25zdCBzb3VyY2VEaXJlY3RvcnkgPSBwYXRoLmpvaW4odGhpcy5iYXNlUGF0aCwgbGFuZ3VhZ2UpO1xuXG4gICAgYXdhaXQgdGhpcy5pbnN0YWxsRmlsZXMoc291cmNlRGlyZWN0b3J5LCB0YXJnZXREaXJlY3RvcnksIGxhbmd1YWdlLCBwcm9qZWN0SW5mbyk7XG4gICAgYXdhaXQgdGhpcy5hcHBseUZ1dHVyZUZsYWdzKHRhcmdldERpcmVjdG9yeSk7XG4gICAgYXdhaXQgaW52b2tlQnVpbHRpbkhvb2tzKFxuICAgICAgeyB0YXJnZXREaXJlY3RvcnksIGxhbmd1YWdlLCB0ZW1wbGF0ZU5hbWU6IHRoaXMubmFtZSB9LFxuICAgICAge1xuICAgICAgICBzdWJzdGl0dXRlUGxhY2Vob2xkZXJzSW46IGFzeW5jICguLi5maWxlTmFtZXM6IHN0cmluZ1tdKSA9PiB7XG4gICAgICAgICAgZm9yIChjb25zdCBmaWxlTmFtZSBvZiBmaWxlTmFtZXMpIHtcbiAgICAgICAgICAgIGNvbnN0IGZ1bGxQYXRoID0gcGF0aC5qb2luKHRhcmdldERpcmVjdG9yeSwgZmlsZU5hbWUpO1xuICAgICAgICAgICAgY29uc3QgdGVtcGxhdGUgPSBhd2FpdCBmcy5yZWFkRmlsZShmdWxsUGF0aCwgeyBlbmNvZGluZzogJ3V0Zi04JyB9KTtcbiAgICAgICAgICAgIGF3YWl0IGZzLndyaXRlRmlsZShmdWxsUGF0aCwgdGhpcy5leHBhbmQodGVtcGxhdGUsIGxhbmd1YWdlLCBwcm9qZWN0SW5mbykpO1xuICAgICAgICAgIH1cbiAgICAgICAgfSxcbiAgICAgICAgcGxhY2Vob2xkZXI6IChwaDogc3RyaW5nKSA9PiB0aGlzLmV4cGFuZChgJSR7cGh9JWAsIGxhbmd1YWdlLCBwcm9qZWN0SW5mbyksXG4gICAgICB9LFxuICAgICk7XG4gIH1cblxuICBwcml2YXRlIGFzeW5jIGluc3RhbGxGaWxlcyhzb3VyY2VEaXJlY3Rvcnk6IHN0cmluZywgdGFyZ2V0RGlyZWN0b3J5OiBzdHJpbmcsIGxhbmd1YWdlOiBzdHJpbmcsIHByb2plY3Q6IFByb2plY3RJbmZvKSB7XG4gICAgZm9yIChjb25zdCBmaWxlIG9mIGF3YWl0IGZzLnJlYWRkaXIoc291cmNlRGlyZWN0b3J5KSkge1xuICAgICAgY29uc3QgZnJvbUZpbGUgPSBwYXRoLmpvaW4oc291cmNlRGlyZWN0b3J5LCBmaWxlKTtcbiAgICAgIGNvbnN0IHRvRmlsZSA9IHBhdGguam9pbih0YXJnZXREaXJlY3RvcnksIHRoaXMuZXhwYW5kKGZpbGUsIGxhbmd1YWdlLCBwcm9qZWN0KSk7XG4gICAgICBpZiAoKGF3YWl0IGZzLnN0YXQoZnJvbUZpbGUpKS5pc0RpcmVjdG9yeSgpKSB7XG4gICAgICAgIGF3YWl0IGZzLm1rZGlyKHRvRmlsZSk7XG4gICAgICAgIGF3YWl0IHRoaXMuaW5zdGFsbEZpbGVzKGZyb21GaWxlLCB0b0ZpbGUsIGxhbmd1YWdlLCBwcm9qZWN0KTtcbiAgICAgICAgY29udGludWU7XG4gICAgICB9IGVsc2UgaWYgKGZpbGUubWF0Y2goL14uKlxcLnRlbXBsYXRlXFwuW14uXSskLykpIHtcbiAgICAgICAgYXdhaXQgdGhpcy5pbnN0YWxsUHJvY2Vzc2VkKGZyb21GaWxlLCB0b0ZpbGUucmVwbGFjZSgvXFwudGVtcGxhdGUoXFwuW14uXSspJC8sICckMScpLCBsYW5ndWFnZSwgcHJvamVjdCk7XG4gICAgICAgIGNvbnRpbnVlO1xuICAgICAgfSBlbHNlIGlmIChmaWxlLm1hdGNoKC9eLipcXC5ob29rXFwuKGQuKT9bXi5dKyQvKSkge1xuICAgICAgICAvLyBJZ25vcmVcbiAgICAgICAgY29udGludWU7XG4gICAgICB9IGVsc2Uge1xuICAgICAgICBhd2FpdCBmcy5jb3B5KGZyb21GaWxlLCB0b0ZpbGUpO1xuICAgICAgfVxuICAgIH1cbiAgfVxuXG4gIHByaXZhdGUgYXN5bmMgaW5zdGFsbFByb2Nlc3NlZCh0ZW1wbGF0ZVBhdGg6IHN0cmluZywgdG9GaWxlOiBzdHJpbmcsIGxhbmd1YWdlOiBzdHJpbmcsIHByb2plY3Q6IFByb2plY3RJbmZvKSB7XG4gICAgY29uc3QgdGVtcGxhdGUgPSBhd2FpdCBmcy5yZWFkRmlsZSh0ZW1wbGF0ZVBhdGgsIHsgZW5jb2Rpbmc6ICd1dGYtOCcgfSk7XG4gICAgYXdhaXQgZnMud3JpdGVGaWxlKHRvRmlsZSwgdGhpcy5leHBhbmQodGVtcGxhdGUsIGxhbmd1YWdlLCBwcm9qZWN0KSk7XG4gIH1cblxuICBwcml2YXRlIGV4cGFuZCh0ZW1wbGF0ZTogc3RyaW5nLCBsYW5ndWFnZTogc3RyaW5nLCBwcm9qZWN0OiBQcm9qZWN0SW5mbykge1xuICAgIC8vIGVzbGludC1kaXNhYmxlLW5leHQtbGluZSBAdHlwZXNjcmlwdC1lc2xpbnQvbm8tcmVxdWlyZS1pbXBvcnRzXG4gICAgY29uc3QgbWFuaWZlc3QgPSByZXF1aXJlKHBhdGguam9pbihyb290RGlyKCksICdwYWNrYWdlLmpzb24nKSk7XG4gICAgY29uc3QgTUFUQ0hfVkVSX0JVSUxEID0gL1xcK1thLWYwLTldKyQvOyAvLyBNYXRjaGVzIFwiK0JVSUxEXCIgaW4gXCJ4Lnkuei1iZXRhK0JVSUxEXCJcbiAgICBjb25zdCBjZGtWZXJzaW9uID0gbWFuaWZlc3QudmVyc2lvbi5yZXBsYWNlKE1BVENIX1ZFUl9CVUlMRCwgJycpO1xuICAgIGxldCBjb25zdHJ1Y3RzVmVyc2lvbiA9IG1hbmlmZXN0LmRldkRlcGVuZGVuY2llcy5jb25zdHJ1Y3RzLnJlcGxhY2UoTUFUQ0hfVkVSX0JVSUxELCAnJyk7XG4gICAgc3dpdGNoIChsYW5ndWFnZSkge1xuICAgICAgY2FzZSAnamF2YSc6XG4gICAgICBjYXNlICdjc2hhcnAnOlxuICAgICAgY2FzZSAnZnNoYXJwJzpcbiAgICAgICAgY29uc3RydWN0c1ZlcnNpb24gPSByYW5nZUZyb21TZW12ZXIoY29uc3RydWN0c1ZlcnNpb24sICdicmFja2V0Jyk7XG4gICAgICAgIGJyZWFrO1xuICAgICAgY2FzZSAncHl0aG9uJzpcbiAgICAgICAgY29uc3RydWN0c1ZlcnNpb24gPSByYW5nZUZyb21TZW12ZXIoY29uc3RydWN0c1ZlcnNpb24sICdwZXAnKTtcbiAgICAgICAgYnJlYWs7XG4gICAgfVxuICAgIHJldHVybiB0ZW1wbGF0ZVxuICAgICAgLnJlcGxhY2UoLyVuYW1lJS9nLCBwcm9qZWN0Lm5hbWUpXG4gICAgICAucmVwbGFjZSgvJXN0YWNrbmFtZSUvLCBwcm9qZWN0LnN0YWNrTmFtZSA/PyAnJW5hbWUuUGFzY2FsQ2FzZWQlU3RhY2snKVxuICAgICAgLnJlcGxhY2UoXG4gICAgICAgIC8lUGFzY2FsTmFtZVNwYWNlJS8sXG4gICAgICAgIHByb2plY3Quc3RhY2tOYW1lID8gY2FtZWxDYXNlKHByb2plY3Quc3RhY2tOYW1lICsgJ1N0YWNrJywgeyBwYXNjYWxDYXNlOiB0cnVlIH0pIDogJyVuYW1lLlBhc2NhbENhc2VkJScsXG4gICAgICApXG4gICAgICAucmVwbGFjZShcbiAgICAgICAgLyVQYXNjYWxTdGFja1Byb3BzJS8sXG4gICAgICAgIHByb2plY3Quc3RhY2tOYW1lID8gY2FtZWxDYXNlKHByb2plY3Quc3RhY2tOYW1lLCB7IHBhc2NhbENhc2U6IHRydWUgfSkgKyAnU3RhY2tQcm9wcycgOiAnU3RhY2tQcm9wcycsXG4gICAgICApXG4gICAgICAucmVwbGFjZSgvJW5hbWVcXC5jYW1lbENhc2VkJS9nLCBjYW1lbENhc2UocHJvamVjdC5uYW1lKSlcbiAgICAgIC5yZXBsYWNlKC8lbmFtZVxcLlBhc2NhbENhc2VkJS9nLCBjYW1lbENhc2UocHJvamVjdC5uYW1lLCB7IHBhc2NhbENhc2U6IHRydWUgfSkpXG4gICAgICAucmVwbGFjZSgvJWNkay12ZXJzaW9uJS9nLCBjZGtWZXJzaW9uKVxuICAgICAgLnJlcGxhY2UoLyVjb25zdHJ1Y3RzLXZlcnNpb24lL2csIGNvbnN0cnVjdHNWZXJzaW9uKVxuICAgICAgLnJlcGxhY2UoLyVjZGstaG9tZSUvZywgY2RrSG9tZURpcigpKVxuICAgICAgLnJlcGxhY2UoLyVuYW1lXFwuUHl0aG9uTW9kdWxlJS9nLCBwcm9qZWN0Lm5hbWUucmVwbGFjZSgvLS9nLCAnXycpKVxuICAgICAgLnJlcGxhY2UoLyVweXRob24tZXhlY3V0YWJsZSUvZywgcHl0aG9uRXhlY3V0YWJsZSgpKVxuICAgICAgLnJlcGxhY2UoLyVuYW1lXFwuU3RhY2tOYW1lJS9nLCBwcm9qZWN0Lm5hbWUucmVwbGFjZSgvW15BLVphLXowLTktXS9nLCAnLScpKTtcbiAgfVxuXG4gIC8qKlxuICAgKiBBZGRzIGNvbnRleHQgdmFyaWFibGVzIHRvIGBjZGsuanNvbmAgaW4gdGhlIGdlbmVyYXRlZCBwcm9qZWN0IGRpcmVjdG9yeSB0b1xuICAgKiBlbmFibGUgZnV0dXJlIGJlaGF2aW9yIGZvciBuZXcgcHJvamVjdHMuXG4gICAqL1xuICBwcml2YXRlIGFzeW5jIGFwcGx5RnV0dXJlRmxhZ3MocHJvamVjdERpcjogc3RyaW5nKSB7XG4gICAgY29uc3QgY2RrSnNvbiA9IHBhdGguam9pbihwcm9qZWN0RGlyLCAnY2RrLmpzb24nKTtcbiAgICBpZiAoIShhd2FpdCBmcy5wYXRoRXhpc3RzKGNka0pzb24pKSkge1xuICAgICAgcmV0dXJuO1xuICAgIH1cblxuICAgIGNvbnN0IGNvbmZpZyA9IGF3YWl0IGZzLnJlYWRKc29uKGNka0pzb24pO1xuICAgIGNvbmZpZy5jb250ZXh0ID0ge1xuICAgICAgLi4uY29uZmlnLmNvbnRleHQsXG4gICAgICAuLi5jeGFwaS5ORVdfUFJPSkVDVF9DT05URVhULFxuICAgIH07XG5cbiAgICBhd2FpdCBmcy53cml0ZUpzb24oY2RrSnNvbiwgY29uZmlnLCB7IHNwYWNlczogMiB9KTtcbiAgfVxuXG4gIHB1YmxpYyBhc3luYyBhZGRNaWdyYXRlQ29udGV4dChwcm9qZWN0RGlyOiBzdHJpbmcpIHtcbiAgICBjb25zdCBjZGtKc29uID0gcGF0aC5qb2luKHByb2plY3REaXIsICdjZGsuanNvbicpO1xuICAgIGlmICghKGF3YWl0IGZzLnBhdGhFeGlzdHMoY2RrSnNvbikpKSB7XG4gICAgICByZXR1cm47XG4gICAgfVxuXG4gICAgY29uc3QgY29uZmlnID0gYXdhaXQgZnMucmVhZEpzb24oY2RrSnNvbik7XG4gICAgY29uZmlnLmNvbnRleHQgPSB7XG4gICAgICAuLi5jb25maWcuY29udGV4dCxcbiAgICAgICdjZGstbWlncmF0ZSc6IHRydWUsXG4gICAgfTtcblxuICAgIGF3YWl0IGZzLndyaXRlSnNvbihjZGtKc29uLCBjb25maWcsIHsgc3BhY2VzOiAyIH0pO1xuICB9XG59XG5cbmludGVyZmFjZSBQcm9qZWN0SW5mbyB7XG4gIC8qKiBUaGUgdmFsdWUgdXNlZCBmb3IgJW5hbWUlICovXG4gIHJlYWRvbmx5IG5hbWU6IHN0cmluZztcbiAgcmVhZG9ubHkgc3RhY2tOYW1lPzogc3RyaW5nO1xufVxuXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gYXZhaWxhYmxlSW5pdFRlbXBsYXRlcygpOiBQcm9taXNlPEluaXRUZW1wbGF0ZVtdPiB7XG4gIHJldHVybiBuZXcgUHJvbWlzZShhc3luYyAocmVzb2x2ZSkgPT4ge1xuICAgIHRyeSB7XG4gICAgICBjb25zdCB0ZW1wbGF0ZXNEaXIgPSBwYXRoLmpvaW4ocm9vdERpcigpLCAnbGliJywgJ2luaXQtdGVtcGxhdGVzJyk7XG4gICAgICBjb25zdCB0ZW1wbGF0ZU5hbWVzID0gYXdhaXQgbGlzdERpcmVjdG9yeSh0ZW1wbGF0ZXNEaXIpO1xuICAgICAgY29uc3QgdGVtcGxhdGVzID0gbmV3IEFycmF5PEluaXRUZW1wbGF0ZT4oKTtcbiAgICAgIGZvciAoY29uc3QgdGVtcGxhdGVOYW1lIG9mIHRlbXBsYXRlTmFtZXMpIHtcbiAgICAgICAgdGVtcGxhdGVzLnB1c2goYXdhaXQgSW5pdFRlbXBsYXRlLmZyb21OYW1lKHRlbXBsYXRlc0RpciwgdGVtcGxhdGVOYW1lKSk7XG4gICAgICB9XG4gICAgICByZXNvbHZlKHRlbXBsYXRlcyk7XG4gICAgfSBjYXRjaCB7XG4gICAgICByZXNvbHZlKFtdKTtcbiAgICB9XG4gIH0pO1xufVxuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIGF2YWlsYWJsZUluaXRMYW5ndWFnZXMoKTogUHJvbWlzZTxzdHJpbmdbXT4ge1xuICByZXR1cm4gbmV3IFByb21pc2UoYXN5bmMgKHJlc29sdmUpID0+IHtcbiAgICBjb25zdCB0ZW1wbGF0ZXMgPSBhd2FpdCBhdmFpbGFibGVJbml0VGVtcGxhdGVzKCk7XG4gICAgY29uc3QgcmVzdWx0ID0gbmV3IFNldDxzdHJpbmc+KCk7XG4gICAgZm9yIChjb25zdCB0ZW1wbGF0ZSBvZiB0ZW1wbGF0ZXMpIHtcbiAgICAgIGZvciAoY29uc3QgbGFuZ3VhZ2Ugb2YgdGVtcGxhdGUubGFuZ3VhZ2VzKSB7XG4gICAgICAgIHJlc3VsdC5hZGQobGFuZ3VhZ2UpO1xuICAgICAgfVxuICAgIH1cbiAgICByZXNvbHZlKFsuLi5yZXN1bHRdKTtcbiAgfSk7XG59XG5cbi8qKlxuICogQHBhcmFtIGRpclBhdGggaXMgdGhlIGRpcmVjdG9yeSB0byBiZSBsaXN0ZWQuXG4gKiBAcmV0dXJucyB0aGUgbGlzdCBvZiBmaWxlIG9yIGRpcmVjdG9yeSBuYW1lcyBjb250YWluZWQgaW4gYGBkaXJQYXRoYGAsIGV4Y2x1ZGluZyBhbnkgZG90LWZpbGUsIGFuZCBzb3J0ZWQuXG4gKi9cbmFzeW5jIGZ1bmN0aW9uIGxpc3REaXJlY3RvcnkoZGlyUGF0aDogc3RyaW5nKSB7XG4gIHJldHVybiAoXG4gICAgKGF3YWl0IGZzLnJlYWRkaXIoZGlyUGF0aCkpXG4gICAgICAuZmlsdGVyKChwKSA9PiAhcC5zdGFydHNXaXRoKCcuJykpXG4gICAgICAuZmlsdGVyKChwKSA9PiAhKHAgPT09ICdMSUNFTlNFJykpXG4gICAgICAvLyBpZiwgZm9yIHNvbWUgcmVhc29uLCB0aGUgdGVtcCBmb2xkZXIgZm9yIHRoZSBob29rIGRvZXNuJ3QgZ2V0IGRlbGV0ZWQgd2UgZG9uJ3Qgd2FudCB0byBkaXNwbGF5IGl0IGluIHRoaXMgbGlzdFxuICAgICAgLmZpbHRlcigocCkgPT4gIShwID09PSBJTkZPX0RPVF9KU09OKSlcbiAgICAgIC5zb3J0KClcbiAgKTtcbn1cblxuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIHByaW50QXZhaWxhYmxlVGVtcGxhdGVzKGxhbmd1YWdlPzogc3RyaW5nKSB7XG4gIHByaW50KCdBdmFpbGFibGUgdGVtcGxhdGVzOicpO1xuICBmb3IgKGNvbnN0IHRlbXBsYXRlIG9mIGF3YWl0IGF2YWlsYWJsZUluaXRUZW1wbGF0ZXMoKSkge1xuICAgIGlmIChsYW5ndWFnZSAmJiB0ZW1wbGF0ZS5sYW5ndWFnZXMuaW5kZXhPZihsYW5ndWFnZSkgPT09IC0xKSB7XG4gICAgICBjb250aW51ZTtcbiAgICB9XG4gICAgcHJpbnQoYCogJHtjaGFsay5ncmVlbih0ZW1wbGF0ZS5uYW1lKX06ICR7dGVtcGxhdGUuZGVzY3JpcHRpb259YCk7XG4gICAgY29uc3QgbGFuZ3VhZ2VBcmcgPSBsYW5ndWFnZVxuICAgICAgPyBjaGFsay5ib2xkKGxhbmd1YWdlKVxuICAgICAgOiB0ZW1wbGF0ZS5sYW5ndWFnZXMubGVuZ3RoID4gMVxuICAgICAgICA/IGBbJHt0ZW1wbGF0ZS5sYW5ndWFnZXMubWFwKCh0KSA9PiBjaGFsay5ib2xkKHQpKS5qb2luKCd8Jyl9XWBcbiAgICAgICAgOiBjaGFsay5ib2xkKHRlbXBsYXRlLmxhbmd1YWdlc1swXSk7XG4gICAgcHJpbnQoYCAgIOKUlOKUgCAke2NoYWxrLmJsdWUoYGNkayBpbml0ICR7Y2hhbGsuYm9sZCh0ZW1wbGF0ZS5uYW1lKX0gLS1sYW5ndWFnZT0ke2xhbmd1YWdlQXJnfWApfWApO1xuICB9XG59XG5cbmFzeW5jIGZ1bmN0aW9uIGluaXRpYWxpemVQcm9qZWN0KFxuICB0ZW1wbGF0ZTogSW5pdFRlbXBsYXRlLFxuICBsYW5ndWFnZTogc3RyaW5nLFxuICBjYW5Vc2VOZXR3b3JrOiBib29sZWFuLFxuICBnZW5lcmF0ZU9ubHk6IGJvb2xlYW4sXG4gIHdvcmtEaXI6IHN0cmluZyxcbiAgc3RhY2tOYW1lPzogc3RyaW5nLFxuICBtaWdyYXRlPzogYm9vbGVhbixcbikge1xuICBhd2FpdCBhc3NlcnRJc0VtcHR5RGlyZWN0b3J5KHdvcmtEaXIpO1xuICBwcmludChgQXBwbHlpbmcgcHJvamVjdCB0ZW1wbGF0ZSAke2NoYWxrLmdyZWVuKHRlbXBsYXRlLm5hbWUpfSBmb3IgJHtjaGFsay5ibHVlKGxhbmd1YWdlKX1gKTtcbiAgYXdhaXQgdGVtcGxhdGUuaW5zdGFsbChsYW5ndWFnZSwgd29ya0Rpciwgc3RhY2tOYW1lKTtcbiAgaWYgKG1pZ3JhdGUpIHtcbiAgICBhd2FpdCB0ZW1wbGF0ZS5hZGRNaWdyYXRlQ29udGV4dCh3b3JrRGlyKTtcbiAgfVxuICBpZiAoYXdhaXQgZnMucGF0aEV4aXN0cygnUkVBRE1FLm1kJykpIHtcbiAgICBjb25zdCByZWFkbWUgPSBhd2FpdCBmcy5yZWFkRmlsZSgnUkVBRE1FLm1kJywgeyBlbmNvZGluZzogJ3V0Zi04JyB9KTtcbiAgICAvLyBTYXZlIHRoZSBsb2dzIVxuICAgIC8vIFdpdGhvdXQgdGhpcyBzdGF0ZW1lbnQsIHRoZSByZWFkbWUgb2YgdGhlIENMSSBpcyBwcmludGVkIGluIGV2ZXJ5IGluaXQgdGVzdFxuICAgIGlmICghcmVhZG1lLnN0YXJ0c1dpdGgoJyMgQVdTIENESyBUb29sa2l0JykpIHtcbiAgICAgIHByaW50KGNoYWxrLmdyZWVuKHJlYWRtZSkpO1xuICAgIH1cbiAgfVxuXG4gIGlmICghZ2VuZXJhdGVPbmx5KSB7XG4gICAgYXdhaXQgaW5pdGlhbGl6ZUdpdFJlcG9zaXRvcnkod29ya0Rpcik7XG4gICAgYXdhaXQgcG9zdEluc3RhbGwobGFuZ3VhZ2UsIGNhblVzZU5ldHdvcmssIHdvcmtEaXIpO1xuICB9XG5cbiAgcHJpbnQoJ+KchSBBbGwgZG9uZSEnKTtcbn1cblxuYXN5bmMgZnVuY3Rpb24gYXNzZXJ0SXNFbXB0eURpcmVjdG9yeSh3b3JrRGlyOiBzdHJpbmcpIHtcbiAgY29uc3QgZmlsZXMgPSBhd2FpdCBmcy5yZWFkZGlyKHdvcmtEaXIpO1xuICBpZiAoZmlsZXMuZmlsdGVyKChmKSA9PiAhZi5zdGFydHNXaXRoKCcuJykpLmxlbmd0aCAhPT0gMCkge1xuICAgIHRocm93IG5ldyBFcnJvcignYGNkayBpbml0YCBjYW5ub3QgYmUgcnVuIGluIGEgbm9uLWVtcHR5IGRpcmVjdG9yeSEnKTtcbiAgfVxufVxuXG5hc3luYyBmdW5jdGlvbiBpbml0aWFsaXplR2l0UmVwb3NpdG9yeSh3b3JrRGlyOiBzdHJpbmcpIHtcbiAgaWYgKGF3YWl0IGlzSW5HaXRSZXBvc2l0b3J5KHdvcmtEaXIpKSB7XG4gICAgcmV0dXJuO1xuICB9XG4gIHByaW50KCdJbml0aWFsaXppbmcgYSBuZXcgZ2l0IHJlcG9zaXRvcnkuLi4nKTtcbiAgdHJ5IHtcbiAgICBhd2FpdCBleGVjdXRlKCdnaXQnLCBbJ2luaXQnXSwgeyBjd2Q6IHdvcmtEaXIgfSk7XG4gICAgYXdhaXQgZXhlY3V0ZSgnZ2l0JywgWydhZGQnLCAnLiddLCB7IGN3ZDogd29ya0RpciB9KTtcbiAgICBhd2FpdCBleGVjdXRlKCdnaXQnLCBbJ2NvbW1pdCcsICctLW1lc3NhZ2U9XCJJbml0aWFsIGNvbW1pdFwiJywgJy0tbm8tZ3BnLXNpZ24nXSwgeyBjd2Q6IHdvcmtEaXIgfSk7XG4gIH0gY2F0Y2gge1xuICAgIHdhcm5pbmcoJ1VuYWJsZSB0byBpbml0aWFsaXplIGdpdCByZXBvc2l0b3J5IGZvciB5b3VyIHByb2plY3QuJyk7XG4gIH1cbn1cblxuYXN5bmMgZnVuY3Rpb24gcG9zdEluc3RhbGwobGFuZ3VhZ2U6IHN0cmluZywgY2FuVXNlTmV0d29yazogYm9vbGVhbiwgd29ya0Rpcjogc3RyaW5nKSB7XG4gIHN3aXRjaCAobGFuZ3VhZ2UpIHtcbiAgICBjYXNlICdqYXZhc2NyaXB0JzpcbiAgICAgIHJldHVybiBwb3N0SW5zdGFsbEphdmFzY3JpcHQoY2FuVXNlTmV0d29yaywgd29ya0Rpcik7XG4gICAgY2FzZSAndHlwZXNjcmlwdCc6XG4gICAgICByZXR1cm4gcG9zdEluc3RhbGxUeXBlc2NyaXB0KGNhblVzZU5ldHdvcmssIHdvcmtEaXIpO1xuICAgIGNhc2UgJ2phdmEnOlxuICAgICAgcmV0dXJuIHBvc3RJbnN0YWxsSmF2YShjYW5Vc2VOZXR3b3JrLCB3b3JrRGlyKTtcbiAgICBjYXNlICdweXRob24nOlxuICAgICAgcmV0dXJuIHBvc3RJbnN0YWxsUHl0aG9uKHdvcmtEaXIpO1xuICB9XG59XG5cbmFzeW5jIGZ1bmN0aW9uIHBvc3RJbnN0YWxsSmF2YXNjcmlwdChjYW5Vc2VOZXR3b3JrOiBib29sZWFuLCBjd2Q6IHN0cmluZykge1xuICByZXR1cm4gcG9zdEluc3RhbGxUeXBlc2NyaXB0KGNhblVzZU5ldHdvcmssIGN3ZCk7XG59XG5cbmFzeW5jIGZ1bmN0aW9uIHBvc3RJbnN0YWxsVHlwZXNjcmlwdChjYW5Vc2VOZXR3b3JrOiBib29sZWFuLCBjd2Q6IHN0cmluZykge1xuICBjb25zdCBjb21tYW5kID0gJ25wbSc7XG5cbiAgaWYgKCFjYW5Vc2VOZXR3b3JrKSB7XG4gICAgd2FybmluZyhgUGxlYXNlIHJ1biAnJHtjb21tYW5kfSBpbnN0YWxsJyFgKTtcbiAgICByZXR1cm47XG4gIH1cblxuICBwcmludChgRXhlY3V0aW5nICR7Y2hhbGsuZ3JlZW4oYCR7Y29tbWFuZH0gaW5zdGFsbGApfS4uLmApO1xuICB0cnkge1xuICAgIGF3YWl0IGV4ZWN1dGUoY29tbWFuZCwgWydpbnN0YWxsJ10sIHsgY3dkIH0pO1xuICB9IGNhdGNoIChlOiBhbnkpIHtcbiAgICB3YXJuaW5nKGAke2NvbW1hbmR9IGluc3RhbGwgZmFpbGVkOiBgICsgZS5tZXNzYWdlKTtcbiAgfVxufVxuXG5hc3luYyBmdW5jdGlvbiBwb3N0SW5zdGFsbEphdmEoY2FuVXNlTmV0d29yazogYm9vbGVhbiwgY3dkOiBzdHJpbmcpIHtcbiAgY29uc3QgbXZuUGFja2FnZVdhcm5pbmcgPSBcIlBsZWFzZSBydW4gJ212biBwYWNrYWdlJyFcIjtcbiAgaWYgKCFjYW5Vc2VOZXR3b3JrKSB7XG4gICAgd2FybmluZyhtdm5QYWNrYWdlV2FybmluZyk7XG4gICAgcmV0dXJuO1xuICB9XG5cbiAgcHJpbnQoXCJFeGVjdXRpbmcgJ212biBwYWNrYWdlJ1wiKTtcbiAgdHJ5IHtcbiAgICBhd2FpdCBleGVjdXRlKCdtdm4nLCBbJ3BhY2thZ2UnXSwgeyBjd2QgfSk7XG4gIH0gY2F0Y2gge1xuICAgIHdhcm5pbmcoJ1VuYWJsZSB0byBwYWNrYWdlIGNvbXBpbGVkIGNvZGUgYXMgSkFSJyk7XG4gICAgd2FybmluZyhtdm5QYWNrYWdlV2FybmluZyk7XG4gIH1cbn1cblxuYXN5bmMgZnVuY3Rpb24gcG9zdEluc3RhbGxQeXRob24oY3dkOiBzdHJpbmcpIHtcbiAgY29uc3QgcHl0aG9uID0gcHl0aG9uRXhlY3V0YWJsZSgpO1xuICB3YXJuaW5nKGBQbGVhc2UgcnVuICcke3B5dGhvbn0gLW0gdmVudiAudmVudichYCk7XG4gIHByaW50KGBFeGVjdXRpbmcgJHtjaGFsay5ncmVlbignQ3JlYXRpbmcgdmlydHVhbGVudi4uLicpfWApO1xuICB0cnkge1xuICAgIGF3YWl0IGV4ZWN1dGUocHl0aG9uLCBbJy1tIHZlbnYnLCAnLnZlbnYnXSwgeyBjd2QgfSk7XG4gIH0gY2F0Y2gge1xuICAgIHdhcm5pbmcoJ1VuYWJsZSB0byBjcmVhdGUgdmlydHVhbGVudiBhdXRvbWF0aWNhbGx5Jyk7XG4gICAgd2FybmluZyhgUGxlYXNlIHJ1biAnJHtweXRob259IC1tIHZlbnYgLnZlbnYnIWApO1xuICB9XG59XG5cbi8qKlxuICogQHBhcmFtIGRpciBhIGRpcmVjdG9yeSB0byBiZSBjaGVja2VkXG4gKiBAcmV0dXJucyB0cnVlIGlmIGBgZGlyYGAgaXMgd2l0aGluIGEgZ2l0IHJlcG9zaXRvcnkuXG4gKi9cbmFzeW5jIGZ1bmN0aW9uIGlzSW5HaXRSZXBvc2l0b3J5KGRpcjogc3RyaW5nKSB7XG4gIHdoaWxlICh0cnVlKSB7XG4gICAgaWYgKGF3YWl0IGZzLnBhdGhFeGlzdHMocGF0aC5qb2luKGRpciwgJy5naXQnKSkpIHtcbiAgICAgIHJldHVybiB0cnVlO1xuICAgIH1cbiAgICBpZiAoaXNSb290KGRpcikpIHtcbiAgICAgIHJldHVybiBmYWxzZTtcbiAgICB9XG4gICAgZGlyID0gcGF0aC5kaXJuYW1lKGRpcik7XG4gIH1cbn1cblxuLyoqXG4gKiBAcGFyYW0gZGlyIGEgZGlyZWN0b3J5IHRvIGJlIGNoZWNrZWQuXG4gKiBAcmV0dXJucyB0cnVlIGlmIGBgZGlyYGAgaXMgdGhlIHJvb3Qgb2YgYSBmaWxlc3lzdGVtLlxuICovXG5mdW5jdGlvbiBpc1Jvb3QoZGlyOiBzdHJpbmcpIHtcbiAgcmV0dXJuIHBhdGguZGlybmFtZShkaXIpID09PSBkaXI7XG59XG5cbi8qKlxuICogRXhlY3V0ZXMgYGNvbW1hbmRgLiBTVERFUlIgaXMgZW1pdHRlZCBpbiByZWFsLXRpbWUuXG4gKlxuICogSWYgY29tbWFuZCBleGl0cyB3aXRoIG5vbi16ZXJvIGV4aXQgY29kZSwgYW4gZXhjZXByaW9uIGlzIHRocm93biBhbmQgaW5jbHVkZXNcbiAqIHRoZSBjb250ZW50cyBvZiBTVERPVVQuXG4gKlxuICogQHJldHVybnMgU1RET1VUIChpZiBzdWNjZXNzZnVsKS5cbiAqL1xuYXN5bmMgZnVuY3Rpb24gZXhlY3V0ZShjbWQ6IHN0cmluZywgYXJnczogc3RyaW5nW10sIHsgY3dkIH06IHsgY3dkOiBzdHJpbmcgfSkge1xuICBjb25zdCBjaGlsZCA9IGNoaWxkUHJvY2Vzcy5zcGF3bihjbWQsIGFyZ3MsIHtcbiAgICBjd2QsXG4gICAgc2hlbGw6IHRydWUsXG4gICAgc3RkaW86IFsnaWdub3JlJywgJ3BpcGUnLCAnaW5oZXJpdCddLFxuICB9KTtcbiAgbGV0IHN0ZG91dCA9ICcnO1xuICBjaGlsZC5zdGRvdXQub24oJ2RhdGEnLCAoY2h1bmspID0+IChzdGRvdXQgKz0gY2h1bmsudG9TdHJpbmcoKSkpO1xuICByZXR1cm4gbmV3IFByb21pc2U8c3RyaW5nPigob2ssIGZhaWwpID0+IHtcbiAgICBjaGlsZC5vbmNlKCdlcnJvcicsIChlcnIpID0+IGZhaWwoZXJyKSk7XG4gICAgY2hpbGQub25jZSgnZXhpdCcsIChzdGF0dXMpID0+IHtcbiAgICAgIGlmIChzdGF0dXMgPT09IDApIHtcbiAgICAgICAgcmV0dXJuIG9rKHN0ZG91dCk7XG4gICAgICB9IGVsc2Uge1xuICAgICAgICBwcm9jZXNzLnN0ZGVyci53cml0ZShzdGRvdXQpO1xuICAgICAgICByZXR1cm4gZmFpbChuZXcgRXJyb3IoYCR7Y21kfSBleGl0ZWQgd2l0aCBzdGF0dXMgJHtzdGF0dXN9YCkpO1xuICAgICAgfVxuICAgIH0pO1xuICB9KTtcbn1cbiJdfQ==