require('isomorphic-fetch');
const Q = require('q')
const C = require("./cm-constants")
// const Logger = require("./logger")
// const logger = new Logger()
const logger = require("./logger")

const HARDCODED_DEFAULT_FEES = {
  detail: { provider: "hardcoded" },
  maximumAcceptable: 50,
  fastestFee: 10,
  mediumFee: 5,
  slowFee: 2
}

const HARDCODED_BCH_FEES = {
  detail: { provider: "hardcoded" },
  maximumAcceptable: 10,
  fastestFee: 4,
  mediumFee: 2,
  slowFee: 1
}

const HARDCODED_LTC_FEES = {
  detail: { provider: "hardcoded" },
  maximumAcceptable: 500,
  fastestFee: 200,
  mediumFee: 150,
  slowFee: 100
}

const HARDCODED_BSV_FEES = HARDCODED_BCH_FEES
const HARDCODED_DOGE_FEES = HARDCODED_BCH_FEES

function getNetworkFeesEarnCom() {
  return fetch("https://bitcoinfees.earn.com/api/v1/fees/recommended").then(res => {
    if (res && res.status === 200)
      return res.json()
    else
      return null
  }).then(val => {
    if (!val || !val.fastestFee)
      return null
    return prepareMelisFees({
      provider: "earn.com",
      fastestFee: val.fastestFee,
      mediumFee: val.halfHourFee,
      slowFee: val.hourFee
    })
  }).catch(err => {
    logger.log("Error reading fees from earn.com:", err)
    return Q(null)
  })
}

// Stopped working
function getNetworkFees21() {
  return fetch("https://bitcoinfees.21.co/api/v1/fees/recommended").then(res => {
    if (res && res.status === 200)
      return res.json()
    else
      return null
  }).then(val => {
    if (!val || !val.fastestFee)
      return null
    return prepareMelisFees({
      provider: "21.co",
      fastestFee: val.fastestFee,
      mediumFee: val.halfHourFee,
      slowFee: val.hourFee
    })
  }).catch(err => {
    logger.log("Error reading fees from 21.co:", err)
    return Q(null)
  })
}

function getNetworkFeesBlockCypher(coin) {
  let symbol
  if (coin === C.COIN_PROD_LTC)
    symbol = "ltc"
  else if (coin === C.COIN_PROD_BTC)
    symbol = "btc"
  else if (coin === C.COIN_PROD_DOGE)
    symbol = "doge"
  else
  return null
  const url = "https://api.blockcypher.com/v1/"+symbol+"/main"
  return fetch(url).then(res => {
    if (res && res.status === 200)
      return res.json()
    else
      return null
  }).then(val => {
    if (!val.high_fee_per_kb)
      return null
    return prepareMelisFees({
      provider: "blockcypher.com",
      fastestFee: Math.round(val.high_fee_per_kb / 1024),
      mediumFee: Math.round(val.medium_fee_per_kb / 1024),
      slowFee: Math.round(val.low_fee_per_kb / 1024)
    })
  }).catch(err => {
    logger.log("Error reading fees from blockcypher.com:", err)
    return Q(null)
  })
}

function getNetworkFeesBitgo() {
  return fetch("https://www.bitgo.com/api/v1/tx/fee?numBlocks=4").then(res => {
    if (res && res.status === 200)
      return res.json()
    else
      return null
  }).then(val => {
    if (!val.feePerKb)
      return null
    //    if (!val.feeByBlockTarget || !val.feeByBlockTarget[2] || !val.feeByBlockTarget[4] || !val.feeByBlockTarget[10])
    //      return null
    return prepareMelisFees({
      provider: "bitgo.com",
      fastestFee: Math.round(val.feePerKb / 1024),
      mediumFee: Math.round((val.feePerKb * 0.8) / 1024),
      slowFee: Math.round((val.feePerKb * 0.6) / 1024)
    })
  }).catch(err => {
    logger.log("Error reading fees from bitgo:", err)
    return Q(null)
  })
}

