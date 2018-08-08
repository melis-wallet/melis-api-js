const Bitcoin = require('bitcoinjs-lib')
const bscript = Bitcoin.script
const bcrypto = Bitcoin.crypto
const opcodes = Bitcoin.opcodes

const ecurve = require('ecurve')
const curve = ecurve.getCurveByName('secp256k1')
//const BitcoinMessage = require('bitcoinjs-message')
const BitcoinMessage = require('./sign-message')
const cashaddr = require('cashaddrjs')
const base58grs = require('./base58grs')
const C = require("./cm-constants")
// import { MelisError, throwUnexpectedEx } from "./melis-error"
const MelisErrorModule = require("./melis-error")
const MelisError = MelisErrorModule.MelisError
const throwUnexpectedEx = MelisErrorModule.throwUnexpectedEx
const Logger = require("./logger")
const logger = new Logger()

const PREFIX_MAINNET = "bitcoincash"
const PREFIX_TESTNET = "bchtest"
const PREFIX_REGTEST = "bchreg"

const CASH_BECH32_REGEX = new RegExp("^(("
  + PREFIX_MAINNET + ")|(" + PREFIX_MAINNET.toUpperCase() + ")|("
  + PREFIX_TESTNET + ")|(" + PREFIX_TESTNET.toUpperCase() + ")|("
  + PREFIX_REGTEST + ")|(" + PREFIX_REGTEST.toUpperCase() + ")"
  + "):(([" + C.BECH32_CHARSET + "]{42})|([" + C.BECH32_CHARSET.toUpperCase() + "]{42}))$")

const CASH_BECH32_WITHOUT_PREFIX_LOWERCASE = new RegExp("^[" + C.BECH32_CHARSET + "]{42}$")
const CASH_BECH32_WITHOUT_PREFIX_UPPERCASE = new RegExp("^[" + C.BECH32_CHARSET.toUpperCase() + "]{42}$")

const SIGHASH_BITCOINCASHBIP143 = 0x40

const litecoinTestnet = {
  messagePrefix: '\x19Litecoin Signed Message:\n',
  bip32: {
    public: 0x043587CF, // 0x019da462,
    private: 0x04358394 // 0x019d9cfe
  },
  pubKeyHash: 0x6F, // 111
  scriptHash: 0x3A, // 58
  wif: 0xEF
}

const grsTestnet = Object.assign({}, litecoinTestnet, {
  messagePrefix: '\u001CGroestlcoin Signed Message:\n',
  pubKeyHash: 0x6F, // 111
  scriptHash: 0xc4 // 196
})
const grsProdnet = Object.assign({}, grsTestnet, {
  bip32: {
    public: 0x0488B21E,
    private: 0x0488ADE4
  },
  pubKeyHash: 0x24, // 36
  scriptHash: 0x5,
  wif: 0x80
})

const NETWORKS = Object.assign({ litecoinTestnet, grsTestnet, grsProdnet }, Bitcoin.networks)
const NETWORKS_ARRAY = []
Object.keys(NETWORKS).forEach(net => NETWORKS_ARRAY.push(NETWORKS[net]))

function isValidLegacyAddress(address) {
  if (!address)
    return false
  try {
    const { version, hash } = Bitcoin.address.fromBase58Check(address)
    if (version != this.network.pubKeyHash && version != this.network.scriptHash)
      throw new MelisError("CmInvalidAddressException", "Invalid prefix for Bitcoin Address: " + version)
    return true
  } catch (ex) {
    return false
  }
}

function isValidBchAddress(address) {
  const self = this
  try {
    const decoded = decodeBitcoinCashAddress(address, self) // { prefix, type, hash }
    return true
  } catch (ex) {
    return false
  }
}

function isValidGrsAddress(base58Address) {
  const self = this
  if (!base58Address)
    return false
  try {
    const { version, hash } = decodeGrsLegacyAddress(base58Address, self)
    return true
  } catch (ex) {
    console.log(ex)
    return false
  }
}

