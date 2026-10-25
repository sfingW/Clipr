/**
 * Idempotent RPC teardown. A single GPU crash can raise several signals at once
 * (worker.onerror, the in-flight rejection, messageerror). Teardown must run
 * once, reject with WorkerUnavailableError, and never throw on a repeat call.
 */
import { describe, expect, it } from 'vitest';
import { createRpcClient, WorkerUnavailableError, type LlmWorker } from '../src/core/rpc';

type Listener = (ev: { data?: unknown; message?: string }) => void;

/** A fake Worker: records listeners, terminate calls, and posted messages. */
class FakeWorker {
  terminated = 0;
  posted: unknown[] = [];
  private listeners = new Map<string, Set<Listener>>();
  addEventListener(type: string, fn: Listener): void {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type)!.add(fn);
  }
  removeEventListener(type: string, fn: Listener): void {
    this.listeners.get(type)?.delete(fn);
  }
  listenerCount(type: string): number {
    return this.listeners.get(type)?.size ?? 0;
  }
  postMessage(data: unknown): void {
    this.posted.push(data);
  }
  emit(type: string, ev: { data?: unknown; message?: string } = {}): void {
    for (const fn of [...(this.listeners.get(type) ?? [])]) fn(ev);
  }
  terminate(): void {
    this.terminated++;
  }
}

function make(opts: { onCrash?: (e: Error) => void } = {}) {
  const w = new FakeWorker();
  const client = createRpcClient<LlmWorker>(w as unknown as Worker, opts);
  return { w, client };
}

describe('RPC teardown is idempotent', () => {
  it('calling terminate() twice does not throw and terminates the worker once', () => {
    const { w, client } = make();
    expect(() => {
      client.terminate();
      client.terminate();
    }).not.toThrow();
    expect(w.terminated).toBe(1);
    expect(client.status).toBe('dead');
  });

  it('a crash followed by terminate() (and a second crash signal) does not throw', () => {
    const crashes: Error[] = [];
    const { w, client } = make({ onCrash: (e) => crashes.push(e) });
    expect(() => {
      w.emit('error', { message: 'Device was lost' });
      client.terminate();
      w.emit('error', { message: 'Device was lost' });
      w.emit('messageerror', {});
    }).not.toThrow();
    expect(crashes).toHaveLength(1); // onCrash fires once, not per signal
    expect(w.terminated).toBe(1);
    expect(client.status).toBe('dead');
  });

  it('detaches message, error and messageerror listeners on dispose', () => {
    const { w, client } = make();
    expect(w.listenerCount('message')).toBe(1);
    expect(w.listenerCount('error')).toBe(1);
    expect(w.listenerCount('messageerror')).toBe(1);
    client.terminate();
    expect(w.listenerCount('message')).toBe(0);
    expect(w.listenerCount('error')).toBe(0);
    expect(w.listenerCount('messageerror')).toBe(0);
  });

  it('a request after teardown rejects with WorkerUnavailableError and posts nothing', async () => {
    const { w, client } = make();
    client.terminate();
    await expect(client.request('llm.load', { tier: 'full' })).rejects.toBeInstanceOf(WorkerUnavailableError);
    expect(w.posted).toHaveLength(0);
  });
});

describe('worker crash during an in-flight call', () => {
  it('fires onerror mid-request: the pending promise rejects with WorkerUnavailableError', async () => {
    const crashes: Error[] = [];
    const { w, client } = make({ onCrash: (e) => crashes.push(e) });
    const pending = client.request('llm.score', { candidates: [] }, { timeoutMs: 5_000 });
    w.emit('error', { message: 'out of memory' });

    const err = await pending.then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(WorkerUnavailableError);
    expect((err as Error).name).toBe('WorkerUnavailableError');
    expect((err as Error).message).toMatch(/worker error: out of memory/);
    expect(crashes).toHaveLength(1);
    expect(client.status).toBe('dead');
  });

  it('every in-flight request rejects, not only the first', async () => {
    const { w, client } = make();
    const a = client.request('llm.load', { tier: 'full' }, { timeoutMs: 5_000 });
    const b = client.request('llm.score', { candidates: [] }, { timeoutMs: 5_000 });
    w.emit('error', { message: 'Device was lost' });
    await expect(a).rejects.toBeInstanceOf(WorkerUnavailableError);
    await expect(b).rejects.toBeInstanceOf(WorkerUnavailableError);
  });

  it('a messageerror also tears down with WorkerUnavailableError', async () => {
    const { w, client } = make();
    const pending = client.request('llm.load', { tier: 'full' }, { timeoutMs: 5_000 });
    w.emit('messageerror', {});
    await expect(pending).rejects.toBeInstanceOf(WorkerUnavailableError);
    expect(w.terminated).toBe(1);
  });
});
