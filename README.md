# MAIL DISPATCHER

## Description

The repository contains a mail dispatcher developed using Amazon AWS technologies ([SES](https://aws.amazon.com/ses/), [Lambda](https://aws.amazon.com/lambda/)) in order to map and forward mails sent to aliases or mailing lists.

## Requirements

This application requires

- Node.js (8.10 or greater)
- Unix-like environment (Linux/Mac OS X)
- Shell/Terminal
- AWS Account

## Setup

The following instructions will configure the environment and need to be performed only once, unless of course, the configuration/environment is changed significantly.

1. Clone or download project repository
1. Run `npm install` from the project's directory
1. Create/configure required resources in AWS
1. Setup repository with mappings configuration
1. Create configuration file `config.json`
1. Run `setup` command

### Setup role for AWS Lambda

The function which will process the incoming emails needs to be associated with an execution role, which defines all the permitted permissions/capabilities. The ARN of the role needs to be indicated in the configuration's property `aws.functionRoleArn`.

The role can be based on the following role policy, but it is also possible to use an existing role that provide the same permissions.

    {
        "Version": "2012-10-17",
        "Statement": [
            {
                "Effect": "Allow",
                "Action": [
                    "logs:CreateLogGroup",
                    "logs:CreateLogStream",
                    "logs:PutLogEvents"
                ],
                "Resource": "arn:aws:logs:*:*:*"
            },
            {
                "Effect": "Allow",
                "Action": "ses:SendRawEmail",
                "Resource": "*"
            },
            {
                "Effect": "Allow",
                "Action": [
                    "s3:GetObject",
                    "s3:PutObject",
                    "s3:DeleteObject"
                ],
                "Resource": "arn:aws:s3:::{ S3-BUCKET-NAME }/*"
            }
        ]
    }

### Setup S3 bucket for SES

You need to create a new one or indicate an existing S3 bucket, used to temporarily store the incoming emails while they are being processed and forwarded, in the configuration's property `aws.bucket`.

The bucket has to be configured with the following policy ("Permissions" tab of the S3 bucket detail page), please make sure to replace the placeholders `{ S3-BUCKET-NAME }` and `{ AWS-ACCOUNT-ID }` with the actual values.
    
    {
        "Version": "2012-10-17",
        "Statement": [
            {
                "Sid": "AllowAccessToBucketFromSES",
                "Effect": "Allow",
                "Principal": {
                    "Service": "ses.amazonaws.com"
                },
                "Action": "s3:PutObject",
                "Resource": "arn:aws:s3:::{ S3-BUCKET-NAME }/*",
                "Condition": {
                    "StringEquals": {
                        "aws:Referer": "{ AWS-ACCOUNT-ID }"
                    }
                }
            }
        ]
    }

### Configuration

The following snippet is an example configuration file. Please make sure to replace the placeholder `{ AWS-ACCESS-KEY }`, `{ AWS-SECRET-KEY }`, `{ S3-BUCKET-NAME }` and `{ FUNCTION-ROLE-ARN }`.

    {
        "mappings": {
            "type": "git",
            "uri": "..."
        },
        "domains": [
            {
                "domain": "mails.example.com",
                "defaultTo": [ "info@mails.example.com" ]
            }
        ],
        "aws": {
            "accessKey": "{ AWS-ACCESS-KEY }",
            "secretKey": "{ AWS-SECRET-KEY }",
            "region": "eu-west-1",
            "bucket": "{ S3-BUCKET-NAME }",
            "bucketPrefix": "",
            "functionRoleArn": "{ FUNCTION-ROLE-ARN }"
        }
    }

#### Configuration property: mappings

    Required: true
    Type: object with structure { "type", "uri" }

The configuration of the mappings used when forwarding incoming emails. It is possible to use a Git repository, a local JSON file or a remote JSON url as source for the configuration of mappings.

When using a Git repository for the mappings configuration, the repository will be cloned locally and all contained JSON files (regardless of their folder structure) will be parsed and included.

In this case the `mappings` property will be configured as follows

    {
        "type": "git",
        "uri": "https://github.com/idm-suedtirol/mail-dispatcher-example-config.git"
    }

Each `*.json` file in the cloned working copy of the repository must have the following structure

    {
        "from": "tech@mails.example.com",
        "to": [
            "john.doe@example.com",
            "jane.doe@example.com"
        ]
    }

You can also choose to use a local JSON file for holding the mappings configuration
    
    {
        "type": "file",
        "uri": "/etc/mail-dispatcher/mappings.json"
    }

or a local JSON file, like follows

    {
        "type": "http",
        "uri": "https://etc.example.com/mail-dispatcher/mappings.json"
    }

In both these cases, the structure of the file has to be structured like in the following example

    [
        {
            "from": "all@mails.example.com",
            "to": [
                "administration@example.com",
                "john.doe@example.com",
                "jane.doe@example.com",
                "support@example.com"
            ]
        },
        {
            "from": "tech@mails.example.com",
            "to": [
                "john.doe@example.com",
                "jane.doe@example.com"
            ]
        }
    ]

#### Configuration property: domains

    Required: true
    Type: array (objects with structure { "domain", "defaultRecipient" })

The domains used for the forwarding, each associated with a default recipient. These domains will be queued for verification during the `setup` command, if not yet configured.

#### Configuration properties: aws.accessKey, aws.secretKey

    Required: true
    Type: string

These properties represent the credentials of a valid AWS account.

#### Configuration property: aws.region

    Required: true
    Type: string (AWS region)

These properties represent a valid AWS region in which all resources will be deployed and which should contain all referenced objects.

#### Configuration property: aws.bucket

    Required: true
    Type: string (S3 bucket name)

This property represents the name of the S3 bucket that has been setup and configured.

#### Configuration property: aws.bucketPrefix

    Required: false
    Type: string (path prefix with trailing slash)

This property is used to store the emails in the configured S3 bucket using a prefix ("subfolder"). If not specified or empty, the email will be stored temporarily in the root path of the bucket.

#### Configuration property: aws.functionRoleArn

    Required: true
    Type: string (AWS ARN)

This property represents the ARN of a AWS role that will be associated to the deployed function.

## Usage

The `mail-dispatcher` executable provides multiple sub-commands, namely

* help
* setup
* deploy

The following options are available for all sub-commands

    -c, --configuration    Path to external/different configuration file to use
    -s, --silent           Suppress all logging output

If no external configuration file is specified using `-c` or `--configuration`, then the application expects to find a configuration file named **config.json** inside the project folder.

### mail-dispatcher help

Print all the application's sub-commands and available options.

### mail-dispatcher setup

Setup all configured domains and start verification process for pending items. This command will output all required data for the DNS configuration for the specified domains.

A typical output of this command looks as follows

    (1) Domain: mails.example.com
    (2)   > Status: Pending
    (3)   > MX Record: inbound-smtp.eu-west-1.amazonaws.com
    (4)   > Verification Domain: _amazonses.mails.example.com
    (5)   > Verification Value (TXT): 6sGk2GAyieeDhOdbGGNgifYeJo2PBDE4ZuHafLoKO/c=

In order to setup the domain you need to first configure the MX record on the domain (1) with value (3). Then you need to setup a TXT record on the verification domain (4) with value (5).

This command can be executed consecutively without consequences.

### mail-dispatcher deploy

Fetch the mappings configuration and deploy the function to the AWS infrastructure. When running this command all relevant settings will be configured and updated so that the incoming emails will be processed correctly by the deployed function.

The function will be uploaded with a snapshot of the mappings configuration, so any changes will need to be re-deployed using this command.

## Credits

Based on the work of @arithmetric from: https://github.com/arithmetric/aws-lambda-ses-forwarder