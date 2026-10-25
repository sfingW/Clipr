/**
 * Tier fallback (WebGPU → CPU). Pure: the workers are replaced by fake RPC
 * clients, so no Worker, WebGPU or model is needed.
 */
import { describe, expect, it, vi } from 'vitest';
import { createFallbackDeps, isGpuFailure, CPU_LOADING_NOTE, GPU_FALLBACK_NOTE } from '../src/pipeline/llmFallback';
import type { LlmWorker, RpcClient } from '../src/core/rpc';
import type { Candidate } from '../src/core/types';

type Engine = 'webllm' | 'transformers';
interface FakeOpts {
  load?: (engine: Engine) => Promise<void>;
  score?: (cands: Candidate[]) => Promise<Candidate[]>;
}

/** A fake worker: records every request and terminate, and behaves as the test says. */
function fakeClient(opts: FakeOpts = {}) {
  const log: Array<{ type: string; engine?: Engine }> = [];
  let terminated = 0;
  const client = {
    request: async (type: string, payload: unknown, reqOpts?: { onProgress?: (p: unknown) => void }) => {
      const engine = (payload as { engine?: Engine }).engine;
      log.push({ type, engine });
      if (type === 'llm.load') {
        reqOpts?.onProgress?.({ pct: 1, note: 'fetching' });
        return opts.load ? opts.load(engine ?? 'webllm') : undefined;
      }
      const cands = (payload as { candidates: Candidate[] }).candidates;
      cands.forEach((_, i) => reqOpts?.onProgress?.({ stage: 'scoring', done: i + 1, total: cands.length }));
      return opts.score ? opts.score(cands) : [];
    },
    terminate: () => {
      terminated++;
    },
  };
  return {
    client: client as unknown as RpcClient<LlmWorker>,
    log,
    get terminated() {
      return terminated;
    },
  };
}

const CAND: Candidate = {
  id: 'c1',
  start: 0,
  end: 10,
  text: 'hello world',
  score: 5,
  reason: '',
  source: 'unscored',
} as unknown as Candidate;

const GPU_LOST = new Error('Device was lost... mapAsync failed');

describe('isGpuFailure', () => {
  it('recognises GPU-class failures', () => {
    expect(isGpuFailure(new Error('Metal command buffer failed: Caused GPU Timeout Error'))).toBe(true);
    expect(isGpuFailure(new Error('Device was lost'))).toBe(true);
    expect(isGpuFailure(new Error('Failed to execute mapAsync on GPUBuffer'))).toBe(true);
    expect(isGpuFailure(new Error('WebGPU out of memory'))).toBe(true);
    expect(isGpuFailure(new Error('worker error: boom'))).toBe(true);
    expect(isGpuFailure(new Error('rpc timeout: llm.load'))).toBe(true);
    expect(isGpuFailure(new Error('WEBGPU_UNAVAILABLE: no gpu'))).toBe(true);
  });

  it('does not treat download or unrelated errors as GPU failures', () => {
    expect(isGpuFailure(new Error('Failed to fetch'))).toBe(false);
    expect(isGpuFailure(new Error('something odd'))).toBe(false);
    expect(isGpuFailure('plain string')).toBe(false);
  });
});

