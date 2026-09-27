import assert from 'node:assert/strict';
import { mkdir, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { chromium } from 'playwright';
import {
  fixtureBytes as bytes,
  fixturePayload as payload,
  startFilePublicationFixture,
} from './file-publication-fixture.mjs';

test(
  'a published file renders and downloads through the live cat message channel without a refresh',
  { timeout: 120_000 },
  async () => {
    const fixture = await startFilePublicationFixture();
    let browser;
    try {
      browser = await chromium.launch({ headless: true, executablePath: process.env.CAT_CAFE_TEST_CHROMIUM_PATH });
      const page = await browser.newPage();
      const errors = [];
      page.on('pageerror', (error) => errors.push(error.message));
      let navigations = 0;
      page.on('framenavigated', (frame) => {
        if (frame === page.mainFrame()) navigations++;
      });
      await page.goto(fixture.url);
      await page.getByRole('heading', { name: '合成附件实时发布验证' }).waitFor();
      await page.waitForFunction(() => window.readPublishedMessages);
      const deadline = Date.now() + 10_000;
      while (!fixture.joined() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
      assert.ok(fixture.joined(), 'real socket joined its thread room');
      assert.equal(await page.locator('a[download]').count(), 0);
      const publish = async () => {
        const pending = page.waitForResponse((response) => response.url().endsWith('/fixture/publish'));
        await page.getByRole('button', { name: '发布合成附件', exact: true }).click();
        const response = await pending;
        assert.equal(response.status(), 200, await response.text());
        return response.json();
      };
      const receipt = await publish();
      const link = page.getByRole('link', { name: '下载', exact: true });
      await link.waitFor({ state: 'visible', timeout: 10_000 });
      assert.equal(await link.getAttribute('href'), receipt.url);
      const messages = await page.evaluate(() => window.readPublishedMessages());
      assert.equal(messages[0].id, receipt.messageId);
      assert.equal(messages[0].type, 'assistant');
      assert.equal(messages[0].catId, 'codex');
      assert.equal(fixture.messageStore.getById(receipt.messageId).extra.rich.blocks[0].url, receipt.url);
      const downloadPromise = page.waitForEvent('download');
      await link.click();
      const download = await downloadPromise;
      assert.equal(download.suggestedFilename(), payload.fileName);
      assert.deepEqual(await readFile(await download.path()), bytes);
      assert.deepEqual(await publish(), receipt);
      assert.equal(await page.locator('a[download]').count(), 1);
      assert.equal(navigations, 1, 'no page reload or navigation repaired the message');
      assert.equal(fixture.historyReads(), 0, 'no history API repaired the message');
      assert.deepEqual(errors, []);
      const evidenceDir = process.env.CAT_CAFE_BROWSER_EVIDENCE_DIR;
      if (evidenceDir) {
        await mkdir(evidenceDir, { recursive: true });
        await page.screenshot({ path: path.join(evidenceDir, 'file-publication-live.png'), fullPage: true });
      }
      console.log(
        JSON.stringify({
          liveCardVisible: true,
          downloadedSha256: payload.sha256,
          navigations,
          historyReads: fixture.historyReads(),
          duplicateCards: false,
        }),
      );
    } finally {
      await browser?.close();
      await fixture.close();
      await rm(fixture.dir, { recursive: true, force: true });
    }
  },
);
