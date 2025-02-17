import * as chalk from 'chalk';
import { execSync } from 'child_process';
import * as fs from 'fs';
import * as inquirer from 'inquirer';
import { Answers, Question } from 'inquirer';
import { join } from 'path';
import { Input } from '../commands';
import { defaultGitIgnore } from '../lib/configuration/defaults';
import {
  AbstractPackageManager,
  PackageManager,
  PackageManagerFactory,
} from '../lib/package-managers';
import { generateInput, generateSelect } from '../lib/questions/questions';
import { GitRunner } from '../lib/runners/git.runner';
import {
  AbstractCollection,
  Collection,
  CollectionFactory,
  SchematicOption,
} from '../lib/schematics';
import { EMOJIS, MESSAGES } from '../lib/ui';
import { normalizeToKebabOrSnakeCase } from '../lib/utils/formatting';
import { AbstractAction } from './abstract.action';
import { ClassPrisma } from '../lib/prisma';
import { ClassUserService } from '../lib/service-user';
import { ClassFixtures } from '../lib/fixtures';

export class NewAction extends AbstractAction {
  public async handle(inputs: Input[], options: Input[]) {
    const directoryOption = options.find(
      (option) => option.name === 'directory',
    );
    const dryRunOption = options.find((option) => option.name === 'dry-run');
    const isDryRunEnabled = dryRunOption && dryRunOption.value;

    await askForMissingInformation(inputs, options);
    await generateApplicationFiles(inputs, options).catch(exit);

    const shouldSkipInstall = options.some(
      (option) => option.name === 'skip-install' && option.value === true,
    );

    const shouldSkipGit = options.some(
      (option) => option.name === 'skip-git' && option.value === true,
    );

    const shouldInitializePrima = options.some(
      (option) => option.name === 'prisma' && option.value === 'yes',
    );

    const shouldInitializeUserService = options.some(
      (option) => option.name === 'userService' && option.value === 'yes',
    );

    const shouldInitializeFixtures = options.some(
      (option) => option.name === 'fixtures' && option.value === 'yes',
    );

    const projectDirectory = getProjectDirectory(
      getApplicationNameInput(inputs)!,
      directoryOption,
    );

    if (!shouldSkipInstall) {
      await installPackages(
        options,
        isDryRunEnabled as boolean,
        projectDirectory,
        shouldInitializePrima as boolean,
        shouldInitializeUserService as boolean,
      );

      await createPrismaFiles(
        options,
        isDryRunEnabled as boolean,
        projectDirectory,
        shouldInitializePrima as boolean,
      );

      await createUserService(
        isDryRunEnabled as boolean,
        projectDirectory,
        shouldInitializeUserService as boolean,
      );
    }

    if (!isDryRunEnabled) {
      if (!shouldSkipGit) {
        await initializeGitRepository(projectDirectory);
        await createGitIgnoreFile(projectDirectory);
      }

      //pass shouldInitializeFixtures if we make this an option in the future
      await createFixtures(isDryRunEnabled as boolean, projectDirectory, true);

      printCollective();
    }
    process.exit(0);
  }
}

const getApplicationNameInput = (inputs: Input[]) =>
  inputs.find((input) => input.name === 'name');

const getPackageManagerInput = (inputs: Input[]) =>
  inputs.find((options) => options.name === 'packageManager');

const getPrismaInput = (inputs: Input[]) =>
  inputs.find((options) => options.name === 'prisma');

const getUserServiceInput = (inputs: Input[]) =>
  inputs.find((options) => options.name === 'userService');

const getFixturesInput = (inputs: Input[]) =>
  inputs.find((options) => options.name === 'fixtures');

const getProjectDirectory = (
  applicationName: Input,
  directoryOption?: Input,
): string => {
  return (
    (directoryOption && (directoryOption.value as string)) ||
    normalizeToKebabOrSnakeCase(applicationName.value as string)
  );
};

