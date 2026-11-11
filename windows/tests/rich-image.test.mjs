// An image in an answer (src/views/rich/image.ts): downloaded at once from
// Wikimedia, after a click on Load image from any other site, by Rust
// (web_image), and shown through a blob: URL, unless Settings → Security
// → Images from the web is off: then the card is one row with the site, the
// alt text and the way to the browser, and nothing is downloaded. The card
// survives the chat's redraws.

import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { installFakeDom } from "./fakedom.mjs";
import { calls, internals, sent } from "./tauri.mjs";

const { root } = installFakeDom();
const { renderMarkdown } = await import("../src/views/markdown.ts");
const { renderImage, imageType, siteOf, resetImages, MAX_PER_ANSWER } = await import("../src/views/rich/image.ts");
const { State, DEFAULT_SETTINGS } = await import("../src/core/state.ts");

const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13];
const URL_A = "https://upload.wikimedia.org/wikipedia/commons/a/a1/Op-amp.png";
const URL_B = "https://upload.wikimedia.org/wikipedia/commons/b/b2/Other.png";

/** What Rust answers to web_image, by URL: bytes, or an error. */
let answers = new Map();
/** Downloads under way in Rust, and the most at once; `slow` makes each one last a turn of the event loop. */
let inFlight = 0;
let peak = 0;
let slow = false;
const realInvoke = internals.invoke;
internals.invoke = async (cmd, args) => {
  if (cmd === "web_image") {
    calls.push([cmd, args]);
    peak = Math.max(peak, ++inFlight);
    if (slow) await new Promise((r) => setTimeout(r, 0));
    inFlight--;
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
const openButton = (card) => buttons(card).find((b) => b.getAttribute("aria-label") === "Open in the browser");

beforeEach(() => {
  calls.length = 0;
  inFlight = 0;
  peak = 0;
  slow = false;
  answers = new Map();
  resetImages();
  State.settings = { ...State.settings, webImages: true };
});

test("images from the web are on unless the user turns them off", () => {
  assert.equal(DEFAULT_SETTINGS.webImages, true);
});

test("from a site that may keep a record, the image waits for a click on Load image", async () => {
  const other = "https://images.example.com/p.png?d=secret";
  answers.set(other, PNG);
  const box = document.createElement("div");
  const card = renderImage("Chart", other);
  box.append(card);
  await settle();
  // Nothing downloaded: the row, with the site, the alt text, Load image and the browser.
  assert.deepEqual(sent("web_image"), []);
  assert.ok(card.className.includes("off"));
  assert.equal(card.querySelector(".rc-image-cap").textContent, "Chart");
  assert.ok(openButton(card));
  byText(card, "Load image").fire("click");
  await settle();
  // The click downloads it, saying so to Rust, and the row becomes the image.
  assert.deepEqual(sent("web_image"), [{ url: other, asked: true }]);
  assert.ok(!box.childNodes.includes(card));
  assert.equal(box.childNodes.length, 1);
  const shown = box.childNodes[0];
  assert.equal(state(shown), "shown");
  // Drawn again (the chat redrawn), it stays the image.
  assert.equal(state(renderImage("Chart", other)), "shown");
});

test("a plain http address, or another port, is never one that loads at once", async () => {
  const { loadsAtOnce } = await import("../src/views/rich/image.ts");
  assert.ok(loadsAtOnce(URL_A));
  assert.ok(loadsAtOnce("https://Upload.Wikimedia.org./x.png"));
  assert.ok(!loadsAtOnce("http://upload.wikimedia.org/x.png"));
  assert.ok(!loadsAtOnce("https://upload.wikimedia.org:8443/x.png"));
  assert.ok(!loadsAtOnce("https://upload.wikimedia.org.evil.com/x.png"));
  assert.ok(!loadsAtOnce("https://evil.com/upload.wikimedia.org/x.png"));
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

test("the site is the image's host, lowercase", () => {
  assert.equal(siteOf("https://Upload.Wikimedia.org./x.png"), "upload.wikimedia.org");
  assert.equal(siteOf("not a url"), "");
});

test("the image downloads at once, through Rust, and shows from a blob: URL with its source", async () => {
  answers.set(URL_A, PNG);
  const card = renderImage("Op-amp", URL_A);
  assert.equal(state(card), "loading");
  assert.deepEqual(sent("web_image"), [{ url: URL_A }]);
  await settle();
  assert.equal(state(card), "shown");
  const [img] = card.find("IMG");
  assert.match(img.getAttribute("src"), /^blob:/);
  assert.equal(img.getAttribute("alt"), "Op-amp");
  assert.match(card.querySelector(".rc-image-src").textContent, /^upload\.wikimedia\.org$/);
  assert.equal(card.querySelector(".rc-image-cap").textContent, "Op-amp");
  // Nothing asked, nothing saved: the settings stay as they were.
  assert.equal(sent("save_settings").length, 0);
  for (const b of buttons(card)) assert.ok(b.getAttribute("aria-label"), b.textContent);
});

test("a redraw shows the image at once, without downloading it again", async () => {
  answers.set(URL_A, PNG);
  renderImage("Op-amp", URL_A);
  // The chat redraws while the image downloads: the new card waits for the same download.
  const second = renderImage("Op-amp", URL_A);
  assert.equal(state(second), "loading");
  await settle();
  assert.equal(state(second), "shown");
  const third = renderImage("Op-amp", URL_A);
  assert.equal(state(third), "shown");
  assert.equal(sent("web_image").length, 1);
  // Another image is a download of its own.
  answers.set(URL_B, PNG);
  renderImage("", URL_B);
  assert.equal(sent("web_image").length, 2);
});

test("turned off, the card is one row with the site, the alt text and the browser, and nothing is downloaded", async () => {
  State.settings = { ...State.settings, webImages: false };
  answers.set(URL_A, PNG);
  const card = renderImage("Inverting amplifier", URL_A);
  await settle();
  assert.equal(sent("web_image").length, 0);
  assert.equal(frame(card), null);
  assert.equal(card.find("IMG").length, 0);
  assert.match(card.className, /\boff\b/);
  assert.equal(card.querySelector(".rc-image-src").textContent, "upload.wikimedia.org");
  assert.equal(card.querySelector(".rc-image-cap").textContent, "Inverting amplifier");
  openButton(card).fire("click");
  assert.deepEqual(sent("open_url"), [{ url: URL_A }]);
  // With no alt text, the row still says what it is.
  assert.equal(renderImage("", URL_A).querySelector(".rc-image-cap").textContent, "Image");
  // Turned on again, the next drawing downloads it.
  State.settings = { ...State.settings, webImages: true };
  const on = renderImage("Inverting amplifier", URL_A);
  await settle();
  assert.equal(state(on), "shown");
  assert.equal(sent("web_image").length, 1);
});

test("an image that can't be loaded says so, with its site, and can be tried again", async () => {
  answers.set(URL_A, new Error("The image is bigger than 8 MB."));
  const card = renderImage("", URL_A);
  await settle();
  assert.equal(state(card), "error");
  assert.match(card.textContent, /Couldn't load the image/);
  assert.match(card.textContent, /upload\.wikimedia\.org/);
  // Why, as Rust said it, under the pointer.
  assert.equal(card.querySelector(".rc-image-msg").getAttribute("title"), "The image is bigger than 8 MB.");
  // A redraw doesn't download it again by itself.
  const again = renderImage("", URL_A);
  assert.equal(state(again), "error");
  assert.equal(sent("web_image").length, 1);
  answers.set(URL_A, PNG);
  byText(card, "Try again").fire("click");
  await settle();
  assert.equal(state(card), "shown");
  assert.equal(state(again), "shown", "every card of that image tries again");
  assert.equal(sent("web_image").length, 2);
});

test("bytes that are no image the card shows are an error, not a picture", async () => {
  answers.set(URL_A, [...new TextEncoder().encode("<svg onload=alert(1)>")]);
  const card = renderImage("", URL_A);
  await settle();
  assert.equal(state(card), "error");
  assert.equal(card.find("IMG").length, 0);
});

test("the arrow and the image open the page in the browser", async () => {
  answers.set(URL_A, PNG);
  const card = renderImage("", URL_A);
  openButton(card).fire("click");
  assert.deepEqual(sent("open_url"), [{ url: URL_A }]);
  await settle();
  card.find("IMG")[0].fire("click");
  assert.equal(sent("open_url").length, 2);
});

test("markdown turns a line that is only an image into the card", async () => {
  const { renderMarkdown } = await import("../src/views/markdown.ts");
  const root = document.createElement("div");
  renderMarkdown(root, `The circuit:\n\n![Op-amp](${URL_A})`);
  assert.equal(root.find(".rc-image").length, 1);
  assert.deepEqual(sent("web_image"), [{ url: URL_A }]);
});

/** `count` distinct image URLs, each answered with a small PNG. */
function many(count) {
  return Array.from({ length: count }, (_, i) => {
    const url = `https://upload.wikimedia.org/wikipedia/commons/x/x${i}.png`;
    answers.set(url, PNG);
    return url;
  });
}

test("at most 4 images download at once; the others wait their turn", async () => {
  slow = true;
  const urls = many(10);
  const cards = urls.map((url) => renderImage("", url));
  assert.equal(sent("web_image").length, 4, "the first four start at once, the others on their turn");
  for (let i = 0; i < 20 && cards.some((c) => state(c) !== "shown"); i++) await settle();
  assert.ok(cards.every((c) => state(c) === "shown"));
  assert.equal(sent("web_image").length, 10);
  assert.equal(peak, 4);
});

test("an answer shows its first images only; the ones after are the one row, not downloaded", async () => {
  const urls = many(MAX_PER_ANSWER + 3);
  const cards = urls.map((url, i) => renderImage(i === MAX_PER_ANSWER ? "Last" : "", url, i));
  await settle();
  assert.equal(sent("web_image").length, MAX_PER_ANSWER);
  assert.equal(state(cards[MAX_PER_ANSWER - 1]), "shown");
  const past = cards[MAX_PER_ANSWER];
  assert.match(past.className, /\boff\b/);
  assert.equal(frame(past), null);
  assert.equal(past.querySelector(".rc-image-cap").textContent, "Last");
  assert.equal(cards[MAX_PER_ANSWER + 1].querySelector(".rc-image-cap").textContent, "Image");
  openButton(past).fire("click");
  assert.deepEqual(sent("open_url"), [{ url: urls[MAX_PER_ANSWER] }]);
});

test("a long chat of small images is drawn again from memory, not downloaded again", async () => {
  // The chat draws its whole log again whenever a message comes: 60 images
  // drawn twice are 60 downloads, not 60 and then the oldest again.
  const urls = many(60);
  for (const url of urls) renderImage("", url);
  for (let i = 0; i < 5; i++) await settle();
  assert.equal(sent("web_image").length, 60);
  const again = urls.map((url) => renderImage("", url));
  assert.ok(again.every((c) => state(c) === "shown"));
  assert.equal(sent("web_image").length, 60);
});

test("big images go from memory past 64 MB, the least recently shown first", async () => {
  const big = new Uint8Array(8 * 1024 * 1024);
  big.set(PNG);
  const urls = many(9);
  for (const url of urls) answers.set(url, big);
  for (const url of urls) {
    renderImage("", url);
    await settle();
  }
  assert.equal(sent("web_image").length, 9);
  // Eight fit in 64 MB: the first went when the ninth came, the others stay.
  assert.equal(state(renderImage("", urls[8])), "shown");
  assert.equal(state(renderImage("", urls[1])), "shown");
  assert.equal(state(renderImage("", urls[0])), "loading");
  assert.equal(sent("web_image").length, 10);
});

test("an answer's images are counted through its Markdown, a callout's included: past the first ones, nothing is downloaded", async () => {
  const urls = many(MAX_PER_ANSWER + 3);
  const line = (url) => `![](${url})`;
  const answer = [
    ...urls.slice(0, 8).map(line),
    `> [!NOTE] Pictures\n${urls.slice(8, 11).map((u) => `> ${line(u)}`).join("\n>\n")}`,
    ...urls.slice(11).map(line),
  ].join("\n\n");
  const into = root();
  renderMarkdown(into, answer);
  for (let i = 0; i < 5; i++) await settle();
  assert.deepEqual(sent("web_image").map((c) => c.url), urls.slice(0, MAX_PER_ANSWER));
  const cards = into.find(".rc-image");
  assert.equal(cards.length, MAX_PER_ANSWER + 3);
  assert.equal(cards.filter((c) => /\boff\b/.test(c.className)).length, 3);
  // Drawn again (the chat redraws its log), the same ones stay off.
  renderMarkdown(into, answer);
  await settle();
  assert.equal(sent("web_image").length, MAX_PER_ANSWER);
  // Another answer counts its own.
  renderMarkdown(root(), line(urls[MAX_PER_ANSWER + 2]));
  await settle();
  assert.equal(sent("web_image").length, MAX_PER_ANSWER + 1);
});
