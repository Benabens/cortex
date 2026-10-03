#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

export function resolveEslintBin(fromDir = process.cwd()) {
  const candidateDirs = [
    fromDir,
    path.dirname(fileURLToPath(import.meta.url)),
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'),
  ];

  for (const dir of candidateDirs) {
    try {
      const req = createRequire(path.join(dir, 'package.json'));
      try {
        return req.resolve('eslint/bin/eslint.js');
      } catch {
        const pkgPath = req.resolve('eslint/package.json');
        const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
        const binField = pkg.bin;
        const binRel = typeof binField === 'string' ? binField : binField?.eslint;
        if (binRel) {
          return path.resolve(path.dirname(pkgPath), binRel);
        }
      }
    } catch {
      // Poursuivre vers le dossier candidat suivant
    }
  }

  throw new Error("Impossible de localiser l'exécutable ESLint local.");
}

export function parseBudget(rawContent) {
  if (typeof rawContent !== 'string') {
    throw new Error('Le contenu du budget doit être une chaîne de caractères.');
  }
  const trimmed = rawContent.trim();
  if (trimmed === '') {
    throw new Error('Le fichier de budget est vide.');
  }
  if (!/^\d+$/.test(trimmed)) {
    throw new Error(`Budget invalide : "${trimmed}". Un entier positif ou nul est attendu.`);
  }
  const budget = Number(trimmed);
  if (!Number.isSafeInteger(budget) || budget < 0) {
    throw new Error(`Budget hors limites : "${trimmed}".`);
  }
  return budget;
}

export function readBudget(budgetPath, fsModule = fs) {
  if (!fsModule.existsSync(budgetPath)) {
    throw new Error(`Fichier de budget introuvable : ${budgetPath}`);
  }
  const content = fsModule.readFileSync(budgetPath, 'utf8');
  return parseBudget(content);
}

export function parseAndValidateReport(stdout, status) {
  if (typeof stdout !== 'string' || stdout.trim() === '') {
    throw new Error('Rapport ESLint manquant ou vide.');
  }

  let report;
  try {
    report = JSON.parse(stdout);
  } catch (err) {
    throw new Error(`Rapport ESLint JSON invalide : ${err.message}`);
  }

  if (!Array.isArray(report)) {
    throw new Error('Le rapport ESLint doit être un tableau JSON.');
  }

  let totalErrors = 0;
  let totalFatalErrors = 0;

  for (let i = 0; i < report.length; i++) {
    const item = report[i];
    if (!item || typeof item !== 'object') {
      throw new Error(`Élément invalide dans le rapport ESLint à l'index ${i}.`);
    }

    const { errorCount, fatalErrorCount, messages } = item;

    if (
      typeof errorCount !== 'number' ||
      !Number.isSafeInteger(errorCount) ||
      errorCount < 0
    ) {
      throw new Error(
        `errorCount invalide pour "${item.filePath || `élément ${i}`}" : ${errorCount}. Un entier positif ou nul est requis.`
      );
    }

    let fileFatalErrors = 0;
    if (fatalErrorCount !== undefined && fatalErrorCount !== null) {
      if (
        typeof fatalErrorCount !== 'number' ||
        !Number.isSafeInteger(fatalErrorCount) ||
        fatalErrorCount < 0
      ) {
        throw new Error(
          `fatalErrorCount invalide pour "${item.filePath || `élément ${i}`}" : ${fatalErrorCount}. Un entier positif ou nul est requis.`
        );
      }
      fileFatalErrors = fatalErrorCount;
    } else if (Array.isArray(messages)) {
      for (const msg of messages) {
        if (msg && msg.fatal === true) {
          fileFatalErrors += 1;
        }
      }
    }

    totalFatalErrors += fileFatalErrors;
    totalErrors += errorCount;
  }

  if (totalFatalErrors > 0) {
    throw new Error(
      `ESLint a signalé ${totalFatalErrors} erreur(s) fatale(s) de configuration ou d'analyse.`
    );
  }

  if (status === 1 && totalErrors === 0) {
    throw new Error(
      "Statut de sortie 1 retourné par ESLint alors qu'aucune erreur n'a été détectée dans le rapport."
    );
  }

  return totalErrors;
}

export function getDefaultBudgetPath(cwd = process.cwd(), fsModule = fs) {
  const directPath = path.resolve(cwd, '.ci/lint-budget');
  if (fsModule.existsSync(directPath)) {
    return directPath;
  }
  const scriptDirPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'lint-budget');
  if (fsModule.existsSync(scriptDirPath)) {
    return scriptDirPath;
  }
  return directPath;
}

export function runLintCheck(options = {}) {
  const {
    cwd = process.cwd(),
    budgetPath = getDefaultBudgetPath(cwd, options.fsModule || fs),
    args = null,
    spawnSyncFn = spawnSync,
    resolveEslintBinFn = resolveEslintBin,
    fsModule = fs,
    logger = console,
  } = options;

  const budget = readBudget(budgetPath, fsModule);
  const eslintBin = resolveEslintBinFn(cwd);

  const passedArgs = args ?? (process.argv.slice(2).length > 0 ? process.argv.slice(2) : ['.']);
  const finalArgs = passedArgs.includes('--format') || passedArgs.includes('-f')
    ? passedArgs
    : [...passedArgs, '--format', 'json'];

  const result = spawnSyncFn(process.execPath, [eslintBin, ...finalArgs], {
    cwd,
    encoding: 'utf8',
    shell: false,
    maxBuffer: 16 * 1024 * 1024,
  });

  if (result.error) {
    throw new Error(`Échec du lancement d'ESLint : ${result.error.message}`);
  }

  if (result.status !== 0 && result.status !== 1) {
    const details = result.stderr?.trim() || result.stdout?.trim() || 'aucun détail';
    throw new Error(
      `Crash ou terminaison anormale d'ESLint (code de sortie : ${result.status}) : ${details}`
    );
  }

  const totalErrors = parseAndValidateReport(result.stdout, result.status);

  if (totalErrors > budget) {
    const msg = `Échec du lint : ${totalErrors} erreur(s) détectée(s), dépassant le budget maximal autorisé de ${budget}.`;
    logger.error(msg);
    return { success: false, totalErrors, budget, message: msg };
  }

  const msg = `Succès du lint : ${totalErrors} erreur(s) détectée(s) (budget maximal autorisé : ${budget}).`;
  logger.log(msg);
  return { success: true, totalErrors, budget, message: msg };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  try {
    const outcome = runLintCheck();
    if (!outcome.success) {
      process.exit(1);
    }
  } catch (err) {
    console.error(`Erreur : ${err.message}`);
    process.exit(1);
  }
}
