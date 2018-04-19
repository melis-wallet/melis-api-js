const Bitcoin = require('bitcoinjs-lib')
const bscript = Bitcoin.script
const BitcoinMessage = require('bitcoinjs-message')
const cashaddr = require('cashaddrjs')
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

const CASH_BECH32_REGEX = new RegExp("(("
  + PREFIX_MAINNET + ")|(" + PREFIX_MAINNET.toUpperCase() + ")|("
  + PREFIX_TESTNET + ")|(" + PREFIX_TESTNET.toUpperCase() + ")|("
  + PREFIX_REGTEST + ")|(" + PREFIX_REGTEST.toUpperCase() + ")"
  + "):(([" + C.BECH32_CHARSET + "]{42})|([" + C.BECH32_CHARSET.toUpperCase() + "]{42}))")

const CASH_BECH32_WITHOUT_PREFIX_LOWERCASE = new RegExp("[" + C.BECH32_CHARSET + "]{42}")
const CASH_BECH32_WITHOUT_PREFIX_UPPERCASE = new RegExp("[" + C.BECH32_CHARSET.toUpperCase() + "]{42}")

const SIGHASH_BITCOINCASHBIP143 = 0x40

const litecoinTestnet = {
  messagePrefix: '\x19Litecoin Signed Message:\n',
  bip32: {
    public: 0x043587CF, // 0x019da462,
    private: 0x04358394 // 0x019d9cfe
  },
  pubKeyHash: 0x6F,
  scriptHash: 0x3A,
  wif: 0xEF
}

function isValidLegacyAddress(address) {
  if (!address)
    return false
  try {
    Bitcoin.address.fromBase58Check(address)
    return true
  } catch (ex) {
    return false
  }
}

function isValidBchAddress(address) {
  const self = this
  try {
    getAddressBytesFromBchAddress(address, self)
    return true
  } catch (ex) {
    return false
  }
}

function getAddressBytesFromLegacyAddr(base58Address) {
  const { version, hash } = Bitcoin.address.fromBase58Check(base58Address)
  return hash
}

function getAddressBytesFromBchAddress(address, self) {
  if (C.LEGACY_BITCOIN_REGEX.test(address))
    return getAddressBytesFromLegacyAddr(address)

  if (CASH_BECH32_REGEX.test(address)) {
    const { prefix, type, hash } = cashaddr.decode(address)
    if (prefix !== self.addressPrefix)
      throw new MelisError("CmInvalidAddressException", "Invalid network for Bitcoin Cash Address -- expected: " + self.addressPrefix + " got: " + prefix)
    return Buffer.from(hash)
  }

  if (CASH_BECH32_WITHOUT_PREFIX_LOWERCASE.test(address)) {
    const { prefix, type, hash } = cashaddr.decode(self.addressPrefix + ":" + address)
    return Buffer.from(hash)
  }

  if (CASH_BECH32_WITHOUT_PREFIX_UPPERCASE.test(address)) {
    const { prefix, type, hash } = cashaddr.decode(self.addressPrefix.toUpperCase() + ":" + address)
    return Buffer.from(hash)
  }

  throw new MelisError("CmInvalidAddressException", "Unknown address format: " + address)
}

function hashForSignatureLegacy(tx, index, redeemScript, amount, hashFlags) {
  return tx.hashForSignature(index, redeemScript, hashFlags)
}

function hashForSignatureCash(tx, index, redeemScript, amount, hashFlags) {
  return tx.hashForWitnessV0(index, redeemScript, amount, hashFlags + SIGHASH_BITCOINCASHBIP143)
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

  let decode
  try {
    decode = Bitcoin.address.fromBase58Check(address, self.network)
  } catch (e) { }

  if (!decode)
    throw new MelisError("CmInvalidAddressException", "Unable to decode Bitcoin Cash legacy address: " + address)

  let type
  if (decode.version === self.network.pubKeyHash)
    type = 'P2PKH'
  else if (decode.version === self.network.scriptHash)
    type = 'P2SH'
  else
    throw new MelisError("CmInvalidAddressException", "Unexpected version: " + decode.version + " decoding Bitcoin Cash legacy address: " + address)

  return cashaddr.encode(self.addressPrefix, type, decode.hash)
}

