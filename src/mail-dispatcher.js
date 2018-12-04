const async = require('async')
const AWS = require('aws-sdk')
const child_process = require('child_process')
const colors = require('colors')
const extend = require('extend')
const fs = require('fs-extra')
const globby = require('globby')
const request = require('request')
const retry = require('retry')
const tmp = require('tmp')
const winston = require('winston')

module.exports = class MailDispatcher {

    constructor(config, options) {
        const self = this

        self.configuration = config

        if (!self.configuration.resourceName) {
            self.configuration.resourceName = 'mail-dispatcher'
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
        const self = this
        const args = Array.from(arguments)
        const params = args.slice(2, args.length - 1)
        const callback = args[args.length - 1]

        var operation = retry.operation()

        operation.attempt(() => {
            object[fn].apply(object, params.concat([
                (err, data) => {
                    if (!!err && err.code === 'TooManyRequestsException' && operation.retry(err)) {
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
            })
        })
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
                self.logger.log('info', 'Checking that all configured domains have been verified...')

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

                ], (err) => {
                    if (!!err) {
                        return callback(err)
                    }

                    return callback(null)
                })
            },

            (callback) => {
                var functionConfiguration = {
                    region: self.configuration.aws.region,
                    bucket: self.configuration.aws.bucket,
                    bucketPrefix: self.configuration.aws.bucketPrefix,
                    mappings: {
                        '@default': {}
                    }
                }

                self.configuration.domains.forEach((item) => {
                    functionConfiguration.mappings['@default'][item.domain] = item.defaultTo
                })

                if (self.configuration.mappings.type === 'file') {
                    self.logger.log('info', 'Fetching mappings configuration from file "%s"...', self.configuration.mappings.uri)

                    return callback(null, JSON.parse(fs.readFileSync(self.configuration.mappings.uri, 'utf8')))
                }

                if (self.configuration.mappings.type === 'http') {
                    self.logger.log('info', 'Fetching mappings configuration from url "%s"...', self.configuration.mappings.uri)

                    request({
                        url: self.configuration.mappings.uri,
                        json: true
                    }, (err, response, data) => {
                        if (!err && response.statusCode === 200) {
                            if (!data) {
                                return callback(new Error('Invalid JSON string in response.'))
                            }

                            return callback(null, data)
                        } else if (!!err) {
                            return callback(err)
                        } else {
                            return callback(null, [])
                        }
                    })
                }

                if (self.configuration.mappings.type === 'git') {
                    self.logger.log('info', 'Fetching mappings configuration from repository "%s"...', self.configuration.mappings.uri)

                    child_process.exec('git clone ' + self.configuration.mappings.uri + ' ' + mappingsDirectory.name, () => {
                        globby([ mappingsDirectory.name + '/**/*.json' ]).then(paths => {
                            paths.forEach(path => {
                                if (path.endsWith('.json')) {
                                    const json = JSON.parse(fs.readFileSync(path))

                                    if (!!json.from && !!json.to) {
                                        functionConfiguration.mappings[json.from] = json.to
                                    }
                                }
                            })

                            return callback(null, functionConfiguration)
                        })
                    })
                }
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
                        self.call(lambda, 'createFunction', extend(true, configuration, {
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

                self.call(ses, 'describeActiveReceiptRuleSet', {}, (err, data) => {
                    if (!!err) {
                        self.logger.log('error', 'SES.describeActiveReceiptRuleSet', err)
                        return callback(err)
                    }

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

                    var matches = data.Rules.filter((rule) => rule.Name === self.configuration.resourceName)

                    if (matches.length === 0) {
                        self.call(ses, 'createReceiptRule', {
                            RuleSetName: data.Metadata.Name,
                            Rule: rule
                        }, (err) => {
                            if (!!err) {
                                self.logger.log('error', 'SES.createReceiptRule', err)
                                return callback(err)
                            }

                            return callback(null, functionConfiguration, functionArn)
                        })
                    } else {
                        self.call(ses, 'updateReceiptRule', {
                            RuleSetName: data.Metadata.Name,
                            Rule: rule
                        }, (err) => {
                            if (!!err) {
                                self.logger.log('error', 'SES.updateReceiptRule', err)
                                return callback(err)
                            }

                            return callback(null, functionConfiguration, functionArn)
                        })
                    }
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