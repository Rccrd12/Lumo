// Makes the key pair that signs Lumo's updates, once (or to replace a lost one):
//
//   node scripts/update-key.mjs
//
// It writes nothing anywhere and prints two lines:
//   - PUBLIC: goes in src-tauri/src/updater.rs (UPDATE_PUBLIC_KEY), in git.
//     Anyone may see it; Lumo checks every installer it downloads against it.
//   - PRIVATE: goes in the repository's Actions secret LUMO_UPDATE_KEY
//     (Settings → Secrets and variables → Actions) and in a password manager,
//     nowhere else. The release and beta workflows sign the installers with it
//     (scripts/sign-update.mjs).
//
// A new key pair only works for the Lumo builds that carry its public key: the
// ones already installed refuse installers signed with another key, so their
// users install the next version by hand once.

import { generateKeyPairSync } from "node:crypto";

const { publicKey, privateKey } = generateKeyPairSync("ed25519");
// The raw 32-byte key ends the SPKI encoding.
const pub = publicKey.export({ format: "der", type: "spki" }).subarray(-32).toString("hex");
const priv = privateKey.export({ format: "der", type: "pkcs8" }).toString("base64");
console.log(`PUBLIC  ${pub}`);
console.log(`PRIVATE ${priv}`);
