#!/usr/bin/env node
import 'source-map-support/register';

import cxapi = require('@aws-cdk/cx-api');
import colors = require('colors/safe');
import fs = require('fs-extra');
import util = require('util');
import yargs = require('yargs');

import { bootstrapEnvironment, deployStack, destroyStack, loadToolkitInfo, Mode, SDK } from '../lib';
import { environmentsFromDescriptors, globEnvironmentsFromStacks } from '../lib/api/cxapp/environments';
import { AppStacks, listStackNames } from '../lib/api/cxapp/stacks';
import { printSecurityDiff, printStackDiff, RequireApproval } from '../lib/diff';
import { availableInitLanguages, cliInit, printAvailableTemplates } from '../lib/init';
import { interactive } from '../lib/interactive';
import { data, debug, error, highlight, print, setVerbose, success, warning } from '../lib/logging';
import { PluginHost } from '../lib/plugin';
import { parseRenames } from '../lib/renames';
import { deserializeStructure, serializeStructure } from '../lib/serialize';
import { Configuration, Settings } from '../lib/settings';
import { VERSION } from '../lib/version';

// tslint:disable-next-line:no-var-requires
const promptly = require('promptly');
const confirm = util.promisify(promptly.confirm);

const DEFAULT_TOOLKIT_STACK_NAME = 'CDKToolkit';

// tslint:disable:no-shadowed-variable max-line-length
async function parseCommandLineArguments() {
  const initTemplateLanuages = await availableInitLanguages;
  return yargs
    .usage('Usage: cdk -a <cdk-app> COMMAND')
    .option('app', { type: 'string', alias: 'a', desc: 'REQUIRED: Command-line for executing your CDK app (e.g. "node bin/my-app.js")' })
    .option('context', { type: 'array', alias: 'c', desc: 'Add contextual string parameter.', nargs: 1, requiresArg: 'KEY=VALUE' })
    .option('plugin', { type: 'array', alias: 'p', desc: 'Name or path of a node package that extend the CDK features. Can be specified multiple times', nargs: 1 })
    .option('rename', { type: 'string', desc: 'Rename stack name if different then the one defined in the cloud executable', requiresArg: '[ORIGINAL:]RENAMED' })
    .option('trace', { type: 'boolean', desc: 'Print trace for stack warnings' })
    .option('strict', { type: 'boolean', desc: 'Do not construct stacks with warnings' })
    .option('ignore-errors', { type: 'boolean', default: false, desc: 'Ignores synthesis errors, which will likely produce an invalid output' })
    .option('json', { type: 'boolean', alias: 'j', desc: 'Use JSON output instead of YAML' })
    .option('verbose', { type: 'boolean', alias: 'v', desc: 'Show debug logs' })
    .option('profile', { type: 'string', desc: 'Use the indicated AWS profile as the default environment' })
    .option('proxy', { type: 'string', desc: 'Use the indicated proxy. Will read from HTTPS_PROXY environment variable if not specified.' })
    .option('ec2creds', { type: 'boolean', alias: 'i', default: undefined, desc: 'Force trying to fetch EC2 instance credentials. Default: guess EC2 instance status.' })
    .option('version-reporting', { type: 'boolean', desc: 'Include the "AWS::CDK::Metadata" resource in synthesized templates (enabled by default)', default: undefined })
    .option('path-metadata', { type: 'boolean', desc: 'Include "aws:cdk:path" CloudFormation metadata for each resource (enabled by default)', default: true })
    .option('role-arn', { type: 'string', alias: 'r', desc: 'ARN of Role to use when invoking CloudFormation', default: undefined })
    .command([ 'list', 'ls' ], 'Lists all stacks in the app', yargs => yargs
      .option('long', { type: 'boolean', default: false, alias: 'l', desc: 'display environment information for each stack' }))
    .command([ 'synthesize [STACKS..]', 'synth [STACKS..]' ], 'Synthesizes and prints the CloudFormation template for this stack', yargs => yargs
      .option('interactive', { type: 'boolean', alias: 'i', desc: 'interactively watch and show template updates' })
      .option('output', { type: 'string', alias: 'o', desc: 'write CloudFormation template for requested stacks to the given directory' }))
    .command('bootstrap [ENVIRONMENTS..]', 'Deploys the CDK toolkit stack into an AWS environment', yargs => yargs
      .option('toolkit-stack-name', { type: 'string', desc: 'the name of the CDK toolkit stack' }))
    .command('deploy [STACKS..]', 'Deploys the stack(s) named STACKS into your AWS account', yargs => yargs
      .option('require-approval', { type: 'string', choices: [RequireApproval.Never, RequireApproval.AnyChange, RequireApproval.Broadening], desc: 'what security-sensitive changes need manual approval' })
      .option('toolkit-stack-name', { type: 'string', desc: 'the name of the CDK toolkit stack' }))
    .command('destroy [STACKS..]', 'Destroy the stack(s) named STACKS', yargs => yargs
      .option('force', { type: 'boolean', alias: 'f', desc: 'Do not ask for confirmation before destroying the stacks' }))
    .command('diff [STACK]', 'Compares the specified stack with the deployed stack or a local template file', yargs => yargs
      .option('template', { type: 'string', desc: 'the path to the CloudFormation template to compare with' })
      .option('strict', { type: 'boolean', desc: 'do not filter out AWS::CDK::Metadata resources', default: false }))
    .command('metadata [STACK]', 'Returns all metadata associated with this stack')
    .command('init [TEMPLATE]', 'Create a new, empty CDK project from a template. Invoked without TEMPLATE, the app template will be used.', yargs => yargs
      .option('language', { type: 'string', alias: 'l', desc: 'the language to be used for the new project (default can be configured in ~/.cdk.json)', choices: initTemplateLanuages })
      .option('list', { type: 'boolean', desc: 'list the available templates' }))
    .commandDir('../lib/commands', { exclude: /^_.*/ })
    .version(VERSION)
    .demandCommand(1, '') // just print help
    .help()
    .alias('h', 'help')
    .epilogue([
      'If your app has a single stack, there is no need to specify the stack name',
      'If one of cdk.json or ~/.cdk.json exists, options specified there will be used as defaults. Settings in cdk.json take precedence.'
    ].join('\n\n'))
    .argv;
}
// tslint:enable:no-shadowed-variable max-line-length

