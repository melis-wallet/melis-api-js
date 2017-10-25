//const {fetch, Request, Response, Headers} = require('fetch-ponyfill')()
require('isomorphic-fetch');
const Q = require('q')
const events = require('events')
const Stomp = require('webstomp-client')
const WebSocketClient = require('ws')
const SockJS = require('sockjs-client')
const Bitcoin = require('bitcoinjs-lib')
const BitcoinMessage = require('bitcoinjs-message')
const isNode = require('detect-node')
const randomBytes = require('randombytes')
const sjcl = require('sjcl-all')
const C = require("./cm-constants")
const BC_APIS = require("./blockchain-apis")

Bitcoin.Transaction.SIGHASH_BITCOINCASHBIP143 = 0x40

function MelisError(ex, msg) {
  this.ex = ex
  this.msg = msg
  this.message = "Exception class " + ex + " '" + msg + "'"
  this.stack = (new Error()).stack
}
MelisError.prototype = Object.create(Error.prototype)
MelisError.prototype.constructor = MelisError

function walletOpen(target, hd, serverWalletData) {
  if (!hd || !serverWalletData)
    throwUnexpectedEx("No data opening wallet")
  target.hdWallet = hd
  var accounts = {}
  var balances = {}
  var infos = {}
  serverWalletData.accounts.forEach(function (a, i) {
    accounts[a.num] = a
    balances[a.num] = serverWalletData.balances[i]
    infos[a.num] = serverWalletData.accountInfos[i]
  })
  target.walletData = {
    accounts: accounts,
    balances: balances,
    infos: infos
  }
  // Transforms arrays in objects
  serverWalletData.accounts = accounts
  serverWalletData.balances = balances
  serverWalletData.accountInfos = infos
  emitEvent(target, C.EVENT_WALLET_OPENED, serverWalletData)
}

function walletClose(target) {
  target.hdWallet = null
  target.walletData = null
}

function updateWalletInfo(target, info) {
  target.walletData.info = info
}

function updateAccount(target, account, balance, info) {
  target.walletData.accounts[account.num] = account
  target.walletData.balances[account.num] = balance
  if (info)
    target.walletData.infos[account.num] = info
}

function updateAccountInfo(target, account, info) {
  if (target.walletData.accounts[account.num])
    target.walletData.infos[account.num] = info
}

function updateServerConfig(target, config) {
  if (config.message)
    target.log("Server message status: " + config.message)
  target.cmConfiguration = config
  target.lastBlock = config.topBlock
  target.bitcoinNetwork = target.decodeNetworkName(target.cmConfiguration.network)
  if (config.feeInfo && !target.fees.lastUpdated)
    target.fees = {
      detail: config.feeInfo,
      fastestFee: config.feeInfo.fastestFee,
      mediumFee: config.feeInfo.mediumFee,
      maximumAcceptable: config.feeInfo.fastestFee * 3,
      lastUpdated: new Date()
    }
}

function emitEvent(target, event, params) {
  target.lastReceivedMsgDate = new Date()
  if (event === C.EVENT_DISCONNECT_REQ) {
    target.log("Server requested to disconnect:", params)
    return handleConnectionLoss(target, true)
  }
  if (event === C.EVENT_PING)
    target.stompClient.send(C.UTILS_PONG, {}, {})
  if (event !== C.EVENT_RPC_ACTIVITY_END && event !== C.EVENT_RPC_ACTIVITY_START)
    target.log("[CM emitEvent] " + event + " params: " + JSON.stringify(params))
  if (event === C.EVENT_CONFIG)
    updateServerConfig(target, params)
  var listeners = target.listeners(event)
  if (!listeners.length) {
//target.log("[CM emitEvent] nessun listener per l'evento '" + event + "'")
    target.emit(C.UNHANDLED_EVENT, {name: event, params: params})
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

function buildConnectionFailureEx(msg) {
  return new MelisError('ConnectionFailureException', msg)
}

function failPromiseWithBadParam(paramName, msg) {
  return Q.reject(buildBadParamEx(paramName, msg))
}

function throwBadParamEx(paramName, msg) {
  throw buildBadParamEx(paramName, msg)
}

function throwUnexpectedEx(msg) {
  // throw {ex: 'UnexpectedClientEx', msg: msg}
  throw new MelisError('UnexpectedClientEx', msg)
}

function throwInvalidSignatureEx(msg) {
  //throw {ex: 'CmInvalidSignatureException', msg: msg}
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
  target.walletData = null
  target.lastBlock = null
  target.lastOpenParams = null
  target.cmConfiguration = null // Got from server at connect
  target.bitcoinNetwork = Bitcoin.networks.testnet // Overridden from server at connect
  target.connected = false
  target.connecting = false
  target.paused = false
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
    target.logWarning("No response from server since " + secsElapsed + " seconds: DISCONNECTING")
    handleConnectionLoss(target)
  } else if (secsElapsed >= target.maxKeepAliveSeconds / 2) {
    target.ping()
  }
}

function rpcReplyHandler(target, res) {
  // target.log("[STOMP] Ricevuta risposta RPC: " + res)
  //var messageId = res.headers.myId
  target.lastReceivedMsgDate = new Date()
  var message = JSON.parse(res.body)
  var messageId = message.id
  //target.log("[STOMP] rpcReplyHandler message: " + JSON.stringify(message))
  if (messageId) {
    var rpcData = target.waitingReplies[messageId]
    delete target.waitingReplies[messageId]
    if (rpcData)
      rpcData.deferred.resolve(message.m)
    else
      target.logError("[STOMP] RPC reply con ID: " + messageId + " non trovato in coda")
  } else {
    target.logWarning("[STOMP] RPC reply senza ID:", message)
  }
}

function rpcErrorHandler(target, res) {
  target.log("[STOMP] RPC Exception:", res)
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
        target.log("Server requested to slow down requests -- retry #" + rpcData.numRetries + " waiting " + rpcRetryDelay + "ms")
        setTimeout(function () {
          target.log("Preparing new request")
          target.rpc(rpcData.queue, rpcData.data, rpcData.headers, rpcData.numRetries + 1).then(function (res) {
            rpcData.deferred.resolve(res)
          }).catch(function (res) {
            target.log("RE-REQUEST FAILED:", res)
            rpcData.deferred.reject(buildMelisErrorFromServerEx(res))
          })
        }, rpcRetryDelay)
      } else
        rpcData.deferred.reject(buildMelisErrorFromServerEx(message))
    } else {
      target.logError("[STOMP] RPC Error -- Unable to find request with ID: " + messageId)
    }
  }
}

function CM(config) {
  if (!config)
    config = {}
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
  this.fees = {
    maximumAcceptable: C.MAXIMUM_FEE_PER_BYTE,
    lastUpdated: null
  }
  this.feeProviders = [
    this.getNetworkFees21, this.getNetworkFeesBitgo, this.getNetworkFeesBlockCypher
  ]
  initializePrivateFields(this)
}

CM.prototype = Object.create(events.EventEmitter.prototype)

CM.prototype.log = function (a, b) {
  if (a && b)
    console.log(a, b)
  else
    console.log(a)
}

CM.prototype.logWarning = function (a, b) {
  if (a && b)
    console.warn(a, b)
  else
    console.warn(a)
}

CM.prototype.logError = function (a, b) {
  if (a && b)
    console.error(a, b)
  else
    console.error(a)
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
  return this.cmConfiguration.network === C.CHAIN_MAIN
}

CM.prototype.isTestNet = function () {
  return this.cmConfiguration.network === C.CHAIN_TESTNET
}

CM.prototype.isRegTest = function () {
  return this.cmConfiguration.network === C.CHAIN_REGTEST
}

CM.prototype.decodeNetworkName = function (networkName) {
  return networkName === "main" ? Bitcoin.networks.bitcoin : Bitcoin.networks.testnet
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
  var product = 31337 // CM
  var isProdNet = this.bitcoinNetwork.wif === Bitcoin.networks.bitcoin.wif
  var network = isProdNet ? 0 : 1 // Use another path for I2P/TOR?
  return [
    ((0x80000000) | product) >>> 0,
    ((0x80000000) | network) >>> 0
  ]
}

CM.prototype.deriveKeyFromPath = function (hdnode, path) {
  if (!path || path.length === 0)
    return hdnode
  var key = hdnode
  for (var i = 0; i < path.length; i++) {
    var index = path[i]
    if (index & 0x80000000) {
      var v = index & 0x7FFFFFFF
      key = key.deriveHardened(v)
    } else {
      key = key.derive(index)
    }
  }
  return key
}

