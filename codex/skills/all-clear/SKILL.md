---
name: all-clear
description: Use at the end of every finished task in a long chat. When the next task does not need the earlier conversation, write a handoff note of at most 400 characters and tell the user to type /clear and paste it, so the next task starts with a small context.
---

# all-clear

A long chat costs tokens on every message, because the model reads the whole chat again each time. Old details also pull later answers off course. Codex cannot clear its own chat, so you prepare the clear and the user does it with one command.

## When

At the end of an answer, check all of these:

- The task the user asked for is done.
- No question to the user is open. A question the user skipped by starting another topic or task does not count as open.
- The next task, if known, does not need details from this chat that are not saved in files.
- The chat is long: many tool calls, big outputs or more than about 15 turns.

If all are true, add the handoff. If one is false, do nothing.

## How

End the answer with exactly this block:

```
All clear. Type /clear, then paste:

[Handoff] <terse keywords, max 400 characters>
```

If the user skipped an important question, add one more line after the handoff:

```
[Skipped question] <the question in one line, max 200 characters>
```

After the clear, answer the new task first, then raise the skipped question once in one short line, only if it still matters.

Rules for the handoff text:

- Keywords, no full sentences, no history.
- Only facts the next step cannot read from files: paths, decisions, open items, the next task.
- 400 characters or less. Cut, do not summarise the chat.

Never add the block in the middle of a task, while you wait for an answer, or when the user said they will come back to details from this chat.
