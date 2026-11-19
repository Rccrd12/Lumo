// A chat's name (src/core/chats.ts): the one its AI gave it (chat_title.rs)
// or the user, kept whatever its turns say; else the start of its first question.

import { test } from "node:test";
import assert from "node:assert/strict";

const mem = new Map();
globalThis.localStorage = {
  getItem: (k) => (mem.has(k) ? mem.get(k) : null),
  setItem: (k, v) => mem.set(k, String(v)),
  removeItem: (k) => mem.delete(k),
};

// A chat named in an earlier session, as Past chats kept it: read before the module first looks.
mem.set("lumo.chats.v1", JSON.stringify([
  { id: "old", title: "Viaggio a Lisbona", named: "user", updatedAt: 1, provider: "anthropic", session: null, turns: [{ role: "user", content: "ciao" }] },
  { id: "plain", title: "ciao", updatedAt: 1, provider: "anthropic", session: null, turns: [{ role: "user", content: "ciao" }] },
]));

const { NAME_CHARS, chatName, chatNamedBy, deleteChat, loadChats, nameChat, namingExchanges, saveChat } = await import("../src/core/chats.ts");

const turns = (...pairs) => pairs.flatMap(([q, a]) => [{ role: "user", content: q }, ...(a == null ? [] : [{ role: "assistant", content: a }])]);
const chat = (id, t) => ({ id, title: "", updatedAt: 1, provider: "anthropic", session: null, turns: t });

test("a name given in an earlier session is read back; a chat never named shows its first question", () => {
  assert.equal(chatName("old", turns(["ciao"])), "Viaggio a Lisbona");
  assert.equal(chatNamedBy("old"), "user");
  assert.equal(chatName("plain", turns(["ciao"])), "ciao");
  assert.equal(chatNamedBy("plain"), null);
});

test("the AI's name stays when the chat is saved again with more turns", () => {
  const t = turns(["mi aiuti a capire perché la build fallisce con link.exe?", "Certo."]);
  saveChat({ ...chat("build", t), title: "mi aiuti a capire perché la build fallisce con link.exe?" });
  assert.ok(nameChat("build", "Build che fallisce con link.exe", "ai"));
  // Saved where it is, at once.
  assert.equal(loadChats().find((c) => c.id === "build").title, "Build che fallisce con link.exe");
  assert.equal(loadChats().find((c) => c.id === "build").named, "ai");
  // The next answer saves the chat with the start of its first question: the name stays.
  saveChat({ ...chat("build", [...t, ...turns(["e ora?", "Prova così."])]), title: "mi aiuti a capire…" });
  const saved = loadChats().find((c) => c.id === "build");
  assert.equal(saved.title, "Build che fallisce con link.exe");
  assert.equal(saved.named, "ai");
  assert.equal(chatName("build", []), "Build che fallisce con link.exe");
});

test("a chat named while it is still answered keeps the name once it is saved", () => {
  assert.ok(nameChat("unsaved", "Carbonara per 4 persone", "ai"));
  saveChat({ ...chat("unsaved", turns(["ricetta carbonara per 4", "Ecco."])), title: "ricetta carbonara per 4" });
  assert.equal(loadChats().find((c) => c.id === "unsaved").title, "Carbonara per 4 persone");
});

test("the user's name wins and is never taken back by the AI's", () => {
  saveChat({ ...chat("mail", turns(["scrivi una mail a Giulia", "Ecco la mail."])), title: "scrivi una mail a Giulia" });
  nameChat("mail", "Mail a Giulia", "ai");
  assert.ok(nameChat("mail", "  Riunione   con Giulia\n(giovedì) ", "user"));
  assert.equal(chatName("mail", []), "Riunione con Giulia (giovedì)");
  assert.equal(chatNamedBy("mail"), "user");
  // An empty name changes nothing.
  assert.equal(nameChat("mail", "   ", "user"), false);
  assert.equal(chatName("mail", []), "Riunione con Giulia (giovedì)");
});

test("a name is cut at NAME_CHARS characters, never in the middle of an emoji", () => {
  nameChat("long", `${"a".repeat(NAME_CHARS - 1)}🍝🍝`, "user");
  const name = chatName("long", []);
  assert.equal([...name].length, NAME_CHARS);
  assert.ok(name.endsWith("🍝"));
});

test("a deleted chat's name goes with it", () => {
  saveChat({ ...chat("gone", turns(["domanda di prova lunga", "Risposta."])), title: "domanda di prova lunga" });
  nameChat("gone", "Prova", "ai");
  deleteChat("gone");
  assert.equal(chatNamedBy("gone"), null);
  assert.equal(chatName("gone", turns(["domanda di prova lunga"])), "domanda di prova lunga");
});

test("the name is asked from the first two exchanges, once there is enough to go on", () => {
  // No answer yet.
  assert.equal(namingExchanges(turns(["come configuro la build di Lumo?"])), null);
  // One answer to a real question: enough.
  assert.deepEqual(namingExchanges(turns(["come configuro la build di Lumo?", "Così."])), [["come configuro la build di Lumo?", "Così."]]);
  // "ciao": too little, the name waits for the second answer.
  assert.equal(namingExchanges(turns(["ciao", "Ciao! Come posso aiutarti?"])), null);
  assert.deepEqual(namingExchanges(turns(["ciao", "Ciao!"], ["idee per il compleanno di Marta", "Eccone tre."])), [["ciao", "Ciao!"], ["idee per il compleanno di Marta", "Eccone tre."]]);
  // Two at most.
  assert.equal(namingExchanges(turns(["uno due tre", "a"], ["quattro", "b"], ["cinque", "c"])).length, 2);
  // Commands, failed and empty answers are left out.
  const failed = [{ role: "user", content: "perché la build fallisce?" }, { role: "assistant", content: "Network error", failed: true }];
  assert.equal(namingExchanges(failed), null);
  assert.deepEqual(namingExchanges([...turns(["/compact", "Compacted."]), ...turns(["riassumi la fattura di marzo", "Ecco."])]), [["riassumi la fattura di marzo", "Ecco."]]);
  assert.equal(namingExchanges(turns(["riassumi la fattura di marzo", "  "])), null);
});