function toOutputScriptCash(address) {
  if (!C.LEGACY_BITCOIN_REGEX.test(address))
    address = convertBech32CashAddressToLegacy(address, this)
  return Bitcoin.address.toOutputScript(address, this.network)
}

function toOutputScriptLegacy(address) {
  return Bitcoin.address.toOutputScript(address, this.network)
}

function wifToEcPair(wif) {
  return Bitcoin.ECPair.fromWIF(wif, this.network)
}

function signMessageWithKP(keyPair, message) {
  var pk = keyPair.d.toBuffer(32)
  return BitcoinMessage.sign(message, pk, true, this.network.messagePrefix).toString('base64')
}

function verifyBitcoinMessageSignature(address, signature, message) {
  return BitcoinMessage.verify(message, address, new Buffer(signature, 'base64'), this.network.messagePrefix)
}

function decodeAddressFromScript(script) {
  return Bitcoin.address.fromOutputScript(script, this.network)
}

function addressFromPubKey(pubKey) {
  return pubKey.getAddress(this.network)
}

function derivePubKeys(xpubs, chain, hdIndex) {
  return derivePubKeys_internal(xpubs, chain, hdIndex, this.network)
}

function extractPubKeyFromOutputScript(script) {
  var type = Bitcoin.script.classifyOutput(script)
  if (type === "pubkey") {
    //return Bitcoin.ECPubKey.fromBuffer(script.chunks[0])
    var decoded = Bitcoin.script.decompile(script)
    //logger.log("Decoded:"); logger.log(decoded)
    return Bitcoin.ECPair.fromPublicKeyBuffer(decoded[0], this.network)
  }
  return null
}

function prepareAddressSignature(keyPair, prefix) {
  var address = this.addressFromPubKey(keyPair)
  var message = prefix + address
  return {
    address: address,
    message: message,
    base64Sig: this.signMessageWithKP(keyPair, message)
  }
}

function derivePubKeys_internal(xpubs, chain, hdIndex, network) {
  var keys = []
  for (var i = 0; i < xpubs.length; i++) {
    var hd = Bitcoin.HDNode.fromBase58(xpubs[i], network)
    var key = hd.derive(chain).derive(hdIndex)
    keys.push(key.getPublicKeyBuffer().toString('hex'))
  }
  return keys
}

function createRedeemScript(keys, minSignatures, useCheckVerify) {
  if (!keys || minSignatures <= 0 || minSignatures > keys.length)
    return null
  var script
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
  var scriptParams = accountInfo.scriptParams
  var script
  var hasMandatoryKeys = scriptParams.mandatoryKeys && scriptParams.mandatoryKeys.length > 0
  var hasOtherKeys = scriptParams.otherKeys && scriptParams.otherKeys.length > 0
  logger.log("minSignatures: " + accountInfo.minSignatures + " hasMandatoryKeys: " + hasMandatoryKeys + " hasOtherKeys: " + hasOtherKeys + " scriptParams: ", scriptParams)
  if (hasMandatoryKeys) {
    logger.log("[calcP2SH] #mandatoryKeys: " + scriptParams.mandatoryKeys.length, scriptParams.mandatoryKeys)
    script = createRedeemScript(derivePubKeys_internal(scriptParams.mandatoryKeys, chain, hdIndex, this.network), scriptParams.mandatoryKeys.length, hasOtherKeys)
    if (hasOtherKeys) {
      logger.log("[calcP2SH] #otherKeys: " + scriptParams.otherKeys.length, scriptParams.otherKeys)
      var minimumNonMandatorySignatures = accountInfo.minSignatures - scriptParams.mandatoryKeys.length
      if (accountInfo.serverMandatory)
        minimumNonMandatorySignatures++
      if (minimumNonMandatorySignatures <= 0)
        throwUnexpectedEx("Unable to create address for account: unexpected signature scheme (minimumNonMandatorySignatures=" + minimumNonMandatorySignatures + ")")
      script += " " + createRedeemScript(derivePubKeys_internal(scriptParams.otherKeys, chain, hdIndex, this.network), minimumNonMandatorySignatures, false)
    }
  } else {
    if (!hasOtherKeys)
      throwUnexpectedEx("Unexpected account info: no mandatory and other keys")
    logger.log("[calcP2SH] #otherKeys: " + scriptParams.otherKeys.length, scriptParams.otherKeys)
    script = createRedeemScript(derivePubKeys_internal(scriptParams.otherKeys, chain, hdIndex, this.network), accountInfo.minSignatures, false)
  }
  logger.log("[calcP2SH] script: " + script)
  var redeemScript = Bitcoin.script.fromASM(script)
  var scriptPubKey = Bitcoin.script.scriptHash.output.encode(Bitcoin.crypto.hash160(redeemScript))
  //logger.log("redeemScript: ", Bitcoin.script.toASM(redeemScript))
  //logger.log("scriptPubKey: ", Bitcoin.script.toASM(scriptPubKey))
  return Bitcoin.address.fromOutputScript(scriptPubKey, this.network)
}

