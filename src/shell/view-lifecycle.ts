/** 独立视图宿主与跨标签暂存：DOM/LRU 生命周期离开 app.ts 总装配闭包。 */
export interface ParkableView { destroy(): void }

export class ViewHostRegistry {
  private readonly hosts = new WeakMap<object, HTMLElement>();
  create(parent: HTMLElement): HTMLElement {
    const host = document.createElement('div');
    host.className = 'view-host';
    parent.append(host);
    return host;
  }
  register(view: object, host: HTMLElement): void { this.hosts.set(view, host); }
  get(view: object): HTMLElement | undefined { return this.hosts.get(view); }
}

export interface ParkedEntry<T extends ParkableView> {
  key: string;
  view: T;
  host: HTMLElement;
}

export class ViewParking<T extends { key: string; host: HTMLElement }> {
  private readonly entries = new Map<string, T>();
  constructor(private readonly limit: number, private readonly destroy: (entry: T) => void) {}

  get(key: string): T | undefined { return this.entries.get(key); }
  take(key: string): T | undefined {
    const entry = this.entries.get(key);
    this.entries.delete(key);
    return entry;
  }
  put(key: string, entry: T): void {
    const stale = this.entries.get(key);
    this.entries.delete(key);
    if (stale) this.destroy(stale);
    this.entries.set(key, entry);
    while (this.entries.size > this.limit) {
      const [oldKey, old] = this.entries.entries().next().value!;
      this.entries.delete(oldKey);
      this.destroy(old);
    }
  }
  delete(key: string): void {
    const entry = this.take(key);
    if (entry) this.destroy(entry);
  }
  hosts(): HTMLElement[] { return this.values().map(e => e.host); }
  values(): T[] { return [...this.entries.values()]; }
  entriesArray(): Array<[string, T]> { return [...this.entries.entries()]; }
}
