require('isomorphic-fetch');
const Q = require('q')
const events = require('events')
const Stomp = require('webstomp-client')
const WebSocketClient = require('ws')
const SockJS = require('sockjs-client')
const Bitcoin = require('bitcoinjs-lib')
const isNode = (require('detect-node') && !('electron' in global.process.versions))
const randomBytes = require('randombytes')
const sjcl = require('sjcl-all')
const C = require("./cm-constants")
const FeeApi = require("./fee-api")
const BC_APIS = require("./blockchain-apis")
const CoinDrivers = require("./drivers")
const logger = require("./logger")
const MelisErrorModule = require("./melis-error")
const MelisError = MelisErrorModule.MelisError
const throwUnexpectedEx = MelisErrorModule.throwUnexpectedEx

function walletOpen(target, hd, serverWalletData, isSingleAccount) {
  if (!hd || !serverWalletData)
    throwUnexpectedEx("No data opening wallet")
  const accounts = {}, balances = {}, infos = {}, keys = {}
  serverWalletData.accounts.forEach((a, i) => {
    accounts[a.pubId] = a
    balances[a.pubId] = serverWalletData.balances[i]
    infos[a.pubId] = serverWalletData.accountInfos[i]
    if (isSingleAccount)
      keys[a.num] = hd
    else
      keys[a.num] = target.deriveAccountHdKey(hd, a.num, a.coin)
  })
  if (isSingleAccount)
    target.hdAccount = hd
  else
    target.hdWallet = hd
  target.walletData = {
    accounts, balances, infos, keys
  }
  // Transforms arrays in objects
  serverWalletData.accounts = accounts
  serverWalletData.balances = balances
  serverWalletData.accountInfos = infos
  emitEvent(target, C.EVENT_WALLET_OPENED, serverWalletData)
}

function walletClose(target) {
  target.hdWallet = null
  target.hdAccount = null
  target.walletData = null
}

function updateWalletInfo(target, info) {
  target.walletData.info = info
}

function updateAccount(target, accountData, hdWallet) {
  const account = accountData.account
  target.walletData.accounts[account.pubId] = account
  target.walletData.balances[account.pubId] = accountData.balance
  target.walletData.infos[account.pubId] = accountData.accountInfo
  if (hdWallet)
    target.walletData.keys[account.num] = target.deriveAccountHdKey(hdWallet, account.num, account.coin)
}

function updateServerConfig(target, config) {
  if (config.message)
    logger.log("Server message status: " + config.message)
  target.useTestPaths = !(!config.platform || config.platform === "production")
  target.cmConfiguration = config
  target.lastBlocks = config.topBlocks
  target.platform = config.platform
}

function possiblyIncompleteAccountInfo(info) {
  return !info || !info.account || info.account.status == C.STATUS_WAITING_COSIGNERS
    || (info.cosigners && info.cosigners.length > 1 && !info.scriptParams)
}

function emitEvent(target, event, params) {
  target.lastReceivedMsgDate = new Date()
  if (event === C.EVENT_DISCONNECT_REQ) {
    logger.log("Server requested to disconnect:", params)
    return handleConnectionLoss(target, true)
  }
  if (event === C.EVENT_PING)
    target.stompClient.send(C.UTILS_PONG, {}, {})
  if (event !== C.EVENT_RPC_ACTIVITY_END && event !== C.EVENT_RPC_ACTIVITY_START)
    logger.log("[CM emitEvent] " + event + " params: " + JSON.stringify(params))
  if (event === C.EVENT_CONFIG)
    updateServerConfig(target, params)
  var listeners = target.listeners(event)
  if (!listeners.length) {
    //logger.log("[CM emitEvent] nessun listener per l'evento '" + event + "'")
    target.emit(C.UNHANDLED_EVENT, { name: event, params: params })
  } else {
    target.emit(event, params)
  }
}

function buildMelisErrorFromServerEx(err) {
  var res = new MelisError(err.ex, err.msg)
  for (var prop in err) {
    if (prop !== 'ex' && prop !== 'msg')
      res[prop] = err[prop]
  }
  return res
}

function buildBadParamEx(paramName, msg) {
  //return {ex: 'CmBadParamException', param: paramName, msg: msg}
  var err = new MelisError('CmBadParamException', msg)
  err.param = paramName
  return err
}

function buildInvalidAddressEx(address, msg) {
  return new MelisError('CmInvalidAddressException', msg)
}

function buildConnectionFailureEx(msg) {
  return new MelisError('ConnectionFailureException', msg)
}

function failPromiseWithEx(ex) {
  return Q.reject(ex)
}

function failPromiseWithBadParam(paramName, msg) {
  return Q.reject(buildBadParamEx(paramName, msg))
}

function throwBadParamEx(paramName, msg) {
  throw buildBadParamEx(paramName, msg)
}

function throwInvalidSignatureEx(msg) {
  throw new MelisError('CmInvalidSignatureException', msg)
}

function throwConnectionEx(msg) {
  throw buildConnectionFailureEx(msg)
}

function initializePrivateFields(target) {
  target.rpcCounter = 0
  if (target.waitingReplies) {
    for (var d in target.waitingReplies) {
      var deferred = target.waitingReplies[d].deferred
      deferred.reject(C.EVENT_DISCONNECT)
    }
  }
  target.waitingReplies = {}
  target.hdWallet = null
  target.accountExtendedKey = null
  target.walletData = null
  target.lastBlocks = {}
  target.lastOpenParams = null
  target.cmConfiguration = null // Got from server at connect
  target.connected = false
  target.connecting = false
  target.paused = false
  target.stompClient = null
}

function addPagingInfo(pars, pagingInfo) {
  if (pagingInfo) {
    pars.page = pagingInfo.page || 0
    pars.size = pagingInfo.size || 20
    if (pagingInfo.sortField) {
      pars.sortField = pagingInfo.sortField
      pars.sortDir = pagingInfo.sortDir
    }
  }
  return pars
}

function simpleRandomInt(max) {
  return Math.floor(Math.random() * max)
}

function handleConnectionLoss(target) {
  if (!target.connected)
    return Q()
  var deferred = Q.defer()
  target.stompClient.disconnect(function (res) {
    stompDisconnected(target, res, null)
    deferred.resolve()
  })
  return deferred.promise
}

function keepAliveFunction(target) {
  var nowTime = new Date().getTime()
  var lastMsgTime = target.lastReceivedMsgDate ? target.lastReceivedMsgDate.getTime() : nowTime - 1
  var secsElapsed = (nowTime - lastMsgTime) / 1000 + 1
  // console.log("[KEEPALIVE] elapsed from last msg: " + secsElapsed + " minKeepAlive: " + target.maxKeepAliveSeconds)
  if (secsElapsed >= target.maxKeepAliveSeconds + 20) {
    logger.logWarning("No response from server since " + secsElapsed + " seconds: DISCONNECTING")
    handleConnectionLoss(target)
  } else if (secsElapsed >= target.maxKeepAliveSeconds / 2) {
    target.ping()
  }
}

function rpcReplyHandler(target, res) {
  // logger.log("[STOMP] Ricevuta risposta RPC: " + res)
  //var messageId = res.headers.myId
  target.lastReceivedMsgDate = new Date()
  var message = JSON.parse(res.body)
  var messageId = message.id
  //logger.log("[STOMP] rpcReplyHandler message: " + JSON.stringify(message))
  if (messageId) {
    var rpcData = target.waitingReplies[messageId]
    delete target.waitingReplies[messageId]
    if (rpcData)
      rpcData.deferred.resolve(message.m)
    else
      logger.logError("[STOMP] RPC reply con ID: " + messageId + " non trovato in coda")
  } else {
    logger.logWarning("[STOMP] RPC reply senza ID:", message)
  }
}

function rpcErrorHandler(target, res) {
  logger.log("[STOMP] RPC Exception:", res)
  target.lastReceivedMsgDate = new Date()
  //var messageId = res.headers.myId
  var message = JSON.parse(res.body)
  var messageId = message.id
  if (messageId) {
    var rpcData = target.waitingReplies[messageId]
    delete target.waitingReplies[messageId]
    if (rpcData) {
      if (message.ex === C.EX_TOO_MANY_REQUESTS && rpcData.numRetries < target.rpcMaxRetries) {
        var rpcRetryDelay = target.rpcRetryDelay * rpcData.numRetries
        logger.log("Server requested to slow down requests -- retry #" + rpcData.numRetries + " waiting " + rpcRetryDelay + "ms")
        setTimeout(function () {
          logger.log("Preparing new request")
          target.rpc(rpcData.queue, rpcData.data, rpcData.headers, rpcData.numRetries + 1).then(function (res) {
            rpcData.deferred.resolve(res)
          }).catch(function (res) {
            logger.log("RE-REQUEST FAILED:", res)
            rpcData.deferred.reject(buildMelisErrorFromServerEx(res))
          })
        }, rpcRetryDelay)
      } else
        rpcData.deferred.reject(buildMelisErrorFromServerEx(message))
    } else {
      logger.logError("[STOMP] RPC Error -- Unable to find request with ID: " + messageId)
    }
  }
}

function CM(config) {
  if (!config)
    config = {}
  if (config.useTestPaths)
    this.useTestPaths = config.useTestPaths
  if (config.stompEndpoint || process.env.MELIS_ENDPOINT)
    this.stompEndpoint = process.env.MELIS_ENDPOINT || config.stompEndpoint
  this.apiDiscoveryUrl = process.env.MELIS_DISCOVER || config.apiDiscoveryUrl || C.MELIS_DISCOVER
  this.apiUrls = null
  this.rpcTimeout = config.rpcTimeout >= 100 ? config.rpcTimeout : 60000
  this.rpcRetryDelay = config.rpcRetryDelay >= 10 ? config.rpcRetryDelay : 1500
  this.rpcMaxRetries = config.rpcMaxRetries >= 1 ? config.rpcMaxRetries : 10
  this.autoReconnectDelay = config.autoReconnectDelay >= 0 ? config.autoReconnectDelay : 30
  this.maxKeepAliveSeconds = config.maxKeepAliveSeconds >= 20 ? config.maxKeepAliveSeconds : 60
  this.disableKeepAlive = config.disableKeepAlive === true
  this.connected = false
  this.autoReconnectFunc = null
  this.stompClient = null
  this.externalTxValidator = null
  this.minutesBetweenNetworkFeesUpdates = 60

  this.feeApi = new FeeApi({ melis: this })
  initializePrivateFields(this)
}

CM.prototype = Object.create(events.EventEmitter.prototype)

// by default f is console
CM.prototype.setLogger = function (f) {
  if (f)
    logger.setLogObject(f)
  else
    logger.setLogObject({
      log: (a, b) => { },
      logWarning: (a, b) => { },
      logError: (a, b) => { }
    })
}

CM.prototype.getRpcTimeout = function () {
  return this.rpcTimeout
}

CM.prototype.setRpcTimeout = function (ms) {
  if (ms >= 1 && ms <= 1000000)
    this.rpcTimeout = ms
  else
    throwBadParamEx(ms, "Timeout ms must be between 1 and 1000000")
}

CM.prototype.isProdNet = function () {
  return !this.useTestPaths
}

//
// Coin dependent functions
//

function getSupportedCoins() {
  return Object.keys(CoinDrivers)
}

function getDriver(coin) {
  const driver = CoinDrivers[coin]
  if (!driver)
    throw new MelisError("Unknown coin: " + coin)
  return driver
}

CM.prototype.getDefaultPlatformCoin = function (coin) {
  return this.isProdNet() ? C.COIN_PROD_BTC : C.COIN_TEST_BTC
}

CM.prototype.getCoinDriver = function (coin) {
  return getDriver(coin)
}

CM.prototype.decodeCoinAddress = function (coin, address) {
  return getDriver(coin).decodeCoinAddress(address)
}

CM.prototype.hashForSignature = function (coin, tx, index, redeemScript, amount, hashFlags) {
  return getDriver(coin).hashForSignature(tx, index, redeemScript, amount, hashFlags)
}

CM.prototype.isValidAddress = function (coin, address) {
  return getDriver(coin).isValidAddress(address)
}

CM.prototype.toScriptSignature = function (coin, signature, hashFlags) {
  return getDriver(coin).toScriptSignature(signature, hashFlags)
}

CM.prototype.toOutputScript = function (coin, address) {
  return getDriver(coin).toOutputScript(address)
}

