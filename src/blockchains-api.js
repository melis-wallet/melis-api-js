"use strict";
require('es6-promise').polyfill();
//var Promise = require('es6-promise').Promise;
require('isomorphic-fetch');
//var fetch = require('node-fetch');

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
    return fetch("https://blockexplorer.com/api/tx/" + hash, {
      mode: 'no-cors'
    }).then(function (res) {
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
      return fetch("https://blockchain.info/rawtx/" + out.tx + "?cors=true", {
        mode: 'no-cors'
      }).then(function (res) {
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
  var baseUrl = "http://api.blockcypher.com/v1/btc/" + (isTestnet ? "test3" : "main") + "/txs/";
  return {
    getTxOutputs: function (outs) {
      return forEachOut(outs, function (out) {
        var url = baseUrl + out.tx + "?limit=1&outstart=" + out.n;
        return fetch(url, {mode: 'no-cors'}).then(function (res) {
          return res.json();
        }).then(function (res) {
          //console.log(res);
          var data = res.outputs[0];
          //console.log(data);
          return {
            n: out.n,
            // address: data.addresses[0],
            amount: data.value
          };
        });
      });
    }
  };
};

var chainso_provider = function (isTestnet) {
  var network = (isTestnet ? "BTCTEST" : "BTC");
  return {
    getTxOutputs: function (outs) {
      return forEachOut(outs, function (out) {
        return fetch("https://chain.so/api/v2/get_tx_outputs/" + network + "/" + out.tx + "/" + out.n, {
          mode: 'no-cors'
        }).then(function (res) {
          return res.json();
        }).then(function (res) {
          var data = res.data;
          return {
            n: data.outputs.output_no,
            // address: data.outputs.address,
            amount: parseBtcAmount(data.outputs.value)
          };
        });
      });
    }
  };
};

// https://btc.blockr.io/api/v1/tx/info/60c1f1a3160042152114e2bba45600a5045711c3a8a458016248acec59653471,4addbc5ec75e087a44a34e8c1c3bd05fd495771072879a89a8c9aaa356255cb2
var blockr_provider = function (isTestnet) {
  var baseUrl = "https://" + (isTestnet ? "tbtc" : "btc") + ".blockr.io/api/v1/";
  return  {
    getTxOutputs: function (outs) {
      return forEachOut(outs, function (out) {
        var url = baseUrl + "tx/info/" + out.tx;
        return fetch(url, {mode: 'no-cors'}).then(function (res) {
          return res.json();
        }).then(function (res) {
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
  {name: "blockcypher.com", api: blockcypher_provider(1)},
  {name: "chain.so", api: chainso_provider(1)},
  {name: "blockr.io", api: blockr_provider(1)}
];

var prodnet_providers = [
  //{name: "blockexplorer.com", api: blockexplorer_provider},
  {name: "blockchain.info", api: blockchain_provider},
  {name: "blockcypher.com", api: blockcypher_provider(0)},
  {name: "chain.so", api: chainso_provider(0)},
  {name: "blockr.io", api: blockr_provider(0)}
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

