# MAIL DISPATCHER

## Description

The repository contains a mail dispatcher based on [MailGun's](https://www.mailgun.com) routing functionality for domains managed on [AWS's Route53](https://aws.amazon.com/route53/) in order to map and forward mails sent to aliases or mailing lists.

## Requirements

This application requires

- Unix-like environment (Linux/Mac OS X)
- Shell/Terminal
- Node.js (8.10 or greater) and Yarn
- AWS Account
- MailGun Account (Premium Tier with routes enabled)

## Setup

The following instructions will configure the environment and need to be performed only once, unless of course, the configuration/environment is changed significantly.

1. Clone or download the project repository
1. Run `yarn` from the project's directory
1. Create AWS account and configure required resources
1. Create MailGun account and get API key
1. Setup repository with mappings configuration
1. Create configuration file `config.json`
1. Run `deploy` command

### Configure AWS user/credentials

If you don't want to use your existing AWS account, you can create a separate user with it's own credentials. From the IAM's control panel you can create new users with the following options and settings

- **Username**: (of your choice)
- **Programmatic access**: Checked/Enabled

Make sure the following permissions/policies are configured

- **AmazonRoute53FullAccess**

After successful creation of the user, please take note of the created access/secret keys and indicate them in the configuration properties `aws.accessKey` and `aws.secretKey`.

### Configuration

The following snippet is an example configuration file. Please make sure to replace the placeholder `{AWS-ACCESS-KEY}`, `{AWS-SECRET-KEY}` and `{MAILGUN-API-KEY}`.

    {
      "aws": {
        "accessKey": "{AWS-ACCESS-KEY}",
        "secretKey": "{AWS-SECRET-KEY}"
      },
      "mailgun": {
        "apiKey": "{MAILGUN-API-KEY}",
        "region": "eu"
      },
      "domains": [
        {
          "domain": "mg1.example.org",
          "smtp_password" : "tesThing",
          "credentials" : [
            {
              "login" : "alice@mg1.example.org",
              "password" : "tesThingAlice"
            },
            {
              "login" : "bob@mg1.example.org",
              "password" : "tesThingBob"
            }
          ]
        },
        {
          "domain": "mails.example.com",
          "zone": "example.com",
          "additionalSenders": [ "..." ],
          "additionalTxtRecords: [ "...", "..." ]
        },
        "anotherexample.com"
      ],
      "removeMissingDomains" : false,
      "deleteExistingMailgunDomains" : false,
      "resetDkimSelector" : false,
      "loglevel" : "info",
      "debug" : true,
      "forceRouteDeletion" : true,
      "mappings": {
        "info@example.org": [ "...", "..." ],
        "info@mails.example.com": [ "..." ]
      },
      
      (or)
      
      "mappings": "/path/to/folder/with/mappings/**/*.json",
      
      (or)
      
      "mappings": [
        "/path/to/folder/with/mappings/**/*.json",
        "/another/path/to/folder/with/mappings/**/*.json"
      ]
    }

#### Configuration properties: aws.accessKey, aws.secretKey

    Required: true
    Type: string

These properties represent the credentials of a valid AWS account.

#### Configuration property: defaultTo

    Required: false
    Type: string or array of strings

Defines a list of recipients that will receive emails that don't match any of the specified mappings.

#### Configuration property: domains

    Required: true
    Type: array (objects with structure { "domain", "zone", "defaultTo", "smtp_password", "credentials", "force" } or strings)

The domains enabled for forwarding, if only a string is supplied then the default options for the domain are used. If you use a subdomain, then you can define the hosted zone used on Route53 - otherwise the given domain name will be used.

It is possible to define a default recipients mapping separately from the global configuration with `defaultTo`. If you just want to apply the global configuration, then you can specify nothing or just `"defaultTo": true` - on the other hand if you have a global configuration but you don't want to apply it to a specific domain, then `"defaultTo": false` is what you're looking for.

#### Configuration property: removeMissingDomains

    Required: false
    Default: false
    Type: bool

If true, domains that are missing in the configuration but exist in your mailgun account will be removed from Mailgun during deployment (!)

#### Configuration property: deleteExistingMailgunDomains

    Required: false
    Default: false
    Type: bool

if true, configured domains are deleted by Mailgun and rebuilt from scratch (normal behaviour before 2.0.0). if this parameter is missing or false, existing domains are reused by mailgun. 


#### Configuration property: debug

    Required: false
    Default: false
    Type: bool

If true, verification step will be skipped

#### Configuration property: mappings

    Required: true
    Type: mappings object, path string with wildcards, array of path strings with wildcards

The configuration of the mappings used when forwarding incoming emails. It is possible to directly specify the emails and their mapped recipients as a JSON object and/or use one or more path locations that contain JSON files, that can be also organised using nested subfolders.

When choosing to organize the mappings using JSON files, it is obviously possible to use folders based on Git repositories.

Regardless of their location, the mappings file(s) have to be structured as in the following example

    {
      "info@example.org": [ "...", "..." ],
      "info@mails.example.com": [ "..." ],
      "ask@anotherexample.com": "..."
    }

If you specify/map the same address multiple times (in different files), then the resulting recipients will be merged together.

## Usage

The `mail-dispatcher` executable provides multiple sub-commands, namely

* help
* deploy
* clean
* routes

The following options are available for all sub-commands

    -c, --configuration    Path to external/different configuration file to use
    -s, --silent           Suppress all logging output

If no external configuration file is specified using `-c` or `--configuration`, then the application expects to find a configuration file named **config.json** inside the project folder.

### mail-dispatcher help

Print all the application's sub-commands and available options.

### mail-dispatcher deploy

Deploy the currently configured mappings to AWS and MailGun infrastructures. When running this command all relevant settings will be configured and updated so that the incoming emails will be processed correctly by MailGun's routing functionality.

When hosted zones are created from scratch on Route53 and the nameserver configuration is not automatically managed and updated, the nameserver hostnames are printed out on the console.

Attention: All unlisted domains will be deleted from Mailgun

### mail-dispatcher routes

Reset all routes at Mailgun. All existing routes are deleted (if config.debug != true && config.forceRouteDeletion == true) and regenerated based on the current configuration. All other settings/configurations remain untouched.

Quick way to correct discrepancies between existing routes and configuration without having to provoke a complete reset of the entire setup. Can and should be used once/manually if required.

Attention: This software does not support pagination at Mailgun and the hard cap for routes is 1000. This should be sufficient for the application usecase. If more than 1000 routes are configured, discrepancies may occur. In this case, routes may be created twice.

### mail-dispatcher clean

Clean all related resources on AWS (DNS records) and MailGun (domains, routes). Eventually created hosted zones on Route53 are not removed/deleted.

## Testing

You can test this script with example domains (example.org). In this case Mailgun cannot verify the domains. Set the debug parameter to true to avoid the verification step.

**as always, make a backup copy of your current mailgun and aws configuration before using this script in your productive environment**

## Authors

* Daniel Rampanelli [hello@danielrampanelli.com](mailto:hello@danielrampanelli.com)

## License

`TODO`