function decodeGrsLegacyAddress(base58Address, self) {
  if (!self)
    self = this
  const payload = base58grs.decode(base58Address)

  if (payload.length < 21 || payload.length > 21)
    throw new MelisError("CmInvalidAddressException", "Expected 21 bytes, got " + payload.length)

  const version = payload.readUInt8(0)
  if (version != self.network.pubKeyHash && version != self.network.scriptHash)
    throw new MelisError("CmInvalidAddressException", "Invalid prefix for GRS Address: " + version)

  const hash = payload.slice(1)
  return { version, hash }
}

function decodeBitcoinLegacyAddress(base58Address) {
  return Bitcoin.address.fromBase58Check(base58Address) // { version, hash }
}

function decodeBitcoinCashAddress(address, self) {
  if (C.LEGACY_BITCOIN_REGEX.test(address))
    return decodeBitcoinLegacyAddress(address)

  const expectedPrefix = self.addressPrefix
  let decoded   //  { prefix, type, hash }

  if (CASH_BECH32_REGEX.test(address))
    decoded = cashaddr.decode(address)
  else if (CASH_BECH32_WITHOUT_PREFIX_LOWERCASE.test(address))
    decoded = cashaddr.decode(expectedPrefix + ":" + address)
  else if (CASH_BECH32_WITHOUT_PREFIX_UPPERCASE.test(address))
    decoded = cashaddr.decode(expectedPrefix.toUpperCase() + ":" + address)

  if (decoded)
    if (decoded.prefix === expectedPrefix)
      return Object.assign(decoded, {
        version: decoded.type === "P2SH" ? self.network.scriptHash : self.network.pubKeyHash,
        hash: Buffer.from(decoded.hash)
      })
    else
      throw new MelisError("CmInvalidAddressException", "Invalid network for Bitcoin Cash Address -- expected: " + expectedPrefix + " got: " + decoded.prefix)

  throw new MelisError("CmInvalidAddressException", "Unknown address format: " + address)
}

function hashForSignatureLegacy(tx, index, redeemScript, amount, hashFlags) {
  return tx.hashForSignature(index, redeemScript, hashFlags)
}

function hashForSignatureCash(tx, index, redeemScript, amount, hashFlags) {
  return tx.hashForWitnessV0(index, redeemScript, amount, hashFlags + SIGHASH_BITCOINCASHBIP143)
}

function hashForSignatureGrs(tx, inIndex, prevOutScript, amount, hashType) {
  const EMPTY_SCRIPT = Buffer.allocUnsafe(0)
  const ONE = Buffer.from('0000000000000000000000000000000000000000000000000000000000000001', 'hex')
  const VALUE_UINT64_MAX = Buffer.from('ffffffffffffffff', 'hex')
  const BLANK_OUTPUT = {
    script: EMPTY_SCRIPT,
    valueBuffer: VALUE_UINT64_MAX
  }

  // https://github.com/bitcoin/bitcoin/blob/master/src/test/sighash_tests.cpp#L29
  if (inIndex >= tx.ins.length) return ONE

  // ignore OP_CODESEPARATOR
  var ourScript = bscript.compile(bscript.decompile(prevOutScript).filter(function (x) {
    return x !== opcodes.OP_CODESEPARATOR
  }))

  var txTmp = tx.clone()

  // SIGHASH_NONE: ignore all outputs? (wildcard payee)
  if ((hashType & 0x1f) === Bitcoin.Transaction.SIGHASH_NONE) {
    txTmp.outs = []

    // ignore sequence numbers (except at inIndex)
    txTmp.ins.forEach(function (input, i) {
      if (i === inIndex) return

      input.sequence = 0
    })

    // SIGHASH_SINGLE: ignore all outputs, except at the same index?
  } else if ((hashType & 0x1f) === Bitcoin.Transaction.SIGHASH_SINGLE) {
    // https://github.com/bitcoin/bitcoin/blob/master/src/test/sighash_tests.cpp#L60
    if (inIndex >= tx.outs.length) return ONE

    // truncate outputs after
    txTmp.outs.length = inIndex + 1

    // "blank" outputs before
    for (var i = 0; i < inIndex; i++) {
      txTmp.outs[i] = BLANK_OUTPUT
    }

    // ignore sequence numbers (except at inIndex)
    txTmp.ins.forEach(function (input, y) {
      if (y === inIndex) return

      input.sequence = 0
    })
  }

  // SIGHASH_ANYONECANPAY: ignore inputs entirely?
  if (hashType & Bitcoin.Transaction.SIGHASH_ANYONECANPAY) {
    txTmp.ins = [txTmp.ins[inIndex]]
    txTmp.ins[0].script = ourScript

    // SIGHASH_ALL: only ignore input scripts
  } else {
    // "blank" others input scripts
    txTmp.ins.forEach(function (input) { input.script = EMPTY_SCRIPT })
    txTmp.ins[inIndex].script = ourScript
  }

  // serialize and hash
  var buffer = Buffer.allocUnsafe(txTmp.__byteLength(false) + 4)
  buffer.writeInt32LE(hashType, buffer.length - 4)
  txTmp.__toBuffer(buffer, 0, false)

  return bcrypto.sha256(buffer)
}

