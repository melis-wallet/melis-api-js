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