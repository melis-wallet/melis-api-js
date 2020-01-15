// example arguments
// coin: TBCH
// account extended key: tprv8fc9wmH7L6FKPaThEwgv9Kr42U6o1ep4kCUeDWq7eH6TaUEudfjGZpytfEeDWAWE7e3daF8ysKN1fww3kGqWeCHnFEiXgGLpsuYeqS7aEn3
const MELIS = require('../src/cm')
const C = MELIS.C
const melis = new MELIS({
  apiDiscoveryUrl: C.MELIS_TEST_DISCOVER
})
melis.setLogger() // Disable melis logs

if (process.argv.length != 4)
  doExit("You need to specify the coin and account extended key as command line argument")

const coin = process.argv[2]
const b58 = process.argv[3]

function doExit(msg) {
  if (msg)
    console.log(msg)
  melis.disconnect()
  process.exit(0)
}

async function connectAndLoginWithAccount(coin, masterAccountKey) {
  const config = await melis.connect()
  console.log("Connected to server. ")
  const res = await melis.accountOpen(masterAccountKey, {
    coin
  })
  console.log("Single account logged in: ", res)
  return res.accountData.account
}

(async () => {
  const account = await connectAndLoginWithAccount(coin, b58)
  const slice = await melis.addressesGet(account)
  console.log(`List of ${slice.list.length} latest active addresses:`)
  slice.list.forEach(aa => {
    console.log(aa.address)
  })
  doExit("Disconnecting")
})()