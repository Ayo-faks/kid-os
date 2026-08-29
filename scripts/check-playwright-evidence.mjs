import { readFile } from 'node:fs/promises';

const [reportPath, ...arguments_] = process.argv.slice(2);
const countOptionIndex = arguments_.indexOf('--tests-per-project');
const testsPerProject = Number(arguments_[countOptionIndex + 1]);
const requiredProjects = arguments_.filter(
  (_, index) => index !== countOptionIndex && index !== countOptionIndex + 1,
);
if (
  reportPath === undefined ||
  countOptionIndex === -1 ||
  !Number.isInteger(testsPerProject) ||
  testsPerProject <= 0 ||
  requiredProjects.length === 0 ||
  new Set(requiredProjects).size !== requiredProjects.length
) {
  throw new Error(
    'Usage: node scripts/check-playwright-evidence.mjs <report.json> ' +
      '--tests-per-project <count> <required-project>...',
  );
}

const report = JSON.parse(await readFile(reportPath, 'utf8'));
const expected = Number(report.stats?.expected ?? -1);
const flaky = Number(report.stats?.flaky ?? -1);
const skipped = Number(report.stats?.skipped ?? -1);
const unexpected = Number(report.stats?.unexpected ?? -1);
const reportErrors = Array.isArray(report.errors) ? report.errors.length : -1;
const tests = [];

function collectTests(suites) {
  for (const suite of suites ?? []) {
    collectTests(suite.suites);
    for (const spec of suite.specs ?? []) {
      for (const test of spec.tests ?? []) tests.push(test);
    }
  }
}

collectTests(report.suites);

const projectCounts = Object.fromEntries(requiredProjects.map((project) => [project, 0]));
const unexpectedProjects = new Set();
let invalidResults = 0;
for (const test of tests) {
  if (Object.hasOwn(projectCounts, test.projectName)) {
    projectCounts[test.projectName] += 1;
  } else {
    unexpectedProjects.add(String(test.projectName));
  }
  const statuses = Array.isArray(test.results) ? test.results.map((result) => result.status) : [];
  if (
    test.expectedStatus !== 'passed' ||
    statuses.length === 0 ||
    statuses.some((status) => status !== 'passed')
  ) {
    invalidResults += 1;
  }
}

const invalidProjectCounts = requiredProjects.filter(
  (project) => projectCounts[project] !== testsPerProject,
);
const expectedTotal = requiredProjects.length * testsPerProject;
if (
  expected !== expectedTotal ||
  expected !== tests.length ||
  flaky !== 0 ||
  skipped !== 0 ||
  unexpected !== 0 ||
  reportErrors !== 0 ||
  invalidResults !== 0 ||
  invalidProjectCounts.length !== 0 ||
  unexpectedProjects.size !== 0
) {
  throw new Error(
    `Playwright evidence rejected: expected=${expected} tests=${tests.length} skipped=${skipped} ` +
      `flaky=${flaky} unexpected=${unexpected} reportErrors=${reportErrors} ` +
      `invalidResults=${invalidResults} invalidProjectCounts=${invalidProjectCounts.join(',') || 'none'} ` +
      `unexpectedProjects=${[...unexpectedProjects].join(',') || 'none'}`,
  );
}

process.stdout.write(
  `${JSON.stringify({ expected, flaky, projectCounts, skipped, status: 'passed', testsPerProject, unexpected })}\n`,
);
