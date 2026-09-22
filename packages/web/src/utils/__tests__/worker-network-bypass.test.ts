// @vitest-environment node
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { runInNewContext } from 'node:vm';
import { transformSync } from 'esbuild';
import { describe, expect, it, vi } from 'vitest';

describe('Service Worker request ownership', () => {
  it('bypasses all live API and polling methods, leaving documents and static assets to Workbox', () => {
    const source = readFileSync(resolve('worker/network-bypass.ts'), 'utf8');
    const listeners: Array<(event: unknown) => void> = [];
    runInNewContext(transformSync(source, { loader: 'ts', format: 'iife' }).code, {
      URL,
      self: { addEventListener: (_: string, listener: (event: unknown) => void) => listeners.push(listener) },
    });
    expect(listeners).toHaveLength(1);
    for (const method of ['GET', 'POST', 'DELETE']) {
      for (const path of ['/api/health', '/api/threads/t/queue', '/socket.io/?transport=polling', '/socket.io']) {
        const stopImmediatePropagation = vi.fn();
        const respondWith = vi.fn();
        listeners[0]({
          request: { url: `https://example.test${path}`, method },
          stopImmediatePropagation,
          respondWith,
        });
        expect(stopImmediatePropagation).toHaveBeenCalledTimes(1);
        expect(respondWith).not.toHaveBeenCalled();
      }
    }
    for (const path of ['/', '/thread/t', '/_next/static/app.js', '/socket.io.png', '/my/api/example']) {
      const stopImmediatePropagation = vi.fn();
      listeners[0]({ request: { url: `https://example.test${path}` }, stopImmediatePropagation });
      expect(stopImmediatePropagation).not.toHaveBeenCalled();
    }
  });
});
