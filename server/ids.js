// bytes32 helpers shared by the ledger, the catalog, missions and the
// swap service. sha256 is used instead of keccak so the server needs no
// dependency; on chain these are opaque 32-byte identifiers either way.
"use strict";

const crypto = require("crypto");

/** Deterministic bytes32 for a label, e.g. "mission:library-conversation-group". */
function bytes32(label) {
  return "0x" + crypto.createHash("sha256").update(String(label)).digest("hex");
}

/** bytes32 of several parts, joined so the boundaries are unambiguous. */
function hashParts(...parts) {
  const h = crypto.createHash("sha256");
  for (const part of parts) {
    const buf = Buffer.from(String(part));
    h.update(Buffer.from(String(buf.length) + ":"));
    h.update(buf);
  }
  return "0x" + h.digest("hex");
}

/** A random learner handle: 32 bytes from the CSPRNG. Never derived from anything. */
function randomHandle() {
  return "0x" + crypto.randomBytes(32).toString("hex");
}

function randomToken(bytes = 24) {
  return crypto.randomBytes(bytes).toString("base64url");
}

/** Pack a short ASCII string (≤ 32 chars) into a bytes32, right-padded with zeros. */
function asciiBytes32(text) {
  const str = String(text);
  if (str.length > 32 || !/^[\x20-\x7e]*$/.test(str)) throw new Error(`"${str}" does not fit a bytes32 (≤ 32 printable ASCII chars)`);
  const buf = Buffer.alloc(32);
  Buffer.from(str, "ascii").copy(buf);
  return "0x" + buf.toString("hex");
}

/** Pad an ASCII reason into a bytes32 so it can go into an event. */
function reasonBytes32(reason) {
  const buf = Buffer.alloc(32);
  Buffer.from(String(reason).slice(0, 32), "ascii").copy(buf);
  return "0x" + buf.toString("hex");
}

function reasonFromBytes32(hex) {
  return Buffer.from(String(hex).replace(/^0x/, ""), "hex").toString("ascii").replace(/\0+$/, "");
}

const isBytes32 = (v) => typeof v === "string" && /^0x[0-9a-fA-F]{64}$/.test(v);

module.exports = { bytes32, hashParts, randomHandle, randomToken, asciiBytes32, reasonBytes32, reasonFromBytes32, isBytes32 };
