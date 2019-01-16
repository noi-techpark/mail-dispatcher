'use strict';

module.exports = function MailDispatcherError(message, email) {
  Error.captureStackTrace(this, this.constructor);

  this.name = this.constructor.name;
  this.message = message;
  this.email = email;
};

require('util').inherits(module.exports, Error);