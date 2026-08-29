import { readFile } from 'node:fs/promises';

const [reportPath] = process.argv.slice(2);
if (reportPath === undefined) throw new Error('Vitest JSON report path is required');

const report = JSON.parse(await readFile(reportPath, 'utf8'));
const failed = count('numFailedTests');
const passed = count('numPassedTests');
const pending = count('numPendingTests');
const total = count('numTotalTests');
const suitesFailed = count('numFailedTestSuites');
const suitesPassed = count('numPassedTestSuites');
const suitesPending = count('numPendingTestSuites');
const suitesTotal = count('numTotalTestSuites');
const testResults = Array.isArray(report.testResults) ? report.testResults : [];
const invalidSuites = testResults.filter((result) => {
  const assertions = Array.isArray(result.assertionResults) ? result.assertionResults : [];
  return (
    result.status !== 'passed' ||
    assertions.length === 0 ||
    assertions.some((assertion) => assertion.status !== 'passed')
  );
}).length;

if (
  report.success !== true ||
  failed !== 0 ||
  pending !== 0 ||
  passed <= 0 ||
  total !== passed ||
  suitesFailed !== 0 ||
  suitesPending !== 0 ||
  suitesPassed <= 0 ||
  suitesTotal !== suitesPassed ||
  testResults.length === 0 ||
  invalidSuites !== 0
) {
  throw new Error(
    `Vitest evidence rejected: success=${String(report.success)} passed=${passed}/${total} ` +
      `failed=${failed} pending=${pending} suites=${suitesPassed}/${suitesTotal} ` +
      `failedSuites=${suitesFailed} pendingSuites=${suitesPending} invalidSuites=${invalidSuites}`,
  );
}

process.stdout.write(
  `${JSON.stringify({ failed, passed, pending, resultFiles: testResults.length, status: 'passed', suitesFailed, suitesPassed, suitesPending, suitesTotal, total })}\n`,
);

function count(field) {
  return Number.isInteger(report[field]) ? report[field] : -1;
}
