import type {FullConfig, FullResult, Reporter, Suite, TestCase} from '@playwright/test/reporter';
import {filtered, keyOf} from '../guard-common';

const FLOOR = 185;

// Screenshot hygiene, so a green run can also be believed by `git status`:
// - toHaveScreenshot baselines live in `<spec>-snapshots/` and only change under
//   `--update-snapshots` (Playwright's own flag; a normal run compares).
// - Evidence PNGs under e2e/screenshots/ are written through rig.ts
//   evidenceShot(): a normal run attaches them to the report under test-results/
//   and never touches the tree; the tracked copy is refreshed only under the same
//   `--update-snapshots`, narrowed to the spec whose evidence you mean to refresh.
// Two consecutive full runs must leave `git status --porcelain e2e` empty.

const KNOWN_SKIPS: Record<string, string> = {};

class OfflineGuard implements Reporter {
  private config: FullConfig | null = null;
  private projects: string[] = [];
  private collected = 0;
  private skipped: string[] = [];
  private ran = new Set<string>();

  onBegin(config: FullConfig, suite: Suite) {
    this.config = config;
    this.projects = config.projects.map((p) => p.name);
    this.collected = suite.allTests().length;
  }

  onTestEnd(test: TestCase, result: {status: string}) {
    const key = keyOf(test, this.projects);
    if (result.status === 'skipped') this.skipped.push(key);
    else this.ran.add(key);
  }

  async onEnd(result: FullResult) {
    const narrowed = this.config ? filtered(this.config) : null;
    const problems: string[] = [];

    for (const key of this.skipped) {
      if (!(key in KNOWN_SKIPS)) {
        problems.push(
          `SKIPPED, and not in KNOWN_SKIPS: ${key}\n` +
            '  A skipped test guarded nothing on this run. Either fix the rig so it ' +
            'runs, or turn the skip into a failure naming what is missing, or add it ' +
            "to KNOWN_SKIPS in e2e/offline/guard.ts with a reason and today's date."
        );
      }
    }

    for (const [key, why] of Object.entries(KNOWN_SKIPS)) {
      if (this.ran.has(key)) {
        problems.push(
          `STALE KNOWN_SKIPS entry: ${key}\n  It ran normally this time, so the ` +
            `allowance is out of date and must be deleted. It said: ${why}`
        );
      }
    }

    if (narrowed) {
      console.log(
        `\noffline guard note: this run was narrowed (${narrowed}), so the ` +
          `count floor does not apply. Collected ${this.collected}, floor is ${FLOOR}.`
      );
    } else if (this.collected < FLOOR) {
      problems.push(
        `THE COUNT DROPPED. This run collected ${this.collected} tests; a full run ` +
          `has to collect at least ${FLOOR}. ${FLOOR - this.collected} tests have ` +
          'disappeared -- a renamed file, a bad testMatch, a describe that never ' +
          'registered, or a spec that stopped parsing all look exactly like a healthy ' +
          'green run. If they were deleted on purpose, lower FLOOR in ' +
          'e2e/offline/guard.ts in the same commit, read off --list.'
      );
    } else if (this.collected > FLOOR) {
      problems.push(
        `THE COUNT ROSE. This run collected ${this.collected} tests and FLOOR is ` +
          `${FLOOR}, so ${this.collected - FLOOR} test` +
          `${this.collected - FLOOR > 1 ? 's are' : ' is'} outside the floor's ` +
          'protection: they could all disappear again and this guard would say nothing ' +
          'that stops a run.\n' +
          `  Set FLOOR = ${this.collected} in e2e/offline/guard.ts, in the commit that ` +
          'added them.'
      );
    }

    if (problems.length) {
      console.error('\n' + '='.repeat(72));
      console.error('OFFLINE GUARD FAILED THE RUN');
      console.error('The tests above may all have passed; the run still cannot be believed.\n');
      for (const p of problems) console.error(`- ${p}\n`);
      console.error('='.repeat(72));
      result.status = 'failed';
    }
  }
}

export default OfflineGuard;
