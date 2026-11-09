// An image in an answer (src/views/rich/image.ts): nothing is downloaded
// until the user says so, for this image (Show) or its site (Always from …,
// kept in the settings); Rust downloads it (web_image) and the card shows the
// bytes through a blob: URL; the card survives the chat's redraws.

import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { installFakeDom } from "./fakedom.mjs";
import { calls, internals, sent } from "./tauri.mjs";

installFakeDom();
const { renderImage, imageType, siteOf, imageAllowed, resetImages } = await import("../src/views/rich/image.ts");
const { State } = await import("../src/core/state.ts");

const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13];
const URL_A = "https://upload.wikimedia.org/wikipedia/commons/a/a1/Op-amp.png";
const URL_B = "https://upload.wikimedia.org/wikipedia/commons/b/b2/Other.png";

/** What Rust answers to web_image, by URL: bytes, or an error. */
let answers = new Map();
const realInvoke = internals.invoke;
internals.invoke = async (cmd, args) => {
  if (cmd === "web_image") {
    calls.push([cmd, args]);
    const answer = answers.get(args.url);
    if (answer instanceof Error) throw answer;
    return answer ? new Uint8Array(answer).buffer : null;
  }
  return realInvoke(cmd, args);
};

/** Lets the downloads under way finish. */
const settle = () => new Promise((r) => setTimeout(r, 0));
const frame = (card) => card.querySelector(".rc-image-frame");
const state = (card) => frame(card).className.replace("rc-image-frame", "").trim();
const buttons = (card) => card.find("BUTTON");
const byText = (card, text) => buttons(card).find((b) => b.textContent === text);

beforeEach(() => {
  calls.length = 0;
  answers = new Map();
  resetImages();
  State.settings = { ...State.settings, webImageSites: [] };
});