function getNetworkFeesMelis(coin) {
  const url = melis.peekRestPrefix() + "/feeInfo/" + coin
  return fetch(url).then(res => res.json())
    .then(val => prepareMelisFees(val.feeInfo))
}

function prepareMelisFees(feeInfo) {
  return {
    detail: feeInfo,
    fastestFee: feeInfo.fastestFee,
    mediumFee: feeInfo.mediumFee,
    maximumAcceptable: feeInfo.fastestFee * 3,
    lastUpdated: new Date()
  }
}

const feeProviders = {}

// Bitcoin
feeProviders[C.COIN_PROD_BTC] = {
  'hardcoded': () => Q(HARDCODED_DEFAULT_FEES),
  'melis': () => getNetworkFeesMelis(C.COIN_PROD_BTC),
  //'21.co': getNetworkFees21,
  'earn.com': getNetworkFeesEarnCom,
  'blockcypher.com': () => getNetworkFeesBlockCypher(C.COIN_PROD_BTC),
  'bitgo.com': getNetworkFeesBitgo
}
feeProviders[C.COIN_TEST_BTC] = {
  'hardcoded': () => Q(HARDCODED_BCH_FEES),
  'melis': () => getNetworkFeesMelis(C.COIN_TEST_BTC)
}
feeProviders[C.COIN_REGTEST_BTC] = {
  'hardcoded': () => Q(HARDCODED_BCH_FEES),
  'melis': () => getNetworkFeesMelis(C.COIN_REGTEST_BTC)
}

// Bitcoin Cash
feeProviders[C.COIN_PROD_BCH] = {
  'hardcoded': () => Q(HARDCODED_BCH_FEES),
  'melis': () => getNetworkFeesMelis(C.COIN_PROD_BCH),
}
feeProviders[C.COIN_TEST_BCH] = {
  'hardcoded': () => Q(HARDCODED_BCH_FEES),
  'melis': () => getNetworkFeesMelis(C.COIN_TEST_BCH)
}
feeProviders[C.COIN_REGTEST_BCH] = {
  'hardcoded': () => Q(HARDCODED_BCH_FEES),
  'melis': () => getNetworkFeesMelis(C.COIN_REGTEST_BCH)
}

// Litecoin
feeProviders[C.COIN_PROD_LTC] = {
  'hardcoded': () => Q(HARDCODED_LTC_FEES),
  'melis': () => getNetworkFeesMelis(C.COIN_PROD_LTC),
  'blockcypher.com': () => getNetworkFeesBlockCypher(C.COIN_PROD_LTC)
}
feeProviders[C.COIN_TEST_LTC] = {
  'hardcoded': () => Q(HARDCODED_LTC_FEES),
  'melis': () => getNetworkFeesMelis(C.COIN_TEST_LTC)
}
feeProviders[C.COIN_REGTEST_LTC] = {
  'hardcoded': () => Q(HARDCODED_LTC_FEES),
  'melis': () => getNetworkFeesMelis(C.COIN_REGTEST_LTC)
}

// Groestlcoin
feeProviders[C.COIN_PROD_GRS] = {
  'hardcoded': () => Q(HARDCODED_BCH_FEES),
  'melis': () => getNetworkFeesMelis(C.COIN_PROD_GRS)
}
feeProviders[C.COIN_TEST_GRS] = {
  'hardcoded': () => Q(HARDCODED_BCH_FEES),
  'melis': () => getNetworkFeesMelis(C.COIN_TEST_GRS)
}
feeProviders[C.COIN_REGTEST_GRS] = {
  'hardcoded': () => Q(HARDCODED_BCH_FEES),
  'melis': () => getNetworkFeesMelis(C.COIN_REGTEST_GRS)
}

