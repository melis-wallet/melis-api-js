# JavaScript bindings for the Melis bitcoin service

## Overview

This library provides a JavaScript API to access the remote Melis STOMP APIs
and easily access the advanced multisig and realtime notification features
of a Bitcoin Melis wallet.

## Examples usage

### Receive funds
This simple code will:
* Open an existing wallet with at least an account
* ask for an unused address
* wait for an incoming (unconfirmed) transaction on the account
* report if the transaction has been confirmed

```javascript
var CM = require('../src/cm')
var C = CM.C
var cm = new CM({apiDiscoveryUrl: C.MELIS_TEST_DISCOVER})
var seed = "58e5e9e58956d9db4aeff9875994dcf253186d26884ddc25031fab98eff6ea34" // an existing wallet used for testing purposes

var myWallet, myAccount, myAddress

// Register an handler that will be notified of new incoming or outcoming transactions
cm.on(C.EVENT_TX_INFO_NEW, res => {
  console.log("New transaction received!\n", res.txInfo)
})

// Register an handler to be notified by transactions changing state
// for example because they have been confirmed
cm.on(C.EVENT_TX_INFO_UPDATED, res => {
  if (res.txInfo.blockMature > 0)
    console.log("TX has been confirmed!")
})

// Disable logs, very noisy
cm.log = function () {}

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
```

### Multiuser account
First user runs this script that:
* registers a new wallet
* create a 1of2 account and a join code for the second user
* waits for the second user to join the account (thus rendering the account functional)

```javascript
var CM = require('../src/cm')
var C = CM.C
var cm = new CM({apiDiscoveryUrl: C.MELIS_TEST_DISCOVER})
var seed = cm.random32HexBytes()

cm.on(C.EVENT_JOINED, res => {
  console.log("Cosigner joined: " + res.activationCode.pubId + ", the account is ready!")
  cm.disconnect()
})

cm.log = function () {} // Disable logs

cm.connect().then((config) => {
  console.log("Connected to server. Blockchain height: " + config.topBlock.height)
  return cm.walletRegister(seed)
}).then(wallet => {
  console.log("Wallet opened with seed: " + seed)
  return cm.accountCreate({
    type: C.TYPE_MULTISIG_MANDATORY_SERVER,
    cosigners: [{name: 'Frank'}],
    minSignatures: 1}
  )
}).then(res => {
  var cosigners = res.accountInfo.cosigners
  let joinCode
  cosigners.forEach(info => {
    if (info.name === 'Frank')
      joinCode = info.code
  })
  console.log("Waiting for cosigner with join code " + joinCode + " to join my account -- Press ctrl-c to exit")
}).catch(error => {
  console.log("Unexpected exception: ", error)
})
```

The second user runs this script with the joinCode got from the first script and join the multiuser/multisig account:

> node script "joincode"

```javascript
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
```
