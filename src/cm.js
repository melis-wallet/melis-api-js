'use strict';
var Q = require('q');
var events = require('events');
var Stomp = require('stompjs');
var SockJS = require('sockjs-client');
var Bitcoin = require('bitcoinjs-lib');
var isNode = require('detect-node');
var randomBytes = require('randombytes');
var sjcl = require('sjcl-all');
var C = require("./cm-constants");
var BlockChainApi = require("./blockchains-api");

function walletOpen(target, hd, serverWalletData) {
  if (!hd || !serverWalletData) {
    console.error("ASSERT ERROR: no wallet data opening wallet");
    //throw new Error("wallet open error");
    return null;
  }
  target.hdWallet = hd;
  target.walletData = serverWalletData;
  emitEvent(target, C.EVENT_WALLET_OPENED, serverWalletData);
}

function walletClose(target) {
  target.hdWallet = null;
  target.walletData = null;
}

function updateAccount(target, account, balance) {
  var accounts = target.walletData.accounts;
  var num = -1;
  for (var i = 0; i < accounts.length; i++)
    if (accounts[i].num === account.num) {
      num = i;
      break;
    }
  if (num === -1) {
    target.walletData.accounts.push(account);
    target.walletData.balances.push(balance);
  } else {
    target.walletData.accounts[num] = account;
    target.walletData.balances[num] = balance;
  }
}

function updateAccountInfo(target, account, info) {
  if (target.walletData.accounts[account.num])
    target.walletData.accounts[account.num].info = info;
}

function updateServerConfig(target, config) {
  if (config.message)
    console.log("Server message status: " + config.message);
  target.cmConfiguration = config;
  target.lastBlock = config.topBlock;
  target.bitcoinNetwork = target.decodeNetworkName(target.cmConfiguration.network); // === "prodnet" ? Bitcoin.networks.bitcoin : Bitcoin.networks.testnet;
}

function emitEvent(target, event, params) {
  if (event !== C.EVENT_RPC_ACTIVITY_END && event !== C.EVENT_RPC_ACTIVITY_START)
    console.log("[CM emitEvent] " + event + " params: " + JSON.stringify(params));
  if (event === C.EVENT_CONFIG)
    updateServerConfig(target, params);
  var listeners = target.listeners(event);
  if (!listeners.length) {
//console.log("[CM emitEvent] nessun listener per l'evento '" + event + "'");
    target.emit(C.UNHANDLED_EVENT, {name: event, params: params});
  } else {
    target.emit(event, params);
  }
}

function throwUnexpectedEx(msg) {
  throw {ex: 'UnexpectedClientEx', msg: msg};
}

function throwBadParamEx(paramName, msg) {
  throw {ex: 'CmBadParamException', param: paramName, msg: msg};
}

function failedPromise(ex, msg) {
  return Q.reject({ex: ex, msg: msg});
}

function initializePrivateFields(target) {
  target.rpcCounter = 0;
  if (target.waitingReplies) {
    for (var d in target.waitingReplies) {
      var deferred = target.waitingReplies[d].deferred;
      deferred.reject(C.EVENT_DISCONNECT);
    }
  }
  target.waitingReplies = {};
  target.hdWallet = null;
  target.walletData = null;
  target.lastBlock = null;
  target.lastSeed = null;
  target.cmConfiguration = null; // Got from server at connect
  target.bitcoinNetwork = Bitcoin.networks.testnet; // Overridden from server at connect
}

function addPagingInfo(pars, pagingInfo) {
  if (pagingInfo) {
    pars.page = pagingInfo.page || 0;
    pars.size = pagingInfo.size || 20;
    if (pagingInfo.sortField) {
      pars.sortField = pagingInfo.sortField;
      pars.sortDir = pagingInfo.sortDir;
    }
  }
  return pars;
}

function CM(config) {
  if (!config)
    config = {};
  this.serviceUrl = config.serviceUrl || C.chainMasterStompUrl;
  this.rpcTimeout = config.rpcTimeout >= 100 ? config.rpcTimeout : 60000;
  this.rpcRetryDelay = config.rpcRetryDelay >= 10 ? config.rpcRetryDelay : 1500;
  this.rpcMaxRetries = config.rpcMaxRetries >= 1 ? config.rpcMaxRetries : 10;
  this.autoReconnectDelay = config.autoReconnectDelay >= 0 ? config.autoReconnectDelay : 30;
  this.connected = false;
  this.autoReconnectFunc = null;
  this.stompClient = null;
  this.externalTxValidator = null;
  initializePrivateFields(this);
}

CM.prototype = Object.create(events.EventEmitter.prototype);
CM.prototype.Q = Q;
CM.prototype.Bitcoin = Bitcoin;
CM.prototype.sjcl = sjcl;
CM.prototype.getRpcTimeout = function () {
  return this.rpcTimeout;
};

CM.prototype.setRpcTimeout = function (ms) {
  if (ms >= 1 && ms <= 1000000)
    this.rpcTimeout = ms;
  else
    throwBadParamEx(ms, "Timeout ms must be between 1 and 1000000");
};

CM.prototype.isProdNet = function () {
  return this.cmConfiguration.network === C.CHAIN_MAIN;
};

CM.prototype.isTestNet = function () {
  return this.cmConfiguration.network === C.CHAIN_TESTNET;
};

CM.prototype.isRegTest = function () {
  return this.cmConfiguration.network === C.CHAIN_REGTEST;
};

CM.prototype.decodeNetworkName = function (networkName) {
  return networkName === "prodnet" ? Bitcoin.networks.bitcoin : Bitcoin.networks.testnet;
};

CM.prototype.setAutoReconnectDelay = function (seconds) {
  if (seconds >= 0)
    this.autoReconnectDelay = seconds;
};

CM.prototype.randomBytes = function (n) {
  return randomBytes(n);
};

CM.prototype.randomHexBytes = function (n) {
  return this.randomBytes(n).toString('hex');
};

CM.prototype.random32HexBytes = function () {
  return this.randomHexBytes(32);
};

CM.prototype.isConnected = function () {
  return this.connected;
};

CM.prototype.isReady = function () {
  return !(!this.cmConfiguration);
};

CM.prototype.getConfig = function () {
  return this.cmConfiguration;
};

CM.prototype.peekTopBlock = function () {
  return this.lastBlock;
};

CM.prototype.peekWalletPubKey = function () {
  if (this.hdWallet)
    return this.hdWallet.getPublicKeyBuffer().toString('hex');
  throwUnexpectedEx("Wallet not open");
};

CM.prototype.peekHdWallet = function () {
  if (this.hdWallet)
    return this.hdWallet;
  throwUnexpectedEx("Wallet not open");
};

CM.prototype.parseBIP32Path = function (path, radix) {
  if (!radix)
    radix = 10;
  if (path.indexOf("m/") === 0)
    path = path.substring(2);
  var result = [];
  var pathElems = path.split("/");
  for (var i = 0; i < pathElems.length; i++) {
    var hardened = false;
    var val = pathElems[i];
    if (val.charAt(val.length - 1) === '\'') {
      hardened = true;
      val = val.substring(0, val.length - 1);
    }
    val = parseInt(val, radix);
    if (val >= 0x80000000)
      throwBadParamEx('path', "Invalid path element: " + val);
    result.push((hardened ? (0x80000000) | val : val) >>> 0);
  }
  return result;
};

CM.prototype.getLoginPath = function () {
  var product = 31337; // CM
  var isProdNet = this.bitcoinNetwork.wif === Bitcoin.networks.bitcoin.wif;
  var network = isProdNet ? 0 : 1; // Use another path for I2P/TOR
  return [
    ((0x80000000) | product) >>> 0,
    ((0x80000000) | network) >>> 0
  ];
};

