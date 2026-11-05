// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { ChangeSet } from '@codemirror/state';
import { BlockHeightCache } from './block-height-cache';

describe('高度预言机内容缓存', () => {
  it('内容跨坐标复用，容器与类型隔离，保留小数', () => {
    const cache = new BlockHeightCache(); cache.layout('width:800');
    const a = cache.identity('Table', 'a', 0, 0, 0, 10)!;
    cache.put(a, 137.25);
    expect(cache.get(cache.identity('Table', 'a', 0, 0, 20, 30))).toBe(137.25);
    expect(cache.get(cache.identity('Table', 'a', 0, 1, 40, 50))).toBeUndefined();
    expect(cache.get(cache.identity('Other', 'a', 0, 0, 60, 70))).toBeUndefined();
  });
  it('块前映射，边界失效，旧内容支持撤销', () => {
    const cache = new BlockHeightCache(); cache.layout('a');
    const a = cache.identity('Table', 'a', 0, 0, 5, 10)!; cache.put(a, 40);
    cache.map(ChangeSet.of({ from: 0, insert: 'x' }, 20));
    expect(a.from).toBe(6); expect(cache.get(a)).toBe(40);
    cache.map(ChangeSet.of({ from: 6, insert: 'x' }, 21));
    expect(cache.valid(a)).toBe(false);
    cache.put(a, 90); expect(cache.get(cache.identity('Table', 'a', 0, 0, 6, 11))).toBe(40);
  });
  it('布局世代、非法高度、超大源码、实例隔离', () => {
    const cache = new BlockHeightCache(); cache.layout('a');
    const a = cache.identity('Table', 'a', 0, 0, 0, 1)!;
    for (const height of [0, -1, NaN, Infinity]) cache.put(a, height);
    expect(cache.get(a)).toBeUndefined();
    cache.put(a, 40); const generation = cache.generation; cache.layout('b');
    cache.put(a, 60, generation); expect(cache.get(a)).toBeUndefined();
    expect(cache.identity('Table', 'x'.repeat(65537), 0, 0, 0, 1)).toBeUndefined();
    expect(new BlockHeightCache().get(a)).toBeUndefined();
  });
  it('条数预算淘汰旧内容', () => {
    const cache = new BlockHeightCache(); cache.layout('a');
    for (let i = 0; i < 1025; i++) cache.put(cache.identity('Table', String(i), 0, 0, i, i + 1)!, 40);
    expect(cache.get(cache.identity('Table', '0', 0, 0, 0, 1))).toBeUndefined();
  });
  it('字节预算与暂时未知布局保留已测记录', () => {
    const cache = new BlockHeightCache(); cache.layout('a');
    const source = 'x'.repeat(32000);
    cache.put(cache.identity('Table', source, 0, 0, 0, 1)!, 40);
    cache.invalidateLayout(); expect(cache.get(cache.identity('Table', source, 0, 0, 0, 1))).toBeUndefined();
    cache.layout('a'); expect(cache.get(cache.identity('Table', source, 0, 0, 0, 1))).toBe(40);
    for (let i = 1; i < 40; i++) cache.put(cache.identity('Table', source + i, 0, 0, i, i + 1)!, 40);
    expect(cache.get(cache.identity('Table', source, 0, 0, 0, 1))).toBeUndefined();
  });
});
