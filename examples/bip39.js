var process = require('process')
var bip39 = require('bip39')

var args = process.argv.slice(2)
if (args.length < 1) {
  console.log("syntax: node bip39.js [<hexseed> | mnemonics....]")
  process.exit(0)
}

if (args.length === 1) {
  var seed = args[0]
  var mnemonics = bip39.entropyToMnemonic(seed)
  console.log("MNEMONICS: " + mnemonics)
} else {
  var mnemonics = args.join(" ")
  if (bip39.validateMnemonic(mnemonics)) {
    var entropy = bip39.mnemonicToEntropy(mnemonics)
    var seed = bip39.mnemonicToSeedHex(entropy)
    console.log("ENTROPY: " + entropy)
    console.log("SEED: " + seed.substring(0,64))
  } else {
    console.log("Mnemonics invalid: " + mnemonics)
  }
}
