# Work in Progress

Nothing has been done beyond trivial renames at this point.

# Firefox Accounts database service

Node.js-based database service
for Firefox Accounts.
Includes:

* The [API server](#api-server).
* A [memory-store backend](#memory-store-backend).
  Useful as a stub
  for testing against.
* A [PostgreSQL backend](#postgresql-backend).
  Used in production.

To run the tests
for all components:

```sh
npm test
```

## Prerequisites

* node.js 6
* npm
* PostgreSQL (we use version 10.4 in production)

## API Server

See the [API documentation][apidocs].
Backend implementers should also read
the [database documentation][dbdocs].

For example usage,
see the [readme][server-readme].

To run the server tests:

```sh
npm run test-server
```

## Memory-store backend

Implements the [backend API][dbdocs]
as a memory store.

This is the backend store
that is loaded by the default export
from the npm package,
so the following call to `require`
will return a server
that uses the memory-store backend:

```js
var fxadb = require('fxa-auth-db-postgres')
```

To run the memory-store tests:

```sh
npm run test-mem
```

## PostgreSQL backend

Implements the [backend API][dbdocs]
as a PostgreSQL database.

To run the PostgreSQL tests:

```sh
npm run test-postgres
```

### Configuration

Both the server
and the database patcher
read values from a config file
`config/$NODE_ENV.json`,
where `NODE_ENV` is an environment variable
set in the shell.

For local development,
set `NODE_ENV` to `dev`
then create a new JSON file
called `config/dev.json`.
In there,
you can set any values
that you'd like to override
the master config file,
`config/config.js`.

For instance:

```json
{
  "master": {
    "user": "root",
    "password": "foo"
  },
  "slave": {
    "user": "root",
    "password": "bar"
  }
}
```

### Starting the server

You can start the server like so:

```sh
npm start
```

This will set up the database for you
then start the server on whichever port
is configured in `config/$NODE_ENV.json`
(port 8000 by default).

If the server fails to start,
check that PostgreSQL is running
and that your active config
has the correct settings
to connect to the database.

### Setting-up the database separately

If you want to run
the database patcher on its own,
use the following command:

```sh
node bin/db_patcher.js
```

This command creates the database
if it doesn't exist,
then runs migrations
from `lib/db/schema`
in the appropriate order.
Both forward and reverse migrations
are contained in this directory,
but note that the reverse migrations
are commented out
as a precaution against
accidental execution.

If the command fails,
check that PostgreSQL is running
and that your active config
has the correct settings
to connect to the database.

### Clean-up

If you want to clean the database,
just drop it in PostgreSQL:

```sh
psql -u postgres -p -c 'DROP DATABASE fxa'
```

It will be recreated automatically
next time you run `npm start`.

## License

[MPL 2.0][license]

[apidocs]: docs/API.md
[dbdocs]: docs/DB_API.md
[server-readme]: db-server/README.md
[license]: LICENSE

