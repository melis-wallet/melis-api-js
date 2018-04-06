const Melis = require('../src/cm')
const C = Melis.C
const melis = new Melis({ apiDiscoveryUrl: C.MELIS_TEST_DISCOVER })
const seed = melis.random32HexBytes()

const coin = C.COIN_TEST_BTC, returnAddress = "2N8hwP1WmJrFF5QWABn38y63uYLhnJYJYTF"

let account

melis.on(C.EVENT_JOINED, event => {
  console.log("Cosigner joined: " + event.activationCode.pubId + ", the account is ready!", event)
  return melis.getUnusedAddress(account).then(addr => {
    console.log("Receiving address: ", addr)
  })
})

melis.on(C.EVENT_ACCOUNT_UPDATED, event => {
  console.log("Account event: ", event)
})

melis.log = function () { } // Disable logs

melis.connect().then((config) => {
  const topBlock = config.topBlocks[coin]
  console.log("Connected to server. Blockchain height for coin " + coin + ": " + topBlock.height + " hash: " + topBlock.hash)
  return melis.walletRegister(seed)
}).then(wallet => {
  console.log("Wallet opened with master seed: " + seed)
  return melis.accountCreate({
    coin,
    type: C.TYPE_MULTISIG_MANDATORY_SERVER,
    cosigners: [{ name: 'Frank' }],
    minSignatures: 1
  })
}).then(res => {
  console.log("Account creation data:", res)
  account = res.account
  const cosigners = res.accountInfo.cosigners
  let joinCode
  cosigners.forEach(info => {
    if (info.name === 'Frank')
      joinCode = info.code
  })
  console.log("Waiting for cosigner with join code " + joinCode + " to join my account -- Press ctrl-c to exit")
}).catch(error => {
  console.log("Unexpected exception: ", error)
})