function toScriptSignatureLegacy(signature, hashFlags) {
  return signature.toScriptSignature(hashFlags)
}

function toScriptSignatureCash(signature, hashFlags) {
  const hashTypeBuffer = Buffer.alloc(1)
  hashFlags |= SIGHASH_BITCOINCASHBIP143
  hashTypeBuffer.writeUInt8(hashFlags, 0)
  return Buffer.concat([signature.toDER(), hashTypeBuffer])
}

function convertBech32CashAddressToLegacy(address, self) {
  if (C.LEGACY_BITCOIN_REGEX.test(address))
    return address

  if (CASH_BECH32_REGEX.test(address)) {
    // Good as it is
  } else if (CASH_BECH32_WITHOUT_PREFIX_LOWERCASE.test(address)) {
    address = self.addressPrefix + ":" + address
  } else if (CASH_BECH32_WITHOUT_PREFIX_UPPERCASE.test(address)) {
    address = self.addressPrefix.toUpperCase() + ":" + address
  } else {
    throw new MelisError("CmInvalidAddressException", "Unknown address format: " + address)
  }

  let decoded
  try {
    decoded = cashaddr.decode(address)
  } catch (ex) {
    throw new MelisError("CmInvalidAddressException", "Unknown address format: " + address)
  }

  if (decoded.prefix !== self.addressPrefix)
    throw new MelisError("CmInvalidAddressException", "Invalid prefix in address -- expected: " + self.addressPrefix + " got: " + decoded.prefix)

  if (decoded.type === 'P2PKH')
    return Bitcoin.address.toBase58Check(Buffer.from(decoded.hash), self.network.pubKeyHash)
  else if (decoded.type === 'P2SH')
    return Bitcoin.address.toBase58Check(Buffer.from(decoded.hash), self.network.scriptHash)
  else
    throw new MelisError("CmInvalidAddressException", "Unknown Bitcoin Cash type: " + decoded.type)

}

function convertLegacyAddressToBech32Cash(address, self) {
  if (!C.LEGACY_BITCOIN_REGEX.test(address))
    throw new MelisError("CmInvalidAddressException", "Invalid Bitcoin Cash legacy address: " + address)

  let decoded
  try {
    decoded = Bitcoin.address.fromBase58Check(address, self.network)
  } catch (e) { }

  if (!decoded)
    throw new MelisError("CmInvalidAddressException", "Unable to decode Bitcoin Cash legacy address: " + address)

  let type
  if (decoded.version === self.network.pubKeyHash)
    type = 'P2PKH'
  else if (decoded.version === self.network.scriptHash)
    type = 'P2SH'
  else
    throw new MelisError("CmInvalidAddressException", "Unexpected version: " + decoded.version + " decoding Bitcoin Cash legacy address: " + address)

  return cashaddr.encode(self.addressPrefix, type, decoded.hash)
}

