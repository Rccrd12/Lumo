// Markdown in the chat's answers (src/views/markdown.ts): blocks are parsed
// line by line, inline syntax is parsed to a tree, and rendering
// builds DOM nodes from text only — never HTML — with http(s)-only links.

import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { installFakeDom } from "./fakedom.mjs";
import { calls, sent } from "./tauri.mjs";

const dom = installFakeDom();
const { parseMarkdown, parseInline, renderMarkdown, safeWebUrl } = await import("../src/views/markdown.ts");

beforeEach(() => {
  calls.length = 0;
});

// ── Blocks ────────────────────────────────────────────────────────────────────

test("headings need a space after the hashes", () => {
  assert.deepEqual(parseMarkdown("# Title\n## Sub\n####### Deep"), [
    { kind: "heading", level: 1, text: "Title" },
    { kind: "heading", level: 2, text: "Sub" },
    { kind: "heading", level: 6, text: "Deep" },
  ]);
  assert.deepEqual(parseMarkdown("#hashtag"), [{ kind: "paragraph", text: "#hashtag" }]);
});

test("a fenced code block keeps its lines as they are, language apart", () => {
  const md = "Before\n```python\nprint('hi')\n  indented\n\n# not a heading\n```\nAfter";
  assert.deepEqual(parseMarkdown(md), [
    { kind: "paragraph", text: "Before" },
    { kind: "code", lang: "python", code: "print('hi')\n  indented\n\n# not a heading" },
    { kind: "paragraph", text: "After" },
  ]);
  // An unclosed fence runs to the end, as while an answer is still streaming.
  assert.deepEqual(parseMarkdown("```\nlet x"), [{ kind: "code", lang: "", code: "let x" }]);
});

test("lists keep their markers and nesting", () => {
  assert.deepEqual(parseMarkdown("- one\n* two\n  + nested\n1. first\n12. twelfth"), [
    { kind: "item", prefix: "•", text: "one", indent: 0 },
    { kind: "item", prefix: "•", text: "two", indent: 0 },
    { kind: "item", prefix: "•", text: "nested", indent: 1 },
    { kind: "item", prefix: "1.", text: "first", indent: 0 },
    { kind: "item", prefix: "12.", text: "twelfth", indent: 0 },
  ]);
});

test("quotes, rules and paragraphs that stop at the next block", () => {
  assert.deepEqual(parseMarkdown("> quoted\n>\n---\nline one\nline two\n- item\n\npara"), [
    { kind: "quote", text: "quoted" },
    { kind: "quote", text: "" },
    { kind: "rule" },
    { kind: "paragraph", text: "line one\nline two" },
    { kind: "item", prefix: "•", text: "item", indent: 0 },
    { kind: "paragraph", text: "para" },
  ]);
  assert.deepEqual(parseMarkdown("a\r\nb"), [{ kind: "paragraph", text: "a\nb" }]);
  assert.deepEqual(parseMarkdown(""), []);
});

// ── Inline ────────────────────────────────────────────────────────────────────

test("inline code, bold, italic and links nest as a tree", () => {
  assert.deepEqual(parseInline("Use `npm ci` **now**, *really* or __not__ _ever_."), [
    { kind: "text", text: "Use " },
    { kind: "code", text: "npm ci" },
    { kind: "text", text: " " },
    { kind: "strong", children: [{ kind: "text", text: "now" }] },
    { kind: "text", text: ", " },
    { kind: "em", children: [{ kind: "text", text: "really" }] },
    { kind: "text", text: " or " },
    { kind: "strong", children: [{ kind: "text", text: "not" }] },
    { kind: "text", text: " " },
    { kind: "em", children: [{ kind: "text", text: "ever" }] },
    { kind: "text", text: "." },
  ]);
  assert.deepEqual(parseInline("[**Docs**](https://example.com/a?b=1)"), [
    { kind: "link", url: "https://example.com/a?b=1", children: [{ kind: "strong", children: [{ kind: "text", text: "Docs" }] }] },
  ]);
});

test("snake_case words and code spans are not italics", () => {
  assert.deepEqual(parseInline("call my_long_name now"), [{ kind: "text", text: "call my_long_name now" }]);
  assert.deepEqual(parseInline("`a *b* c`"), [{ kind: "code", text: "a *b* c" }]);
  assert.deepEqual(parseInline("2 * 3 * 4"), [{ kind: "text", text: "2 * 3 * 4" }]);
});

