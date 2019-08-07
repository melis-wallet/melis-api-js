function Logger(config) {
  this.logObj = console
}

Logger.prototype.setLogObject = function (newObj) {
  this.logObj = newObj
}

Logger.prototype.log = function (a, b) {
  if (a && b)
    this.logObj.log(a, b)
  else
    this.logObj.log(a)
}

Logger.prototype.logWarning = function (a, b) {
  if (a && b)
    this.logObj.warn(a, b)
  else
    this.logObj.warn(a)
}

Logger.prototype.logError = function (a, b) {
  if (a && b)
    this.logObj.error(a, b)
  else
    this.logObj.error(a)
}

module.exports = new Logger()
