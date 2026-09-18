import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { setImmediate as nextTurn } from 'node:timers/promises';
import {
  mergeTranscriptEventSources,
  mergeTranscriptEventSourcesAsync,
} from '../dist/domains/cats/services/session/transcript/TranscriptEventEnvelope.js';
import { TranscriptWriter } from '../dist/domains/cats/services/session/transcript/TranscriptWriter.js';

const envelope = (eventNo, invocationId = 'inv', event = { type: 'text', content: 'same' }) => ({
  v: 1,
  t: 1,
  threadId: 't',
  catId: 'c',
  sessionId: 's',
  invocationId,
  eventNo,
  event,
});

test('empty-source reads avoid serializing payloads while preserving numbering', async () => {
  const event = envelope(9, 'inv', {
    toJSON() {
      throw new Error('unnecessary serialization');
    },
  });
  assert.equal(mergeTranscriptEventSources([], [event])[0].eventNo, 0);
  assert.equal((await mergeTranscriptEventSourcesAsync([], [event]))[0].eventNo, 0);
  assert.equal((await mergeTranscriptEventSourcesAsync([event], []))[0].eventNo, 9);
});

test('cooperative merge keeps duplicate counts, invocation identity, order and supplemental priority', async () => {
  const primary = [envelope(0, 'old'), envelope(1), envelope(2), envelope(3, 'other')];
  const supplemental = [envelope(0), envelope(1, 'new')];
  assert.deepEqual(
    await mergeTranscriptEventSourcesAsync(primary, supplemental),
    mergeTranscriptEventSources(primary, supplemental),
  );
});

test('large merges yield to I/O and abort without finishing obsolete work', async () => {
  const primary = Array.from({ length: 2048 }, (_, i) => envelope(i, String(i)));
  const controller = new AbortController();
  const pending = mergeTranscriptEventSourcesAsync(primary, primary, controller.signal);
  await nextTurn();
  controller.abort();
  await assert.rejects(pending, { name: 'AbortError' });
});

test('live-file reads can be canceled, tolerate malformed rows, and stay fresh after appends', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'transcript-read-responsiveness-'));
  const writer = new TranscriptWriter({ dataDir: dir });
  const session = { sessionId: 's', threadId: 't', catId: 'c', seq: 0 };
  try {
    const sub = join(dir, 'threads/t/c/sessions/s');
    await mkdir(sub, { recursive: true });
    const lines = Array.from({ length: 4096 }, (_, i) => JSON.stringify(envelope(i, String(i))));
    await writeFile(join(sub, 'events.live.jsonl'), `${lines.join('\n')}\nmalformed\n`);
    const controller = new AbortController();
    const pending = writer.readActiveEvents(session, controller.signal);
    controller.abort();
    await assert.rejects(pending, { name: 'AbortError' });
    assert.equal((await writer.readActiveEvents(session)).length, 4096);
    writer.appendEvent(session, { type: 'done' }, 'new');
    const fresh = await writer.readActiveEvents(session);
    assert.equal(fresh.length, 4097);
    assert.equal(fresh.at(-1).invocationId, 'new');
    assert.equal(fresh.at(-1).eventNo, 4096);
  } finally {
    await writer.drainPendingWrites();
    await rm(dir, { recursive: true, force: true });
  }
});
