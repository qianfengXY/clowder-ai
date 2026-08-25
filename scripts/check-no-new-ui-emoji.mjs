#!/usr/bin/env node

/**
 * F056 debt-freeze guard: reject raw emoji added to production Web JSX/TSX.
 *
 * Existing glyphs are intentionally outside this incremental gate. Tests,
 * fixtures, and non-rendering TS/JS helpers are also outside its UI boundary.
 */

import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const RAW_EMOJI = /\p{Extended_Pictographic}/u;
const UI_EXTENSION = /\.(?:jsx|tsx)$/u;
const NON_PRODUCTION_SEGMENT = /\/(?:__fixtures__|__tests__|fixtures|test|tests)\//u;
const NON_PRODUCTION_BASENAME = /\.(?:fixture|spec|stories|story|test)\.(?:jsx|tsx)$/u;

function requestedBase() {
  const baseIndex = process.argv.indexOf('--base');
  if (baseIndex === -1) return process.env.NO_NEW_UI_EMOJI_BASE || 'origin/main';
  const base = process.argv[baseIndex + 1];
  if (!base || base.startsWith('--')) throw new Error('--base requires a Git revision');
  return base;
}

function git(args) {
  return execFileSync('git', args, {
    cwd: repoRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 30_000,
  });
}

function isProductionUiPath(filePath) {
  return (
    filePath.startsWith('packages/web/src/') &&
    UI_EXTENSION.test(filePath) &&
    !NON_PRODUCTION_SEGMENT.test(filePath) &&
    !NON_PRODUCTION_BASENAME.test(filePath)
  );
}

function changedProductionUiFiles(base) {
  return git(['diff', '--name-only', '-z', '--diff-filter=ACMR', `${base}...HEAD`, '--', 'packages/web/src'])
    .split('\0')
    .filter(Boolean)
    .filter(isProductionUiPath);
}

function addedEmojiLines(base, filePath) {
  const diff = git(['diff', '--unified=0', '--no-color', `${base}...HEAD`, '--', filePath]);
  const findings = [];
  let newLineNumber = 0;

  for (const line of diff.split('\n')) {
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/u.exec(line);
    if (hunk) {
      newLineNumber = Number.parseInt(hunk[1], 10);
      continue;
    }
    if (line.startsWith('+++') || line.startsWith('---') || line.startsWith('diff ') || line.startsWith('index ')) {
      continue;
    }
    if (line.startsWith('+')) {
      const content = line.slice(1);
      if (RAW_EMOJI.test(content)) findings.push({ filePath, lineNumber: newLineNumber, content: content.trim() });
      newLineNumber += 1;
      continue;
    }
    if (!line.startsWith('-') && line.length > 0) newLineNumber += 1;
  }

  return findings;
}

function main() {
  try {
    const base = requestedBase();
    const files = changedProductionUiFiles(base);
    const findings = files.flatMap((filePath) => addedEmojiLines(base, filePath));

    if (findings.length === 0) {
      console.log(`✅ No new raw UI emoji detected (${files.length} production JSX/TSX file(s) inspected).`);
      return;
    }

    console.error('❌ New raw emoji detected in production Web UI:');
    for (const finding of findings) {
      console.error(`  ${finding.filePath}:${finding.lineNumber}  ${finding.content}`);
    }
    console.error('Use a designed SVG/asset, or keep parser/test fixtures outside production JSX/TSX.');
    process.exitCode = 1;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    console.error(`❌ Unable to inspect UI diff: ${detail}`);
    process.exitCode = 1;
  }
}

main();