CM.prototype.deriveKeyFromPath = function (hdnode, path) {
  if (!path || path.length === 0)
    return hdnode;
  var key = hdnode;
  for (var i = 0; i < path.length; i++) {
    var index = path[i];
    if (index & 0x80000000) {
      var v = index & 0x7FFFFFFF;
      key = key.deriveHardened(v);
    } else {
      key = key.derive(index);
    }
  }
  return key;
};

// BIP44 standard derivation
CM.prototype.deriveHdAccount_internal = function (network, hd, accountNum, chain, index) {
  var isProdNet = !network || network.wif === Bitcoin.networks.bitcoin.wif;
  // console.log("[deriveAccount] " + accountNum + "/" + chain + "/" + index + " isProdNet: " + isProdNet, network);
  var key = hd.deriveHardened(44);
  key = key.deriveHardened(isProdNet ? 0 : 1);
  key = key.deriveHardened(accountNum);
  if (chain === undefined || chain === null || index === undefined || index === null)
    return key;
  return key.derive(chain).derive(index);
};

CM.prototype.deriveHdAccount = function (accountNum, chain, index) {
  return this.deriveHdAccount_internal(this.bitcoinNetwork, this.hdWallet, accountNum, chain, index);
};

CM.prototype.rpc = function (queue, headers, data, numRetries) {
  console.log("[RPC] q: " + queue + " data: " + JSON.stringify(data) + " h: " + JSON.stringify(headers));
  if (!queue)
    throwBadParamEx('queue', "RPC call without defined queue");
  var deferred = Q.defer();
  this.rpcCounter++;
  if (Object.keys(this.waitingReplies).length === 0) {
    emitEvent(this, C.EVENT_RPC_ACTIVITY_START);
  }
  this.pendingRPC++;
  var rpcCounter = this.rpcCounter;
  this.waitingReplies[rpcCounter] = {
    deferred: deferred,
    queue: queue,
    headers: headers,
    data: data,
    numRetries: numRetries || 1
  };
  // console.log("[STOMP] queue: " + queue + " data: " + JSON.stringify(data) + " typeof(data): " + typeof data);
  if (!headers)
    headers = {};
  headers.id = rpcCounter;
  this.stompClient.send(queue, headers, data ? typeof data === "object" ? JSON.stringify(data) : data : null);
  var self = this;
  return deferred.promise.timeout(this.rpcTimeout).fail(function (err) {
    console.log("[RPC] Ex or Timeout -- res: " + JSON.stringify(err));
    var ex = err;
    if (err.code && err.code === 'ETIMEDOUT') {
      ex = {ex: "rpcTimeout", msg: 'RPC call timeout after ' + self.rpcTimeout + 'ms'};
      delete self.waitingReplies[rpcCounter];
    }
    return Q.reject(ex);
  }).finally(function () {
    if (Object.keys(self.waitingReplies).length === 0) {
      emitEvent(self, C.EVENT_RPC_ACTIVITY_END);
    }
  });
};

function rpcReplyHandler(target, res) {
  // console.log("[STOMP] Ricevuta risposta RPC: " + res);
  //var messageId = res.headers.myId;
  var message = JSON.parse(res.body);
  var messageId = message.id;
  //console.log("[STOMP] rpcReplyHandler message: " + JSON.stringify(message));
  if (messageId) {
    var rpcData = target.waitingReplies[messageId];
    delete target.waitingReplies[messageId];
    if (rpcData)
      rpcData.deferred.resolve(message.m);
    else
      console.error("[STOMP] RPC reply con ID: " + messageId + " non trovato in coda");
  } else {
    console.warn("[STOMP] RPC reply senza ID: " + message);
  }
}

function rpcErrorHandler(target, res) {
  console.log("[STOMP] RPC Exception: " + JSON.stringify(res));
  //var messageId = res.headers.myId;
  var message = JSON.parse(res.body);
  var messageId = message.id;
  if (messageId) {
    var rpcData = target.waitingReplies[messageId];
    delete target.waitingReplies[messageId];
    if (rpcData) {
      if (message.ex === C.EX_TOO_MANY_REQUESTS && rpcData.numRetries < target.rpcMaxRetries) {
        var rpcRetryDelay = target.rpcRetryDelay * rpcData.numRetries;
        console.log("Server requested to slow down requests -- retry #" + rpcData.numRetries + " waiting " + rpcRetryDelay + "ms");
        setTimeout(function () {
          console.log("Preparing new request");
          target.rpc(rpcData.queue, rpcData.headers, rpcData.data, rpcData.numRetries + 1).then(function (res) {
            rpcData.deferred.resolve(res);
          }).fail(function (res) {
            console.log("RE-REQUEST FAILED: " + JSON.stringify(res));
            rpcData.deferred.reject(res);
          });
        }, rpcRetryDelay);
      } else
        rpcData.deferred.reject(message);
    } else {
      console.error("[STOMP] RPC Error -- Unable to find request with ID: " + messageId);
    }
  }
}

