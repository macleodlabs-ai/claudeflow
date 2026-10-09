// Types for the bundled @noble crypto (curves, ciphers, hashes 2.4.0): the functions the plugin uses.
type Bytes = Uint8Array
export declare const x25519: { utils: { randomSecretKey(): Bytes }; getPublicKey(sk: Bytes): Bytes; getSharedSecret(sk: Bytes, pk: Bytes): Bytes }
export declare const p256: { verify(sig: Bytes, msg: Bytes, pk: Bytes, opts?: { prehash?: boolean; format?: 'compact' | 'der'; lowS?: boolean }): boolean; sign(msg: Bytes, sk: Bytes, opts?: { prehash?: boolean; format?: 'compact' | 'der'; lowS?: boolean }): Bytes; getPublicKey(sk: Bytes, compressed?: boolean): Bytes; utils: { randomSecretKey(): Bytes }; Signature: P256Signature }
type P256Sig = { r: bigint; s: bigint; toBytes(format?: 'compact' | 'der'): Bytes }
type P256Signature = { new (r: bigint, s: bigint): P256Sig; fromBytes(b: Bytes, format?: 'compact' | 'der'): P256Sig }
export declare function xchacha20poly1305(key: Bytes, nonce: Bytes, aad?: Bytes): { encrypt(pt: Bytes): Bytes; decrypt(ct: Bytes): Bytes }
export declare function hkdf(hash: unknown, ikm: Bytes, salt: Bytes | undefined, info: Bytes | undefined, length: number): Bytes
export declare function hmac(hash: unknown, key: Bytes, msg: Bytes): Bytes
export declare const sha256: ((msg: Bytes) => Bytes) & { outputLen: number }
export declare function randomBytes(n?: number): Bytes
