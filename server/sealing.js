// Sealing a card to the learner's device key.
//
//   ECDH (P-256) against the learner's public key
//   → HKDF-SHA256 (random salt, fixed info)
//   → AES-256-GCM
//
// The learner's app generated its keypair in the browser with
// extractable: false and keeps it in IndexedDB. What lands in the store is a
// blob this service cannot open: full compromise of the backend yields
// ciphertext and last-four digits. There is no escrow, on purpose.
//
// The browser side (public/learner/crypto.js) mirrors this exactly with
// WebCrypto. `open` below is the Node mirror of that browser code, used by
// the tests to prove the learner's key opens a card and a stranger's does not.
"use strict";

const crypto = require("crypto");

const CURVE = "prime256v1"; // P-256 in WebCrypto
const INFO = Buffer.from("languagetoken/card-seal/v1");
const ALG = "ECDH-P256+HKDF-SHA256+A256GCM";

/** Generate a learner-style keypair. Tests use this to play the browser. */
function generateLearnerKeypair() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ec", { namedCurve: CURVE });
  return { publicJwk: publicKey.export({ format: "jwk" }), privateKey, publicKey };
}

function assertP256Jwk(jwk) {
  if (!jwk || jwk.kty !== "EC" || jwk.crv !== "P-256" || !jwk.x || !jwk.y) {
    throw new Error("learner public key must be a P-256 EC JWK");
  }
}

function deriveKey(secret, salt) {
  return Buffer.from(crypto.hkdfSync("sha256", secret, salt, INFO, 32));
}

/**
 * Seal a plaintext object to a learner's public key (JWK).
 * Returns a blob with no key material the server could use to reopen it.
 */
function seal(plaintext, learnerPublicJwk) {
  assertP256Jwk(learnerPublicJwk);
  const learnerPublic = crypto.createPublicKey({ key: learnerPublicJwk, format: "jwk" });
  const ephemeral = crypto.generateKeyPairSync("ec", { namedCurve: CURVE });
  const secret = crypto.diffieHellman({ privateKey: ephemeral.privateKey, publicKey: learnerPublic });
  const salt = crypto.randomBytes(32);
  const key = deriveKey(secret, salt);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([cipher.update(Buffer.from(JSON.stringify(plaintext), "utf8")), cipher.final()]);
  const tag = cipher.getAuthTag();
  // the ephemeral private key goes out of scope here and is never written down
  return {
    v: 1,
    alg: ALG,
    epk: ephemeral.publicKey.export({ format: "jwk" }),
    salt: salt.toString("base64"),
    iv: iv.toString("base64"),
    ct: Buffer.concat([ct, tag]).toString("base64"), // ciphertext || tag, as WebCrypto expects
  };
}

/** Node mirror of the browser's decrypt. Throws if the key does not match. */
function open(blob, learnerPrivateKey) {
  if (!blob || blob.v !== 1 || blob.alg !== ALG) throw new Error("unsupported sealed blob");
  const epk = crypto.createPublicKey({ key: blob.epk, format: "jwk" });
  const secret = crypto.diffieHellman({ privateKey: learnerPrivateKey, publicKey: epk });
  const key = deriveKey(secret, Buffer.from(blob.salt, "base64"));
  const data = Buffer.from(blob.ct, "base64");
  const ct = data.subarray(0, data.length - 16);
  const tag = data.subarray(data.length - 16);
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(blob.iv, "base64"));
  decipher.setAuthTag(tag);
  const pt = Buffer.concat([decipher.update(ct), decipher.final()]);
  return JSON.parse(pt.toString("utf8"));
}

module.exports = { seal, open, generateLearnerKeypair, ALG };
