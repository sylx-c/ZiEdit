// 本次官网截图专用的原创示例，不读取真实任务或外部服务。
type TaskState = 'planned' | 'working' | 'done';

interface Task {
  readonly id: string;
  title: string;
  state: TaskState;
  minutes: number;
}

const tasks: Task[] = [
  { id: 'note', title: '整理今天的工作笔记', state: 'done', minutes: 15 },
  { id: 'code', title: '检查一段独立的代码', state: 'working', minutes: 30 },
  { id: 'guide', title: '补全写作手册的例子', state: 'planned', minutes: 20 },
];

export function remainingMinutes(items: readonly Task[]): number {
  return items
    .filter(task => task.state !== 'done')
    .reduce((total, task) => total + task.minutes, 0);
}

export function completeTask(items: readonly Task[], id: string): Task[] {
  return items.map(task =>
    task.id === id ? { ...task, state: 'done' } : { ...task },
  );
}

export function describeTask(task: Task): string {
  const marker = task.state === 'done' ? '[x]' : '[ ]';
  return `${marker} ${task.title} (${task.minutes} 分钟)`;
}

const summary = tasks.map(describeTask).join('\n');
const remaining = remainingMinutes(tasks);

console.log(summary);
console.log(`预计还需 ${remaining} 分钟`);