CM.prototype.wifToEcPair = function (coin, wif) {
  return getDriver(coin).wifToEcPair(wif)
}

CM.prototype.signMessageWithKP = function (coin, keyPair, message) {
  return getDriver(coin).signMessageWithKP(keyPair, message)
}

CM.prototype.verifyMessageSignature = function (coin, address, signature, message) {
  return getDriver(coin).verifyMessageSignature(address, signature, message)
}

CM.prototype.signMessageWithAA = function (account, aa, message) {
  if (account.type !== C.TYPE_PLAIN_HD)
    throw new MelisError('CmBadParamException', 'Only single signature accounts can sign messages')
  const key = this.deriveAddressKey(account.num, aa.chain, aa.hdindex)
  return this.signMessageWithKP(account.coin, key.keyPair, message)
}

CM.prototype.buildAddressFromScript = function (coin, script) {
  return getDriver(coin).buildAddressFromScript(script)
}

CM.prototype.pubkeyToAddress = function (coin, key) {
  return getDriver(coin).pubkeyToAddress(key)
}

CM.prototype.prepareAddressSignature = function (coin, keyPair, prefix) {
  return getDriver(coin).prepareAddressSignature(keyPair, prefix)
}

CM.prototype.extractPubKeyFromOutputScript = function (coin, script) {
  return getDriver(coin).extractPubKeyFromOutputScript(script)
}

CM.prototype.calcP2SH = function (coin, accountInfo, chain, hdIndex) {
  return getDriver(coin).calcP2SH(accountInfo, chain, hdIndex)
}

CM.prototype.derivePubKeys = function (coin, xpubs, chain, hdIndex) {
  return getDriver(coin).derivePubKeys(xpubs, chain, hdIndex)
}

CM.prototype.hdNodeFromHexSeed = function (seed, coin) {
  if (!coin)
    coin = this.getDefaultPlatformCoin()
  return getDriver(coin).hdNodeFromHexSeed(seed)
}

CM.prototype.hdNodeFromBase58 = function (xpub, coin) {
  if (!coin)
    coin = this.getDefaultPlatformCoin()
  return getDriver(coin).hdNodeFromBase58(xpub)
}

CM.prototype.hdNodeToBase58Xpub = function (hd, coin) {
  if (!coin)
    coin = this.getDefaultPlatformCoin()
  return getDriver(coin).hdNodeToBase58Xpub(hd)
}

CM.prototype.exportAccountMasterKeyToBase58 = function (account) {
  const hd = this.peekAccountMasterKey(account)
  return getDriver(account.coin).hdNodeToExtendedBase58(hd)
}

CM.prototype.updateNetworkFees = function (coin) {
  var self = this
  if (!self.feeInfos)
    self.feeInfos = {}
  if (self.feeInfos[coin] && self.feeInfos[coin].lastUpdated) {
    const msToLastUpdate = new Date() - self.feeInfos[coin].lastUpdated
    if (msToLastUpdate > 1000 * 60 * 15)  // Update fees not more than once every 15 minutes
      return self.feeInfos[coin]
  }
  const provider = coin.endsWith(C.COIN_PROD_BTC) ? 'melis' : 'hardcoded'
  return self.feeApi.getFeesByProvider(coin, provider)().then(res => {
    return self.feeInfos[coin] = res
  })
}

CM.prototype.setAutoReconnectDelay = function (seconds) {
  if (seconds >= 0)
    this.autoReconnectDelay = seconds
  else
    this.autoReconnectDelay = 0
}

CM.prototype.randomBytes = function (n) {
  return randomBytes(n)
}

CM.prototype.randomHexBytes = function (n) {
  return this.randomBytes(n).toString('hex')
}

CM.prototype.random32HexBytes = function () {
  return this.randomHexBytes(32)
}

CM.prototype.isConnected = function () {
  return this.connected
}

CM.prototype.isReady = function () {
  return !(!this.cmConfiguration)
}

CM.prototype.parseBIP32Path = function (path, radix) {
  if (!radix)
    radix = 10
  if (path.indexOf("m/") === 0)
    path = path.substring(2)
  var result = []
  var pathElems = path.split("/")
  for (var i = 0; i < pathElems.length; i++) {
    var hardened = false
    var val = pathElems[i]
    if (val.charAt(val.length - 1) === '\'') {
      hardened = true
      val = val.substring(0, val.length - 1)
    }
    val = parseInt(val, radix)
    if (val >= 0x80000000)
      throwBadParamEx('path', "Invalid path element: " + val)
    result.push((hardened ? (0x80000000) | val : val) >>> 0)
  }
  return result
}

CM.prototype.getLoginPath = function () {
  const product = 31337 // CM
  const path = this.isProdNet() ? 0 : 1 // Use another path for I2P/TOR?
  return [
    ((0x80000000) | product) >>> 0,
    ((0x80000000) | path) >>> 0
  ]
}

CM.prototype.deriveKeyFromPath = function (hdnode, path) {
  if (!path || path.length === 0)
    return hdnode
  let key = hdnode
  for (let i = 0; i < path.length; i++) {
    const index = path[i]
    if (index & 0x80000000) {
      const v = index & 0x7FFFFFFF
      key = key.deriveHardened(v)
    } else {
      key = key.derive(index)
    }
  }
  return key
}

// BIP44 standard derivation
CM.prototype.deriveAccountHdKey = function (hd, accountNum, coin) {
  const subTree = this.isProdNet() ? 0 : 1
  let key = hd.deriveHardened(44)
  key = key.deriveHardened(subTree)
  key = key.deriveHardened(accountNum)
  if (coin)
    getDriver(coin).fixKeyNetworkParameters(key)
  return key
}

CM.prototype.deriveChainIndex = function (accountKey, chain, index) {
  return accountKey.derive(chain).derive(index)
}

CM.prototype.deriveAddressKey = function (accountNum, chain, index) {
  const accountHd = this.walletData.keys[accountNum]
  return accountHd.derive(chain).derive(index)
}

CM.prototype.peekAccountMasterKey = function (account) {
  return this.walletData.keys[account.num]
}

CM.prototype.exportAddressKeyToWIF = function (account, aa) {
  const key = this.deriveAddressKey(account.num, aa.chain, aa.hdindex)
  return key.keyPair.toWIF()
}

CM.prototype.rpc = function (queue, data, headers, numRetries) {
  logger.log("[RPC] q: " + queue + (headers ? " h: " + JSON.stringify(headers) : " no headers") + (data ? " data: " + JSON.stringify(data) : " no data"))
  if (!this.connected)
    return Q.reject(buildConnectionFailureEx("RPC call without connection"))
  if (!queue)
    return Q.reject(buildBadParamEx('queue', "RPC call without defined queue"))
  var deferred = Q.defer()
  this.rpcCounter++
  if (Object.keys(this.waitingReplies).length === 0) {
    emitEvent(this, C.EVENT_RPC_ACTIVITY_START)
  }
  this.pendingRPC++
  var rpcCounter = this.rpcCounter
  this.waitingReplies[rpcCounter] = {
    deferred: deferred,
    queue: queue,
    headers: headers,
    data: data,
    numRetries: numRetries || 1
  }
  // logger.log("[STOMP] queue: " + queue + " data: " + JSON.stringify(data) + " typeof(data): " + typeof data)
  if (!headers)
    headers = {}
  headers.id = rpcCounter
  if (data !== undefined && data !== null)
    this.stompClient.send(queue, typeof data === "object" ? JSON.stringify(data) : data, headers)
  else
    this.stompClient.send(queue, "{}", headers)
  var self = this
  return deferred.promise.timeout(this.rpcTimeout).catch(function (err) {
    logger.log("[RPC] Ex or Timeout -- res: ", err)
    var ex
    if (err.code && err.code === 'ETIMEDOUT') {
      ex = new MelisError('RpcTimeoutException', 'RPC call timeout after ' + self.rpcTimeout + 'ms')
      //ex = {ex: "rpcTimeout", msg: 'RPC call timeout after ' + self.rpcTimeout + 'ms'}
      delete self.waitingReplies[rpcCounter]
    } else
      ex = buildMelisErrorFromServerEx(err)
    return Q.reject(ex)
  }).finally(function () {
    if (Object.keys(self.waitingReplies).length === 0) {
      emitEvent(self, C.EVENT_RPC_ACTIVITY_END)
    }
  })
}

CM.prototype.simpleRpcSlice = function (queue, data) {
  return this.rpc(queue, data).then(res => {
    return res.slice
  })
}

// Fetch the STOMP endpoint from the melis discover server
function fetchStompEndpoint(self) {
  var discoveryUrl = self.apiDiscoveryUrl
  logger.log("Discovering STOMP endpoint using: ", discoveryUrl)
  return fetch(discoveryUrl, {
    headers: { "user-agent": "melis-js-api/" + C.CLIENT_API_VERSION }
  }).then(function (res) {
    if (res.status !== 200)
      throw new MelisError('DiscoveryEx', 'Bad status code: ' + res.status)
    return res.json()
  }).then(function (discovered) {
    logger.log("Discovery result: ", discovered)
    self.apiUrls = discovered
    if (discovered.publicUrlPrefix || discovered.stompEndpoint)
      return discovered
    throw new MelisError('DiscoveryEx', 'Missing discovery data from ' + discoveryUrl)
  }).catch(function (res) {
    if (res.ex === "DiscoveryEx")
      throw res
    var stringMsg = "" + res
    if (stringMsg.includes("SyntaxError: Unexpected token"))
      throw new MelisError('DiscoveryEx', 'Unable to discover stompEndpoint from ' + discoveryUrl)
    else
      throw new MelisError('DiscoveryEx', stringMsg)
  })
}

function enableKeepAliveFunc(self) {
  logger.log("[enableKeepAliveFunc] self.keepAliveFunc: " + self.keepAliveFunc)
  if (self.disableKeepAlive || self.keepAliveFunc)
    return
  self.keepAliveFunc = setInterval(function () {
    keepAliveFunction(self)
  }, (self.maxKeepAliveSeconds / 2 + 1) * 1000)
}

function disableKeepAliveFunc(self) {
  logger.log("[disableKeepAliveFunc] self.keepAliveFunc: " + self.keepAliveFunc)
  if (self.keepAliveFunc) {
    clearInterval(self.keepAliveFunc)
    self.keepAliveFunc = null
  }
}

function disableAutoReconnect(self) {
  if (self.autoReconnectFunc) {
    clearTimeout(self.autoReconnectFunc)
    self.autoReconnectFunc = null
  }
}

function stompDisconnected(self, frame, deferred) {
  var wasConnected = self.connected
  var wasPaused = self.paused
  logger.log("[CM] stompDisconnected wasConnected: " + wasConnected + " wasPaused: " + wasPaused)// + " err.code: " + frame.code + " err.wasClean: " + frame.wasClean)
  self.stompClient = null
  self.connected = false
  self.connecting = false
  self.paused = false
  self.cmConfiguration = null
  disableKeepAliveFunc(self)
  if (deferred)
    deferred.reject(frame)

  //logger.log("Open requests: ", Object.keys(self.waitingReplies))
  Object.keys(self.waitingReplies).forEach(function (i) {
    var rpcData = self.waitingReplies[i]
    delete self.waitingReplies[i]
    logger.log('[CM] Cancelling open rpc request:', rpcData)
    rpcData.deferred.reject(buildConnectionFailureEx("Disconnected"))
  })
  self.waitinReplies = {}
  emitEvent(self, C.EVENT_DISCONNECT)

  if (wasPaused || !wasConnected)
    return

  if (self.autoReconnectDelay > 0 && self.autoReconnectFunc === null) {
    var timeout = 10 + Math.random() * 10 + Math.random() * (self.autoReconnectDelay / 10)
    logger.log("[CM] NEXT AUTO RECONNECT in " + timeout + " seconds")
    self.autoReconnectFunc = setTimeout(function () {
      self.autoReconnectFunc = null
      self.connect(self.lastConfig)
    }, timeout * 1000)
  }
}

function retryConnect(self, config, errorMessage) {
  logger.log(errorMessage)
  if (self.autoReconnectDelay > 0) {
    var timeout = 10 + Math.random() * 10 + Math.random() * (self.autoReconnectDelay / 10)
    logger.log("[CM] retryConnect in " + timeout + " seconds")
    return Q.delay(timeout * 1000).then(function () {
      self.connecting = false
      return self.connect(config)
    })
  } else
    throwConnectionEx(errorMessage)
}

