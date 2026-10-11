// Refuses a deploy unless the checkout is exactly what is on GitHub: nothing
// uncommitted, HEAD on a branch at origin, and a checked-out branch not behind
// origin. More than one person works on this repository, so what is deployed
// has to be a commit everyone can find, and deploying from a branch that is
// behind would replace someone else's deployed work with an older tree.
//
// A detached checkout is a promotion's worktree at a chosen commit, where
// "behind" means nothing; the promotion checks its own ordering.
import { execFileSync } from 'node:child_process';

function git(...args) {
  return execFileSync('git', args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function refuse(reason) {
  console.error(`refusing to deploy: ${reason}`);
  process.exit(1);
}

function tryGit(...args) {
  try {
    return git(...args);
  } catch {
    return undefined;
  }
}

if (git('status', '--porcelain') !== '') {
  refuse('there are uncommitted changes. Commit and push them, then deploy.');
}
if (tryGit('fetch', '-q', 'origin') === undefined) {
  refuse('could not fetch from GitHub to check the commit is pushed.');
}
const head = git('rev-parse', '--short', 'HEAD');
if (git('branch', '-r', '--contains', 'HEAD') === '') {
  refuse(`commit ${head} is not pushed to GitHub. Push it, then deploy.`);
}
const branch = tryGit('symbolic-ref', '-q', '--short', 'HEAD');
if (branch !== undefined) {
  if (tryGit('rev-parse', '-q', '--verify', '@{u}') === undefined) {
    refuse(`branch ${branch} does not track a GitHub branch.`);
  }
  const behind = git('rev-list', '--count', 'HEAD..@{u}');
  if (behind !== '0') {
    refuse(
      `branch ${branch} is ${behind} commit(s) behind GitHub. Pull, check, push, then deploy.`,
    );
  }
}