function toOutputScriptCash(address) {
  if (!C.LEGACY_BITCOIN_REGEX.test(address))
    address = convertBech32CashAddressToLegacy(address, this)
  return Bitcoin.address.toOutputScript(address, this.network)
}

function toOutputScriptLegacy(address) {
  return Bitcoin.address.toOutputScript(address, this.network)
}

function toOutputScriptGrs(base58Address) {
  const { version, hash } = decodeGrsLegacyAddress(base58Address, this)
  if (version === this.network.pubKeyHash)
    return bscript.pubKeyHash.output.encode(hash)
  if (version === this.network.scriptHash)
    return bscript.scriptHash.output.encode(hash)
  throw new MelisError("CmInvalidAddressException", "Unexpected version: " + version + " decoding Groestlcoin address: " + base58Address)
}

function wifToEcPair(wif) {
  return Bitcoin.ECPair.fromWIF(wif, this.network)
}

function signMessageWithKP_internal(keyPair, message, useSingleHash, self) {
  const pk = keyPair.d.toBuffer(32)
  return BitcoinMessage.sign(message, pk, true, self.network.messagePrefix, useSingleHash).toString('base64')
}

function signMessageWithKP(keyPair, message, self) {
  if (!self)
    self = this
  return signMessageWithKP_internal(keyPair, message, false, self)
}

function signMessageWithKPGrs(keyPair, message, self) {
  if (!self)
    self = this
  return signMessageWithKP_internal(keyPair, message, true, self)
}

function prepareAddressSignature(keyPair, prefix, signingFunction, self) {
  if (!self)
    self = this
  const address = pubkeyToAddress(keyPair)
  const message = prefix + address
  return {
    address: address,
    message: message,
    base64Sig: signingFunction(keyPair, message, self)
  }
}

function verifyMessageSignature(address, signature, message) {
  //return BitcoinMessage.verify(message, address, new Buffer(signature, 'base64'), this.network.messagePrefix)
  const { version, hash } = decodeBitcoinLegacyAddress(address)
  return BitcoinMessage.verify(message, hash, new Buffer(signature, 'base64'), this.network.messagePrefix)
}
function verifyMessageSignatureGrs(address, signature, message) {
  //return verifyMessageSignature(address, signature, message, true)
  const { version, hash } = decodeGrsLegacyAddress(address, this)
  return BitcoinMessage.verify(message, hash, new Buffer(signature, 'base64'), this.network.messagePrefix, true)
}

function buildAddressFromScript(outScript) {
  const self = this
  return Bitcoin.address.fromOutputScript(outScript, self.network)
}

function buildAddressFromScriptGrs(outputScript) {
  const self = this
  if (bscript.pubKeyHash.output.check(outputScript))
    return base58grs.encode(bscript.compile(outputScript).slice(3, 23), self.network.pubKeyHash)
  if (bscript.scriptHash.output.check(outputScript))
    return base58grs.encode(bscript.compile(outputScript).slice(2, 22), self.network.scriptHash)
  throw new MelisError("CmUnexpectedException", "Unknown script template: " + outputScript)
}

function derivePubKeys(xpubs, chain, hdIndex) {
  return derivePubKeys_internal(this, xpubs, chain, hdIndex)
}

function extractPubKeyFromOutputScript(script) {
  var type = bscript.classifyOutput(script)
  if (type === "pubkey") {
    //return Bitcoin.ECPubKey.fromBuffer(script.chunks[0])
    var decoded = bscript.decompile(script)
    //logger.log("Decoded:"); logger.log(decoded)
    return Bitcoin.ECPair.fromPublicKeyBuffer(decoded[0], this.network)
  }
  return null
}

function derivePubKeys_internal(self, xpubs, chain, hdIndex) {
  const keys = []
  for (var i = 0; i < xpubs.length; i++) {
    //const hd = Bitcoin.HDNode.fromBase58(xpubs[i], network)
    const hd = self.hdNodeFromBase58(xpubs[i])
    const key = hd.derive(chain).derive(hdIndex)
    keys.push(key.getPublicKeyBuffer().toString('hex'))
  }
  return keys
}

