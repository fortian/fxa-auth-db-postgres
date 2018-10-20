/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

'use strict'

const crypto = require('crypto')
const ip = require('ip')
const pg = require('pg')
const P = require('../promise')

const patch = require('./patch')
const dbUtil = require('./util')
const config = require('../../config')

const REQUIRED_CHARSET = 'UTF8MB4_BIN'
const DATABASE_NAME = require('../constants').DATABASE_NAME

const REQUIRED_SQL_MODES = [
  'STRICT_ALL_TABLES',
  'NO_ENGINE_SUBSTITUTION',
]

// https://www.postgresql.org/docs/10/static/errcodes-appendix.html
const ER_TOO_MANY_CONNECTIONS = 53300
const ER_DUP_ENTRY = 42710
const ER_LOCK_WAIT_TIMEOUT = '25P03'
const ER_LOCK_TABLE_FULL = '55P03'
const ER_LOCK_DEADLOCK = '40P01'
const ER_LOCK_ABORTED = 40002

// custom errors
const ER_DELETE_PRIMARY_EMAIL = 2100
const ER_EXPIRED_TOKEN_VERIFICATION_CODE = 2101
const ER_SIGNAL_NOT_FOUND = 1643

const RECOVERY_CODE_LENGTH = config.recoveryCodes.length

