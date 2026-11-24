# Claude Account Switcher

Switch between multiple Claude Code accounts (e.g. Company and Personal) from VS Code.
The active account is always shown in the status bar: `Claude: Work · you@company.com`.

## How it works
Each account gets its own config folder (`CLAUDE_CONFIG_DIR`), so logins never overwrite each other:

- Personal → `~/.claude` (your existing login) or `~/.claude-personal`
- Work → `~/.claude-work`

Switching updates `claudeCode.environmentVariables` (Claude Code panel) and the env of new integrated terminals (CLI).

## Install
```bash
npm i -g @vscode/vsce
cd claude-account-switcher
vsce package
code --install-extension claude-account-switcher-0.1.0.vsix
```
Or just open the folder in VS Code and press **F5** to test.

## Use
1. Click the status bar item (or `Ctrl+Shift+P` → "Claude Accounts: Add Account").
2. Add **Personal** → "Use existing login".
3. Add **Work** → "New separate login" → a terminal opens → type `/login` and sign in with the company account.
4. Click the status bar item any time to switch. Reload the window when prompted.

## Notes
- If a workspace `.vscode/settings.json` defines `claudeCode.environmentVariables`, it overrides the global value.
- No tokens are read or copied; only the email shown in the status bar is read from `.claude.json`.