function hdNodeFromHexSeed(seed) {
  return Bitcoin.HDNode.fromSeedHex(seed, this.network)
}

function hdNodeFromBase58(xpub) {
  return Bitcoin.HDNode.fromBase58(xpub, this.network)
}

function fixKeyNetworkParameters(key) {
  key.keyPair.network = this.network
}

//
//
//

const COMMON_METHODS = {
  wifToEcPair, signMessageWithKP, verifyBitcoinMessageSignature,
  decodeAddressFromScript, addressFromPubKey, extractPubKeyFromOutputScript,
  prepareAddressSignature, derivePubKeys, calcP2SH,
  hdNodeFromHexSeed, hdNodeFromBase58, fixKeyNetworkParameters
}

const BCH_CONSTS = {
  CASH_BECH32_REGEX, CASH_BECH32_WITHOUT_PREFIX_LOWERCASE, CASH_BECH32_WITHOUT_PREFIX_UPPERCASE
}

const BTC_COMMON = {
  isValidAddress: isValidLegacyAddress,
  hashForSignature: hashForSignatureLegacy,
  toScriptSignature: toScriptSignatureLegacy,
  toOutputScript: toOutputScriptLegacy,
  getAddressBytes: getAddressBytesFromLegacyAddr
}

const BCH_COMMON = {
  C: BCH_CONSTS,
  isValidAddress: isValidBchAddress,
  hashForSignature: hashForSignatureCash,
  toScriptSignature: toScriptSignatureCash,
  toOutputScript: toOutputScriptCash,
  getAddressBytes: function (address) { return getAddressBytesFromBchAddress(address, this) },
  toLegacyAddress: function (address) { return convertBech32CashAddressToLegacy(address, this) },
  toCashAddress: function (address) { return convertLegacyAddressToBech32Cash(address, this) }
}

const BTC = Object.assign({ network: Bitcoin.networks.bitcoin }, BTC_COMMON, COMMON_METHODS)
const TBTC = Object.assign({ network: Bitcoin.networks.testnet }, BTC_COMMON, COMMON_METHODS)
const RBTC = Object.assign({ network: Bitcoin.networks.testnet }, BTC_COMMON, COMMON_METHODS)

const BCH = Object.assign({ network: Bitcoin.networks.bitcoin, addressPrefix: PREFIX_MAINNET }, BCH_COMMON, COMMON_METHODS)
const TBCH = Object.assign({ network: Bitcoin.networks.testnet, addressPrefix: PREFIX_TESTNET }, BCH_COMMON, COMMON_METHODS)
const RBCH = Object.assign({ network: Bitcoin.networks.testnet, addressPrefix: PREFIX_REGTEST }, BCH_COMMON, COMMON_METHODS)

const LTC = Object.assign({ network: Bitcoin.networks.litecoin }, BTC_COMMON, COMMON_METHODS)
const TLTC = Object.assign({ network: litecoinTestnet }, BTC_COMMON, COMMON_METHODS)
const RLTC = Object.assign({ network: litecoinTestnet }, BTC_COMMON, COMMON_METHODS)

const networks = {
  BTC, TBTC, RBTC,
  BCH, TBCH, RBCH,
  LTC, TLTC, RLTC,
}

module.exports = networks