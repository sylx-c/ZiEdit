/** 异步视图挂载的代次与每路径串行锁。 */
export class MountEpoch {
  private current = 0;
  private readonly locks = new Map<string, boolean>();
  next(): number { return ++this.current; }
  isCurrent(seq: number): boolean { return seq === this.current; }
  get value(): number { return this.current; }
  locked(path: string): boolean { return this.locks.get(path) === true; }
  lock(path: string): void { this.locks.set(path, true); }
  unlock(path: string): void { this.locks.delete(path); }
}
