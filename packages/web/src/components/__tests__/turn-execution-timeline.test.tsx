import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { TurnExecutionTimeline } from '../TurnExecutionTimeline';

describe('TurnExecutionTimeline', () => {
  it('renders a collapsed completed summary with verified phase and tool durations', () => {
    const html = renderToStaticMarkup(
      <TurnExecutionTimeline
        timeline={{
          v: 1,
          startedAt: 1_000,
          completedAt: 5_000,
          status: 'completed',
          steps: [
            { key: 'request_accepted', startedAt: 1_000, completedAt: 1_200, status: 'completed' },
            { key: 'carrier_acquire_warm', startedAt: 1_200, completedAt: 1_500, status: 'completed' },
            { key: 'first_text', startedAt: 2_500, completedAt: 5_000, status: 'completed' },
            { key: 'completed', startedAt: 5_000, completedAt: 5_000, status: 'completed' },
          ],
        }}
        toolEvents={[
          {
            id: 'tool-start',
            type: 'tool_use',
            label: 'CodeX → Read',
            toolName: 'Read',
            toolUseId: 'tool-1',
            timestamp: 2_000,
            startTimeMs: 2_000,
          },
          {
            id: 'tool-end',
            type: 'tool_result',
            label: 'CodeX ← Read',
            toolName: 'Read',
            toolUseId: 'tool-1',
            timestamp: 2_750,
            endTimeMs: 2_750,
            status: 'completed',
          },
        ]}
      />,
    );

    expect(html).toContain('执行过程 4.0s');
    expect(html).toContain('首段文字 1.5s');
    expect(html).toContain('app-server 热复用');
    expect(html).toContain('Read');
    expect(html).toContain('750ms');
    expect(html).not.toContain('<details open=""');
  });

  it('keeps a running timeline expanded without fabricating missing durations', () => {
    const html = renderToStaticMarkup(
      <TurnExecutionTimeline
        timeline={{
          v: 1,
          startedAt: 10_000,
          status: 'running',
          steps: [{ key: 'request_accepted', startedAt: 10_000, status: 'running' }],
        }}
        now={12_000}
      />,
    );

    expect(html).toContain('<details open=""');
    expect(html).toContain('执行过程 2.0s');
    expect(html).not.toContain('首段文字');
  });

  it('omits legacy tool duration unless an explicit start/end pair exists', () => {
    const html = renderToStaticMarkup(
      <TurnExecutionTimeline
        timeline={{
          v: 1,
          startedAt: 10_000,
          completedAt: 12_000,
          status: 'completed',
          steps: [
            { key: 'request_accepted', startedAt: 10_000, completedAt: 12_000, status: 'completed' },
            { key: 'completed', startedAt: 12_000, completedAt: 12_000, status: 'completed' },
          ],
        }}
        toolEvents={[
          {
            id: 'legacy-start',
            type: 'tool_use',
            label: 'CodeX → Read',
            toolUseId: 'legacy-tool',
            timestamp: 10_500,
          },
          {
            id: 'legacy-end',
            type: 'tool_result',
            label: 'CodeX ← Read',
            toolUseId: 'legacy-tool',
            timestamp: 11_500,
          },
        ]}
      />,
    );

    expect(html).toContain('工具 · Read');
    expect(html).not.toContain('1.0s');
  });

  it('shows terminal failure without exposing tool details or raw results', () => {
    const html = renderToStaticMarkup(
      <TurnExecutionTimeline
        timeline={{
          v: 1,
          startedAt: 20_000,
          completedAt: 21_000,
          status: 'failed',
          steps: [
            { key: 'request_accepted', startedAt: 20_000, completedAt: 21_000, status: 'failed' },
            { key: 'failed', startedAt: 21_000, completedAt: 21_000, status: 'failed' },
          ],
        }}
        toolEvents={[
          {
            id: 'private-start',
            type: 'tool_use',
            label: 'CodeX → Shell',
            detail: 'token=never-render-this',
            toolUseId: 'private-tool',
            toolName: 'Shell',
            startTimeMs: 20_100,
            timestamp: 20_100,
          },
          {
            id: 'private-end',
            type: 'tool_result',
            label: 'CodeX ← Shell',
            detail: 'raw-result-never-render-this',
            toolUseId: 'private-tool',
            toolName: 'Shell',
            status: 'error',
            endTimeMs: 20_600,
            timestamp: 20_600,
          },
        ]}
      />,
    );

    expect(html).toContain('执行失败');
    expect(html).toContain('工具 · Shell');
    expect(html).toContain('500ms');
    expect(html).not.toContain('token=never-render-this');
    expect(html).not.toContain('raw-result-never-render-this');
  });
});
