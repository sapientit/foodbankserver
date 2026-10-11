import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';
import { fileURLToPath, URL } from 'node:url';

const script = fileURLToPath(new URL('./require-pushed.mjs', import.meta.url));

let root = '';
let work = '';

function git(cwd, ...args) {
  return execFileSync(
    'git',
    ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', ...args],
    { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
  ).trim();
}

function requirePushed() {
  return spawnSync(process.execPath, [script], { cwd: work, encoding: 'utf8' });
}

function assertRefused(pattern) {
  const result = requirePushed();
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, pattern);
}

// A clone of a local bare "GitHub" with one commit pushed on main.
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'foodbank-require-pushed-'));
  git(root, 'init', '-q', '--bare', '-b', 'main', 'origin.git');
  git(root, 'clone', '-q', 'origin.git', 'work');
  work = join(root, 'work');
  writeFileSync(join(work, 'file'), 'one\n');
  git(work, 'add', 'file');
  git(work, 'commit', '-q', '-m', 'one');
  git(work, 'push', '-q', '-u', 'origin', 'main');
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

test('allows a clean branch that matches GitHub', () => {
  const result = requirePushed();
  assert.equal(result.status, 0, result.stderr);
});

test('refuses uncommitted changes', () => {
  writeFileSync(join(work, 'file'), 'changed\n');
  assertRefused(/uncommitted changes/);
});

test('refuses a commit that is not pushed', () => {
  git(work, 'commit', '-q', '--allow-empty', '-m', 'local');
  assertRefused(/is not pushed to GitHub/);
});

test('refuses a branch behind GitHub', () => {
  git(root, 'clone', '-q', 'origin.git', 'other');
  git(join(root, 'other'), 'commit', '-q', '--allow-empty', '-m', 'theirs');
  git(join(root, 'other'), 'push', '-q');
  assertRefused(/branch main is 1 commit\(s\) behind GitHub/);
});

test('refuses a branch that tracks nothing on GitHub', () => {
  git(work, 'checkout', '-q', '-b', 'untracked');
  assertRefused(/branch untracked does not track a GitHub branch/);
});

// A promotion deploys an older pushed commit from a detached worktree.
test('allows a detached checkout of a pushed commit, even an older one', () => {
  git(work, 'commit', '-q', '--allow-empty', '-m', 'two');
  git(work, 'push', '-q');
  git(work, 'checkout', '-q', '--detach', 'HEAD~1');
  const result = requirePushed();
  assert.equal(result.status, 0, result.stderr);
});

test('refuses a detached checkout of an unpushed commit', () => {
  git(work, 'checkout', '-q', '--detach');
  git(work, 'commit', '-q', '--allow-empty', '-m', 'local');
  assertRefused(/is not pushed to GitHub/);
});
