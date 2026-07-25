import fs from "fs";

const p = JSON.parse(
  fs.readFileSync(process.argv[2] ?? "CPU.20260725.121041.56134.0.001.cpuprofile", "utf8"),
);
const samples = p.samples ?? [];
const deltas = p.timeDeltas ?? [];
let total = 0;
const self = new Map();
for (let i = 0; i < samples.length; i++) {
  const dt = deltas[i] ?? 1;
  total += dt;
  self.set(samples[i], (self.get(samples[i]) ?? 0) + dt);
}
const nodes = new Map(p.nodes.map((n) => [n.id, n]));
const label = (id) => {
  const n = nodes.get(id);
  if (!n) return "?";
  const cf = n.callFrame ?? {};
  const file = (cf.url ?? "").split(/[/\\]/).pop() ?? "";
  return `${cf.functionName ?? "(anon)"} @ ${file}:${cf.lineNumber ?? ""}`;
};
const byFile = new Map();
const byFn = new Map();
for (const [id, t] of self) {
  const n = nodes.get(id);
  const cf = n?.callFrame ?? {};
  const file = (cf.url ?? "").split(/[/\\]/).pop() ?? "(native)";
  byFile.set(file, (byFile.get(file) ?? 0) + t);
  const fn = cf.functionName ?? "(anon)";
  byFn.set(fn, (byFn.get(fn) ?? 0) + t);
}

console.log("Top self-time:");
for (const [id, t] of [...self.entries()].sort((a, b) => b[1] - a[1]).slice(0, 40)) {
  console.log(`${((t / total) * 100).toFixed(1).padStart(5)}%`, label(id));
}
console.log("\nBy file:");
for (const [file, t] of [...byFile.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20)) {
  console.log(`${((t / total) * 100).toFixed(1).padStart(5)}%`, file);
}
console.log("\nBy function:");
for (const [fn, t] of [...byFn.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20)) {
  console.log(`${((t / total) * 100).toFixed(1).padStart(5)}%`, fn);
}
console.log("\ntotal us", total, `(${(total / 1e6).toFixed(1)}s sampled)`);
