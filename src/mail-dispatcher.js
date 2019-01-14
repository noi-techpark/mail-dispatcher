const async = require('async')
const AWS = require('aws-sdk')
const child_process = require('child_process')
const colors = require('colors')
const fs = require('fs-extra')
const globby = require('globby')
const request = require('request')
const retry = require('retry')
const tmp = require('tmp')
const winston = require('winston')
const _ = require('underscore')

module.exports = class MailDispatcher {

    constructor(config, options) {
        const self = this

        self.configuration = config

        if (!self.configuration.resourceName) {
            self.configuration.resourceName = 'mail-dispatcher'
        }

        if (!!self.configuration.defaultTo) {
            if (!_.isArray(self.configuration.defaultTo)) {
                self.configuration.defaultTo = [ self.configuration.defaultTo ]
            }

            self.configuration.domains = self.configuration.domains.map((entry) => {
                if (!!entry.defaultTo) {
                    if (!_.isArray(entry.defaultTo)) {
                        return _.extend(entry, {
                            defaultTo: [ entry.defaultTo ]
                        })
                    }
                } else {
                    return _.extend(entry, {
                        defaultTo: self.configuration.defaultTo
                    })
                }

                return entry
            })
        }

        // TODO validate configuration

        AWS.config.update({
            region: self.configuration.aws.region,
            credentials: {
                accessKeyId: self.configuration.aws.accessKey,
                secretAccessKey: self.configuration.aws.secretKey,
                region: self.configuration.aws.region
            }
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

    setup() {
        const self = this

        const ses = new AWS.SES()
        const route53 = new AWS.Route53()

        async.waterfall([

            (callback) => {
                self.call(ses, 'listIdentities', {
                    IdentityType: 'Domain',
                    MaxItems: 1000
                }, (err, data) => {
                    if (!!err) {
                        self.logger.log('error', 'SES.listIdentities', err)
                        return callback(err)
                    }

                    return callback(null, data.Identities)
                })
            },

            (identities, callback) => {
                self.call(ses, 'getIdentityVerificationAttributes', {
                    Identities: identities
                }, (err, data) => {
                    if (!!err) {
                        self.logger.log('error', 'SES.getIdentityVerificationAttributes', err)
                        return callback(err)
                    }

                    return callback(null, data.VerificationAttributes)
                })
            },

            (domains, callback) => {
                async.mapSeries(self.configuration.domains, (item, callback) => {
                    if (!!domains[item.domain]) {
                        return callback(null, {
                            domain: item.domain,
                            status: domains[item.domain].VerificationStatus.toUpperCase(),
                            token: domains[item.domain].VerificationToken
                        })
                    } else {
                        self.call(ses, 'verifyDomainIdentity', {
                            Domain: item.domain
                        }, (err, data) => {
                            if (!!err) {
                                self.logger.log('error', 'SES.verifyDomainIdentity', err)
                                return callback(err)
                            }

                            return callback(null, {
                                domain: item.domain,
                                status: 'PENDING',
                                token: data.VerificationToken
                            })
                        })
                    }
                }, (err, domains) => {
                    if (!!err) {
                        return callback(err)
                    }

                    return callback(null, domains)
                })
            },

            (domains, callback) => {
                var updates = []

                self.configuration.domains.forEach((item) => {
                    _.each({
                        bouncesTopic: 'Bounce',
                        complaintsTopic: 'Complaint',
                        deliveriesTopic: 'Delivery'
                    }, (type, property) => {
                        if (!!self.configuration.aws[property]) {
                            updates.push({
                                Identity: item.domain,
                                NotificationType: type,
                                SnsTopic: self.configuration.aws[property]
                            })
                        } else {
                            updates.push({
                                Identity: item.domain,
                                NotificationType: type,
                                SnsTopic: null
                            })
                        }
                    })
                });

                async.mapSeries(updates, (update, callback) => {
                    self.call(ses, 'setIdentityNotificationTopic', update, (err) => {
                        if (!!err) {
                            self.logger.log('error', 'SES.setIdentityNotificationTopic', err)
                            return callback(err)
                        }

                        return callback(null)
                    })
                }, (err) => {
                    if (!!err) {
                        return callback(err)
                    }

                    return callback(null, domains)
                })
            },

            (domains, callback) => {
                if (_.isBoolean(self.configuration.aws.dkimEnabled)) {
                    if (self.configuration.aws.dkimEnabled) {
                        async.mapSeries(domains, (item, callback) => {
                            async.waterfall([

                                (callback) => {
                                    setTimeout(() => {
                                        self.call(ses, 'verifyDomainDkim', {
                                            Domain: item.domain
                                        }, (err) => {
                                            if (!!err) {
                                                self.logger.log('error', 'SES.verifyDomainDkim', err)
                                                return callback(err)
                                            }

                                            callback(null)
                                        })
                                    }, 1000)
                                },

                                (callback) => {
                                    self.call(ses, 'getIdentityDkimAttributes', {
                                        Identities: [ item.domain ]
                                    }, (err, data) => {
                                        if (!!err) {
                                            self.logger.log('error', 'SES.getIdentityDkimAttributes', err)
                                            return callback(err)
                                        }

                                        var dkim = {
                                            enabled: true,
                                            verified: false,
                                            records: {}
                                        }

                                        var attributes = data.DkimAttributes[item.domain]

                                        dkim.verified = attributes.DkimVerificationStatus === 'Success'

                                        _.each(attributes.DkimTokens, (token) => {
                                            dkim.records[token + '._domainkey.' + item.domain] = token + '.dkim.amazonses.com'
                                        })

                                        return callback(null, _.extend(_.clone(item), {
                                            dkim: dkim
                                        }))
                                    })
                                }

                            ], (err, domain) => {
                                if (!!err) {
                                    return callback(err)
                                }

                                return callback(null, domain)
                            })
                        }, (err, domains) => {
                            if (!!err) {
                                return callback(err)
                            }

                            return callback(null, domains)
                        })
                    } else {
                        return callback(null, domains)
                    }
                } else {
                    return callback(null, domains)
                }
            },

            (domains, callback) => {
                if (!!self.configuration.aws.dnsConfigurationEnabled) {
                    self.call(route53, 'listHostedZones', {
                        MaxItems: '1000'
                    }, (err, data) => {
                        if (!!err) {
                            self.logger.log('error', 'Route53.listHostedZones', err)
                            return callback(err)
                        }

                        async.waterfall([

                            (callback) => {
                                async.map(domains, (item, callback) => {
                                    item.warnings = []

                                    var zones = data.HostedZones.filter((zone) => item.domain.endsWith(zone.Name.slice(0, -1)))

                                    if (zones.length > 0) {
                                        var zone = zones[0]

                                        self.call(route53, 'listResourceRecordSets', {
                                            HostedZoneId: zone.Id
                                        }, (err, data) => {
                                            if (!!err) {
                                                self.logger.log('error', 'Route53.listResourceRecordSets', err)
                                                return callback(err)
                                            }

                                            var records = []

                                            _.each(data.ResourceRecordSets, (set) => {
                                                _.each(set.ResourceRecords, (record) => {
                                                    records.push({
                                                        name: set.Name.slice(0, -1),
                                                        type: set.Type,
                                                        value: record.Value
                                                    })
                                                })
                                            })

                                            var pending = []

                                            var verificationDomain = '_amazonses.' + item.domain
                                            var verificationValue = '"' + item.token + '"'

                                            if (records.filter((dnsRecord) => {
                                                return dnsRecord.type === 'TXT' && dnsRecord.name === verificationDomain && dnsRecord.value === verificationValue
                                            }).length === 0) {
                                                pending.push({
                                                    zone: zone,
                                                    type: 'TXT',
                                                    domain: verificationDomain,
                                                    value: verificationValue
                                                })
                                            }

                                            var mxDomain = item.domain
                                            var mxHost = 'inbound-smtp.' + self.configuration.aws.region + '.amazonaws.com'
                                            var mxValue = '10 ' + mxHost

                                            if (records.filter((dnsRecord) => {
                                                return dnsRecord.type === 'MX' && dnsRecord.name === mxDomain && dnsRecord.value.includes(mxHost)
                                            }).length === 0) {
                                                if (records.filter((dnsRecord) => {
                                                    return dnsRecord.type === 'MX' && dnsRecord.name === mxDomain
                                                }).length === 0) {
                                                    pending.push({
                                                        zone: zone,
                                                        type: 'MX',
                                                        domain: mxDomain,
                                                        value: mxValue
                                                    })
                                                } else {
                                                    item.warnings.push('Found existing MX record')
                                                }
                                            }

                                            if (!!self.configuration.aws.spfEnabled) {
                                                var spfDomain = item.domain
                                                var spfValue = '"v=spf1 include:' + self.configuration.aws.region + '.amazonses.com ~all"'

                                                if (records.filter((dnsRecord) => {
                                                    return dnsRecord.type === 'TXT' && dnsRecord.name === spfDomain && dnsRecord.value === spfValue
                                                }).length === 0) {
                                                    if (records.filter((dnsRecord) => {
                                                        return dnsRecord.type === 'TXT' && dnsRecord.name === spfDomain && dnsRecord.value.includes('v=spf1')
                                                    }).length === 0) {
                                                        pending.push({
                                                            zone: zone,
                                                            type: 'TXT',
                                                            domain: spfDomain,
                                                            value: spfValue
                                                        })
                                                    } else {
                                                        item.warnings.push('Found existing SPF/TXT record')
                                                    }
                                                }
                                            }

                                            if (!!self.configuration.aws.dkimEnabled) {
                                                _.each(item.dkim.records, (value, domain) => {
                                                    if (records.filter((dnsRecord) => {
                                                        return dnsRecord.type === 'CNAME' && dnsRecord.name === domain && dnsRecord.value === value
                                                    }).length === 0) {
                                                        pending.push({
                                                            zone: zone,
                                                            type: 'CNAME',
                                                            domain: domain,
                                                            value: value
                                                        })
                                                    }
                                                })
                                            }

                                            if (!!self.configuration.aws.spfEnabled || !!self.configuration.aws.dkimEnabled) {
                                                var dmarcDomain = '_dmarc.' + item.domain
                                                var dmarcValue = '"v=DMARC1;p=quarantine;pct=25;rua=mailto:dmarc@' + item.domain + '"'

                                                if (records.filter((dnsRecord) => {
                                                    return dnsRecord.type === 'TXT' && dnsRecord.name === dmarcDomain && dnsRecord.value === dmarcValue
                                                }).length === 0) {
                                                    if (records.filter((dnsRecord) => {
                                                        return dnsRecord.type === 'TXT' && dnsRecord.name === dmarcDomain && dnsRecord.value.includes('v=DMARC1')
                                                    }).length === 0) {
                                                        pending.push({
                                                            zone: zone,
                                                            type: 'TXT',
                                                            domain: dmarcDomain,
                                                            value: dmarcValue
                                                        })
                                                    } else {
                                                        item.warnings.push('Found existing DMARC/TXT record')
                                                    }
                                                }
                                            }

                                            return callback(null, pending)
                                        })
                                    } else {
                                        return callback(null, [])
                                    }
                                }, (err, pending) => {
                                    if (!!err) {
                                        return callback(err)
                                    }

                                    callback(null, _.flatten(pending, true))
                                })
                            },

                            (pending, callback) => {
                                async.mapSeries(pending, (record, callback) => {
                                    self.call(route53, 'changeResourceRecordSets', {
                                        HostedZoneId: record.zone.Id,
                                        ChangeBatch: {
                                            Changes: [
                                                {
                                                    Action: 'CREATE',
                                                    ResourceRecordSet: {
                                                        Name: record.domain,
                                                        Type: record.type,
                                                        TTL: 300,
                                                        ResourceRecords: [
                                                            {
                                                                Value: record.value
                                                            }
                                                        ]
                                                    }
                                                }
                                            ]
                                        }
                                    }, (err) => {
                                        if (!!err) {
                                            self.logger.log('error', 'Route53.changeResourceRecordSets', err)
                                            return callback(err)
                                        }

                                        return callback(null)
                                    })
                                }, (err) => {
                                    if (!!err) {
                                        return callback(err)
                                    }

                                    return callback(null)
                                })
                            }

                        ], (err) => {
                            if (!!err) {
                                return callback(err)
                            }

                            return callback(null, domains)
                        })

                    })
                } else {
                    return callback(null, domains)
                }
            }

        ], (err, domains) => {
            if (!!err) {
                console.error(err.message || err)
                return process.exit(1)
            }

            self.logger.log('info', 'Setup completed.')

            domains.forEach((item) => {
                console.log(colors.cyan('Domain: %s'), item.domain)
                console.log('  > Status: %s', item.status === 'SUCCESS' ? colors.green('Verified') : colors.red('Pending'))
                console.log('  > MX Record: inbound-smtp.%s.amazonaws.com', self.configuration.aws.region)
                console.log('  > Verification Domain: _amazonses.%s', item.domain)
                console.log('  > Verification Value (TXT): %s', item.token)

                if (item.dkim && item.dkim.enabled) {
                    console.log('  > DKIM: %s', item.dkim.verified ? colors.green('Verified') : colors.red('Pending'))

                    _.each(item.dkim.records, (value, record) => {
                        console.log('      > Name: %s', record)
                        console.log('        Type: CNAME')
                        console.log('        Value: %s', value)
                    })
                } else {
                    console.log('  > DKIM: Disabled')
                }

                if (item.warnings) {
                    console.log('  > Warnings:')

                    _.each(item.warnings, (warning) => {
                        console.log('      > %s', colors.yellow(warning))
                    })
                }
            })
        })
    }

    canBeResolved(table, address) {
        const self = this

        var queue = [ address ]
        var processed = []

        do {
            var resolvedQueue = []
            var processedAddresses = []

            queue.forEach((address) => {
                if (!!table[address]) {
                    table[address].forEach((to) => {
                        processedAddresses.push(to)

                        self.configuration.domains.forEach((item) => {
                            if (to.includes('@' + item.domain)) {
                                resolvedQueue.push(to)
                            }
                        })
                    })
                } else {
                    self.configuration.domains.forEach((item) => {
                        if (address.includes('@' + item.domain)) {
                            item.defaultTo.forEach((to) => {
                                processedAddresses.push(to)
                                resolvedQueue.push(to)
                            })
                        }
                    })
                }
            })

            queue = resolvedQueue

            if (_.intersection(queue, processed).length > 0) {
                return false
            }

            processed = _.unique(processed.concat(processedAddresses))
        } while (queue.length > 0)

        return true
    }

    deploy() {
        const self = this

        const lambda = new AWS.Lambda()
        const ses = new AWS.SES()

        var mappingsDirectory = tmp.dirSync()
        var packageDir = tmp.dirSync()
        var packageFile = tmp.tmpNameSync({ postfix: '.zip' })

        async.waterfall([

            (callback) => {
                self.logger.log('info', 'Checking that all configured domains are ready to use...')

                async.waterfall([

                    (callback) => {
                        self.call(ses, 'listIdentities', {
                            IdentityType: 'Domain',
                            MaxItems: 1000
                        }, (err, data) => {
                            if (!!err) {
                                self.logger.log('error', 'SES.listIdentities', err)
                                return callback(err)
                            }

                            return callback(null, data.Identities)
                        })
                    },

                    (identities, callback) => {
                        self.call(ses, 'getIdentityVerificationAttributes', {
                            Identities: identities
                        }, (err, data) => {
                            if (!!err) {
                                self.logger.log('error', 'SES.getIdentityVerificationAttributes', err)
                                return callback(err)
                            }

                            var unverifiedDomains = []

                            self.configuration.domains.forEach((item) => {
                                if (!data.VerificationAttributes[item.domain] || data.VerificationAttributes[item.domain].VerificationStatus !== 'Success') {
                                    unverifiedDomains.push(item.domain)
                                }
                            })

                            if (unverifiedDomains.length > 0) {
                                self.logger.log('error', 'Trying to use unverified domains: [ %s ]', unverifiedDomains.join(', '))
                                return callback(new Error('Some of the configured domains have not been verified, please check or run the setup again.'))
                            } else {
                                return callback(null)
                            }
                        })
                    },

                    (callback) => {
                        self.call(ses, 'getIdentityDkimAttributes', {
                            Identities: self.configuration.domains.map((item) => item.domain)
                        }, (err, data) => {
                            if (!!err) {
                                self.logger.log('error', 'SES.getIdentityDkimAttributes', err)
                                return callback(err)
                            }

                            var updates = []

                            _.each(data.DkimAttributes, (attributes, domain) => {
                                if (_.isBoolean(self.configuration.aws.dkimEnabled)) {
                                    if (self.configuration.aws.dkimEnabled && !attributes.DkimEnabled) {
                                        updates.push({
                                            Identity: domain,
                                            DkimEnabled: true
                                        })
                                    }

                                    if (!self.configuration.aws.dkimEnabled && attributes.DkimEnabled) {
                                        updates.push({
                                            Identity: domain,
                                            DkimEnabled: false
                                        })
                                    }
                                }
                            })

                            if (!!updates) {
                                async.mapSeries(updates, (update, callback) => {
                                    self.call(ses, 'setIdentityDkimEnabled', update, (err, data) => {
                                        if (!!err) {
                                            return callback(err)
                                        }

                                        return callback(null)
                                    })
                                }, (err) => {
                                    if (!!err) {
                                        return callback(err)
                                    }

                                    return callback(null)
                                })
                            } else {
                                return callback(null)
                            }
                        })
                    }

                ], (err) => {
                    if (!!err) {
                        return callback(err)
                    }

                    return callback(null)
                })
            },

            (callback) => {
                if (self.configuration.mappings.type === 'file') {
                    self.logger.log('info', 'Fetching mappings configuration from file "%s"...', self.configuration.mappings.uri)

                    if (!fs.existsSync(self.configuration.mappings.uri)) {
                        return callback(new Error('Given file does not appear to be readable or exist.'))
                    }

                    var data = JSON.parse(fs.readFileSync(self.configuration.mappings.uri, 'utf8'))

                    if (!data) {
                        return callback(new Error('Invalid JSON string in file.'))
                    }

                    return callback(null, data)
                }

                if (self.configuration.mappings.type === 'http') {
                    self.logger.log('info', 'Fetching mappings configuration from url "%s"...', self.configuration.mappings.uri)

                    request({
                        url: self.configuration.mappings.uri,
                        json: true
                    }, (err, response, data) => {
                        if (!!err || response.statusCode !== 200) {
                            return callback(err)
                        }

                        if (!data) {
                            return callback(new Error('Invalid JSON string in response.'))
                        }

                        return callback(null, data)
                    })
                }

                if (self.configuration.mappings.type === 'git') {
                    self.logger.log('info', 'Fetching mappings configuration from repository "%s"...', self.configuration.mappings.uri)

                    child_process.exec('git clone ' + self.configuration.mappings.uri + ' ' + mappingsDirectory.name, () => {
                        globby([ mappingsDirectory.name + '/**/*.json' ]).then(paths => {
                            var data = []

                            paths.forEach(path => {
                                if (path.endsWith('.json')) {
                                    data.push(JSON.parse(fs.readFileSync(path)))
                                }
                            })

                            return callback(null, data)
                        })
                    })
                }

                return callback(null, [])
            },

            (items, callback) => {
                items = items.filter((item) => !!item.from && !!item.to)

                items.forEach((item) => {
                    if (!_.isArray(item.from)) {
                        item.from = [ item.from ]
                    }

                    if (!_.isArray(item.to)) {
                        item.to = [ item.to ]
                    }
                })

                return callback(null, items)
            },

            (items, callback) => {
                const self = this

                self.logger.log('info', 'Checking whether the mapped addresses are acyclic...')

                var table = {}
                items.filter((item) => item.type === 'email').forEach((item) => {
                    item.from.forEach((from) => {
                        table[from] = item.to
                    })
                })

                var invalid = []
                var addresses = []

                self.configuration.domains.filter((item) => !!item.defaultTo).map((item) => item.defaultTo).forEach((tos) => {
                    addresses = addresses.concat(tos)
                })

                addresses = addresses.concat(items.map((item) => item.from))

                addresses = _.unique(addresses)

                addresses.forEach((address) => {
                    if (!self.canBeResolved(table, address)) {
                        invalid.push(address)
                    }
                })

                if (invalid.length > 0) {
                    return callback(new Error('Detected forwarding cycle for: [ ' + invalid.join(', ') + ' ]'))
                }

                return callback(null, items)
            },

            (items, callback) => {
                var functionConfiguration = {
                    region: self.configuration.aws.region,
                    bucket: self.configuration.aws.bucket,
                    bucketPrefix: self.configuration.aws.bucketPrefix,
                    mappings: {
                        '@default': {}
                    }
                }

                // TODO add support for command/lmtp default destinations

                self.configuration.domains.filter((item) => !!item.defaultTo).forEach((item) => {
                    functionConfiguration.mappings['@default'][item.domain] = item.defaultTo.map((to) => {
                        return {
                            type: 'email',
                            address: to
                        }
                    })
                })

                items.forEach((item) => {
                    var triggers = {}

                    item.from.forEach((from) => {
                        if (_.isString(from)) {
                            triggers[from] = {}
                        }

                        if (_.isObject(from) && !!from.type) {
                            if (from.type === 'mailman') {
                                var actions = {}
                                actions[from.list] = 'post'
                                actions[from.list + '-admin'] = 'admin'
                                actions[from.list + '-bounces'] = 'bounces'
                                actions[from.list + '-confirm'] = 'confirm'
                                actions[from.list + '-join'] = 'join'
                                actions[from.list + '-leave'] = 'leave'
                                actions[from.list + '-owner'] = 'owner'
                                actions[from.list + '-request'] = 'request'
                                actions[from.list + '-subscribe'] = 'subscribe'
                                actions[from.list + '-unsubscribe'] = 'unsubscribe'

                                _.each(actions, (action, addressPart) => {
                                    triggers[addressPart + '@' + from.domain] = {
                                        'MAILMAN_ACTION': action,
                                        'MAILMAN_LIST': from.list
                                    }
                                })
                            }
                        }
                    })

                    _.each(triggers, (context, from) => {
                        if (!_.has(functionConfiguration.mappings, from)) {
                            functionConfiguration.mappings[from] = []
                        }
                    })

                    item.to.forEach((to) => {
                        if (_.isString(to)) {
                            _.each(triggers, (context, from) => {
                                functionConfiguration.mappings[from].push({
                                    type: 'email',
                                    address: to
                                })
                            })
                        }

                        if (_.isObject(to) && !!to.type) {
                            if (to.type === 'command') {
                                _.each(triggers, (context, from) => {
                                    var command = to.command

                                    _.each(context, (value, key) => {
                                        command = command.replace('{{' + key + '}}', value)
                                    })

                                    functionConfiguration.mappings[from].push(_.extend(_.clone(to), {
                                        command: command
                                    }))
                                })
                            }
                        }
                    })
                })

                return callback(null, functionConfiguration)
            },

            (functionConfiguration, callback) => {
                self.logger.log('info', 'Creating function package...')

                fs.copySync(__dirname + '/../node_modules', packageDir.name + '/node_modules')

                fs.writeFileSync(packageDir.name + '/config.json', JSON.stringify(functionConfiguration))

                fs.copySync(__dirname + '/index.js', packageDir.name + '/index.js')

                child_process.exec('zip -rq -X "' + packageFile + '" ./node_modules ./config.json ./index.js', { cwd: packageDir.name }, () => {
                    return callback(null, functionConfiguration)
                })
            },

            (functionConfiguration, callback) => {
                self.logger.log('info', 'Deploying function "%s"...', self.configuration.resourceName)

                self.call(lambda, 'getFunction', {
                    FunctionName: self.configuration.resourceName
                }, (err, data) => {
                    if (!!err && err.code !== 'ResourceNotFoundException') {
                        self.logger.log('error', 'Lambda.getFunction', err)
                        return callback(err)
                    }

                    var configuration = {
                        FunctionName: self.configuration.resourceName,
                        Handler: 'index.handler',
                        Runtime: 'nodejs8.10',
                        MemorySize: 128,
                        Role: self.configuration.aws.functionRoleArn,
                        Timeout: 30
                    }

                    const code = fs.readFileSync(packageFile).buffer

                    if (!!data) {
                        async.series([

                            (callback) => {
                                self.call(lambda, 'updateFunctionConfiguration', configuration, (err) => {
                                    if (!!err) {
                                        self.logger.log('error', 'Lambda.updateFunctionConfiguration', err)
                                        return callback(err)
                                    }

                                    return callback(null)
                                })
                            },

                            (callback) => {
                                self.call(lambda, 'updateFunctionCode', {
                                    FunctionName: self.configuration.resourceName,
                                    Publish: true,
                                    ZipFile: code
                                }, (err) => {
                                    if (!!err) {
                                        self.logger.log('error', 'Lambda.updateFunctionCode', err)
                                        return callback(err)
                                    }

                                    return callback(null)
                                })
                            }

                        ], (err) => {
                            if (!!err) {
                                return callback(err)
                            }

                            return callback(null, functionConfiguration, data.Configuration.FunctionArn)
                        })
                    } else {
                        self.call(lambda, 'createFunction', _.extend(_.clone(configuration), {
                            Publish: true,
                            Code: {
                                ZipFile: code
                            }
                        }), (err, data) => {
                            if (!!err) {
                                self.logger.log('error', 'Lambda.createFunction', err)
                                return callback(err)
                            }

                            return callback(null, functionConfiguration, data.FunctionArn)
                        })
                    }
                })
            },

            (functionConfiguration, functionArn, callback) => {
                self.logger.log('info', 'Ensuring the function can be invoked on incoming emails...')

                self.call(lambda, 'addPermission', {
                    FunctionName: self.configuration.resourceName,
                    StatementId: 'GiveSESPermissionToInvokeFunction',
                    Action: 'lambda:InvokeFunction',
                    Principal: 'ses.amazonaws.com'
                }, (err, data) => {
                    if (!!err && err.code !== 'ResourceConflictException') {
                        self.logger.log('error', 'Lambda.addPermission', err || data)
                        return callback(err)
                    }

                    if (!!err && err.code === 'ResourceConflictException') {
                        return callback(null, functionConfiguration, functionArn)
                    }

                    return callback(null, functionConfiguration, functionArn)
                })
            },

            (functionConfiguration, functionArn, callback) => {
                self.logger.log('info', 'Ensuring the rules for incoming emails are configured...')

                async.waterfall([

                    (callback) => {
                        self.call(ses, 'describeActiveReceiptRuleSet', {}, (err, data) => {
                            if (!!err) {
                                self.logger.log('error', 'SES.describeActiveReceiptRuleSet', err)
                                return callback(err)
                            }

                            if (!!data && !!data.Metadata && !!data.Metadata.Name) {
                                callback(null, data.Metadata.Name, data.Rules || [])
                            } else {
                                var ruleSet = 'default-rule-set-' + Math.random().toString(36).substring(2, 8)

                                self.call(ses, 'createReceiptRuleSet', {
                                    RuleSetName: ruleSet
                                }, (err, data) => {
                                    if (!!err) {
                                        self.logger.log('error', 'SES.createReceiptRuleSet', err)
                                        return callback(err)
                                    }

                                    self.call(ses, 'setActiveReceiptRuleSet', {
                                        RuleSetName: ruleSet
                                    }, (err, data) => {
                                        if (!!err) {
                                            self.logger.log('error', 'SES.setActiveReceiptRuleSet', err)
                                            return callback(err)
                                        }

                                        callback(null, ruleSet, [])
                                    })
                                })
                            }
                        })
                    },

                    (ruleSet, rules, callback) => {
                        var rule = {
                            Name: self.configuration.resourceName,
                            Enabled: true,
                            ScanEnabled: true,
                            Recipients: self.configuration.domains.map((item) => item.domain),
                            Actions: [
                                {
                                    S3Action: {
                                        BucketName: self.configuration.aws.bucket,
                                        ObjectKeyPrefix: self.configuration.aws.bucketPrefix
                                    }
                                },
                                {
                                    LambdaAction: {
                                        FunctionArn: functionArn,
                                        InvocationType: 'Event'
                                    }
                                }
                            ]
                        }

                        var matches = rules.filter((rule) => rule.Name === self.configuration.resourceName)

                        if (matches.length === 0) {
                            self.call(ses, 'createReceiptRule', {
                                RuleSetName: ruleSet,
                                Rule: rule
                            }, (err) => {
                                if (!!err) {
                                    self.logger.log('error', 'SES.createReceiptRule', err)
                                    return callback(err)
                                }

                                return callback(null)
                            })
                        } else {
                            self.call(ses, 'updateReceiptRule', {
                                RuleSetName: ruleSet,
                                Rule: rule
                            }, (err) => {
                                if (!!err) {
                                    self.logger.log('error', 'SES.updateReceiptRule', err)
                                    return callback(err)
                                }

                                return callback(null)
                            })
                        }
                    }

                ], (err) => {
                    if (!!err) {
                        return callback(err)
                    }

                    return callback(null, functionConfiguration, functionArn)
                })
            },

            (functionConfiguration, functionArn, callback) => {
                self.logger.log('info', 'Cleaning up...')

                fs.removeSync(mappingsDirectory.name)
                fs.removeSync(packageDir.name)
                fs.removeSync(packageFile)

                return callback(null, functionConfiguration, functionArn)
            }

        ], (err) => {
            if (!!err) {
                console.error(err.message || err)
                return process.exit(1)
            }

            self.logger.log('info', 'Deployment completed.')
        })
    }

}