CM.prototype.connect = function (config) {
  if (this.autoReconnectFunc) {
    clearInterval(this.autoReconnectFunc);
    this.autoReconnectFunc = null;
  }

  if (this.stompClient !== null) {
    if (this.connected)
      return;
    this.stompClient = null;
  }

  if ((/^wss?:\/\//).test(this.serviceUrl)) {
    if (isNode) {
      console.log("[STOMP] Apertura websocket (node) a: " + this.serviceUrl);
      this.stompClient = Stomp.overWS(this.serviceUrl);
    } else {
      console.log("[STOMP] Apertura websocket (browser) a: " + this.serviceUrl);
      this.stompClient = Stomp.client(this.serviceUrl);
    }
  } else {
    console.log("[STOMP] Apertura sockjs a: " + this.serviceUrl);
    this.stompClient = Stomp.over(new SockJS(this.serviceUrl));
  }

  this.stompClient.debug = function (str) {
//console.log("this.stompClient.debug() called. Size: " + str.length);
//console.log(str);
  };
  var self = this;
  var deferred = Q.defer();
  var headers = {};
  if (config && config.userAgent)
    headers.userAgent = JSON.stringify(config.userAgent);
  if (config && config.locale)
    headers.locale = config.locale;
  if (config && config.currency)
    headers.currency = config.currency;
  this.stompClient.connect(headers, function (frame) {
    console.log("[CM] Connect: " + frame);
    self.connected = true;
    emitEvent(self, C.EVENT_CONNECT);
    self.stompClient.subscribe(C.QUEUE_RPC_REPLY, function (message) {
      rpcReplyHandler(self, message);
    });
    self.stompClient.subscribe(C.QUEUE_RPC_ERROR, function (message) {
      rpcErrorHandler(self, message);
    });
    self.stompClient.subscribe(C.QUEUE_SERVER_EVENTS, function (message) {
      //console.log("[CM] Server event: " + message.body);
      var msg = JSON.parse(message.body);
      emitEvent(self, msg.type, msg.params);
    });
    self.stompClient.subscribe(C.QUEUE_PUBLIC_MSGS, function (message) {
      var msg = JSON.parse(message.body);
      emitEvent(self, C.EVENT_PUBLIC_MESSAGE, msg);
    });
    self.stompClient.subscribe(C.QUEUE_BLOCKS, function (message) {
      var msg = JSON.parse(message.body);
      self.lastBlock = msg;
      emitEvent(self, C.EVENT_BLOCK, msg);
    });
    self.stompClient.subscribe(C.QUEUE_CONFIG, function (message) {
      console.log("[CM] CONFIG: " + message.body);
      var initialEvents = JSON.parse(message.body);
      for (var i = 0; i < initialEvents.length; i++) {
        var event = initialEvents[i];
        emitEvent(self, event.type, event.params);
      }
      if (self.lastSeed) {
        self.walletOpen(self.lastSeed).then(function () {
          deferred.resolve(self.cmConfiguration);
        });
      } else
        deferred.resolve(self.cmConfiguration);
    });
  }, function (frame) {
    console.log("[CM] Disconnected: " + frame);
    self.connected = false;
    self.cmConfiguration = null;
    deferred.reject(frame);
    emitEvent(self, C.EVENT_DISCONNECT);
    if (self.autoReconnectDelay && self.autoReconnectFunc === null) {
      var timeout = 10 + Math.random() * 10 + Math.random() * (self.autoReconnectDelay / 10);
      console.log("[CM] ---- NEXT AUTO RECONNECT : " + timeout);
      self.autoReconnectFunc = setTimeout(function () {
        self.autoReconnectFunc = null;
        self.connect();
      }, timeout * 1000);
    }
  });
  return deferred.promise;
};

CM.prototype.disconnect = function () {
  var self = this;
  this.autoReconnectDelay = 0;
  if (this.autoReconnectFunc) {
    clearInterval(this.autoReconnectFunc);
    this.autoReconnectFunc = null;
  }
  var deferred = Q.defer();
  this.stompClient.disconnect(function (res) {
    //console.log("[STOMP] Disconnect: " + res);
    self.connected = false;
    initializePrivateFields(self);
    deferred.resolve(res);
  });
  return deferred.promise;
};

CM.prototype.subscribe = function (queue, callback, headers) {
  if (!queue || !callback)
    throwBadParamEx('queue', "Call to subscribe without defined queue or callback");
  return this.stompClient.subscribe(queue, function (res) {
    console.log("[CM] response to subscribe " + queue + " : " + res);
    var msg = JSON.parse(res.body);
    callback(msg);
  }, headers);
};

CM.prototype.subscribeToCurrencyData = function (currency, callback) {
  if (!currency || !callback)
    throwBadParamEx('currency', "Missing currency or callback while subscribing to quotation: " + currency);
  var res = this.subscribe(C.QUEUE_QUOTES_PREFIX + currency, callback);
  return res.ask === 0 ? null : res;
};
//CM.send = function (queue, headers, data) {
//  console.log("[STOMP] send to queue: " + queue + " data: " + data + " typeof(data): " + typeof data);
//  this.stompClient.send(queue, headers, data ? typeof data === "object" ? JSON.stringify(data) : data : null);
//};
//

//
// PUBLIC METHODS
//

CM.prototype.getPaymentAddressForAccount = function (accountIdOrAlias, memo) {
  return this.rpc(C.GET_PAYMENT_ADDRESS, null, {name: accountIdOrAlias, data: memo}).then(function (res) {
    //console.log("[CM] getAddresses: " + JSON.stringify(res));
    return res.address;
  });
};

CM.prototype.accountGetPublicInfo = function (params) {
  return this.rpc(C.GET_ACCOUNT_PUBLIC_INFO, null, {name: params.name, code: params.code}).then(function (res) {
    //console.log("[CM] accountGetPublicInfo: " + JSON.stringify(res));
    return res.account;
  });
};

CM.prototype.getWalletChallenge = function () {
  return this.rpc(C.GET_CHALLENGE);
};

//
// UTILITIES
//

CM.prototype.decodeTxFromBuffer = function (buf) {
  //return Bitcoin.Transaction.fromHex(rawTx);
  return Bitcoin.Transaction.fromBuffer(buf);
};

CM.prototype.createTxBuilderFromTxBuffer = function (buf) {
  return Bitcoin.TransactionBuilder.fromTransaction(this.decodeTxFromBuffer(buf), this.bitcoinNetwork);
};

//CM.prototype.decodeScript = function (hexScript) {
// return Bitcoin.script.decompile(new Buffer(hexScript, "hex"));
// // return new Buffer(hexScript, "hex");
//};

CM.prototype.wifToEcPair = function (wif) {
  return Bitcoin.ECPair.fromWIF(wif, this.bitcoinNetwork);
};

CM.prototype.signMessage = function (keyPair, message) {
  return Bitcoin.message.sign(keyPair, message, this.bitcoinNetwork);
};

CM.prototype.decodeAddressFromScript = function (script) {
  return Bitcoin.address.fromOutputScript(script, this.bitcoinNetwork);
};

CM.prototype.addressFromPubKey = function (pubKey) {
  return pubKey.getAddress(this.bitcoinNetwork);
};

CM.prototype.extractPubKeyFromOutputScript = function (script) {
  var type = Bitcoin.script.classifyOutput(script);
  if (type === "pubkey") {
    //return Bitcoin.ECPubKey.fromBuffer(script.chunks[0]);
    var decoded = Bitcoin.script.decompile(script);
    //console.log("Decoded:"); console.log(decoded);
    return Bitcoin.ECPair.fromPublicKeyBuffer(decoded[0], this.bitcoinNetwork);
  }
  return null;
};

CM.prototype.pushTx = function (hex) {
  return this.rpc(C.UTILS_PUSH_TX, null, {hex: hex}).then(function (res) {
    return res;
  });
};

CM.prototype.deviceSetPassword = function (deviceName, pin) {
  if (!deviceName || !pin)
    return failedPromise('MethodArgumentNotValidException', 'missing deviceName or pin');
  return this.rpc(C.WALLET_DEVICE_SET_PASSWORD, null, {
    deviceName: deviceName,
    userPin: pin
  }).then(function (res) {
    // The result is base64 encoded
    //console.log("[CM] setDeviceName: " + JSON.stringify(res));
    return {deviceId: res.info};
  });
};

CM.prototype.deviceGetPassword = function (deviceId, pin) {
  if (!deviceId || !pin)
    return failedPromise('MethodArgumentNotValidException', 'missing deviceId or pin');
  return this.rpc(C.WALLET_DEVICE_GET_PASSWORD, null, {
    deviceId: deviceId,
    userPin: pin
  }).then(function (res) {
    console.log("[CM] getDevicePassword: " + JSON.stringify(res));
    return res.info;
  });
};

CM.prototype.deviceChangePin = function (deviceId, oldPin, newPin) {
  if (!deviceId || !oldPin || !newPin)
    return failedPromise('MethodArgumentNotValidException', 'missing deviceId or pins');
  return this.rpc(C.WALLET_DEVICE_CHANGE_PIN, null, {
    deviceId: deviceId,
    userPin: oldPin,
    newPin: newPin
  }).then(function (res) {
    console.log("[CM] deviceChangePin: " + JSON.stringify(res));
    return res.info;
  });
};

CM.prototype.devicePromoteToPrimary = function (deviceId, tfa) {
  if (!deviceId)
    return failedPromise('MethodArgumentNotValidException', 'missing deviceId or pin');
  return this.rpc(C.WALLET_DEVICE_PROMOTE_TO_PRIMARY, null, {
    deviceId: deviceId,
    tfa: tfa
  }).then(function (res) {
    console.log("[CM] devicePromoteToPrimary: " + JSON.stringify(res));
    return res;
  });
};

CM.prototype.deviceGetRecoveryHours = function () {
  return this.rpc(C.WALLET_DEVICE_GET_RECOVERY_HOURS, null, {}).then(function (res) {
    console.log("[CM] device recovery hours: " + JSON.stringify(res));
    return res;
  });
};

CM.prototype.deviceSetRecoveryHours = function (hours, tfa) {
  return this.rpc(C.WALLET_DEVICE_SET_RECOVERY_HOURS, null, {
    data: hours,
    tfa: tfa
  }).then(function (res) {
    console.log("[CM] set device recovery hours(" + hours + "): " + JSON.stringify(res));
    return res;
  });
};

CM.prototype.devicesGet = function () {
  return this.rpc(C.WALLET_DEVICES_GET, null, {}).then(function (res) {
    console.log("[CM] wallet devices: " + JSON.stringify(res));
    return res.slice;
  });
};

CM.prototype.devicesDelete = function (param) {
  var data = {};
  if (param instanceof Array)
    data.deviceIds = param;
  else
    data.deviceId = param;
  return this.rpc(C.WALLET_DEVICES_DELETE, null, data).then(function (res) {
    console.log("[CM] deletion of wallet devices " + JSON.stringify(param) + ":" + JSON.stringify(res));
    return res;
  });
};

//
// WALLET functions
//

CM.prototype.walletOpen = function (seed, params) {
  var self = this;
  if (!params)
    params = {};
  //return self.rpc(C.GET_CHALLENGE).then(function (res) {
  return this.getWalletChallenge().then(function (res) {
    var challengeHex = res.challenge;
    //console.log("[CM] walletOpen challenge: " + challengeHex + " seed: " + seed + " network: " + JSON.stringify(self.bitcoinNetwork));
    var hd = Bitcoin.HDNode.fromSeedHex(seed, self.bitcoinNetwork);
    // Keep the public key for ourselves
    var loginKey = self.deriveKeyFromPath(hd, self.getLoginPath());
    var buf = new Buffer(challengeHex, 'hex');
    var signature = loginKey.sign(buf);
    //console.log("child: " + child.getPublicKeyBuffer().toString('hex')() + " sig: " + signature);
    //console.log("pubKey: " + masterPubKey + " r: " + signature.r.toString() + " s: " + signature.s.toString());
    return self.rpc(C.WALLET_OPEN, null, {
      id: loginKey.getPublicKeyBuffer().toString('hex'),
      signatureR: signature.r.toString(), signatureS: signature.s.toString(),
      sessionName: params.sessionName,
      deviceId: params.deviceId
    }).then(function (res) {
      console.log("[CM] walletOpen : " + JSON.stringify(res));
      walletOpen(self, hd, res.wallet);
      self.lastSeed = seed;
      return res.wallet;
    });
  });
};

CM.prototype.walletRegister = function (seed, params) {
  var self = this;
  if (!params)
    params = {};
  var loginKey;
  try {
    var hd = Bitcoin.HDNode.fromSeedHex(seed, self.bitcoinNetwork);
    loginKey = self.deriveKeyFromPath(hd, self.getLoginPath());
    //console.log('REGISTER hd: ', hd, ' loginKey: ', loginKey);
  } catch (error) {
    var ex = {ex: "clientAssertFailure", msg: error.message};
    console.log(ex);
    return Q.reject(ex);
  }
  return self.rpc(C.WALLET_REGISTER, null, {
    xpub: loginKey.neutered().toBase58(),
    //id: loginKey.getPublicKeyBuffer().toString('hex'),
    //chainCode: loginKey.chainCode.toString('hex'),
    sessionName: params.sessionName,
    deviceId: params.deviceId
  }).then(function (res) {
    console.log("[CM] walletRegister: " + JSON.stringify(res));
    walletOpen(self, hd, res.wallet);
    self.lastSeed = seed;
    return res.wallet;
  });
};

CM.prototype.walletClose = function () {
  var self = this;
  return self.rpc(C.WALLET_CLOSE, null, {}).then(function (res) {
    console.log("[CM] walletClose : " + JSON.stringify(res));
    walletClose(self);
    return res;
  });
};

CM.prototype.walletGetNumSessions = function () {
  return this.rpc(C.WALLET_GET_NUM_SESSIONS, null, {}).then(function (res) {
    //console.log("[CM] number of sessions with wallet open: " + JSON.stringify(res));
    return res.numWalletSessions;
  });
};

CM.prototype.walletGetNotifications = function (fromDate, pagingInfo) {
  var pars = addPagingInfo({fromDate: fromDate}, pagingInfo);
  return this.rpc(C.WALLET_GET_NOTIFICATIONS, null, pars).then(function (res) {
    console.log("[CM GET_WALLET_NOTIFICATIONS] res: " + JSON.stringify(res));
    return res.slice;
  });
};

CM.prototype.getFreeAccountNum = function () {
  return this.rpc(C.WALLET_GET_FREE_ACCOUNT_NUM, null, {}).then(function (res) {
    console.log("[CM] getFreeAccountNum res: " + JSON.stringify(res));
    return res.accountNum;
  });
};

CM.prototype.addPushTokenGoogle = function (token) {
  return this.rpc(C.WALLET_PUSH_REGISTER_GOOGLE, null, {data: token}).then(function (res) {
    console.log("[CM set google push token] res: " + JSON.stringify(res));
    return res;
  });
};

CM.prototype.aliasGetInfo = function (account) {
  return this.rpc(C.ACCOUNT_ALIAS_INFO, null, {pubId: account.pubId}).then(function (res) {
    console.log("[CM] getAliasInfo: " + JSON.stringify(res) + " for account " + account.pubId);
    return res;
  });
};

CM.prototype.aliasIsAvailable = function (alias) {
  return this.rpc(C.ACCOUNT_ALIAS_AVAILABLE, null, {name: alias}).then(function (res) {
    console.log("[CM] aliasAvailable(" + alias + "): " + JSON.stringify(res));
    return res;
  });
};

CM.prototype.aliasDefine = function (account, alias) {
  return this.rpc(C.ACCOUNT_ALIAS_DEFINE, null, {pubId: account.pubId, name: alias}).then(function (res) {
    console.log("[CM] aliasDefine(" + alias + "): " + JSON.stringify(res));
    return res;
  });
};

CM.prototype.clientMetaSet = function (name, value) {
  return this.rpc(C.WALLET_CLIENT_META_SET, null, {name: name, meta: value});
};

CM.prototype.clientMetaGet = function (name) {
  return this.rpc(C.WALLET_CLIENT_META_GET, null, {name: name}).then(function (res) {
    return res.meta;
  });
};

CM.prototype.clientMetasGet = function (pagingInfo) {
  var pars = addPagingInfo({}, pagingInfo);
  return this.rpc(C.WALLET_CLIENT_METAS_GET, null, pars).then(function (res) {
    return res.slice;
  });
};

CM.prototype.clientMetaDelete = function (name) {
  return this.rpc(C.WALLET_CLIENT_META_DELETE, null, {name: name});
};
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
  var self = this;
  if (!params || !params.type)
    throwBadParamEx('params', "Bad parameters");
  var numPromise;
  if (params.accountNum === undefined)
    numPromise = this.getFreeAccountNum();
  else
    numPromise = Q(params.accountNum);
  return numPromise.then(function (accountNum) {
    params.accountNum = accountNum;
    var accountHd = self.deriveHdAccount(accountNum);
    params.xpub = accountHd.neutered().toBase58();
    return self.rpc(C.ACCOUNT_REGISTER, null, params).then(function (res) {
      updateAccount(self, res.account, res.balance);
      return res;
    });
  });
};