test("only http and https addresses become links", () => {
  assert.equal(safeWebUrl("https://example.com"), "https://example.com/");
  assert.equal(safeWebUrl("http://localhost:3000/x"), "http://localhost:3000/x");
  for (const bad of ["javascript:alert(1)", "JaVaScRiPt:alert(1)", "file:///etc/passwd", "data:text/html,<b>x</b>", "vbscript:x", "/relative", "mailto:a@b.c", "not a url"]) {
    assert.equal(safeWebUrl(bad), null, bad);
  }
  // The address's parentheses pair up: all of it is the (refused) address.
  assert.deepEqual(parseInline("[click](javascript:alert(1))"), [
    { kind: "link", url: null, children: [{ kind: "text", text: "click" }] },
  ]);
  // Wikimedia's file names often have them; an unpaired one still ends the address as before.
  assert.deepEqual(parseInline("[Saturn](https://commons.wikimedia.org/wiki/File:Saturn_(cropped).jpg) and (this)"), [
    { kind: "link", url: "https://commons.wikimedia.org/wiki/File:Saturn_(cropped).jpg", children: [{ kind: "text", text: "Saturn" }] },
    { kind: "text", text: " and (this)" },
  ]);
  assert.deepEqual(parseInline("[a](https://a.org/b(c)"), [
    { kind: "link", url: "https://a.org/b(c", children: [{ kind: "text", text: "a" }] },
  ]);
});

// ── Rendering ─────────────────────────────────────────────────────────────────

test("markup in an answer is shown as text, never parsed", () => {
  const root = dom.root();
  const evil = '<img src=x onerror="alert(1)"> **<script>alert(2)</script>**\n```\n<b>code</b>\n```';
  renderMarkdown(root, evil); // fakedom throws if anything touches innerHTML
  assert.equal(root.find("IMG").length, 0);
  assert.equal(root.find("SCRIPT").length, 0);
  assert.equal(root.find("B").length, 0);
  assert.match(root.textContent, /<img src=x onerror="alert\(1\)">/);
  assert.equal(root.find("STRONG")[0].textContent, "<script>alert(2)</script>");
  assert.equal(root.find("PRE")[0].textContent, "<b>code</b>");
});

test("each block becomes its own element", () => {
  const root = dom.root();
  renderMarkdown(root, "## Answer\n\nHere:\n\n- **item 1**\n- item 2\n\n> note\n\n---\n\n```js\nx()\n```");
  const classes = root.children.map((c) => c.className);
  assert.deepEqual(classes, ["md-h md-h1", "md-p", "md-item", "md-item", "md-quote", "md-rule", "md-pre"]);
  assert.equal(root.find(".md-bullet")[0].textContent, "•");
  assert.equal(root.find(".md-copy").length, 1);
  // Rendering again replaces, it never appends.
  renderMarkdown(root, "plain");
  assert.equal(root.children.length, 1);
});

test("a web link opens through Rust; anything else is plain text", () => {
  const root = dom.root();
  renderMarkdown(root, "See [the docs](https://example.com/docs) or [this](file:///etc/passwd).");
  const links = root.find("A");
  assert.equal(links.length, 1);
  assert.equal(links[0].getAttribute("href"), "https://example.com/docs");
  const event = links[0].fire("click");
  assert.equal(event.defaultPrevented, true);
  assert.deepEqual(sent("open_url"), [{ url: "https://example.com/docs" }]);
  assert.match(root.textContent, /or this\.$/);
});

test("a table: header, rows and pipes escaped in cells; a lone pipe line stays text", () => {
  assert.deepEqual(parseMarkdown("Intro\n| A | B |\n|---|:-:|\n| 1 | `x` \\| y |\n| 2 |\nafter"), [
    { kind: "paragraph", text: "Intro" },
    { kind: "table", head: ["A", "B"], rows: [["1", "`x` | y"], ["2"]] },
    { kind: "paragraph", text: "after" },
  ]);
  assert.deepEqual(parseMarkdown("| not a table"), [{ kind: "paragraph", text: "| not a table" }]);
  const root = document.createElement("div");
  renderMarkdown(root, "| A | B |\n|---|---|\n| **1** | 2 |\n| 3 |");
  const table = root.querySelector(".md-table");
  assert.ok(table);
  assert.equal(table.find("TH").length, 2);
  // Short rows are filled out to the table's width.
  assert.equal(table.find("TD").length, 4);
  assert.equal(table.find("STRONG").length, 1);
});

// ── Rich cards (views/rich) ──────────────────────────────────────────────────

