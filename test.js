const assert = require("assert");
const path = require("path");

// VS Code is unavailable in plain Node, so load pure helpers through a tiny mock.
const Module = require("module");
const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === "vscode") return {};
  return originalLoad.call(this, request, parent, isMain);
};
const { belongsToWorkspace, extractText, isUserMessageEntry, relativeAge, usageBar } = require("./extension");
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
console.log("ok");
