var CM = require('../src/cm')
var C = CM.C
var cm = new CM({apiDiscoveryUrl: C.MELIS_TEST_DISCOVER})
var seed = "58e5e9e58956d9db4aeff9875994dcf253186d26884ddc25031fab98eff6ea34" // or cm.random32HexBytes()

var myWallet, myAccount, myAddress

cm.on(C.EVENT_TX_INFO_NEW, res => {
  console.log("New transaction received!\n", res.txInfo)
})

cm.on(C.EVENT_TX_INFO_UPDATED, res => {
  if (res.txInfo.blockMature > 0)
    console.log("TX has been confirmed!")
})

cm.log = function () {} // Disable logs

cm.connect().then((config) => {
  console.log("Connected to server. Blockchain height: " + config.topBlock.height)
  return cm.walletOpen(seed)
}).then(wallet => {
  console.log("Wallet opened with seed: " + seed)
  myWallet = wallet
  myAccount = wallet.accounts[Object.keys(wallet.accounts)[0]]
  console.log("Using account " + myAccount.num + " with pubId: " + myAccount.pubId)
  return cm.getUnusedAddress(myAccount)
}).then(res => {
  myAddress = res.address
  console.log("Waiting for TEST coins to " + myAddress + " -- Press ctrl-c to exit")
}).catch(error => {
  console.log("Unexpected exception: ", error)
})