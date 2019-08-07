const process = require('process')
const MELIS = require('../src/cm')
const C = MELIS.C
const melis = new MELIS({
  apiDiscoveryUrl: C.MELIS_TEST_DISCOVER
})
melis.setLogger() // Disable melis logs

const seed = "58e5e9e58956d9db4aeff9875994dcf253186d26884ddc25031fab98eff6ea34" // our test wallet

if (process.argv.length != 3)
  doExit("You need to specify the payload in hex as command line argument")

const payload = Buffer.from(process.argv[2], 'hex')

function doExit(msg) {
  if (msg)
    console.log(msg)
  melis.disconnect()
  process.exit(0)
}

let myWallet
async function connectAndSelectAccount() {
  const config = await melis.connect()
  console.log("Connected to server. ")
  const wallet = await melis.walletOpen(seed)
  console.log("Wallet opened with seed: " + seed)
  myWallet = wallet
  let account

  // Search a BCH account
  const pubIds = Object.keys(wallet.accounts)
  console.log("pubIds: ", pubIds)
  for (let i = 0; i < pubIds.length; i++) {
    const a = wallet.accounts[pubIds[i]]
    if (a.coin === C.COIN_TEST_BCH) {
      account = a
      break
    }
  }

  // If not found, create one
  if (!account) {
    console.log("No TBCH account yet, creating it")
    const res = await cm.accountCreate({
      coin: C.COIN_TEST_BCH,
      type: C.TYPE_PLAIN_HD
    })
    account = res.account
  }

  console.log("Using account with pubId: " + account.pubId + " (#" + account.num + ")")
  const balance = melis.peekAccountBalance(account)
  console.log("Confirmed funds (satoshis):" + balance.amAvailable + " unconfirmed: " + balance.amUnconfirmed)

  if (balance.amAvailable + balance.amUnconfirmed < 1000000) {
    const aa = await melis.getUnusedAddress(account)
    const address = aa.address
    doExit("Not enough funds to operate, please send some test BCH to: " + address)
  }

  return account
}

(async () => {
  const account = await connectAndSelectAccount()
  console.log("Preparing to push " + payload.toString('hex') + " into the Bitcoin Cash Testnet network")
  const res = await melis.payRecipients(account, [{
    payloadBase64: payload.toString('base64'),
    amount: 0
  }], {
    allowUnconfirmed: true
  })
  console.log("PUSH result:", res)
  console.log("---- TRANSACTION " + res.hash + " PUSHED TO NETWORK ----")
  doExit("Check TX status at https://explorer.bitcoin.com/tbch/tx/" + res.hash)
})()