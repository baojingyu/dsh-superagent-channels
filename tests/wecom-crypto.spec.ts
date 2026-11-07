/** The WeCom callback's signature and AES payload: sorted SHA-1 verification, and encryption that the decrypt reverses. */
import { createHash } from 'node:crypto'
import { expect, it } from 'vitest'
import { decrypt, encrypt, signatureOf, verifySignature } from '../src/sources/chat/wecom/crypto.ts'

// A 43-character EncodingAESKey decodes to the 32-byte AES key (44 Base64 characters, the last one the padding `=`).
const KEY = 'abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG'
const CORP = 'ww1234567890abcdef'
const TOKEN = 'QDG6eK'
const TIMESTAMP = '1409659589'
const NONCE = '1234567890'

it('verifies the sorted SHA-1 signature WeCom signs, and refuses any other', () => {
  const echostr = 'abcdefg'
  const expected = createHash('sha1').update([TOKEN, TIMESTAMP, NONCE, echostr].sort().join('')).digest('hex')
  expect(signatureOf(TOKEN, TIMESTAMP, NONCE, echostr)).toBe(expected)
  expect(verifySignature(TOKEN, TIMESTAMP, NONCE, expected, echostr)).toBe(true)
  expect(verifySignature(TOKEN, TIMESTAMP, NONCE, expected, 'another')).toBe(false)
  expect(verifySignature(TOKEN, TIMESTAMP, NONCE, 'x'.repeat(40), echostr)).toBe(false)
  // A message callback signs token, timestamp, nonce and its encrypted body, with no echostr.
  expect(signatureOf(TOKEN, TIMESTAMP, NONCE)).toBe(createHash('sha1').update([TOKEN, TIMESTAMP, NONCE].sort().join('')).digest('hex'))
})

it('rejects an EncodingAESKey that is not 43 characters or not 32 bytes, and never names the key', () => {
  for (const bad of ['short', 'a'.repeat(42), 'a'.repeat(44), '!'.repeat(43)]) {
    let thrown: Error | undefined
    try { encrypt('x', bad, CORP) } catch (error) { thrown = error as Error }
    expect(thrown).toBeInstanceOf(Error)
    expect(thrown!.message).toMatch(/EncodingAESKey/)
    expect(thrown!.message).not.toContain(bad)
    expect(() => decrypt('AAAA', bad, CORP)).toThrow(/EncodingAESKey/)
  }
})

it('decrypts what it encrypted, including Chinese text, an empty body and a body longer than one block', () => {
  for (const message of ['hello', '中文消息：你好，世界！😀', '', 'x'.repeat(5000)]) {
    const encrypted = encrypt(message, KEY, CORP)
    expect(encrypted).not.toBe(message)
    expect(decrypt(encrypted, KEY, CORP)).toBe(message)
  }
})

it('refuses a payload for another corporation, an empty payload and a tampered one', () => {
  const encrypted = encrypt('hello', KEY, CORP)
  expect(() => decrypt(encrypted, KEY, 'wwothercorp')).toThrow('another corporation')
  expect(() => decrypt('', KEY, CORP)).toThrow('empty')
  const bytes = Buffer.from(encrypted, 'base64')
  bytes[bytes.length - 1] = (bytes[bytes.length - 1] ?? 0) ^ 0xff
  expect(() => decrypt(bytes.toString('base64'), KEY, CORP)).toThrow()
})
