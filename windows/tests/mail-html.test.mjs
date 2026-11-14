// An email as its sender drew it (src/core/mail-html.ts): which links open,
// what the corner says, how it is shrunk to fit, which images wait for Load
// images and what of the email is taken out. What Rust sends (mail.rs
// html_plan, assemble) is tested there.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  DROPPED_TAGS, EMAIL_FRAME_CSP, EMAIL_FRAME_SANDBOX, MAX_EMAIL_IMAGES, anchorOf, backgroundUrl, browserUrl, droppedAttribute, fitZoom, hiddenBox, httpsImage,
  imageSource, imagesLeftOut, imagesToLoad, isDataUrl, linkParts, mailtoUrl, opensInBrowser, readMailHtml, trackingPixel, webImageUrl,
} from "../src/core/mail-html.ts";

test("only http and https links open, in the browser", () => {
  assert.equal(opensInBrowser("https://shop.example/track"), true);
  assert.equal(opensInBrowser(" http://shop.example "), true);
  assert.equal(opensInBrowser("javascript:alert(1)"), false);
  assert.equal(opensInBrowser("mailto:ada@example.com"), false);
  assert.equal(opensInBrowser("file:///C:/Windows"), false);
  assert.equal(opensInBrowser("#top"), false);
});

test("the corner says where a link really goes: the whole site, then the path, not the tracking", () => {
  assert.deepEqual(linkParts("https://libreria-aurora.example/ordini/48213/traccia?utm_source=email&u=9"), { host: "libreria-aurora.example", path: "/ordini/48213/traccia" });
  assert.deepEqual(linkParts("https://shop.example/"), { host: "shop.example", path: "" });
  assert.deepEqual(linkParts("https://shop.example/a/"), { host: "shop.example", path: "/a" });
  assert.equal(linkParts("javascript:void(0)"), null);
  assert.equal(linkParts("https://"), null);
  // A long path gives way; the site never does.
  const long = linkParts(`https://x.example/${"a".repeat(200)}`);
  assert.equal(long.host, "x.example");
  assert.ok(long.path.endsWith("…") && long.path.length <= 60);
  // A name made to look like another site's keeps its end, the domain that owns it.
  const phish = linkParts("https://www.paypal.com.account-security-verification-center-login-session-renewal.evil.example/login");
  assert.ok(phish.host.endsWith("renewal.evil.example"), phish.host);
  assert.ok(phish.host.startsWith("…"));
  // A path that isn't valid percent-encoding is shown as it is.
  assert.deepEqual(linkParts("https://shop.example/%E0%A4%A"), { host: "shop.example", path: "/%E0%A4%A" });
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
  // "auto" is no size: a 1×1 stand-in with a width would be drawn as a square.
  assert.equal(hiddenBox("600", "auto", ""), "h");
  assert.equal(hiddenBox("600", null, "height:auto"), "h");
  assert.equal(hiddenBox("auto", "auto", ""), "wh");
});

test("an email's HTML from Rust: its text, or its bytes read in their charset", () => {
  assert.equal(readMailHtml({ html: "<p>Ciao</p>" }), "<p>Ciao</p>");
  assert.equal(readMailHtml({ html: "" }), "");
  assert.equal(readMailHtml(null), "");
  // Shift_JIS "あ" (0x82 0xA0), as Rust hands it over.
  assert.equal(readMailHtml({ html: "", bytes: Buffer.from([0x3c, 0x70, 0x3e, 0x82, 0xa0]).toString("base64"), charset: "Shift_JIS" }), "<p>あ");
  // windows-1251 "Привет"
  assert.equal(readMailHtml({ html: "", bytes: Buffer.from([0xcf, 0xf0, 0xe8, 0xe2, 0xe5, 0xf2]).toString("base64"), charset: "windows-1251" }), "Привет");
  // A charset no one knows: read as UTF-8.
  assert.equal(readMailHtml({ html: "", bytes: Buffer.from("ok").toString("base64"), charset: "x-unknown" }), "ok");
  assert.equal(readMailHtml({ html: "", bytes: "%%%", charset: "utf-8" }), "");
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
  // A shadow root declared in the HTML, and names that would stand for the frame's own methods.
  assert.ok(DROPPED_TAGS.includes("template"));
  assert.equal(droppedAttribute("shadowrootmode", "open"), true);
  assert.equal(droppedAttribute("name", "addEventListener"), true);
});