function createRedeemScript(keys, minSignatures, useCheckVerify) {
  if (!keys || minSignatures <= 0 || minSignatures > keys.length)
    return null
  let script
  if (keys.length === 1) {
    // sanity check: should never happen because not a P2SH script
    if (!useCheckVerify)
      throwUnexpectedEx("Tried to build a redeemscript for single pub key without CHECKSIGVERIFY")
    script = keys[0] + " OP_CHECKSIGVERIFY"
  } else {
    keys.sort()
    script = "OP_" + minSignatures
    for (var i = 0; i < keys.length; i++)
      script += " " + keys[i]
    script += " OP_" + keys.length
    if (useCheckVerify)
      script += " OP_CHECKMULTISIGVERIFY"
    else
      script += " OP_CHECKMULTISIG"
  }
  // this.log("[createRedeemScript2] script: " + script)
  return script
}

function calcP2SH(accountInfo, chain, hdIndex) {
  const self = this
  const scriptParams = accountInfo.scriptParams
  const hasMandatoryKeys = scriptParams.mandatoryKeys && scriptParams.mandatoryKeys.length > 0
  const hasOtherKeys = scriptParams.otherKeys && scriptParams.otherKeys.length > 0
  let script
  logger.log("minSignatures: " + accountInfo.minSignatures + " hasMandatoryKeys: " + hasMandatoryKeys + " hasOtherKeys: " + hasOtherKeys + " scriptParams: ", scriptParams)
  if (hasMandatoryKeys) {
    logger.log("[calcP2SH] #mandatoryKeys: " + scriptParams.mandatoryKeys.length, scriptParams.mandatoryKeys)
    const mandatoryPubKeys = derivePubKeys_internal(self, scriptParams.mandatoryKeys, chain, hdIndex)
    script = createRedeemScript(mandatoryPubKeys, scriptParams.mandatoryKeys.length, hasOtherKeys)
    if (hasOtherKeys) {
      logger.log("[calcP2SH] #otherKeys: " + scriptParams.otherKeys.length, scriptParams.otherKeys)
      let minimumNonMandatorySignatures = accountInfo.minSignatures - scriptParams.mandatoryKeys.length
      if (accountInfo.serverMandatory)
        minimumNonMandatorySignatures++
      if (minimumNonMandatorySignatures <= 0)
        throwUnexpectedEx("Unable to create address for account: unexpected signature scheme (minimumNonMandatorySignatures=" + minimumNonMandatorySignatures + ")")
      const otherPubKeys = derivePubKeys_internal(self, scriptParams.otherKeys, chain, hdIndex)
      script += " " + createRedeemScript(otherPubKeys, minimumNonMandatorySignatures, false)
    }
  } else {
    if (!hasOtherKeys)
      throwUnexpectedEx("Unexpected account info: no mandatory and other keys")
    logger.log("[calcP2SH] #otherKeys: " + scriptParams.otherKeys.length, scriptParams.otherKeys)
    const pubKeys = derivePubKeys_internal(self, scriptParams.otherKeys, chain, hdIndex)
    script = createRedeemScript(pubKeys, accountInfo.minSignatures, false)
  }
  logger.log("[calcP2SH] script: " + script)
  const redeemScript = bscript.fromASM(script)
  const scriptPubKey = bscript.scriptHash.output.encode(bcrypto.hash160(redeemScript))
  //logger.log("redeemScript: ", Bitcoin.script.toASM(redeemScript))
  //logger.log("scriptPubKey: ", Bitcoin.script.toASM(scriptPubKey))
  //return Bitcoin.address.fromOutputScript(scriptPubKey, this.network)
  return self.buildAddressFromScript(scriptPubKey)
}

function hdNodeFromHexSeed(seed) {
  return Bitcoin.HDNode.fromSeedHex(seed, this.network)
}

function hdNodeFromBase58(xpub) {
  return Bitcoin.HDNode.fromBase58(xpub, NETWORKS_ARRAY)
}

