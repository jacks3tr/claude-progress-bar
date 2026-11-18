# Claude Code progress bar

A progress bar with a live countdown, shown above the prompt in Claude Code. Claude sets it when it starts long multi-step work and updates it as things change.

```
Migrating 8 threads  3 of 8 done                            ×
██████████████████████████▌─────────────────────────────────
45%                                            00:09:59 left
```

## Install

In a terminal session of Claude Code, type:

```
/plugin install progress-eta --marketplace jacks3tr/claude-progress-bar
```

Answer `y` to add the marketplace, then press Enter to install for your user. It works right away.

Or from a shell:

```bash
claude plugin install progress-eta --marketplace jacks3tr/claude-progress-bar
```

In the Claude desktop app: click **+** next to the prompt box, then **Plugins**, **Add marketplace**, enter `jacks3tr/claude-progress-bar`, then **Add plugin**.

## Use

- Ask Claude to track progress on a long task, or let it decide. It gets a `set_progress` tool to set the percent, the time left and a short status line.
- The time left counts down live (`HH:MM:SS`), and the bar and percent move with it: a 14-minute estimate from 0% reads 50% after 7 minutes. Each update from Claude resets the pace from the new numbers.
- When the estimate passes, the bar turns amber to red, holds at 99% and counts the overtime until Claude marks it done.
- When the bar has not been updated for 10 minutes (5 once overdue), Claude gets one quiet reminder with its next tool result. Nothing runs on a timer to wake it.
- Close the bar with the **×** or `/progress-clear`.

Works in local Claude Code sessions (terminal, desktop app, VS Code). Cloud sessions don't load plugins.
