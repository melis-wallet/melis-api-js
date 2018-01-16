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
  try {
    getAddressBytesFromBchAddress(address)
  } catch (ex) {
    return false
  }
}  

function getAddressBytesFromLegacyAddr(base58Address) {
    const { version, hash } = Bitcoin.address.fromBase58Check(base58Address)
  return hash
}  

function getAddressBytesFromBchAddress(address) {
  if (C.LEGACY_BITCOIN_REGEX.test(address))
    return getAddressBytesFromLegacyAddr(address)

  if (CASH_BECH32_REGEX.test(address)) {
    const { prefix, type, hash } = cashaddr.decode(address)
    if (prefix !== this.addressPrefix)
      throw new MelisError("CmInvalidAddressException", "Invalid network for Bitcoin Cash Address -- expected: " + this.addressPrefix + " got: " + prefix)
    return hash
  }

  if (CASH_BECH32_WITHOUT_PREFIX_LOWERCASE.test(address)) {
    const { prefix, type, hash } = cashaddr.decode(this.addressPrefix + ":" + address)
    return hash
  }

  if (CASH_BECH32_WITHOUT_PREFIX_UPPERCASE.test(address)) {
    const { prefix, type, hash } = cashaddr.decode(this.addressPrefix.toUpperCase() + ":" + address)
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

const BCH_CONSTS = {
  CASH_BECH32_REGEX, CASH_BECH32_WITHOUT_PREFIX_LOWERCASE, CASH_BECH32_WITHOUT_PREFIX_UPPERCASE
}

const BTC = {
  network: Bitcoin.networks.bitcoin,
  isValidAddress: isValidLegacyAddress,
  hashForSignature: hashForSignatureLegacy,
  getAddressBytes: getAddressBytesFromLegacyAddr
}

const TBTC = {
  network: Bitcoin.networks.testnet,
  isValidAddress: isValidLegacyAddress,
  hashForSignature: hashForSignatureLegacy,
  getAddressBytes: getAddressBytesFromLegacyAddr
}

const RBTC = {
  network: Bitcoin.networks.testnet,
  isValidAddress: isValidLegacyAddress,
  hashForSignature: hashForSignatureLegacy,
  getAddressBytes: getAddressBytesFromLegacyAddr
}

const BCH = {
  C: BCH_CONSTS,
  network: Bitcoin.networks.bitcoin,
  addressPrefix: PREFIX_MAINNET,
  isValidAddress: isValidBchAddress,
  hashForSignature: hashForSignatureCash,
  getAddressBytes: getAddressBytesFromBchAddress
}

const TBCH = {
  C: BCH_CONSTS,
  network: Bitcoin.networks.testnet,
  addressPrefix: PREFIX_TESTNET,
  isValidAddress: isValidBchAddress,
  hashForSignature: hashForSignatureCash,
  getAddressBytes: getAddressBytesFromBchAddress
}

const RBCH = {
  C: BCH_CONSTS,
  network: Bitcoin.networks.testnet,
  addressPrefix: PREFIX_REGTEST,
  isValidAddress: isValidBchAddress,
  hashForSignature: hashForSignatureCash,
  getAddressBytes: getAddressBytesFromBchAddress,
}

const networks = {
  BTC, TBTC, RBTC,
  BCH, TBCH, RBCH
}

module.exports = networks