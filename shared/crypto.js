(function (global) {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();

  function bufferToBase64(buffer) {
    const bytes = buffer instanceof ArrayBuffer ? new Uint8Array(buffer) : buffer;
    let binary = "";
    const chunkSize = 0x8000;
    for (let i = 0; i < bytes.length; i += chunkSize) {
      const chunk = bytes.subarray(i, i + chunkSize);
      binary += String.fromCharCode.apply(null, chunk);
    }
    return btoa(binary);
  }

  function base64ToBuffer(base64) {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
  }

  async function hashPin(pin) {
    const hashed = await crypto.subtle.digest("SHA-256", encoder.encode(pin));
    return bufferToBase64(hashed);
  }

  async function importAesKeyFromBase64(keyBase64) {
    const rawKey = base64ToBuffer(keyBase64);
    return crypto.subtle.importKey("raw", rawKey, "AES-GCM", false, [
      "encrypt",
      "decrypt",
    ]);
  }

  async function encryptText(keyBase64, plaintext) {
    const key = await importAesKeyFromBase64(keyBase64);
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const cipherBuffer = await crypto.subtle.encrypt(
      { name: "AES-GCM", iv },
      key,
      encoder.encode(plaintext)
    );
    return {
      ciphertext: bufferToBase64(cipherBuffer),
      iv: bufferToBase64(iv),
    };
  }

  async function decryptText(keyBase64, cipherBase64, ivBase64) {
    const key = await importAesKeyFromBase64(keyBase64);
    const cipher = base64ToBuffer(cipherBase64);
    const iv = base64ToBuffer(ivBase64);
    const plainBuffer = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv },
      key,
      cipher
    );
    return decoder.decode(plainBuffer);
  }

  global.ChatLockCrypto = {
    encoder,
    decoder,
    bufferToBase64,
    base64ToBuffer,
    hashPin,
    encryptText,
    decryptText,
    importAesKeyFromBase64,
  };
})(globalThis);
