import { afterAll } from 'vitest';
import { clearIrFrames } from '../src/common/render-queue';

// 每个测试文件收尾清空渲染队列：jsdom 环境拆除后，残留的 rAF/定时器回调
// 会以「requestAnimationFrame is not defined」形式在下一个文件的窗口炸出。
afterAll(() => clearIrFrames());
