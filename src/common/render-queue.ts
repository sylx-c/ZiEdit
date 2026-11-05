/** 行内/块件共用帧预算；回调内的一片不可抢占，因此每片仍须保持有界。 */
import { hasPendingInput } from './input-pending';
const jobs = new Map<number, { run: () => void; background: boolean; owner?: object }>();
let serial = 0, frame = 0;
let task: ReturnType<typeof setTimeout> | undefined;
const BUDGET_MS = 8;
let activeDeadline = 0;
let measurements: Map<object, () => void> | undefined;

/** 同一显示面先提交本片的全部写入，再完成一次布局/锚定测量。 */
export function measureAfterRender(owner: object, measure: () => void): void {
  if (!measurements) { measure(); return; }
  if (!measurements.size) activeDeadline -= 2; // 8ms 总预算中预留测量时间。
  measurements.set(owner, measure);
}

/** 当前队列片的剩余预算，供可抢占解析使用；普通回调仍保持无参接口。 */
export function remainingRenderBudget(): number { return activeDeadline ? Math.max(0, activeDeadline - performance.now()) : BUDGET_MS; }

/** rAF 守卫在调用点用 typeof 判定：模块加载时存在不代表触发时仍在（vitest 跨文件环境拆除后全局绑定消失）。 */

function schedule(): void {
  if (frame || task !== undefined) return;
  // 在帧间提交装饰，CM 下一帧的测量与原生滚动锚可在绘制前一起完成。
  // 若在 rAF 内改高度，CM 的测量只能排到后续帧，会先绘制一次未锚定的正文。
  if (typeof requestAnimationFrame === 'function') frame = requestAnimationFrame(() => { frame = 0; task = setTimeout(flush, 0); });
  else task = setTimeout(flush, 0);
}

function flush(continuationDeadline = 0): void {
  task = undefined;
  // Promise 派生工作在回调之后才执行。下一宏任务才可检查其真实耗时；
  // 便宜工作继续使用本帧剩余预算，不必为每个小片空等一次屏幕刷新。
  if (!jobs.size) { activeDeadline = 0; return; }
  if (continuationDeadline && (performance.now() >= continuationDeadline || hasPendingInput()
    || [...jobs.values()].some(job => !job.background))) { activeDeadline = 0; schedule(); return; }
  const deadline = continuationDeadline || performance.now() + BUDGET_MS;
  activeDeadline = deadline;
  measurements = new Map();
  // 本帧中新排的后续片必须留给下一帧，不能在同一帧追赶整个视口。
  const batch = [...jobs].sort((a, b) => Number(a[1].background) - Number(b[1].background));
  const updated = new Set<object>();
  let backgroundRan = false;
  try {
    for (const [id, { run, background, owner }] of batch) {
      if (performance.now() >= activeDeadline) break;
      // 连续输入可能在本批次开始后才到达；后台片在每次切换前再检查一次，
      // 让滚轮/触摸事件先获得主线程，同时保留当前帧已排队的可见更新。
      if (background && hasPendingInput()) break;
      // CM 每次事务都会重记滚动锚。上次事务尚未测量时再提交，会以中间
      // 高度估计覆盖原锚，造成正文未移动却补偿一行。每面每帧只提交一次。
      if (owner && updated.has(owner)) continue;
      // CM 的本片写入还需一次不可抢占的高度测量。后台解析不得占用
      // 同一片的预留时间，再把测量和解析发布成本叠加到 8ms 之外。
      if (background && (measurements.size || hasPendingInput())) break;
      if (!jobs.delete(id)) continue;
      if (owner) updated.add(owner);
      run();
      // 后台回调可能只 resolve Promise，实际工作在 flush 后的微任务中。
      // 每个宏任务最多放行一片，下一宏任务再核对包含微任务的实际预算。
      if (background) { backgroundRan = true; break; }
    }
  } finally {
    try { for (const measure of measurements.values()) measure(); }
    finally {
      const canContinue = backgroundRan && !measurements.size && performance.now() < activeDeadline;
      const nextDeadline = activeDeadline;
      measurements = undefined;
      if (canContinue) task = setTimeout(() => flush(nextDeadline), 0);
      else { activeDeadline = 0; if (jobs.size) schedule(); }
    }
  }
}
export function requestIrFrame(run: () => void, background = false, owner?: object): number {
  const id = ++serial; jobs.set(id, { run, background, owner });
  schedule();
  return id;
}
export function cancelIrFrame(id: number): void {
  jobs.delete(id);
  if (!jobs.size) { if (typeof cancelAnimationFrame === 'function') cancelAnimationFrame(frame); frame = 0; clearTimeout(task); task = undefined; }
}

/** 测试收尾：清空待跑任务并撤销定时器，杜绝游离计时器跨测试文件在已拆除环境触发。 */
export function clearIrFrames(): void {
  jobs.clear();
  if (frame) { if (typeof cancelAnimationFrame === 'function') cancelAnimationFrame(frame); frame = 0; }
  clearTimeout(task); task = undefined; activeDeadline = 0; measurements = undefined;
}
