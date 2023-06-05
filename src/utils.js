// SPDX-FileCopyrightText: NOI Techpark <digital@noi.bz.it>
//
// SPDX-License-Identifier: AGPL-3.0-or-later

module.exports = {

  sleep: (milliseconds) => {
    return new Promise(resolve => setTimeout(resolve, milliseconds))
  }

}
