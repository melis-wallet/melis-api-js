const Bitcoin = require('bitcoinjs-lib')

const networks = {
    BTC: Bitcoin.networks.bitcoin,
    TBTC: Bitcoin.networks.testnet,
    RBTC: Bitcoin.networks.testnet,
    BCH: Bitcoin.networks.bitcoin,
    TBCH: Bitcoin.networks.testnet,
    RBCH: Bitcoin.networks.testnet
}

module.exports = networks