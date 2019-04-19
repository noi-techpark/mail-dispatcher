const async = require('async')
const AWS = require('aws-sdk')
const fs = require('fs')
const MailDispatcherError = require('./error')
const SSH = require('simple-ssh')

const configuration = JSON.parse(fs.readFileSync(__dirname + '/config.json'))

exports.handler = (event, context, callback) => {
    const ses = new AWS.SES()
    const s3 = new AWS.S3({ signatureVersion: 'v4' })

    if (!event || !event.hasOwnProperty('Records') || event.Records.length !== 1 || !event.Records[0].hasOwnProperty('eventSource') || event.Records[0].eventSource !== 'aws:ses' || event.Records[0].eventVersion !== '1.0') {
        return callback(new Error('Invalid SES message received.'))
    }

    var record = event.Records[0]

    var email = record.ses.mail

    var recipients = {}
    record.ses.receipt.recipients.forEach((recipient) => {
        if (!!configuration.mappings[recipient]) {
            recipients[recipient] = configuration.mappings[recipient]
        } else {
            var position = recipient.lastIndexOf('@')
            if (position !== -1) {
                recipients[recipient] = configuration.mappings['@default'][recipient.slice(position + 1)]
            }
        }
    })

    async.waterfall([

        (callback) => {
            callback(null, email, recipients)
        },

        (email, recipients, callback) => {
            s3.copyObject({
                Bucket: configuration.bucket,
                CopySource: configuration.bucket + '/' + configuration.bucketPrefix + email.messageId,
                Key: configuration.bucketPrefix + email.messageId,
                ACL: 'private',
                ContentType: 'text/plain',
                StorageClass: 'STANDARD'
            }, (err) => {
                if (!!err) {
                    return callback(new Error('Could not make readable copy of email on S3. ' + err.message))
                }

                s3.getObject({
                    Bucket: configuration.bucket,
                    Key: configuration.bucketPrefix + email.messageId
                }, (err, data) => {
                    if (!!err) {
                        return callback(new Error('Failed to load email from S3. ' + err.message))
                    }

                    callback(null, email, recipients, data.Body.toString())

                    data = null
                })
            })
        },

        (email, recipients, message, callback) => {
            async.eachOfSeries(recipients, (toRecipients, originalRecipient, callback) => {
                var match = message.match(/^((?:.+\r?\n)*)(\r?\n(?:.*\s+)*)/m)
                var headerPart = match && match[1] ? match[1] : message
                var bodyPart = match && match[2] ? match[2] : ''

                match = headerPart.match(/^From: (.*(?:\r?\n\s+.*)*\r?\n)/m)
                var from = match && match[1] ? match[1] : ''

                if (!/^Reply-To: /mi.test(headerPart) && from) {
                    headerPart = headerPart + 'Reply-To: ' + from
                }

                headerPart = headerPart.replace(/^Return-Path: (.*)\r?\n/mg, '')

                headerPart = headerPart.replace(/^Sender: (.*)\r?\n/mg, '')

                headerPart = headerPart.replace(/^Message-ID: (.*)\r?\n/mig, '')

                headerPart = headerPart.replace(/^DKIM-Signature: .*\r?\n(\s+.*\r?\n)*/mg, '')

                headerPart = headerPart.replace(/X-Original-Received:/g, 'X-Original-Received-Tmp:')
                headerPart = headerPart.replace(/Received:/g, 'X-Original-Received:')
                headerPart = headerPart.replace(/X-Original-Received-Tmp:/g, 'X-Original-Received:')

                match = null

                async.mapSeries(toRecipients, (recipient, callback) => {
                    if (recipient.type === 'email') {
                        var rawMessage = headerPart.replace(
                            /^From: (.*(?:\r?\n\s+.*)*)/mg,
                            (match, from) => {
                                return 'From: ' + originalRecipient
                            }
                        ) + bodyPart

                        return ses.sendRawEmail({
                            Destinations: [ recipient.address ],
                            Source: originalRecipient,
                            RawMessage: {
                                Data: rawMessage
                            }
                        }, (err) => {
                            rawMessage = null

                            if (!!err) {
                                return callback(new MailDispatcherError('Email sending failed. ' + err.message, message))
                            }

                            console.log('Email forwarded from "%s" to "%s".', originalRecipient, recipient.address)

                            return callback(null)
                        })
                    }

                    if (recipient.type === 'command') {
                        var rawMessage = headerPart + bodyPart

                        var command = recipient.command
                        command = command.replace('{{MESSAGE_ID}}', email.messageId)
                        command = command.replace('{{DOMAIN}}', from.slice(from.lastIndexOf('@') + 1))
                        command = command.replace('{{FROM}}', from)

                        var ssh = new SSH({
                            host: recipient.host,
                            port: recipient.port,
                            user: recipient.user,
                            key: recipient.key
                        })

                        return ssh.exec(command, {
                            in: rawMessage,
                            exit: (code, stdout, stderr) => {
                                rawMessage = null
                                command = null
                                ssh = null

                                if (code === 0) {
                                    console.log('Email forwarded from "%s" to command "%s".', originalRecipient, recipient.command)

                                    return callback(null)
                                } else {
                                    return callback(new MailDispatcherError('Error during command invocation: ' + stderr, message))
                                }
                            }
                        }).start()
                    }

                    return callback(new Error('Unable to handle the recipient: ' + JSON.stringify(recipient)))
                }, (err) => {
                    match = null
                    headerPart = null
                    bodyPart = null

                    if (!!err) {
                        return callback(err)
                    }

                    return callback(null)
                })
            }, (err) => {
                message = null

                if (!!err) {
                    return callback(err)
                }

                callback(null, email, recipients)
            })
        },

        (email, recipients, callback) => {
            s3.deleteObject({
                Bucket: configuration.bucket,
                Key: configuration.bucketPrefix + email.messageId
            }, (err) => {
                if (!!err) {
                    return callback(new Error('Email cleanup failed. ' + err.message))
                }

                callback(null, email, recipients)
            })
        }

    ], (err) => {
        if (!!err) {
            console.error('Error occurred while processing the email: ', err)

            return callback(err)
        } else {
            console.log('Email processed successfully.')

            return callback(null)
        }
    })
}