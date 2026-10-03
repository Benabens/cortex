import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseBudget,
  parseAndValidateReport,
  runLintCheck,
} from './check-lint.mjs';

function createMockSpawn({ stdout = '', stderr = '', status = 0, error = null }) {
  return () => ({
    stdout,
    stderr,
    status,
    error,
  });
}

function createMockFs(filesMap = {}) {
  return {
    existsSync(p) {
      return Object.prototype.hasOwnProperty.call(filesMap, p);
    },
    readFileSync(p) {
      if (!Object.prototype.hasOwnProperty.call(filesMap, p)) {
        throw new Error(`ENOENT: no such file or directory, open '${p}'`);
      }
      return filesMap[p];
    },
  };
}

const mockResolveEslint = () => '/mock/path/to/eslint/bin/eslint.js';
const mockLogger = {
  log: () => {},
  error: () => {},
};

test('check-lint: sous budget', () => {
  const budget = '210';
  const report = JSON.stringify([
    { filePath: 'src/a.js', errorCount: 100 },
    { filePath: 'src/b.js', errorCount: 50 },
  ]);

  const outcome = runLintCheck({
    budgetPath: '/dummy/.ci/lint-budget',
    fsModule: createMockFs({ '/dummy/.ci/lint-budget': budget }),
    spawnSyncFn: createMockSpawn({ stdout: report, status: 1 }),
    resolveEslintBinFn: mockResolveEslint,
    logger: mockLogger,
  });

  assert.strictEqual(outcome.success, true);
  assert.strictEqual(outcome.totalErrors, 150);
  assert.strictEqual(outcome.budget, 210);
});

test('check-lint: dépassement de budget', () => {
  const budget = '210';
  const report = JSON.stringify([
    { filePath: 'src/a.js', errorCount: 200 },
    { filePath: 'src/b.js', errorCount: 15 },
  ]);

  const outcome = runLintCheck({
    budgetPath: '/dummy/.ci/lint-budget',
    fsModule: createMockFs({ '/dummy/.ci/lint-budget': budget }),
    spawnSyncFn: createMockSpawn({ stdout: report, status: 1 }),
    resolveEslintBinFn: mockResolveEslint,
    logger: mockLogger,
  });

  assert.strictEqual(outcome.success, false);
  assert.strictEqual(outcome.totalErrors, 215);
  assert.strictEqual(outcome.budget, 210);
});

test('check-lint: zéro erreur avec rapport vide ou errorCount = 0', () => {
  const budget = '210';

  const outcomeEmpty = runLintCheck({
    budgetPath: '/dummy/.ci/lint-budget',
    fsModule: createMockFs({ '/dummy/.ci/lint-budget': budget }),
    spawnSyncFn: createMockSpawn({ stdout: '[]', status: 0 }),
    resolveEslintBinFn: mockResolveEslint,
    logger: mockLogger,
  });
  assert.strictEqual(outcomeEmpty.success, true);
  assert.strictEqual(outcomeEmpty.totalErrors, 0);

  const reportZero = JSON.stringify([
    { filePath: 'src/clean.js', errorCount: 0 },
  ]);
  const outcomeZero = runLintCheck({
    budgetPath: '/dummy/.ci/lint-budget',
    fsModule: createMockFs({ '/dummy/.ci/lint-budget': budget }),
    spawnSyncFn: createMockSpawn({ stdout: reportZero, status: 0 }),
    resolveEslintBinFn: mockResolveEslint,
    logger: mockLogger,
  });
  assert.strictEqual(outcomeZero.success, true);
  assert.strictEqual(outcomeZero.totalErrors, 0);
});

