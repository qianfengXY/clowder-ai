import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { saveFileBufferToUploadDir } from '../src/utils/file-storage.js';

test('failed and concurrent writes never expose partial final bytes or poison a retry', async (t) => {
  const uploadDir = await fs.mkdtemp(join(tmpdir(), 'atomic-file-test-'));
  const input = {
    uploadDir,
    filenameStem: 'same-key',
    originalFilename: 'test.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from('complete synthetic bytes'),
  };
  const destination = join(uploadDir, 'same-key.txt');
  const original = fs.writeFile;
  let release: () => void = () => {};
  let started: () => void = () => {};
  const partialWritten = new Promise<void>((resolve) => {
    started = resolve;
  });
  const resume = new Promise<void>((resolve) => {
    release = resolve;
  });
  let first = true;
  const mocked = t.mock.method(fs, 'writeFile', async (target, bytes, options) => {
    if (!first) return original(target, bytes, options);
    first = false;
    await original(target, bytes.subarray(0, 4), options);
    started();
    await resume;
    throw Object.assign(new Error('synthetic disk write failure'), { code: 'EIO' });
  });
  syncBuiltinESMExports();
  try {
    const failed = saveFileBufferToUploadDir(input);
    const rejected = assert.rejects(failed, /synthetic disk write failure/);
    await partialWritten;
    // A reader must see absence or complete bytes, never the writer's prefix.
    const during = await fs.readFile(destination).catch((error) => {
      assert.equal(error.code, 'ENOENT');
      return null;
    });
    await saveFileBufferToUploadDir(input);
    const concurrentBytes = await fs.readFile(destination);
    release();
    await rejected;
    assert.equal(during, null, 'partial bytes must not occupy the final path');
    assert.deepEqual(concurrentBytes, input.buffer, 'a concurrent retry sees only complete bytes');
    await Promise.all([saveFileBufferToUploadDir(input), saveFileBufferToUploadDir(input)]);
    assert.deepEqual(await fs.readFile(destination), input.buffer, 'retry recovers the same key');
    assert.deepEqual(await fs.readdir(uploadDir), ['same-key.txt']);
    const other = { ...input, buffer: Buffer.from('different bytes') };
    await saveFileBufferToUploadDir(other);
    assert.deepEqual(await fs.readFile(destination), input.buffer, 'existing bytes are never overwritten');
  } finally {
    release();
    mocked.mock.restore();
    syncBuiltinESMExports();
    await fs.rm(uploadDir, { recursive: true, force: true });
  }
});