CM.prototype.accountJoin = function (code, meta) {
  var self = this;
  console.log("[CM] joinWallet code: " + code + "'" + JSON.stringify(meta) + "'");
  return this.getFreeAccountNum().then(function (accountNum) {
    var accountHd = self.deriveHdAccount(accountNum);
    return self.rpc(C.ACCOUNT_JOIN, null, {
      code: code,
      accountNum: accountNum,
      xpub: accountHd.neutered().toBase58(),
      meta: meta
    }).then(function (res) {
      console.log("[CM] joinWallet res: " + JSON.stringify(res));
      updateAccount(self, res.account, res.balance);
      return res;
    });
  });
};

CM.prototype.accountRefresh = function (account) {
  var self = this;
  return this.rpc(C.ACCOUNT_REFRESH, null, {
    pubId: account.pubId
  }).then(function (res) {
    console.log("[CM] accountRefresh: " + JSON.stringify(res));
    updateAccount(self, res.account, res.balance);
    return res;
  });
};

CM.prototype.accountUpdate = function (account, options) {
  if (!options || typeof options !== 'object')
    return;
  var self = this;
  console.log("[accountUpdate] " + account.pubId + " : " + JSON.stringify(options));
  return this.rpc(C.ACCOUNT_UPDATE, null, {
    pubId: account.pubId,
    hidden: options.hidden,
    meta: options.meta,
    pubMeta: options.pubMeta
  }).then(function (res) {
    console.log("[CM] accountUpdate: " + JSON.stringify(res));
    updateAccount(self, res.account, res.balance);
    return res;
  });
};

