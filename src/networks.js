const Bitcoin = require('bitcoinjs-lib')
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
  return Bitcoin.address.toOutputScript(regtestAddress, this.network)
}

//
//
//

const BCH_CONSTS = {
  CASH_BECH32_REGEX, CASH_BECH32_WITHOUT_PREFIX_LOWERCASE, CASH_BECH32_WITHOUT_PREFIX_UPPERCASE
}

const BTC = {
  network: Bitcoin.networks.bitcoin,
  isValidAddress: isValidLegacyAddress,
  hashForSignature: hashForSignatureLegacy,
  getAddressBytes: getAddressBytesFromLegacyAddr,
  toOutputScript: toOutputScriptLegacy
}

const TBTC = {
  network: Bitcoin.networks.testnet,
  isValidAddress: isValidLegacyAddress,
  hashForSignature: hashForSignatureLegacy,
  getAddressBytes: getAddressBytesFromLegacyAddr,
  toOutputScript: toOutputScriptLegacy
}

const RBTC = {
  network: Bitcoin.networks.testnet,
  isValidAddress: isValidLegacyAddress,
  hashForSignature: hashForSignatureLegacy,
  getAddressBytes: getAddressBytesFromLegacyAddr,
  toOutputScript: toOutputScriptLegacy
}

const BCH = {
  C: BCH_CONSTS,
  network: Bitcoin.networks.bitcoin,
  addressPrefix: PREFIX_MAINNET,
  isValidAddress: isValidBchAddress,
  hashForSignature: hashForSignatureCash,
  getAddressBytes: getAddressBytesFromBchAddress,
  toOutputScript: toOutputScriptCash
}

const TBCH = {
  C: BCH_CONSTS,
  network: Bitcoin.networks.testnet,
  addressPrefix: PREFIX_TESTNET,
  isValidAddress: isValidBchAddress,
  hashForSignature: hashForSignatureCash,
  getAddressBytes: getAddressBytesFromBchAddress,
  toOutputScript: toOutputScriptCash
}

const RBCH = {
  C: BCH_CONSTS,
  network: Bitcoin.networks.testnet,
  addressPrefix: PREFIX_REGTEST,
  isValidAddress: isValidBchAddress,
  hashForSignature: hashForSignatureCash,
  getAddressBytes: getAddressBytesFromBchAddress,
  toOutputScript: toOutputScriptCash
}

const networks = {
  BTC, TBTC, RBTC,
  BCH, TBCH, RBCH
}

module.exports = networks