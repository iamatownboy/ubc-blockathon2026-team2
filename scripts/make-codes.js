#!/usr/bin/env node
// Participation codes for a real programme.
//
// The demo ships WELCOME-01…12 because a presenter has to type one on stage.
// Those are guessable, and guessable is fine for a laptop and nowhere else.
//
// This prints codes a partner desk can hand out: 8 characters from a 32-letter
// alphabet with the ambiguous ones removed (no O/0, no I/1), grouped for
// reading aloud. That is 40 bits — with the server's eight-tries-per-window
// limit, guessing one is not a strategy.
//
//   node scripts/make-codes.js 200            → 200 codes, one per line
//   node scripts/make-codes.js 200 > codes.txt
//   ENROLLMENT_CODES=$(paste -sd, codes.txt) node server/server.js
//
// Print them, hand them out one per person, and keep the list off the server.
"use strict";

const crypto = require("crypto");

const ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ"; // 32 chars, no O/0/I/1
const GROUPS = 2;
const PER_GROUP = 4;

function code() {
  const need = GROUPS * PER_GROUP;
  const out = [];
  // Rejection-free: 256 is a multiple of 32, so every byte maps uniformly.
  for (const byte of crypto.randomBytes(need)) out.push(ALPHABET[byte % ALPHABET.length]);
  return Array.from({ length: GROUPS }, (_, g) => out.slice(g * PER_GROUP, (g + 1) * PER_GROUP).join("")).join("-");
}

function main(argv) {
  const count = Number(argv[0] ?? 100);
  if (!Number.isInteger(count) || count < 1 || count > 100000) {
    console.error("usage: node scripts/make-codes.js <count 1..100000>");
    process.exit(1);
  }
  const seen = new Set();
  while (seen.size < count) seen.add(code());
  for (const c of seen) console.log(c);
}

if (require.main === module) main(process.argv.slice(2));

module.exports = { code, ALPHABET };
