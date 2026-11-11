// Lumo's own update key (scripts/update-key.mjs, scripts/sign-update.mjs):
// what the workflows sign is what updater.rs checks.

import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { carriedPublicKey, signBytes, verifyBytes } from "../scripts/sign-update.mjs";

const pair = () => {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  return {
    pub: publicKey.export({ format: "der", type: "spki" }).subarray(-32).toString("hex"),
    priv: privateKey.export({ format: "der", type: "pkcs8" }).toString("base64"),
  };
};

test("a signature holds for its file and its key only", () => {
  const { pub, priv } = pair();
  const file = Buffer.from("MZ an installer");
  const sig = signBytes(file, priv);
  assert.match(sig, /^[0-9a-f]{128}$/);
  assert.ok(verifyBytes(file, `${sig}\n`, pub), "as the .sig file has it");
  assert.equal(verifyBytes(Buffer.from("MZ another one"), sig, pub), false);
  assert.equal(verifyBytes(file, sig, pair().pub), false, "another key");
  assert.equal(verifyBytes(file, "00", pub), false);
  assert.equal(verifyBytes(file, sig, "PUBLIC_KEY_PENDING"), false);
});

test("the public key is read from updater.rs as it is written there", () => {
  const key = "6e3bb7fd2d3e35b7c572f35da38704c50860350d4ff818f2fd5290d0d200d17b";
  assert.equal(carriedPublicKey(`const UPDATE_PUBLIC_KEY: &str = "${key}";`), key);
  assert.equal(carriedPublicKey('const UPDATE_PUBLIC_KEY: &str = "PUBLIC_KEY_PENDING";'), null);
});
