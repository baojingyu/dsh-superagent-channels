/**
 * WeCom callback security: the SHA-1 signature WeCom sends with every callback, and the AES-256-CBC payload it encrypts
 * with the app's 43-character EncodingAESKey. The plaintext is `random(16) || len(4, big endian) || message || corpId`,
 * padded to 32-byte blocks with PKCS#7; the IV is the first 16 bytes of the key. Errors name the field, never the key.
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual } from 'node:crypto'

/** WeCom pads the payload to a multiple of 32 bytes with PKCS#7 (its own block size, not AES's 16). */
const BLOCK = 32
const ALGORITHM = 'aes-256-cbc'
const KEY_CHARS = 43

/** Decodes the 43-character EncodingAESKey into its 32-byte AES key; the error names the field, never the key. */
function decodeKey(encodingAesKey: string): Buffer {
  if (typeof encodingAesKey !== 'string' || encodingAesKey.length !== KEY_CHARS) {
    throw new Error(`The WeCom EncodingAESKey must be ${KEY_CHARS} characters`)
  }
  const key = Buffer.from(`${encodingAesKey}=`, 'base64')
  if (key.length !== 32) throw new Error('The WeCom EncodingAESKey does not decode to 32 bytes')
  return key
}

/** Hex SHA-1 of the token, timestamp, nonce and optional encrypted payload, sorted as WeCom sorts them before hashing. */
export function signatureOf(token: string, timestamp: string, nonce: string, encrypted?: string): string {
  const parts = [token, timestamp, nonce, ...(encrypted === undefined ? [] : [encrypted])].sort()
  return createHash('sha1').update(parts.join(''), 'utf8').digest('hex')
}

/** Whether `expected` is the signature of this callback's token, timestamp, nonce and (for a message) encrypted body. */
export function verifySignature(token: string, timestamp: string, nonce: string, expected: string, encrypted?: string): boolean {
  const actual = signatureOf(token, timestamp, nonce, encrypted)
  const left = Buffer.from(actual, 'utf8')
  const right = Buffer.from(expected, 'utf8')
  return left.length === right.length && timingSafeEqual(left, right)
}

/** Strips WeCom's 32-byte-block PKCS#7 padding, rejecting a padding byte that runs past the start or does not repeat. */
function unpad(buffer: Buffer): Buffer {
  const last = buffer[buffer.length - 1]
  if (last === undefined || last < 1 || last > BLOCK || last > buffer.length) throw new Error('The WeCom payload has invalid padding')
  for (let index = buffer.length - last; index < buffer.length; index++) {
    if (buffer[index] !== last) throw new Error('The WeCom payload has invalid padding')
  }
  return buffer.subarray(0, buffer.length - last)
}

/** Appends WeCom's 32-byte-block PKCS#7 padding (always 1..32 bytes). */
function pad(buffer: Buffer): Buffer {
  const fill = BLOCK - (buffer.length % BLOCK)
  return Buffer.concat([buffer, Buffer.alloc(fill, fill)])
}

/** Encrypts `message` for `corpId` into the Base64 payload a WeCom callback carries. */
export function encrypt(message: string, encodingAesKey: string, corpId: string): string {
  const key = decodeKey(encodingAesKey)
  const body = Buffer.from(message, 'utf8')
  const length = Buffer.alloc(4)
  length.writeUInt32BE(body.length, 0)
  const plain = Buffer.concat([randomBytes(16), length, body, Buffer.from(corpId, 'utf8')])
  const cipher = createCipheriv(ALGORITHM, key, key.subarray(0, 16))
  cipher.setAutoPadding(false)
  return Buffer.concat([cipher.update(pad(plain)), cipher.final()]).toString('base64')
}

/** Decrypts a Base64 WeCom payload, checking its padding, its declared length and that it belongs to `corpId`. */
export function decrypt(encrypted: string, encodingAesKey: string, corpId: string): string {
  const key = decodeKey(encodingAesKey)
  if (!encrypted) throw new Error('The WeCom payload is empty')
  let padded: Buffer
  try {
    const decipher = createDecipheriv(ALGORITHM, key, key.subarray(0, 16))
    decipher.setAutoPadding(false)
    padded = Buffer.concat([decipher.update(Buffer.from(encrypted, 'base64')), decipher.final()])
  } catch { throw new Error('The WeCom payload could not be decrypted') }
  const plain = unpad(padded)
  if (plain.length < 20) throw new Error('The WeCom payload is too short')
  const length = plain.readUInt32BE(16)
  if (20 + length > plain.length) throw new Error('The WeCom payload length is invalid')
  const message = plain.subarray(20, 20 + length).toString('utf8')
  const received = plain.subarray(20 + length).toString('utf8')
  if (received !== corpId) throw new Error('The WeCom payload belongs to another corporation')
  return message
}
