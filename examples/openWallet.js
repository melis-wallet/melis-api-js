var process = require('process')
var CM = require('../src/cm')
var C = CM.C
var cm = new CM({apiDiscoveryUrl: C.MELIS_TEST_DISCOVER})

var args = process.argv.slice(2)
if (args.length < 1) {
  console.log("syntax: node wallet.js open|create [<hexseed>]")
  process.exit(0)
}

var doCreate = false
var cmd = args[0]

var seed
if (args.length > 1)
  seed = args[1]

if (cmd === 'create') {
  doCreate = true
  if (!seed)
    seed = cm.random32HexBytes()
} else if (cmd === 'open') {
} else {
  console.log("invalid command: " + cmd)
  process.exit(0)
}

console.log((doCreate ? "Creating wallet" : "Opening wallet") + " using seed: " + seed)

cm.connect().then(function (config) {
  console.log("Connected to server")
  if (doCreate)
    return cm.walletRegister(seed)
  else
    return cm.walletOpen(seed)
}).catch(function (err) {
  console.log("Unable to open wallet: ", err)
  process.exit(-1)
}).then(function (wallet) {
  console.log("Wallet", wallet)
  var account
  for (var i in wallet.accounts)
    if (!account)
      account = wallet.accounts[i]
  console.log("selected account: ", account)
  return cm.addressesGet(account)
}).then(function (slice) {
  var l = slice.list
  console.log("Addresses: ")
  l.forEach(function (x) {
    console.log(x.address)
  })
  //return cm.disconnect()
})

