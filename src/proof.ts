// A/B experiment: do the ten tanks really learn from reward? Two fresh simulations run the same settings; one of them gets
// a series of "nice" hormone shots, the control gets none. Afterwards the phase lock between neighbouring layers is compared.

import { NUM_LAYERS, type Params } from "./model";
import { Simulation, type MemoryMode } from "./sim";

export interface ProofStats {
  lock: number; // mean phase lock of the nine links, measured at the end
  align: number; // context alignment
  gain: number; // mean learned coupling (Simulation.learned)
}

export interface ProofResult {
  control: ProofStats;
  trained: ProofStats;
  gains: number[]; // learned gain per link of the trained sim
  pairs: number;
}

const STEPS = 4; // simulation steps per observation, as in the live loop
const DT = 1 / 30; // seconds per observation in the live loop
const seconds = (s: number): number => Math.round(s / DT);

async function run(p: Params, nice: number, focus: number, memory: MemoryMode, tick: () => Promise<void>): Promise<ProofStats & { gains: number[] }> {
  const sim = new Simulation(2);
  sim.setMemory(memory);
  sim.fire(focus);
  const lock = Array.from({ length: NUM_LAYERS - 1 }, () => 0);
  let align = 0;
  let count = 0;
  const total = seconds(6 + nice * 1 + 10);
  for (let k = 0; k < total; k++) {
    for (let i = 0; i < STEPS; i++) sim.step(p);
    sim.observe(p, DT);
    const sec = k * DT;
    if (nice > 0 && sec >= 6 && sec < 6 + nice && k % seconds(1) === 0) sim.reward(1.2, focus);
    if (sec >= 6 + nice + 5) {
      for (let l = 0; l < lock.length; l++) lock[l] = (lock[l] ?? 0) + (sim.lock[l] ?? 0);
      align += sim.alignment;
      count++;
    }
    if (k % 45 === 0) await tick();
  }
  const gains = Array.from({ length: NUM_LAYERS - 1 }, (_, l) => sim.learned(l));
  return {
    lock: lock.reduce((a, b) => a + b, 0) / lock.length / Math.max(1, count),
    align: align / Math.max(1, count),
    gain: gains.reduce((a, b) => a + b, 0) / gains.length,
    gains,
  };
}

/** Runs `pairs` control/trained pairs with the given settings and averages them. `progress` gets a status line. */
export async function proveLearning(p: Params, pairs: number, progress: (text: string) => void, memory: MemoryMode = "gain", tick: () => Promise<void> = () => new Promise((r) => setTimeout(r, 0))): Promise<ProofResult> {
  const sum = (a: ProofStats, b: ProofStats): ProofStats => ({ lock: a.lock + b.lock, align: a.align + b.align, gain: a.gain + b.gain });
  const zero = { lock: 0, align: 0, gain: 0 };
  let control: ProofStats = zero;
  let trained: ProofStats = zero;
  let gains = Array.from({ length: NUM_LAYERS - 1 }, () => 0);
  for (let i = 0; i < pairs; i++) {
    progress(`pair ${i + 1} of ${pairs}: control without reward...`);
    control = sum(control, await run(p, 0, 8, memory, tick));
    progress(`pair ${i + 1} of ${pairs}: eight nice shots on L9...`);
    const t = await run(p, 8, 8, memory, tick);
    trained = sum(trained, t);
    gains = gains.map((g, l) => g + (t.gains[l] ?? 1) / pairs);
  }
  const avg = (s: ProofStats): ProofStats => ({ lock: s.lock / pairs, align: s.align / pairs, gain: s.gain / pairs });
  return { control: avg(control), trained: avg(trained), gains, pairs };
}