CM.prototype.connect = function (config) {
  const self = this
  if (this.connecting)
    return Q()
  this.paused = false
  this.connecting = true
  if (this.autoReconnectFunc) {
    clearTimeout(this.autoReconnectFunc)
    this.autoReconnectFunc = null
  }

  if (this.stompClient !== null) {
    if (this.connected)
      return Q(self.cmConfiguration)
    this.stompClient.disconnect()
    this.stompClient = null
  }

  const discoverer = self.stompEndpoint ?
    Q(self.stompEndpoint) :
    Q(fetchStompEndpoint(self, config)).then(function (discovered) {
      return discovered.stompEndpoint
    })
  return discoverer.then(stompEndpoint => {
    return self.connect_internal(stompEndpoint, config)
  }).catch(err => {
    logger.log("Discover err:", err)
    const errMsg = 'Unable to connect: ' + err.ex + " : " + err.msg
    const callback = config ? config.connectProgressCallback : null
    if (callback && typeof callback === 'function')
      callback({ errMsg: errMsg, err: err })
    if (config && config.autoRetry)
      return retryConnect(self, config, errMsg)
    else {
      self.connecting = false
      return Q.reject(err)
    }
  })
}

CM.prototype.connect_internal = function (stompEndpoint, config) {
  const self = this
  const deferred = Q.defer()
  const options = { debug: false, heartbeat: false, protocols: ['v12.stomp'] }
  if ((/^wss?:\/\//).test(stompEndpoint)) {
    if (isNode) {
      logger.log("[STOMP] Opening websocket (node):", stompEndpoint)
      const ws = new WebSocketClient(stompEndpoint)
      ws.on('error', function (error) {
        logger.log('[connect_internal] CONNECT ERROR:' + error.code)
        deferred.reject(error)
      })
      this.stompClient = Stomp.over(ws, options)
    } else {
      logger.log("[STOMP] Opening websocket (browser) to " + stompEndpoint + " options:", options)
      this.stompClient = Stomp.client(stompEndpoint, options)
    }
  } else {
    logger.log("[STOMP] Opening sockjs:", stompEndpoint)
    this.stompClient = Stomp.over(new SockJS(stompEndpoint), options)
  }

  this.stompClient.debug = function (str) {
    //logger.log(str)
  }
  var headers = {}
  if (config && config.userAgent)
    headers.userAgent = JSON.stringify(config.userAgent)
  if (config && config.locale)
    headers.locale = config.locale
  if (config && config.currency)
    headers.currency = config.currency
  this.lastConfig = config

  this.stompClient.connect(headers, function (frame) {
    logger.log("[CM] Connected to websocket: " + frame)
    self.connected = true
    self.connecting = false
    self.paused = false

    self.stompClient.subscribe(C.QUEUE_RPC_REPLY, function (message) {
      rpcReplyHandler(self, message)
    })

    self.stompClient.subscribe(C.QUEUE_RPC_ERROR, function (message) {
      rpcErrorHandler(self, message)
    })

    self.stompClient.subscribe(C.QUEUE_SERVER_EVENTS, function (message) {
      //logger.log("[CM] Server event: " + message.body)
      var msg = JSON.parse(message.body)
      emitEvent(self, msg.type, msg.params)
    })

    self.stompClient.subscribe(C.QUEUE_PUBLIC_MSGS, function (message) {
      var msg = JSON.parse(message.body)
      if (msg.type && msg.type === C.EVENT_PING)
        emitEvent(self, C.EVENT_PING, msg)
      else
        emitEvent(self, C.EVENT_PUBLIC_MESSAGE, msg)
    })

    self.stompClient.subscribe(C.QUEUE_BLOCKS, function (message) {
      const msg = JSON.parse(message.body)
      self.lastBlocks[msg.coin] = msg
      emitEvent(self, C.EVENT_BLOCK, msg)
    })

    self.stompClient.subscribe(C.QUEUE_CONFIG, function (message) {
      var initialEvents = JSON.parse(message.body)
      for (var i = 0; i < initialEvents.length; i++) {
        var event = initialEvents[i]
        emitEvent(self, event.type, event.params)
      }
      if (self.lastOpenParams) {
        if (self.lastOpenParams.accountExtendedKey) {
          self.accountOpen(self.lastOpenParams.accountExtendedKey, self.lastOpenParams).then(wallet => {
            emitEvent(self, C.EVENT_SESSION_RESTORED, wallet)
          })
        } else if (self.lastOpenParams.seed) {
          self.walletOpen(self.lastOpenParams.seed, self.lastOpenParams).then(wallet => {
            emitEvent(self, C.EVENT_SESSION_RESTORED, wallet)
          })
        }
      }
      if (self.cmConfiguration.maxKeepAliveSeconds && self.cmConfiguration.maxKeepAliveSeconds < self.maxKeepAliveSeconds)
        self.maxKeepAliveSeconds = self.cmConfiguration.maxKeepAliveSeconds
      enableKeepAliveFunc(self)
      emitEvent(self, C.EVENT_CONNECT)
      deferred.resolve(self.cmConfiguration)
    })

  }, function (frame) {
    stompDisconnected(self, frame, deferred)
  })
  return deferred.promise
}

CM.prototype.disconnect = function () {
  const self = this
  disableKeepAliveFunc(self)
  disableAutoReconnect(self)
  if (!this.connected)
    return Q()
  var deferred = Q.defer()
  this.stompClient.disconnect(res => {
    logger.log("[CM] STOMP Client disconnect: " + res)
    this.stompClient = null
    initializePrivateFields(self)
    deferred.resolve(res)
  })
  return deferred.promise
}

CM.prototype.networkOnline = function () {
  if (this.autoReconnectDelay > 0)
    return this.connect()
  else
    return Q()
}

CM.prototype.networkOffline = function () {
  disableKeepAliveFunc(this)
  this.paused = true
  return handleConnectionLoss(this)
}

CM.prototype.hintDevicePaused = function () {
  disableKeepAliveFunc(this)
  this.paused = true
  if (this.connected)
    this.sessionSetParams({ paused: true })
  return Q()
}

CM.prototype.verifyConnectionEstablished = function (timeout) {
  var self = this
  this.paused = false
  if (!timeout || timeout < 0)
    timeout = 5
  if (timeout > this.maxKeepAliveSeconds)
    timeout = this.maxKeepAliveSeconds
  logger.log("[verifyConnectionEstablished] connected: " + this.connected + " timeout: " + timeout + " stompClient: " + (this.stompClient ? "yes" : "no"))
  if (!this.stompClient)
    return Q()
  if (!this.connected)
    return this.connect()
  return this.ping().timeout(timeout * 1000).catch(function (err) {
    logger.log("[verifyConnectionEstablished] ping timeout after " + timeout + " seconds")
    return handleConnectionLoss(self)
  }).then(function () {
    enableKeepAliveFunc(self)
  })
}

CM.prototype.subscribe = function (queue, callback, headers) {
  if (!queue || !callback)
    throwBadParamEx('queue', "Call to subscribe without defined queue or callback")
  var self = this
  return this.stompClient.subscribe(queue, function (res) {
    // logger.log("[CM] message to queue " + queue + " : ", res)
    var msg = JSON.parse(res.body)
    callback(msg)
  }, headers)
}

CM.prototype.subscribeToTickers = function (currency, callback) {
  if (!currency || !callback)
    throwBadParamEx('currency', "Missing currency or callback while subscribing to tickers")
  return this.subscribe(C.QUEUE_TICKERS_PREFIX + currency, callback)
}

CM.prototype.subscribeToTickersHistory = function (period, currency, callback) {
  if (!period || !currency || !callback)
    throwBadParamEx('currency', "Missing period, currency or callback while subscribing to history: " + currency)
  var path = C.QUEUE_TICKERS_HISTORY_PREFIX + period + "/" + currency
  return this.subscribe(path, callback)
}

//
// PUBLIC METHODS
//

CM.prototype.getPaymentAddressForAccount = function (accountIdOrAlias, param) {
  var opts = { name: accountIdOrAlias }
  if (param) {
    if (param.memo)
      opts.data = param.memo
    if (param.address)
      opts.address = param.address
  }
  return this.rpc(C.GET_PAYMENT_ADDRESS, opts).then(function (res) {
    //logger.log("[CM] getPaymentAddress: ", res)
    return res.address
  })
}

CM.prototype.accountGetPublicInfo = function (params) {
  return this.rpc(C.GET_ACCOUNT_PUBLIC_INFO, { name: params.name, code: params.code }).then(function (res) {
    //logger.log("[CM] accountGetPublicInfo: " + JSON.stringify(res))
    return res.account
  })
}

CM.prototype.getLoginChallenge = function () {
  return this.rpc(C.GET_CHALLENGE)
}

//
// UTILITIES
//

CM.prototype.decodeTxFromBuffer = function (buf) {
  return Bitcoin.Transaction.fromBuffer(buf)
}

CM.prototype.pushTx = function (coin, hex) {
  return this.rpc(C.UTILS_PUSH_TX, { coin, hex })
}

CM.prototype.getFeeInfo = function (coin) {
  return this.rpc(C.UTILS_FEE_INFO + "/" + coin)
}

CM.prototype.ping = function () {
  return this.rpc(C.UTILS_PING)
}

CM.prototype.logException = function (account, data, deviceId, agent) {
  return this.rpc(C.UTILS_LOG_EX, {
    pubId: account ? account.pubId : null,
    data: data,
    deviceId: deviceId,
    ua: typeof agent === "object" ? agent : { application: agent }
  })
}

CM.prototype.logData = function (account, data, deviceId, agent) {
  return this.rpc(C.UTILS_LOG_DATA, {
    pubId: account.pubId,
    data: data,
    deviceId: deviceId,
    ua: typeof agent === "object" ? agent : { application: agent }
  })
}

CM.prototype.deviceSetPassword = function (deviceName, pin) {
  if (!deviceName || !pin)
    return failPromiseWithBadParam(deviceName ? "pin" : "deviceName", "missing deviceName or pin")
  var self = this
  return this.rpc(C.WALLET_DEVICE_SET_PASSWORD, {
    deviceName: deviceName,
    userPin: pin
  }).then(function (res) {
    // The result is base64 encoded
    logger.log("[CM] setDeviceName:", res)
    return { deviceId: res.info }
  })
}

CM.prototype.deviceGetPassword = function (deviceId, pin) {
  if (!deviceId || !pin)
    return failPromiseWithBadParam(deviceId ? "pin" : "deviceId", "missing deviceId or pin")
  var self = this
  return this.rpc(C.WALLET_DEVICE_GET_PASSWORD, {
    deviceId: deviceId,
    userPin: pin
  }).then(function (res) {
    logger.log("[CM] getDevicePassword:", res)
    return res.info
  })
}

CM.prototype.deviceUpdate = function (deviceId, newName) {
  if (!deviceId || !newName)
    return failPromiseWithBadParam("deviceId|newName", "missing deviceId or newName")
  var self = this
  return this.rpc(C.WALLET_DEVICE_UPDATE, {
    deviceId: deviceId,
    deviceName: newName
  }).then(function (res) {
    return res.info
  })
}

CM.prototype.deviceChangePin = function (deviceId, oldPin, newPin) {
  if (!deviceId || !oldPin || !newPin)
    return failPromiseWithBadParam("deviceId|oldPin|newPin", "missing deviceId, newPin or oldPin")
  var self = this
  return this.rpc(C.WALLET_DEVICE_CHANGE_PIN, {
    deviceId: deviceId,
    userPin: oldPin,
    newPin: newPin
  }).then(function (res) {
    return res.info
  })
}

CM.prototype.devicePromoteToPrimary = function (deviceId, tfa) {
  if (!deviceId)
    return failPromiseWithBadParam("deviceId", "missing deviceId")
  return this.rpc(C.WALLET_DEVICE_PROMOTE_TO_PRIMARY, {
    deviceId: deviceId,
    tfa: tfa
  })
}

CM.prototype.deviceCancelPromotion = function (tfa) {
  return this.rpc(C.WALLET_DEVICE_CANCEL_PROMOTION, { tfa })
}

CM.prototype.deviceGetRecoveryHours = function () {
  return this.rpc(C.WALLET_DEVICE_GET_RECOVERY_HOURS)
}

CM.prototype.deviceSetRecoveryHours = function (hours, tfa) {
  return this.rpc(C.WALLET_DEVICE_SET_RECOVERY_HOURS, {
    data: hours, tfa: tfa
  })
}

CM.prototype.devicesGet = function () {
  return this.simpleRpcSlice(C.WALLET_DEVICES_GET)
}

CM.prototype.devicesDelete = function (param) {
  var data = {}
  if (param instanceof Array)
    data.deviceIds = param
  else
    data.deviceId = param
  return this.rpc(C.WALLET_DEVICES_DELETE, data)
}

CM.prototype.devicesDeleteAll = function (deviceId) {
  var data = {}
  if (deviceId)
    data.deviceId = deviceId
  return this.rpc(C.WALLET_DEVICES_DELETE_ALL, data)
}

//
// WALLET functions
//

CM.prototype.walletLogin = function (seed, params) {
  throw ('todo')
}

CM.prototype.walletOpen = function (seed, params) {
  const self = this
  if (!params)
    params = {}
  return this.getLoginChallenge().then(res => {
    //logger.log("[CM] walletOpen challenge: " + challengeHex + " seed: " + seed + " isProduction:"+self.isProdNet())
    const hd = self.hdNodeFromHexSeed(seed)
    // Keep the public key for ourselves
    const loginId = self.deriveKeyFromPath(hd, self.getLoginPath())
    const chainCode = Buffer.alloc(32, "42", 'hex')
    const loginHD = new Bitcoin.HDNode(loginId.keyPair, chainCode)
    const loginPath = [simpleRandomInt(C.MAX_SUBPATH), simpleRandomInt(C.MAX_SUBPATH)]
    const loginKey = self.deriveKeyFromPath(loginHD, loginPath)
    const signature = loginKey.sign(Buffer.from(res.challenge, 'hex'))
    //logger.log("child: " + child.getPublicKeyBuffer().toString('hex')() + " sig: " + signature)
    //logger.log("pubKey: " + masterPubKey + " r: " + signature.r.toString() + " s: " + signature.s.toString())
    return self.rpc(C.WALLET_OPEN, {
      id: loginId.getPublicKeyBuffer().toString('hex'),
      loginPath,
      signatureR: signature.r.toString(), signatureS: signature.s.toString(),
      sessionName: params.sessionName,
      deviceId: params.deviceId,
      usePinAsTfa: params.usePinAsTfa,
      supportedCoins: getSupportedCoins()
    }).then(res => {
      const wallet = res.wallet
      logger.log("[CM] walletOpen pubKey:" + wallet.pubKey + self.isProdNet() + " #accounts: " + Object.keys(wallet.accounts).length + " isProdNet: ")
      walletOpen(self, hd, wallet)
      self.lastOpenParams = { seed: seed, sessionName: params.sessionName, deviceId: params.deviceId }
      return wallet
    })
  })
}

CM.prototype.accountOpen = function (extendedKey, params) {
  const self = this
  if (!params)
    params = {}
  const accountHd = self.hdNodeFromBase58(extendedKey, params.coin)
  return this.getLoginChallenge().then(res => {
    const loginPath = [simpleRandomInt(C.MAX_SUBPATH), simpleRandomInt(C.MAX_SUBPATH)]
    const loginKey = self.deriveKeyFromPath(accountHd, loginPath)
    const challenge = Buffer.from(res.challenge, 'hex')
    const signature = loginKey.sign(challenge)
    //logger.log("child: " + child.getPublicKeyBuffer().toString('hex')() + " sig: " + signature)
    //logger.log("pubKey: " + masterPubKey + " r: " + signature.r.toString() + " s: " + signature.s.toString())
    return self.rpc(C.ACCOUNT_OPEN, {
      coin: params.coin,
      xpub: self.hdNodeToBase58Xpub(accountHd),
      loginPath,
      signatureR: signature.r.toString(), signatureS: signature.s.toString(),
      sessionName: params.sessionName,
      deviceId: params.deviceId,
      usePinAsTfa: params.usePinAsTfa
    }).then(res => {
      const wallet = res.wallet
      const accountData = res.accountData
      logger.log("[CM] accountOpen isProdNet: " + self.isProdNet + " wallet: ", wallet)
      wallet.accounts = [accountData.account]
      wallet.balances = [accountData.balance]
      wallet.accountInfos = [accountData.accountInfo]
      walletOpen(self, accountHd, wallet, true)
      self.lastOpenParams = { accountExtendedKey: extendedKey, sessionName: params.sessionName, deviceId: params.deviceId }
      return res
    })
  })
}

CM.prototype.walletRegister = function (seed, params) {
  var self = this
  if (!params)
    params = {}
  var loginKey
  var self = this
  try {
    //var hd = self.hdNodeFromHexSeed(self.isProdNet() ? C.COIN_PROD_BTC : C.COIN_TEST_BTC, seed)
    var hd = self.hdNodeFromHexSeed(seed)
    loginKey = self.deriveKeyFromPath(hd, self.getLoginPath())
    //logger.log('REGISTER hd: ', hd, ' loginKey: ', loginKey)
  } catch (error) {
    var ex = { ex: "clientAssertFailure", msg: error.message }
    logger.log(ex)
    return Q.reject(ex)
  }
  return self.rpc(C.WALLET_REGISTER, {
    xpub: self.hdNodeToBase58Xpub(loginKey),
    sessionName: params.sessionName,
    deviceId: params.deviceId,
    usePinAsTfa: params.usePinAsTfa,
    supportedCoins: getSupportedCoins()
  }).then(res => {
    logger.log("[CM] walletRegister: ", res)
    walletOpen(self, hd, res.wallet)
    self.lastOpenParams = { seed: seed, sessionName: params.sessionName, deviceId: params.deviceId }
    return res.wallet
  })
}

CM.prototype.walletClose = function () {
  const self = this
  return self.rpc(C.WALLET_CLOSE).then(function (res) {
    walletClose(self)
    return res
  })
}

CM.prototype.accountsGet = function (pagingInfo) {
  const pars = addPagingInfo({}, pagingInfo)
  return this.simpleRpcSlice(C.WALLET_ACCOUNTS_GET, pars)
}

CM.prototype.walletGetNumSessions = function () {
  return this.rpc(C.WALLET_GET_NUM_SESSIONS).then(function (res) {
    //console.log("[CM] number of sessions with wallet open: " + JSON.stringify(res))
    return res.numWalletSessions
  })
}

CM.prototype.walletGetNotifications = function (fromDate, pagingInfo) {
  const pars = addPagingInfo({ fromDate: fromDate }, pagingInfo)
  return this.simpleRpcSlice(C.WALLET_GET_NOTIFICATIONS, pars)
}

CM.prototype.walletGetAccountsStatus = async function (pubIds, fromDate, pagingInfo) {
  if (!pubIds || pubIds.length == 0)
    return failPromiseWithBadParam("pubIds", "missing pubIds")
  const pars = addPagingInfo({ pubIds, fromDate }, pagingInfo)
  const res = await this.rpc(C.WALLET_GET_ACCOUNTS_STATUS, pars)
  return res.accounts
}

CM.prototype.walletGetInfo = function () {
  var self = this
  return this.rpc(C.WALLET_GET_INFO).then(function (res) {
    logger.log("walletGetInfo:", res)
    updateWalletInfo(self, res.info)
    return res.info
  })
}

// Creates random account numbers
// in order to be unable to guess hidden account numbers
CM.prototype.getFreeAccountNum = function () {
  return this.rpc(C.WALLET_GET_FREE_ACCOUNT_NUM).then(function (res) {
    return res.accountNum // + simpleRandomInt(2)
  })
}

CM.prototype.addPushTokenGoogle = function (token) {
  return this.rpc(C.WALLET_PUSH_REGISTER_GOOGLE, { data: token })
}

CM.prototype.aliasGetInfo = function (account) {
  return this.rpc(C.ACCOUNT_ALIAS_INFO, { pubId: account.pubId })
}

CM.prototype.aliasIsAvailable = function (alias) {
  return this.rpc(C.ACCOUNT_ALIAS_AVAILABLE, { name: alias })
}

CM.prototype.aliasDefine = function (account, alias) {
  return this.rpc(C.ACCOUNT_ALIAS_DEFINE, { pubId: account.pubId, name: alias })
}

CM.prototype.walletMetaSet = function (name, value) {
  return this.rpc(C.WALLET_META_SET, { name: name, meta: value })
}

CM.prototype.walletMetaGet = function (param) {
  if (Array.isArray(param))
    return this.rpc(C.WALLET_META_GET, { names: param })
  else
    return this.rpc(C.WALLET_META_GET, { name: param }).then(function (res) {
      return res.meta
    })
}

CM.prototype.walletMetasGet = function (pagingInfo) {
  var pars = addPagingInfo({}, pagingInfo)
  return this.simpleRpcSlice(C.WALLET_METAS_GET, pars)
}

CM.prototype.walletMetaDelete = function (name) {
  return this.rpc(C.WALLET_META_DELETE, { name: name })
}

//
// Account functions
//

/*
 *  Parameters:
 *  type
 *  accountNum
 *  meta
 *  hidden
 *  cosigners
 *  minSignatures
 *  mandatorySignature
 */
CM.prototype.accountCreate = function (params) {
  if (!params || !params.type)
    throwBadParamEx('params', "Bad parameters")
  let numPromise
  if (params.accountNum === undefined)
    numPromise = this.getFreeAccountNum()
  else
    numPromise = Q(params.accountNum)
  const self = this
  return numPromise.then(accountNum => {
    logger.log("[CM] accountCreate coin: " + params.coin + " accountNum: " + params.accountNum)
    params.accountNum = accountNum
    const accountHd = self.deriveAccountHdKey(self.hdWallet, accountNum, params.coin)
    params.xpub = self.hdNodeToBase58Xpub(accountHd, params.coin)
    return self.rpc(C.ACCOUNT_REGISTER, params)
  }).then(res => {
    updateAccount(self, res, self.hdWallet)
    return res
  })
}

CM.prototype.accountJoin = function (params) {
  const self = this
  logger.log("[CM] joinWallet params:", params)
  var numPromise = Q(params.accountNum)
  if (params.accountNum === undefined)
    numPromise = self.getFreeAccountNum().then(num => {
      params.accountNum = num
    })

  var coinPromise = Q(params.coin)
  if (!params.coin)
    coinPromise = this.joinCodeGetInfo(params.code).then(res => {
      params.coin = res.info.coin
    })

  return numPromise.then(coinPromise).then(() => {
    logger.log("[CM] joinWallet coin: " + params.coin + " accountNum: " + params.accountNum)
    const accountHd = self.deriveAccountHdKey(self.hdWallet, params.accountNum, params.coin)
    return self.rpc(C.ACCOUNT_JOIN, {
      code: params.code,
      accountNum: params.accountNum,
      xpub: self.hdNodeToBase58Xpub(accountHd, params.coin),
      meta: params.meta
    })
  }).then(res => {
    updateAccount(self, res, self.hdWallet)
    return res
  })
}

CM.prototype.accountRefresh = function (account) {
  var self = this
  return this.rpc(C.ACCOUNT_REFRESH, {
    pubId: account.pubId
  }).then(res => {
    if (res.account && res.balance && res.accountInfo)
      updateAccount(self, res)
    return res
  })
}

CM.prototype.accountUpdate = function (account, options) {
  if (!options || typeof options !== 'object')
    return
  logger.log("[accountUpdate] " + account.pubId + " :", options)
  var self = this
  return this.rpc(C.ACCOUNT_UPDATE, {
    pubId: account.pubId,
    hidden: options.hidden,
    meta: options.meta,
    tfa: options.tfa,
    pubMeta: options.pubMeta
  }).then(res => {
    updateAccount(self, res)
    return res
  })
}

CM.prototype.accountDelete = function (account) {
  const self = this
  return this.rpc(C.ACCOUNT_DELETE, { pubId: account.pubId }).then(res => {
    delete self.walletData.accounts[account.pubId]
    delete self.walletData.balances[account.pubId]
    delete self.walletData.infos[account.pubId]
    return res
  })
}

CM.prototype.joinCodeGetInfo = function (code) {
  return this.rpc(C.ACCOUNT_GET_JOIN_CODE_INFO, { code: code })
}

CM.prototype.getLocktimeDays = function (account) {
  return this.rpc(C.ACCOUNT_GET_LOCKTIME_DAYS, {
    pubId: account.pubId
  })
}

CM.prototype.setLocktimeDays = function (account, days, tfa) {
  return this.rpc(C.ACCOUNT_SET_LOCKTIME_DAYS, {
    pubId: account.pubId, data: days, tfa: tfa
  })
}

CM.prototype.getRecoveryInfo = function (account, fromDate) {
  return this.rpc(C.ACCOUNT_GET_RECOVERY_INFO, {
    pubId: account.pubId,
    fromDate: fromDate
  })
}

CM.prototype.getUnusedAddress = function (account, address, labels, meta) {
  const self = this
  if (meta && Object.keys(meta).length === 0)
    meta = null
  if (labels && labels.length === 0)
    labels = null
  const promise = possiblyIncompleteAccountInfo(self.peekAccountInfo(account)) ?
    self.accountRefresh(account).then(res => res.account) : Q(account)
  return promise.then(account => {
    return this.rpc(C.ACCOUNT_GET_UNUSED_ADDRESS, {
      pubId: account.pubId,
      address: address,
      labels: labels,
      meta: meta
    })
  }).then(res => {
    const aa = res.address
    if (!self.isAddressOfAccount(account, aa))
      return failPromiseWithEx(buildInvalidAddressEx(aa.address, "Received address not matching account definition! addr:" + aa.address + " pubId: " + account.pubId))
    return aa
  })
}

CM.prototype.addressUpdate = function (account, address, labels, meta) {
  if (meta && Object.keys(meta).length === 0)
    meta = null
  if (labels && labels.length === 0)
    labels = null
  return this.rpc(C.ACCOUNT_ADDRESS_UPDATE, {
    pubId: account.pubId,
    address: address,
    labels: labels,
    meta: meta
  }).then(res => res.address)
}

CM.prototype.addressRelease = function (account, address) {
  return this.rpc(C.ACCOUNT_ADDRESS_RELEASE, {
    pubId: account.pubId,
    address: address
  }).then(res => res.address)
}

CM.prototype.addressGet = function (account, address, optionsAndPaging) {
  var pars = addPagingInfo({ pubId: account.pubId, address: address }, optionsAndPaging)
  if (optionsAndPaging && optionsAndPaging.includeTxInfos)
    pars.includeTxInfos = optionsAndPaging.includeTxInfos
  return this.rpc(C.ACCOUNT_ADDRESS_GET, pars)
}

CM.prototype.addressesGet = function (account, optionsAndPaging) {
  var pars = addPagingInfo({ pubId: account.pubId }, optionsAndPaging)
  if (optionsAndPaging && optionsAndPaging.onlyActives)
    pars.onlyActives = optionsAndPaging.onlyActives
  if (optionsAndPaging && optionsAndPaging.chain >= 0)
    pars.chain = optionsAndPaging.chain
  return this.simpleRpcSlice(C.ACCOUNT_ADDRESSES_GET, pars)
}

CM.prototype.addLegacyAddress = function (account, keyPair, params) {
  var data = this.prepareAddressSignature(account.coin, keyPair, C.MSG_PREFIX_LEGACY_ADDR)
  return this.rpc(C.WALLET_ADD_LEGACY_ADDRESS, {
    pubId: account.pubId,
    address: data.address,
    data: data.base64Sig,
    labels: params ? params.labels : null,
    meta: params ? params.meta : null
  })
}

CM.prototype.accountGetNotifications = function (account, fromDate, pagingInfo) {
  var pars = addPagingInfo({ pubId: account.pubId, fromDate: fromDate }, pagingInfo)
  return this.simpleRpcSlice(C.ACCOUNT_GET_NOTIFICATIONS, pars)
}

CM.prototype.txInfosGet = function (account, filter, pagingInfo) {
  if (!filter)
    filter = {}
  var pars = addPagingInfo({
    pubId: account.pubId,
    fromDate: filter.fromDate,
    txDate: filter.txDate,
    direction: filter.direction
  }, pagingInfo)
  return this.simpleRpcSlice(C.ACCOUNT_GET_TX_INFOS, pars)
}

CM.prototype.txInfoGet = function (id) {
  return this.rpc(C.ACCOUNT_GET_TX_INFO, {
    data: id
  }).then(function (res) {
    return res.txInfo
  })
}

CM.prototype.txInfoSet = function (id, labels, meta) {
  return this.rpc(C.ACCOUNT_SET_TX_INFO, {
    data: id,
    labels: labels,
    meta: meta
  }).then(function (res) {
    //console.log("[CM SET_TX_INFO] res: " + JSON.stringify(res))
    return res.txInfo
  })
}

CM.prototype.getAllLabels = function (account) {
  return this.rpc(C.ACCOUNT_GET_ALL_LABELS, { pubId: account ? account.pubId : null })
}

CM.prototype.ptxPrepare = function (account, recipients, options) {
  logger.log("[CM ptxPrepare] account: " + account.pubId + " to: " + JSON.stringify(recipients) + " opts: ", options)
  options = options || {}
  var params = {
    pubId: account.pubId,
    recipients: recipients,
    unspents: options.unspents,
    tfa: options.tfa,
    ptxOptions: {}
  }
  Object.keys(options)
    .filter(k => k !== 'autoSignIfValidated')
    .forEach(k => params.ptxOptions[k] = options[k])
  logger.log("[CM ptxPrepare] params:", params)
  return this.rpc(C.ACCOUNT_PTX_PREPARE, params)
}

CM.prototype.ptxFeeBump = function (id, options) {
  if (!options || !options.feeMultiplier)
    throwBadParamEx("options.feeMultiplier", "Missing feeMultiplier")
  var ptxOptions = { feeMultiplier: options.feeMultiplier }
  var params = { data: id, ptxOptions: ptxOptions }
  return this.rpc(C.ACCOUNT_PTX_FEE_BUMP, params)
}

CM.prototype.ptxGetById = function (id) {
  return this.rpc(C.ACCOUNT_PTX_GET, { data: id })
}

CM.prototype.ptxGetByHash = function (account, hash) {
  return this.rpc(C.ACCOUNT_PTX_GET, { pubId: account.pubId, hash: hash })
}

CM.prototype.ptxCancel = function (ptx) {
  return this.rpc(C.ACCOUNT_PTX_CANCEL, { data: ptx.id })
}

CM.prototype.ptxSignFields = function (account, ptx) {
  const num1 = simpleRandomInt(C.MAX_SUBPATH), num2 = simpleRandomInt(C.MAX_SUBPATH)
  const key = this.deriveAddressKey(account.num, num1, num2)
  var sig = this.signMessageWithKP(account.coin, key.keyPair, ptx.rawTx)
  return this.rpc(C.ACCOUNT_PTX_SIGN_FIELDS, {
    data: ptx.id,
    num1: num1,
    num2: num2,
    signatures: [sig]
  })
}

CM.prototype.ptxHasFieldsSignature = function (ptx) {
  if (!ptx.meta)
    return false
  var keyMessage = ptx.meta.ownerSig
  return !!(keyMessage && keyMessage.keyPath && keyMessage.ptxSig)
}

// TODO: add verification of cosigners public key
CM.prototype.ptxVerifyFieldsSignature = function (account, ptx) {
  const self = this
  return this.ensureAccountInfo(account).then(function (account) {
    if (!self.ptxHasFieldsSignature(ptx))
      throwInvalidSignatureEx("PTX owner signature missing")
    let xpub = account.xpub
    if (account.numCosigners > 0) {
      var cosignerData = self.peekAccountInfo(account).cosigners.find(function (cosigner) {
        return cosigner.pubId === ptx.accountPubId
      })
      if (!cosignerData)
        throwInvalidSignatureEx("PTX owner not found: " + ptx.accountPubId)
      xpub = cosignerData.xpub
    }
    const keyMessage = ptx.meta.ownerSig
    logger.log("ptx keyMessage:", keyMessage)
    const keyPath = keyMessage.keyPath
    const hd = self.hdNodeFromBase58(xpub, account.coin)
    const node = hd.derive(keyPath[0]).derive(keyPath[1])
    //var address = node.keyPair.getAddress()
    const address = self.pubkeyToAddress(account.coin, node.keyPair)
    var ptxSigVerified = false
    try {
      ptxSigVerified = self.verifyMessageSignature(account.coin, address, keyMessage.ptxSig, ptx.rawTx)
      logger.log("[CM] ptx#" + ptx.id + " address: " + address + " VERIFIED: " + ptxSigVerified)
    } catch (ex) {
      logger.log("verifyBitcoinMessageEx: ", ex)
    }
    if (!ptxSigVerified)
      throwInvalidSignatureEx("PTX owner signature invalid")
  })
}

CM.prototype.ptxsGet = function (account, filter, pagingInfo) {
  if (!filter)
    filter = {}
  var pars = addPagingInfo({
    pubId: account.pubId,
    fromDate: filter.fromDate,
    direction: filter.direction
  }, pagingInfo)
  return this.simpleRpcSlice(C.ACCOUNT_PTXS_GET, pars)
}

CM.prototype.signaturesPrepare = function (params) {
  params.accountKeys = this.walletData.keys
  return this._signaturesPrepare(params)
}

CM.prototype._signaturesPrepare = function (params) {
  const self = this
  const accountKeys = params.accountKeys
  const coin = params.coin
  const accountNum = params.accountNum
  const progressCallback = params.progressCallback
  const tx = this.decodeTxFromBuffer(Buffer.from(params.rawTx, 'hex'))
  const inputs = params.inputs
  const signatures = []
  const deferred = Q.defer()

  const signInput = function (i) {
    const inputInfo = inputs[i]
    logger.log("signInput #" + i + " account#: " + accountNum + " coin: " + coin + " intputInfo:", inputInfo)
    if (!inputInfo)
      throwUnexpectedEx("Internal error: can't find info data for tx input #" + i)
    if (!inputInfo.aa) {
      logger.log("Skipping input with missing AA info")
      return Promise.resolve()
    }
    const accountAddress = inputInfo.aa
    const accountKey = accountKeys[accountNum]
    const key = self.deriveChainIndex(accountKey, accountAddress.chain, accountAddress.hdindex)
    let redeemScript
    if (accountAddress.redeemScript)
      redeemScript = Buffer.from(accountAddress.redeemScript, "hex")
    else
      redeemScript = self.toOutputScript(coin, self.pubkeyToAddress(coin, key)) // o inputInfo.script
    const hashForSignature = self.hashForSignature(coin, tx, i, redeemScript, inputInfo.amount, Bitcoin.Transaction.SIGHASH_ALL)
    const signature = key.sign(hashForSignature)
    //logger.log("[signed input #" + i + "] redeemScript: " + redeemScript.buffer.toString('hex') +
    //        " hashForSignature: " + hashForSignature.toString('hex')) // + " sig: " + sig.toString('hex'))
    signatures.push({ key: key, sig: signature })
  }

  const f = function (i) {
    const progressInfo = { currStep: i, totalSteps: tx.ins.length }
    deferred.notify(progressInfo)
    var promise = null
    if (progressCallback)
      promise = progressCallback(progressInfo)
    if (!promise || !promise.then || typeof promise.then !== 'function')
      promise = Q()
    promise.then(function () {
      signInput(i)
      if (i === tx.ins.length - 1)
        deferred.resolve(signatures)
      else
        f(i + 1)
    })
  }

  process.nextTick(function () {
    f(0)
  })
  return deferred.promise
}

CM.prototype.signaturesSubmit = function (state, signatures, tfa) {
  var account = state.account
  var txId = state.ptx.id
  var self = this
  logger.log("[CM signaturesSubmit] sigs: " + signatures + " txId: " + txId + " account: ", account)
  return this.rpc(C.ACCOUNT_SUBMIT_SIGNATURES, {
    pubId: account.pubId,
    data: txId,
    signatures: signatures,
    tfa: tfa
  }).then(function (res) {
    return res.hash
  })
}

CM.prototype.areAddressesOfAccount = function (account, addresses) {
  for (let i = 0; i < addresses.length; i++)
    if (!this.isAddressOfAccount(account, addresses[i].aa))
      return false
  return true
}

CM.prototype.isAddressOfAccount = function (account, accountAddress) {
  if (!accountAddress)
    return false
  let addr
  switch (account.type) {
    case C.TYPE_PLAIN_HD:
      const key = this.deriveAddressKey(account.num, accountAddress.chain, accountAddress.hdindex)
      //addr = key.getAddress()
      addr = this.pubkeyToAddress(account.coin, key)
      break
    default:
      const info = this.peekAccountInfo(account)
      addr = this.calcP2SH(account.coin, info, accountAddress.chain, accountAddress.hdindex)
  }
  logger.log("[isAddressesOfAccount] type: " + account.type + " accountAddress: " + accountAddress.address + " calcAddr: " + addr)
  let decodedAa, decodedAddr
  try {
    decodedAa = this.decodeCoinAddress(account.coin, accountAddress.address)
    decodedAddr = this.decodeCoinAddress(account.coin, addr)
  } catch (err) {
    return false
  }
  logger.log("[isAddressesOfAccount] addr.version: " + decodedAddr.version + " decodedAa.version: " + decodedAa.version + " test: " + (decodedAddr.version == decodedAa.version))
  return decodedAddr.hash.equals(decodedAa.hash) && decodedAddr.version == decodedAa.version
}

// updates account data if missing or incomplete
CM.prototype.ensureAccountInfo = function (account) {
  var self = this
  var info = self.peekAccountInfo(account)
  if (possiblyIncompleteAccountInfo(info)) {
    return self.accountRefresh(account).then(res => {
      info = res.accountInfo
      if (info.cosigners && info.cosigners.length > 1 && !info.scriptParams)
        throwUnexpectedEx("Account not complete yet: have cosigners joined?")
      return res.account
    })
  } else
    return Q(account)
}

const SLP_PREFIX = Buffer.from("6a04534c50000101", 'hex')  // OP_RETURN SLP\0 01
const SLP_ACTION_GENESIS = Buffer.from("0747454e45534953", 'hex')  // GENESIS
const SLP_ACTION_MINT = Buffer.from("044d494e54", 'hex')  // MINT
const SLP_ACTION_SEND = Buffer.from("0453454e44", 'hex')  // SEND
const SLP_ACTIONS = [SLP_ACTION_SEND, SLP_ACTION_GENESIS, SLP_ACTION_MINT]
function isSlp(tx) {
  if (tx.outs.length < 2)
    return false
  let script = tx.outs[0].script
  if (SLP_PREFIX.compare(script.slice(0, SLP_PREFIX.length)) !== 0)
    return false;
  script = script.slice(SLP_PREFIX.length)
  return SLP_ACTIONS.some(action => action.compare(script.slice(0, action.length)) == 0)
}
//const SLP_SEND_PREFIX = Buffer.from("6a04534c500001010453454e44",'hex')
//return SLP_SEND_PREFIX.compare(out.script.slice(0,SLP_SEND_PREFIX.length)) == 0
// const script = Bitcoin.script.decompile(out.script)
// console.log("REMOVEME RAW SCRIPT", out.script)
// console.log("REMOVEME DECOMPILED SCRIPT", script)
// console.log("S[0]: "+script[0]+" s[1]: "+script[1]+" s[2]: "+script[2])
// if (script.length <= 4)
//   return false
// return (script[0] == 106 && script[1].compare(SLP_PREFIX) && script[3].compare(SLP_ACTION_SEND))
// //   return false
// // const part = script[1]
// // return SLP_SEND_PREFIX.compare(part.slice(0,SLP_SEND_PREFIX.length)) == 0

CM.prototype.analyzeTx = function (state, options) {
  if (options && options.skipAnalyze)
    return null
  if (options && options.forceValidationError) {
    // For regression testing
    return { validated: false, error: options.forceValidationError }
  }
  const account = state.account
  const coin = account.coin
  const recipients = state.recipients || []
  const ptx = state.ptx
  const inputs = ptx.inputs
  const changes = ptx.changes || []
  const tx = this.decodeTxFromBuffer(Buffer.from(ptx.rawTx, 'hex'))
  let amountInOur = 0, amountInOther = 0, amountToRecipients = 0
  let amountToChange = 0, amountToUnknown = 0
  let error, i
  //logger.log("ANALYZE", ptx)

  // TODO: This code must be updated when the transaction contains unknown inputs, like in CoinJoin
  for (i = 0; i < tx.ins.length; i++) {
    var txInput = tx.ins[i]
    logger.log("INPUT #" + i + " " + txInput.hash.toString('hex') + "/" + txInput.index)
    for (j = 0; j < inputs.length; j++) {
      var preparedInput = inputs[j]
      var prepInputHash = Buffer.from(preparedInput.tx, 'hex').reverse()
      if (txInput.hash.equals(prepInputHash) && txInput.index === preparedInput.n) {
        // If we do not use Bitcoin Cash or segwit txs we have to trust the server
        // We could use an external service to know input values but leaking private infos
        amountInOur += preparedInput.amount
      } else {
        // The amount is unknown
        //amountInOther += txInput.amount
      }
    }
  }

  // Calc amount for defined recipients, for the change, and to unknown addresses

  for (let j = 0; j < recipients.length; j++) {
    // If recipients have zero amount or are Melis accounts we need to trust the server
    if (!recipients[j].amount || recipients[j].pubId)
      recipients[j].validated = true
    else
      recipients[j].decodedAddr = this.decodeCoinAddress(coin, recipients[j].address)
  }

  // Mark our recipients to verify that none is left out
  for (i = 0; i < tx.outs.length; i++) {
    const output = tx.outs[i]

    // We skip validation of zero amount outputs to allow OP_RETURN usage
    if (output.value === 0)
      continue

    const toAddr = this.buildAddressFromScript(coin, output.script)
    const decodedTo = this.decodeCoinAddress(coin, toAddr)
    var isChange = false
    for (let j = 0; j < changes.length; j++) {
      const decodedChange = this.decodeCoinAddress(coin, changes[j].aa.address)
      //if (toAddr === changes[j].aa.address) {
      if (decodedTo.hash.equals(decodedChange.hash) && decodedTo.version === decodedChange.version) {
        amountToChange += output.value
        isChange = true
        break
      }
      logger.log("[Analyze] Output #" + i + " to: " + toAddr + " amount: " + output.value + " isChange: " + isChange)
    }

    if (!isChange) {
      var isRecipient = false
      for (let j = 0; j < recipients.length; j++) {
        var recipient = recipients[j]

        // When sending to Melis accounts we need to trust the server
        if (recipient.pubId || recipient.validated)
          continue

        // We skip validation of zero amount outputs to allow OP_RETURN usage
        if (recipient.amount === 0)
          continue

        //if (toAddr === recipient.address) {
        if (decodedTo.hash.equals(recipient.decodedAddr.hash) && decodedTo.version === recipient.decodedAddr.version) {
          if (recipient.isRemainder || output.value === recipient.amount) {
            amountToRecipients += output.value
            isRecipient = true
            recipient.validated = true
          } else {
            error = "Wrong amount sent to recipient"
          }
          break
        }
      }
      if (!isRecipient)
        amountToUnknown += output.value
    }
  }

  // Verify that all recipients have been validated
  if (!error)
    for (i = 0; i < recipients.length; i++)
      if (!recipients[i].validated)
        error = "Missing recipient"
  const extimatedTxSize = this.estimateTxSizeFromAccountInfo(this.peekAccountInfo(account), tx)
  logger.log("coin: " + coin + " feeInfos", this.feeInfos)
  const maxFeePerByte = (this.feeInfos && this.feeInfos[coin]) ?
    this.feeInfos[coin].maximumAcceptable :
    this.feeApi.getHardcodedMaxFeePerByte(coin).maximumAcceptable
  const maximumAcceptableFee = extimatedTxSize * maxFeePerByte
  const fees = amountInOur - amountToRecipients - amountToChange - amountToUnknown
  if (!error)
    if (fees > maximumAcceptableFee)
      error = "Fees too high"
    else if (fees !== ptx.fees)
      error = "Calculated fees does not match server info"
    else if (!isSlp(tx) && (amountToRecipients + amountToUnknown > 0) && (fees > amountToRecipients + amountToUnknown))
      //  else if (fees > amountToChange &&
      //          (fees > (amountToRecipients + amountToUnknown) || (amountToRecipients === 0 && amountToUnknown === 0)))
      error = "Fees (" + fees + ") would be greater than total outputs of transaction (" + amountToRecipients + "/" + amountToUnknown + "/" + amountToChange + ")"
    else if (!this.areAddressesOfAccount(account, changes))
      error = "Change address not validated"
  //    else if (amountToUnknown !== 0)
  //      error = "Destination address not validated"
  logger.log("[ANALYZE] isSlp: " + isSlp(tx) + " amountInOur: " + amountInOur + " amountInOther: " + amountInOther + " amountToRecipients: "
    + amountToRecipients + " amountToChange: " + amountToChange + " amountToUnknown: " + amountToUnknown)
  logger.log("[ANALYZE] fees: " + fees + " maxAcceptableFees: " + maximumAcceptableFee + " ptx.fees: " + ptx.fees
    + " extimatedTxSize: " + extimatedTxSize + " error: " + error + " maxFeePerByte: " + maxFeePerByte)
  return {
    validated: !error,
    error: error,
    fees: fees,
    maximumAcceptableFee: maximumAcceptableFee,
    amountInOur: amountInOur,
    amountInOther: amountInOther,
    amountToRecipients: amountToRecipients,
    amountToChange: amountToChange,
    amountToUnknown: amountToUnknown
  }
}

CM.prototype.preparePayAllToAddress = function (account, address, options) {
  if (!options)
    options = {}
  options.selectAllUnspents = true
  var recipients = [{ address: address, isRemainder: true, amount: 0 }]
  return this.payPrepare(account, recipients, options)
}

CM.prototype.payPrepare = function (account, recipients, options) {
  const self = this
  if (!recipients)
    recipients = []
  if (recipients.length === 0 && (!options || !options.unspents))
    return failPromiseWithBadParam("recipients", "Missing recipients or inputs to rotate")
  for (var i = 0; i < recipients.length; i++) {
    const recipient = recipients[i]
    if (recipient.address && !self.isValidAddress(account.coin, recipient.address))
      return failPromiseWithEx(buildInvalidAddressEx(recipient.address, "Invalid address: " + recipient.address))
    if (!recipient.address && !recipient.pubId && !recipient.payloadBase64)
      return failPromiseWithBadParam("recipient", "Missing address, pubId or payload in recipient")
    if (recipient.amount !== undefined && recipient.amount !== null)
      recipient.amount = parseInt(recipient.amount)
    // const v = parseInt(recipient.amount)
    // if (v === undefined || v === null || v < 0)
    //   return failPromiseWithBadParam("amount", "Invalid amount: " + v)
    // recipient.amount = v
  }
  const state = { account: account, recipients: recipients }
  return this.ensureAccountInfo(account).then(function (account) {
    state.account = account
    return self.ptxPrepare(account, recipients, options)
  }).then(function (res) {
    state.ptx = res.ptx
    return self.updateNetworkFees(state.account.coin)
  }).then(function () {
    state.summary = self.analyzeTx(state, options)
    if (options && options.autoSignIfValidated && state.summary.validated)
      return self.ptxSignFields(state.account, state.ptx).then(function (res) {
        state.ptx = res.ptx
        return state
      })
    else
      return state
  })
}

CM.prototype.payPrepareFeeBump = function (state, options) {
  var self = this
  return self.ptxFeeBump(state.ptx.id, options).then(function (res) {
    state = self.rebuildStateFromPtx(state.account, res.ptx)
    if (options && options.autoSignIfValidated)
      return self.ptxSignFields(state.account, state.ptx).then(function (res) {
        state.ptx = res.ptx
        return state
      })
    else
      return state
  })
}

CM.prototype.verifyPtx = function (state, options) {
  var self = this
  return this.ptxVerifyFieldsSignature(state.account, state.ptx).then(function () {
    return self.analyzeTx(state, options)
  })
}

CM.prototype.payConfirm = function (state, tfa) {
  var self = this
  return this.ptxVerifyFieldsSignature(state.account, state.ptx).then(() => {
    return self.signaturesPrepare({
      coin: state.account.coin,
      accountNum: state.account.num,
      progressCallback: state.progressCallback,
      rawTx: state.ptx.rawTx,
      inputs: state.ptx.inputs
    })
  }).then(signatures => {
    return self.signaturesSubmit(state, signatures.map(o => {
      return o.sig.toDER().toString('hex')
    }), tfa)
  })
}

CM.prototype.payAllToAddress = function (account, address, options) {
  options = options || {}
  options.selectAllUnspents = true
  var recipients = [{ address: address, isRemainder: true, amount: 0 }]
  return this.payRecipients(account, recipients, options)
}

CM.prototype.payRecipients = function (account, recipients, options) {
  var self = this
  options = options || {}
  options.autoSignIfValidated = true
  return this.payPrepare(account, recipients, options).then(state => {
    if (state.summary.validated) {
      return self.payConfirm(state, options ? options.tfa : undefined).then(function (hash) {
        state.hash = hash
        return state
      })
    } else {
      var ex = { ex: "clientValidationFailure", msg: "Self validation not passed", error: state.summary.error }
      logger.log(ex)
      return Q.reject(ex)
    }
  })
}

CM.prototype.getExpiringUnspents = function (account, pagingInfo) {
  var pars = addPagingInfo({ pubId: account.pubId }, pagingInfo)
  return this.simpleRpcSlice(C.ACCOUNT_GET_EXPIRING_UNSPENTS, pars)
}

CM.prototype.getUnspents = function (account, pagingInfo) {
  var pars = addPagingInfo({ pubId: account.pubId }, pagingInfo)
  return this.simpleRpcSlice(C.ACCOUNT_GET_UNSPENTS, pars)
}

// Deprecated, to be purged soon
CM.prototype.getUnspentsAtBlock = function (account, blockNum) {
  return this.rpc(C.PREFIX_ACCOUNT_METHODS + "getUnspentsAtBlock", {
    pubId: account.pubId,
    data: blockNum
  })
}

//
// Spending limits
//

CM.prototype.accountGetLimits = function (account) {
  logger.log("[CM accountGetLimits] account: ", account)
  return this.rpc(C.ACCOUNT_LIMITS_GET, {
    pubId: account.pubId
  })
}

CM.prototype.accountSetLimit = function (account, limit, tfa) {
  logger.log("[CM accountSetLimit] limit: " + JSON.stringify(limit) + " account:", account)
  return this.rpc(C.ACCOUNT_LIMIT_SET, {
    pubId: account.pubId,
    type: limit.type, isHard: limit.isHard, amount: limit.amount,
    tfa: tfa
  }).then(function (res) {
    //console.log("res: " + JSON.stringify(res))
    return res
  })
}

CM.prototype.accountCancelLimitChange = function (account, limitType, tfa) {
  logger.log("[CM accountCancelLimitChange] " + limitType + " account:", account)
  return this.rpc(C.ACCOUNT_LIMIT_CANCEL_CHANGE, {
    pubId: account.pubId,
    type: limitType,
    tfa: tfa
  }).then(function (res) {
    return res
  })
}

//
// TFA
//

CM.prototype.tfaGetWalletConfig = function (account) {
  const params = {}
  if (account)
    params.pubId = account.pubId
  return this.rpc(C.TFA_GET_WALLET_CONFIG, params).then(res => res.tfaConfig)
}

CM.prototype.tfaEnrollStart = function (params, tfa) {
  if (!params.name)
    throwBadParamEx('params', "Missing name")
  logger.log("[CM tfaEnrollStart] name: " + params.name + " value: " + params.value + " tfa: " + (tfa ? JSON.stringify(tfa) : "NONE"))
  return this.rpc(C.TFA_ENROLL_START, {
    name: params.name,
    value: params.value,
    data: params.data,
    meta: params.meta,
    tfa: tfa
  }).then(function (res) {
    return res.tfaRes
  })
}

CM.prototype.tfaEnrollFinish = function (tfa) {
  return this.rpc(C.TFA_ENROLL_FINISH, { tfa: tfa }).then(function (res) {
    return res.tfaRes
  })
}

CM.prototype.tfaDeviceDelete = function (param, tfa) {
  return this.rpc(C.TFA_DEVICE_DELETE, {
    name: param.name,
    value: param.value,
    tfa: tfa
  }).then(function (res) {
    return res
  })
}

CM.prototype.tfaProposeDeleteDevices = function () {
  return this.rpc(C.TFA_PROPOSE_DELETE_DEVICES)
}

CM.prototype.tfaDeviceSetMeta = function (params, tfa) {
  return this.rpc(C.TFA_DEVICE_SET_META, {
    name: params.name,
    value: params.value,
    meta: params.meta,
    tfa: tfa
  })
}

CM.prototype.tfaDeviceSetNotifications = function (params, tfa) {
  return this.rpc(C.TFA_DEVICE_SET_NOTIFICATIONS, {
    name: params.name,
    value: params.value,
    data: params.enabled,
    tfa: tfa
  })
}

CM.prototype.tfaAuthStart = function (params) {
  return this.rpc(C.TFA_AUTH_REQUEST, {
    name: params.name,
    value: params.value
  }).then(function (res) {
    return res.tfaRes
  })
}

CM.prototype.tfaAuthValidate = function (tfa) {
  return this.rpc(C.TFA_AUTH_VALIDATE, { tfa: tfa }).then(function (res) {
    return res.tfaRes
  })
}

CM.prototype.tfaGetAccountConfig = function (account) {
  return this.rpc(C.TFA_GET_ACCOUNT_CONFIG, { pubId: account.pubId }).then(function (res) {
    return res.tfaConfig
  })
}

CM.prototype.tfaSetAccountConfig = function (account, config, tfa) {
  logger.log("[CM tfaSetAccountConfig] config: " + JSON.stringify(config))
  return this.rpc(C.TFA_SET_ACCOUNT_CONFIG, {
    pubId: account.pubId,
    data: config.policy,
    tfa: tfa
  }).then(function (res) {
    return res.tfaConfig
  })
}

//
// Address book methods
//

CM.prototype.abAdd = function (entry) {
  logger.log("[CM ab add] ", entry)
  return this.rpc(C.AB_ADD, {
    coin: entry.coin,
    type: entry.type,
    val: entry.val,
    labels: entry.labels,
    meta: entry.meta
  })
}

CM.prototype.abUpdate = function (entry) {
  logger.log("[CM ab update]", entry)
  return this.rpc(C.AB_UPDATE, {
    id: entry.id,
    coin: entry.coin,
    type: entry.type,
    val: entry.val,
    labels: entry.labels,
    meta: entry.meta
  })
}

CM.prototype.abDelete = function (entry) {
  logger.log("[CM ab delete]", entry)
  return this.rpc(C.AB_DELETE, { id: entry.id })
}

CM.prototype.abGet = function (fromDate, pagingInfo) {
  var pars = addPagingInfo({ fromDate: fromDate }, pagingInfo)
  return this.simpleRpcSlice(C.AB_GET, pars)
}

//
// Chat / Messaging methods
//

CM.prototype.msgSendToAccount = function (account, to, payload, type) {
  return this.rpc(C.MSG_SEND_TO_ACCOUNT, {
    pubId: account.pubId,
    toAccount: to,
    payload: payload,
    type: type
  })
}

CM.prototype.msgSendToPtx = function (account, ptx, payload, type) {
  return this.rpc(C.MSG_SEND_TO_PTX, {
    pubId: account.pubId,
    toPtx: ptx.id,
    payload: payload,
    type: type
  })
}

CM.prototype.msgGetAllToWallet = function (fromDate, pagingInfo) {
  var pars = addPagingInfo({ fromDate: fromDate }, pagingInfo)
  return this.simpleRpcSlice(C.MSG_GET_ALL_TO_WALLET, pars)
}

CM.prototype.msgGetAllToPtx = function (ptx, fromDate, pagingInfo) {
  var pars = addPagingInfo({ toPtx: ptx.id, fromDate: fromDate }, pagingInfo)
  return this.simpleRpcSlice(C.MSG_GET_ALL_TO_PTX, pars)
}

CM.prototype.msgGetAllToPtxs = function (fromDate, pagingInfo) {
  var pars = addPagingInfo({ fromDate: fromDate }, pagingInfo)
  return this.simpleRpcSlice(C.MSG_GET_ALL_TO_PTXS, pars)
}

//
// Utilities
//

CM.prototype.sessionSetParams = function (params, tfa) {
  var par = { tfa: tfa }
  var validProps = ['locale', 'currency', 'paused', 'usePinAsTfa']
  validProps.forEach(function (p) {
    if (params[p] !== undefined)
      par[p] = params[p]
  })
  return this.rpc(C.SESSION_SET_PARAMS, par)
}

CM.prototype.getPaymentAddressViaRest = function (pubId, options) {
  let fetchParams = "?"
  if (options.info)
    fetchParams += "&info=" + encodeURIComponent(options.info)
  if (options.address)
    fetchParams += "&address=" + encodeURIComponent(options.address)
  return fetch(this.peekRestPrefix() + "/account/" + pubId + "/getPaymentAddress" + fetchParams, {
    method: 'POST',
    headers: { "user-agent": C.MELIS_USER_AGENT }
  }).then(res => res.json())
}

CM.prototype.verifyInstantViaRest = function (account, address, hash, n) {
  const node = this.deriveAddressKey(account.num, address.chain, address.hdindex)
  const data = this.prepareAddressSignature(account.coin, node.keyPair, C.MSG_PREFIX_INSTANT_VERIFY)
  return fetch(this.peekRestPrefix() + "/verifyInstantTx?txHash=" + hash + "&outputNum=" + n + "&sig=" + encodeURIComponent(data.base64Sig), {
    headers: { "user-agent": C.MELIS_USER_AGENT }
  }).then(res => res.json())
}

CM.prototype.prepareUnspentForkClaim = function (params) {
  return this.rpc(C.PREPARE_UNSPENT_FORK_CLAIM, {
    pubId: params.account.pubId,
    targetCoin: params.targetCoin,
    targetAddress: params.targetAddress,
    unspents: params.unspents
  })
}

CM.prototype.submitForkClaim = function (id, signatures) {
  return this.rpc(C.SUBMIT_FORK_CLAIM, {
    id, signatures
  })
}

CM.prototype.slpPrepareGenesisPtx = async function (account, genesisData, options) {
  genesisData.pubId = account.pubId
  if (options)
    genesisData.ptxOptions = options
  const state = { account: account }
  account = await this.ensureAccountInfo(account)
  state.account = account
  let res = await this.rpc(C.SLP_CREATE_GENESIS, genesisData)
  state.ptx = res.ptx
  await this.updateNetworkFees(account.coin)
  state.summary = this.analyzeTx(state, options)
  if (options && options.autoSignIfValidated && state.summary.validated) {
    res = await this.ptxSignFields(state.account, state.ptx)
    state.ptx = res.ptx
  }
  return state
}

CM.prototype.slpPrepareMintPtx = async function (account, mintData, options) {
  mintData.pubId = account.pubId
  if (options)
    mintData.ptxOptions = options
  const state = { account: account }
  account = await this.ensureAccountInfo(account)
  state.account = account
  let res = await this.rpc(C.SLP_CREATE_MINT, mintData)
  state.ptx = res.ptx
  await this.updateNetworkFees(account.coin)
  state.summary = this.analyzeTx(state, options)
  if (options && options.autoSignIfValidated && state.summary.validated) {
    res = await this.ptxSignFields(state.account, state.ptx)
    state.ptx = res.ptx
  }
  return state
}

CM.prototype.slpGetTokenInfoByTicker = async function (ticker) {
  return await this.rpc(C.SLP_GET_TOKEN_INFO_BY_TICKER + "/" + ticker)
}

CM.prototype.slpGetTokenInfoByTokenId = async function (tokenId) {
  return await this.rpc(C.SLP_GET_TOKEN_INFO_BY_TOKENID + "/" + tokenId)
}

CM.prototype.slpGetTokenInfos = async function () {
  return await this.rpc(C.SLP_GET_TOKEN_INFOS)
}

CM.prototype.slpTxInfoGet = async function (id) {
  const res = await this.rpc(C.SLP_GET_TX_INFO, { data: id })
  return res.slpTxInfo
}

CM.prototype.slpTxInfoSet = async function (id, labels, meta) {
  const res = await this.rpc(C.SLP_SET_TX_INFO, {
    data: id,
    labels: labels,
    meta: meta
  })
  return res.slpTxInfo
}

//
// Non-promise returning methods
//

CM.prototype.estimateInputSigSize = function (numAccounts, minSignatures) {
  var redeemScriptSize = numAccounts * 34 + 3
  var signaturesSize = minSignatures * 72 + 3
  return redeemScriptSize + signaturesSize + 3
}

CM.prototype.estimateTxSize = function (numInputs, numRecipients, inputSigSize) {
  return 10 + numRecipients * 34 + numInputs * (inputSigSize + 72)
}

CM.prototype.estimateInputSigSizeFromAccount = function (accountInfo) {
  if (!accountInfo || !accountInfo.type)
    throwUnexpectedEx("No info data for account")
  if (accountInfo.type === C.TYPE_PLAIN_HD || accountInfo.type === C.TYPE_LEGACY)
    return 148
  var hasServerSignature = accountInfo.serverSignature ? 1 : 0
  var numPubKeys = accountInfo.cosigners.length + hasServerSignature
  var minSignatures = accountInfo.minSignatures + hasServerSignature
  return this.estimateInputSigSize(numPubKeys, minSignatures)
}

CM.prototype.estimateTxSizeFromAccountInfo = function (accountInfo, tx) {
  return this.estimateTxSize(tx.ins.length, tx.outs.length, this.estimateInputSigSizeFromAccount(accountInfo))
}

CM.prototype.rebuildStateFromPtx = function (account, ptx) {
  return {
    ptx: ptx,
    account: account,
    info: ptx.info,
    recipients: null,
    validated: false
  }
}

CM.prototype.peekConfig = function () {
  return this.cmConfiguration
}

CM.prototype.peekPublicUrl = function () {
  return this.apiUrls.publicUrlPrefix + "/app"
}

CM.prototype.peekRestPrefix = function () {
  return this.apiUrls.restPrefix
}

CM.prototype.peekTopBlock = function (coin) {
  return this.lastBlocks[coin]
}

CM.prototype.peekWalletPubKey = function () {
  if (this.hdWallet)
    return this.hdWallet.getPublicKeyBuffer().toString('hex')
  throwUnexpectedEx("Wallet not open")
}

CM.prototype.peekHdWallet = function () {
  if (this.hdWallet)
    return this.hdWallet
  throwUnexpectedEx("Wallet not open")
}

CM.prototype.peekWallet = function () {
  return this.walletData
}

CM.prototype.peekAccounts = function () {
  return this.walletData.accounts
}

CM.prototype.peekAccountInfos = function () {
  return this.walletData.infos
}

CM.prototype.peekAccountBalance = function (account) {
  return this.walletData.balances[account.pubId]
}

CM.prototype.peekAccountInfo = function (account) {
  return this.walletData.infos[account.pubId]
}

CM.prototype.deviceIdHash = function (deviceId) {
  if (!deviceId || typeof deviceId !== "string")
    return null
  return "DI" + Bitcoin.crypto.ripemd160(Buffer.from(deviceId, 'utf8')).toString('base64')
}

CM.prototype.countNumAccounts = function () {
  return Object.keys(this.peekAccounts()).length
  //  return  this.peekAccounts().reduce(function (prevVal, currVal, i, arr) {
  //    return prevVal + (arr[i] ? 1 : 0)
  //  }, 0)
}

//
// Recovery code
//

function pubKeyComparator(a, b) {
  return a.pubKey.localeCompare(b.pubKey)
}

CM.prototype.recoveryPrepareMultiSigInputSig = function (index, accountInfo, unspent, accountsSigData) {
  const bscript = Bitcoin.script
  const coin = accountInfo.coin
  //console.log("input #" + index + ": ", input)
  //console.log("unspent #" + index + ": ", unspent)
  logger.log("[recovery-prepareInputSig] coin: " + coin + " inputIndex: " + index + " unspent: " + unspent.aa.address + " chain: " + unspent.aa.chain + " hdindex: " + unspent.aa.hdindex + " redeemScr: " + unspent.aa.redeemScript)
  //console.log("#" + index + " srvPubKey: " + serverSigData.pubKey)
  var scriptParams = accountInfo.scriptParams
  if (!scriptParams)
    throw new MelisError('CmBadParamException', 'Unable to find scriptParams preparing recovery signatures')
  var mandatoryPubKeys = []
  if (scriptParams.mandatoryKeys && scriptParams.mandatoryKeys.length > 0)
    mandatoryPubKeys = this.derivePubKeys(coin, scriptParams.mandatoryKeys, unspent.aa.chain, unspent.aa.hdindex)
  var otherPubKeys = this.derivePubKeys(coin, scriptParams.otherKeys ? scriptParams.otherKeys : [], unspent.aa.chain, unspent.aa.hdindex)
  logger.log("accountsSigData: ", accountsSigData)
  logger.log("derived mandatory PubKeys: ", mandatoryPubKeys)
  logger.log("derived other PubKeys: ", otherPubKeys)

  // Let's associate signatures to pubKeys
  var self = this, mandatorySigs = [], otherSigs = []
  accountsSigData.forEach(function (sigData) {
    logger.log("SigData pubKey: " + sigData.pubKey)
    var found = mandatoryPubKeys.find(function (pubKey) {
      return sigData.pubKey === pubKey
    })
    if (found)
      mandatorySigs.push(sigData)
    else {
      found = otherPubKeys.find(function (pubKey) {
        return sigData.pubKey === pubKey
      })
      if (found)
        otherSigs.push(sigData)
      else
        throw new MelisError('CmBadParamException', "Unable to find pubKey in account recovery data: " + sigData.pubKey)
    }
  })
  logger.log("#mandatorySigs: " + mandatorySigs.length + " #otherSigs: " + otherSigs.length + " mandatoryServer: " + accountInfo.serverMandatory)
  if (mandatorySigs.length !== mandatoryPubKeys.length)
    throw new MelisError('CmBadParamException', 'Wrong mandatory signatures -- found: ' + mandatorySigs.length + " needed: " + mandatoryPubKeys.length)
  if (otherSigs.length !== (accountInfo.minSignatures + (accountInfo.serverMandatory ? 1 : 0) - mandatorySigs.length))
    throw new MelisError('CmBadParamException', 'Wrong additional signatures -- found: ' + otherSigs.length + " mandatory: " + mandatorySigs.length + " mandatoryServer: " + accountInfo.serverMandatory)
  mandatorySigs.sort(pubKeyComparator)
  otherSigs.sort(pubKeyComparator)

  var script = 'OP_0';   // Work around a bug in CHECKMULTISIG that is now a required part of the protocol.
  otherSigs.forEach(sigData => {
    const scriptSignature = self.toScriptSignature(coin, sigData.sig, sigData.hash)
    script += ' ' + scriptSignature.toString('hex')
  })
  if (mandatorySigs.length > 1 && otherSigs.length > 0)
    script += ' OP_0'
  mandatorySigs.forEach(sigData => {
    const scriptSignature = self.toScriptSignature(coin, sigData.sig, sigData.hash)
    script += ' ' + scriptSignature.toString('hex')
  })

  logger.log("scriptPubKey: " + script)
  var scriptSig = bscript.fromASM(script)
  var bufferRedeemScript = Buffer.from(unspent.aa.redeemScript, 'hex')
  logger.log("redeemScript: " + bscript.toASM(bufferRedeemScript))

  var p2shScript = bscript.scriptHash.input.encode(scriptSig, bufferRedeemScript)
  return p2shScript
}

CM.prototype.recoveryPrepareSimpleTx = function (params) {
  const self = this
  const seed = params.seed
  const accountInfo = params.accountInfo
  const unspents = params.unspents
  const fees = params.fees
  const destinationAddress = params.destinationAddress
  logger.log("[recoveryPrepareSimpleTx] accountinfo: ", accountInfo)
  logger.log("[recoveryPrepareSimpleTx] unspents: ", unspents)

  const coin = accountInfo.coin
  const bscript = Bitcoin.script
  const tx = new Bitcoin.Transaction()
  let inputAmount = 0
  for (let i = 0; i < unspents.length; i++) {
    let unspent = unspents[i]
    tx.addInput(Buffer.from(unspent.tx, 'hex').reverse(), unspent.n, Bitcoin.Transaction.DEFAULT_SEQUENCE)
    inputAmount += unspent.amount
  }
  if (inputAmount === 0)
    throw new MelisError("Unexpected: input amount is zero")
  const outputSig = this.toOutputScript(coin, destinationAddress)
  logger.log("[rebuildSingleTx] inputAmount:" + inputAmount + " fees: " + fees + " outputSig: " + outputSig.toString('hex') + " destAddress: " + destinationAddress)
  tx.addOutput(outputSig, inputAmount - fees)

  const accountHd = self.deriveAccountHdKey(self.hdNodeFromHexSeed(seed), accountInfo.accountNum, coin)
  const accountKeys = {}
  accountKeys[accountInfo.accountNum] = accountHd
  return self._signaturesPrepare({
    coin,
    accountKeys,
    accountNum: accountInfo.accountNum,
    rawTx: tx.toHex(),
    inputs: unspents
  }).then(signatures => {
    for (let i = 0; i < unspents.length; i++) {
      const sigData = signatures[i]
      const scriptSignature = self.toScriptSignature(coin, sigData.sig, Bitcoin.Transaction.SIGHASH_ALL)
      const inputScript = bscript.compile([scriptSignature, sigData.key.getPublicKeyBuffer()])
      tx.setInputScript(i, inputScript)
    }
    return tx
  })
}

CM.prototype.recoveryPrepareMultiSigTx = function (accountInfo, tx, unspents, seeds, serverSignaturesData) {
  const self = this
  const coin = accountInfo.coin
  const cosigners = accountInfo.cosigners
  logger.log("[recoveryPrepareMultiSigTx] coin: " + coin + " unspents: ", unspents)
  logger.log("[recoveryPrepareMultiSigTx] server signature data: ", serverSignaturesData)

  if (accountInfo.minSignatures !== seeds.length)
    throw new MelisError('CmBadParamException', '#minSignatures != #seeds')

  const hexTx = tx.toHex()
  const signatures = []

  // Discover which account is owned by which seed
  const accountsData = []
  seeds.forEach(seed => {
    const walletHd = self.hdNodeFromHexSeed(seed)
    const cosigner = cosigners.find(cosigner => {
      const accountHd = self.deriveAccountHdKey(walletHd, cosigner.accountNum, coin)
      return self.hdNodeToBase58Xpub(accountHd, coin) === cosigner.xpub
    })
    if (!cosigner)
      throw new MelisError('CmBadParamException', "Unable to find cosigner for seed: " + seed)
    accountsData.push({ walletHd, accountNum: cosigner.accountNum })
    //accountsData.push({walletHd, seed: seed, accountNum: cosigner.accountNum })
  })

  const f = function (i) {
    const data = accountsData[i]
    const accountHd = self.deriveAccountHdKey(data.walletHd, data.accountNum, coin)
    const accountKeys = {}
    accountKeys[data.accountNum] = accountHd
    return self._signaturesPrepare({
      coin,
      accountKeys,
      accountNum: data.accountNum,
      rawTx: hexTx,
      inputs: unspents
    }).then(accountSigs => {
      signatures.push(accountSigs.map(function (sigData) {
        return {
          pubKey: sigData.key.getPublicKeyBuffer().toString('hex'),
          sig: sigData.sig,
          hash: Bitcoin.Transaction.SIGHASH_ALL
        }
      }))
      if (i < accountsData.length - 1)
        return f(i + 1)
    })
  }

  return f(0).then(function () {
    const allSignatures = []
    for (var i = 0; i < tx.ins.length; i++) {
      const arr = []
      if (accountInfo.serverSignature && accountInfo.serverMandatory) {
        const serverPubKey = Buffer.from(serverSignaturesData[i].pubKey, 'base64').toString('hex')
        const serverSig = Bitcoin.ECSignature.fromDER(Buffer.from(serverSignaturesData[i].sig, 'base64'))
        const serverSigData = { pubKey: serverPubKey, sig: serverSig, hash: Bitcoin.Transaction.SIGHASH_NONE }
        arr.push(serverSigData)
      }
      signatures.forEach(s => arr.push(s[i]))
      allSignatures.push(arr)
    }
    for (var i = 0; i < tx.ins.length; i++) {
      const inputScript = self.recoveryPrepareMultiSigInputSig(i, accountInfo, unspents[i], allSignatures[i])
      //logger.log("#" + i + " inputSig: " + Bitcoin.script.toASM(inputSig))
      tx.setInputScript(i, inputScript)
    }
    return tx
  })
}

CM.C = C
CM.Q = Q
CM.Bitcoin = Bitcoin
CM.sjcl = sjcl
CM.Buffer = Buffer
CM.fetch = fetch
CM.BC_APIS = BC_APIS

module.exports = CM
