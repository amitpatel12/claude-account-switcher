const vscode = require('vscode');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ENV_KEY = 'CLAUDE_CONFIG_DIR';
const ACTIVE_KEY = 'claudeAccounts.active';

let statusItem;
let watchedFile;
let ctx;

// ---------- helpers ----------
const expand = (p) => (p ? p.replace(/^~(?=$|[\\/])/, os.homedir()) : '');

function getProfiles() {
  return vscode.workspace.getConfiguration('claudeAccounts').get('profiles') || [];
}

async function saveProfiles(list) {
  await vscode.workspace
    .getConfiguration('claudeAccounts')
    .update('profiles', list, vscode.ConfigurationTarget.Global);
}

function getActive() {
  const name = ctx.globalState.get(ACTIVE_KEY);
  return getProfiles().find((p) => p.name === name);
}

// Claude Code keeps account info in <configDir>/.claude.json
// (or ~/.claude.json when CLAUDE_CONFIG_DIR is not set)
function accountFile(profile) {
  const dir = expand(profile.configDir);
  return dir ? path.join(dir, '.claude.json') : path.join(os.homedir(), '.claude.json');
}

function readAccount(profile) {
  try {
    const json = JSON.parse(fs.readFileSync(accountFile(profile), 'utf8'));
    const a = json.oauthAccount;
    if (a && a.emailAddress) {
      return { email: a.emailAddress, org: a.organizationName };
    }
  } catch (_) {}
  return null;
}

// A profile counts as logged in if it has saved credentials OR account info.
// (macOS may keep tokens in the Keychain, so .claude.json is also checked.)
function isLoggedIn(profile) {
  const dir = expand(profile.configDir) || path.join(os.homedir(), '.claude');
  if (fs.existsSync(path.join(dir, '.credentials.json'))) return true;
  return !!readAccount(profile);
}

// ---------- apply account ----------
async function applyProfile(profile) {
  const dir = expand(profile.configDir);

  // 1) Claude Code VS Code extension panel
  const cfg = vscode.workspace.getConfiguration('claudeCode');
  const vars = (cfg.get('environmentVariables') || []).filter((v) => v.name !== ENV_KEY);
  if (dir) vars.push({ name: ENV_KEY, value: dir });
  await cfg.update('environmentVariables', vars, vscode.ConfigurationTarget.Global);

  // 2) New integrated terminals (so `claude` CLI uses the same account)
  const col = ctx.environmentVariableCollection;
  if (dir) col.replace(ENV_KEY, dir);
  else col.delete(ENV_KEY);

  await ctx.globalState.update(ACTIVE_KEY, profile.name);
  refreshStatus();
}

// ---------- status bar ----------
function refreshStatus() {
  const p = getActive();
  if (!p) {
    statusItem.text = '$(account) Claude: no account';
    statusItem.tooltip = 'Click to add or pick a Claude account';
    statusItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
    statusItem.show();
    return;
  }
  const info = readAccount(p);
  const loggedIn = isLoggedIn(p);
  statusItem.text = `$(account) Claude: ${p.name}${info ? ' · ' + info.email : loggedIn ? '' : ' · not logged in'}`;
  statusItem.tooltip = new vscode.MarkdownString(
    `**Claude account:** ${p.name}\n\n` +
      (info
        ? `${info.email}${info.org ? '\n\n' + info.org : ''}`
        : loggedIn
        ? '_Logged in_'
        : '_Not logged in. Run "Claude Accounts: Log In"._') +
      `\n\n\`${expand(p.configDir) || '~/.claude (default)'}\`\n\nClick to switch`
  );
  statusItem.backgroundColor = loggedIn ? undefined : new vscode.ThemeColor('statusBarItem.warningBackground');
  statusItem.show();
  watch(accountFile(p));
}

function watch(file) {
  if (watchedFile === file) return;
  if (watchedFile) fs.unwatchFile(watchedFile);
  watchedFile = file;
  fs.watchFile(file, { interval: 3000 }, () => refreshStatus());
}