test("GitHub's alerts: the kind, an optional title, the quote lines under it as Markdown", () => {
  assert.deepEqual(parseMarkdown("Intro\n> [!WARNING]\n> Careful **now**\n>\n> $$x$$\nafter"), [
    { kind: "paragraph", text: "Intro" },
    { kind: "callout", type: "warning", title: "", body: "Careful **now**\n\n$$x$$" },
    { kind: "paragraph", text: "after" },
  ]);
  assert.deepEqual(parseMarkdown(">[!tip] First rule"), [{ kind: "callout", type: "tip", title: "First rule", body: "" }]);
  // An unknown kind stays a quote.
  assert.deepEqual(parseMarkdown("> [!SHOUT] hey"), [{ kind: "quote", text: "[!SHOUT] hey" }]);

  const root = dom.root();
  renderMarkdown(root, "> [!IMPORTANT] Prima regola\n> **Le tensioni** sono uguali.");
  const card = root.querySelector(".rc-callout");
  assert.ok(card);
  assert.equal(card.className, "rc-callout rc-important");
  assert.match(card.textContent, /^Prima regola/);
  assert.equal(card.find("STRONG")[0].textContent, "Le tensioni");
  renderMarkdown(root, "> [!NOTE]\n> text");
  assert.match(root.querySelector(".rc-callout-head").textContent, /Note/);
});

test("a title's Markdown is read, on an alert as on a card: **bold** shows bold, not its stars", () => {
  const root = dom.root();
  renderMarkdown(root, "> [!TIP] Come scegliere f: la regola **LIATE**\n> Logaritmi prima.");
  const head = root.querySelector(".rc-callout-head");
  assert.equal(head.textContent, "Come scegliere f: la regola LIATE");
  assert.equal(head.find("STRONG")[0].textContent, "LIATE");

  renderMarkdown(root, "```lumo-steps La regola **LIATE**\n## Uno\n$$a$$\n## Due\n$$b$$\n```");
  const title = root.querySelector(".rc-title");
  assert.equal(title.textContent, "La regola LIATE");
  assert.equal(title.getAttribute("title"), "La regola LIATE");
  assert.equal(title.find("STRONG")[0].textContent, "LIATE");
});

test("a lumo- block is a rich card, open while its fence is still to come", () => {
  assert.deepEqual(parseMarkdown("Here:\n```lumo-steps Integration by parts\n## One\n$$a$$\n```\nafter"), [
    { kind: "paragraph", text: "Here:" },
    { kind: "rich", type: "steps", title: "Integration by parts", body: "## One\n$$a$$", open: false },
    { kind: "paragraph", text: "after" },
  ]);
  assert.deepEqual(parseMarkdown("```lumo-calc\ninput: V"), [{ kind: "rich", type: "calc", title: "", body: "input: V", open: true }]);
  // The tool workshop's blocks, and kinds Lumo has no card for, stay code.
  assert.equal(parseMarkdown("```lumo-tool\n{}\n```")[0].kind, "code");
  assert.equal(parseMarkdown("```lumo-rocket\nx\n```")[0].kind, "code");

  const root = dom.root();
  renderMarkdown(root, "```lumo-steps Title\n## One\n$$a$$", { streaming: true });
  assert.ok(root.querySelector(".rc-pending"), "a block still being written shows its placeholder");
  // A block the card can't read stays the code it was written as.
  renderMarkdown(root, "```lumo-steps Title\n```");
  assert.ok(root.querySelector(".md-pre"));
  assert.equal(root.querySelector(".rc-card"), null);
});

test("a line that is only an https image is an image block; anything else stays text", () => {
  assert.deepEqual(parseMarkdown("See:\n![Op-amp](https://upload.wikimedia.org/a.png)\nafter"), [
    { kind: "paragraph", text: "See:" },
    { kind: "image", alt: "Op-amp", url: "https://upload.wikimedia.org/a.png" },
    { kind: "paragraph", text: "after" },
  ]);
  assert.deepEqual(parseMarkdown('![x](https://a.org/b.jpg "title")'), [{ kind: "image", alt: "x", url: "https://a.org/b.jpg" }]);
  for (const md of ["![x](http://a.org/b.png)", "![x](file:///c:/a.png)", "![x](javascript:alert(1))", "text ![x](https://a.org/b.png)"]) {
    assert.notEqual(parseMarkdown(md)[0].kind, "image", md);
  }
});