CM.prototype.accountDelete = function (account) {
  var self = this;
  return this.rpc(C.ACCOUNT_DELETE, null, {pubId: account.pubId}).then(function (res) {
    console.log("[CM] accountDelete : " + JSON.stringify(res));
    delete self.walletData[account.num];
    return res;
  });
};

CM.prototype.accountGetInfo = function (account) {
  var self = this;
  return this.rpc(C.ACCOUNT_GET_INFO, null, {pubId: account.pubId}).then(function (res) {
    console.log("[CM] accountGetInfo: " + JSON.stringify(res));
    updateAccountInfo(self, account, res);
    return res;
  });
};

CM.prototype.getLocktimeDays = function (account) {
  return this.rpc(C.ACCOUNT_GET_LOCKTIME_DAYS, null, {
    pubId: account.pubId
  }).then(function (res) {
    return res;
  });
};

CM.prototype.setLocktimeDays = function (account, days, tfa) {
  return this.rpc(C.ACCOUNT_SET_LOCKTIME_DAYS, null, {
    pubId: account.pubId, data: days, tfa: tfa
  }).then(function (res) {
    return res;
  });
};

CM.prototype.getRecoveryInfo = function (account) {
  return this.rpc(C.ACCOUNT_GET_RECOVERY_INFO, null, {
    pubId: account.pubId
  }).then(function (res) {
    //console.log("[CM] getRecoveryData: " + JSON.stringify(res));
    return res;
  });
};

CM.prototype.getUnusedAddress = function (account, address, labels, meta) {
  return this.rpc(C.ACCOUNT_GET_UNUSED_ADDRESS, null, {
    pubId: account.pubId,
    address: address,
    labels: labels,
    meta: meta
  }).then(function (res) {
    console.log("[CM] getUnusedAddress: " + JSON.stringify(res));
    return res.address;
  });
};

CM.prototype.getAddresses = function (account) {
  return this.rpc(C.ACCOUNT_GET_ADDRESSES, null, {pubId: account.pubId}).then(function (res) {
    //console.log("[CM] getAddresses: " + JSON.stringify(res));
    return res.slice;
  });
};

CM.prototype.addLegacyAddress = function (account, keyPair, params) {
  var address = this.addressFromPubKey(keyPair);
  var message = C.LEGACY_ACCOUNT_MSG_PREFIX + address;
  var signature = this.signMessage(keyPair, message);
  return this.rpc(C.WALLET_ADD_LEGACY_ADDRESS, null, {
    pubId: account.pubId,
    address: address,
    data: signature.toString('base64'),
    labels: params ? params.labels : null,
    meta: params ? params.meta : null
  });
};

CM.prototype.accountGetNotifications = function (account, fromDate, pagingInfo) {
  var pars = addPagingInfo({pubId: account.pubId, fromDate: fromDate}, pagingInfo);
  return this.rpc(C.ACCOUNT_GET_NOTIFICATIONS, null, pars).then(function (res) {
    console.log("[CM GET_NOTIFICATIONS] res: " + JSON.stringify(res));
    return res.slice;
  });
};

CM.prototype.txInfosGet = function (account, filter, pagingInfo) {
  if (!filter)
    filter = {};
  var pars = addPagingInfo({
    pubId: account.pubId,
    fromDate: filter.fromDate,
    txDate: filter.txDate,
    direction: filter.direction
  }, pagingInfo);
  return this.rpc(C.ACCOUNT_GET_TX_INFOS, null, pars).then(function (res) {
    console.log("[CM GET_TX_INFOS] res: " + JSON.stringify(res));
    return res.slice;
  });
};

CM.prototype.txInfoGet = function (id) {
  return this.rpc(C.ACCOUNT_GET_TX_INFO, null, {
    data: id
  }).then(function (res) {
    //console.log("[CM GET_TX_INFO] res: " + JSON.stringify(res));
    return res.txInfo;
  });
};

CM.prototype.txInfoSet = function (id, labels, meta) {
  return this.rpc(C.ACCOUNT_SET_TX_INFO, null, {
    data: id,
    labels: labels,
    meta: meta
  }).then(function (res) {
    //console.log("[CM SET_TX_INFO] res: " + JSON.stringify(res));
    return res.txInfo;
  });
};

CM.prototype.getAllLabels = function (account) {
  return this.rpc(C.ACCOUNT_GET_ALL_LABELS, null, {pubId: account ? account.pubId : null}).then(function (res) {
    // console.log("[CM GET_ALL_LABELS] res: " + JSON.stringify(res));
    return res;
  });
};

CM.prototype.ptxPrepare = function (account, recipients, options) {
  var params = {pubId: account.pubId, recipients: recipients};
  if (options && options.tfa)
    params.tfa = options.tfa;
  if (options && options.feeMultiplier)
    params.ptxOptions = {feeMultiplier: options.feeMultiplier};
  console.log("[CM ptxPrepare] account: " + account.pubId + " to: " + JSON.stringify(recipients) + " opts: " + options);
  return this.rpc(C.ACCOUNT_PTX_PREPARE, null, params).then(function (res) {
    return res;
  });
};

CM.prototype.ptxGetById = function (id) {
  return this.rpc(C.ACCOUNT_PTX_GET, null, {data: id}).then(function (res) {
    // console.log("[CM ACCOUNT_GET_PREPARED_TX] res: " + JSON.stringify(res));
    return res;
  });
};

CM.prototype.ptxGetByHash = function (hash) {
  return this.rpc(C.ACCOUNT_PTX_GET, null, {hash: hash}).then(function (res) {
    // console.log("[CM ACCOUNT_GET_PREPARED_TX] res: ", res);
    return res;
  });
};

CM.prototype.ptxCancel = function (ptx) {
  return this.rpc(C.ACCOUNT_PTX_CANCEL, null, {data: ptx.id}).then(function (res) {
    //console.log("[CANCEL_PTX] res: " + JSON.stringify(res));
    return res;
  });
};

CM.prototype.ptxsGet = function (account, filter, pagingInfo) {
  if (!filter)
    filter = {};
  var pars = addPagingInfo({
    pubId: account.pubId,
    fromDate: filter.fromDate,
    direction: filter.direction
  }, pagingInfo);
  return this.rpc(C.ACCOUNT_PTXS_GET, null, pars).then(function (res) {
    // console.log("[CM ACCOUNT_PTXS_GET] res: " + JSON.stringify(res));
    return res.slice;
  });
};