// BIP44 standard derivation
CM.prototype.deriveHdAccount_explicit = function (network, hd, accountNum, chain, index) {
  var isProdNet = !network || network.wif === Bitcoin.networks.bitcoin.wif
  //this.log("[deriveHdAccount_explicit] " + accountNum + "/" + chain + "/" + index + " isProdNet: " + isProdNet, network)
  var key = hd.deriveHardened(44)
  key = key.deriveHardened(isProdNet ? 0 : 1)
  key = key.deriveHardened(accountNum)
  if (chain === undefined || chain === null || index === undefined || index === null)
    return key
  return key.derive(chain).derive(index)
}

CM.prototype.deriveHdAccount = function (accountNum, chain, hdindex) {
  return this.deriveHdAccount_explicit(this.bitcoinNetwork, this.hdWallet, accountNum, chain, hdindex)
}

CM.prototype.accountAddressToWIF = function (account, aa) {
  var key = this.deriveHdAccount(account.num, aa.chain, aa.hdindex)
  return key.keyPair.toWIF()
}

CM.prototype.rpc = function (queue, data, headers, numRetries) {
  this.log("[RPC] q: " + queue + (headers ? " h: " + JSON.stringify(headers) : " no headers") + (data ? " data: " + JSON.stringify(data) : " no data"))
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
  // this.log("[STOMP] queue: " + queue + " data: " + JSON.stringify(data) + " typeof(data): " + typeof data)
  if (!headers)
    headers = {}
  headers.id = rpcCounter
  if (data !== undefined && data !== null)
    this.stompClient.send(queue, typeof data === "object" ? JSON.stringify(data) : data, headers)
  else
    this.stompClient.send(queue, "{}", headers)
  var self = this
  return deferred.promise.timeout(this.rpcTimeout).catch(function (err) {
    self.log("[RPC] Ex or Timeout -- res: ", err)
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
  return this.rpc(queue, data).then(function (res) {
    return res.slice
  })
}

// Fetch the STOMP endpoint from the melis discover server
function fetchStompEndpoint(self) {
  var discoveryUrl = self.apiDiscoveryUrl
  self.log("Discovering STOMP endpoint using: ", discoveryUrl)
  return fetch(discoveryUrl, {
    headers: {"user-agent": "melis-js-api/" + C.CLIENT_API_VERSION}
  }).then(function (res) {
    if (res.status !== 200)
      throw new MelisError('DiscoveryEx', 'Bad status code: ' + res.status)
    return res.json()
  }).then(function (discovered) {
    self.log("Discovery result: ", discovered)
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
  self.log("[enableKeepAliveFunc] self.keepAliveFunc: " + self.keepAliveFunc)
  if (self.disableKeepAlive || self.keepAliveFunc)
    return
  self.keepAliveFunc = setInterval(function () {
    keepAliveFunction(self)
  }, (self.maxKeepAliveSeconds / 2 + 1) * 1000)
}

function disableKeepAliveFunc(self) {
  self.log("[disableKeepAliveFunc] self.keepAliveFunc: " + self.keepAliveFunc)
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
  self.log("[CM] stompDisconnected wasConnected: " + wasConnected + " wasPaused: " + wasPaused)// + " err.code: " + frame.code + " err.wasClean: " + frame.wasClean)
  self.connected = false
  self.connecting = false
  self.paused = false
  self.cmConfiguration = null
  disableKeepAliveFunc(self)
  if (deferred)
    deferred.reject(frame)

  //self.log("Open requests: ", Object.keys(self.waitingReplies))
  Object.keys(self.waitingReplies).forEach(function (i) {
    var rpcData = self.waitingReplies[i]
    delete self.waitingReplies[i]
    self.log('[CM] Cancelling open rpc request:', rpcData)
    rpcData.deferred.reject(buildConnectionFailureEx("Disconnected"))
  })
  self.waitinReplies = {}
  emitEvent(self, C.EVENT_DISCONNECT)

  if (wasPaused || !wasConnected)
    return

  if (self.autoReconnectDelay > 0 && self.autoReconnectFunc === null) {
    var timeout = 10 + Math.random() * 10 + Math.random() * (self.autoReconnectDelay / 10)
    self.log("[CM] NEXT AUTO RECONNECT in " + timeout + " seconds")
    self.autoReconnectFunc = setTimeout(function () {
      self.autoReconnectFunc = null
      self.connect(self.lastConfig)
    }, timeout * 1000)
  }
}

function retryConnect(self, config, errorMessage) {
  self.log(errorMessage)
  if (self.autoReconnectDelay > 0) {
    var timeout = 10 + Math.random() * 10 + Math.random() * (self.autoReconnectDelay / 10)
    self.log("[CM] retryConnect in " + timeout + " seconds")
    return Q.delay(timeout * 1000).then(function () {
      self.connecting = false
      return self.connect(config)
    })
  } else
    throwConnectionEx(errorMessage)
}

CM.prototype.connect = function (config) {
  if (this.connecting)
    return Q()
  this.paused = false
  this.connecting = true
  var self = this
  if (this.autoReconnectFunc) {
    clearTimeout(this.autoReconnectFunc)
    this.autoReconnectFunc = null
  }

  if (this.stompClient !== null) {
    if (this.connected)
      return Q(self.cmConfiguration)
    this.stompClient = null
  }

  var discoverer = self.stompEndpoint ?
          Q(self.stompEndpoint) :
          Q(fetchStompEndpoint(self, config)).then(function (discovered) {
    return discovered.stompEndpoint
  })
  return discoverer.then(function (stompEndpoint) {
    return self.connect_internal(stompEndpoint, config)
  }).catch(function (err) {
    self.log("Discover err:", err)
    var errMsg = 'Unable to connect: ' + err.ex + " : " + err.msg
    var callback = config ? config.connectProgressCallback : null
    if (callback && typeof callback === 'function')
      callback({errMsg: errMsg, err: err})
    return retryConnect(self, config, errMsg)
  })
}

CM.prototype.connect_internal = function (stompEndpoint, config) {
  var self = this
  var deferred = Q.defer()
  var options = {debug: false, heartbeat: false, protocols: Stomp.VERSIONS.supportedProtocols()}
  if ((/^wss?:\/\//).test(stompEndpoint)) {
    if (isNode) {
      self.log("[STOMP] Opening websocket (node):", stompEndpoint)
      var ws = new WebSocketClient(stompEndpoint)
      ws.on('error', function (error) {
        self.log('[connect_internal] CONNECT ERROR:' + error.code)
        deferred.reject(error)
      })
      this.stompClient = Stomp.over(ws, options)
    } else {
      self.log("[STOMP] Opening websocket (browser):", stompEndpoint)
      this.stompClient = Stomp.client(stompEndpoint)
    }
  } else {
    self.log("[STOMP] Opening sockjs:", stompEndpoint)
    this.stompClient = Stomp.over(new SockJS(stompEndpoint))
  }

  this.stompClient.debug = function (str) {
    //self.log(str)
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
    self.log("[CM] Connected to websocket: " + frame)
    self.connected = true
    self.connecting = false
    self.paused = false
    emitEvent(self, C.EVENT_CONNECT)

    self.stompClient.subscribe(C.QUEUE_RPC_REPLY, function (message) {
      rpcReplyHandler(self, message)
    })

    self.stompClient.subscribe(C.QUEUE_RPC_ERROR, function (message) {
      rpcErrorHandler(self, message)
    })

    self.stompClient.subscribe(C.QUEUE_SERVER_EVENTS, function (message) {
      //self.log("[CM] Server event: " + message.body)
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
      var msg = JSON.parse(message.body)
      self.lastBlock = msg
      emitEvent(self, C.EVENT_BLOCK, msg)
    })

    self.stompClient.subscribe(C.QUEUE_CONFIG, function (message) {
      var initialEvents = JSON.parse(message.body)
      for (var i = 0; i < initialEvents.length; i++) {
        var event = initialEvents[i]
        emitEvent(self, event.type, event.params)
      }
      if (self.lastOpenParams) {
        self.walletOpen(self.lastOpenParams.seed, self.lastOpenParams).then(function (wallet) {
          emitEvent(self, C.EVENT_SESSION_RESTORED, wallet)
        })
      }
      if (self.cmConfiguration.maxKeepAliveSeconds && self.cmConfiguration.maxKeepAliveSeconds < self.maxKeepAliveSeconds)
        self.maxKeepAliveSeconds = self.cmConfiguration.maxKeepAliveSeconds
      enableKeepAliveFunc(self)
      deferred.resolve(self.cmConfiguration)
    })

  }, function (frame) {
    stompDisconnected(self, frame, deferred)
  })
  return deferred.promise
}

CM.prototype.disconnect = function () {
  var self = this
  disableKeepAliveFunc(self)
  disableAutoReconnect(self)
  if (!this.connected)
    return Q()
  var deferred = Q.defer()
  this.stompClient.disconnect(function (res) {
    //self.log("[STOMP] Disconnect: " + res)
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
    this.sessionSetParams({paused: true})
  return Q()
}

CM.prototype.verifyConnectionEstablished = function (timeout) {
  var self = this
  this.paused = false
  if (!timeout || timeout < 0)
    timeout = 5
  if (timeout > this.maxKeepAliveSeconds)
    timeout = this.maxKeepAliveSeconds
  self.log("[verifyConnectionEstablished] connected: " + this.connected + " timeout: " + timeout + " stompClient: " + (this.stompClient ? "yes" : "no"))
  if (!this.stompClient)
    return Q()
  if (!this.connected)
    return this.connect()
  return this.ping().timeout(timeout * 1000).catch(function (err) {
    self.log("[verifyConnectionEstablished] ping timeout after " + timeout + " seconds")
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
    //self.log("[CM] message to queue " + queue + " : ", res)
    var msg = JSON.parse(res.body)
    callback(msg)
  }, headers)
}

CM.prototype.subscribeToTickerData = function (currency, callback) {
  if (!currency || !callback)
    throwBadParamEx('currency', "Missing currency or callback while subscribing to ticker: " + currency)
  var res = this.subscribe(C.QUEUE_TICKERS_PREFIX + currency, callback)
  return res.ask === 0 ? null : res
}

CM.prototype.subscribeToQuotationHistory = function (currency, callback) {
  if (!currency || !callback)
    throwBadParamEx('currency', "Missing currency or callback while subscribing to history: " + currency)
  var res = this.subscribe(C.QUEUE_QUOTE_HISTORY_PREFIX + currency, callback)
  return res.ask === 0 ? null : res
}

//
// PUBLIC METHODS
//

CM.prototype.getPaymentAddressForAccount = function (accountIdOrAlias, param) {
  var opts = {name: accountIdOrAlias}
  if (param) {
    if (param.memo)
      opts.data = param.memo
    if (param.address)
      opts.address = param.address
  }
  return this.rpc(C.GET_PAYMENT_ADDRESS, opts).then(function (res) {
    //this.log("[CM] getPaymentAddress: ", res)
    return res.address
  })
}

CM.prototype.accountGetPublicInfo = function (params) {
  return this.rpc(C.GET_ACCOUNT_PUBLIC_INFO, {name: params.name, code: params.code}).then(function (res) {
    //this.log("[CM] accountGetPublicInfo: " + JSON.stringify(res))
    return res.account
  })
}

CM.prototype.getWalletChallenge = function () {
  return this.rpc(C.GET_CHALLENGE)
}

//
// UTILITIES
//

CM.prototype.decodeTxFromBuffer = function (buf) {
  return Bitcoin.Transaction.fromBuffer(buf)
}

CM.prototype.createTxBuilderFromTxBuffer = function (buf) {
  return Bitcoin.TransactionBuilder.fromTransaction(this.decodeTxFromBuffer(buf), this.bitcoinNetwork)
}

CM.prototype.wifToEcPair = function (wif) {
  return Bitcoin.ECPair.fromWIF(wif, this.bitcoinNetwork)
}

CM.prototype.signMessageWithKP = function (keyPair, message) {
  var pk = keyPair.d.toBuffer(32)
  return BitcoinMessage.sign(message, this.bitcoinNetwork.messagePrefix, pk, true).toString('base64')
}

CM.prototype.signMessageWithAA = function (account, aa, message) {
  if (account.type !== C.TYPE_PLAIN_HD)
    throw new MelisError('CmBadParamException', 'Only single signature accounts can sign messages')
  var key = this.deriveHdAccount(account.num, aa.chain, aa.hdindex)
  return this.signMessageWithKP(key.keyPair, message)
}

CM.prototype.verifyBitcoinMessageSignature = function (address, signature, message) {
  //return Bitcoin.message.verify(address, signature, message, this.bitcoinNetwork)
  return BitcoinMessage.verify(message, this.bitcoinNetwork.messagePrefix, address, new Buffer(signature, 'base64'))
}

CM.prototype.decodeAddressFromScript = function (script) {
  return Bitcoin.address.fromOutputScript(script, this.bitcoinNetwork)
}

CM.prototype.addressFromPubKey = function (pubKey) {
  return pubKey.getAddress(this.bitcoinNetwork)
}

CM.prototype.extractPubKeyFromOutputScript = function (script) {
  var type = Bitcoin.script.classifyOutput(script)
  if (type === "pubkey") {
    //return Bitcoin.ECPubKey.fromBuffer(script.chunks[0])
    var decoded = Bitcoin.script.decompile(script)
    //this.log("Decoded:"); this.log(decoded)
    return Bitcoin.ECPair.fromPublicKeyBuffer(decoded[0], this.bitcoinNetwork)
  }
  return null
}

CM.prototype.pushTx = function (hex) {
  return this.rpc(C.UTILS_PUSH_TX, {hex: hex})
}

CM.prototype.getFeeInfo = function () {
  return this.rpc(C.UTILS_FEE_INFO)
}

CM.prototype.ping = function () {
  return this.rpc(C.UTILS_PING)
}

CM.prototype.logException = function (account, data, deviceId, agent) {
  return this.rpc(C.UTILS_LOG_EX, {
    pubId: account ? account.pubId : null,
    data: data,
    deviceId: deviceId,
    ua: typeof agent === "object" ? agent : {application: agent}
  })
}

CM.prototype.logData = function (account, data, deviceId, agent) {
  return this.rpc(C.UTILS_LOG_DATA, {
    pubId: account.pubId,
    data: data,
    deviceId: deviceId,
    ua: typeof agent === "object" ? agent : {application: agent}
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
    self.log("[CM] setDeviceName:", res)
    return {deviceId: res.info}
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
    self.log("[CM] getDevicePassword:", res)
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

CM.prototype.deviceCancelPromotion = function () {
  return this.rpc(C.WALLET_DEVICE_CANCEL_PROMOTION)
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

CM.prototype.walletOpen = function (seed, params) {
  var self = this
  if (!params)
    params = {}
  return this.getWalletChallenge().then(function (res) {
    var challengeHex = res.challenge
    //self.log("[CM] walletOpen challenge: " + challengeHex + " seed: " + seed + " network: " + JSON.stringify(self.bitcoinNetwork))
    var hd = Bitcoin.HDNode.fromSeedHex(seed, self.bitcoinNetwork)
    // Keep the public key for ourselves
    var loginKey = self.deriveKeyFromPath(hd, self.getLoginPath())
    var buf = new Buffer(challengeHex, 'hex')
    var signature = loginKey.sign(buf)
    //self.log("child: " + child.getPublicKeyBuffer().toString('hex')() + " sig: " + signature)
    //self.log("pubKey: " + masterPubKey + " r: " + signature.r.toString() + " s: " + signature.s.toString())
    return self.rpc(C.WALLET_OPEN, {
      id: loginKey.getPublicKeyBuffer().toString('hex'),
      signatureR: signature.r.toString(), signatureS: signature.s.toString(),
      sessionName: params.sessionName,
      deviceId: params.deviceId,
      usePinAsTfa: params.usePinAsTfa
    }).then(function (res) {
      var wallet = res.wallet
      self.log("[CM] walletOpen pubKey:" + wallet.pubKey + " #accounts: " + Object.keys(wallet.accounts).length)
      walletOpen(self, hd, wallet)
      self.lastOpenParams = {seed: seed, sessionName: params.sessionName, deviceId: params.deviceId}
      return wallet
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
    var hd = Bitcoin.HDNode.fromSeedHex(seed, self.bitcoinNetwork)
    loginKey = self.deriveKeyFromPath(hd, self.getLoginPath())
    //self.log('REGISTER hd: ', hd, ' loginKey: ', loginKey)
  } catch (error) {
    var ex = {ex: "clientAssertFailure", msg: error.message}
    self.log(ex)
    return Q.reject(ex)
  }
  return self.rpc(C.WALLET_REGISTER, {
    xpub: loginKey.neutered().toBase58(),
    //id: loginKey.getPublicKeyBuffer().toString('hex'),
    //chainCode: loginKey.chainCode.toString('hex'),
    sessionName: params.sessionName,
    deviceId: params.deviceId,
    usePinAsTfa: params.usePinAsTfa
  }).then(function (res) {
    self.log("[CM] walletRegister: ", res)
    walletOpen(self, hd, res.wallet)
    self.lastOpenParams = {seed: seed, sessionName: params.sessionName, deviceId: params.deviceId}
    return res.wallet
  })
}

CM.prototype.walletClose = function () {
  var self = this
  return self.rpc(C.WALLET_CLOSE).then(function (res) {
    walletClose(self)
    return res
  })
}

CM.prototype.walletGetNumSessions = function () {
  return this.rpc(C.WALLET_GET_NUM_SESSIONS).then(function (res) {
    //console.log("[CM] number of sessions with wallet open: " + JSON.stringify(res))
    return res.numWalletSessions
  })
}

CM.prototype.walletGetNotifications = function (fromDate, pagingInfo) {
  var pars = addPagingInfo({fromDate: fromDate}, pagingInfo)
  return this.simpleRpcSlice(C.WALLET_GET_NOTIFICATIONS, pars)
}

CM.prototype.walletGetInfo = function () {
  var self = this
  return this.rpc(C.WALLET_GET_INFO).then(function (res) {
    self.log("walletGetInfo:", res)
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
  return this.rpc(C.WALLET_PUSH_REGISTER_GOOGLE, {data: token})
}

CM.prototype.aliasGetInfo = function (account) {
  return this.rpc(C.ACCOUNT_ALIAS_INFO, {pubId: account.pubId})
}

CM.prototype.aliasIsAvailable = function (alias) {
  return this.rpc(C.ACCOUNT_ALIAS_AVAILABLE, {name: alias})
}

CM.prototype.aliasDefine = function (account, alias) {
  return this.rpc(C.ACCOUNT_ALIAS_DEFINE, {pubId: account.pubId, name: alias})
}

CM.prototype.walletMetaSet = function (name, value) {
  return this.rpc(C.WALLET_META_SET, {name: name, meta: value})
}

CM.prototype.walletMetaGet = function (param) {
  if (Array.isArray(param))
    return this.rpc(C.WALLET_META_GET, {names: param})
  else
    return this.rpc(C.WALLET_META_GET, {name: param}).then(function (res) {
      return res.meta
    })
}

CM.prototype.walletMetasGet = function (pagingInfo) {
  var pars = addPagingInfo({}, pagingInfo)
  return this.simpleRpcSlice(C.WALLET_METAS_GET, pars)
}

CM.prototype.walletMetaDelete = function (name) {
  return this.rpc(C.WALLET_META_DELETE, {name: name})
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
  var numPromise
  if (params.accountNum === undefined)
    numPromise = this.getFreeAccountNum()
  else
    numPromise = Q(params.accountNum)
  var self = this
  return numPromise.then(function (accountNum) {
    params.accountNum = accountNum
    var accountHd = self.deriveHdAccount(accountNum)
    params.xpub = accountHd.neutered().toBase58()
    return self.rpc(C.ACCOUNT_REGISTER, params)
  }).then(function (res) {
    updateAccount(self, res.account, res.balance, res.accountInfo)
    return res
  })
}

CM.prototype.accountJoin = function (params) {
  this.log("[CM] joinWallet params:", params)
  var numPromise
  if (params.accountNum === undefined)
    numPromise = this.getFreeAccountNum()
  else
    numPromise = Q(params.accountNum)
  var self = this
  return numPromise.then(function (accountNum) {
    var accountHd = self.deriveHdAccount(accountNum)
    return self.rpc(C.ACCOUNT_JOIN, {
      code: params.code,
      accountNum: accountNum,
      xpub: accountHd.neutered().toBase58(),
      meta: params.meta
    })
  }).then(function (res) {
    updateAccount(self, res.account, res.balance, res.accountInfo)
    return res
  })
}

CM.prototype.accountRefresh = function (account) {
  var self = this
  return this.rpc(C.ACCOUNT_REFRESH, {
    pubId: account.pubId
  }).then(function (res) {
    updateAccount(self, res.account, res.balance, res.accountInfo)
    return res
  })
}

CM.prototype.accountUpdate = function (account, options) {
  if (!options || typeof options !== 'object')
    return
  this.log("[accountUpdate] " + account.pubId + " :", options)
  var self = this
  return this.rpc(C.ACCOUNT_UPDATE, {
    pubId: account.pubId,
    hidden: options.hidden,
    meta: options.meta,
    tfa: options.tfa,
    pubMeta: options.pubMeta
  }).then(function (res) {
    updateAccount(self, res.account, res.balance, res.accountInfo)
    return res
  })
}

CM.prototype.accountDelete = function (account) {
  var self = this
  return this.rpc(C.ACCOUNT_DELETE, {pubId: account.pubId}).then(function (res) {
    delete self.walletData.accounts[account.num]
    delete self.walletData.balances[account.num]
    delete self.walletData.infos[account.num]
    return res
  })
}

CM.prototype.accountGetInfo = function (account) {
  var self = this
  return this.rpc(C.ACCOUNT_GET_INFO, {pubId: account.pubId}).then(function (res) {
    updateAccountInfo(self, account, res)
    return res
  })
}

CM.prototype.joinCodeGetInfo = function (code) {
  return this.rpc(C.ACCOUNT_GET_JOIN_CODE_INFO, {code: code})
}

CM.prototype.getLocktimeDays = function (account) {
  return this.rpc(C.ACCOUNT_GET_LOCKTIME_DAYS, {
    pubId: account.pubId
  }).then(function (res) {
    return res
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
  if (meta && Object.keys(meta).length === 0)
    meta = null
  if (labels && labels.length === 0)
    labels = null
  var self = this
  return this.rpc(C.ACCOUNT_GET_UNUSED_ADDRESS, {
    pubId: account.pubId,
    address: address,
    labels: labels,
    meta: meta
  }).then(function (res) {
    return res.address
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
  }).then(function (res) {
    return res.address
  })
}

CM.prototype.addressRelease = function (account, address) {
  return this.rpc(C.ACCOUNT_ADDRESS_RELEASE, {
    pubId: account.pubId,
    address: address
  }).then(function (res) {
    return res.address
  })
}

CM.prototype.addressGet = function (account, address, optionsAndPaging) {
  var pars = addPagingInfo({pubId: account.pubId, address: address}, optionsAndPaging)
  if (optionsAndPaging && optionsAndPaging.includeTxInfos)
    pars.includeTxInfos = optionsAndPaging.includeTxInfos
  return this.rpc(C.ACCOUNT_ADDRESS_GET, pars)
}

CM.prototype.addressesGet = function (account, optionsAndPaging) {
  var pars = addPagingInfo({pubId: account.pubId}, optionsAndPaging)
  if (optionsAndPaging && optionsAndPaging.onlyActives)
    pars.onlyActives = optionsAndPaging.onlyActives
  return this.simpleRpcSlice(C.ACCOUNT_ADDRESSES_GET, pars)
}

CM.prototype.addLegacyAddress = function (account, keyPair, params) {
  var data = this.prepareAddressSignature(keyPair, C.MSG_PREFIX_LEGACY_ADDR)
  return this.rpc(C.WALLET_ADD_LEGACY_ADDRESS, {
    pubId: account.pubId,
    address: data.address,
    data: data.base64Sig,
    labels: params ? params.labels : null,
    meta: params ? params.meta : null
  })
}

CM.prototype.accountGetNotifications = function (account, fromDate, pagingInfo) {
  var pars = addPagingInfo({pubId: account.pubId, fromDate: fromDate}, pagingInfo)
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
  return this.rpc(C.ACCOUNT_GET_ALL_LABELS, {pubId: account ? account.pubId : null})
}

CM.prototype.ptxPrepare = function (account, recipients, options) {
  this.log("[CM ptxPrepare] account: " + account.pubId + " to: " + JSON.stringify(recipients) + " opts: ", options)
  options = options || {}
  var params = {
    pubId: account.pubId,
    recipients: recipients,
    unspents: options.unspents,
    tfa: options.tfa,
    ptxOptions: {}
  }
  if (options.selectAllUnspents)
    params.ptxOptions.selectAllUnspents = options.selectAllUnspents
  if (options.feeMultiplier)
    params.ptxOptions.feeMultiplier = options.feeMultiplier
  if (options.allowUnconfirmed)
    params.ptxOptions.allowUnconfirmed = options.allowUnconfirmed
  if (options.doInstant)
    params.ptxOptions.doInstant = options.doInstant
  if (options.disableRbf)
    params.ptxOptions.disableRbf = options.disableRbf
  if (options.satoshisPerByte)
    params.ptxOptions.satoshisPerByte = options.satoshisPerByte
  this.log("[CM ptxPrepare] params:", params)
  return this.rpc(C.ACCOUNT_PTX_PREPARE, params)
}

CM.prototype.ptxFeeBump = function (id, options) {
  if (!options || !options.feeMultiplier)
    throwBadParamEx("options.feeMultiplier", "Missing feeMultiplier")
  var ptxOptions = {feeMultiplier: options.feeMultiplier}
  var params = {data: id, ptxOptions: ptxOptions}
  return this.rpc(C.ACCOUNT_PTX_FEE_BUMP, params)
}

CM.prototype.ptxGetById = function (id) {
  return this.rpc(C.ACCOUNT_PTX_GET, {data: id})
}

CM.prototype.ptxGetByHash = function (hash) {
  return this.rpc(C.ACCOUNT_PTX_GET, {hash: hash})
}

CM.prototype.ptxCancel = function (ptx) {
  return this.rpc(C.ACCOUNT_PTX_CANCEL, {data: ptx.id})
}

CM.prototype.ptxSignFields = function (account, ptx) {
  var num1 = simpleRandomInt(C.MAX_SUBPATH), num2 = simpleRandomInt(C.MAX_SUBPATH)
  var node = this.deriveHdAccount(account.num, num1, num2)
  var sig = this.signMessageWithKP(node.keyPair, ptx.rawTx)
  //return { keyPath: [num1, num2], base64Sig: sig.toString('base64')}
//    var verified = self.verifyMessage(node.keyPair.getAddress(), sig, msg)
//    this.log("our xpub: : " + ptx.accountPubId + " path: " + keyPath[0] + " " + keyPath[1])
//    this.log("address: " + node.keyPair.getAddress() + " msg: " + msg + " SIG: " + sig.toString('base64') + " VERIFY: " + verified)
//    var keyMessage = {keyPath: keyPath, ptxSig: sig.toString('base64'), type: 'fullAES'}
  return this.rpc(C.ACCOUNT_PTX_SIGN_FIELDS, {
    data: ptx.id,
    num1: num1,
    num2: num2,
    signatures: [sig]
  }).then(function (res) {
    return res
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
  var self = this
  return this.ensureAccountInfo(account).then(function (account) {
    if (!self.ptxHasFieldsSignature(ptx))
      throwInvalidSignatureEx("PTX owner signature missing")
    var xpub = account.xpub
    if (account.numCosigners > 0) {
      var cosignerData = self.peekAccountInfo(account).cosigners.find(function (cosigner) {
        return cosigner.pubId === ptx.accountPubId
      })
      if (!cosignerData)
        throwInvalidSignatureEx("PTX owner not found: " + ptx.accountPubId)
      xpub = cosignerData.xpub
    }
    var keyMessage = ptx.meta.ownerSig
    self.log("ptx keyMessage:", keyMessage)
    var keyPath = keyMessage.keyPath
    var hd = Bitcoin.HDNode.fromBase58(xpub, self.bitcoinNetwork)
    var node = hd.derive(keyPath[0]).derive(keyPath[1])
    var address = node.keyPair.getAddress()
    var ptxSigVerified = false
    try {
      ptxSigVerified = self.verifyBitcoinMessageSignature(address, keyMessage.ptxSig, ptx.rawTx)
      self.log("[CM] ptx#" + ptx.id + " address: " + address + " VERIFIED: " + ptxSigVerified)
    } catch (ex) {
      self.log("verifyBitcoinMessageEx: ", ex)
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
  // this.log("[CM signaturesPrepare] txId: " + ptx.id)
  var self = this
  var hd = params.hd || this.hdWallet
  var accountNum = params.accountNum
  var progressCallback = params.progressCallback
  var tx = this.decodeTxFromBuffer(new Buffer(params.rawTx, 'hex'))
  var inputs = params.inputs
  var signatures = []
  var network = params.network || this.bitcoinNetwork
  var signInput = function (i) {
    var inputInfo = inputs[i]
    self.log("signInput #" + i + " account#: " + accountNum + " info: '" + JSON.stringify(inputInfo) + "' network: ", network)
    if (!inputInfo)
      throwUnexpectedEx("Internal error: can't find info data for tx input #" + i)
    var accountAddress = inputInfo.aa
    var key = self.deriveHdAccount_explicit(network, hd, accountNum, accountAddress.chain, accountAddress.hdindex)
    var redeemScript
    if (accountAddress.redeemScript)
      redeemScript = new Buffer(accountAddress.redeemScript, "hex")
    else
      redeemScript = Bitcoin.address.toOutputScript(key.getAddress(), network) // o inputInfo.script
    //self.log("aa.script " + accountAddress.redeemScript)
    var hashForSignature
    //if (account && account.chain.indexOf(C.CHAIN_BCH) >= 0)
    if (inputInfo.chain.indexOf(C.CHAIN_PROD_BCH) >= 0)
      hashForSignature = tx.hashForWitnessV0(i, redeemScript, inputInfo.amount, Bitcoin.Transaction.SIGHASH_ALL + Bitcoin.Transaction.SIGHASH_BITCOINCASHBIP143)
    else
      hashForSignature = tx.hashForSignature(i, redeemScript, Bitcoin.Transaction.SIGHASH_ALL)
    var signature = key.sign(hashForSignature)
    //var sigHex = signature.toDER().toString('hex') // signature.toScriptSignature(Bitcoin.Transaction.SIGHASH_ALL)
    //signatures.push(sigHex)
    //self.log("[signed input #" + i + "] redeemScript: " + redeemScript.buffer.toString('hex') +
    //        " hashForSignature: " + hashForSignature.toString('hex')) // + " sig: " + sig.toString('hex'))
    signatures.push({key: key, sig: signature})
  }
  var deferred = Q.defer()
  var f = function (i) {
    var progressInfo = {currStep: i, totalSteps: tx.ins.length}
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
  self.log("[CM signaturesSubmit] sigs: " + signatures + " txId: " + txId + " account: ", account)
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
  for (var i = 0; i < addresses.length; i++)
    if (!this.isAddressOfAccount(account, addresses[i].aa))
      return false
  return true
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

function derivePubKeys(xpubs, chain, hdIndex, network) {
  var keys = []
  for (var i = 0; i < xpubs.length; i++) {
    var hd = Bitcoin.HDNode.fromBase58(xpubs[i], network)
    var key = hd.derive(chain).derive(hdIndex)
    keys.push(key.getPublicKeyBuffer().toString('hex'))
  }
  return keys
}

CM.prototype.calcP2SH = function (accountInfo, chain, hdIndex, network) {
  var scriptParams = accountInfo.scriptParams
  var script
  var hasMandatoryKeys = scriptParams.mandatoryKeys && scriptParams.mandatoryKeys.length > 0
  var hasOtherKeys = scriptParams.otherKeys && scriptParams.otherKeys.length > 0
  this.log("minSignatures: " + accountInfo.minSignatures + " hasMandatoryKeys: " + hasMandatoryKeys + " hasOtherKeys: " + hasOtherKeys + " scriptParams: ", scriptParams)
  if (hasMandatoryKeys) {
    this.log("[calcP2SH] #mandatoryKeys: " + scriptParams.mandatoryKeys.length, scriptParams.mandatoryKeys)
    script = createRedeemScript(derivePubKeys(scriptParams.mandatoryKeys, chain, hdIndex, network), scriptParams.mandatoryKeys.length, hasOtherKeys)
    if (hasOtherKeys) {
      this.log("[calcP2SH] #otherKeys: " + scriptParams.otherKeys.length, scriptParams.otherKeys)
      var minimumNonMandatorySignatures = accountInfo.minSignatures - scriptParams.mandatoryKeys.length
      if (accountInfo.serverMandatory)
        minimumNonMandatorySignatures++
      if (minimumNonMandatorySignatures <= 0)
        throwUnexpectedEx("Unable to create address for account: unexpected signature scheme (minimumNonMandatorySignatures=" + minimumNonMandatorySignatures + ")")
      script += " " + createRedeemScript(derivePubKeys(scriptParams.otherKeys, chain, hdIndex, network), minimumNonMandatorySignatures, false)
    }
  } else {
    if (!hasOtherKeys)
      throwUnexpectedEx("Unexpected account info: no mandatory and other keys")
    this.log("[calcP2SH] #otherKeys: " + scriptParams.otherKeys.length, scriptParams.otherKeys)
    script = createRedeemScript(derivePubKeys(scriptParams.otherKeys, chain, hdIndex, network), accountInfo.minSignatures, false)
  }
  this.log("[calcP2SH] script: " + script)
  var redeemScript = Bitcoin.script.fromASM(script)
  var scriptPubKey = Bitcoin.script.scriptHash.output.encode(Bitcoin.crypto.hash160(redeemScript))
  //this.log("redeemScript: ", Bitcoin.script.toASM(redeemScript))
  //this.log("scriptPubKey: ", Bitcoin.script.toASM(scriptPubKey))
  return Bitcoin.address.fromOutputScript(scriptPubKey, network)
}

CM.prototype.isAddressOfAccount = function (account, accountAddress) {
  var addr
  switch (account.type) {
    case C.TYPE_PLAIN_HD:
      var key = this.deriveHdAccount(account.num, accountAddress.chain, accountAddress.hdindex)
      addr = key.getAddress()
      break
    default:
      var info = this.peekAccountInfo(account)
      addr = this.calcP2SH(info, accountAddress.chain, accountAddress.hdindex, this.bitcoinNetwork)
  }
  this.log("[isAddressesOfAccount] type: " + account.type + " accountAddress: " + accountAddress.address + " calcAddr: " + addr)
  return accountAddress.address === addr
}

// updates accountInfo if missing or incomplete
CM.prototype.ensureAccountInfo = function (account) {
  var self = this
  var info = self.peekAccountInfo(account)
  if (!info || (info.cosigners && info.cosigners.length > 1 && !info.scriptParams))
    return self.accountGetInfo(account).then(function (info) {
      if (info.cosigners && info.cosigners.length > 1 && !info.scriptParams)
        throwUnexpectedEx("Account not complete yet: have cosigners joined?")
      return account
    })
  else
    return Q(account)
}

CM.prototype.analyzeTx = function (state, options) {
  if (options && options.skipAnalyze)
    return null
  if (options && options.forceValidationError) {
    // For regression testing
    return {validated: false, error: options.forceValidationError}
  }
  var account = state.account
  var recipients = state.recipients || []
  var ptx = state.ptx
  var inputs = ptx.inputs
  var changes = ptx.changes || []
  var tx = this.decodeTxFromBuffer(new Buffer(ptx.rawTx, 'hex'))
  var amountInOur = 0
  var amountInOther = 0
  var amountToRecipients = 0
  var amountToChange = 0
  var amountToUnknown = 0
  var error
  var i, j
  //this.log("ANALYZE", ptx)

  // TODO: Per conoscere gli amount degli input dobbiamo usare un servizio come chain.so o similare
//  if (this.externalTxValidator && !this.isRegTest()) {
//    var provider = BlockChainApi.getProvider(this.externalTxValidator)
//    if (provider) {
//      provider.api.getTxOutputs(tx.ins).then(function (res) {
//                ...
//      })
//    }
//  }

  // TODO: This code must be updated when the transaction contains unknown inputs, like in CoinJoin
  for (i = 0; i < tx.ins.length; i++) {
    var txInput = tx.ins[i]
    this.log("INPUT #" + i + " " + txInput.hash.toString('hex') + "/" + txInput.index)
    for (j = 0; j < inputs.length; j++) {
      var preparedInput = inputs[j]
      var prepInputHash = new Buffer(preparedInput.tx, 'hex').reverse()
      if (txInput.hash.equals(prepInputHash) && txInput.index === preparedInput.n) {
        // We have to trust the server if we don't use an external service (leaking private infos)
        amountInOur += preparedInput.amount
      } else {
        // The amount is unknown: we need segwit or external block explorer info
        //amountInOther += txInput.amount
      }
    }
  }

  // Calc amount for defined recipients, for the change, and to unknown addresses

  // If recipients are Melis accounts we need to trust the server
  for (j = 0; j < recipients.length; j++)
    if (recipients[j].pubId)
      recipients[j].validated = true

  // Mark our recipients to verify that none is left out
  for (i = 0; i < tx.outs.length; i++) {
    var output = tx.outs[i]
    var toAddr = this.decodeAddressFromScript(output.script)
    var isChange = false
    for (j = 0; j < changes.length; j++) {
      if (toAddr === changes[j].aa.address) {
        amountToChange += output.value
        isChange = true
        break
      }
      this.log("[Analyze] Output #" + i + " to: " + toAddr + " amount: " + output.value + " isChange: " + isChange)
    }
    if (!isChange) {
      var isRecipient = false
      for (j = 0; j < recipients.length; j++) {
        var recipient = recipients[j]
        if (recipient.pubId)
          continue
        if (toAddr === recipient.address) {
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
  var extimatedTxSize = this.estimateTxSizeFromAccountInfo(this.peekAccountInfo(account), tx)
  var maximumAcceptableFee = extimatedTxSize * this.fees.maximumAcceptable
  var fees = amountInOur - amountToRecipients - amountToChange - amountToUnknown
  if (!error)
    if (fees > maximumAcceptableFee)
      error = "Fees too high"
    else if (fees !== ptx.fees)
      error = "Calculated fees does not match server info"
    else if (amountToRecipients + amountToUnknown > 0 && fees > amountToRecipients + amountToUnknown)
//  else if (fees > amountToChange &&
//          (fees > (amountToRecipients + amountToUnknown) || (amountToRecipients === 0 && amountToUnknown === 0)))
      error = "Fees (" + fees + ") would be greater than total outputs of transaction (" + amountToRecipients + "/" + amountToUnknown + "/" + amountToChange + ")"
    else if (!this.areAddressesOfAccount(account, changes))
      error = "Change address not validated"
//    else if (amountToUnknown !== 0)
//      error = "Destination address not validated"
  this.log("[ANALYZE] amountInOur: " + amountInOur + " amountInOther: " + amountInOther + " amountToRecipients: " + amountToRecipients + " amountToChange: " + amountToChange + " amountToUnknown: " + amountToUnknown)
  this.log("[ANALYZE] fees: " + fees + " maxAcceptableFees: " + maximumAcceptableFee + " ptx.fees: " + ptx.fees + " extimatedTxSize: " + extimatedTxSize + " error: " + error + " feeData: ", this.fees)
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
  var recipients = [{address: address, isRemainder: true, amount: 0}]
  return this.payPrepare(account, recipients, options)
}

CM.prototype.payPrepare = function (account, recipients, options) {
  var self = this
  if (!recipients)
    recipients = []
  if (recipients.length === 0 && (!options || !options.unspents))
    return failPromiseWithBadParam("recipients", "Missing recipients or inputs to rotate")
  recipients.forEach(function (recipient) {
    if (!recipient.address || !self.validateAddress(recipient.address))
      return failPromiseWithBadParam("address", "Invalid address: " + recipient.address)
    var v = parseInt(recipient.amount)
    if (!v || v <= 0)
      return failPromiseWithBadParam("amount", "Invalid amount: " + v)
    recipient.amount = v
  })
  var state = {account: account, recipients: recipients}
  return this.ensureAccountInfo(account).then(function (account) {
    state.account = account
    return self.ptxPrepare(account, recipients, options)
  }).then(function (res) {
    state.ptx = res.ptx
    return self.updateNetworkFees()
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
  return this.ptxVerifyFieldsSignature(state.account, state.ptx).then(function () {
    return self.signaturesPrepare({
      accountNum: state.account.num,
      progressCallback: state.progressCallback,
      rawTx: state.ptx.rawTx,
      inputs: state.ptx.inputs
    })
  }).then(function (signatures) {
    return self.signaturesSubmit(state, signatures.map(function (o) {
      return o.sig.toDER().toString('hex')
    }), tfa)
  })
}

CM.prototype.payAllToAddress = function (account, address, options) {
  options = options || {}
  options.selectAllUnspents = true
  var recipients = [{address: address, isRemainder: true, amount: 0}]
  return this.payRecipients(account, recipients, options)
}

CM.prototype.payRecipients = function (account, recipients, options) {
  var self = this
  options = options || {}
  options.autoSignIfValidated = true
  return this.payPrepare(account, recipients, options).then(function (state) {
    if (state.summary.validated) {
      return self.payConfirm(state, options ? options.tfa : undefined).then(function (hash) {
        state.hash = hash
        return state
      })
    } else {
      var ex = {ex: "clientValidationFailure", msg: "Self validation not passed", error: state.summary.error}
      self.log(ex)
      return Q.reject(ex)
    }
  })
}

CM.prototype.getExpiringUnspents = function (account, pagingInfo) {
  var pars = addPagingInfo({pubId: account.pubId}, pagingInfo)
  return this.simpleRpcSlice(C.ACCOUNT_GET_EXPIRING_UNSPENTS, pars)
}

CM.prototype.getUnspents = function (account, pagingInfo) {
  var pars = addPagingInfo({pubId: account.pubId}, pagingInfo)
  return this.simpleRpcSlice(C.ACCOUNT_GET_UNSPENTS, pars)
}

//
// Spending limits
//

CM.prototype.accountGetLimits = function (account) {
  this.log("[CM accountGetLimits] account: ", account)
  return this.rpc(C.ACCOUNT_LIMITS_GET, {
    pubId: account.pubId
  })
}

CM.prototype.accountSetLimit = function (account, limit, tfa) {
  this.log("[CM accountSetLimit] limit: " + JSON.stringify(limit) + " account:", account)
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
  this.log("[CM accountCancelLimitChange] " + limitType + " account:", account)
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

CM.prototype.tfaGetWalletConfig = function () {
  return this.rpc(C.TFA_GET_WALLET_CONFIG).then(function (res) {
    return res.tfaConfig
  })
}

CM.prototype.tfaEnrollStart = function (params, tfa) {
  if (!params.name)
    throwBadParamEx('params', "Missing name")
  this.log("[CM tfaEnrollStart] name: " + params.name + " value: " + params.value + " tfa: " + (tfa ? JSON.stringify(tfa) : "NONE"))
  return this.rpc(C.TFA_ENROLL_START, {
    name: params.name,
    value: params.value,
    data: params.data,
    address: params.appId,
    meta: params.meta,
    tfa: tfa
  }).then(function (res) {
    //console.log("tfaEnrollStart: " + JSON.stringify(res))
    return res.tfaRes
  })
}

CM.prototype.tfaEnrollFinish = function (tfa) {
  return this.rpc(C.TFA_ENROLL_FINISH, {tfa: tfa}).then(function (res) {
    //console.log("tfaEnrollFinish: " + JSON.stringify(res))
    return res.tfaRes
  })
}

CM.prototype.tfaDeviceDelete = function (param, tfa) {
  return this.rpc(C.TFA_DEVICE_DELETE, {
    name: param.name,
    value: param.value,
    tfa: tfa
  }).then(function (res) {
    //console.log("tfaDeviceDelete: ", res)
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
    value: params.value,
    address: params.appId
  }).then(function (res) {
    //console.log("tfaRequestCode: " + JSON.stringify(res))
    return res.tfaRes
  })
}

CM.prototype.tfaAuthValidate = function (tfa) {
  return this.rpc(C.TFA_AUTH_VALIDATE, {tfa: tfa}).then(function (res) {
    //console.log("tfaAuthValidate: " + JSON.stringify(res))
    return res.tfaRes
  })
}

CM.prototype.tfaGetAccountConfig = function (account) {
  return this.rpc(C.TFA_GET_ACCOUNT_CONFIG, {pubId: account.pubId}).then(function (res) {
    //console.log("res: " + JSON.stringify(res))
    return res.tfaConfig
  })
}

CM.prototype.tfaSetAccountConfig = function (account, config, tfa) {
  this.log("[CM tfaSetAccountConfig] config: " + JSON.stringify(config))
  return this.rpc(C.TFA_SET_ACCOUNT_CONFIG, {
    pubId: account.pubId,
    data: config.policy,
    tfa: tfa
  }).then(function (res) {
    //console.log("res: " + JSON.stringify(res))
    return res.tfaConfig
  })
}

//
// Address book methods
//

CM.prototype.abAdd = function (entry) {
  this.log("[CM ab add] " + JSON.stringify(entry))
  return this.rpc(C.AB_ADD, {
    type: entry.type,
    val: entry.val,
    labels: entry.labels,
    meta: entry.meta
  })
}

CM.prototype.abUpdate = function (entry) {
  this.log("[CM abUpdate] " + JSON.stringify(entry))
  return this.rpc(C.AB_UPDATE, {
    id: entry.id,
    type: entry.type,
    val: entry.val,
    labels: entry.labels,
    meta: entry.meta
  })
}

CM.prototype.abDelete = function (entry) {
  this.log("[CM ab delete] " + JSON.stringify(entry))
  return this.rpc(C.AB_DELETE, {id: entry.id})
}

CM.prototype.abGet = function (fromDate, pagingInfo) {
  //console.log("[CM ab get] since: " + fromDate)
  var pars = addPagingInfo({fromDate: fromDate}, pagingInfo)
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
  var pars = addPagingInfo({fromDate: fromDate}, pagingInfo)
  return this.simpleRpcSlice(C.MSG_GET_ALL_TO_WALLET, pars)
}

CM.prototype.msgGetAllToPtx = function (ptx, fromDate, pagingInfo) {
  var pars = addPagingInfo({toPtx: ptx.id, fromDate: fromDate}, pagingInfo)
  return this.simpleRpcSlice(C.MSG_GET_ALL_TO_PTX, pars)
}

CM.prototype.msgGetAllToPtxs = function (fromDate, pagingInfo) {
  var pars = addPagingInfo({fromDate: fromDate}, pagingInfo)
  return this.simpleRpcSlice(C.MSG_GET_ALL_TO_PTXS, pars)
}

//
// Utilities
//

CM.prototype.sessionSetParams = function (params, tfa) {
  var par = {tfa: tfa}
  var validProps = ['locale', 'currency', 'paused', 'usePinAsTfa']
  validProps.forEach(function (p) {
    if (params[p] !== undefined)
      par[p] = params[p]
  })
  return this.rpc(C.SESSION_SET_PARAMS, par)
}

CM.prototype.getNetworkFees21 = function () {
  var self = this
  return fetch("https://bitcoinfees.21.co/api/v1/fees/recommended").then(function (res) {
    if (res && res.status === 200)
      return res.json()
    else
      return null
  }).then(function (val) {
    if (!val || !val.fastestFee)
      return null
    return {
      provider: "21.co",
      fastestFee: val.fastestFee,
      mediumFee: val.halfHourFee,
      slowFee: val.hourFee
    }
  }).catch(function (err) {
    self.log("Error reading fees from 21.co:", err)
    return Q(null)
  })
}

CM.prototype.getNetworkFeesBlockCypher = function () {
  var self = this
  return fetch("https://api.blockcypher.com/v1/btc/main").then(function (res) {
    if (res && res.status === 200)
      return res.json()
    else
      return null
  }).then(function (val) {
    if (!val.high_fee_per_kb)
      return null
    return {
      provider: "blockcypher.com",
      fastestFee: Math.round(val.high_fee_per_kb / 1024),
      mediumFee: Math.round(val.medium_fee_per_kb / 1024),
      slowFee: Math.round(val.low_fee_per_kb / 1024)
    }
  }).catch(function (err) {
    self.log("Error reading fees from blockcypher.com:", err)
    return Q(null)
  })
}

CM.prototype.getNetworkFeesBitgo = function () {
  var self = this
  return fetch("https://www.bitgo.com/api/v1/tx/fee?numBlocks=4").then(function (res) {
    if (res && res.status === 200)
      return res.json()
    else
      return null
  }).then(function (val) {
    if (!val.feePerKb)
      return null
//    if (!val.feeByBlockTarget || !val.feeByBlockTarget[2] || !val.feeByBlockTarget[4] || !val.feeByBlockTarget[10])
//      return null
    return {
      provider: "bitgo.com",
      fastestFee: Math.round(val.feePerKb / 1024),
      mediumFee: Math.round((val.feePerKb * 0.8) / 1024),
      slowFee: Math.round((val.feePerKb * 0.6) / 1024)
    }
  }).catch(function (err) {
    self.log("Error reading fees from bitgo:", err)
    return Q(null)
  })
}

// TODO: https://shapeshift.io/btcfee

CM.prototype.updateNetworkFeesFromExternalProviders = function () {
  var self = this
  var maxTries = this.feeProviders.length
  function getFees(n) {
    var provider = self.calcNextFeeProvider()
    return provider().then(function (res) {
      if (res)
        return res
      if (n >= maxTries)
        return null
      else
        return getFees(n + 1)
    })
  }
  return getFees(0).then(function (res) {
    if (!res)
      return null
    return self.fees = {
      detail: res,
      fastestFee: res.fastestFee,
      maximumAcceptable: res.fastestFee * 3,
      lastUpdated: new Date()
    }
  })
}

CM.prototype.updateNetworkFees = function () {
  var self = this
  return this.getFeeInfo().then(function (res) {
    return self.fees = {
      detail: res.feeInfo,
      fastestFee: res.feeInfo.fastestFee,
      mediumFee: res.feeInfo.mediumFee,
      maximumAcceptable: res.feeInfo.fastestFee * 3,
      lastUpdated: new Date()
    }
  })
}

CM.prototype.verifyInstantViaRest = function (account, address, hash, n) {
  var node = this.deriveHdAccount(account.num, address.chain, address.hdindex)
  var data = this.prepareAddressSignature(node.keyPair, C.MSG_PREFIX_INSTANT_VERIFY)
  return fetch(this.peekRestPrefix() + "/verifyInstantTx?txHash=" + hash + "&outputNum=" + n + "&sig=" + encodeURIComponent(data.base64Sig), {
    headers: {"user-agent": C.MELIS_USER_AGENT}
  }).then(function (res) {
    return res.json()
  })
}

//
// Non-promise returning methods
//

CM.prototype.calcNextFeeProvider = function () {
  if (this.nextFeeProvider === undefined)
    this.nextFeeProvider = simpleRandomInt(this.feeProviders.length)
  this.nextFeeProvider = (this.nextFeeProvider + 1) % this.feeProviders.length
  return this.feeProviders[this.nextFeeProvider]
}

CM.prototype.prepareAddressSignature = function (keyPair, prefix) {
  var address = this.addressFromPubKey(keyPair)
  var message = prefix + address
  return {
    address: address,
    message: message,
    base64Sig: this.signMessageWithKP(keyPair, message)
  }
}

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

CM.prototype.validateAddress = function (addr) {
  if (!addr)
    return false
  try {
    Bitcoin.address.fromBase58Check(addr)
    return true
  } catch (ex) {
    return false
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

CM.prototype.peekTopBlock = function () {
  return this.lastBlock
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

CM.prototype.peekAccountInfo = function (account) {
  return this.walletData.infos[account.num]
}

CM.prototype.derivePubKeys = function (xpubs, chain, hdIndex) {
  return derivePubKeys(xpubs, chain, hdIndex, this.bitcoinNetwork)
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

CM.prototype.recoveryPrepareInputSig = function (index, accountInfo, unspent, accountsSigData) {
  var bscript = Bitcoin.script
  //console.log("input #" + index + ": ", input)
  //console.log("unspent #" + index + ": ", unspent)
  this.log("[recovery-prepareInputSig] inputIndex: " + index + " unspent: " + unspent.aa.address + " chain: " + unspent.aa.chain + " hdindex: " + unspent.aa.hdindex + " redeemScr: " + unspent.aa.redeemScript)
  //console.log("#" + index + " srvPubKey: " + serverSigData.pubKey)
  var scriptParams = accountInfo.scriptParams
  var mandatoryPubKeys = []
  if (scriptParams.mandatoryKeys && scriptParams.mandatoryKeys.length > 0)
    mandatoryPubKeys = this.derivePubKeys(scriptParams.mandatoryKeys, unspent.aa.chain, unspent.aa.hdindex)
  var otherPubKeys = this.derivePubKeys(scriptParams.otherKeys ? scriptParams.otherKeys : [], unspent.aa.chain, unspent.aa.hdindex)
  this.log("accountsSigData: ", accountsSigData)
  this.log("derived mandatory PubKeys: ", mandatoryPubKeys)
  this.log("derived other PubKeys: ", otherPubKeys)

  // Let's associate signatures to pubKeys
  var self = this, mandatorySigs = [], otherSigs = []
  accountsSigData.forEach(function (sigData) {
    self.log("SigData pubKey: " + sigData.pubKey)
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
  console.log("#mandatorySigs: " + mandatorySigs.length + " #otherSigs: " + otherSigs.length + " mandatoryServer: " + accountInfo.serverMandatory)
  if (mandatorySigs.length !== mandatoryPubKeys.length)
    throw new MelisError('CmBadParamException', 'Wrong mandatory signatures -- found: ' + mandatorySigs.length + " needed: " + mandatoryPubKeys.length)
  if (otherSigs.length !== (accountInfo.minSignatures + (accountInfo.serverMandatory ? 1 : 0) - mandatorySigs.length))
    throw new MelisError('CmBadParamException', 'Wrong additional signatures -- found: ' + otherSigs.length + " mandatory: " + mandatorySigs.length + " mandatoryServer: " + accountInfo.serverMandatory)
  mandatorySigs.sort(pubKeyComparator)
  otherSigs.sort(pubKeyComparator)

  var script = 'OP_0';   // Work around a bug in CHECKMULTISIG that is now a required part of the protocol.
  otherSigs.forEach(function (sigData) {
    script += ' ' + sigData.sig.toScriptSignature(sigData.hash).toString('hex')
  })
  if (mandatorySigs.length > 1 && otherSigs.length > 0)
    script += ' OP_0'
  mandatorySigs.forEach(function (sigData) {
    script += ' ' + sigData.sig.toScriptSignature(sigData.hash).toString('hex')
  })

  self.log("scriptPubKey: " + script)
  var scriptSig = bscript.fromASM(script)
  var bufferRedeemScript = new Buffer(unspent.aa.redeemScript, 'hex')
  self.log("redeemScript: " + bscript.toASM(bufferRedeemScript))

  var p2shScript = Bitcoin.script.scriptHash.input.encode(scriptSig, bufferRedeemScript)
  return p2shScript
}

CM.prototype.recoveryPrepareTransaction = function (accountInfo, tx, unspents, seeds, serverSignaturesData, network) {
  this.log("[recoveryPrepareTransaction] unspents: ", unspents)
  this.log("[recoveryPrepareTransaction] server signature data: ", serverSignaturesData)
  if (accountInfo.minSignatures !== seeds.length)
    throw new MelisError('CmBadParamException', '#minSignatures != #seeds')

  var self = this
  var cosigners = accountInfo.cosigners
  var hexTx = tx.toHex()
  var signatures = []

  // Discover which account is owned by which seed
  var accountsData = []
  seeds.forEach(function (seed) {
    var walletHd = Bitcoin.HDNode.fromSeedHex(seed, network)
    var cosigner = cosigners.find(function (cosigner) {
      var accountHd = self.deriveHdAccount_explicit(network, walletHd, cosigner.accountNum)
      return accountHd.neutered().toBase58() === cosigner.xpub
    })
    if (!cosigner)
      throw new MelisError('CmBadParamException', "Unable to find cosigner for seed: " + seed)
    accountsData.push({seed: seed, accountNum: cosigner.accountNum})
  })

  var f = function (i) {
    var data = accountsData[i]
    return self.signaturesPrepare({
      hd: Bitcoin.HDNode.fromSeedHex(data.seed, network),
      accountNum: data.accountNum,
      rawTx: hexTx,
      inputs: unspents,
      network: network
    }).then(function (accountSigs) {
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
    var allSignatures = []
    for (var i = 0; i < tx.ins.length; i++) {
      var arr = []
      if (accountInfo.serverSignature && accountInfo.serverMandatory) {
        var serverPubKey = new Buffer(serverSignaturesData[i].pubKey, 'base64').toString('hex')
        var serverSig = Bitcoin.ECSignature.fromDER(new Buffer(serverSignaturesData[i].sig, 'base64'))
        var serverSigData = {pubKey: serverPubKey, sig: serverSig, hash: Bitcoin.Transaction.SIGHASH_NONE}
        arr.push(serverSigData)
      }
      signatures.forEach(function (s) {
        arr.push(s[i])
      })
      allSignatures.push(arr)
    }
    for (var i = 0; i < tx.ins.length; i++) {
      var inputSig = self.recoveryPrepareInputSig(i, accountInfo, unspents[i], allSignatures[i])
      //self.log("#" + i + " inputSig: " + Bitcoin.script.toASM(inputSig))
      tx.setInputScript(i, inputSig)
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