const askForMissingInformation = async (inputs: Input[], options: Input[]) => {
  console.info(MESSAGES.PROJECT_INFORMATION_START);
  console.info();

  const prompt: inquirer.PromptModule = inquirer.createPromptModule();

  const nameInput = getApplicationNameInput(inputs);
  if (!nameInput!.value) {
    const message = 'What name would you like to use for the new project?';
    const questions = [generateInput('name', message)('nest-app')];
    const answers: Answers = await prompt(questions as ReadonlyArray<Question>);
    replaceInputMissingInformation(inputs, answers);
  }

  const prismaInput = getPrismaInput(options);
  if (!prismaInput!.value) {
    const answers = await askForPrisma();
    replaceInputMissingInformation(options, answers);
  }

  const userServiceInput = getUserServiceInput(options);
  if (!userServiceInput!.value) {
    const answers = await askForUserService();
    replaceInputMissingInformation(options, answers);
  }

  const packageManagerInput = getPackageManagerInput(options);
  if (!packageManagerInput!.value) {
    const answers = await askForPackageManager();
    replaceInputMissingInformation(options, answers);
  }

  //UNCOMMENT THE FOLLOWING FUNCTION IF WE WANT TO MAKE THIS AN OPTION IN THE FUTURE

  // const fixturesInput = getFixturesInput(options);
  // if (!fixturesInput!.value) {
  //   const answers = await askForFixtures();
  //   replaceInputMissingInformation(options, answers);
  // }
};

const replaceInputMissingInformation = (
  inputs: Input[],
  answers: Answers,
): Input[] => {
  return inputs.map(
    (input) =>
      (input.value =
        input.value !== undefined ? input.value : answers[input.name]),
  );
};

const generateApplicationFiles = async (args: Input[], options: Input[]) => {
  const collectionName = options.find(
    (option) => option.name === 'collection' && option.value != null,
  )!.value;
  const collection: AbstractCollection = CollectionFactory.create(
    (collectionName as Collection) || Collection.NESTJS,
  );
  const schematicOptions: SchematicOption[] = mapSchematicOptions(
    args.concat(options),
  );
  await collection.execute('application', schematicOptions);
  console.info();
};

const mapSchematicOptions = (options: Input[]): SchematicOption[] => {
  return options.reduce(
    (schematicOptions: SchematicOption[], option: Input) => {
      if (option.name !== 'skip-install') {
        schematicOptions.push(new SchematicOption(option.name, option.value));
      }
      return schematicOptions;
    },
    [],
  );
};

const installPackages = async (
  options: Input[],
  dryRunMode: boolean,
  installDirectory: string,
  shouldInitializePrima: boolean,
  shouldInitialzeUserService: boolean,
) => {
  const inputPackageManager = getPackageManagerInput(options)!.value as string;

  let packageManager: AbstractPackageManager;
  if (dryRunMode) {
    console.info();
    console.info(chalk.green(MESSAGES.DRY_RUN_MODE));
    console.info();
    return;
  }

  try {
    packageManager = PackageManagerFactory.create(inputPackageManager);
    await packageManager.install(
      installDirectory,
      inputPackageManager,
      shouldInitializePrima,
      shouldInitialzeUserService,
    );
  } catch (error) {
    if (error && error.message) {
      console.error(chalk.red(error.message));
    }
  }
};

const createPrismaFiles = async (
  options: Input[],
  dryRunMode: boolean,
  createDirectory: string,
  shouldInitializePrima: boolean,
) => {
  if (!shouldInitializePrima) {
    return;
  }
  if (dryRunMode) {
    console.info();
    console.info(chalk.green(MESSAGES.DRY_RUN_MODE));
    console.info();
    return;
  }

  const inputPackageManager = getPackageManagerInput(options)!.value as string;
  const prismaInstance = new ClassPrisma();

  try {
    await prismaInstance.create(createDirectory, inputPackageManager);
  } catch (error) {
    console.error('could not generate the prisma files successfully');
  }
};

const createUserService = async (
  dryRunMode: boolean,
  createDirectory: string,
  shouldInitializeUserService: boolean,
) => {
  if (!shouldInitializeUserService) {
    return;
  }

  if (dryRunMode) {
    console.info();
    console.info(chalk.green(MESSAGES.DRY_RUN_MODE));
    console.info();
    return;
  }

  const userServiceInstance = new ClassUserService();
  try {
    await userServiceInstance.create(createDirectory);
  } catch (error) {
    console.error(
      'could not update the app.module file with user-service file',
    );
  }
};