test("a tracking pixel is never loaded: 2 × 2 px or less, or from a service made for it", () => {
  // 2 × 2 px or less, by its attributes or its style; 0 wide or tall.
  assert.equal(trackingPixel("https://www.amazon.it/gp/r.html?C=1&T=O", "1", "1", ""), true);
  assert.equal(trackingPixel("https://shop.example/a.gif", null, null, "width:1px;height:1px"), true);
  assert.equal(trackingPixel("https://shop.example/a.gif", "0", null, ""), true);
  assert.equal(trackingPixel("https://shop.example/a.gif", "1", null, "height: 0 !important"), true);
  // The services and paths that count openings.
  assert.equal(trackingPixel("https://us5.list-manage.com/track/open.php?u=1", null, null, ""), true);
  assert.equal(trackingPixel("https://mandrillapp.com/track/open.php?u=1", null, null, ""), true);
  assert.equal(trackingPixel("https://u123.ct.sendgrid.net/wf/open?upn=x", null, null, ""), true);
  assert.equal(trackingPixel("https://e.customeriomail.com/e/o/abc", null, null, ""), true);
  assert.equal(trackingPixel("https://news.example/pixel.gif?id=9", null, null, ""), true);
  // An image like any other stays one: its size, one thin side (a line, a spacer), a path that only looks alike.
  assert.equal(trackingPixel("https://img.shop.example/hero.png", "600", "170", ""), false);
  assert.equal(trackingPixel("https://img.shop.example/icon.png", "20", "20", "width:20px"), false);
  assert.equal(trackingPixel("https://img.shop.example/line.gif", "600", "1", ""), false);
  assert.equal(trackingPixel("https://img.shop.example/spacer.gif", "1", "24", ""), false);
  assert.equal(trackingPixel("https://img.shop.example/logo.png", null, null, "max-width:1px"), false);
  assert.equal(trackingPixel("https://img.shop.example/opening-hours.png", null, null, ""), false);
  assert.equal(trackingPixel("https://cdn.example/pixel/hero-600.jpg", "600", null, ""), false);
  assert.equal(trackingPixel("https://cdn.example/img/beacon.jpg", null, null, ""), false);
  assert.equal(trackingPixel("not a url", "300", "100", ""), false);
  // Hidden by its style only: a phone picture the email's own CSS shows.
  assert.equal(trackingPixel("https://cdn.example/hero-mobile.jpg", null, null, "display:none;width:0;max-height:0;overflow:hidden;mso-hide:all"), false);
  assert.equal(trackingPixel("https://cdn.example/hero.jpg", "320", "180", "visibility:hidden"), false);
  // Lumo's own marks are never taken from the email.
  assert.equal(droppedAttribute("data-lumo-src", "https://t.example/o.gif"), true);
  assert.equal(droppedAttribute("data-lumo-tracker", ""), true);
});

test("an image given only by srcset still has an address to load", () => {
  assert.equal(imageSource(" https://a.example/x.png ", "https://a.example/x@2x.png 2x"), "https://a.example/x.png", "its src first");
  assert.equal(imageSource("", "https://a.example/s.jpg 480w, https://a.example/l.jpg 1080w"), "https://a.example/s.jpg");
  assert.equal(imageSource("", "https://a.example/a.jpg, https://a.example/b.jpg 2x"), "https://a.example/a.jpg");
  assert.equal(imageSource("", "  "), "");
  assert.equal(imageSource("", ""), "");
});

test("the email's frame runs nothing and fetches nothing, whatever the island's CSP lets in", () => {
  // Same origin without scripts: with allow-scripts too, the email would be the island (its IPC).
  assert.equal(EMAIL_FRAME_SANDBOX, "allow-same-origin");
  const view = readFileSync(new URL("../src/views/mail-view.ts", import.meta.url), "utf8");
  assert.ok(!view.includes("allow-scripts"), "the Email view never allows scripts");
  assert.ok(view.includes("sandbox: EMAIL_FRAME_SANDBOX"), "the frame takes EMAIL_FRAME_SANDBOX");
  assert.ok(view.includes("EMAIL_FRAME_CSP"), "the frame's document carries its own CSP");
  // Its own CSP: nothing from anywhere but what Lumo hands over (data:, blob:).
  assert.match(EMAIL_FRAME_CSP, /default-src 'none'/);
  assert.match(EMAIL_FRAME_CSP, /img-src data: blob:(;|$)/);
  assert.doesNotMatch(EMAIL_FRAME_CSP, /https?:|'self'|\*|script-src/);
});

