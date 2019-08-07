const Melis = require('../src/cm')
const C = Melis.C
const seed = melis.random32HexBytes()

const coin = C.COIN_TEST_BCH

let account

function doExit(msg) {
  if (msg)
    console.log(msg)
  melis.disconnect()
  process.exit(0)
}

const melis = new Melis({
  apiDiscoveryUrl: C.MELIS_TEST_DISCOVER
})
melis.setLogger() // Disable logs
melis.on(C.EVENT_JOINED, event => {
  console.log("Cosigner joined: " + event.activationCode.pubId + ", the account is ready!", event)
  return melis.getUnusedAddress(account).then(addr => {
    console.log("Receiving address: ", addr)
  })
})
melis.on(C.EVENT_ACCOUNT_UPDATED, event => {
  console.log("Account event: ", event)
})

async function createAccountAndWait() {
  const config = await melis.connect()
  const topBlock = config.topBlocks[coin]
  console.log("Connected to server. Blockchain height for coin " + coin + ": " + topBlock.height + " hash: " + topBlock.hash)
  const wallet = await melis.walletRegister(seed)
  console.log("Wallet opened with master seed: " + seed)
  const res = await melis.accountCreate({
    coin,
    type: C.TYPE_MULTISIG_MANDATORY_SERVER,
    cosigners: [{
      name: 'Frank'
    }],
    minSignatures: 1
  })
  console.log("Account creation data:", res)
  account = res.account
  const cosigners = res.accountInfo.cosigners
  let joinCode
  cosigners.forEach(info => {
    if (info.name === 'Frank')
      joinCode = info.code
  })
  console.log("Waiting for cosigner with join code " + joinCode + " to join my account -- Press ctrl-c to exit")
}

(async () => {
  try {
    await createAccountAndWait()
  } catch (ex) {
    doExit("Unexpected exception: ", error)
  }
})()