test("a lumo- block left open in a finished answer is read as closed, or shown as code with what follows", () => {
  const root = dom.root();
  // Stopped (or cut short) inside a block the card can read: the card.
  renderMarkdown(root, "Here:\n```lumo-steps T\n## A\n$$a$$\n## B\n$$b$$");
  assert.equal(root.querySelector(".rc-pending"), null);
  assert.ok(root.querySelector(".rc-steps"));
  // One it can't: its lines as code, nothing hidden.
  renderMarkdown(root, "```lumo-steps T\n## only one");
  assert.equal(root.querySelector(".rc-pending"), null);
  assert.match(root.querySelector(".md-pre").textContent, /only one/);
  // A closing fence indented a little still closes the block: the text after it is text.
  assert.deepEqual(parseMarkdown("```lumo-cards T\n## A\n- x: 1\n  ```\nafter text"), [
    { kind: "rich", type: "cards", title: "T", body: "## A\n- x: 1", open: false },
    { kind: "paragraph", text: "after text" },
  ]);
});

test("a lumo- block holds code blocks: inside a ```` fence, or a ```lang one inside ```", () => {
  const steps = "## Install\n```bash\nnpm i\n```\n## Run\n```\nnpm start\n```";
  assert.deepEqual(parseMarkdown("````lumo-steps Setup\n" + steps + "\n````\nafter"), [
    { kind: "rich", type: "steps", title: "Setup", body: steps, open: false },
    { kind: "paragraph", text: "after" },
  ]);
  // Three backticks: a ```bash opens a block of its own, its bare ``` closes it.
  assert.deepEqual(parseMarkdown("```lumo-steps Setup\n## Install\n```bash\nnpm i\n```\n## Run\nnpm start\n```\nafter"), [
    { kind: "rich", type: "steps", title: "Setup", body: "## Install\n```bash\nnpm i\n```\n## Run\nnpm start", open: false },
    { kind: "paragraph", text: "after" },
  ]);
  // A ```` block closes only on four backticks or more.
  assert.equal(parseMarkdown("````lumo-steps S\n## A\n```\n## B")[0].open, true);
  // Plain code fences are read as they always were.
  assert.deepEqual(parseMarkdown("```js\na\n```"), [{ kind: "code", lang: "js", code: "a" }]);
});

test("an image's address may hold parentheses that pair up, or be written in <…>", () => {
  const url = "https://upload.wikimedia.org/wikipedia/commons/c/c7/Saturn_during_Equinox_(cropped).jpg";
  assert.deepEqual(parseMarkdown(`![Saturn](${url})`), [{ kind: "image", alt: "Saturn", url }]);
  assert.deepEqual(parseMarkdown(`![Saturn](<${url}>)`), [{ kind: "image", alt: "Saturn", url }]);
  assert.deepEqual(parseMarkdown(`![Saturn](${url} "Saturn")`), [{ kind: "image", alt: "Saturn", url }]);
  assert.equal(parseMarkdown(`![Saturn](${url}) and more`)[0].kind, "paragraph");
});

test("an alert written right under a paragraph starts there, with or without a space after >", () => {
  assert.deepEqual(parseMarkdown("Some text\n>[!NOTE]\n> body"), [
    { kind: "paragraph", text: "Some text" },
    { kind: "callout", type: "note", title: "", body: "body" },
  ]);
});

test("a task list is a checklist; a list mixing task and plain items stays a list", () => {
  assert.deepEqual(parseMarkdown("Steps:\n- [ ] One `a`\n* [x] Two\n\n+ [X] Three\n  wrapped\nafter"), [
    { kind: "paragraph", text: "Steps:" },
    {
      kind: "checklist",
      items: [
        { text: "One `a`", done: false, indent: 0 },
        { text: "Two", done: true, indent: 0 },
        { text: "Three wrapped", done: true, indent: 0 },
      ],
    },
    { kind: "paragraph", text: "after" },
  ]);
  assert.deepEqual(parseMarkdown("- [ ] a\n- plain\n- [x] b"), [
    { kind: "item", prefix: "•", text: "[ ] a", indent: 0 },
    { kind: "item", prefix: "•", text: "plain", indent: 0 },
    { kind: "item", prefix: "•", text: "[x] b", indent: 0 },
  ]);
  // Not a task: no space after the box, or nothing in it.
  assert.equal(parseMarkdown("- [ ]")[0].kind, "item");
  assert.equal(parseMarkdown("- [x]done")[0].kind, "item");
  assert.deepEqual(parseMarkdown("```lumo-checklist Release 0.21.0\n- [ ] a\n- [x] b\n```"), [
    { kind: "rich", type: "checklist", title: "Release 0.21.0", body: "- [ ] a\n- [x] b", open: false },
  ]);
  const root = dom.root();
  renderMarkdown(root, "- [ ] a\n- [x] b");
  assert.ok(root.querySelector(".rc-check"));
  assert.equal(root.find(".rc-check-row").length, 2);
});

