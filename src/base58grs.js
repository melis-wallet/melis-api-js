const base58 = require('bs58')
const ghash = require('groestl-hash-js')

function groestlx2(buffer) {
  return ghash.groestl_2([...buffer], 1, 1)
}

const bs58checkBase = function (checksumFn) {

  // Encode a buffer as a base58-check encoded string
  function encode(payload) {
    var checksum = Buffer.from(checksumFn(payload))
    return base58.encode(Buffer.concat([
      payload,
      checksum
    ], payload.length + 4))
  }

  function decodeRaw(buffer) {
    const payload = buffer.slice(0, -4)
    const checksum = buffer.slice(-4)
    const newChecksum = checksumFn(payload)

    if (
      checksum[0] ^ newChecksum[0] |
      checksum[1] ^ newChecksum[1] |
      checksum[2] ^ newChecksum[2] |
      checksum[3] ^ newChecksum[3]
    )
      return

    return payload
  }

  // Decode a base58-check encoded string to a buffer, no result if checksum is wrong
  function decodeUnsafe(string) {
    var buffer = base58.decodeUnsafe(string)
    if (!buffer) return

    return decodeRaw(buffer)
  }

  function decode(string) {
    const buffer = base58.decode(string)
    const payload = decodeRaw(buffer, checksumFn)
    if (!payload)
      throw new Error('Invalid checksum in base58 GRS encoding')
    return payload
  }

  return {
    encode: encode,
    decode: decode,
    decodeUnsafe: decodeUnsafe
  }
}

module.exports = bs58checkBase(groestlx2)
