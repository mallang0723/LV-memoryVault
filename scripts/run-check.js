export function classifyCheck(result, isTest = false) {
 const error = result.error?.code || (result.error ? 'SPAWN_FAILED' : undefined);
 const counts = isTest ? {
  tests: Number(result.stdout?.match(/tests (\d+)/)?.[1] || 0),
  passed: Number(result.stdout?.match(/pass (\d+)/)?.[1] || 0),
  failed: Number(result.stdout?.match(/fail (\d+)/)?.[1] || 0),
 } : {};
 return {exitCode: error || result.status !== 0 || (isTest && (!counts.tests || counts.failed || counts.passed !== counts.tests)) ? 1 : 0, ...counts, ...(error ? {error} : {})};
}
