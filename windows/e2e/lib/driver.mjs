// A W3C WebDriver client in a few calls, on fetch: what the end-to-end tests
// need from msedgedriver and nothing more (no WebdriverIO, no dependency).

const ELEMENT = "element-6066-11e4-a52e-4f735466cecf";
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class Driver {
  constructor(url = "http://127.0.0.1:4444") {
    this.url = url;
    this.sid = null;
  }

  async call(method, path, body) {
    const res = await fetch(this.url + path, {
      method,
      headers: { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${JSON.stringify(json?.value?.message ?? json).slice(0, 300)}`);
    return json.value;
  }

  s(path) {
    return `/session/${this.sid}${path}`;
  }

  /** Attaches to the WebView2 of a Lumo built with --features e2e. */
  async attach(debuggerAddress = "127.0.0.1:9222") {
    const v = await this.call("POST", "/session", {
      capabilities: { alwaysMatch: { browserName: "webview2", "ms:edgeOptions": { debuggerAddress } } },
    });
    this.sid = v.sessionId;
  }

  async detach() {
    if (!this.sid) return;
    await this.call("DELETE", this.s("")).catch(() => {});
    this.sid = null;
  }

  /** Lumo's windows by the page they show: { island, settings, … }. */
  async windows() {
    const found = {};
    for (const handle of await this.call("GET", this.s("/window/handles"))) {
      await this.call("POST", this.s("/window"), { handle });
      const url = await this.js("return location.pathname");
      const name = url === "/" || url === "/index.html" ? "island" : url.replace(/^\//, "").replace(/\.html$/, "");
      found[name] = handle;
    }
    return found;
  }

  switchTo(handle) {
    return this.call("POST", this.s("/window"), { handle });
  }

  js(script, ...args) {
    return this.call("POST", this.s("/execute/sync"), { script, args });
  }

  async shot() {
    return Buffer.from(await this.call("GET", this.s("/screenshot")), "base64");
  }

  async all(css) {
    const found = await this.call("POST", this.s("/elements"), { using: "css selector", value: css });
    return found.map((e) => e[ELEMENT]);
  }

  async displayed(id) {
    return this.call("GET", this.s(`/element/${id}/displayed`)).catch(() => false);
  }

  /** The first displayed element for `css`, or null. */
  async find(css) {
    for (const id of await this.all(css)) if (await this.displayed(id)) return id;
    return null;
  }

  /** Waits for a displayed element; throws with `what` after `ms`. */
  async visible(css, ms = 10_000, what = css) {
    const end = Date.now() + ms;
    for (;;) {
      const id = await this.find(css);
      if (id) return id;
      if (Date.now() > end) throw new Error(`not on screen after ${ms} ms: ${what}`);
      await sleep(100);
    }
  }

  /** Waits until nothing for `css` is displayed. */
  async gone(css, ms = 10_000) {
    const end = Date.now() + ms;
    while (await this.find(css)) {
      if (Date.now() > end) throw new Error(`still on screen after ${ms} ms: ${css}`);
      await sleep(100);
    }
  }

  /** An element as an argument of js(). */
  ref(id) {
    return { [ELEMENT]: id };
  }

  click(id) {
    return this.call("POST", this.s(`/element/${id}/click`), {});
  }

  text(id) {
    return this.call("GET", this.s(`/element/${id}/text`));
  }

  rect(id) {
    return this.call("GET", this.s(`/element/${id}/rect`));
  }

  /** Waits until `fn` (run in the page) returns something truthy. */
  async until(script, ms = 10_000, what = script) {
    const end = Date.now() + ms;
    for (;;) {
      const v = await this.js(script);
      if (v) return v;
      if (Date.now() > end) throw new Error(`still false after ${ms} ms: ${what}`);
      await sleep(100);
    }
  }
}
