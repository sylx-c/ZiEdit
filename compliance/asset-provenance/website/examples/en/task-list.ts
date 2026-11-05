// Original example for this website capture; no external services or real tasks.
type TaskState = 'planned' | 'working' | 'done';

interface Task {
  readonly id: string;
  title: string;
  state: TaskState;
  minutes: number;
}

const tasks: Task[] = [
  { id: 'note', title: 'Organize the workspace notes', state: 'done', minutes: 15 },
  { id: 'code', title: 'Review a small code example', state: 'working', minutes: 30 },
  { id: 'guide', title: 'Add a concrete writing example', state: 'planned', minutes: 20 },
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
  return `${marker} ${task.title} (${task.minutes} min)`;
}

const summary = tasks.map(describeTask).join('\n');
const remaining = remainingMinutes(tasks);

console.log(summary);
console.log(`Estimated time remaining: ${remaining} minutes`);
