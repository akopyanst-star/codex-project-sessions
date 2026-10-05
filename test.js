const assert = require("assert");
const path = require("path");

// VS Code is unavailable in plain Node, so load pure helpers through a tiny mock.
const Module = require("module");
const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === "vscode") return {};
  return originalLoad.call(this, request, parent, isMain);
};
const {
  belongsToWorkspace,
  extractText,
  isUserMessageEntry,
  relativeAge,
  usageBar,
  normalizeBucket,
  pickBucket,
  compareVersions,
  sortExtensionDirs,
  platformBinDirs,
  pickCodexBinary,
  liveSourceLabel,
} = require("./extension");
Module._load = originalLoad;

const root = path.resolve("C:\\work\\project");
assert.equal(belongsToWorkspace(root, [root]), true);
assert.equal(belongsToWorkspace(path.join(root, "api"), [root]), false);
assert.equal(belongsToWorkspace("C:\\work\\another-project", [root]), false);
assert.equal(extractText([{ type: "input_text", text: "  Hello\nworld  " }]), "Hello world");
assert.equal(extractText([{ type: "output_text", text: "ignored" }]), "");
assert.equal(
  isUserMessageEntry({ type: "event_msg", payload: { type: "user_message", message: "Привет" } }),
  true
);
assert.equal(
  isUserMessageEntry({
    type: "response_item",
    payload: { type: "message", role: "user", content: [{ type: "input_text", text: "Рабочий вопрос" }] },
  }),
  true
);
assert.equal(
  isUserMessageEntry({
    type: "response_item",
    payload: {
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: "<environment_context><cwd>C:\\work\\other</cwd></environment_context>" }],
    },
  }),
  false
);
assert.equal(
  isUserMessageEntry({ type: "event_msg", payload: { type: "user_message", message: "   " } }),
  false
);
assert.match(relativeAge(Date.now() - 65_000), /^1m$/);
assert.equal(usageBar(0), "░░░░░░░░░░");
assert.equal(usageBar(24), "██░░░░░░░░");
assert.equal(usageBar(100), "██████████");

// live limits: bucket choice and normalization
const win = (used, mins, reset) => ({ usedPercent: used, windowDurationMins: mins, resetsAt: reset });
const codexBucket = { planType: "plus", primary: win(12, 300, 1900000000), secondary: win(40.5, 10080, 1900500000) };
assert.deepEqual(pickBucket({ rateLimitsByLimitId: { codex: codexBucket }, rateLimits: { primary: win(99, 300, 1) } }), {
  plan_type: "plus",
  primary: { used_percent: 12, resets_at: 1900000000, window_min: 300 },
  secondary: { used_percent: 40.5, resets_at: 1900500000, window_min: 10080 },
});
assert.equal(pickBucket({ rateLimitsByLimitId: { other: { primary: win(5, 60, 1900000000) } } }).primary.used_percent, 5);
assert.equal(pickBucket({ rateLimitsByLimitId: { codex: { primary: null, secondary: null } }, rateLimits: codexBucket }).plan_type, "plus");
assert.equal(pickBucket({ rateLimits: codexBucket }).secondary.used_percent, 40.5);
assert.equal(pickBucket({}), null);
assert.equal(pickBucket(null), null);
assert.equal(normalizeBucket({ planType: "pro", primary: null, secondary: null }), null);
assert.equal(normalizeBucket({ primary: win(0, 300, null) }).primary.used_percent, 0);
assert.equal(normalizeBucket({ primary: win(0, 300, null) }).primary.resets_at, null);
assert.equal(normalizeBucket({ primary: { usedPercent: "abc" } }), null);
assert.equal(normalizeBucket({ primary: { usedPercent: null } }), null);
assert.equal(normalizeBucket({ secondary: win(7, 10080, 1900000000) }).primary, null);

// live limits: extension folder choice
assert.equal(compareVersions([26, 10], [26, 9]) > 0, true);
assert.equal(compareVersions([26, 5930, 51102], [26, 5930, 51102]), 0);
assert.deepEqual(
  sortExtensionDirs([
    "openai.chatgpt-26.9.1-win32-x64",
    "openai.chatgpt-26.10.0-win32-x64",
    "openai.chatgpt-26.5930.51102-win32-x64",
    "openai.chatgpt-26.5928.31416-win32-x64",
    "ms-python.python-2025.1.0",
    "openai.chatgpt-bad",
  ]),
  [
    "openai.chatgpt-26.5930.51102-win32-x64",
    "openai.chatgpt-26.5928.31416-win32-x64",
    "openai.chatgpt-26.10.0-win32-x64",
    "openai.chatgpt-26.9.1-win32-x64",
  ]
);
assert.deepEqual(
  sortExtensionDirs(["openai.chatgpt-26.9.1-win32-x64", "openai.chatgpt-26.10.0-win32-x64"]),
  ["openai.chatgpt-26.10.0-win32-x64", "openai.chatgpt-26.9.1-win32-x64"]
);
assert.equal(platformBinDirs("win32", "x64")[0], "windows-x86_64");
assert.equal(platformBinDirs("linux", "arm64")[0], "linux-aarch64");
assert.equal(platformBinDirs("darwin", "arm64")[0], "macos-aarch64");
assert.deepEqual(pickCodexBinary(["openai.chatgpt-26.9.1-win32-x64", "openai.chatgpt-26.10.0-win32-x64"], "win32", "x64"), {
  dirName: "openai.chatgpt-26.10.0-win32-x64",
  platformDirs: ["windows-x86_64", "windows-x64"],
  binary: "codex.exe",
});
assert.equal(pickCodexBinary(["openai.chatgpt-26.1.0"], "linux", "x64").binary, "codex");
assert.equal(pickCodexBinary(["something-else"], "win32", "x64"), null);
assert.equal(pickCodexBinary([], "win32", "x64"), null);
assert.equal(liveSourceLabel(Date.now() - 5_000), "Live from Codex · updated just now");
assert.equal(liveSourceLabel(Date.now() - 125_000), "Live from Codex · updated 2m ago");
console.log("ok");
