/** Invented test-engine data. Same shape as live sessions/tabs. Not from user history. */

export type TestTurn = {user: string; reply: string; agoMs: number};

/** One rich message appended after the turns: a voice clip, a doc chip, or an inline snippet. */
export type TestExtraMessage = {
  role: 'user' | 'claude';
  agoMs: number;
  text?: string;
  voice?: {durationS: number};
  file?: {
    name: string;
    fileKind: 'markdown' | 'diff' | 'text' | 'binary';
    size: number;
    inline?: boolean;
    content?: string;
  };
};

export type TestSessionFixture = {
  id: string;
  name: string;
  unread?: number;
  thinking?: boolean;
  turns: TestTurn[];
  extras?: TestExtraMessage[];
};

export type TestHostFixture = {
  engineKey: string;
  tabId: string;
  label: string;
  detail: string;
  sessions: TestSessionFixture[];
};

const hour = 3600_000;
const minute = 60_000;

export const TEST_FIXTURE_NAMES = ['Relay Server', 'Metrics Dashboard', 'Recipe Scraper'] as const;

/** Host A: few chats. These names are what offline Playwright waits for. */
const workshop: TestHostFixture = {
  engineKey: 'test-workshop',
  tabId: 'tab-workshop',
  label: 'workshop',
  detail: 'test host',
  sessions: [
    {
      id: 'test-relay',
      name: 'Relay Server',
      turns: [
        {
          user: 'Is the relay accepting peers?',
          reply: 'Yes. Last health check passed.',
          agoMs: 4 * hour
        },
        {
          user: 'Restart it after the deploy.',
          reply: 'Restarted. Two peers reconnected.',
          agoMs: 2 * hour
        }
      ]
    },
    {
      id: 'test-metrics',
      name: 'Metrics Dashboard',
      unread: 1,
      turns: [
        {
          user: 'Add a CPU chart to the panel.',
          reply: 'Added. Refresh the dashboard.',
          agoMs: 6 * hour
        },
        {
          user: 'Why is the 5xx rate up?',
          reply: 'One worker is restarting. Others are fine.',
          agoMs: 90 * minute
        }
      ]
    },
    {
      id: 'test-recipes',
      name: 'Recipe Scraper',
      turns: [
        {
          user: 'Parse the ingredients list.',
          reply: 'Three items: flour, water, salt.',
          agoMs: 24 * hour
        }
      ]
    }
  ]
};

