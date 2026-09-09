import { describe, expect, it } from "vitest";
import { SIZE } from "../core/board";
import { replay } from "../core/game";
import { strToMoves } from "../core/notation";
import { cellToPolicyIndex, encode, legalMask, policyIndexToCell } from "./features";
import fixtures from "./features.fixtures.json";

function nonzero(arr: Float32Array, C: number): string[] {
  const out: string[] = [];
  for (let x = 0; x < SIZE; x++)
    for (let y = 0; y < SIZE; y++)
      for (let c = 0; c < C; c++) if (arr[(x * SIZE + y) * C + c] !== 0) out.push(`${x},${y},${c}`);
  return out.sort();
}

describe("features: twixtbot-ui(Python) との照合", () => {
  it.each(fixtures.map((f, i) => [i, f] as const))("fixture #%i", (_i, f) => {
    const state = replay({ pieRule: true, rules: "standard" }, strToMoves(f.moves));
    expect(state.toMove).toBe(f.turn);
    const inp = encode(state.board, state.toMove);
    expect(nonzero(inp.pegs, 2)).toEqual(f.pegs.map(([x, y, c]) => `${x},${y},${c}`).sort());
    expect(nonzero(inp.links, 8)).toEqual(f.links.map(([x, y, c]) => `${x},${y},${c}`).sort());
    const mask = legalMask(state.board, state.toMove);
    expect(mask.reduce((a, b) => a + b, 0)).toBe(f.legal);
  });

  it("policy index の往復", () => {
    for (const t of [false, true]) {
      for (let i = 0; i < 528; i++) {
        expect(cellToPolicyIndex(policyIndexToCell(i, t), t)).toBe(i);
      }
    }
  });
});
