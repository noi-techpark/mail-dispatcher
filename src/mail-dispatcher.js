// SPDX-FileCopyrightText: NOI Techpark <digital@noi.bz.it>
//
// SPDX-License-Identifier: AGPL-3.0-or-later

// TODO: Node.js: Unhandled promise rejections are deprecated.
// TODO: Timeouts if waiting do-loops fail
// TODO: Split deploy-function into better readable parts
// TODO: Check and implement Pagination for Mailgun API

const AWS = require('aws-sdk')
const fs = require('fs-extra')
const globby = require('globby')
const retry = require('retry')
const utils = require('./utils')
const winston = require('winston')
const _ = require('underscore')

module.exports = class MailDispatcher {

  constructor(config, options) {
    const self = this

    self.configuration = config

    if (!!self.configuration.defaultTo && _.isString(self.configuration.defaultTo)) {
      self.configuration.defaultTo = [ self.configuration.defaultTo ]
    }

    if (!self.configuration.defaultTo || !_.isArray(self.configuration.defaultTo)) {
      self.configuration.defaultTo = false
    }

    if (!!self.configuration.domains) {
      self.configuration.domains = self.configuration.domains.map((entry, key) => {
        let defaultConfiguration = {
          'zone': null,
          'setupDns': true,
          'additionalSenders': [],
          'additionalTxtRecords': [],
          'blockSpam': false
        }

        if (typeof entry === 'string') {
          return _.extend(defaultConfiguration, {
            domain: entry
          })
        }

        if (typeof entry === 'object') {
          if (!!entry.defaultTo && _.isString(entry.defaultTo)) {
            entry.defaultTo = [ entry.defaultTo ]
          }

          if (typeof entry.defaultTo === 'undefined' || (_.isBoolean(entry.defaultTo) && entry.defaultTo === true)) {
            entry.defaultTo = self.configuration.defaultTo
          }

          if (!!entry.defaultTo && !_.isArray(entry.defaultTo)) {
            entry.defaultTo = false
          }

          if (typeof entry.additionalSenders === 'string') {
            entry.additionalSenders = [ entry.additionalSenders ]
          }

          if (typeof entry.additionalTxtRecords !== 'undefined') {
            entry.additionalTxtRecords = entry.additionalTxtRecords.filter((recordValue) => {
              return !!recordValue
            })
          }

          return _.extend(defaultConfiguration, entry)
        }

        return null
      }).filter((entry) => !!entry && !!entry.domain)
    } else {
      self.configuration.domains = []
    }

    if (!!self.configuration.mappings) {
      let entries = []

      if (_.isString(self.configuration.mappings) || _.isArray(self.configuration.mappings)) {
        let paths = []

        if (_.isString(self.configuration.mappings)) {
          paths.push(self.configuration.mappings)
        }

        if (_.isArray(self.configuration.mappings)) {
          paths = paths.concat(self.configuration.mappings)
        }

        let matches = globby.sync(paths)

        matches.forEach(path => {
          if (path.endsWith('.json')) {
              let entry = JSON.parse(fs.readFileSync(path))

              if (_.isObject(entry)&& !_.isArray(entry)) {
                entries.push(entry)
              }
          }
        })
      }

      if (_.isObject(self.configuration.mappings) && !_.isArray(self.configuration.mappings)) {
        entries.push(self.configuration.mappings)
      }

      self.configuration.mappings = {}

      for (var entry in entries) {
        let mappings = entries[entry]

        for (var email in mappings) {
          if (!_.has(self.configuration.mappings, email)) {
            self.configuration.mappings[email] = []
          }

          if (_.isString(mappings[email])) {
            self.configuration.mappings[email].push(mappings[email])
          }

          if (_.isArray(mappings[email])) {
            self.configuration.mappings[email] = _.unique(self.configuration.mappings[email].concat(mappings[email]))
          }
        }
      }
    } else {
      self.configuration.mappings = {}
    }

    AWS.config.update({
      credentials: {
        accessKeyId: self.configuration.aws.accessKey,
        secretAccessKey: self.configuration.aws.secretKey
      }
    })

    self.route53 = new AWS.Route53()

    self.mailgun = require('mailgun-js')({
      apiKey: self.configuration.mailgun.apiKey,
      host: (!!self.configuration.mailgun.region && self.configuration.mailgun.region === 'eu' ? 'api.eu.mailgun.net' : 'api.mailgun.net')
    })

    self.logger = winston.createLogger({
      level: self.configuration.loglevel || 'info',
      silent: !!options.silent,
        levels: {
          error_mg: 91,
          error_route: 92,
          error_app: 93,
          warn_app: 94,
          warn_mg: 95,
          warn_route: 96,
          info_route: 97,
          info_mg: 98,
          info_app: 99,
          info: 100,
        },
      transports: [ new winston.transports.Console({
        timestamp:true,
        format: winston.format.combine(
          winston.format.timestamp({
            format: 'DD.MM.YYYY HH:mm:ss'
          }),
          winston.format.colorize({
            colors : {
              info_mg : 'green',
              info_app : 'green',
              warn_app : 'yellow',
              error_app : 'red',
              error_mg : 'red',
              warn_mg : 'yellow',
              info_route : 'green',
              error_route : 'red',
              warn_route : 'yellow'
            }
          }),
          winston.format.splat(),
          winston.format.simple(),
          winston.format.printf(msg => `${msg.timestamp} - ${msg.level}: ${msg.message}`)
        )
      }) ]
    })
  }

  call(object, fn) {
    const args = Array.from(arguments)
    const params = args.slice(2, args.length - 1)
    const callback = args[args.length - 1]

    var operation = retry.operation()

    operation.attempt(() => {
      object[fn].apply(object, params.concat([
        (err, data) => {
          if (!!err && _.contains(['TooManyRequestsException', 'Throttling'], err.code) && operation.retry(err)) {
              return
          }

          callback(err, data)
        }
      ]))
    })
  }

  hashRoute(route) {
    return [].concat([ route.expression ], route.actions || route.action).join(':') + '@' + (route.priority || 0)
  }

  chopString(str, size) {
    if (str === null) return []
    str = String(str)
    size = ~~size
    return size > 0 ? str.match(new RegExp('.{1,' + size + '}', 'g')) : [str]
  }

  async clean() {
    const self = this

    self.logger.log('info_app', 'Cleaning up...')

    self.logger.log('info_route', 'Removing related records...')

    let hostedZonesResult = await self.route53.listHostedZones({
      MaxItems: '1000'
    }).promise()

    for (var i in self.configuration.domains) {
      let domainToDeploy = self.configuration.domains[i]
      let domainName = domainToDeploy.domain

      let domainEntry = null

      try {
        domainEntry = await self.mailgun.get('/domains/' + domainName)
      } catch (err) {
        self.logger.log('error_mg', 'Error getting domain information "%s": %s', domainName, err.message || '(no additional error message)')
      }

      let verificationRecordToConfigure = null
      let verificationRecords = false

      if(!!domainEntry) {
        verificationRecords = domainEntry.sending_dns_records.filter((record) => record.record_type === 'TXT' && record.value.includes('k=rsa'))      
      }

      if (!!verificationRecords) {
        verificationRecordToConfigure = verificationRecords[0]
      }

      let hostedZones = hostedZonesResult.HostedZones.filter((zone) => (domainToDeploy.zone || domainName).endsWith(zone.Name.slice(0, -1)))

      if (hostedZones.length > 0) {
        let hostedZone = hostedZones[0]

        let recordSetsResult = await self.route53.listResourceRecordSets({
          HostedZoneId: hostedZone.Id
        }).promise()

        let recordSets = recordSetsResult.ResourceRecordSets

        let changes = recordSets.filter((recordSet) => {
          if (recordSet.Type === 'MX') {
            return true
          }

          if (recordSet.Type === 'TXT' && (recordSet.Name === verificationRecordToConfigure.name || recordSet.Name === verificationRecordToConfigure.name + '.')) {
            return true
          }

          if (recordSet.Type === 'TXT' && recordSet.ResourceRecords.filter((record) => record.Value.includes('v=spf1')).length > 0) {
            return true
          }

          return false
        }).map((record) => {
          return {
            Action: 'DELETE',
            ResourceRecordSet: record
          }
        })

        if (changes.length > 0) {
          let outcome = await self.route53.changeResourceRecordSets({
            HostedZoneId: hostedZone.Id,
            ChangeBatch: {
              Changes: changes
            }
          }).promise()

          await self.route53.waitFor('resourceRecordSetsChanged', {
            Id: outcome.ChangeInfo.Id
          }).promise()
        }
      }
    }

    let domains = await self.mailgun.get('/domains')

    self.logger.log('info_mg', 'Removing %d domains...', domains.items.length)

    for (var i in domains.items) {
      await self.mailgun.delete('/domains/' + domains.items[i].name)
    }

    let routes = await self.mailgun.get('/routes', {limit:1000})

    self.logger.log('info_mg', 'Removing %d routes...', routes.items.length)

    for (var i in routes.items) {
      await self.mailgun.delete('/routes/' + routes.items[i].id)
    }

    self.logger.log('info_mg', 'Waiting for resources to be removed...')

    do {
      domains = await self.mailgun.get('/domains')
      routes = await self.mailgun.get('/routes', {limit:1000})

      await utils.sleep(500)
    } while (domains.items.length > 0)

    self.logger.log('info_app', 'Cleanup completed.')
  }

  async _removeAllRoutesFromMailgun() {
    const self = this;
    
    let routes = await self.mailgun.get('/routes', {limit:1000})

    self.logger.log('info_mg', 'Removing %d routes...', routes.items.length)

    if(self.configuration.debug != true) {
      for (var i in routes.items) {
        await self.mailgun.delete('/routes/' + routes.items[i].id)
      }

      self.logger.log('info_mg', 'Waiting for resources to be removed...')

      do {
        routes = await self.mailgun.get('/routes', {limit:1000})
        await utils.sleep(500)
      } while (routes.items.length > 0)
    } else {
      self.logger.log('info_mg', 'DRY RUN, removing %d routes', routes.items.length)
    }
  }

  async _mailgunCreateDomain(domainEntry, domainConfig) {
    const self = this;
    if(!domainEntry) {
      domainEntry = await self.mailgun.post('/domains', domainConfig)
      return domainEntry;
    } else {
      return domainEntry;
    }
  }

  async _resetDkimSelector(domainEntry, currentDkimSelector = '') {
    const self = this;
        // reset dkim-selector
        if(currentDkimSelector != '') {
          try{
            let result = await self.mailgun.put('/domains/' + domainEntry.domain.name + '/dkim_selector', { dkim_selector : currentDkimSelector });
            self.logger.log('info_mg', 'Resetting DKIM-Selector: %s', result.message)
            for (var j in domainEntry.sending_dns_records) {
              if(domainEntry.sending_dns_records[j].name.includes('_domainkey')) {
                self.logger.log('info_mg', 'Reconfigure DKIM-Selector: %s', currentDkimSelector+'._domainkey.'+domainEntry.domain.name)
                domainEntry.sending_dns_records[j].name = currentDkimSelector+'._domainkey.'+domainEntry.domain.name;
              }
            }
          } catch(err) {
            self.logger.log('warn_mg', 'Cannot reset DKIM-Selector: %s: %s', domainEntry.domain.name, err.message)
          }
        }
  }

  async _setupAdditionalCredentials(domainEntry, additionalSMTPCredentials) {
    const self = this;
    if(!!additionalSMTPCredentials && Array.isArray(additionalSMTPCredentials)) {
      for (const val of additionalSMTPCredentials) {
        if(!!val.login && val.login.length >= 3 && !!val.password && val.password.length >= 5 && val.password.length <= 32) {
          try {
            let result = await self.mailgun.post('/domains/' + domainEntry.domain.name + '/credentials', val)
            self.logger.log('info_mg', '  Setting up domain credentials for "%s": %s', val.login, result.message || '(no additional result message)')
          } catch (err) {
            self.logger.log('warn_mg', '  Error setting up domain credentials "%s": %s', domainEntry.domain.name, err.message || '(no additional error message)')
          }
        } else {
          self.logger.log('error_mg', 'Error setting up additional SMTP credentials (login.length > 3 && password.length between 5 & 32) for %s', val.login)
        }
      }
    } else {
      self.logger.log('info_app', 'No additional SMTP credentials required for "%s"', domainEntry.domain.name)
    }
  }

  async _checkMailgunDomainStatus(newDomain, existingDomain) {
      let self = this;

      if(self.configuration.deleteExistingMailgunDomains === true) {
        return true;
      }

      // check if spam action is already disabled (do not block or tag messages)
      if(existingDomain.domain.spam_action != 'disabled') {
        self.logger.log('warn_mg', 'spamaction enabled, force delete... %s', existingDomain.domain.spam_action)
        return true;
      }

      // force recreation by config
      if(newDomain.force) {
        self.logger.log('warn_mg', 'force delete by config...')
        return true;
      }

      return false;
  }

  async deploy() {
    const self = this

    self.logger.log('info_app', 'Deploying configuration and mappings...')

    let hostedZonesResult = await self.route53.listHostedZones({
      MaxItems: '1000'
    }).promise()

    let existingDomains = await self.mailgun.get('/domains')
    existingDomains = _.object(_.map(existingDomains.items, (item) => [ item.name, item ]))

    self.logger.log('info_app', 'Configured domains: %s', _.pluck(self.configuration.domains, 'domain'))
    self.logger.log('info_mg', 'Existing domains: %s', _.pluck(existingDomains, 'name'))

    let skippedDomains = []

    let cleanupChanges = {}
    let setupChanges = {}

    for (var i in self.configuration.domains) {

      let domainToDeploy = self.configuration.domains[i]

      let domainName = domainToDeploy.domain
      let domainSMTPPassword = domainToDeploy.smtp_password
      let additionalSMTPCredentials = domainToDeploy.credentials
      let currentDkimSelector = '';
      let domainConfig = { name: domainName }

      // if valid domain-wide credentials are present
      if(!!domainSMTPPassword && domainSMTPPassword.length >= 5 && domainSMTPPassword.length <= 32) {
        domainConfig.smtp_password = domainSMTPPassword
      }

      self.logger.log('info_app', '====================================================')
      self.logger.log('info_app', 'Processing domain: %s', domainName)

      let domainEntry = null

      try {
        domainEntry = await self.mailgun.get('/domains/' + domainName)

        let actionNeeded = await self._checkMailgunDomainStatus(domainToDeploy, domainEntry);

        try {
          let currentDkim = domainEntry.sending_dns_records.filter((record) => record.name.includes('_domainkey'))
          currentDkimSelector = currentDkim[0].name.split('.')[0];
          self.logger.log('info_mg', 'Current DKIM-Selector %s', currentDkimSelector);
        } catch(err) {
          self.logger.log('warn_mg', 'No DKIM-Selector found');
        }

        delete existingDomains[domainName]

        if(actionNeeded) {
          let res = await self.mailgun.delete('/domains/' + domainName)

          var domainsToWatch = null

          // wait until domain deletion is complete (mailgun sync?)
          do {
            domainsToWatch = await self.mailgun.get('/domains')
            domainsToWatch = domainsToWatch.items.filter((item) => item.name === domainName)
            self.logger.log('info_mg', 'wait for confirmation: domain deletion')
            await utils.sleep(500)
          } while (domainsToWatch.length > 0)

          domainEntry = false
        } else {
          self.logger.log('warn_mg', 'Skipping mailgun domain deletion');
        }
      } catch (err) {
        if (!!err.code && err.code !== 404) {
          self.logger.log('error_mg', 'Error cleaning up domain "%s": %s', domainName, err.message || '(no additional error message)')
          skippedDomains.push(domainName)
        }
      }

      // trying 10 times to create the domain, if missing @ mailgun
      let count = 0;
      let skipped = false;
      const maxTries = 10;

      while(true) {
        try {
            await utils.sleep(500);
            self.logger.log('info_mg', 'Setting up domain "%s"', domainName)

            domainEntry = await this._mailgunCreateDomain(domainEntry, domainConfig);
            
            // reset dkim-selector
            if(self.configuration.resetDkimSelector === true) {
              let dkim = await self._resetDkimSelector(domainEntry, currentDkimSelector);
            }

            // additional smtp-accounts
            let credent = await self._setupAdditionalCredentials(domainEntry, additionalSMTPCredentials);
            
            self.logger.log('info_mg', 'Domain setup complete "%s"', domainName)
          break;
        } catch (err) {
          self.logger.log('error_mg', '%s. try: Error setting up domain "%s": %s', count, domainName, err.message || '(no additional error message)')
          if (++count == maxTries) {
            skipped = true;
            break;
          }
        }
      }

      if (skipped) {
        domainEntry = false;
        skippedDomains.push(domainName);
        self.logger.log('error_mg', 'FATAL (!) Error setting up domain "%s": Manual check required', domainName)
        throw { message : 'Cannot create configured Domain. Manual Check is required!' }
      }

      // Identify DNS Changes between MG && Route53
      if (!_.contains(skippedDomains, domainName)) {
        self.logger.log('info_app', 'Check DNS changes for domain "%s"', domainName)

        let receivingRecords = domainEntry.receiving_dns_records

        let spfSenderToConfigure = null

        let spfRecords = domainEntry.sending_dns_records.filter((record) => record.record_type === 'TXT' && record.value.includes('v=spf'))
        if (!!spfRecords) {
          let match = spfRecords[0].value.match(/v=spf[0-9]{1} include\:([^\s]+)/)
          if (!!match) {
            spfSenderToConfigure = match[1]
          }
        }

        let verificationRecordToConfigure = null

        let verificationRecords = domainEntry.sending_dns_records.filter((record) => record.record_type === 'TXT' && record.value.includes('k=rsa'))
        if (!!verificationRecords) {
          verificationRecordToConfigure = verificationRecords[0]
        }

        let hostedZoneName = domainToDeploy.zone || domainName

        let hostedZone = null

        let hostedZones = hostedZonesResult.HostedZones.filter((zone) => hostedZoneName === zone.Name.slice(0, -1))

        if (hostedZones.length === 0) {
          self.logger.log('info_route', 'DNS Creating hosted zone @ route53...')

          let newHostedZoneResult = await self.route53.createHostedZone({
            CallerReference: hostedZoneName + '-' + (new Date().getTime()),
            Name: hostedZoneName,
            HostedZoneConfig: {
              PrivateZone: false
            }
          }).promise()

          hostedZone = newHostedZoneResult.HostedZone

          let recordSetsResult = await self.route53.listResourceRecordSets({
            HostedZoneId: hostedZone.Id
          }).promise()

          let nameserverRecords = recordSetsResult.ResourceRecordSets.filter((recordSet) => recordSet.Type === 'NS')

          self.logger.log('info_route', 'Configured hosted zone for "%s": %s', hostedZoneName, _.pluck(_.flatten(nameserverRecords.map((recordSet) => recordSet.ResourceRecords)), 'Value').join(', '))
        } else {
          hostedZone = hostedZones[0]
        }

        let recordSetsResult = await self.route53.listResourceRecordSets({
          HostedZoneId: hostedZone.Id
        }).promise()

        let recordSets = recordSetsResult.ResourceRecordSets

        let domainSpecificRecordSets = recordSets.filter((recordSet) => recordSet.Name.slice(0, -1) === domainName)
        let existingMxRecords = domainSpecificRecordSets.filter((recordSet) => recordSet.Type === 'MX')
        let existingTxtRecords = domainSpecificRecordSets.filter((recordSet) => recordSet.Type === 'TXT')
        let existingVerificationRecords = recordSets.filter((recordSet) => recordSet.Type === 'TXT' && (recordSet.Name === verificationRecordToConfigure.name || recordSet.Name === verificationRecordToConfigure.name + '.'))

        let domainSpecificCleanupChanges = []
        let domainSpecificSetupChanges = []

        if (!!receivingRecords && receivingRecords.length > 0) {
          let mxValues = receivingRecords.map((record) => {
            return record.priority + ' ' + record.value
          })

          let existingMxValues = _.flatten(existingMxRecords.map((record) => record.ResourceRecords)).map((entry) => entry.Value)

          if (existingMxRecords.length === 0 || _.difference(mxValues, existingMxValues).length > 0) {
            domainSpecificCleanupChanges = domainSpecificCleanupChanges.concat(existingMxRecords.map((record) => {
              return {
                Action: 'DELETE',
                ResourceRecordSet: record
              }
            }))

            domainSpecificSetupChanges.push({
              Action: 'CREATE',
              ResourceRecordSet: {
                Name: domainName,
                Type: 'MX',
                TTL: 300,
                ResourceRecords: mxValues.map((record) => {
                  return { Value: record }
                })
              }
            })
          }
        } else {
          domainSpecificCleanupChanges = domainSpecificCleanupChanges.concat(existingMxRecords.map((record) => {
            return {
              Action: 'DELETE',
              ResourceRecordSet: record
            }
          }))
        }

        var txtRecordValues = []

        if (!!spfSenderToConfigure) {
          var senders = [ 'include:' + spfSenderToConfigure ]

          if (!!domainToDeploy.additionalSenders) {
            senders = [].concat(senders, domainToDeploy.additionalSenders.map((sender) => 'include:' + sender))
          }

          // 5 because mailgun itself sets 3 nested includes and additionalSenders usually include mx and a
          if(senders.length >= 5) {
            self.logger.log('warn_route', 'Resulting spf record probably not correct. Necessary dns-lookups > 10. Reduce the number of additional ')
            self.logger.log('warn_route', ' skipping: v=spf1 ' + senders.join(' ') + ' ~all')
          } else {
            txtRecordValues.push('v=spf1 ' + senders.join(' ') + ' ~all')
          }
        }

        if (!!domainToDeploy.additionalTxtRecords) {
          for (var j in domainToDeploy.additionalTxtRecords) {
            txtRecordValues.push(domainToDeploy.additionalTxtRecords[j])
          }
        }

        var existingTxtValues = []

        for (var j in existingTxtRecords) {
          existingTxtValues = [].concat(existingTxtValues, existingTxtRecords[j].ResourceRecords.map((resourceRecord) => {
            return resourceRecord.Value.replace(/^"(.*)"$/, '$1')
          }))
        }

        if (_.difference(txtRecordValues, existingTxtValues).length > 0) {
          domainSpecificCleanupChanges = domainSpecificCleanupChanges.concat(existingTxtRecords.map((record) => {
            return {
              Action: 'DELETE',
              ResourceRecordSet: record
            }
          }))

          if (txtRecordValues.length > 0) {
            domainSpecificSetupChanges.push({
              Action: 'CREATE',
              ResourceRecordSet: {
                Name: domainName,
                Type: 'TXT',
                TTL: 300,
                ResourceRecords: txtRecordValues.map((value) => { return { Value: '"' + value + '"' } })
              }
            })
          }
        }

        if (!!verificationRecordToConfigure) {
          let existingVerificationValue = null
          if (existingVerificationRecords.length === 1 && existingVerificationRecords[0].ResourceRecords.length > 0) {
            let parts = existingVerificationRecords[0].ResourceRecords[0].Value.split('" "')
            parts = parts.map((part) => part.replace('"', ''))

            existingVerificationValue = parts.join('').replace('"', '')
          }

          if (existingVerificationRecords.length === 0 || verificationRecordToConfigure.value !== existingVerificationValue) {
            let parts = self.chopString(verificationRecordToConfigure.value, 240)

            domainSpecificCleanupChanges = domainSpecificCleanupChanges.concat(existingVerificationRecords.map((record) => {
              return {
                Action: 'DELETE',
                ResourceRecordSet: record
              }
            }))

            domainSpecificSetupChanges.push({
              Action: 'CREATE',
              ResourceRecordSet: {
                Name: verificationRecordToConfigure.name,
                Type: 'TXT',
                TTL: 300,
                ResourceRecords: parts.map((part) => {
                  return { Value: '"' + part + '"' }
                })
              }
            })
          }
        } else {
          domainSpecificCleanupChanges = domainSpecificCleanupChanges.concat(existingVerificationRecords.map((record) => {
            return {
              Action: 'DELETE',
              ResourceRecordSet: record
            }
          }))
        }

        if (domainSpecificCleanupChanges.length > 0) {
          if (!_.has(cleanupChanges, hostedZone.Id)) {
            cleanupChanges[hostedZone.Id] = []
          }

          cleanupChanges[hostedZone.Id] = cleanupChanges[hostedZone.Id].concat(domainSpecificCleanupChanges)
        }

        if (domainSpecificSetupChanges.length > 0) {
          if (!_.has(setupChanges, hostedZone.Id)) {
            setupChanges[hostedZone.Id] = []
          }

          setupChanges[hostedZone.Id] = setupChanges[hostedZone.Id].concat(domainSpecificSetupChanges)
        }
      }
    }

    self.logger.log('info_app', 'Applying changes to DNS records')

    if (!_.isEmpty(cleanupChanges)) {
      self.logger.log('info_route', 'Committing DNS cleanup changes...')
      self.logger.log('info_route', '  Changes generally propagate to all Route 53 name servers within 60 seconds.')

      let count = 0

      for (var zoneId in cleanupChanges) {

        cleanupChanges[zoneId].forEach((val)=>{
          self.logger.log('info_route', '    Action: %s, Type: %s, Name: %s', val.Action, val.ResourceRecordSet.Type, val.ResourceRecordSet.Name)
        })

        let outcome = await self.route53.changeResourceRecordSets({
          HostedZoneId: zoneId,
          ChangeBatch: {
            Changes: cleanupChanges[zoneId]
          }
        }).promise()

        await self.route53.waitFor('resourceRecordSetsChanged', {
          Id: outcome.ChangeInfo.Id
        }).promise()

        count += cleanupChanges[zoneId].length
      }

      self.logger.log('info_route', 'Cleaned up %d records', count)
    }

    if (!_.isEmpty(setupChanges)) {
      self.logger.log('info_route', 'Committing DNS setup changes...')
      self.logger.log('info_route', '  Changes generally propagate to all Route 53 name servers within 60 seconds.')

      let count = 0

      for (var zoneId in setupChanges) {        
        self.logger.log('info_route', 'Changing %d records for zoneId %s', setupChanges[zoneId].length, zoneId)
        
        setupChanges[zoneId].forEach((val)=>{
          self.logger.log('info_route', '    Action: %s, Type: %s, Name: %s', val.Action, val.ResourceRecordSet.Type, val.ResourceRecordSet.Name)
        })        
        
        let outcome = await self.route53.changeResourceRecordSets({
          HostedZoneId: zoneId,
          ChangeBatch: {
            Changes: setupChanges[zoneId]
          }
        }).promise()

        await self.route53.waitFor('resourceRecordSetsChanged', {
          Id: outcome.ChangeInfo.Id
        }).promise()

        count += setupChanges[zoneId].length
      }

      self.logger.log('info_route', 'Created %d records', count)
    }

    if (!_.isEmpty(existingDomains) && self.configuration.removeMissingDomains === true) {
      self.logger.log('warn_mg', 'Removing left-over domains from Mailgun...')

      try {
        for (var domainName in existingDomains) {
          await self.mailgun.delete('/domains/' + domainName)
        }

        self.logger.log('info_mg', 'Cleaned up left-over domains: %s', _.keys(existingDomains))
      } catch (err) {
        self.logger.log('error_mg', 'Error while cleaning up domains: %s', err.message || '(no additional error message)')
      }
    }

    self.logger.log('info_mg', 'Configuring mapping routes...')

    let routes = await self.mailgun.get('/routes', {limit:1000})

    routes = _.object(routes.items.map((route) => {
      return [ self.hashRoute(route), route ]
    }))

    let routesToConfigure = []
    let routesToCreate = []

    _.each(self.configuration.mappings, (recipients, email) => {
      let action = [ 'forward("' + recipients.join(',') + '")', 'stop()' ]

      routesToConfigure.push({
        expression: 'match_recipient("' + email + '")',
        action: action,
        priority: 10
      })

      routesToConfigure.push({
        expression: 'match_header("Cc", "' + email + '")',
        action: action,
        priority: 10
      })

      routesToConfigure.push({
        expression: 'match_header("Bcc", "' + email + '")',
        action: action,
        priority: 10
      })
    })

    for (var i in self.configuration.domains) {
      let domain = self.configuration.domains[i]
      let domainName = self.configuration.domains[i].domain

      if (!!domain.defaultTo) {
        let action = [ 'forward("' + domain.defaultTo.join(',') + '")', 'stop()' ]

        routesToConfigure.push({
          expression: 'match_recipient(".*@' + domainName + '")',
          action: action,
          priority: 20
        })

        routesToConfigure.push({
          expression: 'match_header("Cc", ".*@' + domainName + '")',
          action: action,
          priority: 20
        })

        routesToConfigure.push({
          expression: 'match_header("Bcc", ".*@' + domainName + '")',
          action: action,
          priority: 20
        })
      }
    }

    for (var i in routesToConfigure) {
      let hash = self.hashRoute(routesToConfigure[i])

      if (_.has(routes, hash)) {
        delete routes[hash]
      } else {
        routesToCreate.push(routesToConfigure[i])
      }
    }

    try {
      self.logger.log('info_mg', 'Creating %d routes...', routesToCreate.length)

      for (var i in routesToCreate) {
        await self.mailgun.post('/routes', routesToCreate[i])
      }
    } catch (err) {
      self.logger.log('error_mg', 'Error while creating routes: %s', err.message || '(no additional error message)')
    }

    try {
      self.logger.log('info_mg', 'Cleaning up %d routes...', _.keys(routes).length)

      for (var i in routes) {
        await self.mailgun.delete('/routes/' + routes[i].id)
      }
    } catch (err) {
      self.logger.log('error_mg', 'Error while cleaning up routes: %s', err.message || '(no additional error message)')
    }

    try {
      let domainsToVerify = await self.mailgun.get('/domains')
      domainsToVerify = domainsToVerify.items.filter((item) => item.state === 'unverified')

      let domainNamesToVerify = domainsToVerify.map((domain) => domain.name)

      if (domainNamesToVerify.length > 0 && self.configuration.debug != true) {
        self.logger.log('info_mg', 'Verifying domains: %s', domainNamesToVerify)

        let currentDomains = null
        let verifiedDomains = null

        let domainsVerifiedWhileWaiting = []

        do {
          for (var i in domainsToVerify) {
            if (domainsVerifiedWhileWaiting.indexOf(domainsToVerify[i].name) === -1) {
              await utils.sleep(1100)
              self.logger.log('info_mg', 'Trigger verify for domain: %s', domainsToVerify[i].name)
              await self.mailgun.put('/domains/' + domainsToVerify[i].name + '/verify')
            }
          }

          await utils.sleep(15000)

          currentDomains = await self.mailgun.get('/domains')
          currentDomains = currentDomains.items

          verifiedDomains = currentDomains.filter((item) => item.state === 'active')

          let domainsVerifiedDuringLastRun = verifiedDomains.map((domain) => domain.name)
          domainsVerifiedDuringLastRun = _.difference(domainsVerifiedWhileWaiting, domainsVerifiedDuringLastRun)

          if (domainsVerifiedDuringLastRun.length > 0) {
            self.logger.log('info_mg', 'Verified domains: %s', domainsVerifiedDuringLastRun)
          }

          domainsVerifiedWhileWaiting = _.uniq(domainsVerifiedWhileWaiting.concat(verifiedDomains.map((domain) => domain.name)))
        } while (currentDomains.length !== verifiedDomains.length)
      }
    } catch (err) {
      self.logger.log('error_mg', 'Error while verifying domains: %s', err.message || '(no additional error message)')
    }

    self.logger.log('info_mg', 'Deployment completed!')
  }

  async routes() {
    const self = this;

    self.logger.log('info_mg', 'Configuring mapping routes...')

    if(self.configuration.forceRouteDeletion == true) await this._removeAllRoutesFromMailgun()

    let routes = await self.mailgun.get('/routes', {limit:1000})
    
    self.logger.log('info_mg', '%d existing routes...', _.size(routes.items))
    
    // existing routes without duplicates
    routes = _.object(routes.items.map((route) => {
      return [ self.hashRoute(route), route ]
    }))

    self.logger.log('info_mg', '%d existing routes without duplicates...', _.size(routes))

    let routesToConfigure = []
    let routesToCreate = []

    // setup routes to configure
    _.each(self.configuration.mappings, (recipients, email) => {
      let action = [ 'forward("' + recipients.join(',') + '")', 'stop()' ]

      routesToConfigure.push({
        expression: 'match_recipient("' + email + '")',
        action: action,
        priority: 10
      })

      routesToConfigure.push({
        expression: 'match_header("Cc", "' + email + '")',
        action: action,
        priority: 10
      })

      routesToConfigure.push({
        expression: 'match_header("Bcc", "' + email + '")',
        action: action,
        priority: 10
      })
    })

    self.logger.log('info_mg', '%d routes to configure from mappings...', routesToConfigure.length)

    for (var i in self.configuration.domains) {
      let domain = self.configuration.domains[i]
      let domainName = self.configuration.domains[i].domain

      if (!!domain.defaultTo) {
        let action = [ 'forward("' + domain.defaultTo.join(',') + '")', 'stop()' ]

        routesToConfigure.push({
          expression: 'match_recipient(".*@' + domainName + '")',
          action: action,
          priority: 20
        })

        routesToConfigure.push({
          expression: 'match_header("Cc", ".*@' + domainName + '")',
          action: action,
          priority: 20
        })

        routesToConfigure.push({
          expression: 'match_header("Bcc", ".*@' + domainName + '")',
          action: action,
          priority: 20
        })
      }
    }

    self.logger.log('info_mg', '%d routes to configure from mappings and domains-settings...', routesToConfigure.length)

    // do not create duplicates
    for (var i in routesToConfigure) {
      let hash = self.hashRoute(routesToConfigure[i])
      if (_.has(routes, hash)) {
        delete routes[hash]
      } else {
        routesToCreate.push(routesToConfigure[i])
      }
    }

    try {
      self.logger.log('info_mg', 'Creating %d routes...', routesToCreate.length)

      for (var i in routesToCreate) {
        await self.mailgun.post('/routes', routesToCreate[i])
      }
    } catch (err) {
      self.logger.log('error_mg', 'Error while creating routes: %s', err.message || '(no additional error message)')
    }

    try {
      self.logger.log('info_mg', 'Cleaning up %d routes...', _.keys(routes).length)

      for (var i in routes) {
        await self.mailgun.delete('/routes/' + routes[i].id)
      }
    } catch (err) {
      self.logger.log('error_mg', 'Error while cleaning up routes: %s', err.message || '(no additional error message)')
    }
  }

}