test("a task list followed by a numbered list is still a checklist, the numbered list a list", () => {
  const items = [
    { text: "a", done: false, indent: 0 },
    { text: "b", done: true, indent: 0 },
  ];
  assert.deepEqual(parseMarkdown("- [ ] a\n- [x] b\n\n1. Next\n2. Then"), [
    { kind: "checklist", items },
    { kind: "item", prefix: "1.", text: "Next", indent: 0 },
    { kind: "item", prefix: "2.", text: "Then", indent: 0 },
  ]);
  assert.deepEqual(parseMarkdown("- [ ] a\n- [x] b\n1. Next"), [
    { kind: "checklist", items },
    { kind: "item", prefix: "1.", text: "Next", indent: 0 },
  ]);
  assert.deepEqual(parseMarkdown("1. Do this\n\n- [ ] a\n- [x] b"), [
    { kind: "item", prefix: "1.", text: "Do this", indent: 0 },
    { kind: "checklist", items },
  ]);
  // A numbered list nested under a task item still makes it a plain list.
  assert.equal(parseMarkdown("- [ ] a\n  1. sub\n- [x] b")[0].kind, "item");
});

test("an image line that is not an https image stays in its paragraph", () => {
  for (const img of ["![img](pic.png)", "![img](http://x.com/a.png)"]) {
    assert.deepEqual(parseMarkdown(`Para\n${img}`), [{ kind: "paragraph", text: `Para\n${img}` }]);
  }
  assert.deepEqual(parseMarkdown("Para\n![img](https://x.com/a.png)"), [
    { kind: "paragraph", text: "Para" },
    { kind: "image", alt: "img", url: "https://x.com/a.png" },
  ]);
});

test("an image line still being written loads nothing until its line is done", () => {
  const url = "https://upload.wikimedia.org/wikipedia/commons/c/c7/Saturn_(cropped).jpg";
  const cut = "Here:\n![Saturn](https://upload.wikimedia.org/wikipedia/commons/c/c7/Saturn_(cropped)";
  assert.equal(parseMarkdown(cut).at(-1).kind, "image", "a finished text reads it as it is");
  assert.deepEqual(parseMarkdown(cut, true).map((b) => b.kind), ["paragraph", "paragraph"]);
  const root = dom.root();
  renderMarkdown(root, cut, { streaming: true, scope: "c#1" });
  renderMarkdown(root, `Here:\n![Saturn](${url})`, { streaming: true, scope: "c#1" });
  assert.equal(root.querySelector(".rc-image"), null);
  assert.equal(calls.filter(([cmd]) => cmd === "web_image").length, 0);
  // The next line has started, or the answer is done: the image.
  renderMarkdown(root, `Here:\n![Saturn](${url})\nMore`, { streaming: true, scope: "c#1" });
  assert.ok(root.querySelector(".rc-image"));
  const done = dom.root();
  renderMarkdown(done, `Here:\n![Saturn](${url})`, { scope: "c#1" });
  assert.ok(done.querySelector(".rc-image"));
  // In an alert at the end of the text as well, and the alert is drawn again once its line is done.
  const alert = dom.root();
  renderMarkdown(alert, `> [!NOTE]\n> ![Saturn](${url})`, { streaming: true, scope: "c#2" });
  assert.equal(alert.querySelector(".rc-image"), null);
  renderMarkdown(alert, `> [!NOTE]\n> ![Saturn](${url})\n\nMore`, { streaming: true, scope: "c#2" });
  assert.ok(alert.querySelector(".rc-image"));
  renderMarkdown(alert, `> [!NOTE]\n> ![Saturn](${url})`, { scope: "c#2" });
  assert.ok(alert.querySelector(".rc-image"));
});

test("a finished card stays the same node while the answer goes on being written", () => {
  const root = dom.root();
  const head = "Intro\n```lumo-steps T\n## A\n$$a$$\n## B\n$$b$$\n```\n";
  renderMarkdown(root, head + "More", { streaming: true, scope: "c#1" });
  const card = root.querySelector(".rc-steps");
  renderMarkdown(root, head + "More words", { streaming: true, scope: "c#1" });
  assert.equal(root.querySelector(".rc-steps"), card);
  assert.equal(root.children[1], card);
  // Another text in its place: a new card.
  renderMarkdown(root, "```lumo-steps T\n## A\n$$a$$\n## C\n$$c$$\n```", { streaming: true, scope: "c#1" });
  assert.notEqual(root.querySelector(".rc-steps"), card);
});