module.exports = function (log, error) {

  var LOCK_ERRNOS = [
    ER_LOCK_WAIT_TIMEOUT,
    ER_LOCK_TABLE_FULL,
    ER_LOCK_DEADLOCK,
    ER_LOCK_ABORTED
  ]

  // make a pool of connections that we can draw from
  function PostgreSQL(options) {
    options.master.database = DATABASE_NAME
    options.slave.database = DATABASE_NAME
    this.options = options
    this.ipHmacKey = options.ipHmacKey

    this.patchLevel = 0
    // poolCluster will remove the pool after `removeNodeErrorCount` errors.
    // We don't ever want to remove a pool because we only have one pool
    // for writing and reading each. Connection errors are mostly out of our
    // control for automatic recovery so monitoring of 503s is critical.
    // Since `removeNodeErrorCount` is Infinity `canRetry` must be false
    // to prevent inifinite retry attempts.
    this.poolCluster = pg.createPoolCluster(
      {
        removeNodeErrorCount: Infinity,
        canRetry: false
      }
    )

    if (options.charset && options.charset !== REQUIRED_CHARSET) {
      log.error('createPoolCluster.invalidCharset', { charset: options.charset })
      throw new Error('You cannot use any charset besides ' + REQUIRED_CHARSET)
    } else {
      options.charset = REQUIRED_CHARSET
    }

    options.master.charset = options.charset
    options.slave.charset = options.charset

    this.requiredModes = REQUIRED_SQL_MODES
    if (options.requiredSQLModes) {
      this.requiredModes = options.requiredSQLModes.split(',')
      this.requiredModes.forEach(mode => {
        if (! /^[A-Z0-9_]+$/.test(mode)) {
          throw new Error('Invalid SQL mode: ' + mode)
        }
      })
    }

    // Use separate pools for master and slave connections.
    this.poolCluster.add('MASTER', options.master)
    this.poolCluster.add('SLAVE', options.slave)
    this.getClusterConnection = P.promisify(this.poolCluster.getConnection, {
      context: this.poolCluster
    })


    this.statInterval = setInterval(
      reportStats.bind(this),
      options.statInterval || 15000
    )
    this.statInterval.unref()

    // prune tokens every so often
    function prune() {
      this.pruneTokens().then(
        function() {
          log.info('PostgreSQL.pruneTokens', { msg: 'Finished' })
        },
        function(err) {
          log.error('PostgreSQL.pruneTokens', { err: err })
        }
      )

      var pruneIn = options.pruneEvery / 2 + Math.floor(Math.random() * options.pruneEvery)
      setTimeout(prune.bind(this), pruneIn).unref()
    }
    // start the pruning off, but only if enabled in config
    if ( options.enablePruning ) {
      prune.bind(this)()
    }
  }

  function reportStats() {
    var nodes = Object.keys(this.poolCluster._nodes).map(
      function (name) {
        return this.poolCluster._nodes[name]
      }.bind(this)
    )
    var stats = nodes.reduce(
      function (totals, node) {
        totals.errors += node.errorCount
        totals.connections += node.pool._allConnections.length
        totals.queue += node.pool._connectionQueue.length
        totals.free += node.pool._freeConnections.length
        return totals
      },
      {
        stat: 'pg',
        errors: 0,
        connections: 0,
        queue: 0,
        free: 0
      }
    )
    log.info('stats', stats)
  }

  // this will be called from outside this file
  PostgreSQL.connect = function(options) {
    return P.resolve().then(() => {
      // check that the database patch level is what we expect (or one above)
      var pg = new PostgreSQL(options)

      // Select : dbMetadata
      // Fields : value
      // Where  : name = $1
      var DB_METADATA = 'CALL dbMetadata_1(?)'

      return pg.readFirstResult(DB_METADATA, [options.patchKey])
        .then(
          function (result) {
            pg.patchLevel = +result.value

            log.info('connect', {
              patchLevel: pg.patchLevel,
              patchLevelRequired: patch.level
            })

            if ( pg.patchLevel >= patch.level ) {
              return pg
            }

            throw new Error('dbIncorrectPatchLevel')
          }
        )
    })
  }

  PostgreSQL.prototype.close = function () {
    this.poolCluster.end()
    clearInterval(this.statInterval)
    return P.resolve()
  }

  PostgreSQL.prototype.ping = function () {
    return this.getConnection('MASTER')
      .then(
        function(connection) {
          var d = P.defer()
          connection.ping(
            function (err) {
              connection.release()
              return err ? d.reject(err) : d.resolve()
            }
          )
          return d.promise
        }
      )
  }

  // CREATE

  // Insert : accounts
  // Values : uid = $1, normalizedEmail = $2, email = $3, emailCode = $4, emailVerified = $5, kA = $6, wrapWrapKb = $7, authSalt = $8, verifierVersion = $9, verifyHash = $10, verifierSetAt = $11, createdAt = $12, locale = $13
  var CREATE_ACCOUNT = 'CALL createAccount_7(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'

  PostgreSQL.prototype.createAccount = function (uid, data) {
    return this.write(
      CREATE_ACCOUNT,
      [
        uid,
        data.normalizedEmail,
        data.email,
        data.emailCode,
        data.emailVerified,
        data.kA,
        data.wrapWrapKb,
        data.authSalt,
        data.verifierVersion,
        data.verifyHash,
        data.verifierSetAt,
        data.createdAt,
        data.locale
      ]
    )
  }

  // Insert : sessionTokens
  // Values : tokenId = $1, tokenData = $2, uid = $3, createdAt = $4,
  //          uaBrowser = $5, uaBrowserVersion = $6, uaOS = $7, uaOSVersion = $8,
  //          uaDeviceType = $9, uaFormFactor = $10, tokenVerificationId = $11
  //          mustVerify = $12, tokenVerificationCode = $13, tokenVerificationCodeExpiresAt = $14
  var CREATE_SESSION_TOKEN = 'CALL createSessionToken_9(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'

  PostgreSQL.prototype.createSessionToken = function (tokenId, sessionToken) {
    return this.write(
      CREATE_SESSION_TOKEN,
      [
        tokenId,
        sessionToken.data,
        sessionToken.uid,
        sessionToken.createdAt,
        sessionToken.uaBrowser,
        sessionToken.uaBrowserVersion,
        sessionToken.uaOS,
        sessionToken.uaOSVersion,
        sessionToken.uaDeviceType,
        sessionToken.uaFormFactor,
        sessionToken.tokenVerificationId,
        !! sessionToken.mustVerify,
        sessionToken.tokenVerificationCode ? dbUtil.createHash(sessionToken.tokenVerificationCode): null,
        sessionToken.tokenVerificationCodeExpiresAt
      ]
    )
  }

  // Insert : keyFetchTokens
  // Values : tokenId = $1, authKey = $2, uid = $3, keyBundle = $4, createdAt = $5,
  //          tokenVerificationId = $6
  var CREATE_KEY_FETCH_TOKEN = 'CALL createKeyFetchToken_2(?, ?, ?, ?, ?, ?)'

  PostgreSQL.prototype.createKeyFetchToken = function (tokenId, keyFetchToken) {
    return this.write(
      CREATE_KEY_FETCH_TOKEN,
      [
        tokenId,
        keyFetchToken.authKey,
        keyFetchToken.uid,
        keyFetchToken.keyBundle,
        keyFetchToken.createdAt,
        keyFetchToken.tokenVerificationId
      ]
    )
  }

  // Insert : passwordForgotTokens
  // Values : tokenId = $1, tokenData = $2, uid = $3, passCode = $4, createdAt = $5, tries = $6
  var CREATE_PASSWORD_FORGOT_TOKEN = 'CALL createPasswordForgotToken_2(?, ?, ?, ?, ?, ?)'

  PostgreSQL.prototype.createPasswordForgotToken = function (tokenId, passwordForgotToken) {
    return this.write(
      CREATE_PASSWORD_FORGOT_TOKEN,
      [
        tokenId,
        passwordForgotToken.data,
        passwordForgotToken.uid,
        passwordForgotToken.passCode,
        passwordForgotToken.createdAt,
        passwordForgotToken.tries
      ]
    )
  }

  // Insert : passwordChangeTokens
  // Values : tokenId = $1, tokenData = $2, uid = $3, createdAt = $4
  var CREATE_PASSWORD_CHANGE_TOKEN = 'CALL createPasswordChangeToken_2(?, ?, ?, ?)'

  PostgreSQL.prototype.createPasswordChangeToken = function (tokenId, passwordChangeToken) {
    return this.write(
      CREATE_PASSWORD_CHANGE_TOKEN,
      [
        tokenId,
        passwordChangeToken.data,
        passwordChangeToken.uid,
        passwordChangeToken.createdAt
      ]
    )
  }

  const UPSERT_AVAILABLE_COMMAND = 'CALL upsertAvailableCommand_1(?, ?, ?, ?)'
  const PURGE_AVAILABLE_COMMANDS = 'CALL purgeAvailableCommands_1(?, ?)'

  function makeStatementsToAddAvailableCommands(uid, deviceId, deviceInfo) {
    const availableCommands = deviceInfo.availableCommands || {}
    return Object.keys(availableCommands).reduce((acc, commandName) => {
      const commandData = availableCommands[commandName]
      acc.push({
        sql: UPSERT_AVAILABLE_COMMAND,
        params: [uid, deviceId, commandName, commandData]
      })
      return acc
    }, [])
  }

  const CREATE_DEVICE = 'CALL createDevice_4(?, ?, ?, ?, ?, ?, ?, ?, ?)'

  PostgreSQL.prototype.createDevice = function (uid, deviceId, deviceInfo) {
    const statements = [{
      sql: CREATE_DEVICE,
      params: [
        uid,
        deviceId,
        deviceInfo.sessionTokenId,
        deviceInfo.name, // inNameUtf8
        deviceInfo.type,
        deviceInfo.createdAt,
        deviceInfo.callbackURL,
        deviceInfo.callbackPublicKey,
        deviceInfo.callbackAuthKey
      ]
    }]
    if (deviceInfo.hasOwnProperty('availableCommands')) {
      statements.push(...makeStatementsToAddAvailableCommands(uid, deviceId, deviceInfo))
    }
    return this.writeMultiple(statements)
  }

  const UPDATE_DEVICE = 'CALL updateDevice_5(?, ?, ?, ?, ?, ?, ?, ?, ?)'

  PostgreSQL.prototype.updateDevice = function (uid, deviceId, deviceInfo) {
    const statements = [{
      sql: UPDATE_DEVICE,
      params: [
        uid,
        deviceId,
        deviceInfo.sessionTokenId,
        deviceInfo.name, // inNameUtf8
        deviceInfo.type,
        deviceInfo.callbackURL,
        deviceInfo.callbackPublicKey,
        deviceInfo.callbackAuthKey,
        deviceInfo.callbackIsExpired
      ],
      resultHandler(result) {
        // If the UPDATE_DEVICE fails, no need to continue!
        if (result.affectedRows === 0) {
          log.error('PostgreSQL.updateDevice', { err: result })
          throw error.notFound()
        }
      }
    }]
    if (deviceInfo.hasOwnProperty('availableCommands')) {
      statements.push({sql: PURGE_AVAILABLE_COMMANDS, params: [uid, deviceId]},
                      ...makeStatementsToAddAvailableCommands(uid, deviceId, deviceInfo))
    }
    return this.writeMultiple(statements)
  }

  // READ

  // Select : accounts
  // Fields : uid
  // Where  : normalizedEmail = LOWER($1)
  var ACCOUNT_EXISTS = 'CALL accountExists_2(?)'

  PostgreSQL.prototype.accountExists = function (emailBuffer) {
    return this.readFirstResult(ACCOUNT_EXISTS, [emailBuffer.toString('utf8')])
  }

  // Select : accounts
  // Fields : uid
  // Where  : uid = $1 AND verifyHash = $2
  var CHECK_PASSWORD = 'CALL checkPassword_1(?, ?)'

  PostgreSQL.prototype.checkPassword = function (uid, hash) {
    return this.readFirstResult(
      CHECK_PASSWORD,
      [uid, hash.verifyHash]
    ).catch(function(err) {
      // If .readFirstResult() doesn't find anything, it returns an error.notFound()
      // so we need to convert that to an error.incorrectPassword()
      if ( err.errno === error.notFound().errno ) {
        throw error.incorrectPassword()
      }
      throw err
    })
  }

  // Select : devices d, sessionTokens s, deviceAvailableCommands dc, deviceCommandIdentifiers ci
  // Fields : d.uid, d.id, d.sessionTokenId, d.name, d.type, d.createdAt, d.callbackURL,
  //          d.callbackPublicKey, d.callbackAuthKey, d.callbackIsExpired,
  //          s.uaBrowser, s.uaBrowserVersion, s.uaOS, s.uaOSVersion, s.uaDeviceType,
  //          s.uaFormFactor, s.lastAccessTime, {  ci.commandName : dc.commandData }
  // Where  : d.uid = $1
  var ACCOUNT_DEVICES = 'CALL accountDevices_15(?)'

  PostgreSQL.prototype.accountDevices = function (uid) {
    return this.readAllResults(ACCOUNT_DEVICES, [uid])
      .then(rows => dbUtil.aggregateNameValuePairs(rows, 'id', 'commandName', 'commandData', 'availableCommands'))
  }

  // Select : devices d, sessionTokens s, deviceAvailableCommands dc, deviceCommandIdentifiers ci
  // Fields : d.uid, d.id, d.sessionTokenId, d.name, d.type, d.createdAt, d.callbackURL,
  //          d.callbackPublicKey, d.callbackAuthKey, d.callbackIsExpired,
  //          s.uaBrowser, s.uaBrowserVersion, s.uaOS, s.uaOSVersion, s.uaDeviceType,
  //          s.uaFormFactor, s.lastAccessTime, {  ci.commandName : dc.commandData }
  // Where  : d.uid = $1 AND d.id = $2
  var DEVICE = 'CALL device_2(?, ?)'

  PostgreSQL.prototype.device = function (uid, id) {
    return this.readAllResults(DEVICE, [uid, id])
      .then(rows => dbUtil.aggregateNameValuePairs(rows, 'id', 'commandName', 'commandData', 'availableCommands'))
      .then(devices => {
        if (devices.length === 0) {
          throw error.notFound()
        }
        return devices[0]
      })
  }

  // Select : devices d, unverifiedTokens u
  // Fields : d.id, d.name, d.type, d.createdAt, d.callbackURL, d.callbackPublicKey,
  //          d.callbackAuthKey, d.callbackIsExpired
  // Where  : u.uid = $1 AND u.tokenVerificationId = $2 AND
  //          u.tokenId = d.sessionTokenId AND u.uid = d.uid
  var DEVICE_FROM_TOKEN_VERIFICATION_ID = 'CALL deviceFromTokenVerificationId_6(?, ?)'

  PostgreSQL.prototype.deviceFromTokenVerificationId = function (uid, tokenVerificationId) {
    return this.readAllResults(DEVICE_FROM_TOKEN_VERIFICATION_ID, [uid, tokenVerificationId])
      .then(rows => dbUtil.aggregateNameValuePairs(rows, 'id', 'commandName', 'commandData', 'availableCommands'))
      .then(devices => {
        if (devices.length === 0) {
          throw error.notFound()
        }
        return devices[0]
      })
  }

  // Select : sessionTokens t, accounts a, devices d, unverifiedTokens ut
  // Fields : t.tokenData, t.uid, t.createdAt, t.uaBrowser, t.uaBrowserVersion, t.uaOS,
  //          t.uaOSVersion, t.uaDeviceType, t.uaFormFactor, t.lastAccessTime, t.authAt,
  //          a.emailVerified, a.email, a.emailCode, a.verifierSetAt, a.locale,
  //          a.createdAt AS accountCreatedAt, a.profileChangedAt,
  //          d.id AS deviceId, d.name AS deviceName, d.type AS deviceType, d.createdAt
  //          AS deviceCreatedAt, d.callbackURL AS deviceCallbackURL, d.callbackPublicKey
  //          AS deviceCallbackPublicKey, d.callbackAuthKey AS deviceCallbackAuthKey,
  //          d.callbackIsExpired AS deviceCallbackIsExpired
  //          ut.tokenVerificationId, ut.mustVerify
  // Where  : t.tokenId = $1 AND t.uid = a.uid AND t.tokenId = d.sessionTokenId AND
  //          t.uid = d.uid AND t.tokenId = u.tokenId
  var SESSION_DEVICE = 'CALL sessionWithDevice_16(?)'

  PostgreSQL.prototype.sessionToken = function (id) {
    return this.readAllResults(SESSION_DEVICE, [id])
      .then(rows => dbUtil.aggregateNameValuePairs(rows, 'deviceId', 'deviceCommandName', 'deviceCommandData', 'deviceAvailableCommands'))
      .then(results => {
        if (results.length === 0) {
          throw error.notFound()
        }
        return results[0]
      })
  }

  // Select : sessionTokens t, devices d
  // Fields : t.tokenId, t.uid, t.createdAt, t.uaBrowser, t.uaBrowserVersion,
  //          t.uaOS, t.uaOSVersion, t.uaDeviceType, t.uaFormFactor, t.lastAccessTime, t.authAt,
  //          d.id AS deviceId, d.name AS deviceName, d.type AS deviceType,
  //          d.createdAt AS deviceCreatedAt, d.callbackURL AS deviceCallbackURL,
  //          d.callbackPublicKey AS deviceCallbackPublicKey, d.callbackAuthKey AS deviceCallbackAuthKey,
  //          d.callbackIsExpired AS deviceCallbackIsExpired
  // Where  : t.uid = $1 AND t.tokenId = d.sessionTokenId AND
  //          t.uid = d.uid AND t.tokenId = u.tokenId
  var SESSIONS = 'CALL sessions_11(?)'

  PostgreSQL.prototype.sessions = function (uid) {
    return this.readAllResults(SESSIONS, [uid])
      .then(rows => dbUtil.aggregateNameValuePairs(rows, 'deviceId', 'deviceCommandName', 'deviceCommandData', 'deviceAvailableCommands'))
  }

  // Select : keyFetchTokens t, accounts a
  // Fields : t.authKey, t.uid, t.keyBundle, t.createdAt, a.emailVerified, a.verifierSetAt
  // Where  : t.tokenId = $1 AND t.uid = a.uid
  var KEY_FETCH_TOKEN = 'CALL keyFetchToken_1(?)'

  PostgreSQL.prototype.keyFetchToken = function (id) {
    return this.readFirstResult(KEY_FETCH_TOKEN, [id])
  }

  // Select : keyFetchTokens t, accounts a, unverifiedTokens ut
  // Fields : t.authKey, t.uid, t.keyBundle, t.createdAt, a.emailVerified, a.verifierSetAt,
  //          ut.tokenVerificationId
  // Where  : t.tokenId = $1 AND t.uid = a.uid AND t.tokenId = ut.tokenId
  var KEY_FETCH_TOKEN_VERIFIED = 'CALL keyFetchTokenWithVerificationStatus_2(?)'

  PostgreSQL.prototype.keyFetchTokenWithVerificationStatus = function (tokenId) {
    return this.readFirstResult(KEY_FETCH_TOKEN_VERIFIED, [tokenId])
  }

  // Select : accountResetTokens t, accounts a
  // Fields : t.uid, t.tokenData, t.createdAt, a.verifierSetAt
  // Where  : t.tokenId = $1 AND t.uid = a.uid
  var ACCOUNT_RESET_TOKEN = 'CALL accountResetToken_1(?)'

  PostgreSQL.prototype.accountResetToken = function (id) {
    return this.readFirstResult(ACCOUNT_RESET_TOKEN, [id])
  }

  // Select : passwordForgotToken t, accounts a
  // Fields : t.uid, t.tokenData, t.createdAt, t.passCode, t.tries, a.email, a.verifierSetAt
  // Where  : t.tokenId = $1 AND t.uid = a.uid
  var PASSWORD_FORGOT_TOKEN = 'CALL passwordForgotToken_2(?)'
  PostgreSQL.prototype.passwordForgotToken = function (id) {
    return this.readFirstResult(PASSWORD_FORGOT_TOKEN, [id])
  }

  // Select : passwordChangeToken t, accounts a
  // Fields : t.uid, t.tokenData, t.createdAt, a.email, a.verifierSetAt
  // Where  : t.tokenId = $1 AND t.uid = a.uid
  var PASSWORD_CHANGE_TOKEN = 'CALL passwordChangeToken_3(?)'

  PostgreSQL.prototype.passwordChangeToken = function (id) {
    return this.readFirstResult(PASSWORD_CHANGE_TOKEN, [id])
  }

  // Select : accounts
  // Fields : uid, email, normalizedEmail, emailVerified, emailCode, kA, wrapWrapKb, verifierVersion, authSalt, verifierSetAt, createdAt, lockedAt
  // Where  : accounts.normalizedEmail = LOWER($1)
  var EMAIL_RECORD = 'CALL emailRecord_4(?)'

  PostgreSQL.prototype.emailRecord = function (emailBuffer) {
    return this.readFirstResult(EMAIL_RECORD, [emailBuffer.toString('utf8')])
  }

  // Select : accounts
  // Fields : uid, email, normalizedEmail, emailVerified, emailCode, kA, wrapWrapKb, verifierVersion, authSalt,
  //          verifierSetAt, createdAt, locale, lockedAt, profileChangedAt
  // Where  : accounts.uid = LOWER($1)
  var ACCOUNT = 'CALL account_4(?)'

  PostgreSQL.prototype.account = function (uid) {
    return this.readFirstResult(ACCOUNT, [uid])
  }

  // UPDATE

  // Update : passwordForgotTokens
  // Set    : tries = $1
  // Where  : tokenId = $2
  var UPDATE_PASSWORD_FORGOT_TOKEN = 'CALL updatePasswordForgotToken_1(?, ?)'

  PostgreSQL.prototype.updatePasswordForgotToken = function (tokenId, token) {
    return this.write(UPDATE_PASSWORD_FORGOT_TOKEN, [token.tries, tokenId])
  }

  // Update : sessionTokens
  // Set    : uaBrowser = $2, uaBrowserVersion = $3, uaOS = $4, uaOSVersion = $5,
  //          uaDeviceType = $6, uaFormFactor = $7, lastAccessTime = $8,
  //          authAt = $9, mustVerify = $10
  // Where  : tokenId = $1
  var UPDATE_SESSION_TOKEN = 'CALL updateSessionToken_3(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'

  PostgreSQL.prototype.updateSessionToken = function (tokenId, token) {
    return this.write(
      UPDATE_SESSION_TOKEN,
      [
        tokenId,
        token.uaBrowser,
        token.uaBrowserVersion,
        token.uaOS,
        token.uaOSVersion,
        token.uaDeviceType,
        token.uaFormFactor,
        token.lastAccessTime,
        token.authAt,
        token.mustVerify
      ]
    )
  }

  // DELETE

  // Delete : sessionTokens, keyFetchTokens, accountResetTokens, passwordChangeTokens,
  //          passwordForgotTokens, accounts, devices, unverifiedTokens, emails, signinCodes, totp
  // Where  : uid = $1
  var DELETE_ACCOUNT = 'CALL deleteAccount_15(?)'

  PostgreSQL.prototype.deleteAccount = function (uid) {
    return this.write(DELETE_ACCOUNT, [uid])
  }

  // Delete : sessionTokens, unverifiedTokens, devices
  // Where  : tokenId = $1
  var DELETE_SESSION_TOKEN = 'CALL deleteSessionToken_3(?)'

  PostgreSQL.prototype.deleteSessionToken = function (tokenId) {
    return this.write(DELETE_SESSION_TOKEN, [tokenId])
  }

  // Delete : keyFetchTokens, unverifiedTokens
  // Where  : tokenId = $1
  var DELETE_KEY_FETCH_TOKEN = 'CALL deleteKeyFetchToken_2(?)'

  PostgreSQL.prototype.deleteKeyFetchToken = function (tokenId) {
    return this.write(DELETE_KEY_FETCH_TOKEN, [tokenId])
  }

  // Delete : unverifiedTokens
  // Where  : tokenVerificationId = $1, uid = $2
  var VERIFY_TOKENS = 'CALL verifyToken_3(?, ?)'

  PostgreSQL.prototype.verifyTokens = function (tokenVerificationId, accountData) {
    return this.read(VERIFY_TOKENS, [tokenVerificationId, accountData.uid])
      .then(function (result) {
        if (result.affectedRows === 0) {
          throw error.notFound()
        }
      })
  }

  // Delete : unverifiedTokens
  // Where  : tokenVerificationCode = $1, uid = $2
  const VERIFY_TOKEN_CODE = 'CALL verifyTokenCode_1(?, ?)'

  PostgreSQL.prototype.verifyTokenCode = function (tokenData, accountData) {
    return this.readFirstResult(VERIFY_TOKEN_CODE, [dbUtil.createHash(tokenData.code), accountData.uid])
      .then((result) => {
        if (result['@updateCount'] === 0) {
          throw error.notFound()
        }
      })
      .catch((err) => {
        // Custom error when attempted to verify an expired code
        if (err.errno === ER_EXPIRED_TOKEN_VERIFICATION_CODE) {
          throw error.expiredTokenVerificationCode()
        }
        throw err
      })
  }

  // Delete : accountResetTokens
  // Where  : tokenId = $1
  var DELETE_ACCOUNT_RESET_TOKEN = 'CALL deleteAccountResetToken_1(?)'

  PostgreSQL.prototype.deleteAccountResetToken = function (tokenId) {
    return this.write(DELETE_ACCOUNT_RESET_TOKEN, [tokenId])
  }

  // Delete : passwordForgotTokens
  // Where  : tokenId = $1
  var DELETE_PASSWORD_FORGOT_TOKEN = 'CALL deletePasswordForgotToken_1(?)'

  PostgreSQL.prototype.deletePasswordForgotToken = function (tokenId) {
    return this.write(DELETE_PASSWORD_FORGOT_TOKEN, [tokenId])
  }

  // Delete : passwordChangeTokens
  // Where  : tokenId = $1
  var DELETE_PASSWORD_CHANGE_TOKEN = 'CALL deletePasswordChangeToken_1(?)'

  PostgreSQL.prototype.deletePasswordChangeToken = function (tokenId) {
    return this.write(DELETE_PASSWORD_CHANGE_TOKEN, [tokenId])
  }

  // Select : devices
  // Fields : sessionTokenId
  // Delete : devices, sessionTokens, unverifiedTokens
  // Where  : uid = $1, deviceId = $2
  var DELETE_DEVICE = 'CALL deleteDevice_3(?, ?)'

  PostgreSQL.prototype.deleteDevice = function (uid, deviceId) {
    return this.write(DELETE_DEVICE, [ uid, deviceId ], results => {
      const result = results[1]
      if (result.affectedRows === 0) {
        log.error('PostgreSQL.deleteDevice', { err: result })
        throw error.notFound()
      }
      return results[0][0]
    })
  }

  // VERIFICATION REMINDERS

  // INSERT : id, uid, email, emailCode, type, acceptLanguage, createdAt
  var CREATE_REMINDER = 'CALL createVerificationReminder_2(?, ?, ?)'

  PostgreSQL.prototype.createVerificationReminder = function (body) {
    if (! body || ! body.uid || ! body.type) {
      throw error.wrap(new Error('"uid", "type" are required'))
    }

    var reminderData = {
      uid: Buffer.from(body.uid),
      type: body.type,
      createdAt: Date.now()
    }

    return this.write(CREATE_REMINDER, [
      reminderData.uid,
      reminderData.type,
      reminderData.createdAt
    ])
  }

  // SELECT:
  var FETCH_REMINDERS = 'CALL fetchVerificationReminders_2(?, ?, ?, ?, ?)'

  PostgreSQL.prototype.fetchReminders = function (body, query) {
    var now = Date.now()

    if (! query || ! query.reminderTime || ! query.reminderTimeOutdated || ! query.type || ! query.limit) {
      throw error.wrap(new Error('fetchReminders - reminderTime, reminderTimeOutdated, limit or type missing'))
    }

    return this.read(FETCH_REMINDERS, [
      now,
      query.type,
      query.reminderTime,
      query.reminderTimeOutdated,
      query.limit
    ]).then(function (readResult) {
      return readResult[0]
    })
  }

  // DELETE REMINDER:
  var DELETE_REMINDER = 'CALL deleteVerificationReminder_1(?, ?)'

  PostgreSQL.prototype.deleteReminder = function (body) {
    if (! body || ! body.uid || ! body.type) {
      throw error.wrap(new Error('"uid", "type" are required'))
    }

    var reminderData = {
      uid: body.uid,
      type: body.type
    }

    return this.write(
      DELETE_REMINDER,
      [
        reminderData.uid,
        reminderData.type
      ]
    )
  }

  // BATCH

  // Step   : 1
  // Delete : sessionTokens, keyFetchTokens, accountResetTokens, passwordChangeTokens,
  //          passwordForgotTokens, devices, unverifiedTokens
  // Where  : uid = $1
  //
  // Step   : 2
  // Update : accounts
  // Set    : verifyHash = $2, authSalt = $3, wrapWrapKb = $4, verifierSetAt = $5, verifierVersion = $6
  // Where  : uid = $1
  var RESET_ACCOUNT = 'CALL resetAccount_9(?, ?, ?, ?, ?, ?)'

  PostgreSQL.prototype.resetAccount = function (uid, data) {
    return this.write(
      RESET_ACCOUNT,
      [uid, data.verifyHash, data.authSalt, data.wrapWrapKb, data.verifierSetAt, data.verifierVersion]
    )
  }

  // Update : accounts, emails
  // Set    : emailVerified = true if email is in accounts table or isVerified = true if on email table
  // Where  : uid = $1, emailCode = $2
  var VERIFY_EMAIL = 'CALL verifyEmail_6(?, ?)'

  PostgreSQL.prototype.verifyEmail = function (uid, emailCode) {
    return this.write(VERIFY_EMAIL, [uid, emailCode])
  }

  // Step   : 1
  // Delete : passwordForgotTokens
  // Where  : tokenId = $1
  //
  // Step   : 2
  // Insert : accountResetTokens
  // Values : tokenId = $2, tokenData = $3, uid = $4, createdAt = $5
  //
  // Step   : 3
  // Update : accounts
  // Set    : emailVerified = true
  // Where  : uid = $4
  //
  // Step   : 4
  // Update : emails
  // Set    : isVerified = true
  // Where  : isPrimary = true AND uid = $4
  var FORGOT_PASSWORD_VERIFIED = 'CALL forgotPasswordVerified_7(?, ?, ?, ?, ?)'

  PostgreSQL.prototype.forgotPasswordVerified = function (tokenId, accountResetToken) {
    return this.write(
      FORGOT_PASSWORD_VERIFIED,
      [
        tokenId,
        accountResetToken.tokenId,
        accountResetToken.data,
        accountResetToken.uid,
        accountResetToken.createdAt
      ]
    )
  }

  // Update : accounts
  // Set    : locale = $1
  // Where  : uid = $2
  var UPDATE_LOCALE = 'CALL updateLocale_1(?, ?)'

  PostgreSQL.prototype.updateLocale = function (uid, data) {
    return this.write(UPDATE_LOCALE, [data.locale, uid])
  }

  var CREATE_UNBLOCK_CODE = 'CALL createUnblockCode_1(?, ?, ?)'

  PostgreSQL.prototype.createUnblockCode = function (uid, code) {
    // hash the code since it's like a password
    code = dbUtil.createHash(uid, code)
    return this.write(
      CREATE_UNBLOCK_CODE,
      [ uid, code, Date.now() ],
      function (result) {
        return {}
      }
    )
  }

  var CONSUME_UNBLOCK_CODE = 'CALL consumeUnblockCode_3(?, ?)'

  PostgreSQL.prototype.consumeUnblockCode = function (uid, code) {
    // hash the code since it's like a password
    code = dbUtil.createHash(uid, code)
    return this.write(
      CONSUME_UNBLOCK_CODE,
      [ uid, code ],
      function (result) {
        if (result.length === 0 || result[0].length === 0 || ! result[0][0].createdAt) {
          log.error('PostgreSQL.consumeUnblockCode', { err: result })
          throw error.notFound()
        }
        return result[0][0]
      }
    )
  }

  // USER EMAILS
  // Insert : emails
  // Values : normalizedEmail = $1, email = $2, uid = $3, emailCode = $4, isVerified = $5, verifiedAt = $7, createdAt = $8
  var CREATE_EMAIL = 'CALL createEmail_2(?, ?, ?, ?, ?, ?, ?)'
  PostgreSQL.prototype.createEmail = function (uid, data) {
    return this.write(
      CREATE_EMAIL,
      [
        data.normalizedEmail,
        data.email,
        uid,
        data.emailCode,
        data.isVerified,
        data.verifiedAt,
        Date.now()
      ]
    )
  }

  // Get : email
  // Values : email = $1
  var GET_SECONDARY_EMAIL = 'CALL getSecondaryEmail_1(?)'
  PostgreSQL.prototype.getSecondaryEmail = function (email) {
    return this.readFirstResult(GET_SECONDARY_EMAIL, [email])
  }

  // Select : accounts
  // Fields : uid, email, normalizedEmail, emailVerified, emailCode, kA, wrapWrapKb, verifierVersion, authSalt,
  //          verifierSetAt, createdAt, lockedAt, primaryEmail, profileChangedAt
  // Where  : emails.normalizedEmail = LOWER($1)
  var GET_ACCOUNT_RECORD = 'CALL accountRecord_3(?)'
  PostgreSQL.prototype.accountRecord = function (email) {
    return this.readFirstResult(GET_ACCOUNT_RECORD, [email])
  }

  // Select : emails
  // Values : uid = $1
  var ACCOUNT_EMAILS = 'CALL accountEmails_4(?)'
  PostgreSQL.prototype.accountEmails = function (uid) {
    return this.readAllResults(
      ACCOUNT_EMAILS,
      [
        uid
      ]
    )
  }

  // Update : emails
  // Values : uid = $1, email = $2
  var SET_PRIMARY_EMAIL = 'CALL setPrimaryEmail_2(?, ?)'
  PostgreSQL.prototype.setPrimaryEmail = function (uid, email) {
    return this.write(
      SET_PRIMARY_EMAIL,
      [
        uid,
        email
      ]
    )
  }

  // Delete : emails
  // Values : uid = $1, email = $2
  var DELETE_EMAIL = 'CALL deleteEmail_3(?, ?)'
  PostgreSQL.prototype.deleteEmail = function (uid, email) {
    return this.write(
      DELETE_EMAIL,
      [
        uid,
        email
      ]
    )
      .catch(function(err){
        // Signal exception is triggered when an attempt to
        // delete a primary email.
        if (err.errno === ER_DELETE_PRIMARY_EMAIL) {
          throw error.cannotDeletePrimaryEmail()
        }
        throw err
      })
  }

  // Internal

  PostgreSQL.prototype.singleQuery = function (poolName, sql, params) {
    return this.getConnection(poolName)
      .then(
        function (connection) {
          return query(connection, sql, params)
            .then(
              function (result) {
                connection.release()
                return result
              },
              function (err) {
                connection.release()
                throw err
              }
            )
        }
      )
  }

  PostgreSQL.prototype.multipleQueries = function (poolName, queries, finalQuery) {
    return this.getConnection(poolName)
      .then(
        function (connection) {
          var results = []
          return P.each(
            queries,
            function (q) {
              return query(connection, q.sql, q.params)
                .then(
                  function (result) {
                    results.push(result)
                  }
                )
            }
          )
          .then(
            function () {
              return results
            }
          )
          .finally(
            function () {
              if (finalQuery) {
                return query(connection, finalQuery.sql, finalQuery.params)
                  .finally(finish)
              }

              finish()

              function finish () {
                connection.release()
              }
            }
          )
        }
      )
  }

  PostgreSQL.prototype.transaction = function (fn) {
    return retryable(
      function () {
        return this.getConnection('MASTER')
          .then(
            function (connection) {
              return query(connection, 'BEGIN')
                .then(
                  function () {
                    return fn(connection)
                  }
                )
                .then(
                  function (result) {
                    return query(connection, 'COMMIT')
                      .then(function () { return result })
                  }
                )
                .catch(
                  function (err) {
                    log.error('PostgreSQL.transaction', { err: err })
                    return query(connection, 'ROLLBACK')
                      .then(function () { throw err })
                  }
                )
                .then(
                  function (result) {
                    connection.release()
                    return result
                  },
                  function (err) {
                    connection.release()
                    throw err
                  }
                )
            }
          )
      }.bind(this),
      LOCK_ERRNOS
    )
    .catch(
      function (err) {
        throw error.wrap(err)
      }
    )
  }

  PostgreSQL.prototype.readFirstResult = function (sql, params) {
    return this.read(sql, params)
      .then(function(results) {
        // instead of the result being [result], it'll be [[result...]]
        if (! results.length) { throw error.notFound() }
        if (! results[0].length) { throw error.notFound() }
        return results[0][0]
      })
  }

  PostgreSQL.prototype.readAllResults = function (sql, params) {
    return this.read(sql, params)
      .then(function(results) {
        // instead of the result being [result], it'll be [[result...]]
        if (! results.length) { throw error.notFound() }
        return results[0]
      })
  }

  PostgreSQL.prototype.read = function (sql, params) {
    return this.singleQuery('SLAVE*', sql, params)
      .catch(
        function (err) {
          log.error('PostgreSQL.read', { sql: sql, id: params, err: err })
          throw error.wrap(err)
        }
      )
  }

  PostgreSQL.prototype.readMultiple = function (queries, finalQuery) {
    return this.multipleQueries('SLAVE*', queries, finalQuery)
      .catch(
        function (err) {
          log.error('PostgreSQL.readMultiple', { err: err })
          throw error.wrap(err)
        }
      )
  }

  PostgreSQL.prototype.write = function (sql, params, resultHandler) {
    return this.singleQuery('MASTER', sql, params)
      .then(
        function (result) {
          log.trace('PostgreSQL.write', { sql: sql, result: result })
          if (resultHandler) {
            return resultHandler(result)
          }
          return {}
        },
        function (err) {
          log.error('PostgreSQL.write', { sql: sql, err: err })
          if (err.errno === ER_DUP_ENTRY) {
            err = error.duplicate()
          }
          else {
            err = error.wrap(err)
          }
          throw err
        }
      )
  }

  PostgreSQL.prototype.writeMultiple = function (queries) {
    return this.transaction(connection => {
      return P.each(queries, ({sql, params, resultHandler}) => {
        return query(connection, sql, params)
        .then(
          function (result) {
            log.trace('PostgreSQL.writeMultiple', { sql, result })
            if (resultHandler) {
              return resultHandler(result)
            }
          },
          function (err) {
            log.error('PostgreSQL.writeMultiple', { sql, err })
            if (err.errno === ER_DUP_ENTRY) {
              err = error.duplicate()
            }
            else {
              err = error.wrap(err)
            }
            throw err
          }
        )
      })
    })
    .then(() => {
      return {}
    })
  }

  PostgreSQL.prototype.getConnection = function (name) {
    return new P((resolve, reject) => {
      retryable(
        this.getClusterConnection.bind(this, name),
        [ER_TOO_MANY_CONNECTIONS, 'ECONNREFUSED', 'ETIMEDOUT', 'ECONNRESET']
      ).then((connection) => {

        if (connection._fxa_initialized) {
          return resolve(connection)
        }

        // Enforce sane defaults on every new connection.
        // These *should* be set by the database by default, but it's nice
        // to have an additional layer of protection here.
        connection.query('SELECT @@sql_mode AS mode;', (err, rows) => {
          if (err) {
            return reject(err)
          }

          const currentModes = rows[0]['mode'].split(',')
          this.requiredModes.forEach(requiredMode => {
            if (currentModes.indexOf(requiredMode) === -1) {
              currentModes.push(requiredMode)
            }
          })

          const newMode = currentModes.join(',')
          connection.query(`SET SESSION sql_mode = '${newMode}';`, (err) => {
            if (err) {
              return reject(err)
            }

            connection.query('SET NAMES utf8mb4 COLLATE utf8mb4_bin;', (err) => {
              if (err) {
                return reject(err)
              }

              connection._fxa_initialized = true
              resolve(connection)
            })
          })
        })
      })
    })
  }

  function query(connection, sql, params) {
    var d = P.defer()
    connection.query(
      sql,
      params || [],
      function (err, results) {
        if (err) { return d.reject(err) }
        d.resolve(results)
      }
    )
    return d.promise
  }

  function retryable(fn, errnos) {
    function success(result) {
      return result
    }
    function failure(err) {
      var errno = err.cause ? err.cause.errno : err.errno
      log.error('PostgreSQL.retryable', { err: err })
      if (errnos.indexOf(errno) === -1) {
        throw err
      }
      return fn()
    }
    return fn().then(success, failure)
  }

  // exposed for testing only
  PostgreSQL.prototype.retryable_ = retryable

  const PRUNE = 'CALL prune_7(?)'
  PostgreSQL.prototype.pruneTokens = function () {
    log.info('PostgreSQL.pruneTokens')

    var pruneTokensMaxAge = this.options.pruneTokensMaxAge

    if (! pruneTokensMaxAge || pruneTokensMaxAge === 0) {
      throw new Error('pruneTokensMaxAge is misconfigured')
    }

    var pruneTokensOlderThanDate = Date.now() - pruneTokensMaxAge

    return this.write(PRUNE, [pruneTokensOlderThanDate])
  }

  // Utility method for logging connection config at startup
  PostgreSQL.prototype._connectionConfig = function (poolName) {
    var exclude = [
      'pool',
      'password',
      'user',
      'host',
      'port'
    ]

    return this.getConnection(poolName)
      .then(
        function (connection) {
          return query(connection, 'SELECT 1')
            .then(
              function (result) {
                var config = {}
                Object.keys(connection.config).sort().forEach(function(key) {
                  if (exclude.indexOf(key) === -1) {
                    config[key] = connection.config[key]
                  }
                })
                connection.release()
                return config
              },
              function (err) {
                connection.release()
                throw err
              }
            )
        }
      )
  }

  // Utility method for logging charset/collation and other variables at startup
  PostgreSQL.prototype._showVariables = function (poolName) {
    var include = [
      'character_set_client',
      'character_set_connection',
      'character_set_database',
      'character_set_filesystem',
      'character_set_results',
      'character_set_server',
      'character_set_system',
      'collation_connection',
      'collation_database',
      'collation_server',
      'max_connections',
      'version',
      'wait_timeout',
      'sql_mode'
    ]

    return this.getConnection(poolName)
      .then(
        function (connection) {
          return query(connection, 'SHOW VARIABLES')
            .then(
              function(variables) {
                var vars = {}
                variables.forEach(function(v) {
                  var name = v.Variable_name
                  if (include.indexOf(name) !== -1) {
                    vars[name] = v.Value
                  }
                })
                connection.release()
                return vars
              },
              function(err) {
                connection.release()
                throw err
              }
            )
        }
      )
  }

  function ipHmac(key, uid, addr) {
    if (ip.isV4Format(addr)) {
      addr = '::' + addr
    }
    addr = ip.toBuffer(addr)

    var hmac = crypto.createHmac('sha256', key)
    hmac.update(uid)
    hmac.update(addr)

    return hmac.digest()
  }

  var SECURITY_EVENT_NAMES = {
    'account.create': 1,
    'account.login': 2,
    'account.reset': 3
  }

  var CREATE_SECURITY_EVENT = 'CALL createSecurityEvent_3(?, ?, ?, ?, ?)'
  PostgreSQL.prototype.createSecurityEvent = function (data) {
    var uid = data.uid
    var tokenId = data.tokenId
    var nameId = SECURITY_EVENT_NAMES[data.name]
    var ipAddr = ipHmac(this.ipHmacKey, uid, data.ipAddr)
    return this.write(CREATE_SECURITY_EVENT, [uid, tokenId, nameId, ipAddr, Date.now()])
  }

  var FETCH_SECURITY_EVENTS = 'CALL fetchSecurityEvents_1(?, ?)'
  PostgreSQL.prototype.securityEvents = function (where) {
    var uid = where.id

    var ipAddr = ipHmac(this.ipHmacKey, uid, where.ipAddr)
    return this.read(FETCH_SECURITY_EVENTS, [uid, ipAddr])
      .then(
        function (result) {
          return result[0]
        }
      )
  }

  const CREATE_EMAIL_BOUNCE = 'CALL createEmailBounce_1(?, ?, ?, ?)'
  PostgreSQL.prototype.createEmailBounce = function (data) {
    const args = [
      data.email,
      dbUtil.mapEmailBounceType(data.bounceType),
      dbUtil.mapEmailBounceSubType(data.bounceSubType),
      Date.now()
    ]
    return this.write(CREATE_EMAIL_BOUNCE, args)
  }

  const FETCH_EMAIL_BOUNCES = 'CALL fetchEmailBounces_1(?)'
  PostgreSQL.prototype.fetchEmailBounces = function (emailBuffer) {
    return this.read(FETCH_EMAIL_BOUNCES, [emailBuffer.toString('utf8')])
      .then(result => result[0])
  }

  // Insert : signinCodes
  // Values : hash = $1, uid = $2, createdAt = $3, flowId = $4
  const CREATE_SIGNIN_CODE = 'CALL createSigninCode_2(?, ?, ?, ?)'
  PostgreSQL.prototype.createSigninCode = function (code, uid, createdAt, flowId) {
    // code is hashed to thwart timing attacks
    return this.write(CREATE_SIGNIN_CODE, [ dbUtil.createHash(code), uid, createdAt, flowId ])
  }

  // Delete : signinCodes
  // Where : hash = $1, createdAt > now - config.signinCodesMaxAge
  const CONSUME_SIGNIN_CODE = 'CALL consumeSigninCode_4(?, ?)'
  PostgreSQL.prototype.consumeSigninCode = function (code) {
    const newerThan = Date.now() - this.options.signinCodesMaxAge
    return this.readFirstResult(CONSUME_SIGNIN_CODE, [ dbUtil.createHash(code), newerThan ])
  }

  // Delete : account tokens passwordChangeTokens, passwordForgotTokens and accountResetTokens
  // Where : uid = $1
  const ACCOUNT_RESET_TOKENS = 'CALL resetAccountTokens_1(?)'
  PostgreSQL.prototype.resetAccountTokens = function (uid) {
    return this.write(
      ACCOUNT_RESET_TOKENS,
      [uid]
    )
  }

  const CREATE_TOTP_TOKEN = 'CALL createTotpToken_1(?, ?, ?, ?)'
  PostgreSQL.prototype.createTotpToken = function (uid, data) {
    return this.write(CREATE_TOTP_TOKEN, [uid, data.sharedSecret, data.epoch, Date.now()])
  }

  const GET_TOTP_TOKEN = 'CALL totpToken_2(?)'
  PostgreSQL.prototype.totpToken = function (uid) {
    return this.readFirstResult(GET_TOTP_TOKEN, [uid])
  }

  const DELETE_TOTP_TOKEN = 'CALL deleteTotpToken_2(?)'
  PostgreSQL.prototype.deleteTotpToken = function (uid) {
    return this.write(DELETE_TOTP_TOKEN, [uid])
  }

  const UPDATE_TOTP_TOKEN = 'CALL updateTotpToken_2(?, ?, ?)'
  PostgreSQL.prototype.updateTotpToken = function (uid, token) {
    return this.read(UPDATE_TOTP_TOKEN, [
      uid,
      token.verified,
      token.enabled
    ]).then((result) => {
      if (result.affectedRows === 0) {
        throw error.notFound()
      }
      return P.resolve({})
    })
  }

  const VERIFY_SESSION_WITH_METHOD = 'CALL verifyTokensWithMethod_2(?, ?, ?)'
  PostgreSQL.prototype.verifyTokensWithMethod = function (tokenId, data) {
    return P.resolve()
      .then(() => {
        const verificationMethod = dbUtil.mapVerificationMethodType(data.verificationMethod)

        if (! verificationMethod) {
          throw error.invalidVerificationMethod()
        }

        return this.readFirstResult(VERIFY_SESSION_WITH_METHOD, [
          tokenId,
          verificationMethod,
          Date.now()
        ])
          .then((result) => {
            if (result['@updateCount'] === 0) {
              throw error.notFound()
            }

            return P.resolve({})
          })
      })
  }

  const DELETE_RECOVERY_CODES = 'CALL deleteRecoveryCodes_1(?)'
  const INSERT_RECOVERY_CODE = 'CALL createRecoveryCode_3(?, ?, ?)'
  PostgreSQL.prototype.replaceRecoveryCodes = function (uid, count) {

    // Because of the hashing requirements the process of replacing
    // recovery codes is done is two separate procedures. First one
    // deletes all current codes and the second one inserts the
    // hashed randomly generated codes.
    return dbUtil.generateRecoveryCodes(count, RECOVERY_CODE_LENGTH)
      .then((codes) => {
        return this.read(DELETE_RECOVERY_CODES, [uid])
          .then(() => codes.map((code) => dbUtil.createHashScrypt(code)))
          .all()
          .then((items) => {
            const queries = []
            items.forEach((item) => {
              queries.push({
                sql: INSERT_RECOVERY_CODE,
                params: [uid, item.hash, item.salt]
              })
            })

            return this.writeMultiple(queries)
          })
          .then(() => codes)
          .catch((err) => {
            if (err.errno === ER_SIGNAL_NOT_FOUND) {
              throw error.notFound()
            }

            throw err
          })

      })
  }

  const CONSUME_RECOVERY_CODE = 'CALL consumeRecoveryCode_2(?, ?)'
  const RECOVERY_CODES = 'CALL recoveryCodes_1(?)'
  PostgreSQL.prototype.consumeRecoveryCode = function (uid, submittedCode) {
    // Consuming a recovery code is done in a two step process because
    // the stored scrypt hash will need to be calculated against the recovery
    // code salt.
    return this.readAllResults(RECOVERY_CODES, [uid])
      .then((results) => {
        // Throw if this user has no recovery codes
        if (results.length === 0) {
          throw error.notFound()
        }

        const compareResults = results.map((code) => {
          return dbUtil.compareHashScrypt(submittedCode, code.codeHash, code.salt)
            .then((equals) => {
              return {code, equals}
            })
        })

        // Filter only matching code
        return P.filter(compareResults, result => result.equals)
          .map((result) => result.code)
      })
      .then((result) => {
        if (result.length === 0) {
          throw error.notFound()
        }
        return this.readFirstResult(CONSUME_RECOVERY_CODE, [uid, result[0].codeHash])
      })
      .then((result) => {
        return P.resolve({
          remaining: result.count
        })
      })
      .catch((err) => {
        if (err.errno === ER_SIGNAL_NOT_FOUND) {
          throw error.notFound()
        }

        throw err
      })
  }

  const CREATE_RECOVERY_KEY = 'CALL createRecoveryKey_3(?, ?, ?)'
  PostgreSQL.prototype.createRecoveryKey = function (uid, data) {
    const recoveryKeyIdHash = dbUtil.createHash(data.recoveryKeyId)
    const recoveryData = data.recoveryData
    return this.write(CREATE_RECOVERY_KEY, [uid, recoveryKeyIdHash, recoveryData])
      .then(() => {
        return {}
      })
      .catch((err) => {
        if (err.errno === ER_SIGNAL_NOT_FOUND) {
          throw error.notFound()
        }

        throw err
      })
  }

  const GET_RECOVERY_KEY = 'CALL getRecoveryKey_3(?)'
  PostgreSQL.prototype.getRecoveryKey = function (options) {
    return this.readFirstResult(GET_RECOVERY_KEY, [options.id])
      .then((results) => {
        // Throw if this user has no recovery keys
        if (results.length === 0) {
          throw error.notFound()
        }

        // Currently, a user can only have one recovery key. Instead of
        // simply returning the key, lets double check that the right recoveryKeyId
        // was specified and throw a custom error if they don't match.
        const recoveryKeyIdHash = dbUtil.createHash(options.recoveryKeyId)
        if (! results.recoveryKeyIdHash.equals(recoveryKeyIdHash)) {
          throw error.recoveryKeyInvalid()
        }

        return results
      })
  }

  MySql.prototype.recoveryKeyExists = function (uid) {
    let exists = true
    return this.read(GET_RECOVERY_KEY, [uid])
      .then((results) => {
        if (results[0].length === 0) {
          exists = false
        }

        return {exists}
      })
  }

  const DELETE_RECOVERY_KEY = 'CALL deleteRecoveryKey_2(?)'
  PostgreSQL.prototype.deleteRecoveryKey = function (options) {
    return this.write(DELETE_RECOVERY_KEY, [options.id])
      .then(() => {
        return {}
      })
  }

  return PostgreSQL
}