test("Load images asks an http image, or a //site one, on https; nothing else", () => {
  assert.equal(httpsImage("https://img.example/a.png"), "https://img.example/a.png");
  assert.equal(httpsImage(" http://img.example/a.png "), "https://img.example/a.png");
  assert.equal(httpsImage("HTTP://img.example/a.png"), "https://img.example/a.png");
  assert.equal(httpsImage("//cdn.example/a.png"), "https://cdn.example/a.png");
  assert.equal(httpsImage("//"), null);
  assert.equal(httpsImage("cid:logo"), null);
  assert.equal(httpsImage("/img/a.png"), null);
  assert.equal(httpsImage("ftp://img.example/a.png"), null);
  assert.equal(isDataUrl("DATA:image/png;base64,AA"), true);
  assert.equal(isDataUrl(" data:image/gif;base64,AA"), true);
  assert.equal(isDataUrl("https://data.example/a.png"), false);
  // A tracking pixel given as //site is known as one too.
  assert.equal(trackingPixel("//us5.list-manage.com/track/open.php?u=1", null, null, ""), true);
});

test("an email's background waits for Load images: its attribute, or the url() of its style", () => {
  assert.equal(backgroundUrl("https://img.example/hero.png", ""), "https://img.example/hero.png");
  assert.equal(backgroundUrl("http://img.example/hero.png", ""), "https://img.example/hero.png");
  assert.equal(backgroundUrl(null, "background-image:url('https://img.example/a.png');background-size:cover"), "https://img.example/a.png");
  assert.equal(backgroundUrl(null, "color:#fff; background: #123 url(\"http://img.example/b.jpg\") no-repeat"), "https://img.example/b.jpg");
  assert.equal(backgroundUrl(null, "background:url(//cdn.example/c.png)"), "https://cdn.example/c.png");
  assert.equal(backgroundUrl(null, "background-color:#fff"), null);
  assert.equal(backgroundUrl(null, "background-image:url(data:image/png;base64,AA)"), null);
  assert.equal(backgroundUrl(null, "border-image:url(https://img.example/x.png)"), null);
  assert.equal(backgroundUrl("data:image/png;base64,AA", ""), null);
  assert.equal(backgroundUrl("", ""), null);
});

test("a click opens the address the corner shows; a mailto: only its address; #place stays in the email", () => {
  assert.equal(browserUrl("https://shop.example/a b"), "https://shop.example/a%20b");
  assert.equal(browserUrl(" https://shop.example/\ttrack "), "https://shop.example/track");
  assert.equal(browserUrl("https://evil.example\\@paypal.com/"), "https://evil.example/@paypal.com/");
  assert.equal(linkParts("https://evil.example\\@paypal.com/").host, "evil.example");
  assert.equal(browserUrl("https://shop.example/x\" & calc"), "https://shop.example/x%22%20&%20calc");
  assert.equal(browserUrl("javascript:alert(1)"), null);
  assert.equal(browserUrl("https://"), null);
  assert.equal(mailtoUrl("mailto:ada@example.com"), "mailto:ada@example.com");
  assert.equal(mailtoUrl("MAILTO:ada%40example.com?subject=Ciao&attach=C:\\secret.txt"), "mailto:ada@example.com");
  assert.equal(mailtoUrl("mailto:ada@example.com,bob@example.com"), null);
  assert.equal(mailtoUrl("mailto:"), null);
  assert.equal(mailtoUrl("mailto:%E0%A4%A"), null);
  assert.equal(mailtoUrl("https://example.com"), null);
  assert.equal(anchorOf("#offerte"), "offerte");
  assert.equal(anchorOf("#sezione%201"), "sezione 1");
  assert.equal(anchorOf("#"), null);
  assert.equal(anchorOf("https://shop.example/#a"), null);
});

test("past the images Load images asks for, how many are left out is said", () => {
  assert.equal(imagesLeftOut(["https://a/1.png", "https://a/1.png", "http://a/2.png"]), 0);
  const many = Array.from({ length: MAX_EMAIL_IMAGES + 7 }, (_, i) => `https://a/${i}.png`);
  assert.equal(imagesLeftOut([...many, many[0]]), 7);
});
