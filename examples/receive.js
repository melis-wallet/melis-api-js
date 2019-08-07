// TESTNET FAUCETS:
// BCH: https://testnet.manu.backend.hamburg/bitcoin-cash-faucet
// BTC: https://testnet.manu.backend.hamburg/faucet
// LTC: http://testnet.litecointools.com/

const MELIS = require('../src/cm')
const C = MELIS.C
const melis = new MELIS({
  apiDiscoveryUrl: C.MELIS_TEST_DISCOVER
})
melis.setLogger() // Disable logs

const seed = "58e5e9e58956d9db4aeff9875994dcf253186d26884ddc25031fab98eff6ea34" // or cm.random32HexBytes()
let myWallet, myAccount, myAddress

function doExit(msg) {
  if (msg)
    console.log(msg)
  melis.disconnect()
  process.exit(0)
}

melis.on(C.EVENT_TX_INFO_NEW, res => {
  console.log("New transaction received!\n", res.txInfo)
})

melis.on(C.EVENT_TX_INFO_UPDATED, res => {
  if (res.txInfo.blockMature > 0)
    console.log("TX has been confirmed!")
})

async function openWalletAndGetAddress() {
  const config = await melis.connect()
  console.log("Connected to server. Platform:" + config.platform + " Supported coins: ", config.coins)
  const wallet = await melis.walletOpen(seed)
  console.log("Wallet opened with seed: " + seed)
  myWallet = wallet
  myAccount = wallet.accounts[Object.keys(wallet.accounts)[0]]
  console.log("Using account " + myAccount.num + " with pubId: " + myAccount.pubId)
  const aa = await melis.getUnusedAddress(myAccount)
  myAddress = aa.address
  console.log("Waiting for Bitcoin Testnet coins to " + myAddress + " -- Press ctrl-c to exit")
}

(async () => {
  try {
    await openWalletAndGetAddress()
  } catch (ex) {
    doExit("Unexpected exception: ", error)
  }
})()