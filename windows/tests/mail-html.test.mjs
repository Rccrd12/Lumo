// An email as its sender drew it (src/core/mail-html.ts): which links open,
// what the corner says, how it is shrunk to fit, which images wait for Load
// images and what of the email is taken out. mail.rs html_of is tested there.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DROPPED_TAGS, MAX_EMAIL_IMAGES, droppedAttribute, fitZoom, hiddenBox, imagesToLoad, linkLabel, opensInBrowser, webImageUrl,
} from "../src/core/mail-html.ts";

test("only http and https links open, in the browser", () => {
  assert.equal(opensInBrowser("https://shop.example/track"), true);
  assert.equal(opensInBrowser(" http://shop.example "), true);
  assert.equal(opensInBrowser("javascript:alert(1)"), false);
  assert.equal(opensInBrowser("mailto:ada@example.com"), false);
  assert.equal(opensInBrowser("file:///C:/Windows"), false);
  assert.equal(opensInBrowser("#top"), false);
});

test("the corner says where a link really goes: the site and the path, not the tracking", () => {
  assert.equal(linkLabel("https://libreria-aurora.example/ordini/48213/traccia?utm_source=email&u=9"), "libreria-aurora.example/ordini/48213/traccia");
  assert.equal(linkLabel("https://shop.example/"), "shop.example");
  assert.equal(linkLabel("https://shop.example/a/"), "shop.example/a");
  assert.equal(linkLabel("javascript:void(0)"), "");
  assert.equal(linkLabel("https://"), "");
  assert.ok(linkLabel(`https://x.example/${"a".repeat(200)}`).endsWith("…"));
  assert.ok(linkLabel(`https://x.example/${"a".repeat(200)}`).length <= 80);
});

test("an email wider than the room is shrunk to fit, never below half", () => {
  assert.equal(fitZoom(600, 640), 1);
  assert.equal(fitZoom(600, 600), 1);
  assert.equal(fitZoom(600, 540), 0.9);
  assert.equal(fitZoom(2000, 540), 0.5);
  assert.equal(fitZoom(0, 540), 1);
  assert.equal(fitZoom(600, 0), 1);
});

test("Load images asks for each https image once, and at most so many", () => {
  assert.equal(webImageUrl("https://img.example/a.png"), true);
  assert.equal(webImageUrl("http://img.example/a.png"), false);
  assert.equal(webImageUrl("cid:logo"), false);
  assert.deepEqual(imagesToLoad(["https://a/1.png", " https://a/1.png", "http://a/2.png", "cid:x", "https://a/3.png"]), ["https://a/1.png", "https://a/3.png"]);
  const many = Array.from({ length: 100 }, (_, i) => `https://a/${i}.png`);
  assert.equal(imagesToLoad(many).length, MAX_EMAIL_IMAGES);
});

test("a hidden image keeps its box: its own size, 48 px tall with a width only, 48 × 48 with neither", () => {
  assert.equal(hiddenBox("600", "170", ""), "");
  assert.equal(hiddenBox(null, null, "width:600px;height:170px"), "");
  assert.equal(hiddenBox("600", null, ""), "h");
  assert.equal(hiddenBox(null, null, "max-width:600px"), "wh");
  assert.equal(hiddenBox(null, "", "display:block"), "wh");
});

test("what runs, loads or goes somewhere is taken out of the email", () => {
  for (const tag of ["script", "iframe", "object", "embed", "base", "link", "meta", "form"]) assert.ok(DROPPED_TAGS.includes(tag), tag);
  assert.equal(droppedAttribute("onclick", "x()"), true);
  assert.equal(droppedAttribute("ONLOAD", "x()"), true);
  assert.equal(droppedAttribute("href", "javascript:alert(1)"), true);
  assert.equal(droppedAttribute("href", " java\u0009script:alert(1)"), true);
  assert.equal(droppedAttribute("src", "data:text/html,<script>"), true);
  assert.equal(droppedAttribute("href", "https://shop.example"), false);
  assert.equal(droppedAttribute("style", "color:red"), false);
});
