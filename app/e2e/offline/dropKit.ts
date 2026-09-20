import type {JSHandle, Page} from '@playwright/test';

// A synthetic file drag for the offline rig. Playwright has no native file
// drag, so the spec builds a DataTransfer carrying one File inside the page
// (its `types` then includes 'Files', which is the pane's dragHasFiles() gate)
// and dispatches the drag events on the target with it.

export async function fileTransfer(page: Page, name = 'notes.txt'): Promise<JSHandle<DataTransfer>> {
  return page.evaluateHandle((name) => {
    const dt = new DataTransfer();
    dt.items.add(new File(['hello from the drop rig'], name, {type: 'text/plain'}));
    return dt;
  }, name);
}

// Hover a file over `sel` (dragenter, then the steady-state dragover).
export async function dragFilesOver(page: Page, sel: string, name?: string): Promise<void> {
  const dataTransfer = await fileTransfer(page, name);
  await page.dispatchEvent(sel, 'dragenter', {dataTransfer});
  await page.dispatchEvent(sel, 'dragover', {dataTransfer});
}

// Let go of the file over `sel`.
export async function dropFiles(page: Page, sel: string, name?: string): Promise<void> {
  const dataTransfer = await fileTransfer(page, name);
  await page.dispatchEvent(sel, 'drop', {dataTransfer});
}

// Move the drag out of the pane (relatedTarget null = off the window).
export async function dragFilesOut(page: Page, sel: string): Promise<void> {
  await page.dispatchEvent(sel, 'dragleave', {relatedTarget: null});
}
