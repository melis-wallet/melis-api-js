//require('es6-promise').polyfill();
require('isomorphic-fetch')

var forEachOut = function (outs, fun) {
  var promises = [];
  outs.forEach(function (out) {
    promises.push(fun(out));
  });
  return Promise.all(promises);
};

var parseBtcAmount = function (s) {
  var m = s.match(/(\d+)\.(\d+)/);
  var intPart = parseInt(m[1]);
  var frac = parseInt(m[2]);
  return frac + intPart * 100000000;
};

//const https = require('https');
//  ES6 version
//  return fetch("https://chain.so/api/v2/get_tx_outputs/BTC/" + hash + "/" + output)
//          .then(r => r.json())
//          .then(r => {
//          var data = r.data;
//                  return {
//                    address: data.outputs.address,
//                    value: data.outputs.value
//                    }
//          });
//fetch(url).then(r => r.json())
//  .then(data => console.log(data))
//  .catch(e => console.log("Booo"))

//https://blockexplorer.com/api/tx/5756ff16e2b9f881cd15b8a7e478b4899965f87f553b6210d0f8e5bf5be7df1d
var blockexplorer_provider = {
  getTxOutput: function (hash, output) {
    //return fetch("https://blockexplorer.com/api/tx/" + hash, {      mode: 'no-cors'    }).then(function (res) {
    return fetch("https://blockexplorer.com/api/tx/" + hash).then(function (res) {
      return res.json();
    }).then(function (res) {
      var vouts = res.vout;
      var vout = vouts[output];
      return {
        n: vout.n,
        //address: vout.addr,
        amount: parseBtcAmount(vout.value)
      };
    });
  }
};

//https://blockchain.info/it/rawtx/4addbc5ec75e087a44a34e8c1c3bd05fd495771072879a89a8c9aaa356255cb2?cors=true
var blockchain_provider = {
  //torUrl: "https://blockchainbdgpzk.onion/",
  getTxOutputs: function (outs) {
    return forEachOut(outs, function (out) {
      // return fetch("https://blockchain.info/rawtx/" + out.tx + "?cors=true", {mode: 'no-cors'}).then(function (res) {
      return fetch("https://blockchain.info/rawtx/" + out.tx + "?cors=true").then(function (res) {
        return res.json();
      }).then(function (res) {
        var vouts = res.out;
        var vout = vouts[out.n];
        return {
          n: vout.n,
          // address: vout.addr,
          amount: vout.value
        };
      });
    });
  }
};

// Batch supported limit=1  outstart=X
// http://api.blockcypher.com/v1/btc/main/txs/a40c283de4c26b027a5734ff89ce78ade1220fc313befa107ec6c245c24bdec0;60c1f1a3160042152114e2bba45600a5045711c3a8a458016248acec59653471
var blockcypher_provider = function (isTestnet) {
  let baseUrl = "https://api.blockcypher.com/v1/btc/" + (isTestnet ? "test3" : "main")

  function getRawBlockChainStatus() {
    return fetch(baseUrl).then(function (res) {
      if (res.status !== 200)
        return null
      return res.json()
    })
  }

  function getRawTxOut(hash, out) {
    let url = baseUrl + "/txs/" + hash + "?limit=1&outstart=" + out
    //console.log('Requesting rawtxdata for ' + hash + "/" + out + " url: " + url)
    return fetch(url).then(function (res) {
      if (res.status !== 200)
        return null
      return res.json()
    })
  }

  return {
    submitTx: (hexTx) => {
      let url = baseUrl + "/txs/push"
      var body = {tx: hexTx}
      return fetch(url, {method: 'POST', body: JSON.stringify(body)}).then((res) => {
        console.log("[blockcypher submitTx] res: ", res)
        return res
//        res.json().then(res => {
//          return {
//            hash: res.tx.hash,
//            rawRes: res.json()
//          }
//        })
      })
    },

    getBlockChainStatus: () => {
      return getRawBlockChainStatus().then(res => {
        return {
          chain: isTestnet ? 'test' : 'main',
          height: res.height
                  //hash: res.hash,
                  //time: res.time
        }
      })
    },

    getRawTxOut: (hash, out) => {
      return getRawTxOut(hash, out)
    },

    getTxOutputs: function (outs) {
      return forEachOut(outs, function (out) {
        return getRawTxOut(out.tx, out.n).then(res => {
          if (!res)
            return null
          var data = res.outputs[0];
          return {
            n: out.n,
            // address: data.addresses[0],
            amount: data.value,
            spent: data.spent_by ? {
              tx: data.spent_by,
              inputNum: null
            } : null
          }
        })
      })
    }
  }
}

/*
 * chain.so
 */
