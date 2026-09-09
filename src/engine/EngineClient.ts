import type { GameSettings, Move } from "../core/game";
import type { Candidate, FromWorker, ToWorker } from "./protocol";

export interface ThinkResult {
  move: Move;
  value: number;
  candidates: Candidate[];
  evalMs: number;
  sims?: number;
}

export interface EngineInfo {
  loadMs: number;
  evalMs: number;
}

/** UI 側から Worker を扱うラッパー。1 つのアプリで 1 インスタンスを共有する */
export class EngineClient {
  private worker: Worker;
  private nextId = 1;
  private pending = new Map<number, { resolve: (r: ThinkResult) => void; reject: (e: Error) => void }>();
  private readyPromise: Promise<EngineInfo>;
  info: EngineInfo | null = null;

  constructor() {
    this.worker = new Worker(new URL("./engine.worker.ts", import.meta.url), { type: "module" });
    this.readyPromise = new Promise<EngineInfo>((resolve, reject) => {
      const onMsg = (e: MessageEvent<FromWorker>) => {
        const m = e.data;
        if (m.type === "ready") {
          this.info = { loadMs: m.loadMs, evalMs: m.evalMs };
          resolve(this.info);
        } else if (m.type === "error" && m.id === undefined) {
          reject(new Error(m.message));
        }
      };
      this.worker.addEventListener("message", onMsg);
    });
    this.worker.addEventListener("message", (e: MessageEvent<FromWorker>) => this.onMessage(e.data));
    const baseUrl = new URL(import.meta.env.BASE_URL, location.href).href;
    this.send({ type: "init", baseUrl });
  }

  ready(): Promise<EngineInfo> {
    return this.readyPromise;
  }

  private send(m: ToWorker) {
    this.worker.postMessage(m);
  }

  /** 思考の進捗(done, total)。total = -1 は時間制 */
  onProgress: ((id: number, done: number, total: number) => void) | null = null;

  private onMessage(m: FromWorker) {
    if (m.type === "progress") {
      this.onProgress?.(m.id, m.done, m.total);
    } else if (m.type === "move") {
      this.pending.get(m.id)?.resolve({ move: m.move, value: m.value, candidates: m.candidates, evalMs: m.evalMs, sims: m.sims });
      this.pending.delete(m.id);
    } else if (m.type === "cancelled") {
      this.pending.get(m.id)?.reject(new Error("cancelled"));
      this.pending.delete(m.id);
    } else if (m.type === "error" && m.id !== undefined) {
      this.pending.get(m.id)?.reject(new Error(m.message));
      this.pending.delete(m.id);
    }
  }

  /** 思考を依頼。signal で中断可能 */
  think(settings: GameSettings, moves: Move[], level: number, signal?: AbortSignal, strongestTimeMs?: number): Promise<ThinkResult> {
    const id = this.nextId++;
    const p = new Promise<ThinkResult>((resolve, reject) => this.pending.set(id, { resolve, reject }));
    this.send({ type: "think", id, settings, moves, level, strongestTimeMs });
    signal?.addEventListener("abort", () => this.send({ type: "cancel", id }), { once: true });
    return p;
  }

  dispose() {
    this.worker.terminate();
  }
}

let shared: EngineClient | null = null;
export function getEngine(): EngineClient {
  if (!shared) shared = new EngineClient();
  return shared;
}
