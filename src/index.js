const async = require('async')
const AWS = require('aws-sdk')
const fs = require('fs')

const configuration = JSON.parse(fs.readFileSync(__dirname + '/config.json'))

exports.handler = (event, context, callback) => {
    const ses = new AWS.SES()
    const s3 = new AWS.S3({ signatureVersion: 'v4' })

    async.waterfall([

        (callback) => {
            if (!event || !event.hasOwnProperty('Records') || event.Records.length !== 1 || !event.Records[0].hasOwnProperty('eventSource') || event.Records[0].eventSource !== 'aws:ses' || event.Records[0].eventVersion !== '1.0') {
                return callback(new Error('Invalid SES message received.'))
}

            callback(null, event.Records[0].ses.mail, event.Records[0].ses.receipt.recipients)
        },

        (email, recipients, callback) => {
            var matches = {}

            recipients.forEach((recipient) => {
                matches[recipient] = configuration.mappings[recipient] || configuration.mappings['@default']
            })

            callback(null, email, matches)
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
                })
            })
        },

        (email, recipients, body, callback) => {
            async.eachOfSeries(recipients, (recipients, originalRecipient, callback) => {
                var match = body.match(/^((?:.+\r?\n)*)(\r?\n(?:.*\s+)*)/m)
                var headerPart = match && match[1] ? match[1] : body
                var bodyPart = match && match[2] ? match[2] : ''

                if (!/^Reply-To: /mi.test(headerPart)) {
                    match = headerPart.match(/^From: (.*(?:\r?\n\s+.*)*\r?\n)/m)
                    var from = match && match[1] ? match[1] : ''
                    if (from) {
                        headerPart = headerPart + 'Reply-To: ' + from
                    }
                }

                headerPart = headerPart.replace(
                    /^From: (.*(?:\r?\n\s+.*)*)/mg,
                    (match, from) => {
                        return 'From: ' + from.replace('<', 'at ').replace('>', '') + ' <' + originalRecipient + '>'
                    })

                headerPart = headerPart.replace(/^Return-Path: (.*)\r?\n/mg, '')

                headerPart = headerPart.replace(/^Sender: (.*)\r?\n/mg, '')

                headerPart = headerPart.replace(/^Message-ID: (.*)\r?\n/mig, '')

                headerPart = headerPart.replace(/^DKIM-Signature: .*\r?\n(\s+.*\r?\n)*/mg, '')

                headerPart += ('Received: by inbound-smtp.' + configuration.region + '.amazonaws.com with SMTP; ' + (new Date()).toString() + '\r\n')

                ses.sendRawEmail({
                    Destinations: recipients,
                    Source: originalRecipient,
                    RawMessage: {
                        Data: headerPart + bodyPart
                    }
                }, (err, data) => {
                    if (!!err) {
                        return callback(new Error('Email sending failed. ' + err.message))
                    }

                    callback(null, email, recipients, body)
                })
            }, (err) => {
                if (!!err) {
                    return callback(err)
                }

                callback(null, email, recipients, body)
            })
        },

        (email, recipients, body, callback) => {
            s3.deleteObject({
                Bucket: configuration.bucket,
                Key: configuration.bucketPrefix + email.messageId
            }, (err, data) => {
                if (!!err) {
                    return callback(new Error('Email sending failed. ' + err.message))
                }

                callback(null, email, recipients, body)
            })
        }

    ], (err, email, recipients, body) => {
        if (!!err) return console.error(err)

        for (originalRecipient in recipients) {
            console.log('Email forwarded from %s to [ %s ].', originalRecipient, recipients[originalRecipient].join(', '))
        }
    })
}