CM.prototype.signaturesPrepare = function (params) {
  // console.log("[CM signaturesPrepare] txId: " + ptx.id);
  var self = this;
  var hd = params.hd || this.hdWallet;
  var accountNum = params.accountNum;
  var progressCallback = params.progressCallback;
  var tx = this.decodeTxFromBuffer(new Buffer(params.rawTx, 'hex'));
  var inputs = params.inputs;
  var signatures = [];
  var network = params.network || this.bitcoinNetwork;
  var signInput = function (i) {
    var inputInfo = inputs[i];
    console.log("signInput #" + i + " account#: " + accountNum + " info: " + JSON.stringify(inputInfo) + " network: " + network);
    if (!inputInfo)
      throwUnexpectedEx("Internal error: can't find info data for tx input #" + i);
    var accountAddress = inputInfo.aa;
    var key = self.deriveHdAccount_internal(network, hd, accountNum, accountAddress.chain, accountAddress.hdindex);
    var redeemScript;
    if (accountAddress.redeemScript)
      redeemScript = new Buffer(accountAddress.redeemScript, "hex");
    else
      redeemScript = Bitcoin.address.toOutputScript(key.getAddress(), network); // o inputInfo.script
    //console.log("aa.script " + accountAddress.redeemScript);
    var hashForSignature = tx.hashForSignature(i, redeemScript, Bitcoin.Transaction.SIGHASH_ALL);
    var signature = key.sign(hashForSignature);
    //var sigHex = signature.toDER().toString('hex'); // signature.toScriptSignature(Bitcoin.Transaction.SIGHASH_ALL);
    //signatures.push(sigHex);
    //console.log("[signed input #" + i + "] redeemScript: " + redeemScript.buffer.toString('hex') +
    //        " hashForSignature: " + hashForSignature.toString('hex')); // + " sig: " + sig.toString('hex'));
    signatures.push({key: key, sig: signature});
  };
  var deferred = Q.defer();
  var f = function (i) {
    var progressInfo = {currStep: i, totalSteps: tx.ins.length};
    deferred.notify(progressInfo);
    var promise = null;
    if (progressCallback)
      promise = progressCallback(progressInfo);
    if (!promise || !promise.then || typeof promise.then !== 'function')
      promise = Q();
    promise.then(function () {
      signInput(i);
      if (i === tx.ins.length - 1)
        deferred.resolve(signatures);
      else
        f(i + 1);
    });
  };
  process.nextTick(function () {
    f(0);
  });
  return deferred.promise;
};

CM.prototype.signaturesSubmit = function (state, signatures, tfa) {
  var account = state.account;
  var txId = state.ptx.id;
  console.log("[CM signaturesSubmit] sigs: " + signatures + " txId: " + txId + " account: " + JSON.stringify(account));
  return this.rpc(C.ACCOUNT_SUBMIT_SIGNATURES, null, {
    pubId: account.pubId,
    data: txId,
    signatures: signatures,
    tfa: tfa
  }).then(function (res) {
    console.log("[CM] signaturesSubmit: " + JSON.stringify(res));
    return res.hash;
  });
};

CM.prototype.areAddressesOfAccount = function (account, addresses) {
  for (var i = 0; i < addresses.length; i++)
    if (!this.isAddressOfAccount(account, addresses[i].aa))
      return false;
  return true;
};

function createRedeemScript(keys, minSignatures, useCheckVerify) {
  if (!keys || minSignatures <= 0 || minSignatures > keys.length)
    return null;
  var script;
  if (keys.length === 1) {
    // sanity check: should never happen because not a P2SH script
    if (!useCheckVerify)
      throwUnexpectedEx("Tried to build a redeemscript for single pub key without CHECKSIGVERIFY");
    script = keys[0] + " OP_CHECKSIGVERIFY";
  } else {
    keys.sort();
    script = "OP_" + minSignatures;
    for (var i = 0; i < keys.length; i++)
      script += " " + keys[i];
    script += " OP_" + keys.length;
    if (useCheckVerify)
      script += " OP_CHECKMULTISIGVERIFY";
    else
      script += " OP_CHECKMULTISIG";
  }
  // console.log("[createRedeemScript2] script: " + script);
  return script;
}

function derivePubKeys(xpubs, chain, hdIndex, network) {
  var keys = [];
  for (var i = 0; i < xpubs.length; i++) {
    var hd = Bitcoin.HDNode.fromBase58(xpubs[i], network);
    var key = hd.derive(chain).derive(hdIndex);
    keys.push(key.getPublicKeyBuffer().toString('hex'));
  }
  return keys;
}

function calcP2SH(accountInfo, chain, hdIndex, network) {
  var scriptParams = accountInfo.scriptParams;
  var script;
  var hasMandatoryKeys = scriptParams.mandatoryKeys && scriptParams.mandatoryKeys.length > 0;
  var hasOtherKeys = scriptParams.otherKeys && scriptParams.otherKeys.length > 0;
  if (hasMandatoryKeys) {
    console.log("[calcP2SH] #mandatoryKeys: " + scriptParams.mandatoryKeys.length, scriptParams.mandatoryKeys);
    script = createRedeemScript(derivePubKeys(scriptParams.mandatoryKeys, chain, hdIndex, network), scriptParams.mandatoryKeys.length, hasOtherKeys);
    if (hasOtherKeys) {
      console.log("[calcP2SH] #otherKeys: " + scriptParams.otherKeys.length, scriptParams.otherKeys);
      var minimumNonMandatorySignatures = accountInfo.minSignatures - scriptParams.mandatoryKeys.length;
      if (scriptParams.serverMandatory)
        minimumNonMandatorySignatures++;
      if (minimumNonMandatorySignatures <= 0)
        throwUnexpectedEx("Unable to create address for account: unexpected signature scheme");
      script += " " + createRedeemScript(derivePubKeys(scriptParams.otherKeys, chain, hdIndex, network), minimumNonMandatorySignatures, false);
    }
  } else {
    if (!hasOtherKeys)
      throwUnexpectedEx("Unexpected account info: no mandatory and other keys");
    console.log("[calcP2SH] #otherKeys: " + scriptParams.otherKeys.length, scriptParams.otherKeys);
    script = createRedeemScript(derivePubKeys(scriptParams.otherKeys, chain, hdIndex, network), accountInfo.minSignatures, false);
  }
  console.log("[calcP2SH] script: " + script);
  var redeemScript = Bitcoin.script.fromASM(script);
  var scriptPubKey = Bitcoin.script.scriptHashOutput(Bitcoin.crypto.hash160(redeemScript));
  //console.log("redeemScript: ", Bitcoin.script.toASM(redeemScript));
  //console.log("scriptPubKey: ", Bitcoin.script.toASM(scriptPubKey));
  return Bitcoin.address.fromOutputScript(scriptPubKey, network);
}

CM.prototype.isAddressOfAccount = function (account, accountAddress) {
//console.log("[isAddressesOfAccount] type: " + account.type + " ", accountAddress);
  var addr;
  switch (account.type) {
    case C.TYPE_PLAIN_HD:
      var key = this.deriveHdAccount(account.num, accountAddress.chain, accountAddress.hdindex);
      addr = key.getAddress();
      break;
    default:
      var info = this.walletData.accounts[account.num].info;
      addr = calcP2SH(info, accountAddress.chain, accountAddress.hdindex, this.bitcoinNetwork);
  }
  console.log("[isAddressesOfAccount] accountAddress: " + accountAddress.address + " calcAddr: " + addr);
  return accountAddress.address === addr;
};

