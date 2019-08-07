const Melis = require('../src/cm')
const C = Melis.C

function doExit(msg) {
  if (msg)
    console.log(msg)
  melis.disconnect()
  process.exit(0)
}

if (process.argv.length < 3) {
  console.log("Please pass joinCode as first argument")
  process.exit(1)
}
const joinCode = process.argv[2]

const melis = new Melis({
  apiDiscoveryUrl: C.MELIS_TEST_DISCOVER
})
const seed = melis.random32HexBytes()
melis.setLogger()
melis.on(C.EVENT_NEW_ACCOUNT, event => {
  console.log("NEW Account: ", event)
})
melis.on(C.EVENT_ACCOUNT_UPDATED, event => {
  console.log("Account event: ", event)
})

async function joinAccountAndWait() {
  const config = await melis.connect()
  console.log("Connected to server.")
  const wallt = await melis.walletRegister(seed)
  console.log("Wallet opened with seed: " + seed)
  const res = await melis.accountJoin({
    code: joinCode
  })
  console.log("Multisig account joined with joinCode: " + joinCode, res)
}

(async () => {
  try {
    await joinAccountAndWait()
    await melis.disconnect()
  } catch (ex) {
    doExit("Unexpected exception: ", error)
  }
})()