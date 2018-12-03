const async = require('async')
const AWS = require('aws-sdk')
const child_process = require('child_process')
const fs = require('fs-extra')
const globby = require('globby')
const tmp = require('tmp')
const winston = require('winston')

module.exports = class MailDispatcher {

    constructor(config) {
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
            silent: false,
            transports: [ new winston.transports.Console({
                format: winston.format.combine(
                    winston.format.colorize(),
                    winston.format.splat(),
                    winston.format.simple()
                )
            }) ]
        })
    }

    deploy() {
        const self = this

        var mappingsDirectory = tmp.dirSync()
        var packageDir = tmp.dirSync()
        var packageFile = tmp.tmpNameSync({ postfix: '.zip' })

        async.waterfall([

            (callback) => {
                var functionConfiguration = {
                    region: self.configuration.aws.region,
                    bucket: self.configuration.aws.bucket,
                    bucketPrefix: self.configuration.aws.bucketPrefix,
                    mappings: {
                        '@default': self.configuration.defaultRecipient
                    }
                }

                var matches

                matches = self.configuration.mappings.match(/^git:\/\/(.+)$/)
                if (!!matches) {
                    self.logger.log('info', 'Fetching mappings configuration from repository "%s"...', matches[1])

                    child_process.exec('git clone ' + matches[1] + ' ' + mappingsDirectory.name, () => {
                        globby([ mappingsDirectory.name + '/**/*.json' ]).then(paths => {
                            paths.forEach(path => {
                                if (path.endsWith('.json')) {
                                    const json = JSON.parse(fs.readFileSync(path))

                                    if (!!json.address && !!json.recipients) {
                                        functionConfiguration.mappings[json.address] = json.recipients
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
                    callback(null, functionConfiguration)
                })
            },

            (functionConfiguration, callback) => {
                self.logger.log('info', 'Deploying function "%s"...', self.configuration.resourceName)

                const lambda = new AWS.Lambda()

                lambda.getFunction({ FunctionName: self.configuration.resourceName }, (err, data) => {
                    if (!!err && err.code !== 'ResourceNotFoundException') {
                        self.logger.log('error', 'Lambda.getFunction', err)
                        return callback(err)
                    }

                    const code = fs.readFileSync(packageFile).buffer

                    if (!!data) {
                        // TODO update function configuration

                        lambda.updateFunctionCode({
                            FunctionName: self.configuration.resourceName,
                            Publish: true,
                            ZipFile: code
                        }, (err) => {
                            if (!!err) {
                                self.logger.log('error', 'Lambda.updateFunctionCode', err)
                                return callback(err)
                            }

                            callback(null, functionConfiguration)
                        })
                    } else {
                        lambda.createFunction({
                            FunctionName: self.configuration.resourceName,
                            Handler: 'index.handler',
                            Runtime: 'nodejs8.10',
                            MemorySize: 128,
                            Publish: true,
                            Role: self.configuration.aws.functionRoleArn,
                            Timeout: 30,
                            Code: {
                                ZipFile: code
                            }
                        }, (err) => {
                            if (!!err) {
                                self.logger.log('error', 'Lambda.createFunction', err)
                                return callback(err)
                            }

                            callback(null, functionConfiguration)
                        })
                    }
                })
            },

            (functionConfiguration, callback) => {
                self.logger.log('info', 'Cleaning up...')

                fs.removeSync(mappingsDirectory.name)
                fs.removeSync(packageDir.name)
                fs.removeSync(packageFile)

                callback(null, functionConfiguration)
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