CM.prototype.analyzeTx = function (state) {
  var account = state.account;
  var recipients = state.recipients;
  var ptx = state.ptx;
  var inputs = ptx.inputs;
  var changes = ptx.changes;
  var tx = this.decodeTxFromBuffer(new Buffer(ptx.rawTx, 'hex'));
  var amountInOur = 0;
  var amountInOther = 0;
  var amountToRecipients = 0;
  var amountToChange = 0;
  var amountToUnknown = 0;
  var error;
  var i, j;
  //console.log("ANALYZE", ptx);

  // TODO: Per conoscere gli amount degli input dobbiamo usare un servizio come chain.so o similare
//  if (this.externalTxValidator && !this.isRegTest()) {
//    var provider = BlockChainApi.getProvider(this.externalTxValidator);
//    if (provider) {
//      provider.api.getTxOutputs(tx.ins).then(function (res) {
//                ...
//      });
//    }
//  }

  // TODO: This code must be updated when the transaction contains unknown inputs, like in CoinJoin
  for (i = 0; i < tx.ins.length; i++) {
    var txInput = tx.ins[i];
    console.log("INPUT #" + i, txInput);
    for (j = 0; i < inputs.length; i++) {
      var preparedInput = inputs[i];
      if (txInput.address === preparedInput.address) {
//        if (txInput.amount === preparedInput.amount)
        amountInOur += preparedInput.amount;
//        else
//          error = "Input amount not matching";
      } else {
        amountInOther += txInput.amount;
      }
    }
  }

  // Calc amount for defined recipients, for the change, and to unknown addresses
  // Mark our recipients to verify that none is left
  for (i = 0; i < tx.outs.length; i++) {
    var output = tx.outs[i];
    var toAddr = this.decodeAddressFromScript(output.script);
    console.log("[Analyze] Output #" + i + " to: " + toAddr + " amount: " + output.value + " script: " + output.script.buffer.toString('hex'));
    var isChange = false;
    for (j = 0; j < changes.length; j++) {
      if (toAddr === changes[j].aa.address) {
        amountToChange += output.value;
        isChange = true;
        break;
      }
    }
    if (!isChange) {
      var isRecipient = false;
      for (j = 0; j < recipients.length; j++) {
        var recipient = recipients[j];
        if (toAddr === recipient.address) {
          if (output.value === recipient.amount) {
            amountToRecipients += output.value;
            isRecipient = true;
            recipient.validated = true;
          } else {
            error = "Wrong amount sent to recipient";
          }
          break;
        }
      }
      if (!isRecipient)
        amountToUnknown += output.value;
    }
  }

  // Verify that all recipients have been validated
  for (i = 0; i < recipients.length; i++)
    if (!recipients[i].validated)
      error = "Missing recipient";
  var txKb = (ptx.rawTx.length / 2) / 1024;
  var maximumAcceptableFee = txKb * C.MAXIMUM_FEE_PER_KB;
  if (maximumAcceptableFee < C.MAXIMUM_BASE_FEE)
    maximumAcceptableFee = C.MAXIMUM_BASE_FEE;
  var fees = amountInOur - amountToRecipients - amountToChange;
  if (fees > maximumAcceptableFee)
    error = "Fees too high";
  else if (fees !== ptx.fees)
    error = "Calculated fees does not match server info";
  else if (!this.areAddressesOfAccount(account, changes))
    error = "Change address not validated";
  else if (amountToUnknown !== 0)
    error = "Destination address not validated";
  console.log("[ANALYZE] to-dest: " + amountToRecipients + " to-change: " + amountToChange + " to-other: " + amountToUnknown + " fees: " + fees +
          " txBytes: " + (ptx.rawTx.length / 2) + " Kb: " + txKb + " error: " + error);
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
  };
};

CM.prototype.payPrepare = function (account, recipients, options) {
  var self = this;
  if (!recipients || recipients.length === 0)
    return Q.reject({ex: "MethodArgumentNotValidException"});
  recipients.forEach(function (recipient) {
    if (!recipient.address || !self.validateAddress(recipient.address))
      return Q.reject({ex: "CmInvalidAddressException", value: recipient.address});
    var v = parseInt(recipient.amount);
    if (!v || v <= 0)
      return Q.reject({ex: "MethodArgumentNotValidException", value: v});
    recipient.amount = v;
  });
  var state = {account: account, recipients: recipients};
  // console.log("[STEP 0] account: " + account.pubId + " recipients: " + JSON.stringify(recipients));
  // TODO: aggiungere dei parametri alla walletOpen in modo che restituisca info su tutti gli account al login
  var promise = null;
  if (!this.walletData.accounts[account.num].info) {
    console.log("[CM payPrepare] Loading info for account #" + account.num);
    promise = this.accountGetInfo(account);
  }
  return Q(promise).then(function () {
    return self.ptxPrepare(account, recipients, options);
  }).then(function (res) {
    state.ptx = res.ptx;
    if (!options || !options.skipAnalyze)
      state.summary = self.analyzeTx(state);
    return state;
  });
};

CM.prototype.payConfirm = function (state, tfa) {
  var self = this;
  return self.signaturesPrepare({
    accountNum: state.account.num,
    progressCallback: state.progressCallback,
    rawTx: state.ptx.rawTx,
    inputs: state.ptx.inputs
  }).then(function (signatures) {
    return self.signaturesSubmit(state, signatures.map(function (o) {
      return o.sig.toDER().toString('hex');
    }), tfa);
  });
};

CM.prototype.payRecipients = function (account, recipients, options) {
  var self = this;
  return this.payPrepare(account, recipients, options).then(function (state) {
    if (state.summary.validated)
      return self.payConfirm(state, options ? options.tfa : undefined);
    else {
      var ex = {ex: "clientValidationFailure", msg: "Self validation not passed", error: state.summary.error};
      console.log(ex);
      return Q.reject(ex);
    }
  });
};

CM.prototype.getUnspents = function (account, pagingInfo) {
  var pars = addPagingInfo({pubId: account.pubId}, pagingInfo);
  console.log("[CM getUnspents] account: " + JSON.stringify(account));
  return this.rpc(C.ACCOUNT_GET_UNSPENT_TXS, null, pars).then(function (res) {
    //console.log("[CM] getUnspents: " + JSON.stringify(res));
    return res.slice;
  });
};

//
// Spending limits
//

CM.prototype.accountGetLimits = function (account) {
  console.log("[CM accountGetLimits] account: " + JSON.stringify(account));
  return this.rpc(C.ACCOUNT_LIMITS_GET, null, {
    pubId: account.pubId
  }).then(function (res) {
    console.log("res: " + JSON.stringify(res));
    return res;
  });
};

CM.prototype.accountSetLimit = function (account, limit, tfa) {
  console.log("[CM accountSetLimit] limit: " + JSON.stringify(limit) + " account: " + JSON.stringify(account));
  return this.rpc(C.ACCOUNT_LIMIT_SET, null, {
    pubId: account.pubId,
    type: limit.type, isHard: limit.isHard, amount: limit.amount,
    tfa: tfa
  }).then(function (res) {
    console.log("res: " + JSON.stringify(res));
    return res;
  });
};

CM.prototype.accountCancelLimitChange = function (account, limitType, tfa) {
  console.log("[CM accountCancelLimitChange] " + limitType + " account: " + JSON.stringify(account));
  return this.rpc(C.ACCOUNT_LIMIT_CANCEL_CHANGE, null, {
    pubId: account.pubId,
    type: limitType,
    tfa: tfa
  }).then(function (res) {
    return res;
  });
};

//
// TFA
//

CM.prototype.tfaGetWalletConfig = function () {
  return this.rpc(C.TFA_GET_WALLET_CONFIG, null, {}).then(function (res) {
    console.log("[CM tfaGetWalletConfig] res: " + JSON.stringify(res));
    return res.tfaConfig;
  });
};