function hdNodeFromBase58Grs(hd_base58_ser) {
  var buffer = base58grs.decode(hd_base58_ser)
  if (buffer.length !== 78) throw new Error('Invalid buffer length')

  // 4 bytes: version bytes
  var version = buffer.readUInt32BE(0)
  //const network = this.network

  // // list of networks?
  // if (Array.isArray(Bitcoin.networks)) {
  let network = NETWORKS_ARRAY.filter(x => {
    return version === x.bip32.private ||
      version === x.bip32.public
  }).pop()

  if (!network) throw new Error('Unknown GRS network version')

  //   // otherwise, assume a network object (or default to bitcoin)
  // } else {
  //   network = networks || NETWORKS.bitcoin
  // }

  if (version !== network.bip32.private &&
    version !== network.bip32.public) throw new Error('Invalid network version')

  // 1 byte: depth: 0x00 for master nodes, 0x01 for level-1 descendants, ...
  var depth = buffer[4]

  // 4 bytes: the fingerprint of the parent's key (0x00000000 if master key)
  var parentFingerprint = buffer.readUInt32BE(5)
  if (depth === 0) {
    if (parentFingerprint !== 0x00000000) throw new Error('Invalid parent fingerprint')
  }

  // 4 bytes: child number. This is the number i in xi = xpar/i, with xi the key being serialized.
  // This is encoded in MSB order. (0x00000000 if master key)
  var index = buffer.readUInt32BE(9)
  if (depth === 0 && index !== 0) throw new Error('Invalid index')

  // 32 bytes: the chain code
  var chainCode = buffer.slice(13, 45)
  var keyPair

  // 33 bytes: private key data (0x00 + k)
  if (version === network.bip32.private) {
    if (buffer.readUInt8(45) !== 0x00) throw new Error('Invalid private key')

    var d = BigInteger.fromBuffer(buffer.slice(46, 78))
    keyPair = new Bitcoin.ECPair(d, null, { network: network })

    // 33 bytes: public key data (0x02 + X or 0x03 + X)
  } else {
    var Q = ecurve.Point.decodeFrom(curve, buffer.slice(45, 78))
    // Q.compressed is assumed, if somehow this assumption is broken, `new HDNode` will throw

    // Verify that the X coordinate in the public point corresponds to a point on the curve.
    // If not, the extended public key is invalid.
    curve.validate(Q)

    keyPair = new Bitcoin.ECPair(null, Q, { network: network })
  }

  var hd = new Bitcoin.HDNode(keyPair, chainCode)
  hd.depth = depth
  hd.index = index
  hd.parentFingerprint = parentFingerprint

  return hd
}

function fixKeyNetworkParameters(key) {
  key.keyPair.network = this.network
}

function pubkeyToAddress(key) {
  return key.getAddress(this.network)
}

function pubkeyToAddressGrs(key) {
  return base58grs.encode(bcrypto.hash160(key.getPublicKeyBuffer()), this.network.pubKeyHash)
}

function hdNodeToBase58Xpub(hd) {
  return hd.neutered().toBase58()
}

function hdNodeToBase58XpubGrs(hd) {
  // Version
  const version = this.network.bip32.public
  const buffer = Buffer.allocUnsafe(78)

  // 4 bytes: version bytes
  buffer.writeUInt32BE(version, 0)

  // 1 byte: depth: 0x00 for master nodes, 0x01 for level-1 descendants, ....
  buffer.writeUInt8(hd.depth, 4)

  // 4 bytes: the fingerprint of the parent's key (0x00000000 if master key)
  buffer.writeUInt32BE(hd.parentFingerprint, 5)

  // 4 bytes: child number. This is the number i in xi = xpar/i, with xi the key being serialized.
  // This is encoded in big endian. (0x00000000 if master key)
  buffer.writeUInt32BE(hd.index, 9)

  // 32 bytes: the chain code
  hd.chainCode.copy(buffer, 13)

  // 33 bytes: the public key
  // X9.62 encoding for public keys
  hd.keyPair.getPublicKeyBuffer().copy(buffer, 45)

  return base58grs.encode(buffer)
}