describe('createFallbackDeps: loading', () => {
  it('stays on WebGPU when the load succeeds', async () => {
    const a = fakeClient();
    const spawn = vi.fn(() => a.client);
    const reports: Array<Record<string, unknown>> = [];
    const deps = createFallbackDeps({ preferWebGpu: true, spawn });
    await deps.loadModel((p) => reports.push(p));

    expect(spawn).toHaveBeenCalledTimes(1);
    expect(a.log).toEqual([{ type: 'llm.load', engine: 'webllm' }]);
    expect(reports.some((r) => r.engine === 'webgpu')).toBe(true);
    expect(reports.some((r) => r.note === GPU_FALLBACK_NOTE)).toBe(false);
  });

  it('on a GPU failure during load: terminates the worker, respawns on transformers, and says so', async () => {
    const gpu = fakeClient({
      load: async () => {
        throw GPU_LOST;
      },
    });
    const cpu = fakeClient();
    const spawn = vi.fn().mockReturnValueOnce(gpu.client).mockReturnValueOnce(cpu.client);
    const reports: Array<Record<string, unknown>> = [];
    const deps = createFallbackDeps({ preferWebGpu: true, spawn });
    await deps.loadModel((p) => reports.push(p));

    expect(gpu.terminated).toBe(1);
    expect(spawn).toHaveBeenCalledTimes(2);
    expect(cpu.log).toEqual([{ type: 'llm.load', engine: 'transformers' }]);
    expect(reports.some((r) => r.note === GPU_FALLBACK_NOTE)).toBe(true);
    expect(reports.some((r) => r.note === CPU_LOADING_NOTE && r.engine === 'cpu')).toBe(true);
  });

  it('with preferWebGpu=false: starts on CPU directly and never requests WebGPU', async () => {
    const cpu = fakeClient();
    const spawn = vi.fn(() => cpu.client);
    const reports: Array<Record<string, unknown>> = [];
    const deps = createFallbackDeps({ preferWebGpu: false, spawn });
    await deps.loadModel((p) => reports.push(p));

    expect(cpu.log).toEqual([{ type: 'llm.load', engine: 'transformers' }]);
    expect(reports[0]).toMatchObject({ engine: 'cpu', note: CPU_LOADING_NOTE });
    expect(reports.some((r) => r.note === GPU_FALLBACK_NOTE)).toBe(false);
  });

  it('a non-GPU load error (e.g. download) is rethrown without a fallback', async () => {
    const gpu = fakeClient({
      load: async () => {
        throw new Error('Failed to fetch');
      },
    });
    const spawn = vi.fn(() => gpu.client);
    const deps = createFallbackDeps({ preferWebGpu: true, spawn });
    await expect(deps.loadModel(() => undefined)).rejects.toThrow('Failed to fetch');
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  it('a failure on CPU is rethrown: there is no third tier inside the engine layer', async () => {
    const cpu = fakeClient({
      load: async () => {
        throw new Error('Failed to fetch');
      },
    });
    const spawn = vi.fn(() => cpu.client);
    const deps = createFallbackDeps({ preferWebGpu: false, spawn });
    await expect(deps.loadModel(() => undefined)).rejects.toThrow('Failed to fetch');
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  it('after a successful load, a second loadModel does not reload the model', async () => {
    const a = fakeClient();
    const deps = createFallbackDeps({ preferWebGpu: true, spawn: () => a.client });
    await deps.loadModel(() => undefined);
    await deps.score([CAND], () => undefined, () => undefined);
    expect(a.log.filter((x) => x.type === 'llm.load')).toHaveLength(1);
  });
});

describe('createFallbackDeps: scoring', () => {
  it('a mid-run GPU failure: terminates, reloads on CPU, and re-scores the full pass', async () => {
    const gpu = fakeClient({
      score: async () => {
        throw new Error('Metal command buffer failed: Caused GPU Timeout Error');
      },
    });
    const cpuScored: Candidate = { ...CAND, score: 7, source: 'scored' } as Candidate;
    const cpu = fakeClient({ score: async () => [cpuScored] });
    const spawn = vi.fn().mockReturnValueOnce(gpu.client).mockReturnValueOnce(cpu.client);
    const reports: Array<Record<string, unknown>> = [];
    const deps = createFallbackDeps({ preferWebGpu: true, spawn });

    await deps.loadModel(() => undefined);
    // Load on the GPU worker succeeded, so the failure is in the scoring call.
    const out = await deps.score([CAND, CAND], () => undefined, (p) => reports.push(p));

    expect(gpu.terminated).toBe(1);
    expect(cpu.log.map((x) => x.type)).toEqual(['llm.load', 'llm.score']);
    expect(out).toEqual([cpuScored]);
    expect(reports.some((r) => r.note === GPU_FALLBACK_NOTE)).toBe(true);
  });

  it('after a fallback, the session stays on CPU: the next run does not spawn a GPU worker', async () => {
    const gpu = fakeClient({
      load: async () => {
        throw GPU_LOST;
      },
    });
    const cpu = fakeClient({ score: async (c) => c });
    const spawn = vi.fn().mockReturnValueOnce(gpu.client).mockReturnValueOnce(cpu.client);
    const deps = createFallbackDeps({ preferWebGpu: true, spawn });
    await deps.loadModel(() => undefined);
    await deps.score([CAND], () => undefined, () => undefined);

    expect(spawn).toHaveBeenCalledTimes(2);
    expect(cpu.log.filter((x) => x.type === 'llm.score')).toHaveLength(1);
  });

  it('a non-GPU scoring error is rethrown without a fallback', async () => {
    const a = fakeClient({ score: async () => { throw new Error('bad reply'); } });
    const spawn = vi.fn(() => a.client);
    const deps = createFallbackDeps({ preferWebGpu: true, spawn });
    await deps.loadModel(() => undefined);
    await expect(deps.score([CAND], () => undefined, () => undefined)).rejects.toThrow('bad reply');
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  it('reports scoring progress as done/total', async () => {
    const done: Array<[number, number]> = [];
    const a = fakeClient({ score: async (c) => c });
    const deps = createFallbackDeps({ preferWebGpu: false, spawn: () => a.client });
    await deps.loadModel(() => undefined);
    await deps.score([CAND], (d, t) => done.push([d, t]), () => undefined);
    expect(done).toEqual([[1, 1]]);
  });
});
