# Give each idea a clear place

Turn loose notes into a document you can return to. This sample was written for the current ZiEdit website capture; its tasks and people are fictional.

## Start with a simple note

**Make the point clear, then refine it.** Use headings to separate topics and short paragraphs to explain the reasons behind a decision.

- Plain text works well for quick notes without a planned structure.
- Code keeps its indentation so the eye can follow the logic.
- Markdown brings explanations, checklists, and code into one file.

## Make the next step concrete

| Task | Completion condition | State |
| --- | --- | --- |
| Organize notes | Each item has a clear subject | Done |
| Review code | Inputs and outputs can be checked | Working |
| Add context | Examples can be read locally | Planned |

> A document does not need to explain everything at once. Keep the facts accurate, then reduce what the next reader has to guess.

## Keep a reusable fragment

```ts
const next = tasks.find(task => task.state !== 'done');
console.log(next?.title ?? 'All tasks are complete');
```

## Review before closing

- [x] The file name explains its contents.
- [x] Examples contain no account details, secrets, or real project data.
- [ ] Check aging explanations during the next edit.

This original sample is kept in the repository so the capture can be reproduced. It contains no quotations from external articles or third-party examples.
