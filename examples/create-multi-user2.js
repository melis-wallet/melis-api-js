const Melis = require('../src/cm')
const C = Melis.C
const cm = new Melis({ apiDiscoveryUrl: C.MELIS_TEST_DISCOVER })
const seed = cm.random32HexBytes()

if (process.argv.length < 3) {
  console.log("Please pass joinCode as first argument")
  process.exit(1)
}
var joinCode = process.argv[2]

// Disable melis logs
cm.log = function () { }

cm.on(C.EVENT_NEW_ACCOUNT, event => {
  console.log("NEW Account: ", event)
})

cm.on(C.EVENT_ACCOUNT_UPDATED, event => {
  console.log("Account event: ", event)
})

cm.connect().then(config => {
  console.log("Connected to server")
  return cm.walletRegister(seed)
}).then(wallet => {
  console.log("Wallet opened with seed: " + seed)
  return cm.accountJoin({ code: joinCode })
}).then(res => {
  console.log("Multisig account joined with joinCode: " + joinCode, res)
}).catch(error => {
  console.log("Unexpected exception " + error.ex + " : " + error.message)
}).finally(() => {
  return cm.disconnect()
})