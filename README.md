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
1. Create/configure certificates and roles in AWS
1. Create configuration file `config.json`
1. Create/update repository with mappings configuration
1. Configure roles, verified domains and rules for incoming emails

## Usage

The `mail-dispatcher` executable provides multiple sub-commands, namely

* help
* deploy

The following options are available for all sub-commands

	-c, --configuration    Path to external/different configuration file to use

If no external configuration file is specified using `-c` or `--configuration`, then the application expects to find a configuration file named **config.json** inside the project folder.

### mail-dispatcher help

Print all the application's sub-commands and available options.

### mail-dispatcher deploy

Fetch the mappings configuration and deploy the function to the AWS infrastructure.