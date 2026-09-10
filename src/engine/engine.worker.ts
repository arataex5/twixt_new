/// <reference lib="webworker" />
import { newGame, replay } from "../core/game";
import { levelSpec } from "./levels";
import { Net } from "./net";
import type { FromWorker, ToWorker } from "./protocol";
import { chooseMove } from "./think";

const net = new Net();
let current: { id: number; cancelled: boolean } | null = null;

const post = (m: FromWorker) => (self as unknown as Worker).postMessage(m);

self.onmessage = async (e: MessageEvent<ToWorker>) => {
  const msg = e.data;
  try {
    if (msg.type === "init") {
      const t0 = performance.now();
      await net.load(msg.baseUrl);
      const loadMs = performance.now() - t0;
      const t1 = performance.now();
      await net.evaluate(newGame().board, "white", false);
      post({ type: "ready", loadMs, evalMs: performance.now() - t1 });
    } else if (msg.type === "think") {
      const job = { id: msg.id, cancelled: false };
      current = job;
      const state = replay(msg.settings, msg.moves);
      const spec = levelSpec(msg.level, msg.strongestTimeMs);
      const res = await chooseMove(net, state, spec, {
        isCancelled: () => job.cancelled,
        onProgress: (done, total) => post({ type: "progress", id: job.id, done, total }),
      });
      if (job.cancelled) post({ type: "cancelled", id: msg.id });
      else post({ type: "move", id: msg.id, ...res });
    } else if (msg.type === "cancel") {
      if (current && current.id === msg.id) current.cancelled = true;
    }
  } catch (err) {
    post({ type: "error", id: msg.type === "think" ? msg.id : undefined, message: (err as Error).message });
  }
};
