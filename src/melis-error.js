function MelisError(ex, msg) {
  this.ex = ex
  this.msg = msg
  this.message = "Exception class " + ex + " '" + msg + "'"
  this.stack = (new Error()).stack
}
MelisError.prototype = Object.create(Error.prototype)
MelisError.prototype.constructor = MelisError

module.exports = MelisError