test("the image's type is read from its first bytes, never from its name", () => {
  assert.equal(imageType(new Uint8Array(PNG)), "image/png");
  assert.equal(imageType(new Uint8Array([0xff, 0xd8, 0xff, 0xe0])), "image/jpeg");
  assert.equal(imageType(new TextEncoder().encode("GIF89a....")), "image/gif");
  assert.equal(imageType(new TextEncoder().encode("RIFF\0\0\0\0WEBPVP8 ")), "image/webp");
  assert.equal(imageType(new Uint8Array([0, 0, 0, 0x1c, ...new TextEncoder().encode("ftypmif1\0\0\0\0mif1avif")])), "image/avif");
  assert.equal(imageType(new Uint8Array([0, 0, 0, 0x18, ...new TextEncoder().encode("ftypheic\0\0\0\0mif1heic")])), null);
  assert.equal(imageType(new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"/>')), null);
  assert.equal(imageType(new Uint8Array()), null);
});

test("the site is the image's exact host, lowercase", () => {
  assert.equal(siteOf("https://Upload.Wikimedia.org./x.png"), "upload.wikimedia.org");
  assert.equal(siteOf("not a url"), "");
});

test("first the card asks, and nothing is downloaded", () => {
  const card = renderImage("Inverting amplifier", URL_A);
  assert.equal(state(card), "ask");
  assert.match(card.textContent, /This answer has an image from upload\.wikimedia\.org/);
  assert.match(card.textContent, /Inverting amplifier/);
  assert.ok(byText(card, "Show"));
  assert.ok(byText(card, "Always from upload.wikimedia.org"));
  assert.equal(sent("web_image").length, 0);
  assert.equal(card.find("IMG").length, 0);
  // Every button can be reached and named.
  for (const b of buttons(card)) assert.ok(b.getAttribute("aria-label"), b.textContent);
});

test("Show downloads this image only, through Rust, and shows it from a blob: URL", async () => {
  answers.set(URL_A, PNG);
  const card = renderImage("Op-amp", URL_A);
  byText(card, "Show").fire("click");
  assert.equal(state(card), "loading");
  assert.deepEqual(sent("web_image"), [{ url: URL_A }]);
  await settle();
  assert.equal(state(card), "shown");
  const [img] = card.find("IMG");
  assert.match(img.getAttribute("src"), /^blob:/);
  assert.equal(img.getAttribute("alt"), "Op-amp");
  // Only for this image: another one of the same site still asks.
  assert.ok(imageAllowed(URL_A));
  assert.ok(!imageAllowed(URL_B));
  assert.equal(state(renderImage("", URL_B)), "ask");
  assert.deepEqual(State.settings.webImageSites, []);
  assert.equal(sent("save_settings").length, 0);
});

test("a redraw shows the image at once, without downloading it again", async () => {
  answers.set(URL_A, PNG);
  const first = renderImage("Op-amp", URL_A);
  byText(first, "Show").fire("click");
  // The chat redraws while the image downloads: the new card waits for the same download.
  const second = renderImage("Op-amp", URL_A);
  assert.equal(state(second), "loading");
  await settle();
  assert.equal(state(second), "shown");
  const third = renderImage("Op-amp", URL_A);
  assert.equal(state(third), "shown");
  assert.equal(sent("web_image").length, 1);
});

test("Always from … keeps the site in the settings and loads every image of it", async () => {
  answers.set(URL_A, PNG);
  answers.set(URL_B, PNG);
  const a = renderImage("A", URL_A);
  const b = renderImage("B", URL_B);
  const other = renderImage("C", "https://example.org/c.png");
  byText(a, "Always from upload.wikimedia.org").fire("click");
  assert.deepEqual(State.settings.webImageSites, ["upload.wikimedia.org"]);
  const [saved] = sent("save_settings");
  assert.deepEqual(saved.settings.webImageSites, ["upload.wikimedia.org"]);
  await settle();
  assert.equal(state(a), "shown");
  assert.equal(state(b), "shown", "the other card of that site loads too");
  assert.equal(state(other), "ask", "another site still asks");
  assert.deepEqual(sent("web_image").map((x) => x.url).sort(), [URL_A, URL_B].sort());
  // A new answer's image of that site loads without asking.
  const later = renderImage("", "https://upload.wikimedia.org/x/new.png");
  assert.equal(state(later), "loading");
});

test("a site removed in Settings asks again, even for an image already here", async () => {
  State.settings = { ...State.settings, webImageSites: ["upload.wikimedia.org"] };
  answers.set(URL_A, PNG);
  const card = renderImage("", URL_A);
  await settle();
  assert.equal(state(card), "shown");
  State.settings = { ...State.settings, webImageSites: [] };
  assert.equal(state(renderImage("", URL_A)), "ask");
});

test("an image that can't be loaded says so, with its site, and can be tried again", async () => {
  answers.set(URL_A, new Error("The image is bigger than 8 MB."));
  const card = renderImage("", URL_A);
  byText(card, "Show").fire("click");
  await settle();
  assert.equal(state(card), "error");
  assert.match(card.textContent, /Couldn't load the image/);
  assert.match(card.textContent, /upload\.wikimedia\.org/);
  // A redraw doesn't download it again by itself.
  assert.equal(state(renderImage("", URL_A)), "error");
  assert.equal(sent("web_image").length, 1);
  answers.set(URL_A, PNG);
  byText(card, "Try again").fire("click");
  await settle();
  assert.equal(state(card), "shown");
  assert.equal(sent("web_image").length, 2);
});

test("bytes that are no image the card shows are an error, not a picture", async () => {
  answers.set(URL_A, [...new TextEncoder().encode("<svg onload=alert(1)>")]);
  const card = renderImage("", URL_A);
  byText(card, "Show").fire("click");
  await settle();
  assert.equal(state(card), "error");
  assert.equal(card.find("IMG").length, 0);
});

test("the arrow and the image open the page in the browser", async () => {
  answers.set(URL_A, PNG);
  const card = renderImage("", URL_A);
  const open = buttons(card).find((b) => b.getAttribute("aria-label") === "Open in the browser");
  open.fire("click");
  assert.deepEqual(sent("open_url"), [{ url: URL_A }]);
  byText(card, "Show").fire("click");
  await settle();
  card.find("IMG")[0].fire("click");
  assert.equal(sent("open_url").length, 2);
});

test("markdown turns a line that is only an image into the card", async () => {
  const { renderMarkdown } = await import("../src/views/markdown.ts");
  const root = document.createElement("div");
  renderMarkdown(root, `The circuit:\n\n![Op-amp](${URL_A})`);
  assert.equal(root.find(".rc-image").length, 1);
  assert.equal(sent("web_image").length, 0);
});
