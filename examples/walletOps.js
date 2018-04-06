const Q = require('q')
const process = require('process')
var argv = require('minimist')(process.argv.slice(2));

const Melis = require('../src/cm')
const C = Melis.C
const melis = new Melis({ apiDiscoveryUrl: C.MELIS_TEST_DISCOVER })
melis.log = function () { }   // Disable logs

let args = argv._

const availCmds = new Set(["open", "create", "showAccounts", "showAddresses", "pay", "newAddress"])

function usage(msg, skipInstructions) {
  if (!skipInstructions) {
    console.log("syntax: node walletOps.js [--seed=seed] [--account=pubId] <cmd>")
    console.log("<cmd> is one of", availCmds)
  }
  if (msg)
    console.log(msg)
  process.exit(0)
}

if (args.length < 1)
  usage()
const cmd = args[0]
let seed = argv.seed
const pubId = argv.account
const address = argv.address
const amount = argv.amount

function requireParams(...params) {
  params.forEach(p => {
    if (!argv[p])
      usage("Missing option --" + p)
  })
}

if (!availCmds.has(cmd))
  usage("Invalid command: " + cmd)

let doCreate = false
switch (cmd) {
  case 'create':
    doCreate = true
    if (!seed)
      seed = melis.random32HexBytes()
    break;
  case 'showAccounts':
    requireParams("seed");
    break;
  case 'showAddresses':
    requireParams("seed", "account");
    break;
  case 'newAddress':
    requireParams("seed", "account");
    break;
  case 'pay':
    requireParams("seed", "account", "address", "amount");
    break;
}

console.log((doCreate ? "Creating wallet" : "Opening wallet") + " using seed: " + seed)

function getAccountFromPubId(pubId) {
  const account = melis.peekAccounts()[pubId]
  if (!account)
    usage("Unable to find account " + pubId + " in wallet", true)
  return account
}

function showAccounts(wallet) {
  const accounts = wallet.accounts
  if (!Object.keys(accounts).length)
    console.log("No accounts in wallet")
  else
    Object.keys(accounts).forEach(pubId => {
      const acc = accounts[pubId]
      const bal = wallet.balances[pubId]
      console.log("Account " + pubId + " coin: " + acc.coin + " type: " + acc.type + " status: " + acc.status + " confirmed: " + bal.amAvailable + " unconfirmed: " + bal.amUnconfirmed)
    })
}

async function showAddresses(pubId) {
  const account = getAccountFromPubId(pubId)
  const slice = await melis.addressesGet(account)
  var l = slice.list
  console.log("List of addresses for account " + pubId + ": ")
  l.forEach(x => {
    console.log(x.address)
  })
}

function pay(pubId, address, amount, options) {
  const account = getAccountFromPubId(pubId)
  return melis.payRecipients(account,
    [{ address, amount, isRemainder: (amount === 0) }], options).then(res => {
      console.log("Payment sent to " + address + " hash: ", res)
    }).catch(err => {
      console.log("Unable to pay " + amount + " to address: " + address, err)
    })
}

function newAddress(pubId) {
  const account = getAccountFromPubId(pubId)
  return melis.getUnusedAddress(account).then(res => {
    console.log("New address: ", res)
  })
}

melis.connect().then(config => {
  console.log("Connected to server")
  if (doCreate)
    return melis.walletRegister(seed)
  else
    return melis.walletOpen(seed)
}).catch(function (err) {
  console.log("Unable to open wallet: ", err)
  process.exit(-1)
}).then(wallet => {
  console.log("Wallet " + wallet.pubKey + " creationdate: " + new Date(wallet.cd) + " lastLogin: " + new Date(wallet.lastLogin))
  switch (cmd) {
    case 'create':
      doCreate = true
      if (!seed)
        seed = melis.random32HexBytes()
      break;
    case 'showAccounts':
      return Q(showAccounts(wallet))
    case 'showAddresses':
      return showAddresses(pubId)
    case 'newAddress':
      return newAddress(pubId)
    case 'pay':
      return pay(pubId, address, amount, { allowUnconfirmed: true })
    default:
      usage("Command not yet implemented: " + cmd, true)
  }
}).finally(() => {
  console.log("Disconnecting...")
  return melis.disconnect()
})

