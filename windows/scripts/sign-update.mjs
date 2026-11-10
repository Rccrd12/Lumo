// Signs installers for Lumo's updater: `<file>.sig` beside each file, the
// hex ed25519 signature of its bytes. Run by the release and beta workflows
// right before they publish, with the private key in LUMO_UPDATE_KEY (from
// scripts/update-key.mjs):
//
//   node scripts/sign-update.mjs <installer>…
//
// Each signature is checked against the public key in src-tauri/src/updater.rs
// (UPDATE_PUBLIC_KEY) before anything is published: a secret that does not
// match the key Lumo carries stops the job, since every Lumo would refuse the
// installer. Settings → Updates → Update now installs nothing without a
// signature that holds (updater.rs).

import { createPrivateKey, createPublicKey, sign, verify } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** The SPKI prefix of a raw ed25519 public key (RFC 8410). */
const SPKI_ED25519 = Buffer.from("302a300506032b6570032100", "hex");

/** The hex signature of `bytes` with the base64 PKCS#8 private key `key`. */
export function signBytes(bytes, key) {
  const privateKey = createPrivateKey({ key: Buffer.from(key.trim(), "base64"), format: "der", type: "pkcs8" });
  return sign(null, bytes, privateKey).toString("hex");
}

/** True when `signature` (hex) is `bytes` signed by the raw public key `publicHex`. */
export function verifyBytes(bytes, signature, publicHex) {
  if (!/^[0-9a-f]{64}$/i.test(publicHex) || !/^[0-9a-f]{128}$/i.test(signature.trim())) return false;
  const publicKey = createPublicKey({ key: Buffer.concat([SPKI_ED25519, Buffer.from(publicHex, "hex")]), format: "der", type: "spki" });
  return verify(null, bytes, publicKey, Buffer.from(signature.trim(), "hex"));
}

/** The public key Lumo carries, from updater.rs. */
export function carriedPublicKey(source) {
  return /const UPDATE_PUBLIC_KEY: &str = "([0-9a-fA-F]{64})";/.exec(source)?.[1] ?? null;
}

function main(files) {
  const key = process.env.LUMO_UPDATE_KEY;
  if (!key) {
    console.error("LUMO_UPDATE_KEY is not set: the installers are not signed, and Lumo would refuse them.");
    process.exit(1);
  }
  const publicHex = carriedPublicKey(readFileSync(join(root, "src-tauri", "src", "updater.rs"), "utf8"));
  if (!publicHex) {
    console.error("src-tauri/src/updater.rs has no UPDATE_PUBLIC_KEY.");
    process.exit(1);
  }
  if (!files.length) {
    console.error("usage: node scripts/sign-update.mjs <installer>…");
    process.exit(1);
  }
  for (const file of files) {
    const bytes = readFileSync(file);
    const signature = signBytes(bytes, key);
    if (!verifyBytes(bytes, signature, publicHex)) {
      console.error("LUMO_UPDATE_KEY is not the key whose public half is in updater.rs: nothing signed.");
      process.exit(1);
    }
    writeFileSync(`${file}.sig`, `${signature}\n`);
    console.log(`signed ${file}`);
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) main(process.argv.slice(2));
