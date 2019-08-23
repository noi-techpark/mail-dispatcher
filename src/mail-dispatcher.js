const async = require('async')
const AWS = require('aws-sdk')
const child_process = require('child_process')
const colors = require('colors')
const fs = require('fs-extra')
const globby = require('globby')
const request = require('request')
const retry = require('retry')
const tmp = require('tmp')
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
      level: 'info',
      silent: !!options.silent,
      transports: [ new winston.transports.Console({
        format: winston.format.combine(
          winston.format.colorize(),
          winston.format.splat(),
          winston.format.simple()
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

    self.logger.log('info', 'Cleaning up...')

    self.logger.log('info', 'Removing related records...')

    let hostedZonesResult = await self.route53.listHostedZones({
      MaxItems: '1000'
    }).promise()

    for (var i in self.configuration.domains) {
      let domainToDeploy = self.configuration.domains[i]
      let domainName = domainToDeploy.domain

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

          if (recordSet.Type === 'TXT' && recordSet.Name.includes('_domainkey.' + domainName)) {
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

    self.logger.log('info', 'Removing %d domains...', domains.items.length)

    for (var i in domains.items) {
      await self.mailgun.delete('/domains/' + domains.items[i].name)
    }

    let routes = await self.mailgun.get('/routes')

    self.logger.log('info', 'Removing %d routes...', routes.items.length)

    for (var i in routes.items) {
      await self.mailgun.delete('/routes/' + routes.items[i].id)
    }

    self.logger.log('info', 'Waiting for resources to be removed...')

    do {
      domains = await self.mailgun.get('/domains')
      routes = await self.mailgun.get('/routes')

      await utils.sleep(500)
    } while (domains.items.length > 0)

    self.logger.log('info', 'Cleanup completed.')
  }

  async deploy() {
    const self = this

    self.logger.log('info', 'Deploying configuration and mappings...')

    let hostedZonesResult = await self.route53.listHostedZones({
      MaxItems: '1000'
    }).promise()

    let existingDomains = await self.mailgun.get('/domains')
    existingDomains = _.object(_.map(existingDomains.items, (item) => [ item.name, item ]))

    self.logger.log('info', 'Configured domains: %s', _.pluck(self.configuration.domains, 'domain'))

    let skippedDomains = []

    let cleanupChanges = {}
    let setupChanges = {}

    for (var i in self.configuration.domains) {
      let domainToDeploy = self.configuration.domains[i]
      let domainName = domainToDeploy.domain

      self.logger.log('info', 'Processing domain: %s', domainName)

      let domainEntry = null

      try {
        domainEntry = await self.mailgun.get('/domains/' + domainName)

        delete existingDomains[domainName]

        if (domainEntry.domain.spam_action !== 'tag') {
          await self.mailgun.delete('/domains/' + domainName)

          var domainsToWatch = null

          do {
            domainsToWatch = await self.mailgun.get('/domains')
            domainsToWatch = domainsToWatch.items.filter((item) => item.name === domainName)

            await utils.sleep(500)
          } while (domainsToWatch.length > 0)

          domainEntry = false
        }

      } catch (err) {
        if (!!err.code && err.code !== 404) {
          self.logger.log('error', 'Error cleaning up domain "%s": %s', domainName, err.message || '(no additional error message)')

          skippedDomains.push(domainName)
        }
      }

      try {
        if (!domainEntry) {
          domainEntry = await self.mailgun.post('/domains', {
            name: domainName,
            spam_action: 'tag'
          })
        }
      } catch (err) {
        self.logger.log('error', 'Error setting up domain "%s": %s', domainName, err.message || '(no additional error message)')

        skippedDomains.push(domainName)
      }

      if (!_.contains(skippedDomains, domainName)) {
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

          self.logger.log('info', 'Configured hosted zone for "%s": %s', hostedZoneName, _.pluck(_.flatten(nameserverRecords.map((recordSet) => recordSet.ResourceRecords)), 'Value').join(', '))
        } else {
          hostedZone = hostedZones[0]
        }

        let recordSetsResult = await self.route53.listResourceRecordSets({
          HostedZoneId: hostedZone.Id
        }).promise()

        let recordSets = recordSetsResult.ResourceRecordSets

        let domainSpecificRecordSets = recordSets.filter((recordSet) => recordSet.Name.slice(0, -1) === domainName)
        let existingMxRecords = domainSpecificRecordSets.filter((recordSet) => recordSet.Type === 'MX')
        let existingSpfRecords = domainSpecificRecordSets.filter((recordSet) => recordSet.Type === 'TXT' && recordSet.ResourceRecords.filter((record) => record.Value.includes('v=spf1')).length > 0)
        let existingVerificationRecords = recordSets.filter((recordSet) => recordSet.Type === 'TXT' && recordSet.Name.includes('_domainkey.' + domainName))

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

        if (!!spfSenderToConfigure) {
          let senders = [ 'include:' + spfSenderToConfigure ]

          // TODO include additional/other senders

          let spfValue = '"v=spf1 ' + senders.join(' ') + ' ~all"'

          let existingSpfValue = null
          if (existingSpfRecords.length === 1 && existingSpfRecords[0].ResourceRecords.length > 0) {
            existingSpfValue = existingSpfRecords[0].ResourceRecords[0].Value
          }

          if (existingSpfRecords.length === 0 || spfValue !== existingSpfValue) {
            domainSpecificCleanupChanges = domainSpecificCleanupChanges.concat(existingSpfRecords.map((record) => {
              return {
                Action: 'DELETE',
                ResourceRecordSet: record
              }
            }))

            domainSpecificSetupChanges.push({
              Action: 'CREATE',
              ResourceRecordSet: {
                Name: domainName,
                Type: 'TXT',
                TTL: 300,
                ResourceRecords: [
                  {
                    Value: spfValue
                  }
                ]
              }
            })
          }
        } else {
          domainSpecificCleanupChanges = domainSpecificCleanupChanges.concat(existingSpfRecords.map((record) => {
            return {
              Action: 'DELETE',
              ResourceRecordSet: record
            }
          }))
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

    self.logger.log('info', 'Applying changes to DNS records')

    if (!_.isEmpty(cleanupChanges)) {
      let count = 0

      for (var zoneId in cleanupChanges) {
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

      self.logger.log('info', 'Cleaned up %d records', count)
    }

    if (!_.isEmpty(setupChanges)) {
      let count = 0

      for (var zoneId in setupChanges) {
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

      self.logger.log('info', 'Created %d records', count)
    }

    if (!_.isEmpty(existingDomains)) {
      try {
        for (var domainName in existingDomains) {
          await self.mailgun.delete('/domains/' + domainName)
        }

        self.logger.log('info', 'Cleaned up left-over domains: %s', _.keys(existingDomains))
      } catch (err) {
        self.logger.log('error', 'Error while cleaning up domains: %s', err.message || '(no additional error message)')
      }
    }

    self.logger.log('info', 'Configuring mapping routes...')

    let routes = await self.mailgun.get('/routes')

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
      self.logger.log('info', 'Creating %d routes...', routesToCreate.length)

      for (var i in routesToCreate) {
        await self.mailgun.post('/routes', routesToCreate[i])
      }
    } catch (err) {
      self.logger.log('error', 'Error while creating routes: %s', err.message || '(no additional error message)')
    }

    try {
      self.logger.log('info', 'Cleaning up %d routes...', _.keys(routes).length)

      for (var i in routes) {
        await self.mailgun.delete('/routes/' + routes[i].id)
      }
    } catch (err) {
      self.logger.log('error', 'Error while cleaning up routes: %s', err.message || '(no additional error message)')
    }

    try {
      let domainsToVerify = await self.mailgun.get('/domains')
      domainsToVerify = domainsToVerify.items.filter((item) => item.state === 'unverified')

      let domainNamesToVerify = domainsToVerify.map((domain) => domain.name)

      if (domainNamesToVerify.length > 0) {
        self.logger.log('info', 'Verifying domains: %s', domainNamesToVerify)

        let currentDomains = null
        let verifiedDomains = null

        let domainsVerifiedWhileWaiting = []

        do {
          for (var i in domainsToVerify) {
            if (domainsVerifiedWhileWaiting.indexOf(domainsToVerify[i].name) === -1) {
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
            self.logger.log('info', 'Verified domains: %s', domainsVerifiedDuringLastRun)
          }

          domainsVerifiedWhileWaiting = _.uniq(domainsVerifiedWhileWaiting.concat(verifiedDomains.map((domain) => domain.name)))
        } while (currentDomains.length !== verifiedDomains.length)
      }
    } catch (err) {
      self.logger.log('error', 'Error while verifying domains: %s', err.message || '(no additional error message)')
    }

    self.logger.log('info', 'Deployment completed!')
  }

}