test("a block being written keeps one placeholder, and nothing kept is taken out and put back", () => {
  const root = dom.root();
  const head = "Intro\n```lumo-steps T\n## A\n$$a$$\n## B\n$$b$$\n```\n\n```lumo-quiz Planets\n? Which is";
  renderMarkdown(root, head, { streaming: true, scope: "p#1" });
  const card = root.querySelector(".rc-steps");
  const pending = root.querySelector(".rc-pending");
  assert.ok(pending);
  // Taken out and put back, a node starts its CSS animations over: the dots,
  // at every chunk. Only the new paragraphs go in.
  const moved = [];
  const insert = root.insertBefore.bind(root);
  root.insertBefore = (node, ref) => (moved.push(node), insert(node, ref));
  for (const more of [" the largest?", " the largest?\n- Mars", " the largest?\n- Mars\n+ Jupiter"]) {
    renderMarkdown(root, head + more, { streaming: true, scope: "p#1" });
    assert.equal(root.querySelector(".rc-pending"), pending, "the same placeholder");
    assert.equal(root.querySelector(".rc-steps"), card);
  }
  assert.ok(!moved.includes(pending) && !moved.includes(card));
  // Its fence closed: the card in the placeholder's place.
  renderMarkdown(root, head + " the largest?\n- Mars\n+ Jupiter\n```", { streaming: true, scope: "p#1" });
  assert.equal(root.querySelector(".rc-pending"), null);
  assert.ok(root.querySelector(".rc-quiz"));
  assert.equal(root.children.at(-1), root.querySelector(".rc-quiz"));
});

test("the same block in two messages keeps two states", () => {
  const text = "```lumo-steps Twins\n## A\n$$a$$\n## B\n$$b$$\n## C\n$$c$$\n```";
  const one = dom.root();
  const two = dom.root();
  renderMarkdown(one, text, { scope: "chat#1" });
  renderMarkdown(two, text, { scope: "chat#3" });
  const next = (root) => root.querySelector(".rc-steps").find("BUTTON").find((b) => b.getAttribute("aria-label") === "Next step");
  next(one).fire("click");
  assert.equal(one.find(".rc-count")[0].textContent, "2 / 3");
  assert.equal(two.find(".rc-count")[0].textContent, "1 / 3");
  next(two).fire("click");
  assert.equal(two.find(".rc-count")[0].textContent, "2 / 3");
  // Drawn again, each message's card is where it was.
  renderMarkdown(one, text, { scope: "chat#1" });
  assert.equal(one.find(".rc-count")[0].textContent, "2 / 3");
});

test("a code block holds a shorter fence, and one indented under a list item is still one", () => {
  const nested = parseMarkdown("````markdown\n```js\nlet a = 1;\n```\n````\nAfter");
  assert.deepEqual(nested, [
    { kind: "code", lang: "markdown", code: "```js\nlet a = 1;\n```" },
    { kind: "paragraph", text: "After" },
  ]);
  const listed = parseMarkdown("1. Run this:\n   ```bash\n   ls -la\n     cd x\n   ```\n2. Done");
  assert.deepEqual(listed.map((b) => b.kind), ["item", "code", "item"]);
  assert.deepEqual(listed[1], { kind: "code", lang: "bash", code: "ls -la\n  cd x" });
  // A paragraph ends where an indented fence starts.
  assert.deepEqual(parseMarkdown("Text\n  ```\nx\n  ```").map((b) => b.kind), ["paragraph", "code"]);
});

test("a card drawn when nothing could be sent is drawn again once it can", () => {
  const root = dom.root();
  const text = "```lumo-quiz Q\n? One?\n- a\n+ b\n```";
  renderMarkdown(root, text, { scope: "ink-send", streaming: true });
  const inked = root.find(".rc-quiz")[0];
  assert.ok(inked);
  renderMarkdown(root, text, { scope: "ink-send", send: () => {} });
  const done = root.find(".rc-quiz")[0];
  assert.notEqual(done, inked);
  // Then it stays the same node from one draw to the next.
  renderMarkdown(root, text, { scope: "ink-send", send: () => {} });
  assert.equal(root.find(".rc-quiz")[0], done);
});
