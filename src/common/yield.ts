// yield —— 主线程让出原语（分片长任务的统一让出点；snapshot 分段快照 / 分屏分片渲染共用）。
// setTimeout(0) 宏任务让出：浏览器获得输入处理与绘制机会，再继续下一片。
export function yieldToBrowser(): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, 0));
}