CM.prototype.tfaEnrollStart = function (params, tfa) {
  if (!params.name)
    throwBadParamEx('params', "Missing name");
  console.log("[CM tfaEnrollStart] name: " + params.name + " value: " + params.value + " tfa: " + (tfa ? JSON.stringify(tfa) : "NONE"));
  return this.rpc(C.TFA_ENROLL_START, null, {
    name: params.name,
    value: params.value,
    data: params.data,
    address: params.appId,
    meta: params.meta,
    tfa: tfa
  }).then(function (res) {
    console.log("tfaEnrollStart: " + JSON.stringify(res));
    return res.tfaRes;
  });
};

CM.prototype.tfaEnrollFinish = function (tfa) {
  console.log("[CM tfaEnrollFinish] " + (tfa ? JSON.stringify(tfa) : "NONE"));
  return this.rpc(C.TFA_ENROLL_FINISH, null, {tfa: tfa}).then(function (res) {
    console.log("tfaEnrollFinish: " + JSON.stringify(res));
    return res.tfaRes;
  });
};

CM.prototype.tfaDeviceDelete = function (param, tfa) {
  return this.rpc(C.TFA_DEVICE_DELETE, null, {
    name: param.name,
    value: param.value,
    tfa: tfa
  }).then(function (res) {
    console.log("tfaDeviceDelete: ", res);
    return res;
  });
};

CM.prototype.tfaDeviceProposeDelete = function (param) {
  return this.rpc(C.TFA_DEVICE_PROPOSE_DELETE, null, {
    name: param.name,
    value: param.value
  }).then(function (res) {
    console.log("tfaDeviceProposeDelete: ", res);
    return res;
  });
};

CM.prototype.tfaDeviceSetMeta = function (params, tfa) {
  return this.rpc(C.TFA_DEVICE_SET_META, null, {
    name: params.name,
    value: params.value,
    meta: params.meta,
    tfa: tfa
  }).then(function (res) {
    console.log("tfaDeviceSetMeta: " + JSON.stringify(res));
    return res;
  });
};

CM.prototype.tfaDeviceSetNotifications = function (params, tfa) {
  return this.rpc(C.TFA_DEVICE_SET_NOTIFICATIONS, null, {
    name: params.name,
    value: params.value,
    data: params.enabled,
    tfa: tfa
  }).then(function (res) {
    return res;
  });
};

CM.prototype.tfaAuthStart = function (params) {
  return this.rpc(C.TFA_AUTH_REQUEST, null, {
    name: params.name,
    value: params.value,
    address: params.appId
  }).then(function (res) {
    console.log("tfaRequestCode: " + JSON.stringify(res));
    return res.tfaRes;
  });
};

CM.prototype.tfaAuthValidate = function (tfa) {
  console.log("[CM tfaAuthValidate] " + JSON.stringify(tfa));
  return this.rpc(C.TFA_AUTH_VALIDATE, null, {tfa: tfa}).then(function (res) {
    console.log("tfaAuthValidate: " + JSON.stringify(res));
    return res.tfaRes;
  });
};

CM.prototype.tfaGetAccountConfig = function (account) {
  return this.rpc(C.TFA_GET_ACCOUNT_CONFIG, null, {pubId: account.pubId}).then(function (res) {
    console.log("res: " + JSON.stringify(res));
    return res.tfaConfig;
  });
};

CM.prototype.tfaSetAccountConfig = function (account, config) {
  console.log("[CM tfaAetAccountConfig] config: " + JSON.stringify(config));
  return this.rpc(C.TFA_SET_ACCOUNT_CONFIG, null, {
    pubId: account.pubId, data: config.policy
  }).then(function (res) {
    console.log("res: " + JSON.stringify(res));
    return res.tfaConfig;
  });
};

//
// Address book methods
//

CM.prototype.abAdd = function (entry) {
  console.log("[CM ab add] " + JSON.stringify(entry));
  return this.rpc(C.AB_ADD, null, {
    type: entry.type,
    val: entry.val,
    labels: entry.labels,
    meta: entry.meta
  }).then(function (res) {
    console.log("[CM] abAdd: " + JSON.stringify(res));
    return res;
  });
};

CM.prototype.abUpdate = function (entry) {
  console.log("[CM abUpdate] " + JSON.stringify(entry));
  return this.rpc(C.AB_UPDATE, null, {
    id: entry.id,
    type: entry.type,
    val: entry.val,
    labels: entry.labels,
    meta: entry.meta
  }).then(function (res) {
    console.log("[CM] abUpdate: " + JSON.stringify(res));
    return res;
  });
};

CM.prototype.abDelete = function (entry) {
  console.log("[CM ab delete] " + JSON.stringify(entry));
  return this.rpc(C.AB_DELETE, null, {id: entry.id}).then(function (res) {
    console.log("[CM] abDelete: " + JSON.stringify(res));
    return res;
  });
};

CM.prototype.abGet = function (fromDate, pagingInfo) {
  console.log("[CM ab get] since: " + fromDate);
  var pars = addPagingInfo({fromDate: fromDate}, pagingInfo);
  return this.rpc(C.AB_GET, null, pars).then(function (res) {
    console.log("[CM ab get] " + JSON.stringify(res));
    return res.slice;
  });
};

//
// Chat / Messaging methods
//

CM.prototype.msgSendToAccount = function (account, to, payload, type) {
  return this.rpc(C.MSG_SEND_TO_ACCOUNT, null, {
    pubId: account.pubId,
    toAccount: to,
    payload: payload,
    type: type
  }).then(function (res) {
    return res;
  });
};

CM.prototype.msgSendToPtx = function (account, ptx, payload, type) {
  return this.rpc(C.MSG_SEND_TO_PTX, null, {
    pubId: account.pubId,
    toPtx: ptx.id,
    payload: payload,
    type: type
  }).then(function (res) {
    return res;
  });
};

CM.prototype.msgGetAllToWallet = function (fromDate, pagingInfo) {
  var pars = addPagingInfo({fromDate: fromDate}, pagingInfo);
  return this.rpc(C.MSG_GET_ALL_TO_WALLET, null, pars).then(function (res) {
    return res.slice;
  });
};

CM.prototype.msgGetAllToPtx = function (ptx, fromDate, pagingInfo) {
  var pars = addPagingInfo({toPtx: ptx.id, fromDate: fromDate}, pagingInfo);
  return this.rpc(C.MSG_GET_ALL_TO_PTX, null, pars).then(function (res) {
    return res.slice;
  });
};

CM.prototype.msgGetAllToPtxs = function (fromDate, pagingInfo) {
  var pars = addPagingInfo({fromDate: fromDate}, pagingInfo);
  return this.rpc(C.MSG_GET_ALL_TO_PTXS, null, pars).then(function (res) {
    return res.slice;
  });
};
//
//
// Non-promise returning methods
//

// TODO-security: applicare la firma alla ptx per essere sicuri che sia stata preparata dall'utente
// e non sia stata creata malevolmente dal server
CM.prototype.rebuildStateFromPtx = function (account, ptx) {
  return {
    ptx: ptx,
    account: account,
    info: ptx.info,
    recipients: null,
    validated: false
  };
};

CM.prototype.validateAddress = function (addr) {
  try {
    Bitcoin.address.fromBase58Check(addr);
    return true;
  } catch (ex) {
    return false;
  }
};

CM.prototype.peekAccounts = function () {
  return this.walletData.accounts;
};

CM.prototype.derivePubKeys = function (xpubs, chain, hdIndex) {
  return derivePubKeys(xpubs, chain, hdIndex, this.bitcoinNetwork);
};

module.exports = CM;
