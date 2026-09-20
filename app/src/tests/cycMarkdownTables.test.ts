import {describe, expect, test} from 'vitest';
import {snippetMessage} from '../features/chat/messages/fileMessages';
import {renderMarkdown} from '../features/media/pageRenderer';
import {setFormatted} from '../features/chat/content';
import {parseMarkdownDocument} from '../features/content/markdown';

function expectTable(root: ParentNode) {
  const table = root.querySelector('table');
  expect(table).not.toBeNull();
  expect(table?.querySelector('thead > tr > th')?.textContent).toBe('Name');
  expect(table?.querySelector('tbody > tr > td')?.textContent).toBe('Ada');
}

describe('Markdown tables', () => {
  const source = 'Name | Value\n--- | ---\nAda | longunbrokenvalue';

  test('renders tables in ordinary conversation messages', () => {
    const message = document.createElement('div');
    setFormatted(message, source);

    expectTable(message);
    expect(message.querySelector('.cyc-snippet-table-wrap.cyc-overflower')).not.toBeNull();
  });

  test('renders Show markdown snippets with the same table structure', () => {
    const message = snippetMessage(
      {
        id: 'm1',
        role: 'claude',
        kind: 'text',
        text: '',
        ts: 0,
        file: {
          docId: 'show-table',
          name: 'report.md',
          fileKind: 'markdown',
          size: source.length,
          inline: true,
          content: source
        }
      },
      true,
      true
    );

    expectTable(message);
    expect(message.querySelector('.cyc-snippet-table-wrap.cyc-overflower')).not.toBeNull();
  });

  test('renders full markdown files with a semantic table head and body', () => {
    const article = renderMarkdown(
      parseMarkdownDocument('| Name | Value |\n| --- | --- |\n| Ada | longunbrokenvalue |').nodes
    );

    expectTable(article);
    expect(article.querySelector('thead')).not.toBeNull();
    expect(article.querySelector('tbody')).not.toBeNull();
  });
});