var chainso_provider = function (isTestnet) {
  var network = (isTestnet ? "BTCTEST" : "BTC")
  let baseUrl = "https://chain.so/api/v2/"

  function getData(url, opts) {
    console.log("[CHAINSO DEBUG] Request for " + url + " with opts:", opts)
    return fetch(url, opts).then(function (res) {
      console.log("[CHAINSO DEBUG] res:", res)
      if (res.status !== 200)
        return null
      return res.json()
    }).then(json => {
      if (!json || !json.status === "success")
        return null
      return json.data
    })
  }

  function getRawBlockChainStatus() {
    let url = baseUrl + "get_info/" + network
    return getData(url)
  }

  function getRawTxOutSpent(hash, out) {
    let url = baseUrl + "is_tx_spent/" + network + "/" + hash + "/" + out
    console.log('[chain.so] Requesting is_tx_spent for ' + hash + "/" + out + " url: " + url)
    return getData(url)
  }

  function getRawTxOut(hash, out) {
    let url = baseUrl + "get_tx_outputs/" + network + "/" + hash + "/" + out
    console.log('[chain.so] Requesting get_tx_output for ' + hash + "/" + out + " url: " + url)
    return getData(url)
  }

  return {
    getBlockChainStatus: () => {
      return getRawBlockChainStatus().then(res => {
        return {
          chain: isTestnet ? 'test' : 'main',
          height: res.blocks
                  //hash: res.hash,
                  //time: res.time
        }
      })
    },

    submitTx: (hexTx) => {
      let url = baseUrl + "send_tx/" + network
      var body = {tx_hex: hexTx}
      return getData(url, {method: 'POST', body: JSON.stringify(body)})
    },

    getRawTxOutSpent: (hash, out) => {
      return getRawTxOutSpent(hash, out)
    },

    getRawTxOut: (hash, out) => {
      return getRawTxOut(hash, out)
    },

    getTxOutputs: function (outs) {
      let outResult
      return forEachOut(outs, function (out) {
        return getRawTxOut(out.tx, out.n).then(res => {
          if (!res)
            return null
          outResult = res.outputs
          return getRawTxOutSpent(out.tx, out.n)
        }).then(res => {
          return {
            n: outResult.output_no,
            // address: data.outputs.address,
            amount: parseBtcAmount(outResult.value),
            spent: res.spent ? {
              tx: res.spent.txid,
              inputNum: res.spent.input_no
            } : null
          }
        })
      })
    }
  }
}

/*
 * blockr.io
 */
var blockr_provider = function (isTestnet) {
  var baseUrl = "https://" + (isTestnet ? "tbtc" : "btc") + ".blockr.io/api/v1/";
  return  {
    submitTx: (hexTx) => {
      const url = baseUrl + "tx/push"
      const body = {hex: hexTx}
      return fetch(url, {method: 'POST', body: JSON.stringify(body)}).then(res => {
        return res.json()
      })
    },

    // https://btc.blockr.io/api/v1/tx/info/60c1f1a3160042152114e2bba45600a5045711c3a8a458016248acec59653471,4addbc5ec75e087a44a34e8c1c3bd05fd495771072879a89a8c9aaa356255cb2
    getTxOutputs: function (outs) {
      return forEachOut(outs, function (out) {
        var url = baseUrl + "tx/info/" + out.tx;
        return fetch(url).then(res => {
          return res.json()
        }).then(res => {
          var vouts = res.data.vouts;
          var vout = vouts[out.n];
          return {
            n: vout.n,
            // address: vout.address,
            amount: parseBtcAmount(vout.amount)
          };
        });
      });
    }
  };
};

// TODO: https://webbtc.com/api

var testnet_providers = [
  //{name: "blockexplorer.com", api: blockexplorer_provider},
  //{name: "blockchain.info", api: blockchain_provider},
  {name: "blockcyphercom", api: blockcypher_provider(1)},
  {name: "chainso", api: chainso_provider(1)},
  {name: "blockrio", api: blockr_provider(1)}
];

var prodnet_providers = [
  //{name: "blockexplorer.com", api: blockexplorer_provider},
  {name: "blockchaininfo", api: blockchain_provider},
  {name: "blockcyphercom", api: blockcypher_provider(0)},
  {name: "chainso", api: chainso_provider(0)},
  {name: "blockrio", api: blockr_provider(0)}
];

function API(config) {
  this.testnet_providers = testnet_providers;
  this.prodnet_providers = prodnet_providers;
  this.lastProvider = Math.floor(Math.random() * prodnet_providers.lenght);
}

API.prototype.getProviders = function (isTestnet) {
  return (isTestnet ? this.testnet_providers : this.prodnet_providers);
};

API.prototype.getProviderNames = function (isTestnet) {
  return (isTestnet ? this.testnet_providers : this.prodnet_providers).map(function (o) {
    return o.name;
  });
};

API.prototype.getProvider = function (name, isTestnet) {
  return (isTestnet ? this.testnet_providers : this.prodnet_providers).find(function (o) {
    return o.name === name;
  });
};

// TODO: https://explorer.blockstack.org/
// TODO: https://www.smartbit.com.au/api

module.exports = API;

//API.prototype.getTxOutputs = function (arr, providerName) {
//  if (!arr)
//    return null;
//  this.lastProvider = (this.lastProvider + 1) % this.prodnet_providers.length;
//  var provider = this.prodnet_providers[API.lastProvider];
//  if (providerName) {
//    var p = this.prodnet_providers.find(function (elem) {
//      return elem.name === providerName;
//    });
//    if (p)
//      provider = p;
//  }
//  //return provider.api.getTxOutput(arr[0].tx, arr[0].out).then(function (res) {
//  return provider.api.getTxOutput(arr).then(function (res) {
//    return {
//      providerName: provider.name,
//      outs: res
//    };
//  });
//};