const createFixtures = async (
  dryRunMode: boolean,
  createDirectory: string,
  shouldInitializeFixtures: boolean,
) => {
  if (!shouldInitializeFixtures) {
    return;
  }

  if (dryRunMode) {
    console.info();
    console.info(chalk.green(MESSAGES.DRY_RUN_MODE));
    console.info();
    return;
  }

  //THIS WILL CREATE THE FILES STEP BY STEP, FIRST IT WILL CREATE THE HUSKY FILES
  //THEN IT WILL CREATE THE .sh AND DOCKER RELATED FILES
  //THEN IT WILL CREATE THE .github FILE
  //THEN IT WILL CREATE THE .devcontainer FILE

  const fixturesInstance = new ClassFixtures();
  try {
    await fixturesInstance.create(createDirectory);
  } catch (error) {
    console.error('could create the necessary files for user fixtures');
  }
};

const askForPackageManager = async (): Promise<Answers> => {
  const questions: Question[] = [
    generateSelect('packageManager')(MESSAGES.PACKAGE_MANAGER_QUESTION)([
      PackageManager.NPM,
      PackageManager.YARN,
      PackageManager.PNPM,
    ]),
  ];
  const prompt = inquirer.createPromptModule();
  return await prompt(questions);
};

const askForPrisma = async (): Promise<Answers> => {
  const questions: Question[] = [
    generateSelect('prisma')(MESSAGES.PRISMA_QUESTION)(['yes', 'no']),
  ];
  const prompt = inquirer.createPromptModule();
  return await prompt(questions);
};

const askForUserService = async (): Promise<Answers> => {
  const questions: Question[] = [
    generateSelect('userService')(MESSAGES.USER_SERVICE_QUESTION)([
      'yes',
      'no',
    ]),
  ];
  const prompt = inquirer.createPromptModule();
  return await prompt(questions);
};

const askForFixtures = async (): Promise<Answers> => {
  const questions: Question[] = [
    generateSelect('fixtures')(MESSAGES.FIXTURES_QUESTION)(['yes', 'no']),
  ];
  const prompt = inquirer.createPromptModule();
  return await prompt(questions);
};

const initializeGitRepository = async (dir: string) => {
  const runner = new GitRunner();
  await runner.run('init', true, join(process.cwd(), dir)).catch(() => {
    console.error(chalk.red(MESSAGES.GIT_INITIALIZATION_ERROR));
  });
};

/**
 * Write a file `.gitignore` in the root of the newly created project.
 * `.gitignore` available in `@nestjs/schematics` cannot be published to
 * NPM (needs to be investigated).
 *
 * @param dir Relative path to the project.
 * @param content (optional) Content written in the `.gitignore`.
 *
 * @return Resolves when succeeds, or rejects with any error from `fn.writeFile`.
 */
const createGitIgnoreFile = (dir: string, content?: string) => {
  const fileContent = content || defaultGitIgnore;
  const filePath = join(process.cwd(), dir, '.gitignore');

  if (fileExists(filePath)) {
    return;
  }
  return fs.promises.writeFile(filePath, fileContent);
};

const printCollective = () => {
  const dim = print('dim');
  const yellow = print('yellow');
  const emptyLine = print();

  emptyLine();
  yellow(`Thanks for installing Nest ${EMOJIS.PRAY}`);
  dim('Please consider donating to our open collective');
  dim('to help us maintain this package.');
  emptyLine();
  emptyLine();
  print()(
    `${chalk.bold(`${EMOJIS.WINE}  Donate:`)} ${chalk.underline(
      'https://opencollective.com/nest',
    )}`,
  );
  emptyLine();
};

const print =
  (color: string | null = null) =>
  (str = '') => {
    const terminalCols = retrieveCols();
    const strLength = str.replace(/\u001b\[[0-9]{2}m/g, '').length;
    const leftPaddingLength = Math.floor((terminalCols - strLength) / 2);
    const leftPadding = ' '.repeat(Math.max(leftPaddingLength, 0));
    if (color) {
      str = (chalk as any)[color](str);
    }
    console.log(leftPadding, str);
  };

export const retrieveCols = () => {
  const defaultCols = 80;
  try {
    const terminalCols = execSync('tput cols', {
      stdio: ['pipe', 'pipe', 'ignore'],
    });
    return parseInt(terminalCols.toString(), 10) || defaultCols;
  } catch {
    return defaultCols;
  }
};

const fileExists = (path: string) => {
  try {
    fs.accessSync(path);
    return true;
  } catch (err: any) {
    if (err.code === 'ENOENT') {
      return false;
    }

    throw err;
  }
};

export const exit = () => process.exit(1);