// Bitcoin SV
feeProviders[C.COIN_PROD_BSV] = {
  'hardcoded': () => Q(HARDCODED_BSV_FEES),
  'melis': () => getNetworkFeesMelis(C.COIN_PROD_BSV)
}
feeProviders[C.COIN_TEST_BSV] = {
  'hardcoded': () => Q(HARDCODED_BSV_FEES),
  'melis': () => getNetworkFeesMelis(C.COIN_TEST_BSV)
}
feeProviders[C.COIN_REGTEST_BSV] = {
  'hardcoded': () => Q(HARDCODED_BSV_FEES),
  'melis': () => getNetworkFeesMelis(C.COIN_REGTEST_BSV)
}

// DOGE
feeProviders[C.COIN_PROD_DOGE] = {
  'hardcoded': () => Q(HARDCODED_DOGE_FEES),
  'melis': () => getNetworkFeesMelis(C.COIN_PROD_DOGE)
}
feeProviders[C.COIN_TEST_DOGE] = {
  'hardcoded': () => Q(HARDCODED_DOGE_FEES),
  'melis': () => getNetworkFeesMelis(C.COIN_TEST_DOGE)
}
feeProviders[C.COIN_REGTEST_DOGE] = {
  'hardcoded': () => Q(HARDCODED_DOGE_FEES),
  'melis': () => getNetworkFeesMelis(C.COIN_REGTEST_DOGE)
}


// var nextFeeProvider
// feeProviders = [
//   getNetworkFees21, getNetworkFeesBitgo, getNetworkFeesBlockCypher
// ]

// function calcNextFeeProvider() {
//   if (nextFeeProvider === undefined)
//     nextFeeProvider = simpleRandomInt(feeProviders.length)
//   nextFeeProvider = (nextFeeProvider + 1) % feeProviders.length
//   return feeProviders[nextFeeProvider]
// }
//
// FeeInfo.prototype.updateNetworkFeesFromExternalProviders = function () {
//   var self = this
//   var maxTries = feeProviders.length
//   function getFees(n) {
//     var provider = self.calcNextFeeProvider()
//     return provider().then(res => {
//       if (res)
//         return res
//       if (n >= maxTries)
//         return null
//       else
//         return getFees(n + 1)
//     })
//   }
//   return getFees(0).then(res => {
//     if (!res)
//       return null
//     return self.fees = {
//       detail: res,
//       fastestFee: res.fastestFee,
//       maximumAcceptable: res.fastestFee * 3,
//       lastUpdated: new Date()
//     }
//   })
// }

// FeeInfo.prototype.getNetworkFees = function (coin) {
//   return this.getFeesPerByte(coin).then(feeInfo => {
//     console.log("  DEBUG  res:", feeInfo)
//     return {
//       detail: feeInfo,
//       fastestFee: feeInfo.fastestFee,
//       mediumFee: feeInfo.mediumFee,
//       maximumAcceptable: feeInfo.fastestFee * 3,
//       lastUpdated: new Date()
//     }
//   })
// }

var melis

function FeeInfo(config) {
  if (!config || !config.melis)
    logger.logWarning("Missing melis definition in FeeInfo constructor")
  if (config && config.melis)
    melis = config.melis
}

FeeInfo.prototype.getHardcodedFeePerByte = function (coin) {
  switch (coin) {
    case C.COIN_PROD_BCH:
    case C.COIN_TEST_BCH:
    case C.COIN_REGTEST_BCH:
    case C.COIN_TEST_BTC:
    case C.COIN_REGTEST_BTC:
      return HARDCODED_BCH_FEES
    case C.COIN_PROD_LTC:
    case C.COIN_TEST_LTC:
    case C.COIN_REGTEST_LTC:
      return HARDCODED_LTC_FEES
    case C.COIN_PROD_BTC:
    default:
      return HARDCODED_DEFAULT_FEES
  }
}

FeeInfo.prototype.getProviderNames = function (coin) {
  const providers = feeProviders[coin]
  if (!providers)
    return ['hardcoded']
  return Object.keys(providers)
}

FeeInfo.prototype.getFeesByProvider = function (coin, providerName) {
  const providers = feeProviders[coin]
  if (!providers)
    return () => Q(this.getHardcodedFeePerByte(coin))
  else
    return providers[providerName]
}

module.exports = FeeInfo
