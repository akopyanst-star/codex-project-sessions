const vscode = require("vscode");
const fs = require("fs");
const os = require("os");
const path = require("path");
const readline = require("readline");

const CODEX_SCHEME = "openai-codex";
const CODEX_AUTHORITY = "route";

function normalizePath(value) {
  if (!value) return "";
  const normalized = path.resolve(value).replace(/[\\/]+$/, "");
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function belongsToWorkspace(cwd, roots) {
  const candidate = normalizePath(cwd);
  return roots.some((root) => candidate === normalizePath(root));
}

function relativeAge(timestamp) {
  const seconds = Math.max(0, Math.floor((Date.now() - timestamp) / 1000));
  if (seconds < 60) return "now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

function resetIn(timestampSeconds) {
  const seconds = Math.max(0, Math.ceil(timestampSeconds - Date.now() / 1000));
  if (seconds < 60) return "<1m";
  const minutes = Math.ceil(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.ceil(minutes / 60);
  if (hours < 48) return `${hours}h`;
  return `${Math.ceil(hours / 24)}d`;
}

function usageBar(percent) {
  const value = Math.max(0, Math.min(100, Number(percent) || 0));
  const width = 10;
  const filled = Math.round((value / 100) * width);
  return `${"█".repeat(filled)}${"░".repeat(width - filled)}`;
}

function extractText(content) {
  if (!Array.isArray(content)) return "";
  return content
    .filter((part) => part && (part.type === "input_text" || part.type === "text"))
    .map((part) => part.text || "")
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

function isUserMessageEntry(entry) {
  const payload = entry?.payload;
  let message = "";
  if (entry?.type === "event_msg" && payload?.type === "user_message") {
    message = typeof payload.message === "string" ? payload.message.trim() : "";
  } else if (entry?.type === "response_item" && payload?.type === "message" && payload.role === "user") {
    message = extractText(payload.content);
  }
  if (!message) return false;
  return !/^(<recommended_plugins>|<environment_context>|<skills_instructions>|<INSTRUCTIONS>|# AGENTS\.md instructions)/i.test(
    message
  );
}

async function readSession(file, roots) {
  const input = fs.createReadStream(file, { encoding: "utf8" });
  const lines = readline.createInterface({ input, crlfDelay: Infinity });
  let meta = null;
  let hasUserMessage = false;
  let started = 0;
  let completed = 0;

  try {
    for await (const line of lines) {
      let entry;
      try {
        entry = JSON.parse(line);
      } catch {
        continue;
      }
      if (!meta && entry.type === "session_meta") {
        meta = entry.payload;
      }
      if (isUserMessageEntry(entry)) hasUserMessage = true;
      if (entry.type === "event_msg" && entry.payload?.type === "task_started") started += 1;
      if (entry.type === "event_msg" && entry.payload?.type === "task_complete") completed += 1;
    }
  } finally {
    lines.close();
    input.destroy();
  }

  if (!meta || !hasUserMessage || !belongsToWorkspace(meta.cwd, roots)) return null;
  const id = meta.id || meta.session_id;
  if (!id) return null;
  const stat = await fs.promises.stat(file);
  return {
    id,
    cwd: meta.cwd,
    title: "New chat",
    timestamp: stat.mtimeMs || Date.parse(meta.timestamp || ""),
    active: started > completed,
  };
}

async function listJsonlFiles(dir) {
  const result = [];
  const pending = [dir];
  while (pending.length) {
    const current = pending.pop();
    let entries;
    try {
      entries = await fs.promises.readdir(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) pending.push(fullPath);
      else if (entry.isFile() && entry.name.endsWith(".jsonl")) result.push(fullPath);
    }
  }
  return result;
}

async function readThreadNames() {
  const names = new Map();
  const indexFile = path.join(os.homedir(), ".codex", "session_index.jsonl");
  let contents;
  try {
    contents = await fs.promises.readFile(indexFile, "utf8");
  } catch {
    return names;
  }
  for (const line of contents.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line);
      if (entry.id && entry.thread_name?.trim()) names.set(entry.id, entry.thread_name.trim());
    } catch {
      // Ignore an incomplete line while Codex is updating the index.
    }
  }
  return names;
}

async function readLatestRateLimits(files) {
  const stats = await Promise.all(
    files.map(async (file) => {
      try {
        return { file, mtime: (await fs.promises.stat(file)).mtimeMs };
      } catch {
        return null; // file vanished between listing and stat
      }
    })
  );
  const recent = stats.filter(Boolean).sort((a, b) => b.mtime - a.mtime);
  // A file's mtime is not the time of its last limits record (an old chat can be reopened),
  // so scan several recent files and keep the newest record by its own timestamp.
  let best = null;
  for (const { file } of recent.slice(0, 30)) {
    let contents;
    try {
      const stat = await fs.promises.stat(file);
      const length = Math.min(stat.size, 256 * 1024);
      const handle = await fs.promises.open(file, "r");
      try {
        const buffer = Buffer.alloc(length);
        await handle.read(buffer, 0, length, stat.size - length);
        contents = buffer.toString("utf8");
      } finally {
        await handle.close();
      }
    } catch {
      continue;
    }
    const lines = contents.split(/\r?\n/).reverse();
    for (const line of lines) {
      try {
        const entry = JSON.parse(line);
        if (entry.type === "event_msg" && entry.payload?.type === "token_count" && entry.payload.rate_limits) {
          const time = Date.parse(entry.timestamp) || 0;
          if (!best || time > best.time) best = { limits: entry.payload.rate_limits, time };
          break;
        }
      } catch {
        // The first line can be partial because only the tail is read.
      }
    }
  }
  return best;
}

class UsageProvider {
  constructor() {
    this.changed = new vscode.EventEmitter();
    this.onDidChangeTreeData = this.changed.event;
  }

  refresh() {
    this.changed.fire();
  }

  getTreeItem(item) {
    return item;
  }

  async getChildren() {
    const files = await listJsonlFiles(path.join(os.homedir(), ".codex", "sessions"));
    const latest = await readLatestRateLimits(files);
    if (!latest) {
      const item = new vscode.TreeItem("Usage will appear after the first request");
      item.iconPath = new vscode.ThemeIcon("info");
      return [item];
    }
    const { limits, time } = latest;
    const plan = new vscode.TreeItem(`Account: ${limits.plan_type || "Codex"}`);
    plan.iconPath = new vscode.ThemeIcon("account");
    plan.command = { command: "codexProjectSessions.openAccount", title: "View details" };
    const updated = new vscode.TreeItem(" ");
    updated.description = time ? `Local data from ${relativeAge(time)} ago` : "Local data, time unknown";
    updated.tooltip = "Codex saves limits locally only after a request from this computer. Usage from other devices or apps is not visible here until your next request.";
    updated.iconPath = new vscode.ThemeIcon("history");
    const makeLimit = (label, value) => {
      const expired = value?.resets_at && value.resets_at * 1000 <= Date.now();
      // Show what is LEFT, like the official Codex usage window does.
      const left = Math.max(0, 100 - Math.round(value?.used_percent || 0));
      const item = new vscode.TreeItem(
        expired ? `${label}  no fresh data` : `${label}  ${usageBar(left)}  ${left}% left`
      );
      item.tooltip = expired
        ? `${label}: this window restarted after the last local record. Send any message to Codex to update.`
        : `${label}: ${left}% left${value?.resets_at ? `\nResets in ${resetIn(value.resets_at)}` : ""}`;
      item.iconPath = new vscode.ThemeIcon(
        expired ? "circle-outline" : "circle-filled",
        expired
          ? undefined
          : new vscode.ThemeColor(left <= 10 ? "charts.red" : left <= 30 ? "charts.yellow" : "charts.green")
      );
      const reset = new vscode.TreeItem(" ");
      reset.description = expired
        ? "Send any message to Codex to update"
        : value?.resets_at ? `Resets in ${resetIn(value.resets_at)}` : "Reset time unavailable";
      reset.iconPath = new vscode.ThemeIcon("blank");
      return [item, reset];
    };
    return [plan, updated, ...makeLimit("Session (5hr)", limits.primary), ...makeLimit("Weekly (7 day)", limits.secondary)];
  }
}

class SessionsProvider {
  constructor(context, hiddenIds) {
    this.context = context;
    this.hiddenIds = hiddenIds;
    this.searchText = "";
    this.activeOnly = false;
    this.changed = new vscode.EventEmitter();
    this.onDidChangeTreeData = this.changed.event;
  }

  refresh() {
    this.changed.fire();
  }

  setSearch(value) {
    this.searchText = value.trim().toLocaleLowerCase();
    this.refresh();
  }

  toggleActive() {
    this.activeOnly = !this.activeOnly;
    this.refresh();
    return this.activeOnly;
  }

  groups() {
    return this.context.globalState.get(`sessionGroups:${this.workspaceKey()}`, []);
  }

  assignments() {
    return this.context.globalState.get(`sessionGroupAssignments:${this.workspaceKey()}`, {});
  }

  workspaceKey() {
    return (vscode.workspace.workspaceFolders || [])
      .map((folder) => normalizePath(folder.uri.fsPath))
      .sort()
      .join("|");
  }

  groupsStorageKey() {
    return `sessionGroups:${this.workspaceKey()}`;
  }

  assignmentsStorageKey() {
    return `sessionGroupAssignments:${this.workspaceKey()}`;
  }

  getTreeItem(item) {
    if (item.kind === "new") {
      const treeItem = new vscode.TreeItem("New session", vscode.TreeItemCollapsibleState.None);
      treeItem.iconPath = new vscode.ThemeIcon("add");
      treeItem.command = { command: "codexProjectSessions.newChat", title: "New session" };
      return treeItem;
    }
    if (item.kind === "group") {
      const treeItem = new vscode.TreeItem(item.name, vscode.TreeItemCollapsibleState.Expanded);
      treeItem.description = String(item.sessions.length);
      treeItem.iconPath = new vscode.ThemeIcon("folder");
      treeItem.contextValue = item.deletable ? "codexProjectGroupDeletable" : "codexProjectGroup";
      return treeItem;
    }
    const treeItem = new vscode.TreeItem(item.title, vscode.TreeItemCollapsibleState.None);
    treeItem.description = relativeAge(item.timestamp);
    treeItem.tooltip = `${item.title}\n${item.cwd}`;
    treeItem.iconPath = item.active
      ? new vscode.ThemeIcon("circle-filled", new vscode.ThemeColor("charts.green"))
      : new vscode.ThemeIcon("circle-outline", new vscode.ThemeColor("disabledForeground"));
    treeItem.contextValue = "codexProjectSession";
    treeItem.command = {
      command: "codexProjectSessions.openChat",
      title: "Open Codex Chat",
      arguments: [item],
    };
    return treeItem;
  }

  async getChildren(element) {
    if (element?.kind === "group") return element.sessions;
    const roots = (vscode.workspace.workspaceFolders || []).map((folder) => folder.uri.fsPath);
    if (!roots.length) return [{ kind: "new" }];
    const sessionsDir = path.join(os.homedir(), ".codex", "sessions");
    const [files, threadNames] = await Promise.all([listJsonlFiles(sessionsDir), readThreadNames()]);
    let sessions = (await Promise.all(files.map((file) => readSession(file, roots).catch(() => null))))
      .filter(Boolean)
      .filter((session) => !this.hiddenIds.has(session.id))
      // Codex adds a thread name only after a real first message. Editor tabs
      // that were opened and closed untouched remain unindexed and stay hidden.
      .filter((session) => threadNames.has(session.id))
      .map((session) => ({ ...session, title: threadNames.get(session.id) || session.title }));
    if (this.searchText) sessions = sessions.filter((session) => session.title.toLocaleLowerCase().includes(this.searchText));
    if (this.activeOnly) sessions = sessions.filter((session) => session.active);
    sessions.sort((a, b) => b.timestamp - a.timestamp);
    const assignments = this.assignments();
    const groupNodes = this.groups().map((name) => ({
      kind: "group",
      name,
      deletable: true,
      sessions: sessions.filter((session) => assignments[session.id] === name),
    }));
    groupNodes.push({
      kind: "group",
      name: "Ungrouped",
      deletable: false,
      sessions: sessions.filter((session) => !assignments[session.id] || !this.groups().includes(assignments[session.id])),
    });
    return [{ kind: "new" }, ...groupNodes.filter((group) => group.sessions.length || group.name === "Ungrouped")];
  }
}

const BAK_MARK = "codex-project-sessions-";

function getOpenAI() {
  return vscode.extensions.getExtension("openai.chatgpt");
}

async function atomicWrite(file, contents) {
  const tmp = `${file}.cps-${process.pid}.tmp`;
  try {
    await fs.promises.writeFile(tmp, contents, "utf8");
    await fs.promises.rename(tmp, file);
  } catch (error) {
    await fs.promises.unlink(tmp).catch(() => {});
    throw error;
  }
}

async function backupOnce(file, version) {
  const backup = `${file}.${BAK_MARK}${version}.bak`;
  await fs.promises.copyFile(file, backup, fs.constants.COPYFILE_EXCL).catch((error) => {
    if (error.code !== "EEXIST") throw error;
  });
}

// Patches the official OpenAI Codex extension: editor-title button opens a new
// chat tab, and /first-run reuses the plain composer route. Runs only with consent.
async function ensureOpenAIButtonPatch(context) {
  const openai = getOpenAI();
  if (!openai) return;
  const manifestPath = path.join(openai.extensionPath, "package.json");
  const problems = [];
  let version = "unknown";
  let manifestChanged = false;
  let routeChanged = false;
  try {
    const manifest = JSON.parse(await fs.promises.readFile(manifestPath, "utf8"));
    version = manifest.version || version;

    // Step 1: manifest (editor-title button -> new chat in a tab).
    const editorTitle = manifest.contributes?.menus?.["editor/title"] || [];
    for (const item of editorTitle) {
      if (item.command === "chatgpt.openSidebar") {
        item.command = "chatgpt.newCodexPanel";
        manifestChanged = true;
      }
    }
    const newPanel = (manifest.contributes?.commands || []).find((command) => command.command === "chatgpt.newCodexPanel");
    if (!newPanel) problems.push("command chatgpt.newCodexPanel not found in manifest");
    else if (newPanel.icon !== "$(add)") {
      newPanel.icon = "$(add)";
      manifestChanged = true;
    }
    if (manifestChanged) {
      try {
        await backupOnce(manifestPath, version);
        await atomicWrite(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
      } catch (error) {
        manifestChanged = false;
        problems.push(`manifest: ${error.message}`);
      }
    }

    // Step 2: /first-run route points to the same component as /extension/panel/new.
    let routeSeen = false;
    try {
      const assetsPath = path.join(openai.extensionPath, "webview", "assets");
      const assetNames = await fs.promises.readdir(assetsPath);
      for (const assetName of assetNames.filter((name) => /^app-initial-.*\.js$/.test(name))) {
        const assetPath = path.join(assetsPath, assetName);
        const assetSource = await fs.promises.readFile(assetPath, "utf8");
        const newRoute = assetSource.match(/path:`\/extension\/panel\/new`,element:\(0,([\w$]+)\.jsx\)\(([\w$]+),\{\}\)/);
        const firstRunPattern = /path:`\/first-run`,element:\(0,([\w$]+)\.jsx\)\(([\w$]+),\{\}\)/;
        const firstRun = assetSource.match(firstRunPattern);
        if (!newRoute || !firstRun) continue;
        routeSeen = true;
        if (firstRun[2] === newRoute[2]) continue; // already patched
        const patched = assetSource.replace(
          firstRunPattern,
          () => `path:\`/first-run\`,element:(0,${firstRun[1]}.jsx)(${newRoute[2]},{})`
        );
        try {
          await backupOnce(assetPath, version);
          await atomicWrite(assetPath, patched);
          routeChanged = true;
        } catch (error) {
          problems.push(`route ${assetName}: ${error.message}`);
        }
      }
    } catch (error) {
      problems.push(`webview assets: ${error.message}`);
    }
    if (!routeSeen) problems.push("first-run route pattern not found (OpenAI extension layout changed)");
  } catch (error) {
    problems.push(error.message);
  }

  if (problems.length) {
    const key = `patchWarned:${version}`;
    if (!context.globalState.get(key)) {
      await context.globalState.update(key, true);
      void vscode.window.showWarningMessage(
        `Codex Project Sessions: the OpenAI extension patch (version ${version}) was not fully applied: ${problems.join("; ")}. ` +
          "Run \"Restore official Codex extension files\" to roll back, or turn off codexProjectSessions.patchOfficialExtension."
      );
    }
  }
  if (manifestChanged || routeChanged) {
    const action = await vscode.window.showInformationMessage(
      "Codex Project Sessions patched the OpenAI Codex extension. Reload the window to apply it.",
      "Reload Window"
    );
    if (action === "Reload Window") await vscode.commands.executeCommand("workbench.action.reloadWindow");
  }
}

async function restoreOfficialExtension() {
  const openai = getOpenAI();
  if (!openai) {
    void vscode.window.showWarningMessage("OpenAI Codex extension (openai.chatgpt) is not installed.");
    return;
  }
  const version = openai.packageJSON?.version;
  const suffix = `.${BAK_MARK}${version}.bak`;
  const dirs = [openai.extensionPath, path.join(openai.extensionPath, "out"), path.join(openai.extensionPath, "webview", "assets")];
  const restored = [];
  const failed = [];
  for (const dir of dirs) {
    let names;
    try {
      names = await fs.promises.readdir(dir);
    } catch {
      continue;
    }
    for (const name of names.filter((n) => n.endsWith(suffix))) {
      const backup = path.join(dir, name);
      const target = path.join(dir, name.slice(0, -suffix.length));
      try {
        await atomicWrite(target, await fs.promises.readFile(backup, "utf8"));
        await fs.promises.unlink(backup);
        restored.push(path.basename(target));
      } catch (error) {
        failed.push(`${path.basename(target)}: ${error.message}`);
      }
    }
  }
  if (failed.length) void vscode.window.showErrorMessage(`Restore failed for: ${failed.join("; ")}`);
  if (!restored.length) {
    if (!failed.length) void vscode.window.showInformationMessage(`No backups found for OpenAI Codex ${version}. Nothing to restore.`);
    return;
  }
  const config = vscode.workspace.getConfiguration("codexProjectSessions");
  if (config.get("patchOfficialExtension")) await config.update("patchOfficialExtension", false, vscode.ConfigurationTarget.Global);
  const action = await vscode.window.showInformationMessage(
    `Restored: ${restored.join(", ")}. Patching is now off. Reload the window to apply.`,
    "Reload Window"
  );
  if (action === "Reload Window") await vscode.commands.executeCommand("workbench.action.reloadWindow");
}

async function maybePatch(context) {
  const config = vscode.workspace.getConfiguration("codexProjectSessions");
  const info = config.inspect("patchOfficialExtension");
  const explicit = info && info.globalValue;
  if (explicit === true) return ensureOpenAIButtonPatch(context);
  if (explicit === false || context.globalState.get("patchConsentAsked")) return;
  await context.globalState.update("patchConsentAsked", true);
  const answer = await vscode.window.showInformationMessage(
    "Codex Project Sessions can patch the official OpenAI Codex extension files so the + button opens a new chat in an editor tab and first-run screens do not repeat. Backups (.bak) are kept and can be restored with \"Restore official Codex extension files\". Use at your own risk.",
    "Enable",
    "No"
  );
  if (answer === "Enable") {
    await config.update("patchOfficialExtension", true, vscode.ConfigurationTarget.Global);
  } else if (answer === "No") {
    await config.update("patchOfficialExtension", false, vscode.ConfigurationTarget.Global);
  }
}

function activate(context) {
  const hiddenIds = new Set(context.globalState.get("hiddenSessionIds", []));
  const provider = new SessionsProvider(context, hiddenIds);
  const usageProvider = new UsageProvider();
  void maybePatch(context);
  context.subscriptions.push(
    provider.changed,
    usageProvider.changed,
    vscode.window.registerTreeDataProvider("codexProjectSessions.sessions", provider),
    vscode.window.registerTreeDataProvider("codexProjectSessions.usage", usageProvider),
    vscode.commands.registerCommand("codexProjectSessions.refresh", () => {
      provider.refresh();
      usageProvider.refresh();
    }),
    vscode.commands.registerCommand("codexProjectSessions.search", async () => {
      const value = await vscode.window.showInputBox({
        title: "Search Codex sessions",
        prompt: "Leave empty to clear the search",
        value: provider.searchText,
      });
      if (value !== undefined) provider.setSearch(value);
    }),
    vscode.commands.registerCommand("codexProjectSessions.toggleActive", () => {
      const enabled = provider.toggleActive();
      vscode.window.setStatusBarMessage(enabled ? "Codex: showing active sessions" : "Codex: showing all sessions", 2500);
    }),
    vscode.commands.registerCommand("codexProjectSessions.newGroup", async () => {
      const name = (await vscode.window.showInputBox({ title: "New session group", prompt: "Group name" }))?.trim();
      if (!name || name.toLocaleLowerCase() === "ungrouped") return;
      const groups = provider.groups();
      if (!groups.some((group) => group.toLocaleLowerCase() === name.toLocaleLowerCase())) {
        await context.globalState.update(provider.groupsStorageKey(), [...groups, name]);
        provider.refresh();
      }
    }),
    vscode.commands.registerCommand("codexProjectSessions.moveToGroup", async (item) => {
      const choices = [{ label: "Ungrouped", value: null }, ...provider.groups().map((name) => ({ label: name, value: name }))];
      const selected = await vscode.window.showQuickPick(choices, { title: `Move “${item.title}” to group` });
      if (!selected) return;
      const assignments = provider.assignments();
      if (selected.value) assignments[item.id] = selected.value;
      else delete assignments[item.id];
      await context.globalState.update(provider.assignmentsStorageKey(), assignments);
      provider.refresh();
    }),
    vscode.commands.registerCommand("codexProjectSessions.deleteGroup", async (item) => {
      const answer = await vscode.window.showWarningMessage(`Delete group “${item.name}”? Chats will move to Ungrouped.`, { modal: true }, "Delete");
      if (answer !== "Delete") return;
      await context.globalState.update(provider.groupsStorageKey(), provider.groups().filter((name) => name !== item.name));
      const assignments = provider.assignments();
      for (const id of Object.keys(assignments)) if (assignments[id] === item.name) delete assignments[id];
      await context.globalState.update(provider.assignmentsStorageKey(), assignments);
      provider.refresh();
    }),
    vscode.commands.registerCommand("codexProjectSessions.openAccount", () =>
      vscode.commands.executeCommand("chatgpt.openSidebar")
    ),
    vscode.commands.registerCommand("codexProjectSessions.openChat", async (item) => {
      const uri = vscode.Uri.from({
        scheme: CODEX_SCHEME,
        authority: CODEX_AUTHORITY,
        path: `/local/${item.id}`,
      });
      await vscode.commands.executeCommand("vscode.openWith", uri, "chatgpt.conversationEditor", {
        viewColumn: vscode.window.activeTextEditor?.viewColumn || vscode.ViewColumn.Active,
        preserveFocus: false,
        preview: false,
      });
    }),
    vscode.commands.registerCommand("codexProjectSessions.removeChat", async (item) => {
      const answer = await vscode.window.showWarningMessage(
        "Remove this chat from the project list? The conversation itself is kept.",
        { modal: true },
        "Remove"
      );
      if (answer !== "Remove") return;
      hiddenIds.add(item.id);
      await context.globalState.update("hiddenSessionIds", [...hiddenIds]);
      provider.refresh();
    }),
    vscode.commands.registerCommand("codexProjectSessions.restoreChats", async () => {
      hiddenIds.clear();
      await context.globalState.update("hiddenSessionIds", []);
      provider.refresh();
    }),
    vscode.commands.registerCommand("codexProjectSessions.restoreOfficialExtension", restoreOfficialExtension),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (
        event.affectsConfiguration("codexProjectSessions.patchOfficialExtension") &&
        vscode.workspace.getConfiguration("codexProjectSessions").inspect("patchOfficialExtension")?.globalValue === true
      ) {
        void ensureOpenAIButtonPatch(context);
      }
    }),
    vscode.commands.registerCommand("codexProjectSessions.newChat", () =>
      vscode.commands.executeCommand("chatgpt.newCodexPanel")
    )
  );

  const watcher = vscode.workspace.createFileSystemWatcher(
    new vscode.RelativePattern(path.join(os.homedir(), ".codex", "sessions"), "**/*.jsonl")
  );
  const refreshAll = () => {
    provider.refresh();
    usageProvider.refresh();
  };
  let debounceTimer;
  const scheduleRefresh = () => {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(refreshAll, 1500);
  };
  context.subscriptions.push({ dispose: () => clearTimeout(debounceTimer) });
  watcher.onDidCreate(scheduleRefresh);
  watcher.onDidChange(scheduleRefresh);
  watcher.onDidDelete(scheduleRefresh);
  context.subscriptions.push(watcher);
  const indexWatcher = vscode.workspace.createFileSystemWatcher(
    path.join(os.homedir(), ".codex", "session_index.jsonl")
  );
  indexWatcher.onDidCreate(scheduleRefresh);
  indexWatcher.onDidChange(scheduleRefresh);
  context.subscriptions.push(indexWatcher);
  const ageRefresh = setInterval(refreshAll, 60_000);
  context.subscriptions.push({ dispose: () => clearInterval(ageRefresh) });
}

function deactivate() {}

module.exports = {
  activate,
  deactivate,
  belongsToWorkspace,
  extractText,
  isUserMessageEntry,
  resetIn,
  usageBar,
  relativeAge,
};