// ---------- commands ----------
async function addAccount() {
  const name = await vscode.window.showInputBox({
    prompt: 'Account name (e.g. Work, Personal)',
    validateInput: (v) => (!v.trim() ? 'Required' : getProfiles().some((p) => p.name === v.trim()) ? 'Already exists' : null),
  });
  if (!name) return;

  const kind = await vscode.window.showQuickPick(
    [
      { label: 'Use existing login (~/.claude)', description: 'Keep the account you are logged into now', value: 'default' },
      { label: 'New separate login', description: `Creates ~/.claude-${slug(name)}`, value: 'new' },
    ],
    { placeHolder: 'Where should this account store its login?' }
  );
  if (!kind) return;

  const profile = {
    name: name.trim(),
    configDir: kind.value === 'default' ? '' : path.join(os.homedir(), `.claude-${slug(name)}`),
  };
  await saveProfiles([...getProfiles(), profile]);
  await applyProfile(profile);

  if (kind.value === 'new') {
    loginTerminal(profile);
  } else {
    promptReload();
  }
}

const slug = (s) => s.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-');

function loginTerminal(profile) {
  const dir = expand(profile.configDir);
  const term = vscode.window.createTerminal({
    name: `Claude login: ${profile.name}`,
    env: dir ? { [ENV_KEY]: dir } : undefined,
  });
  term.show();
  term.sendText('claude');
  vscode.window.showInformationMessage(
    `In the terminal, type /login and sign in with your ${profile.name} account. Then reload the window.`,
    'Reload Window'
  ).then((c) => c && vscode.commands.executeCommand('workbench.action.reloadWindow'));
}

async function login() {
  const p = getActive();
  if (!p) return addAccount();
  loginTerminal(p);
}

async function switchAccount() {
  const profiles = getProfiles();
  if (!profiles.length) return addAccount();

  const active = getActive();
  const items = profiles.map((p) => {
    const info = readAccount(p);
    return {
      label: `${p.name === (active && active.name) ? '$(check) ' : '$(account) '}${p.name}`,
      description: info ? info.email : isLoggedIn(p) ? 'logged in' : 'not logged in',
      detail: expand(p.configDir) || '~/.claude (default)',
      profile: p,
    };
  });
  items.push({ label: '$(add) Add account…', add: true });

  const pick = await vscode.window.showQuickPick(items, { placeHolder: 'Switch Claude account' });
  if (!pick) return;
  if (pick.add) return addAccount();

  await applyProfile(pick.profile);
  if (isLoggedIn(pick.profile)) {
    promptReload();
  } else {
    // Only offer login; never force it
    const c = await vscode.window.showWarningMessage(
      `No saved login found for "${pick.profile.name}".`,
      'Log In',
      'Skip'
    );
    if (c === 'Log In') loginTerminal(pick.profile);
  }
}

async function removeAccount() {
  const profiles = getProfiles();
  const pick = await vscode.window.showQuickPick(profiles.map((p) => p.name), { placeHolder: 'Remove which account? (login files are kept)' });
  if (!pick) return;
  await saveProfiles(profiles.filter((p) => p.name !== pick));
  if (ctx.globalState.get(ACTIVE_KEY) === pick) await ctx.globalState.update(ACTIVE_KEY, undefined);
  refreshStatus();
}

function promptReload() {
  vscode.window
    .showInformationMessage('Claude account switched. Reload the window so the Claude Code panel uses it.', 'Reload Window')
    .then((c) => c && vscode.commands.executeCommand('workbench.action.reloadWindow'));
}

// ---------- lifecycle ----------
function activate(context) {
  ctx = context;
  statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  statusItem.command = 'claudeAccounts.switch';

  context.subscriptions.push(
    statusItem,
    vscode.commands.registerCommand('claudeAccounts.switch', switchAccount),
    vscode.commands.registerCommand('claudeAccounts.add', addAccount),
    vscode.commands.registerCommand('claudeAccounts.login', login),
    vscode.commands.registerCommand('claudeAccounts.remove', removeAccount),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('claudeAccounts')) refreshStatus();
    })
  );

  // Re-apply terminal env on startup
  const a = getActive();
  if (a) {
    const dir = expand(a.configDir);
    if (dir) context.environmentVariableCollection.replace(ENV_KEY, dir);
  }
  refreshStatus();
}

function deactivate() {
  if (watchedFile) fs.unwatchFile(watchedFile);
}

module.exports = { activate, deactivate };
