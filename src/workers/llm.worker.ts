/**
 * LLM worker (SPEC §8.6): WebLLM (SmolLM2) scores candidate windows; it never
 * generates clips. Runs entirely in the browser on WebGPU: no server, no API
 * key. The model is downloaded from the WebLLM model host on first use and
 * cached by the library thereafter.
 *
 * The prompt, lenient JSON parsing and retry rules live in pipeline/scoring.ts
 * (pure, and unit tested); this file only wires them to the engine.
 */
import { CreateMLCEngine, type MLCEngine } from '@mlc-ai/web-llm';
import { serveRpc, type LlmWorker as LlmMethods, type RpcServerContext } from '../core/rpc';
import { scoreWithRetry, LLM_CONTEXT_WINDOW, MAX_TOKENS } from '../pipeline/scoring';

/** SPEC §8.6 / §11: the full-tier scoring model. */
export const LLM_MODEL_ID = 'SmolLM2-360M-Instruct-q4f16_1-MLC';

/** One engine per worker. A failed load is cleared so a retry can run. */
let enginePromise: Promise<MLCEngine> | null = null;

function loadEngine(ctx: RpcServerContext): Promise<MLCEngine> {
  if (enginePromise) return enginePromise;
  const p = (async (): Promise<MLCEngine> => {
    if (!('gpu' in navigator)) {
      throw new Error('WEBGPU_UNAVAILABLE: navigator.gpu is missing in this worker');
    }
    ctx.progress(0, { stage: 'llm_loading', note: 'loading model' });
    return CreateMLCEngine(
      LLM_MODEL_ID,
      {
        initProgressCallback: (report) => {
          ctx.progress(Math.min(99, Math.round(report.progress * 100)), {
            stage: 'llm_loading',
            note: report.text,
          });
        },
      },
      // Smaller KV cache: the model's default window (4096) exhausts GPU memory.
      { context_window_size: LLM_CONTEXT_WINDOW },
    );
  })();
  enginePromise = p;
  p.catch(() => {
    if (enginePromise === p) enginePromise = null;
  });
  return p;
}

async function score(
  payload: LlmMethods['llm.score']['payload'],
  ctx: RpcServerContext,
): Promise<LlmMethods['llm.score']['result']> {
  const engine = await loadEngine(ctx);
  const total = payload.candidates.length;
  const out: LlmMethods['llm.score']['result'] = [];

  for (let i = 0; i < total; i++) {
    const c = payload.candidates[i];
    // Each window is scored in isolation: no chat history carries over, so the
    // KV cache never grows across the ~170 windows of a long video.
    await engine.resetChat();
    const generate = async (prompt: string, temperature: number): Promise<string> => {
      const reply = await engine.chat.completions.create({
        messages: [{ role: 'user', content: prompt }],
        temperature,
        max_tokens: MAX_TOKENS,
      });
      return reply.choices[0]?.message?.content ?? '';
    };
    // A stalled window is interrupted and scored at the default, so the job moves on.
    const result = await scoreWithRetry(generate, c.text, {
      onTimeout: () => {
        void engine.interruptGenerate().catch(() => undefined);
      },
    });
    out.push({ ...c, score: result.score, reason: result.reason, source: 'scored' });
    ctx.progress(Math.round(((i + 1) / total) * 100), { stage: 'scoring', done: i + 1, total });
  }
  return out;
}

serveRpc<LlmMethods>(
  self as unknown as {
    addEventListener(type: 'message', listener: (event: MessageEvent<unknown>) => void): void;
    postMessage(message: unknown, transfer?: Transferable[]): void;
  },
  {
    'llm.load': async (_payload, ctx) => {
      await loadEngine(ctx);
    },
    'llm.score': (payload, ctx) => score(payload, ctx),
  },
);