/** Host B: many more chats so list/scroll/search have something to show. */
const lab: TestHostFixture = {
  engineKey: 'test-lab',
  tabId: 'tab-lab',
  label: 'lab',
  detail: 'test host',
  sessions: [
    {
      id: 'test-build',
      name: 'Build Pipeline',
      turns: [
        {
          user: 'Why did CI go red?',
          reply: 'The lint step failed on an unused import.',
          agoMs: 3 * hour
        }
      ]
    },
    {
      id: 'test-docs',
      name: 'Docs Site',
      turns: [
        {
          user: 'Publish the changelog.',
          reply: 'Published. Link is on the docs index.',
          agoMs: 5 * hour
        }
      ]
    },
    {
      id: 'test-invoices',
      name: 'Invoice Parser',
      unread: 2,
      turns: [
        {
          user: 'Extract vendor names.',
          reply: 'Four vendors. None look duplicated.',
          agoMs: 40 * minute
        }
      ]
    },
    {
      id: 'test-load',
      name: 'Load Test',
      turns: [
        {user: 'Run 200 virtual users.', reply: 'Done. p95 stayed under 240ms.', agoMs: 8 * hour}
      ]
    },
    {
      id: 'test-tokens',
      name: 'Design Tokens',
      turns: [{user: 'List the spacing scale.', reply: '4, 8, 12, 16, 24, 32.', agoMs: 12 * hour}]
    },
    {
      id: 'test-oncall',
      name: 'Oncall Bot',
      thinking: true,
      turns: [
        {
          user: 'Who is on call this week?',
          reply: 'Alex is primary. Sam is backup.',
          agoMs: 15 * minute
        }
      ]
    },
    {
      id: 'test-schema',
      name: 'Schema Migrator',
      turns: [
        {user: 'Is the users table locked?', reply: 'No. The migration is online.', agoMs: 7 * hour}
      ]
    },
    {
      id: 'test-cache',
      name: 'Cache Warmer',
      turns: [
        {user: 'Warm the catalog keys.', reply: 'Warmed 1,200 keys. 3 misses.', agoMs: 9 * hour}
      ]
    },
    {
      id: 'test-auth',
      name: 'Auth Gateway',
      turns: [
        {
          user: 'Rotate the signing key.',
          reply: 'Rotated. Old key valid for one hour.',
          agoMs: 11 * hour
        }
      ]
    },
    {
      id: 'test-weekly',
      name: 'Weekly Report',
      turns: [
        {
          user: 'Draft the status mail.',
          reply: 'Draft ready. Three bullets, one risk.',
          agoMs: 30 * hour
        }
      ]
    },
    {
      id: 'test-images',
      name: 'Image Resizer',
      turns: [
        {user: 'Keep EXIF on thumbs?', reply: 'No. Thumbs drop EXIF on purpose.', agoMs: 14 * hour}
      ]
    },
    {
      id: 'test-logs',
      name: 'Log Tailer',
      unread: 4,
      turns: [
        {
          user: 'Any 5xx in the last hour?',
          reply: 'Two. Both from the same worker.',
          agoMs: 10 * minute
        }
      ]
    },
    {
      id: 'test-formatting',
      name: 'Formatting Sampler',
      turns: [
        {
          user: 'Summarize the deploy checklist.',
          reply:
            '## Deploy checklist\n' +
            '**Ready** to ship when:\n' +
            '- the build is green\n' +
            '- the `vite` bundle is under budget\n' +
            '- the docs index links the changelog\n\n' +
            '> Ship before lunch or wait for tomorrow.',
          agoMs: 2 * hour
        },
        {
          user: 'Show me the retry helper.',
          reply:
            'Here it is:\n\n' +
            '```ts\n' +
            'export async function retry<T>(fn: () => Promise<T>, times = 3): Promise<T> {\n' +
            '  let err: unknown;\n' +
            '  for (let i = 0; i < times; i++) {\n' +
            '    try {\n' +
            '      return await fn();\n' +
            '    } catch (e) {\n' +
            '      err = e;\n' +
            '    }\n' +
            '  }\n' +
            '  throw err;\n' +
            '}\n' +
            '```',
          agoMs: 1 * hour
        }
      ]
    },
    {
      id: 'test-attachments',
      name: 'Attachment Sampler',
      turns: [
        {user: 'Send the runbook and the diff.', reply: 'Coming up, three files.', agoMs: 3 * hour}
      ],
      extras: [
        {
          role: 'claude',
          agoMs: 2 * hour,
          text: 'The oncall runbook notes.',
          file: {name: 'runbook-notes.txt', fileKind: 'text', size: 8123}
        },
        {
          role: 'claude',
          agoMs: 100 * minute,
          file: {
            name: 'CHANGES.md',
            fileKind: 'markdown',
            size: 640,
            inline: true,
            content: '## 0.4.2\n- faster boot\n- smaller stylesheet\n- one less page flag\n'
          }
        },
        {
          role: 'claude',
          agoMs: 95 * minute,
          file: {
            name: 'relay.ts.diff',
            fileKind: 'diff',
            size: 420,
            inline: true,
            content:
              '@@ -1,4 +1,4 @@\n' +
              '-const retries = 2;\n' +
              '+const retries = 3;\n' +
              ' const backoffMs = 250;\n' +
              ' export {retries, backoffMs};\n'
          }
        }
      ]
    },
    {
      id: 'test-voice',
      name: 'Voice Sampler',
      turns: [
        {
          user: 'I will send the next one as audio.',
          reply: 'Go ahead, I will transcribe it.',
          agoMs: 4 * hour
        }
      ],
      extras: [
        {
          role: 'user',
          agoMs: 3 * hour,
          voice: {durationS: 7},
          text: 'Voice check: is the relay healthy after the restart?'
        },
        {
          role: 'claude',
          agoMs: 175 * minute,
          text: 'Heard you clearly. The relay is healthy and both peers are back.'
        },
        {
          role: 'user',
          agoMs: 30 * minute,
          voice: {durationS: 7},
          text: 'Hi'
        }
      ]
    }
  ]
};

export const TEST_HOSTS: TestHostFixture[] = [workshop, lab];