async function initCommandLine() {
  const argv = await parseCommandLineArguments();
  if (argv.verbose) {
    setVerbose();
  }

  debug('CDK toolkit version:', VERSION);
  debug('Command line arguments:', argv);

  const aws = new SDK({
    profile: argv.profile,
    proxyAddress: argv.proxy,
    ec2creds: argv.ec2creds,
  });

  const configuration = new Configuration(argumentsToSettings());
  await configuration.load();
  configuration.logDefaults();

  const appStacks = new AppStacks(argv, configuration, aws);

  const renames = parseRenames(argv.rename);

  /** Function to load plug-ins, using configurations additively. */
  function loadPlugins(...settings: Settings[]) {
    const loaded = new Set<string>();
    for (const source of settings) {
      const plugins: string[] = source.get(['plugin']) || [];
      for (const plugin of plugins) {
        const resolved = tryResolve(plugin);
        if (loaded.has(resolved)) { continue; }
        debug(`Loading plug-in: ${colors.green(plugin)} from ${colors.blue(resolved)}`);
        PluginHost.instance.load(plugin);
        loaded.add(resolved);
      }
    }

    function tryResolve(plugin: string): string {
      try {
        return require.resolve(plugin);
      } catch (e) {
        error(`Unable to resolve plugin ${colors.green(plugin)}: ${e.stack}`);
        throw new Error(`Unable to resolve plug-in: ${plugin}`);
      }
    }
  }

  loadPlugins(configuration.combined);

  const cmd = argv._[0];

  // Bundle up global objects so the commands have access to them
  const commandOptions = { args: argv, appStacks, configuration, aws };

  const returnValue = argv.commandHandler ? await argv.commandHandler(commandOptions) : await main(cmd, argv);
  if (typeof returnValue === 'object') {
    return toJsonOrYaml(returnValue);
  } else if (typeof returnValue === 'string') {
    return returnValue;
  } else {
    return returnValue;
  }

  async function main(command: string, args: any): Promise<number | string | {} | void> {
    const toolkitStackName: string = configuration.combined.get(['toolkitStackName']) || DEFAULT_TOOLKIT_STACK_NAME;

    args.STACKS = args.STACKS || [];
    args.ENVIRONMENTS = args.ENVIRONMENTS || [];

    switch (command) {
      case 'ls':
      case 'list':
        return await cliList({ long: args.long });

      case 'diff':
        return await diffStack(await findStack(args.STACK), args.template, args.strict);

      case 'bootstrap':
        return await cliBootstrap(args.ENVIRONMENTS, toolkitStackName, args.roleArn);

      case 'deploy':
        return await cliDeploy(args.STACKS, toolkitStackName, args.roleArn, configuration.combined.get(['requireApproval']));

      case 'destroy':
        return await cliDestroy(args.STACKS, args.force, args.roleArn);

      case 'synthesize':
      case 'synth':
        return await cliSynthesize(args.STACKS, args.interactive, args.output, args.json);

      case 'metadata':
        return await cliMetadata(await findStack(args.STACK));

      case 'init':
        const language = configuration.combined.get(['language']);
        if (args.list) {
          return await printAvailableTemplates(language);
        } else {
          return await cliInit(args.TEMPLATE, language);
        }

      default:
        throw new Error('Unknown command: ' + command);
    }
  }

  async function cliMetadata(stackName: string) {
    const s = await appStacks.synthesizeStack(stackName);
    return s.metadata;
  }

  /**
   * Bootstrap the CDK Toolkit stack in the accounts used by the specified stack(s).
   *
   * @param environmentGlobs environment names that need to have toolkit support
   *             provisioned, as a glob filter. If none is provided,
   *             all stacks are implicitly selected.
   * @param toolkitStackName the name to be used for the CDK Toolkit stack.
   */
  async function cliBootstrap(environmentGlobs: string[], toolkitStackName: string, roleArn: string | undefined): Promise<void> {
    // Two modes of operation.
    //
    // If there is an '--app' argument, we select the environments from the app. Otherwise we just take the user
    // at their word that they know the name of the environment.

    const app = configuration.combined.get(['app']);

    const environments = app ? await globEnvironmentsFromStacks(appStacks, environmentGlobs) : environmentsFromDescriptors(environmentGlobs);

    await Promise.all(environments.map(async (environment) => {
      success(' ⏳  Bootstrapping environment %s...', colors.blue(environment.name));
      try {
        const result = await bootstrapEnvironment(environment, aws, toolkitStackName, roleArn);
        const message = result.noOp ? ' ✅  Environment %s bootstrapped (no changes).'
                      : ' ✅  Environment %s bootstrapped.';
        success(message, colors.blue(environment.name));
      } catch (e) {
        error(' ❌  Environment %s failed bootstrapping: %s', colors.blue(environment.name), e);
        throw e;
      }
    }));
  }

  /**
   * Synthesize the given set of stacks (called when the user runs 'cdk synth')
   *
   * INPUT: Stack names can be supplied using a glob filter. If no stacks are
   * given, all stacks from the application are implictly selected.
   *
   * OUTPUT: If more than one stack ends up being selected, an output directory
   * should be supplied, where the templates will be written.
   */
  async function cliSynthesize(stackNames: string[],
                               doInteractive: boolean,
                               outputDir: string|undefined,
                               json: boolean): Promise<void> {
    const stacks = await appStacks.selectStacks(...stackNames);
    renames.validateSelectedStacks(stacks);

    if (doInteractive) {
      if (stacks.length !== 1) {
        throw new Error(`When using interactive synthesis, must select exactly one stack. Got: ${listStackNames(stacks)}`);
      }
      return await interactive(stacks[0], argv.verbose, (stack) => appStacks.synthesizeStack(stack));
    }

    if (stacks.length > 1 && outputDir == null) {
      // tslint:disable-next-line:max-line-length
      throw new Error(`Multiple stacks selected (${listStackNames(stacks)}), but output is directed to stdout. Either select one stack, or use --output to send templates to a directory.`);
    }

    if (outputDir == null) {
      return stacks[0].template;  // Will be printed in main()
    }

    fs.mkdirpSync(outputDir);

    for (const stack of stacks) {
      const finalName = renames.finalName(stack.name);
      const fileName = `${outputDir}/${finalName}.template.${json ? 'json' : 'yaml'}`;
      highlight(fileName);
      await fs.writeFile(fileName, toJsonOrYaml(stack.template));
    }

    return undefined; // Nothing to print
  }

  async function cliList(options: { long?: boolean } = { }) {
    const stacks = await appStacks.listStacks();

    // if we are in "long" mode, emit the array as-is (JSON/YAML)
    if (options.long) {
      const long = [];
      for (const stack of stacks) {
        long.push({
          name: stack.name,
          environment: stack.environment
        });
      }
      return long; // will be YAML formatted output
    }

    // just print stack names
    for (const stack of stacks) {
      data(stack.name);
    }

    return 0; // exit-code
  }

  async function cliDeploy(stackNames: string[], toolkitStackName: string, roleArn: string | undefined, requireApproval: RequireApproval) {
    if (requireApproval === undefined) { requireApproval = RequireApproval.Broadening; }

    const stacks = await appStacks.selectStacks(...stackNames);
    renames.validateSelectedStacks(stacks);

    for (const stack of stacks) {
      if (stacks.length !== 1) { highlight(stack.name); }
      if (!stack.environment) {
        // tslint:disable-next-line:max-line-length
        throw new Error(`Stack ${stack.name} does not define an environment, and AWS credentials could not be obtained from standard locations or no region was configured.`);
      }
      const toolkitInfo = await loadToolkitInfo(stack.environment, aws, toolkitStackName);
      const deployName = renames.finalName(stack.name);

      if (requireApproval !== RequireApproval.Never) {
        const currentTemplate = await readCurrentTemplate(stack);
        if (printSecurityDiff(currentTemplate, stack, requireApproval)) {
          const confirmed = await confirm(`Do you wish to deploy these changes (y/n)?`);
          if (!confirmed) { throw new Error('Aborted by user'); }
        }
      }

      if (deployName !== stack.name) {
        print('%s: deploying... (was %s)', colors.bold(deployName), colors.bold(stack.name));
      } else {
        print('%s: deploying...', colors.bold(stack.name));
      }

      try {
        const result = await deployStack({ stack, sdk: aws, toolkitInfo, deployName, roleArn });
        const message = result.noOp
          ? ` ✅  %s (no changes)`
          : ` ✅  %s`;

        success('\n' + message, stack.name);

        if (Object.keys(result.outputs).length > 0) {
          print('\nOutputs:');
        }

        for (const name of Object.keys(result.outputs)) {
          const value = result.outputs[name];
          print('%s.%s = %s', colors.cyan(deployName), colors.cyan(name), colors.underline(colors.cyan(value)));
        }

        print('\nStack ARN:');

        data(result.stackArn);
      } catch (e) {
        error('\n ❌  %s failed: %s', colors.bold(stack.name), e);
        throw e;
      }
    }
  }

  async function cliDestroy(stackNames: string[], force: boolean, roleArn: string | undefined) {
    const stacks = await appStacks.selectStacks(...stackNames);
    renames.validateSelectedStacks(stacks);

    if (!force) {
      // tslint:disable-next-line:max-line-length
      const confirmed = await confirm(`Are you sure you want to delete: ${colors.blue(stacks.map(s => s.name).join(', '))} (y/n)?`);
      if (!confirmed) {
        return;
      }
    }

    for (const stack of stacks) {
      const deployName = renames.finalName(stack.name);

      success('%s: destroying...', colors.blue(deployName));
      try {
        await destroyStack({ stack, sdk: aws, deployName, roleArn });
        success('\n ✅  %s: destroyed', colors.blue(deployName));
      } catch (e) {
        error('\n ❌  %s: destroy failed', colors.blue(deployName), e);
        throw e;
      }
    }
  }

  async function diffStack(stackName: string, templatePath: string | undefined, strict: boolean): Promise<number> {
    const stack = await appStacks.synthesizeStack(stackName);
    const currentTemplate = await readCurrentTemplate(stack, templatePath);
    if (printStackDiff(currentTemplate, stack, strict) === 0) {
      return 0;
    } else {
      return 1;
    }
  }

  async function readCurrentTemplate(stack: cxapi.SynthesizedStack, templatePath?: string): Promise<{ [key: string]: any }> {
    if (templatePath) {
      if (!await fs.pathExists(templatePath)) {
        throw new Error(`There is no file at ${templatePath}`);
      }
      const fileContent = await fs.readFile(templatePath, { encoding: 'UTF-8' });
      return parseTemplate(fileContent);
    } else {
      const stackName = renames.finalName(stack.name);
      debug(`Reading existing template for stack ${stackName}.`);

      const cfn = await aws.cloudFormation(stack.environment, Mode.ForReading);
      try {
        const response = await cfn.getTemplate({ StackName: stackName }).promise();
        return (response.TemplateBody && parseTemplate(response.TemplateBody)) || {};
      } catch (e) {
        if (e.code === 'ValidationError' && e.message === `Stack with id ${stackName} does not exist`) {
          return {};
        } else {
          throw e;
        }
      }
    }

    /* Attempt to parse YAML, fall back to JSON. */
    function parseTemplate(text: string): any {
      return deserializeStructure(text);
    }
  }

  /**
   * Match a single stack from the list of available stacks
   */
  async function findStack(name: string): Promise<string> {
    const stacks = await appStacks.selectStacks(name);

    // Could have been a glob so check that we evaluated to exactly one
    if (stacks.length > 1) {
      throw new Error(`This command requires exactly one stack and we matched more than one: ${stacks.map(x => x.name)}`);
    }

    return stacks[0].name;
  }

  /** Convert the command-line arguments into a Settings object */
  function argumentsToSettings() {
    const context: any = {};

    // Turn list of KEY=VALUE strings into an object
    for (const assignment of (argv.context || [])) {
      const parts = assignment.split('=', 2);
      if (parts.length === 2) {
        debug('CLI argument context: %s=%s', parts[0], parts[1]);
        if (parts[0].match(/^aws:.+/)) {
          throw new Error(`User-provided context cannot use keys prefixed with 'aws:', but ${parts[0]} was provided.`);
        }
        context[parts[0]] = parts[1];
      } else {
        warning('Context argument is not an assignment (key=value): %s', assignment);
      }
    }

    return new Settings({
      app: argv.app,
      browser: argv.browser,
      context,
      language: argv.language,
      plugin: argv.plugin,
      toolkitStackName: argv.toolkitStackName,
      versionReporting: argv.versionReporting,
      requireApproval: argv.requireApproval,
      pathMetadata: argv.pathMetadata,
    });
  }

  function toJsonOrYaml(object: any): string {
    return serializeStructure(object, argv.json);
  }
}

initCommandLine()
  .then(value => {
    if (value == null) { return; }
    if (typeof value === 'string') {
      data(value);
    } else if (typeof value === 'number') {
      process.exit(value);
    }
  })
  .catch(err => {
    error(err.message);
    debug(err.stack);
    process.exit(1);
  });
