<picture>
  <source media="(prefers-color-scheme: dark)" srcset="assets/banner-dark.png">
  <img alt="All clear: Claude clears its own chat when a task is done. A short note carries over." src="assets/banner-light.png">
</picture>

# all-clear

A plugin for Claude Code. When a task is done, Claude clears the chat by itself and keeps a short note for the next task.

Short chats cost fewer tokens and keep Claude on track.

## Install

In Claude Code, type:

```
/plugin install all-clear --marketplace nzagros/all-clear
```

Press `y` to add the marketplace, then Enter for the user scope. Done. It works in every new session.

From a shell instead:

```
claude plugin install all-clear --marketplace nzagros/all-clear
```

In the desktop app: click **+** next to the prompt box, then **Plugins**, **Add marketplace**, type `nzagros/all-clear`, then **Add plugin**.

Using Codex? See [Codex](#codex) below.

## How it works

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="assets/how-it-works-dark.png">
  <img alt="How it works: the task is done, Claude writes a note of 400 characters at most, /clear runs by itself, and your next prompt begins with the note. A long chat makes Claude re-read everything on each message; after a clear it reads only the note and your new prompt." src="assets/how-it-works-light.png">
</picture>

1. You finish a task with Claude.
2. Claude checks: does the next task need this chat? If no, it writes a handoff note. 400 characters at most. Only facts that are not in your files.
3. After its answer, `/clear` runs by itself.
4. Your next prompt starts with the note:

```
[Handoff]
login page done, tests green · next: password reset · mail config in .env.example

[Task]
your next prompt
```

If Claude already knows the next task, it starts it right away in the fresh chat.

## Why it saves tokens

Each message you send makes Claude read the whole chat again. In a chat of 80,000 tokens, even "thanks" sends 80,000 input tokens. Prompt caching makes the repeats cheaper, but they still cost and still fill the context window. After a clear, Claude reads the note and your new prompt.

Old details also pull answers off course. A fresh chat with a short note keeps Claude on the current task.

## The reminder

Once a chat has grown by about 20,000 tokens since the last clear, every prompt carries a hidden one-line reminder for Claude: check whether this chat is still needed. You see nothing. Claude decides.

Deep in focus, it's easy to forget `/clear` for hours. The reminder keeps track of that for you.

## Work with it

- One chat per task. Say what you want, let Claude finish, let it clear.
- Keep decisions in files (a README, a TODO, a plan). Claude reads files again after a clear. Chat history is gone.
- Want to keep the chat? Say "don't clear yet" or "I'll come back to this".
- Coming back to a long task tomorrow? Ask Claude to write the state into a file first.
- Clear by hand any time with `/clear`. The plugin adds to it and changes nothing about it.

## When Claude does not clear

- in the middle of a task
- while it waits for your answer
- when you said you'll come back to details from this chat
- inside subagents

## Codex

Codex has no way for a plugin to clear the chat. The Codex version does the part it can: at the end of a finished task in a long chat, Codex writes the note and tells you to type `/clear` and paste it.

```
codex plugin marketplace add nzagros/all-clear
codex plugin add all-clear@all-clear
```

## Requirements

- Claude Code with plugin hooks modules. Tested on 2.1.323.
- Codex CLI with plugins. Tested on 0.165.0.

## Change the numbers

The limits sit at the top of `hooks/register.ts`:

- `MAX_HANDOFF = 400` (characters in the note)
- `NUDGE_TOKENS = 20_000` (growth before the reminder starts)

## Uninstall

```
/plugin uninstall all-clear
```

## Files

- `hooks/register.ts`: the Claude Code plugin (tool, clear, handoff, reminder)
- `codex/skills/all-clear/SKILL.md`: the Codex version
- `assets/src/`: source of the pictures (HTML, rendered with Playwright)

The pictures use [Jost](https://fonts.google.com/specimen/Jost) by indestructible type*, SIL Open Font License 1.1.

## License

MIT
