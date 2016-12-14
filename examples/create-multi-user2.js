var CM = require('../src/cm')
var C = CM.C
var cm = new CM({apiDiscoveryUrl: C.MELIS_TEST_DISCOVER})
var seed = cm.random32HexBytes()

if (process.argv.length < 3) {
  console.log("Please pass joinCode as first argument")
  process.exit(1)
}
var joinCode = process.argv[2]

cm.log = function () {} // Disable logs
cm.connect().then((config) => {
  console.log("Connected to server. Blockchain height: " + config.topBlock.height + " joinCode: " + joinCode)
  return cm.walletRegister(seed)
}).then(wallet => {
  console.log("Wallet opened with seed: " + seed)
  return cm.accountJoin({code: joinCode})
}).then(res => {
  console.log("Multisig account joined with joinCode: " + joinCode)
  return cm.disconnect()
}).catch(error => {
  console.log("Unexpected exception: ", error)
})