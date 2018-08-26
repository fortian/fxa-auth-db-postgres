## Schema

This project uses the [pg-patcher](https://www.npmjs.com/package/pg-patcher) project to perform its database
schema migrations.  However, this is only theoretical, because Mozilla doesn't use this yet.
Production would nominally be
performed manually making sure each step succeeds properly.

When adding a new patch file you need to provide two things:

1. the forward and reverse patches in `db/schema/patch-xxx-xxx.sql`
2. update `db/patch.js` to point to the new patches

Each forward patch should perform its actions and finally update the `dbMetadata` to the new patch level.

Every reverse patch should perform the same actions but in exactly the same reverse order, but *still* update
the `dbMetadata` table last. Also note that for this project we decided to comment out the reverse patch
so that it couldn't be run accidentally.

## Database Table Access Order

In principle, a grown-up, production-ready database shouldn't fail as a matter
of course.  I assume PostgreSQL doesn't randomly deadlock, though I may live to
be corrected.  Out of pessimism, Mozilla's discussion of what to do when the
database comes apart in your hands is below.

MySql tells us that we
[should expect deadlocks to occur](https://docs.oracle.com/cd/E17952_01/refman-5.0-en/innodb-deadlocks.html) every so
often and that they are normal, unless they occur frequently enough to disrupt your normal operations. However, there
are also things we can do to try and minimise the chance that they do occur. One of these approaches is to try the following:

"When modifying multiple tables within a transaction, or different sets of rows in the same table, do those operations
in a consistent order each time."

To document this, we're trying to keep to the following order though obviously deviations can occur if necessary:

* sessionTokens
* keyFetchTokens
* accountResetTokens
* passwordChangeTokens
* passwordForgotTokens
* accounts

As a slice of history related to this decision, you can follow along in cronological order in these four issues/pulls:

* https://github.com/mozilla/fxa-auth-server/issues/785
* https://github.com/mozilla/fxa-auth-db-server/issues/101
* https://github.com/mozilla/fxa-auth-db-mysql/issues/28
* https://github.com/mozilla/fxa-auth-db-mysql/pull/36

## Stored Procedures and Future Patches

When a new stored procedure is added no further actions need to be taken. However, when a new version of a stored
procedure is added, the older version should also be removed. However, due to the way we may have two subsequent
versions of a stack accessing the database the old stored procedure should be removed in the next patch. As an example
consider the following:

* a stored procedure `doSomething_2` already exists
* a new version `doSomething_3` is added in patch 12 during release 50
* upon release:
    * the old stack (release 49) is still using `doSomething_2`
    * the new stack (release 50) is using `doSomething_3`
* a new patch 13 should be added for release during release 51 which removes `doSomething_2`

This works because by the time we get to release 51, the stack for release 49 has already been pulled down and nothing
is using `doSomething_2` any longer.

(Ends)
