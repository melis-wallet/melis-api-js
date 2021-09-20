//var bufferEquals = require('buffer-equals')
const bs58check = require('bs58check')
const createHash = require('create-hash')
const secp256k1 = require('secp256k1')  // V4 changed api https://github.com/cryptocoinjs/secp256k1-node/blob/master/API.md
const varuint = require('varuint-bitcoin')

function sha256(b) {
  return createHash('sha256').update(b).digest()
}
function hash256(buffer) {
  return sha256(sha256(buffer))
}
function hash160(buffer) {
  return createHash('ripemd160').update(sha256(buffer)).digest()
}

function encodeSignature(signature, recovery, compressed) {
  if (compressed) recovery += 4
  return Buffer.concat([Buffer.alloc(1, recovery + 27), signature])
}

function decodeSignature(buffer) {
  if (buffer.length !== 65) throw new Error('Invalid signature length')

  var flagByte = buffer.readUInt8(0) - 27
  if (flagByte > 7) throw new Error('Invalid signature parameter')

  return {
    compressed: !!(flagByte & 4),
    recovery: flagByte & 3,
    signature: buffer.slice(1)
  }
}

function magicHash(message, messagePrefix, useSingleHash) {
  messagePrefix = messagePrefix || '\u0018Bitcoin Signed Message:\n'
  if (!Buffer.isBuffer(messagePrefix)) messagePrefix = Buffer.from(messagePrefix, 'utf8')

  const messageVISize = varuint.encodingLength(message.length)
  const buffer = Buffer.allocUnsafe(messagePrefix.length + messageVISize + message.length)
  messagePrefix.copy(buffer, 0)
  varuint.encode(message.length, buffer, messagePrefix.length)
  buffer.write(message, messagePrefix.length + messageVISize)
  if (useSingleHash)
    return sha256(buffer)
  else
    return hash256(buffer)
}

function sign(message, privateKey, compressed, messagePrefix, useSingleHash) {
  const hash = magicHash(message, messagePrefix, useSingleHash)
  const sigObj = secp256k1.sign(hash, privateKey)
  return encodeSignature(sigObj.signature, sigObj.recovery, compressed)
}

function verify(message, expectedAddressHash, signature, messagePrefix, useSingleHash) {
  if (!Buffer.isBuffer(signature)) signature = Buffer.from(signature, 'base64')

  const parsed = decodeSignature(signature)
  const hash = magicHash(message, messagePrefix, useSingleHash)
  const publicKey = secp256k1.recover(hash, parsed.signature, parsed.recovery, parsed.compressed)
  const actual = hash160(publicKey)
  //var expected = bs58check.decode(address).slice(1)
  //return bufferEquals(actual, expectedAddressHash)
  return expectedAddressHash.equals(actual)
}

module.exports = {
  magicHash: magicHash,
  sign: sign,
  verify: verify
}
