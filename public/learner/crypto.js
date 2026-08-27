// The learner's device key.
//
// A P-256 ECDH keypair is generated in the browser with extractable: false
// and kept in IndexedDB. It never leaves the device. Gift cards are sealed
// to its public half by the service and opened here — the server holds
// ciphertext it cannot read.
//
// Mirrors server/sealing.js exactly: ECDH → HKDF-SHA256 → AES-256-GCM.
// Clearing this site's data deletes the key, and with it every card.
(function () {
  const DB = "languagetoken";
  const STORE = "identity";
  const INFO = new TextEncoder().encode("languagetoken/card-seal/v1");

  function openDb() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(STORE);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  async function get(key) {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, "readonly");
      const req = tx.objectStore(STORE).get(key);
      req.onsuccess = () => resolve(req.result ?? null);
      req.onerror = () => reject(req.error);
    });
  }

  async function put(key, value) {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, "readwrite");
      tx.objectStore(STORE).put(value, key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  /** Load or create the device identity: { publicJwk, privateKey, token }. */
  async function ensureIdentity() {
    let id = await get("me");
    if (!id || !id.privateKey) {
      const pair = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, false, ["deriveBits"]);
      const publicJwk = await crypto.subtle.exportKey("jwk", pair.publicKey);
      id = { publicJwk: { kty: publicJwk.kty, crv: publicJwk.crv, x: publicJwk.x, y: publicJwk.y }, privateKey: pair.privateKey, token: null, createdAt: Date.now() };
      await put("me", id);
    }
    return id;
  }

  async function saveToken(token) {
    const id = await get("me");
    if (id) {
      id.token = token;
      await put("me", id);
    }
  }

  async function forgetIdentity() {
    const db = await openDb();
    await new Promise((resolve) => {
      const tx = db.transaction(STORE, "readwrite");
      tx.objectStore(STORE).clear();
      tx.oncomplete = resolve;
    });
  }

  const b64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

  /** Open a sealed card with this device's private key. Throws if it is not ours. */
  async function openSealed(blob, privateKey) {
    if (!blob || blob.v !== 1) throw new Error("unsupported sealed blob");
    const epk = await crypto.subtle.importKey("jwk", { kty: "EC", crv: "P-256", x: blob.epk.x, y: blob.epk.y }, { name: "ECDH", namedCurve: "P-256" }, false, []);
    const secret = await crypto.subtle.deriveBits({ name: "ECDH", public: epk }, privateKey, 256);
    const hkdfKey = await crypto.subtle.importKey("raw", secret, "HKDF", false, ["deriveKey"]);
    const aesKey = await crypto.subtle.deriveKey({ name: "HKDF", hash: "SHA-256", salt: b64(blob.salt), info: INFO }, hkdfKey, { name: "AES-GCM", length: 256 }, false, ["decrypt"]);
    const plaintext = await crypto.subtle.decrypt({ name: "AES-GCM", iv: b64(blob.iv) }, aesKey, b64(blob.ct));
    return JSON.parse(new TextDecoder().decode(plaintext));
  }

  window.LTCrypto = { ensureIdentity, saveToken, forgetIdentity, openSealed };
})();
