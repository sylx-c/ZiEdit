/** 行内/块件共用帧预算；回调内的一片不可抢占，因此每片仍须保持有界。 */
const jobs = new Map<number, () => void>();
let serial = 0, frame = 0;
const BUDGET_MS = 8;

function flush(): void {
  frame = 0;
  const deadline = performance.now() + BUDGET_MS;
  // 本帧中新排的后续片必须留给下一帧，不能在同一帧追赶整个视口。
  const batch = [...jobs];
  try {
    for (const [id, run] of batch) {
      if (performance.now() >= deadline) break;
      if (!jobs.delete(id)) continue;
      run();
    }
  } finally { if (jobs.size && !frame) frame = requestAnimationFrame(flush); }
}
export function requestIrFrame(run: () => void): number {
  const id = ++serial; jobs.set(id, run);
  if (!frame) frame = requestAnimationFrame(flush);
  return id;
}
export function cancelIrFrame(id: number): void {
  jobs.delete(id);
  if (!jobs.size && frame) { cancelAnimationFrame(frame); frame = 0; }
}