test("check-lint: erreur d'exécution et crash", () => {
  const budget = '210';

  assert.throws(
    () => {
      runLintCheck({
        budgetPath: '/dummy/.ci/lint-budget',
        fsModule: createMockFs({ '/dummy/.ci/lint-budget': budget }),
        spawnSyncFn: createMockSpawn({
          stdout: '',
          stderr: 'Invalid ESLint configuration file',
          status: 2,
        }),
        resolveEslintBinFn: mockResolveEslint,
        logger: mockLogger,
      });
    },
    /Crash ou terminaison anormale d'ESLint/
  );

  assert.throws(
    () => {
      runLintCheck({
        budgetPath: '/dummy/.ci/lint-budget',
        fsModule: createMockFs({ '/dummy/.ci/lint-budget': budget }),
        spawnSyncFn: createMockSpawn({
          error: new Error('ENOENT process failed'),
        }),
        resolveEslintBinFn: mockResolveEslint,
        logger: mockLogger,
      });
    },
    /Échec du lancement d'ESLint/
  );
});

test('check-lint: détection de fatalErrorCount', () => {
  const reportWithFatalCount = JSON.stringify([
    { filePath: 'src/crash.js', errorCount: 1, fatalErrorCount: 1 },
  ]);

  assert.throws(
    () => {
      parseAndValidateReport(reportWithFatalCount, 1);
    },
    /erreur\(s\) fatale\(s\)/
  );

  const reportWithFatalMessage = JSON.stringify([
    {
      filePath: 'src/syntax.js',
      errorCount: 1,
      messages: [{ fatal: true, message: 'Parsing error: Unexpected token' }],
    },
  ]);

  assert.throws(
    () => {
      parseAndValidateReport(reportWithFatalMessage, 1);
    },
    /erreur\(s\) fatale\(s\)/
  );
});

test('check-lint: rapport manquant ou invalide', () => {
  assert.throws(
    () => parseAndValidateReport('', 0),
    /Rapport ESLint manquant ou vide/
  );

  assert.throws(
    () => parseAndValidateReport('Internal ESLint Error: broken', 0),
    /Rapport ESLint JSON invalide/
  );

  assert.throws(
    () => parseAndValidateReport('{"errorCount": 5}', 0),
    /doit être un tableau JSON/
  );

  assert.throws(
    () => parseAndValidateReport('[null]', 0),
    /Élément invalide/
  );

  assert.throws(
    () => parseAndValidateReport(JSON.stringify([{ filePath: 'a.js' }]), 0),
    /errorCount invalide/
  );
  assert.throws(
    () => parseAndValidateReport(JSON.stringify([{ filePath: 'a.js', errorCount: '10' }]), 0),
    /errorCount invalide/
  );
  assert.throws(
    () => parseAndValidateReport(JSON.stringify([{ filePath: 'a.js', errorCount: -1 }]), 0),
    /errorCount invalide/
  );
  assert.throws(
    () => parseAndValidateReport(JSON.stringify([{ filePath: 'a.js', errorCount: 1.5 }]), 0),
    /errorCount invalide/
  );

  assert.throws(
    () => parseAndValidateReport('[]', 1),
    /Statut de sortie 1.*aucune erreur/
  );
  assert.throws(
    () => parseAndValidateReport(JSON.stringify([{ filePath: 'a.js', errorCount: 0 }]), 1),
    /Statut de sortie 1.*aucune erreur/
  );
});

test('check-lint: validation stricte du budget', () => {
  assert.strictEqual(parseBudget('210'), 210);
  assert.strictEqual(parseBudget('  0\n'), 0);

  assert.throws(
    () => {
      runLintCheck({
        budgetPath: '/missing/lint-budget',
        fsModule: createMockFs({}),
        spawnSyncFn: createMockSpawn({ stdout: '[]', status: 0 }),
        resolveEslintBinFn: mockResolveEslint,
        logger: mockLogger,
      });
    },
    /Fichier de budget introuvable/
  );

  assert.throws(() => parseBudget(''), /budget est vide/);
  assert.throws(() => parseBudget('   \n  '), /budget est vide/);
  assert.throws(() => parseBudget('NaN'), /Budget invalide/);
  assert.throws(() => parseBudget('abc'), /Budget invalide/);
  assert.throws(() => parseBudget('-1'), /Budget invalide/);
  assert.throws(() => parseBudget('10.5'), /Budget invalide/);
  assert.throws(() => parseBudget(null), /chaîne de caractères/);
});