//
//
//

const COMMON_METHODS = {
  wifToEcPair,
  verifyMessageSignature,
  buildAddressFromScript,//: function (outScript) { return buildAddressFromScript(this, outScript) },
  extractPubKeyFromOutputScript, pubkeyToAddress,
  hdNodeFromHexSeed, hdNodeFromBase58, hdNodeToBase58Xpub,
  derivePubKeys, calcP2SH, fixKeyNetworkParameters,
  signMessageWithKP,
  prepareAddressSignature: function (keyPair, prefix) {
    return prepareAddressSignature(keyPair, prefix, signMessageWithKP, this)
  },
}

const BCH_CONSTS = {
  CASH_BECH32_REGEX, CASH_BECH32_WITHOUT_PREFIX_LOWERCASE, CASH_BECH32_WITHOUT_PREFIX_UPPERCASE
}

const BTC_COMMON = {
  isValidAddress: isValidLegacyAddress,
  toScriptSignature: toScriptSignatureLegacy,
  toOutputScript: toOutputScriptLegacy,
  decodeCoinAddress: decodeBitcoinLegacyAddress,
  hashForSignature: hashForSignatureLegacy
}

const BCH_COMMON = {
  C: BCH_CONSTS,
  isValidAddress: isValidBchAddress,
  toScriptSignature: toScriptSignatureCash,
  toOutputScript: toOutputScriptCash,
  hashForSignature: hashForSignatureCash,
  decodeCoinAddress: function (address) { return decodeBitcoinCashAddress(address, this) },
  toLegacyAddress: function (address) { return convertBech32CashAddressToLegacy(address, this) },
  toCashAddress: function (address) { return convertLegacyAddressToBech32Cash(address, this) }
}

const BTC = Object.assign({ network: NETWORKS.bitcoin }, BTC_COMMON, COMMON_METHODS)
const TBTC = Object.assign({}, BTC, { network: NETWORKS.testnet })
const RBTC = Object.assign({}, TBTC)

const BCH = Object.assign({ network: NETWORKS.bitcoin, addressPrefix: PREFIX_MAINNET }, BCH_COMMON, COMMON_METHODS)
const TBCH = Object.assign({}, BCH, { network: NETWORKS.testnet, addressPrefix: PREFIX_TESTNET })
const RBCH = Object.assign({}, TBCH, { addressPrefix: PREFIX_REGTEST })

const LTC = Object.assign({ network: NETWORKS.litecoin }, BTC_COMMON, COMMON_METHODS)
const TLTC = Object.assign({}, LTC, { network: litecoinTestnet })
const RLTC = Object.assign({}, TLTC)

const GRS = Object.assign({}, BTC,
  {
    network: grsProdnet,
    verifyMessageSignature: verifyMessageSignatureGrs,
    isValidAddress: isValidGrsAddress,
    decodeCoinAddress: decodeGrsLegacyAddress,
    toOutputScript: toOutputScriptGrs,
    buildAddressFromScript: buildAddressFromScriptGrs, //: function (outScript) { return buildAddressFromScriptGrs(this, outScript) },
    hdNodeFromBase58: hdNodeFromBase58Grs,
    hdNodeToBase58Xpub: hdNodeToBase58XpubGrs,
    pubkeyToAddress: pubkeyToAddressGrs,
    hashForSignature: hashForSignatureGrs,
    signMessageWithKP: signMessageWithKPGrs,
    prepareAddressSignature: function (keyPair, prefix) {
      return prepareAddressSignature(keyPair, prefix, signMessageWithKPGrs, this)
    },
  })
const TGRS = Object.assign({}, GRS, { network: grsTestnet })
const RGRS = Object.assign({}, TGRS)

const drivers = {
  BTC, TBTC, RBTC,
  BCH, TBCH, RBCH,
  LTC, TLTC, RLTC,
  GRS, TGRS, RGRS,
}

module.exports = drivers