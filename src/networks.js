const Bitcoin = require('bitcoinjs-lib')
const BitcoinMessage = require('bitcoinjs-message')
const cashaddr = require('cashaddrjs')
const C = require("./cm-constants")
const MelisError = require("./melis-error")

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
    getAddressBytesFromBchAddress_internal(address, self)
    return true
  } catch (ex) {
    return false
  }
}

function getAddressBytesFromLegacyAddr(base58Address) {
  const { version, hash } = Bitcoin.address.fromBase58Check(base58Address)
  return hash
}

function getAddressBytesFromBchAddress(address) {
  return getAddressBytesFromBchAddress_internal(address, this)
}

function getAddressBytesFromBchAddress_internal(address, self) {
  if (C.LEGACY_BITCOIN_REGEX.test(address))
    return getAddressBytesFromLegacyAddr(address)

  if (CASH_BECH32_REGEX.test(address)) {
    const { prefix, type, hash } = cashaddr.decode(address)
    if (prefix !== self.addressPrefix)
      throw new MelisError("CmInvalidAddressException", "Invalid network for Bitcoin Cash Address -- expected: " + self.addressPrefix + " got: " + prefix)
    return hash
  }

  if (CASH_BECH32_WITHOUT_PREFIX_LOWERCASE.test(address)) {
    const { prefix, type, hash } = cashaddr.decode(self.addressPrefix + ":" + address)
    return hash
  }

  if (CASH_BECH32_WITHOUT_PREFIX_UPPERCASE.test(address)) {
    const { prefix, type, hash } = cashaddr.decode(self.addressPrefix.toUpperCase() + ":" + address)
    return hash
  }

  throw new MelisError("CmInvalidAddressException", "Unknown address format: " + address)
}

function hashForSignatureLegacy(tx, index, redeemScript, amount, hashFlags) {
  return tx.hashForSignature(index, redeemScript, hashFlags)
}

function hashForSignatureCash(tx, index, redeemScript, amount, hashFlags) {
  return tx.hashForWitnessV0(index, redeemScript, amount, hashFlags + SIGHASH_BITCOINCASHBIP143)
}

function convertBech32CashAddressToLegacy(address, self) {
  if (C.LEGACY_BITCOIN_REGEX.test(address))
    return address

  var prefix, type, hash

  if (CASH_BECH32_REGEX.test(address)) {
    // Good as it is
  } else if (CASH_BECH32_WITHOUT_PREFIX_LOWERCASE.test(address)) {
    address = self.addressPrefix + ":" + address
  } else if (CASH_BECH32_WITHOUT_PREFIX_UPPERCASE.test(address)) {
    address = self.addressPrefix.toUpperCase() + ":" + address
  } else {
    throw new MelisError("CmInvalidAddressException", "Unknown address format: " + address)
  }

  try {
    [prefix, type, hash] = cashaddr.decode(address)
  } catch (ex) {
    throw new MelisError("CmInvalidAddressException", "Unknown address format: " + address)
  }

  if (prefix !== self.addressPrefix)
    throw new MelisError("CmInvalidAddressException", "Invalid prefix in address -- expected: " + self.addressPrefix + " got: " + prefix)

  if (type === 'P2PKH')
    return Bitcoin.address.toBase58Check(hash, self.network.pubKeyHash)
  else if (type === 'P2SH')
    return Bitcoin.address.toBase58Check(hash, self.network.scriptHash)
  else
    throw new MelisError("CmInvalidAddressException", "Unknown Bitcoin Cash type: " + type)
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

function extractPubKeyFromOutputScript(script) {
  var type = Bitcoin.script.classifyOutput(script)
  if (type === "pubkey") {
    //return Bitcoin.ECPubKey.fromBuffer(script.chunks[0])
    var decoded = Bitcoin.script.decompile(script)
    //this.log("Decoded:"); this.log(decoded)
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

//
//
//

const COMMON_METHODS = {
  wifToEcPair, signMessageWithKP, verifyBitcoinMessageSignature,
  decodeAddressFromScript, addressFromPubKey, extractPubKeyFromOutputScript,
  prepareAddressSignature
}

const BCH_CONSTS = {
  CASH_BECH32_REGEX, CASH_BECH32_WITHOUT_PREFIX_LOWERCASE, CASH_BECH32_WITHOUT_PREFIX_UPPERCASE
}

const BTC_COMMON = {
  isValidAddress: isValidLegacyAddress,
  hashForSignature: hashForSignatureLegacy,
  getAddressBytes: getAddressBytesFromLegacyAddr,
  toOutputScript: toOutputScriptLegacy
}

const BCH_COMMON = {
  C: BCH_CONSTS,
  isValidAddress: isValidBchAddress,
  hashForSignature: hashForSignatureCash,
  getAddressBytes: getAddressBytesFromBchAddress,
  toOutputScript: toOutputScriptCash
}

const BTC = Object.assign({ network: Bitcoin.networks.bitcoin }, BTC_COMMON, COMMON_METHODS)
const TBTC = Object.assign({ network: Bitcoin.networks.testnet }, BTC_COMMON, COMMON_METHODS)
const RBTC = Object.assign({ network: Bitcoin.networks.testnet }, BTC_COMMON, COMMON_METHODS)

const BCH = Object.assign({ network: Bitcoin.networks.bitcoin, addressPrefix: PREFIX_MAINNET }, BCH_COMMON, COMMON_METHODS)
const TBCH = Object.assign({ network: Bitcoin.networks.testnet, addressPrefix: PREFIX_TESTNET }, BCH_COMMON, COMMON_METHODS)
const RBCH = Object.assign({ network: Bitcoin.networks.testnet, addressPrefix: PREFIX_REGTEST }, BCH_COMMON, COMMON_METHODS)

const networks = {
  BTC, TBTC, RBTC,
  BCH, TBCH, RBCH
}

module.exports = networks